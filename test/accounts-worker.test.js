// The shared Relay Accounts service (accounts-worker/): provider sign-in, signed assertions, email codes, limits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import worker, { AccountsStore, validReturnTo, resetKeys } from '../accounts-worker/src/index.js';
import { verifyAssertion } from '../src/accounts.js';

function makeEnv(extra = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const objects = new Map();
  const STORE = {
    idFromName: name => name,
    get: name => {
      if (!objects.has(name)) {
        const data = new Map();
        const storage = { get: async k => data.get(k), put: async (k, v) => { data.set(k, structuredClone(v)); }, delete: async k => data.delete(k), setAlarm: async () => {} };
        objects.set(name, new AccountsStore({ storage }));
      }
      const obj = objects.get(name);
      return { fetch: (url, init) => obj.fetch(new Request(url, init)) };
    },
  };
  resetKeys();
  return {
    pub: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    env: {
      STORE, SENDER_EMAIL: 'sender@example.com', DAILY_EMAIL_LIMIT: '450',
      ACCOUNTS_SIGNING_KEY: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url'),
      STATE_KEY: randomBytes(32).toString('base64url'),
      ...extra,
    },
  };
}
const BASE = 'https://accounts.test';
const call = (env, path, init, fetchImpl) => worker.fetch(new Request(BASE + path, init), env, {}, fetchImpl);

test('bridges may only be sent back to their own callback, on HTTPS or this computer', () => {
  for (const ok of ['http://127.0.0.1:8787/auth/broker/callback', 'http://localhost:9/auth/broker/callback', 'http://[::1]:8787/auth/broker/callback', 'https://relay.example.com/auth/broker/callback'])
    assert.equal(validReturnTo(ok), true, ok);
  for (const bad of ['http://relay.example.com/auth/broker/callback', 'https://relay.example.com/auth/other', 'https://relay.example.com/auth/broker/callback?x=1',
    'https://a:b@relay.example.com/auth/broker/callback', 'javascript:alert(1)', '', 'http://127.0.0.1.evil.test/auth/broker/callback'])
    assert.equal(validReturnTo(bad), false, bad);
});

