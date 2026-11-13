// Several WhatsApp profiles in one Relay: separate data, one AI connection, dashboard switcher.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { JSDOM, VirtualConsole } from 'jsdom';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store } from '../src/store.js';
import { DemoWhatsApp } from '../src/demo.js';
import { Bridge } from '../src/tools.js';
import { Profiles, ProfileRouter, MAX_PROFILES } from '../src/profiles.js';
import { createApp } from '../src/server.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, message) { for (let i = 0; i < 150; i++) { if (await fn()) return; await sleep(20); } throw new Error(message); }
const ALEX = '15550100001@s.whatsapp.net';

function setup(t, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'relay-profiles-'));
  const config = { dir, token: 'test'.repeat(16), allowed: new Set(), demo: true, readOnly: false, port: 0, base: 'http://127.0.0.1:0', ...extra };
  const store = new Store(join(dir, 'bridge.sqlite'));
  const main = new Bridge(store, new DemoWhatsApp(store, config), config);
  const profiles = new Profiles(config, main);
  t.after(async () => { await profiles.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, config, store, main, profiles };
}

test('profiles: each WhatsApp gets its own folder and data, and the list survives a restart', async t => {
  const { dir, config, main, profiles } = setup(t);
  assert.deepEqual(profiles.list().map(p => [p.id, p.name, p.main]), [['main', 'Main', true]]);

  const work = profiles.create('  Work  ');
  assert.match(work.id, /^[a-f0-9]{8}$/); assert.equal(work.name, 'Work'); assert.equal(work.main, false);
  assert.ok(existsSync(join(dir, 'profiles', work.id, 'bridge.sqlite')), 'own database');
  assert.throws(() => profiles.create('work'), /already exists/);
  assert.throws(() => profiles.create('   '), /name/);
  assert.equal(profiles.get('WORK').id, work.id, 'found by name, any case');
  assert.equal(profiles.get(work.id).id, work.id);
  assert.equal(profiles.get().id, 'main');
  assert.throws(() => profiles.get('../../etc'), /No WhatsApp profile/);

  // Messages sent through one profile stay in that profile.
  const router = new ProfileRouter(profiles);
  await router.call('send_message', { chat: ALEX, text: 'from work', profile: 'Work' });
  await router.call('send_message', { chat: ALEX, text: 'from main' });
  const texts = async p => (await router.call('get_messages', { chat: ALEX, limit: 50, ...(p ? { profile: p } : {}) })).map(m => m.text);
  assert.ok((await texts('Work')).includes('from work')); assert.ok(!(await texts('Work')).includes('from main'));
  assert.ok((await texts()).includes('from main')); assert.ok(!(await texts()).includes('from work'));
  await assert.rejects(router.call('send_message', { chat: ALEX, text: 'x', profile: 'Nope' }), /No WhatsApp profile/);
  await assert.rejects(router.call('send_message', { chat: ALEX, text: 'x', profile: 7 }), /profile must be/);
  assert.deepEqual((await router.call('list_profiles', {})).map(p => p.name), ['Main', 'Work']);

  profiles.rename('main', 'Personal');
  assert.throws(() => profiles.rename(work.id, 'personal'), /already exists/);
  const saved = JSON.parse(readFileSync(join(dir, 'profiles.json'), 'utf8'));
  assert.equal(saved.mainName, 'Personal'); assert.deepEqual(saved.profiles.map(p => p.name), ['Work']);

  // A restart finds the same profiles and their data.
  const again = new Profiles(config, main);
  assert.deepEqual(again.list().map(p => p.name), ['Personal', 'Work']);
  assert.ok((await new ProfileRouter(again).call('get_messages', { chat: ALEX, limit: 50, profile: 'Work' })).some(m => m.text === 'from work'));
  await again.close(again.get('Work'));

  await assert.rejects(profiles.remove('main'), /can’t be removed/);
  assert.deepEqual(await profiles.remove('Work'), { removed: work.id });
  assert.ok(!existsSync(join(dir, 'profiles', work.id)), 'folder deleted');
  assert.deepEqual(profiles.list().map(p => p.name), ['Personal']);
});

test('profiles: there is a sensible limit', t => {
  const { profiles } = setup(t);
  for (let i = 1; i < MAX_PROFILES; i++) profiles.create('P' + i);
  assert.throws(() => profiles.create('One too many'), new RegExp(`up to ${MAX_PROFILES}`));
});

async function serve(t, profiles, config) {
  const server = createServer(); server.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  config.port = server.address().port; config.base = 'http://127.0.0.1:' + config.port;
  server.on('request', createApp(profiles, config));
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  return config.base;
}

