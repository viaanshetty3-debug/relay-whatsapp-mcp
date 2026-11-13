import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { JSDOM, VirtualConsole } from 'jsdom';
import { Store } from '../src/store.js';
import { DemoWhatsApp } from '../src/demo.js';
import { Bridge } from '../src/tools.js';
import { createApp } from '../src/server.js';
import { passwordProblems, validateProfile } from '../src/accounts.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const GOOD = 'Tropical-Mango!2026';
const PROFILE = { fullName: 'Ada Lovelace', country: 'SG', phone: '+65 9123 4567', email: 'Ada@Example.com', password: GOOD };

async function start(t, extra = {}) {
  const store = new Store(':memory:'), server = createServer();
  server.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const port = server.address().port;
  const config = { port, base: 'http://127.0.0.1:' + port, token: 'test'.repeat(16), allowed: new Set(), demo: true, readOnly: false, ...extra };
  if (typeof config.base === 'function') config.base = config.base(port);
  const wa = new DemoWhatsApp(store, config), bridge = new Bridge(store, wa, config);
  server.on('request', createApp(bridge, config));
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); store.close(); });
  const jar = {};
  const call = async (path, { body, rawBody, method, host = '127.0.0.1', cookie = true, headers = {} } = {}) => {
    const h = { ...headers };
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const c = jar[host]; if (cookie && c) h.Cookie = c;
    const res = await fetch(`http://${host}:${port}${path}`, { method: method || (body !== undefined ? 'POST' : 'GET'), headers: h, body: rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined), redirect: 'manual' });
    const set = res.headers.get('set-cookie');
    if (set) { const v = set.split(';')[0]; jar[host] = v.endsWith('=') ? '' : v; }
    const text = await res.text(); let json; try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, json, text, location: res.headers.get('location'), setCookie: set };
  };
  return { store, config, port, call, jar };
}

test('password and profile rules', () => {
  assert.deepEqual(passwordProblems(GOOD, { email: 'ada@example.com', name: 'Ada Lovelace' }), []);
  assert.ok(passwordProblems('short').includes('at least 12 characters'));
  assert.ok(passwordProblems('alllowercase1!x').includes('an uppercase letter'));
  assert.ok(passwordProblems('Lovelace-Rocks-99', { name: 'Ada Lovelace' }).includes('no parts of your name or email'));
  assert.ok(passwordProblems('MyPassword!2026').includes('no common words or repeated characters'));
  assert.equal(validateProfile(PROFILE).profile.email, 'ada@example.com');
  assert.equal(validateProfile(PROFILE).profile.phone, '+6591234567');
  assert.match(validateProfile({ ...PROFILE, phone: '91234567' }).error, /country code/);
  assert.match(validateProfile({ ...PROFILE, country: '' }).error, /country/);
  assert.match(validateProfile({ ...PROFILE, email: 'nope' }).error, /email/);
});

