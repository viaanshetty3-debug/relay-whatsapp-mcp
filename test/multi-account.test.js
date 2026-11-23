// Several Relay accounts on one computer, and an account that follows its owner to another computer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateKeyPairSync, randomBytes, createHash } from 'node:crypto';
import { Store } from '../src/store.js';
import { DemoWhatsApp } from '../src/demo.js';
import { Bridge } from '../src/tools.js';
import { Profiles } from '../src/profiles.js';
import { Spaces, MAX_ACCOUNTS } from '../src/spaces.js';
import { createApp } from '../src/server.js';
import { localServerEntry } from '../src/clients.js';
import { deriveKeys, sealBlob, openBlob } from '../src/cloud.js';
import worker, { AccountsStore, resetKeys, signAssertion } from '../accounts-worker/src/index.js';

const PASS = 'Tropical-Mango!2026', PASS2 = 'Quiet-Harbor#7781x';
const ADA = { fullName: 'Ada Lovelace', country: 'SG', phone: '+65 9123 4567', email: 'ada@example.com', password: PASS };
const BOB = { fullName: 'Bob Stone', country: 'GB', phone: '+44 7700 900123', email: 'bob@work.example', password: PASS2 };
const SERVICE = 'https://accounts.test';

// The Relay Accounts service, run in this process. `inbox` collects the codes it emails.
function service() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519'), objects = new Map(), data = new Map(), inbox = [];
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const STORE = { idFromName: n => n, get: name => {
    if (!objects.has(name)) {
      const d = new Map(); data.set(name, d);
      objects.set(name, new AccountsStore({ storage: { get: async k => d.get(k), put: async (k, v) => { d.set(k, structuredClone(v)); }, delete: async k => d.delete(k), setAlarm: async () => {} } }));
    }
    return { fetch: (url, init) => objects.get(name).fetch(new Request(url, init)) };
  } };
  resetKeys();
  const env = { STORE, SENDER_EMAIL: 'sender@example.com', GOOGLE_CLIENT_ID: 'g', GOOGLE_CLIENT_SECRET: 's', ACCOUNTS_SIGNING_KEY: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url'), STATE_KEY: randomBytes(32).toString('base64url') };
  const google = async (url, init) => {
    if (String(url).includes('oauth2.googleapis.com')) return Response.json({ access_token: 'gmail-token' });
    const mime = Buffer.from(JSON.parse(init.body).raw, 'base64url').toString('utf8');
    inbox.push({ to: /To: (.*)\r/.exec(mime)[1], code: /code is (\d{6})/.exec(mime)[1] });
    return Response.json({ id: '1' });
  };
  let down = false;
  const fetchImpl = async (url, init = {}) => {
    if (down) throw new TypeError('fetch failed');
    return worker.fetch(new Request(url, { ...init, headers: { ...(init.headers || {}), 'CF-Connecting-IP': '203.0.113.9' }, signal: undefined }), env, {}, google);
  };
  return { fetchImpl, inbox, data, pub, sign: claims => signAssertion(env, claims), ready: STORE.get('vault').fetch('https://store/gmail', { method: 'PUT', body: JSON.stringify({ refresh_token: 'r' }) }), setDown: v => { down = v; } };
}