test('profiles over HTTP: dashboard routes pick a profile, and one MCP connection reaches all of them', async t => {
  const { config, profiles } = setup(t);
  const base = await serve(t, profiles, config);
  const auth = { Authorization: 'Bearer ' + config.token, 'Content-Type': 'application/json' };
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: auth, body: JSON.stringify(body) });

  assert.equal((await fetch(base + '/api/profiles')).status, 401, 'owner only');
  let r = await post('/api/profiles', { name: 'Shop' });
  assert.equal(r.status, 201); const shop = await r.json();
  r = await post('/api/profiles', { name: 'shop' }); assert.equal(r.status, 400); assert.match((await r.json()).error, /already exists/);

  const state = await (await fetch(base + '/api/state?profile=' + shop.id, { headers: auth })).json();
  assert.deepEqual(state.profiles.map(p => p.name), ['Main', 'Shop']);
  assert.equal(state.state, 'connected');
  assert.equal((await fetch(base + '/api/state?profile=missing', { headers: auth })).status, 400);

  await post('/api/disconnect?profile=' + shop.id, {});
  assert.equal(profiles.get('Shop').bridge.wa.state, 'disconnected', 'only that profile');
  assert.equal(profiles.get('main').bridge.wa.state, 'connected');
  await post('/api/connect?profile=' + shop.id, {});

  // The dashboard's tool route honours ?profile=, and an explicit profile argument wins.
  await post('/api/tools/send_message?profile=' + shop.id, { chat: ALEX, text: 'shop hello' });
  const shopMsgs = (await (await post('/api/tools/get_messages', { chat: ALEX, limit: 50, profile: 'Shop' })).json()).result.map(m => m.text);
  assert.ok(shopMsgs.includes('shop hello'));
  const mainMsgs = (await (await post('/api/tools/get_messages', { chat: ALEX, limit: 50 })).json()).result.map(m => m.text);
  assert.ok(!mainMsgs.includes('shop hello'));

  // One MCP connection: list_profiles plus a `profile` argument on every tool.
  const client = new Client({ name: 'profiles-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + config.token } } }));
  t.after(() => client.close());
  const { tools } = await client.listTools();
  assert.equal(tools.length, 38);
  assert.ok(tools.filter(x => x.name !== 'list_profiles').every(x => x.inputSchema.properties.profile), 'every tool takes profile');
  const listed = JSON.parse((await client.callTool({ name: 'list_profiles', arguments: {} })).content[0].text);
  assert.deepEqual(listed.map(p => p.name), ['Main', 'Shop']);
  await client.callTool({ name: 'send_message', arguments: { chat: ALEX, text: 'via mcp', profile: 'Shop' } });
  assert.ok(profiles.get('Shop').bridge.store.messages({ chat: ALEX, limit: 50 }).some(m => m.text === 'via mcp'));
  const bad = await client.callTool({ name: 'list_chats', arguments: { profile: 'Ghost' } });
  assert.equal(bad.isError, true); assert.match(bad.content[0].text, /No WhatsApp profile/);

  r = await post('/api/profiles/' + shop.id + '/rename', { name: 'Store' }); assert.equal((await r.json()).name, 'Store');
  r = await post('/api/profiles/main/remove', {}); assert.equal(r.status, 400);
  r = await post('/api/profiles/' + shop.id + '/remove', {}); assert.deepEqual(await r.json(), { removed: shop.id });
  assert.deepEqual(profiles.list().map(p => p.name), ['Main']);
});

test('dashboard: add a WhatsApp, switch between profiles, rename and remove', async t => {
  const { config, profiles } = setup(t);
  const base = await serve(t, profiles, config);
  const errors = [], vc = new VirtualConsole(); vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'), { url: base, runScripts: 'outside-only', virtualConsole: vc });
  const w = dom.window, d = w.document, $ = s => d.querySelector(s);
  w.fetch = (url, opts) => fetch(base + url, opts); w.TextDecoder = TextDecoder; w.AbortController = AbortController; w.confirm = () => true;
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; }; w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  Object.defineProperty(w.crypto, 'randomUUID', { value: randomUUID });
  t.after(async () => { w.close(); await sleep(20); });
  w.eval(readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'));
  const submit = form => $(form).dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  const choose = value => { $('#profile-select').value = value; $('#profile-select').dispatchEvent(new w.Event('change', { bubbles: true })); };

  $('#token').value = config.token; submit('#login-form');
  await until(() => !$('#workspace').hidden && d.querySelectorAll('.chat-item').length === 3, 'Login failed');
  assert.deepEqual([...d.querySelectorAll('#profile-select option')].map(o => o.value), ['main', '__add']);

  // Add one from the menu.
  choose('__add'); await until(() => $('#profile-dialog').open, 'Add dialog'); assert.equal($('#profile-select').value, 'main');
  $('#profile-name').value = 'Work'; submit('#profile-form');
  await until(() => profiles.list().length === 2 && $('#profile-select').value !== 'main', 'Add failed');
  const work = profiles.get('Work');
  assert.equal($('#profile-select').value, work.id);
  assert.match($('#profile-select').selectedOptions[0].textContent, /Work/);

  // Messages sent from the dashboard go to the selected profile only.
  await until(() => d.querySelectorAll('.chat-item').length === 3, 'Work chats');
  $('.chat-item').click(); await until(() => d.querySelectorAll('.message').length === 3, 'Work chat render');
  $('#message-input').value = 'Hello from Work'; submit('#composer');
  await until(() => work.bridge.store.messages({ chat: ALEX, limit: 50 }).some(m => m.text === 'Hello from Work'), 'Send in Work failed');
  assert.ok(!profiles.get('main').bridge.store.messages({ chat: ALEX, limit: 50 }).some(m => m.text === 'Hello from Work'));

  choose('main');
  await until(() => d.querySelector('#messages').textContent.includes('Choose a conversation'), 'Switch back failed');
  assert.equal(w.localStorage.getItem('relay-profile'), 'main');

  // Rename and remove through the ⋯ dialog (removal needs a second click).
  choose(work.id); await until(() => w.localStorage.getItem('relay-profile') === work.id, 'Switch failed');
  $('#profile-manage').click(); assert.equal($('#profile-remove-area').hidden, false);
  $('#profile-name').value = 'Office'; submit('#profile-form');
  await until(() => profiles.get(work.id).name === 'Office', 'Rename failed');
  $('#profile-manage').click(); $('#profile-remove').click();
  assert.equal(profiles.list().length, 2, 'first click only arms');
  $('#profile-remove').click();
  await until(() => profiles.list().length === 1 && $('#profile-select').value === 'main', 'Remove failed');

  // The main profile can be renamed but never removed.
  $('#profile-manage').click(); assert.equal($('#profile-remove-area').hidden, true);
  assert.deepEqual(errors, []);
});