test('sign up with an emailed 6-digit code, then sign in, reset the password and sign out', async t => {
  const sent = [];
  const { call } = await start(t, { demo: false, mailer: { send: async m => { sent.push(m); } } });
  const code = () => sent.at(-1).subject.match(/\d{6}/)[0];

  assert.equal((await call('/api/state')).status, 401, 'nothing is open before an account exists');
  let r = await call('/auth/status');
  assert.deepEqual([r.json.hasAccount, r.json.signedIn, r.json.emailReady], [false, false, true]);

  r = await call('/auth/signup', { body: { ...PROFILE, password: 'weakpass' } });
  assert.equal(r.status, 400); assert.match(r.json.error, /password needs/);
  r = await call('/auth/signup', { body: PROFILE });
  assert.equal(r.status, 200); assert.equal(r.json.verify, true); assert.equal(r.json.demoCode, undefined, 'real codes are only emailed');
  assert.equal(sent.length, 1); assert.equal(sent[0].to, 'ada@example.com'); assert.match(sent[0].subject, /^Your Relay code: \d{6}$/);

  const right = code(), wrong = right === '000000' ? '111111' : '000000';
  r = await call('/auth/verify', { body: { email: 'ada@example.com', code: wrong } });
  assert.equal(r.status, 400); assert.match(r.json.error, /not right/);
  r = await call('/auth/verify', { body: { email: 'ada@example.com', code: right } });
  assert.equal(r.status, 200); assert.match(r.setCookie, /relay_session=.+; Path=\/; HttpOnly; SameSite=Lax/);
  assert.equal((await call('/api/state')).status, 200, 'the session cookie opens the workspace');
  assert.equal((await call('/auth/status')).json.email, 'ada@example.com');

  r = await call('/auth/signup', { body: { ...PROFILE, email: 'eve@example.com' } });
  assert.equal(r.status, 403, 'sign-up closes once the bridge has an owner');

  await call('/auth/logout', { body: {} });
  assert.equal((await call('/api/state')).status, 401);
  r = await call('/auth/login', { body: { email: 'ada@example.com', password: 'Wrong-Password-1' } });
  assert.equal(r.status, 401);
  r = await call('/auth/login', { body: { email: 'ADA@example.com', password: GOOD } });
  assert.equal(r.status, 200); assert.equal((await call('/api/state')).status, 200);

  // Password reset: an unknown email gets the same answer and no email.
  const before = sent.length;
  assert.equal((await call('/auth/reset/request', { body: { email: 'eve@example.com' } })).status, 200);
  assert.equal(sent.length, before);
  await call('/auth/reset/request', { body: { email: 'ada@example.com' } });
  assert.equal(sent.length, before + 1);
  const NEW = 'Another-Sunny-Day#77';
  r = await call('/auth/reset/confirm', { body: { email: 'ada@example.com', code: code(), password: NEW } });
  assert.equal(r.status, 200);
  assert.equal((await call('/auth/login', { body: { email: 'ada@example.com', password: GOOD } })).status, 401);
  assert.equal((await call('/auth/login', { body: { email: 'ada@example.com', password: NEW } })).status, 200);

  // The owner token still works for MCP clients and as a recovery sign-in.
  assert.equal((await call('/api/state', { cookie: false, headers: { Authorization: 'Bearer ' + 'test'.repeat(16) } })).status, 200);
  assert.equal((await call('/auth/token-login', { cookie: false, body: { token: 'test'.repeat(16) } })).status, 200);
});

test('wrong codes and passwords are limited', async t => {
  const sent = [];
  const { call } = await start(t, { demo: false, mailer: { send: async m => { sent.push(m); } } });
  await call('/auth/signup', { body: PROFILE });
  const right = sent[0].subject.match(/\d{6}/)[0], wrong = right === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) await call('/auth/verify', { body: { email: 'ada@example.com', code: wrong } });
  const r = await call('/auth/verify', { body: { email: 'ada@example.com', code: right } });
  assert.equal(r.status, 400); assert.match(r.json.error, /Too many wrong codes/);
  await sleep(10);
  assert.equal((await call('/auth/resend', { body: { email: 'ada@example.com' } })).status, 200);
  const fresh = sent.at(-1).subject.match(/\d{6}/)[0];
  assert.equal((await call('/auth/verify', { body: { email: 'ada@example.com', code: fresh } })).status, 200);
  for (let i = 0; i < 10; i++) await call('/auth/login', { cookie: false, body: { email: 'ada@example.com', password: 'Nope-Nope-12345' } });
  const locked = await call('/auth/login', { cookie: false, body: { email: 'ada@example.com', password: GOOD } });
  assert.equal(locked.status, 429, 'ten failures lock sign-in for 15 minutes');
});

test('without email set up, a real bridge explains how to fix it', async t => {
  const { call } = await start(t, { demo: false });
  assert.equal((await call('/auth/status')).json.emailReady, false);
  const r = await call('/auth/signup', { body: PROFILE });
  assert.equal(r.status, 503); assert.match(r.json.error, /SMTP_URL/);
});

test('a hosted bridge needs the owner token to create the first account', async t => {
  const { call } = await start(t, { base: port => `https://relay.example.com`, mailer: { send: async () => {} } });
  assert.equal((await call('/auth/status')).json.hostedSetup, true);
  assert.equal((await call('/auth/signup', { body: PROFILE })).status, 403);
  assert.equal((await call('/auth/signup', { body: { ...PROFILE, setupToken: 'test'.repeat(16) } })).status, 200);
});

