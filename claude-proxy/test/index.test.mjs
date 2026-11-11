import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
const env = { PROXY_KEY: 'proxy-secret', SITE_KEY: 'site-secret', CLIENT_KEY: 'client-secret', RELAY_URL: 'https://relay.example.test/whatsapp/mcp' };
function withFetch(fn) { const orig = globalThis.fetch; const calls = []; globalThis.fetch = async (url, init) => { calls.push({ url, init }); return new Response('{"jsonrpc":"2.0","id":1,"result":{}}', { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': 'x=1', 'mcp-session-id': 's1' } }); }; return fn(calls).finally(() => { globalThis.fetch = orig; }); }
const req = (headers = {}, path = '/mcp', method = 'POST') => new Request('https://w.example.test' + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: method === 'POST' ? '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' : undefined });
test('rejects missing or wrong key without calling the relay', () => withFetch(async calls => {
  assert.equal((await worker.fetch(req(), env)).status, 401);
  assert.equal((await worker.fetch(req({ 'x-api-key': 'wrong' }), env)).status, 401);
  assert.equal((await worker.fetch(req({ 'x-api-key': 'proxy-secret' }, '/other'), env)).status, 404);
  assert.equal(calls.length, 0);
}));
test('forwards with relay headers, drops the proxy key and unrelated headers', () => withFetch(async calls => {
  const res = await worker.fetch(req({ 'x-api-key': 'proxy-secret', 'mcp-protocol-version': '2025-11-25', cookie: 'secret=1' }), env);
  assert.equal(res.status, 200); assert.equal(res.headers.get('mcp-session-id'), 's1'); assert.equal(res.headers.get('set-cookie'), null);
  const h = calls[0].init.headers;
  assert.equal(calls[0].url, env.RELAY_URL);
  assert.equal(h.get('OAI-Sites-Authorization'), 'Bearer site-secret'); assert.equal(h.get('X-Relay-Client-Key'), 'client-secret');
  assert.equal(h.get('x-api-key'), null); assert.equal(h.get('cookie'), null); assert.equal(h.get('mcp-protocol-version'), '2025-11-25');
  assert.equal(await new Response(calls[0].init.body).text(), '{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
}));
test('refuses to run unconfigured', () => withFetch(async () => {
  assert.equal((await worker.fetch(req({ 'x-api-key': 'proxy-secret' }), { ...env, CLIENT_KEY: '' })).status, 500);
  assert.equal((await worker.fetch(req({ 'x-api-key': 'proxy-secret' }), { ...env, RELAY_URL: '' })).status, 500);
}));
test('the host credential is optional', () => withFetch(async calls => {
  assert.equal((await worker.fetch(req({ 'x-api-key': 'proxy-secret' }), { ...env, SITE_KEY: undefined })).status, 200);
  assert.equal(calls[0].init.headers.get('OAI-Sites-Authorization'), null);
  assert.equal(calls[0].init.headers.get('X-Relay-Client-Key'), 'client-secret');
}));
test('uses the RELAY service binding when present (same-account relay Worker)', () => withFetch(async calls => {
  const bound = [];
  const RELAY = { fetch: async (url, init) => { bound.push(new Request(url, { ...init, duplex: 'half' })); return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }); } };
  const res = await worker.fetch(req({ 'x-api-key': 'proxy-secret' }), { ...env, RELAY });
  assert.equal(res.status, 200); assert.equal(calls.length, 0, 'no public fetch');
  assert.equal(bound[0].url, env.RELAY_URL); assert.equal(bound[0].headers.get('X-Relay-Client-Key'), 'client-secret'); assert.equal(bound[0].headers.get('x-api-key'), null);
}));