// One computer running Relay. Real folders, pretend WhatsApp (no vault, no network).
async function laptop(t, { dir = mkdtempSync(join(tmpdir(), 'relay-acct-')), svc, ...extra } = {}) {
  const sent = [], server = createServer();
  server.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const port = server.address().port;
  const open = cfg => { const store = new Store(resolve(cfg.dir, 'bridge.sqlite')); return new Bridge(store, new DemoWhatsApp(store, cfg), cfg); };
  const config = { dir, port, base: 'http://127.0.0.1:' + port, token: 'root'.repeat(16), allowed: new Set(), demo: false, readOnly: false,
    mailer: { send: async m => { sent.push(m); } }, accountsUrl: svc ? SERVICE : null, accountsPublicKey: svc?.pub, fetch: svc?.fetchImpl || (async () => { throw new TypeError('fetch failed'); }),
    claudeDesktopPath: join(dir, 'claude_desktop_config.json'), ...extra };
  const main = open(config), spaces = new Spaces(config, new Profiles(config, main, { open }), { open, openProfile: open });
  server.on('request', createApp(spaces, config));
  const close = async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); await spaces.stop(); main.store.close(); };
  // A later laptop may reopen the same folder (a "restart"); on Windows an open database can't be deleted,
  // so a busy folder is left for the last laptop using it, whose own cleanup removes it.
  let closed = false; t.after(async () => {
    if (!closed) await close();
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch (e) { if (e.code !== 'EBUSY' && e.code !== 'EPERM') throw e; }
  });
  const browser = () => {
    const jar = new Map();
    return async (path, { body, bearer, form } = {}) => {
      const headers = {};
      if (bearer) headers.Authorization = 'Bearer ' + bearer; else if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (form) headers['Content-Type'] = 'application/x-www-form-urlencoded';
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: body !== undefined || form ? 'POST' : 'GET', headers, body: form ? new URLSearchParams(form) : body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
      for (const c of res.headers.getSetCookie()) { const [pair] = c.split(';'), i = pair.indexOf('='); const k = pair.slice(0, i), v = pair.slice(i + 1); if (v) jar.set(k, v); else jar.delete(k); }
      const text = await res.text(); let json; try { json = JSON.parse(text); } catch { json = null; }
      return { status: res.status, json, text, location: res.headers.get('location') };
    };
  };
  const signUp = async (call, who) => {
    let r = await call('/auth/signup', { body: who }); assert.equal(r.status, 200, r.text);
    r = await call('/auth/verify', { body: { email: who.email, code: sent.at(-1).code } }); assert.equal(r.status, 200, r.text);
  };
  return { dir, config, spaces, sent, port, browser, signUp, close: async () => { closed = true; await close(); } };
}
const names = r => r.json.map(p => p.name).sort();