test('sign in with GitHub: first time finishes sign-up, later it signs straight in, other accounts are refused', async t => {
  let user = { id: 42, login: 'ada', name: 'Ada Lovelace' }, emails = [{ email: 'ada@example.com', primary: true, verified: true }];
  const seen = [];
  const fakeFetch = async (url, init = {}) => {
    seen.push({ url: String(url), body: init.body ? String(init.body) : '' });
    if (String(url).startsWith('https://github.com/login/oauth/access_token')) return Response.json({ access_token: 'gh-token', token_type: 'bearer' });
    if (String(url) === 'https://api.github.com/user') return Response.json(user);
    if (String(url) === 'https://api.github.com/user/emails') return Response.json(emails);
    throw new Error('unexpected ' + url);
  };
  const { call, port, store } = await start(t, { providers: { github: { clientId: 'gh-id', clientSecret: 'gh-secret' } }, fetch: fakeFetch });
  assert.deepEqual((await call('/auth/status')).json.providers, [{ id: 'github', name: 'GitHub' }]);

  async function signInWithGitHub() {
    let r = await call('/auth/oauth/github');
    assert.equal(r.location, `http://localhost:${port}/auth/oauth/github`, 'local bridges use localhost for provider redirects');
    r = await call('/auth/oauth/github', { host: 'localhost' });
    const to = new URL(r.location);
    assert.equal(to.origin + to.pathname, 'https://github.com/login/oauth/authorize');
    assert.equal(to.searchParams.get('redirect_uri'), `http://localhost:${port}/auth/callback/github`);
    assert.equal(to.searchParams.get('code_challenge_method'), 'S256');
    return call(`/auth/callback/github?code=abc&state=${to.searchParams.get('state')}`, { host: 'localhost' });
  }

  let r = await signInWithGitHub();
  const ticket = new URL(r.location, 'http://x').searchParams.get('signup');
  assert.ok(ticket, 'new users finish signing up');
  assert.match(seen.find(s => s.url.includes('access_token')).body, /client_secret=gh-secret/);
  r = await call('/auth/ticket/' + ticket, { host: 'localhost' });
  assert.deepEqual(r.json, { email: 'ada@example.com', name: 'Ada Lovelace', provider: 'GitHub' });
  r = await call('/auth/signup', { host: 'localhost', body: { ...PROFILE, email: 'attacker@example.com', ticket } });
  assert.equal(r.status, 200); assert.equal(r.json.signedIn, true, 'no email code: GitHub verified it');
  assert.equal(store.kv('account:owner').email, 'ada@example.com', 'the provider email wins over the form');
  assert.equal(store.kv('account:owner').providers.github, '42');

  await call('/auth/logout', { host: 'localhost', body: {} });
  r = await signInWithGitHub();
  assert.equal(r.location, '/'); assert.match(r.setCookie, /relay_session=/);
  assert.equal((await call('/api/state', { host: 'localhost' })).status, 200);

  user = { id: 99, login: 'eve' }; emails = [{ email: 'eve@example.com', primary: true, verified: true }];
  await call('/auth/logout', { host: 'localhost', body: {} });
  r = await signInWithGitHub();
  assert.match(decodeURIComponent(r.location), /isn't the one that owns this bridge/);
  assert.equal(r.setCookie, null);

  r = await call('/auth/callback/github?code=abc&state=forged', { host: 'localhost' });
  assert.match(decodeURIComponent(r.location), /expired/);
});

test('an AI client is approved with the signed-in account instead of the token', async t => {
  const sent = [];
  const { call, port } = await start(t, { mailer: { send: async m => { sent.push(m); } } });
  const reg = await call('/oauth/register', { body: { client_name: 'Test AI', redirect_uris: ['https://client.example/cb'] } });
  const q = new URLSearchParams({ client_id: reg.json.client_id, redirect_uri: 'https://client.example/cb', response_type: 'code', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256', state: 's1' });
  let r = await call('/oauth/authorize?' + q);
  assert.match(r.text, /Sign in to approve/);
  assert.match(r.text, /href="\/\?next=%2Foauth%2Fauthorize%3F/);
  await call('/auth/signup', { body: PROFILE });
  await call('/auth/verify', { body: { email: 'ada@example.com', code: sent[0].subject.match(/\d{6}/)[0] } });
  r = await call('/oauth/authorize?' + q);
  assert.doesNotMatch(r.text, /Owner token/);
  const nonce = r.text.match(/name="nonce" value="([^"]+)"/)[1];
  const res = await fetch(`http://127.0.0.1:${port}/oauth/approve`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ nonce }) });
  assert.equal(res.status, 401, 'no session, no token → refused');
  r = await call('/oauth/authorize?' + q);
  const nonce2 = r.text.match(/name="nonce" value="([^"]+)"/)[1];
  r = await call('/oauth/approve', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: undefined, rawBody: new URLSearchParams({ nonce: nonce2 }).toString() });
  assert.equal(r.status, 303);
  const redirect = new URL(r.location);
  assert.equal(redirect.origin + redirect.pathname, 'https://client.example/cb');
  assert.ok(redirect.searchParams.get('code')); assert.equal(redirect.searchParams.get('state'), 's1');
});

