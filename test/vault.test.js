// Encryption at rest: the data folder is unreadable without its key, and a missing or wrong key
// stops Relay instead of starting over with empty data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Vault, openVault, useEncryptedAuthState, sealAuthFolder, readAuthFile, isSealed } from '../src/vault.js';
import { Store } from '../src/store.js';
import { Bridge } from '../src/tools.js';
import { WhatsApp } from '../src/whatsapp.js';

const MUM = '6590000002@s.whatsapp.net', MUM_LID = '59000000000002@lid', GROUP = '120363000000000009@g.us';
const tmp = t => { const d = mkdtempSync(join(tmpdir(), 'relay-vault-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
// A stand-in for the Keychain / DPAPI / key file.
const memoryStore = () => { const keys = new Map(); return { keys, get: id => { if (!keys.has(id)) throw new Error('not found'); return keys.get(id); }, put: (id, k) => keys.set(id, Buffer.from(k)) }; };
const fileBytes = dir => readdirSync(dir).filter(f => f.startsWith('bridge.sqlite')).map(f => readFileSync(join(dir, f))).reduce((a, b) => Buffer.concat([a, b]), Buffer.alloc(0));

test('sealed values decrypt only with the same key and context; IDs hash consistently', () => {
  const a = new Vault(randomBytes(32)), b = new Vault(randomBytes(32));
  const s = a.seal('I love you', 'message');
  assert.ok(isSealed(s) && !s.includes('love'));
  assert.equal(a.open(s, 'message'), 'I love you');
  assert.throws(() => a.open(s, 'chats'));
  assert.throws(() => b.open(s, 'message'));
  assert.notEqual(a.seal('x'), a.seal('x'), 'fresh IV every time');
  assert.equal(a.hash(MUM), a.hash(MUM));
  assert.notEqual(a.hash(MUM), b.hash(MUM));
  assert.ok(!a.hash(MUM).includes('6590000002'));
});

test('the key is created once, kept outside the data folder, and never replaced', t => {
  const dir = tmp(t), store = memoryStore();
  const v1 = openVault(dir, { store, env: {} });
  const meta = JSON.parse(readFileSync(join(dir, 'vault.json'), 'utf8'));
  assert.equal(store.keys.size, 1);
  assert.ok(!readFileSync(join(dir, 'vault.json'), 'utf8').includes(store.keys.get(meta.keyId).toString('base64')), 'the key is not in the data folder');
  const v2 = openVault(dir, { store, env: {} });
  assert.equal(v2.open(v1.seal('same', 'x'), 'x'), 'same');
  // Key gone (for example, the Keychain item was deleted): stop loudly, don't make a new one.
  store.keys.clear();
  assert.throws(() => openVault(dir, { store, env: {} }), /can't be opened without it/);
  assert.equal(JSON.parse(readFileSync(join(dir, 'vault.json'), 'utf8')).keyId, meta.keyId);
  // Wrong key.
  store.keys.set(meta.keyId, randomBytes(32));
  assert.throws(() => openVault(dir, { store, env: {} }), /not the right one/);
  // Hosted (production) without a key secret: stays unencrypted rather than losing a key on redeploy.
  assert.equal(openVault(tmp(t), { env: { NODE_ENV: 'production' } }), null);
  // Opting out, and bringing your own key.
  assert.equal(openVault(tmp(t), { env: { RELAY_ENCRYPTION: 'off' } }), null);
  const own = randomBytes(32).toString('base64'), d2 = tmp(t);
  const e1 = openVault(d2, { env: { RELAY_DATA_KEY: own } });
  assert.equal(openVault(d2, { env: { RELAY_DATA_KEY: own } }).open(e1.seal('ok', 'y'), 'y'), 'ok');
  assert.throws(() => openVault(d2, { env: { RELAY_DATA_KEY: randomBytes(32).toString('base64') } }), /not the right one/);
});

test('an existing plain database is encrypted in place: nothing readable left, everything still works', async t => {
  const dir = tmp(t), file = join(dir, 'bridge.sqlite');
  const plain = new Store(file);
  plain.put('contacts', { id: MUM, name: 'Mum Secretname' });
  plain.put('chats', { id: MUM, name: 'Mum Secretname', conversationTimestamp: 1794470000, preview: 'Dinner at seven' });
  plain.message({ chat: MUM, id: 'm1', timestamp: 1794470000, text: 'Dinner at seven', fromMe: false, kind: 'conversation' });
  plain.message({ chat: MUM, id: 'm2', timestamp: 1794470100, text: 'Bring the umbrella', fromMe: true, kind: 'conversation' });
  plain.message({ chat: MUM, id: 'p1', timestamp: 1794470200, text: '', fromMe: false, kind: 'imageMessage' });
  plain.event('message', MUM, { id: 'm2' });
  plain.draft(MUM, 'Draft about the surprise party');
  plain.newJob(MUM, 'Scheduled birthday wish', 1794500000);
  plain.kv('account:owner', { email: 'someone@example.com' });
  plain.close();
  assert.ok(fileBytes(dir).includes('Dinner at seven'), 'plain before');

  const vault = new Vault(randomBytes(32)), store = new Store(file, { vault });
  for (const secret of ['Dinner at seven', 'umbrella', 'Secretname', '6590000002', 'surprise party', 'birthday wish', 'someone@example.com'])
    assert.ok(!fileBytes(dir).includes(secret), `"${secret}" is not readable in the database file`);

  const bridge = new Bridge(store, { status: () => ({ state: 'connected' }), on() {} }, { allowed: new Set(), readOnly: false });
  assert.deepEqual((await bridge.call('list_chats', {})).map(c => [c.id, c.name]), [[MUM, 'Mum Secretname']]);
  assert.deepEqual(store.messages({ chat: MUM }).map(m => m.id), ['p1', 'm2', 'm1']);
  assert.deepEqual(store.messages({ query: 'UMBRELLA' }).map(m => m.id), ['m2'], 'search still works, case-insensitively');
  assert.deepEqual(store.messages({ query: 'e', limit: 1, offset: 1 }).map(m => m.id), ['m1']);
  assert.deepEqual(store.messages({ fromMe: true }).map(m => m.id), ['m2']);
  assert.deepEqual(store.messages({ mediaOnly: true }).map(m => m.id), ['p1']);
  assert.equal(store.events(0, 10).at(-1).chat, MUM);
  assert.equal(store.events(0, 10, MUM).length, 1);
  assert.equal(store.drafts()[0].chat, MUM);
  assert.equal(store.jobs()[0].text, 'Scheduled birthday wish');
  assert.equal(store.kv('account:owner').email, 'someone@example.com');
  store.close();

  assert.throws(() => new Store(file), /encrypted, but no key/);
  assert.throws(() => new Store(file, { vault: new Vault(randomBytes(32)) }));
  const again = new Store(file, { vault });
  assert.equal(again.getMessage(MUM, 'm1').text, 'Dinner at seven');
  again.close();
});

test('hidden-ID merges, edits and calls work the same on an encrypted database', async t => {
  const lib = await import('@whiskeysockets/baileys');
  const dir = mkdtempSync(join(tmpdir(), 'relay-vault-')), store = new Store(join(dir, 'bridge.sqlite'), { vault: new Vault(randomBytes(32)) });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const config = { allowed: new Set(), readOnly: false, demo: false, dir };
  const wa = new WhatsApp(store, config, lib); wa.BufferJSON = lib.BufferJSON; wa.sock = { user: { id: '6589999999@s.whatsapp.net' } };
  const bridge = new Bridge(store, wa, config);
  store.put('contacts', { id: MUM, name: 'Mum' });
  store.put('chats', { id: MUM_LID, conversationTimestamp: 1794000000 });
  store.message({ chat: MUM_LID, id: 'x', timestamp: 1794000000, text: 'hi', fromMe: false });
  store.event('message', MUM_LID, { id: 'x' });
  store.draft(MUM_LID, 'reply later');
  store.mergeChat(MUM_LID, MUM);
  assert.deepEqual((await bridge.call('list_chats', {})).map(c => [c.id, c.name]), [[MUM, 'Mum']]);
  assert.equal(store.getMessage(MUM, 'x').text, 'hi');
  assert.equal(store.events(0, 10, MUM).length, 1);
  assert.equal(store.drafts()[0].chat, MUM);
  wa.ingest({ key: { remoteJid: MUM, id: 'log-1', fromMe: true }, messageTimestamp: 1794480000, message: { callLogMesssage: { isVideo: false, callOutcome: 0, durationSecs: 39 } } });
  assert.equal(store.messages({ chat: MUM, limit: 1 })[0].kind, 'call');
  wa.ingest({ key: { remoteJid: GROUP, id: 'g1', fromMe: false, participant: MUM }, messageTimestamp: 1794490000, message: { conversation: 'group hello' } });
  assert.equal((await bridge.call('search_messages', { query: 'group hello' }))[0]?.id ?? (await bridge.call('search_messages', { query: 'group hello' })).messages?.[0]?.id, 'g1');
  store.message({ chat: GROUP, id: 'old', kind: 'secretEncryptedMessage', timestamp: 1, text: '' });
  wa.repairStored();
  assert.equal(store.getMessage(GROUP, 'old'), undefined);
});

test('WhatsApp session files are sealed; old plain files are converted; a wrong key never starts a new session', async t => {
  const lib = await import('@whiskeysockets/baileys');
  const dir = tmp(t), vault = new Vault(randomBytes(32));
  // Plain files left by an older Relay.
  writeFileSync(join(dir, 'creds.json'), JSON.stringify({ registered: true, me: { id: '6589999999:1@s.whatsapp.net' }, noiseKey: { private: { type: 'Buffer', data: 'AAEC' } } }));
  writeFileSync(join(dir, 'pre-key-1.json'), JSON.stringify({ public: { type: 'Buffer', data: 'AQID' } }));
  assert.equal(sealAuthFolder(dir, vault), 2);
  for (const f of readdirSync(dir)) assert.ok(isSealed(readFileSync(join(dir, f), 'utf8')), f + ' is sealed');
  assert.equal(JSON.parse(readAuthFile(dir, 'creds.json', vault)).me.id, '6589999999:1@s.whatsapp.net');

  const { state, saveCreds } = await useEncryptedAuthState(dir, vault, lib);
  assert.equal(state.creds.me.id, '6589999999:1@s.whatsapp.net');
  assert.ok(Buffer.isBuffer(state.creds.noiseKey.private));
  assert.deepEqual([...(await state.keys.get('pre-key', ['1']))['1'].public], [1, 2, 3]);
  await state.keys.set({ session: { 'abc:1': { x: Buffer.from('secret-session') } } });
  assert.ok(!readFileSync(join(dir, 'session-abc-1.json'), 'utf8').includes('secret-session'));
  assert.equal((await state.keys.get('session', ['abc:1']))['abc:1'].x.toString(), 'secret-session');
  await state.keys.set({ session: { 'abc:1': null } });
  assert.ok(!existsSync(join(dir, 'session-abc-1.json')));
  state.creds.me.name = 'Viaan'; await saveCreds();
  assert.equal((await useEncryptedAuthState(dir, vault, lib)).state.creds.me.name, 'Viaan');
  await assert.rejects(useEncryptedAuthState(dir, new Vault(randomBytes(32)), lib));
  assert.ok(isSealed(readFileSync(join(dir, 'creds.json'), 'utf8')), 'the old session is left untouched');
});

test('on Linux and Termux the key is a private file outside the data folder', { skip: process.platform === 'win32' }, t => {
  const dir = tmp(t), cfg = tmp(t), old = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = cfg; t.after(() => { if (old === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = old; });
  const v = openVault(dir, { platform: 'linux', env: {} });
  const meta = JSON.parse(readFileSync(join(dir, 'vault.json'), 'utf8'));
  const file = join(cfg, 'relay-whatsapp-mcp', 'keys', meta.keyId + '.key');
  assert.equal(meta.method, 'file');
  assert.equal((statSync(file).mode & 0o777).toString(8), '600');
  assert.equal(openVault(dir, { env: {} }).open(v.seal('ok', 'z'), 'z'), 'ok');
});