test('two accounts on one computer: separate WhatsApp profiles, chats, AI clients and tokens', async t => {
  const pc = await laptop(t), call = pc.browser();
  await pc.signUp(call, ADA);
  assert.equal((await call('/auth/status')).json.accounts.length, 1);
  await call('/api/profiles', { body: { name: 'Family' } });

  await pc.signUp(call, BOB); // a second account, same browser
  let s = (await call('/auth/status')).json;
  assert.deepEqual(s.accounts.map(a => a.email).sort(), ['ada@example.com', 'bob@work.example']);
  assert.equal(s.email, 'bob@work.example', 'the newest account is in front');
  const bobId = s.account; assert.match(bobId, /^[a-f0-9]{8}$/);
  assert.ok(existsSync(join(pc.dir, 'accounts', bobId, 'bridge.sqlite')), 'its own folder and database');
  assert.equal((await call('/auth/signup', { body: { ...BOB, fullName: 'Someone Else' } })).status, 409, 'one account per email');

  // Bob's account starts empty of Ada's things and gets its own.
  assert.deepEqual(names(await call('/api/profiles')), ['Main']);
  await call('/api/profiles', { body: { name: 'Shop' } });
  const chat = '15550100001@s.whatsapp.net';
  await call('/api/tools/send_message', { body: { chat, text: 'bob-only-note' } });
  const has = async (c, opts) => JSON.stringify((await c('/api/tools/get_messages', { body: { chat }, ...opts })).json).includes('bob-only-note');
  assert.equal(await has(call), true);

  // Switching accounts needs no password, and shows only that account.
  assert.equal((await call('/auth/switch', { body: { account: 'default' } })).status, 200);
  assert.equal((await call('/api/state')).json.account.email, 'ada@example.com');
  assert.deepEqual(names(await call('/api/profiles')), ['Family', 'Main']);
  assert.equal(await has(call), false, "Ada can't read Bob's chats");
  assert.equal((await call('/api/profiles/Shop/rename', { body: { name: 'Mine' } })).status, 400, "or touch Bob's profiles");

  // Each account's owner token reaches only that account (this is what Claude's local adapter uses).
  const bob = pc.spaces.get(bobId);
  assert.notEqual(bob.config.token, pc.config.token);
  assert.equal(readFileSync(join(pc.dir, 'accounts', bobId, 'owner-token'), 'utf8').trim(), bob.config.token);
  assert.equal((await call('/api/state', { bearer: bob.config.token })).json.account.id, bobId);
  assert.equal(await has(call, { bearer: pc.config.token }), false);
  assert.equal(await has(call, { bearer: bob.config.token }), true);
  assert.equal(localServerEntry(pc.config, { account: bobId }).env.RELAY_ACCOUNT, bobId);
  assert.equal(localServerEntry(pc.config).env.RELAY_ACCOUNT, undefined);

  // "Add to Claude Desktop" gives each account its own entry, so Claude can use both.
  await call('/api/local-apps/claude-desktop', { body: {} });
  await call('/auth/switch', { body: { account: bobId } });
  const added = (await call('/api/local-apps/claude-desktop', { body: {} })).json;
  assert.equal(added.name, 'whatsapp-bob-work-example');
  const claude = JSON.parse(readFileSync(pc.config.claudeDesktopPath, 'utf8')).mcpServers;
  assert.deepEqual(Object.keys(claude).sort(), ['whatsapp', 'whatsapp-bob-work-example']);
  assert.equal(claude['whatsapp-bob-work-example'].env.RELAY_ACCOUNT, bobId);
  assert.equal(claude.whatsapp.env.RELAY_ACCOUNT, undefined);

  // An AI client approved while Bob is in front can reach Bob's WhatsApp only.
  const redirect = 'https://client.example/cb', verifier = 'v'.repeat(50), challenge = createHash('sha256').update(verifier).digest('base64url');
  const client = (await call('/oauth/register', { body: { client_name: 'ChatGPT', redirect_uris: [redirect] } })).json;
  const page = await call(`/oauth/authorize?client_id=${client.client_id}&redirect_uri=${encodeURIComponent(redirect)}&response_type=code&code_challenge=${challenge}&code_challenge_method=S256`);
  assert.match(page.text, /Signed in as bob@work\.example/);
  const approved = await call('/oauth/approve', { form: { nonce: /name="nonce" value="([^"]+)"/.exec(page.text)[1] } });
  const code = new URL(approved.location).searchParams.get('code');
  const tokens = (await call('/oauth/token', { form: { grant_type: 'authorization_code', code, client_id: client.client_id, redirect_uri: redirect, code_verifier: verifier } })).json;
  const mcp = async token => {
    const res = await fetch(`http://127.0.0.1:${pc.port}/mcp`, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_profiles', arguments: {} } }) });
    return JSON.stringify(await res.json());
  };
  assert.match(await mcp(tokens.access_token), /Shop/);
  assert.doesNotMatch(await mcp(tokens.access_token), /Family/);
  const refreshed = (await call('/oauth/token', { form: { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id } })).json;
  assert.match(await mcp(refreshed.access_token), /Shop/, 'a refreshed token stays with the same account');
  assert.equal((await call('/api/clients')).json.length, 1);
  await call('/auth/switch', { body: { account: 'default' } });
  assert.equal((await call('/api/clients')).json.length, 0, "Ada doesn't see Bob's AI clients");
  assert.equal((await call(`/api/clients/${client.client_id}/revoke`, { body: {} })).status, 200);
  assert.match(await mcp(refreshed.access_token), /Shop/, "and can't revoke them");

  // Signing out of one account leaves the other signed in. A stranger's browser gets nothing.
  await call('/auth/logout', { body: {} });
  s = (await call('/auth/status')).json;
  assert.equal(s.signedIn, true); assert.equal(s.email, 'bob@work.example'); assert.equal(s.accounts.length, 1);
  const stranger = pc.browser();
  assert.equal((await stranger('/api/state')).status, 401);
  assert.equal((await stranger('/auth/status')).json.accounts.length, 0, "accounts aren't listed to someone who isn't signed in");
  assert.equal((await stranger('/auth/switch', { body: { account: bobId } })).status, 401);
  assert.equal((await stranger('/auth/login', { body: { email: ADA.email, password: PASS2 } })).status, 401, "Bob's password doesn't open Ada's account");
  assert.equal((await stranger('/auth/token-login', { body: { token: bob.config.token } })).status, 200);
  assert.equal((await stranger('/api/state')).json.account.id, bobId);

  // Both accounts are still there after a restart.
  await pc.close();
  const again = await laptop(t, { dir: pc.dir }), back = again.browser();
  assert.equal((await back('/auth/login', { body: { email: BOB.email, password: PASS2 } })).status, 200);
  assert.deepEqual(names(await back('/api/profiles')), ['Main', 'Shop']);
  assert.equal((await back('/auth/login', { body: { email: ADA.email, password: PASS } })).status, 200);
  assert.deepEqual(names(await back('/api/profiles')), ['Family', 'Main']);

  // Removing an account needs its password, deletes its folder, and leaves the other alone.
  assert.match((await back('/auth/remove-account', { body: { password: PASS } })).json.error, /first account/);
  await back('/auth/switch', { body: { account: bobId } });
  assert.equal((await back('/auth/remove-account', { body: { password: 'Wrong-Password!123' } })).status, 401);
  assert.equal((await back('/auth/remove-account', { body: { password: PASS2 } })).status, 200);
  assert.equal(existsSync(join(again.dir, 'accounts', bobId)), false);
  assert.equal((await back('/api/state')).json.account.email, 'ada@example.com');
  assert.equal((await back('/auth/login', { body: { email: BOB.email, password: PASS2 } })).status, 401);
});

test(`a computer holds at most ${MAX_ACCOUNTS} accounts`, async t => {
  const pc = await laptop(t), call = pc.browser();
  for (let i = 0; i < MAX_ACCOUNTS; i++) { await pc.signUp(call, { ...ADA, email: `user${i}@example.com`, password: PASS }); pc.spaces.default.store.kv('account:pending', null); }
  const r = await call('/auth/signup', { body: { ...ADA, email: 'onemore@example.com' } });
  assert.equal(r.status, 403); assert.match(r.json.error, /most accounts/);
});

test('the synced copy is locked with the password: keys, blob, and tamper checks', async () => {
  const a = await deriveKeys(PASS, 'salt-one'), b = await deriveKeys(PASS, 'salt-two'), c = await deriveKeys(PASS2, 'salt-one');
  assert.notEqual(a.auth, a.enc); assert.notEqual(a.auth, b.auth); assert.notEqual(a.enc, c.enc);
  const sealed = sealBlob(a.enc, 'Ada@Example.com', { hello: 'world' });
  assert.deepEqual(openBlob(a.enc, 'ada@example.com', sealed), { hello: 'world' });
  assert.throws(() => openBlob(c.enc, 'ada@example.com', sealed), 'another password');
  assert.throws(() => openBlob(a.enc, 'eve@example.com', sealed), "another person's email");
  assert.throws(() => openBlob(a.enc, 'ada@example.com', sealed.slice(0, -4) + 'AAAA'), 'tampered');
});

test('an account follows its owner to another computer: settings arrive, WhatsApp is linked again there', async t => {
  const svc = service(); await svc.ready;
  const A = await laptop(t, { svc }), a = A.browser();
  await A.signUp(a, ADA);
  const work = (await a('/api/profiles', { body: { name: 'Work' } })).json;
  await a('/api/local-apps/claude-desktop', { body: {} });
  assert.deepEqual((await a('/api/sync')).json, { available: true, on: false, lastSync: null, waitingForCode: false, problem: null });

  // Turning it on needs the password and a code the service emails itself.
  assert.equal((await a('/api/sync/start', { body: { password: 'Wrong-Password!123' } })).status, 401);
  assert.equal((await a('/api/sync/start', { body: { password: PASS } })).json.waitingForCode, true);
  assert.equal(svc.inbox.at(-1).to, 'ada@example.com');
  assert.equal((await a('/api/sync/confirm', { body: { code: '000000' === svc.inbox.at(-1).code ? '111111' : '000000' } })).status, 400);
  let r = await a('/api/sync/confirm', { body: { code: svc.inbox.at(-1).code } });
  assert.equal(r.status, 200, r.text); assert.equal(r.json.on, true);

  // What the service holds: nothing readable, and nothing derived from the password that opens the blob.
  const held = JSON.stringify([...svc.data].map(([k, d]) => [k, [...d]]));
  for (const secret of ['Ada', 'Lovelace', 'ada@example.com', '9123', 'Work', PASS, A.spaces.default.store.kv('cloud:sync').enc, A.spaces.default.store.kv('cloud:sync').auth])
    assert.equal(held.includes(secret), false, `the service must not hold "${secret.slice(0, 12)}"`);

  // Computer B has never seen this account. A wrong password creates nothing.
  const B = await laptop(t, { svc }), b = B.browser();
  assert.equal((await b('/auth/login', { body: { email: ADA.email, password: 'Wrong-Password!123' } })).status, 401);
  assert.equal((await b('/auth/login', { body: { email: 'nobody@example.com', password: PASS } })).status, 401);
  assert.equal((await b('/auth/status')).json.hasAccount, false);
  r = await b('/auth/login', { body: { email: ADA.email, password: PASS } });
  assert.equal(r.status, 200, r.text); assert.equal(r.json.restored, true);

  // The profiles are there by name (same ids), but not linked, with no chats: B links its own devices.
  const onB = (await b('/api/profiles')).json;
  assert.deepEqual(onB.map(p => [p.id, p.name]).sort(), [['main', 'Main'], [work.id, 'Work']].sort());
  const state = (await b('/api/state')).json;
  assert.equal(state.account.email, 'ada@example.com');
  assert.deepEqual(state.setup.aiApps, { claudeDesktop: true }, 'B is told which AI apps to set up again');
  assert.deepEqual(state.setup.here, {});
  assert.equal(existsSync(join(B.dir, 'profiles', work.id, 'auth')), false, 'no WhatsApp session travelled');
  assert.equal(readdirSync(B.dir).includes('auth'), false);
  await b('/api/local-apps/claude-desktop', { body: {} });
  assert.deepEqual((await b('/api/state')).json.setup.here, { claudeDesktop: true });
  await b('/api/setup/done', { body: {} });
  assert.equal((await b('/api/state')).json.setup, null);
  // B's copy opens with the same password afterwards, with the internet off.
  svc.setDown(true);
  const b2 = B.browser();
  assert.equal((await b2('/auth/login', { body: { email: ADA.email, password: PASS } })).status, 200);
  assert.equal((await b2('/auth/login', { body: { email: 'other@example.com', password: PASS } })).status, 401, 'service down: just a failed sign-in');
  svc.setDown(false);

  // Changes travel both ways.
  await a(`/api/profiles/${work.id}/rename`, { body: { name: 'Shop' } });
  await a('/api/sync/now', { body: {} }); await b('/api/sync/now', { body: {} });
  assert.deepEqual(names(await b('/api/profiles')), ['Main', 'Shop']);
  await b('/api/profiles', { body: { name: 'Family' } });
  await b('/api/sync/now', { body: {} }); await a('/api/sync/now', { body: {} });
  assert.deepEqual(names(await a('/api/profiles')), ['Family', 'Main', 'Shop']);

  // Removing a profile on A never unlinks it on B, and B's copy doesn't bring it back to A.
  await a(`/api/profiles/${work.id}/remove`, { body: {} });
  await a('/api/sync/now', { body: {} }); await b('/api/sync/now', { body: {} }); await a('/api/sync/now', { body: {} });
  assert.deepEqual(names(await b('/api/profiles')), ['Family', 'Main', 'Shop']);
  assert.deepEqual(names(await a('/api/profiles')), ['Family', 'Main']);

  // A password change on A re-locks the copy. B is told, and the old password no longer fetches it.
  await a('/auth/reset/request', { body: { email: ADA.email } });
  r = await a('/auth/reset/confirm', { body: { email: ADA.email, code: A.sent.at(-1).code, password: PASS2 } });
  assert.equal(r.status, 200, r.text); assert.equal(r.json.syncPaused, undefined);
  assert.match((await b('/api/sync/now', { body: {} })).json.problem, /password was changed/);
  const C = await laptop(t, { svc }), c = C.browser();
  assert.equal((await c('/auth/login', { body: { email: ADA.email, password: PASS } })).status, 401);
  assert.equal((await c('/auth/login', { body: { email: ADA.email, password: PASS2 } })).json.restored, true);
  assert.deepEqual(names(await c('/api/profiles')), ['Family', 'Main']);

  // Turning it off deletes the service's copy.
  r = await a('/api/sync/off', { body: {} });
  assert.equal(r.json.on, false); assert.equal(r.json.cloudCopyRemoved, true);
  const D = await laptop(t, { svc }), d = D.browser();
  assert.equal((await d('/auth/login', { body: { email: ADA.email, password: PASS2 } })).status, 401);
});

test('account sync stays off in practice mode and when the service is switched off', async t => {
  const svc = service(); await svc.ready;
  for (const extra of [{ demo: true, svc }, { svc: null }]) {
    const pc = await laptop(t, extra), call = pc.browser();
    let r = await call('/auth/signup', { body: ADA });
    await call('/auth/verify', { body: { email: ADA.email, code: r.json.demoCode || pc.sent.at(-1).code } });
    assert.equal((await call('/api/sync')).json.available, false);
    assert.equal((await call('/api/sync/start', { body: { password: PASS } })).status, 400);
    assert.equal(svc.inbox.length, 0);
  }
});

test('an account made with Google or GitHub has no password: turning on sync chooses one, and it then follows its owner too', async t => {
  const svc = service(); await svc.ready;
  const A = await laptop(t, { svc }), a = A.browser();
  await A.signUp(a, ADA);
  // The same shape a provider sign-in stores: name, email and the provider's id. No password, country or phone.
  const store = A.spaces.default.store;
  store.kv('account:owner', { fullName: 'Ada Lovelace', email: ADA.email, providers: { google: 'g-1' }, createdAt: Date.now() });
  assert.equal((await a('/api/state')).json.account.hasPassword, false);
  assert.equal((await a('/auth/status')).json.hasPassword, false);

  // A weak choice is refused and nothing is stored; a good one becomes the account's password once sync starts.
  let r = await a('/api/sync/start', { body: { password: 'short' } });
  assert.equal(r.status, 400); assert.match(r.json.error, /at least 12 characters/);
  assert.equal(store.kv('account:owner').passwordHash, undefined);
  r = await a('/api/sync/start', { body: { password: PASS } });
  assert.equal(r.status, 200, r.text); assert.equal(r.json.waitingForCode, true);
  assert.match(store.kv('account:owner').passwordHash, /^scrypt\$/);
  assert.equal((await a('/api/sync/confirm', { body: { code: svc.inbox.at(-1).code } })).json.on, true);
  assert.equal((await a('/api/state')).json.account.hasPassword, true);

  // Another computer: email and that password bring the account over, though it has no country or phone.
  const B = await laptop(t, { svc }), b = B.browser();
  r = await b('/auth/login', { body: { email: ADA.email, password: PASS } });
  assert.equal(r.status, 200, r.text); assert.equal(r.json.restored, true);
  const onB = B.spaces.all().map(s => s.store.kv('account:owner')).find(Boolean);
  assert.equal(onB.fullName, 'Ada Lovelace'); assert.equal(onB.phone, undefined);
});

test('a Google account with a passcode: sync is locked with the passcode, and Google plus the passcode bring it to another computer', async t => {
  const svc = service(); await svc.ready;
  // What the service does after Google confirms someone: sign an assertion for the bridge that asked.
  const google = async (call, who) => {
    const to = new URL((await call('/auth/oauth/google')).location);
    assert.equal(to.origin + to.pathname, SERVICE + '/oauth/start');
    const assertion = await svc.sign({ iss: SERVICE, aud: to.searchParams.get('return_to'), nonce: to.searchParams.get('nonce'), provider: 'google', verified: true, iat: Date.now(), exp: Date.now() + 300000, ...who });
    return call('/auth/broker/callback?assertion=' + encodeURIComponent(assertion));
  };
  const ADA_G = { id: 'g-1', email: 'ada@example.com', name: 'Ada Lovelace' }, CODE = 'river-stone-42';

  const A = await laptop(t, { svc }), a = A.browser();
  assert.equal((await google(a, ADA_G)).location, '/');
  assert.equal((await a('/auth/passcode', { body: { passcode: CODE, existing: true } })).status, 401, 'nothing to bring over yet');
  assert.equal((await a('/auth/passcode', { body: { passcode: CODE } })).json.signedIn, true);
  await a('/api/profiles', { body: { name: 'Work' } });

  // Sync is turned on with the passcode and one emailed code, as for any account.
  assert.equal((await a('/api/sync/start', { body: { password: 'wrong-passcode' } })).status, 401);
  assert.equal((await a('/api/sync/start', { body: { password: CODE } })).json.waitingForCode, true);
  assert.equal((await a('/api/sync/confirm', { body: { code: svc.inbox.at(-1).code } })).json.on, true);
  // The service holds nothing it can read, and no key: the copy opens only with the passcode.
  const held = JSON.stringify([...svc.data].map(([k, d]) => [k, [...d]]));
  for (const secret of ['Ada', 'Lovelace', 'ada@example.com', 'Work', CODE]) assert.equal(held.includes(secret), false, `the service must not hold "${secret}"`);
  assert.equal(held.includes('psk'), false);

  // Computer B: Google proves who it is; the passcode from computer A brings the account over.
  const B = await laptop(t, { svc }), b = B.browser();
  assert.equal((await google(b, ADA_G)).location, '/');
  assert.equal((await b('/auth/status')).json.needsPasscode, true);
  assert.equal((await b('/api/profiles')).status, 401);
  assert.equal((await b('/auth/passcode', { body: { passcode: 'not-the-passcode', existing: true } })).status, 401);
  const r = await b('/auth/passcode', { body: { passcode: CODE, existing: true } });
  assert.equal(r.status, 200, r.text); assert.equal(r.json.restored, true);
  assert.deepEqual(names(await b('/api/profiles')), ['Main', 'Work']);
  assert.equal((await b('/api/sync')).json.on, true);
  const onB = B.spaces.all().map(s => s.store.kv('account:owner')).find(Boolean);
  assert.equal(onB.fullName, 'Ada Lovelace'); assert.ok(onB.restoredAt); assert.match(onB.passwordHash, /^scrypt\$/);
  // A different Google account gets nothing of Ada's, even with her passcode.
  const C = await laptop(t, { svc }), c = C.browser();
  await google(c, { id: 'g-2', email: 'eve@example.com', name: 'Eve Stone' });
  assert.equal((await c('/auth/passcode', { body: { passcode: CODE, existing: true } })).status, 401);
});