test('dashboard: create account, verify the demo code, open the workspace, sign out and sign back in', async t => {
  const { call, port } = await start(t);
  const base = 'http://127.0.0.1:' + port;
  const errors = [], vc = new VirtualConsole(); vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'), { url: base, runScripts: 'outside-only', virtualConsole: vc });
  const w = dom.window, d = w.document;
  let cookie = '';
  w.fetch = async (url, opts = {}) => {
    const res = await fetch(base + url, { ...opts, headers: { ...(opts.headers || {}), ...(cookie ? { Cookie: cookie } : {}) } });
    const set = res.headers.get('set-cookie'); if (set) { const v = set.split(';')[0]; cookie = v.endsWith('=') ? '' : v; }
    return res;
  };
  w.TextDecoder = TextDecoder; w.AbortController = AbortController; w.confirm = () => true;
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; }; w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  Object.defineProperty(w.crypto, 'randomUUID', { value: randomUUID });
  t.after(() => w.close());
  w.eval(readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'));
  const $ = s => d.querySelector(s);
  const until = async (fn, msg) => { for (let i = 0; i < 150; i++) { if (fn()) return; await sleep(20); } throw new Error(msg + ' | ' + $('#login-error').textContent); };
  const submit = s => $(s).dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));

  await until(() => !$('#auth-signup').hidden, 'sign-up form not shown for a new bridge');
  assert.ok($('#signup-country').options.length > 150, 'country list filled');
  $('#signup-name').value = PROFILE.fullName; $('#signup-country').value = 'SG';
  $('#signup-country').dispatchEvent(new w.Event('change'));
  assert.equal($('#signup-phone').value, '+65 ', 'picking a country fills its dialling code');
  $('#signup-phone').value = PROFILE.phone; $('#signup-email').value = PROFILE.email;
  $('#signup-password').value = 'short'; $('#signup-password').dispatchEvent(new w.Event('input'));
  assert.equal(d.querySelectorAll('#password-rules li.ok').length, 1, 'only "lowercase" passes for "short"');
  $('#signup-password').value = GOOD; $('#signup-password').dispatchEvent(new w.Event('input'));
  assert.equal(d.querySelectorAll('#password-rules li.ok').length, 5);
  $('#signup-confirm').value = 'different'; submit('#signup-form');
  await until(() => /don't match/.test($('#login-error').textContent), 'mismatch not caught');
  $('#signup-confirm').value = GOOD; submit('#signup-form');
  await until(() => !$('#auth-verify').hidden, 'verify step not shown');
  const demo = $('#demo-code').textContent.match(/\d{6}/)[0];
  $('#verify-code').value = demo; submit('#verify-form');
  await until(() => !$('#workspace').hidden && d.querySelectorAll('.chat-item').length === 3, 'workspace did not open');

  $('#logout').click();
  await until(() => !$('#auth-signin').hidden && $('#workspace').hidden, 'sign-in form not shown after sign out');
  assert.equal((await call('/api/state')).status, 401);
  $('#signin-email').value = PROFILE.email; $('#signin-password').value = 'Wrong-Password-1'; submit('#signin-form');
  await until(() => /Wrong email or password/.test($('#login-error').textContent), 'wrong password not reported');
  $('#signin-password').value = GOOD; submit('#signin-form');
  await until(() => !$('#workspace').hidden, 'sign in failed');
  assert.deepEqual(errors, []);
  $('#logout').click(); await sleep(50);
});