test('GitHub sign-in ends with a signed assertion the bridge accepts, and only for the bridge that asked', async () => {
  const { env, pub } = makeEnv({ GITHUB_CLIENT_ID: 'gh-id', GITHUB_CLIENT_SECRET: 'gh-secret' });
  assert.deepEqual(await (await call(env, '/providers')).json(), [{ id: 'github', name: 'GitHub' }]);
  const returnTo = 'http://127.0.0.1:8787/auth/broker/callback', nonce = 'n'.repeat(32);

  assert.equal((await call(env, `/oauth/start?provider=google&return_to=${encodeURIComponent(returnTo)}&nonce=${nonce}`)).status, 404, 'not set up');
  assert.equal((await call(env, `/oauth/start?provider=github&return_to=${encodeURIComponent('https://evil.test/steal')}&nonce=${nonce}`)).status, 400);
  assert.equal((await call(env, `/oauth/start?provider=github&return_to=${encodeURIComponent(returnTo)}&nonce=short`)).status, 400);

  const start = await call(env, `/oauth/start?provider=github&return_to=${encodeURIComponent(returnTo)}&nonce=${nonce}`);
  assert.equal(start.status, 302);
  const auth = new URL(start.headers.get('location'));
  assert.equal(auth.origin + auth.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(auth.searchParams.get('redirect_uri'), BASE + '/callback/github');
  const state = auth.searchParams.get('state');
  assert.ok(!state.includes('127.0.0.1') && !atob(state.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')).includes('8787'), 'state is encrypted');

  const seen = [];
  const fakeFetch = async (url, init = {}) => {
    seen.push(String(url));
    if (String(url) === 'https://github.com/login/oauth/access_token') {
      const body = new URLSearchParams(init.body);
      assert.equal(body.get('client_secret'), 'gh-secret'); assert.equal(body.get('code'), 'the-code');
      return Response.json({ access_token: 'gh-token' });
    }
    if (String(url) === 'https://api.github.com/user') return Response.json({ id: 42, login: 'ada', name: 'Ada Lovelace' });
    if (String(url) === 'https://api.github.com/user/emails') return Response.json([{ email: 'other@example.com', primary: false, verified: true }, { email: 'Ada@Example.com', primary: true, verified: true }]);
    throw new Error('unexpected ' + url);
  };
  // Tampered or wrong-provider state is refused.
  assert.equal((await call(env, `/callback/github?code=the-code&state=${state.slice(0, -2)}xx`, {}, fakeFetch)).status, 400);
  assert.equal((await call(env, `/callback/facebook?code=the-code&state=${state}`, {}, fakeFetch)).status, 400);
  // Cancelled at GitHub: back to the bridge with an error, not an assertion.
  const cancelled = new URL((await call(env, `/callback/github?error=access_denied&state=${state}`, {}, fakeFetch)).headers.get('location'));
  assert.equal(cancelled.origin + cancelled.pathname, returnTo); assert.ok(cancelled.searchParams.get('error')); assert.equal(cancelled.searchParams.get('assertion'), null);

  const done = await call(env, `/callback/github?code=the-code&state=${state}`, {}, fakeFetch);
  const back = new URL(done.headers.get('location'));
  assert.equal(back.origin + back.pathname, returnTo);
  const claims = verifyAssertion(back.searchParams.get('assertion'), pub);
  assert.ok(claims, 'signature checks out with the public key');
  assert.equal(claims.iss, BASE); assert.equal(claims.aud, returnTo); assert.equal(claims.nonce, nonce);
  assert.equal(claims.provider, 'github'); assert.equal(claims.id, '42'); assert.equal(claims.email, 'ada@example.com'); assert.equal(claims.verified, true);
  assert.ok(claims.exp > Date.now() && claims.exp <= Date.now() + 5 * 60000);
  assert.equal(verifyAssertion(back.searchParams.get('assertion'), makeEnv().pub), null, 'a different key rejects it');
});

test('email codes go out through Gmail, with per-address limits and nothing else accepted', async () => {
  const { env } = makeEnv({ GOOGLE_CLIENT_ID: 'g-id', GOOGLE_CLIENT_SECRET: 'g-secret' });
  const sent = [];
  const fakeFetch = async (url, init = {}) => {
    if (String(url) === 'https://oauth2.googleapis.com/token') { assert.equal(new URLSearchParams(init.body).get('refresh_token'), 'refresh-1'); return Response.json({ access_token: 'access-1' }); }
    if (String(url) === 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send') {
      assert.equal(init.headers.Authorization, 'Bearer access-1');
      sent.push(Buffer.from(JSON.parse(init.body).raw, 'base64url').toString('utf8'));
      return Response.json({ id: 'm1' });
    }
    throw new Error('unexpected ' + url);
  };
  const send = (body, ip = '1.2.3.4') => call(env, '/email/code', { method: 'POST', headers: { 'CF-Connecting-IP': ip }, body: JSON.stringify(body) }, fakeFetch);

  assert.equal((await (await call(env, '/health')).json()).email, false);
  let r = await send({ to: 'ada@example.com', code: '12345' });
  assert.equal(r.status, 502, 'Gmail not connected yet'); assert.doesNotMatch((await r.json()).error, /ada|12345/);

  await env.STORE.get('vault').fetch('https://store/gmail', { method: 'PUT', body: JSON.stringify({ refresh_token: 'refresh-1' }) });
  assert.equal((await (await call(env, '/health')).json()).email, true);
  assert.equal((await send({ to: 'not-an-email', code: '12345' })).status, 400);
  assert.equal((await send({ to: 'ada@example.com\r\nBcc: eve@example.com', code: '12345' })).status, 400, 'no header injection');
  assert.equal((await send({ to: 'ada@example.com', code: 'click http://evil.test' })).status, 400, 'only a 5-digit code, never free text');

  r = await send({ to: 'Ada@Example.com', code: '24680', purpose: 'reset' });
  assert.equal(r.status, 200);
  assert.match(sent[0], /^From: Relay <sender@example.com>\r\nTo: ada@example.com\r\nSubject: Your Relay code: 24680/);
  assert.match(sent[0], /reset your Relay password/);

  // The failed attempt above counts too, so 3 more reach the hourly 5.
  for (let i = 0; i < 3; i++) assert.equal((await send({ to: 'ada@example.com', code: '11111' }, '9.9.9.' + i)).status, 200);
  r = await send({ to: 'ada@example.com', code: '11111' }, '8.8.8.8');
  assert.equal(r.status, 429, '5 per address per hour, whatever the network'); assert.ok((await r.json()).retryAfter > 0);
  assert.equal((await send({ to: 'bob@example.com', code: '11111' })).status, 200, 'other addresses are unaffected');
  assert.equal(sent.length, 5);
});

test('the daily total and per-network limits hold', async () => {
  const { env } = makeEnv({ DAILY_EMAIL_LIMIT: '3' });
  await env.STORE.get('vault').fetch('https://store/gmail', { method: 'PUT', body: JSON.stringify({ refresh_token: 'r' }) });
  const fakeFetch = async url => String(url).includes('oauth2') ? Response.json({ access_token: 'a' }) : Response.json({ id: 'm' });
  const send = (to, ip) => call(env, '/email/code', { method: 'POST', headers: { 'CF-Connecting-IP': ip }, body: JSON.stringify({ to, code: '12345' }) }, fakeFetch);
  for (let i = 0; i < 3; i++) assert.equal((await send(`u${i}@example.com`, '10.0.0.' + i)).status, 200);
  assert.equal((await send('u9@example.com', '10.0.0.9')).status, 429);

  const { env: env2 } = makeEnv();
  await env2.STORE.get('vault').fetch('https://store/gmail', { method: 'PUT', body: JSON.stringify({ refresh_token: 'r' }) });
  const send2 = to => call(env2, '/email/code', { method: 'POST', headers: { 'CF-Connecting-IP': '7.7.7.7' }, body: JSON.stringify({ to, code: '12345' }) }, fakeFetch);
  for (let i = 0; i < 20; i++) assert.equal((await send2(`p${i}@example.com`)).status, 200);
  assert.equal((await send2('p99@example.com')).status, 429, '20 per network per hour');
});

test('only the configured sending account can connect Gmail', async () => {
  const { env } = makeEnv({ GOOGLE_CLIENT_ID: 'g-id', GOOGLE_CLIENT_SECRET: 'g-secret' });
  const start = await call(env, '/admin/gmail/start');
  assert.equal(start.status, 302);
  const auth = new URL(start.headers.get('location'));
  assert.match(auth.searchParams.get('scope'), /gmail\.send/);
  assert.equal(auth.searchParams.get('redirect_uri'), BASE + '/admin/gmail/callback');
  const state = auth.searchParams.get('state');
  const as = email => async url => {
    if (String(url) === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'a', refresh_token: 'r-new', scope: 'openid email https://www.googleapis.com/auth/gmail.send', id_token: 'x.' + Buffer.from(JSON.stringify({ sub: '1', email, email_verified: true })).toString('base64url') + '.y' });
    return Response.json({ sub: '1', email, email_verified: true });
  };
  assert.equal((await call(env, `/admin/gmail/callback?code=c&state=${state}`, {}, as('eve@example.com'))).status, 403);
  assert.equal((await (await call(env, '/health')).json()).email, false);
  // A sign-in state can't be replayed against the admin callback.
  const signin = new URL((await call({ ...env, GITHUB_CLIENT_ID: 'i', GITHUB_CLIENT_SECRET: 's' }, `/oauth/start?provider=github&return_to=${encodeURIComponent('http://localhost:1/auth/broker/callback')}&nonce=${'n'.repeat(24)}`)).headers.get('location')).searchParams.get('state');
  assert.notEqual((await call(env, `/admin/gmail/callback?code=c&state=${signin}`, {}, as('sender@example.com'))).status, 200);
  assert.equal((await call(env, `/admin/gmail/callback?code=c&state=${state}`, {}, as('Sender@Example.com'))).status, 200);
  assert.equal((await (await call(env, '/health')).json()).email, true);
});