test('sign in through the Relay Accounts service: only a correctly signed, matching assertion is accepted', async t => {
  const { generateKeyPairSync, sign } = await import('node:crypto');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const assertion = (claims, key = privateKey) => {
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return payload + '.' + sign(null, Buffer.from(payload), key).toString('base64url');
  };
  const mails = [];
  const fakeFetch = async (url, init = {}) => {
    if (String(url) === 'https://accounts.test/providers') return Response.json([{ id: 'google', name: 'Google' }, { id: 'evil', name: 'Evil' }]);
    if (String(url) === 'https://accounts.test/email/code') { mails.push(JSON.parse(init.body)); return Response.json({ ok: true }); }
    throw new Error('unexpected ' + url);
  };
  const { call, port, store } = await start(t, { demo: false, accountsUrl: 'https://accounts.test', accountsPublicKey: pub, fetch: fakeFetch });
  assert.deepEqual((await call('/auth/status')).json.providers, [{ id: 'google', name: 'Google' }], 'unknown providers are ignored');
  assert.equal((await call('/auth/status')).json.emailReady, true, 'codes are emailed by the service: nothing to set up');

  async function begin() {
    const r = await call('/auth/oauth/google');
    const to = new URL(r.location);
    assert.equal(to.origin + to.pathname, 'https://accounts.test/oauth/start');
    assert.equal(to.searchParams.get('return_to'), `http://127.0.0.1:${port}/auth/broker/callback`);
    return { nonce: to.searchParams.get('nonce'), aud: to.searchParams.get('return_to') };
  }
  const good = ({ nonce, aud }, extra = {}) => ({ iss: 'https://accounts.test', aud, nonce, provider: 'google', id: 'g-1', email: 'ada@example.com', verified: true, name: 'Ada Lovelace', iat: Date.now(), exp: Date.now() + 60000, ...extra });
  const finish = a => call('/auth/broker/callback?assertion=' + encodeURIComponent(a));

  // Forged, tampered, replayed, expired or mismatched assertions are refused.
  const other = generateKeyPairSync('ed25519').privateKey;
  let req = await begin();
  assert.match(decodeURIComponent((await finish(assertion(good(req), other))).location), /could not be verified/);
  const signed = assertion(good(req)); const [payload, sig] = signed.split('.');
  const tampered = Buffer.from(JSON.stringify({ ...good(req), email: 'eve@example.com' })).toString('base64url') + '.' + sig;
  assert.match(decodeURIComponent((await finish(tampered)).location), /could not be verified/);
  assert.match(decodeURIComponent((await finish(assertion(good(req, { aud: 'http://127.0.0.1:1/auth/broker/callback' })))).location), /expired/);
  assert.match(decodeURIComponent((await finish(assertion(good(req, { exp: Date.now() - 1 })))).location), /expired/);
  assert.match(decodeURIComponent((await finish(assertion(good(req, { iss: 'https://evil.test' })))).location), /expired/);
  assert.match(decodeURIComponent((await finish(assertion(good({ nonce: 'never-issued-nonce-xxxxxxxx', aud: req.aud })))).location), /expired/);
  void payload;

  // A good one starts sign-up with the verified Google email; it can't be used twice.
  let r = await finish(signed);
  const ticket = new URL(r.location, 'http://x').searchParams.get('signup');
  assert.ok(ticket);
  assert.match(decodeURIComponent((await finish(signed)).location), /expired/, 'no replay');
  r = await call('/auth/signup', { body: { ...PROFILE, ticket } });
  assert.equal(r.json.signedIn, true);
  assert.equal(store.kv('account:owner').providers.google, 'g-1');
  assert.equal(mails.length, 0, 'no code needed: Google verified the email');

  // Later sign-ins go straight in; codes for a password reset go through the service.
  await call('/auth/logout', { body: {} });
  req = await begin();
  r = await finish(assertion(good(req)));
  assert.equal(r.location, '/'); assert.equal((await call('/api/state')).status, 200);
  await call('/auth/reset/request', { body: { email: 'ada@example.com' } });
  assert.equal(mails.length, 1); assert.equal(mails[0].to, 'ada@example.com'); assert.equal(mails[0].purpose, 'reset'); assert.match(mails[0].code, /^\d{6}$/);
  assert.equal(Object.keys(mails[0]).sort().join(), 'code,purpose,to', 'only the address, code and purpose leave the bridge');
});
