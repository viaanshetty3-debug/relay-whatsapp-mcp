// WhatsApp's hidden IDs ("…@lid"): one chat per person, under their phone number and contact name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, toSeconds } from '../src/store.js';
import { Bridge } from '../src/tools.js';
import { WhatsApp } from '../src/whatsapp.js';

const DAD_PN = '6590000001@s.whatsapp.net', DAD_LID = '169000000000001@lid';
const MUM_PN = '6590000002@s.whatsapp.net', MUM_LID = '59000000000002@lid';

async function setup(t) {
  const lib = await import('@whiskeysockets/baileys');
  const store = new Store(':memory:'), config = { allowed: new Set(), readOnly: false, demo: false };
  const wa = new WhatsApp(store, config, lib); wa.BufferJSON = lib.BufferJSON; wa.sock = { user: { id: '6589999999@s.whatsapp.net' } };
  const bridge = new Bridge(store, wa, config);
  t.after(() => store.close());
  return { store, wa, bridge };
}
const msg = (key, text, ts) => ({ key: { id: Math.random().toString(36).slice(2), fromMe: false, ...key }, messageTimestamp: ts, pushName: 'Someone', message: { conversation: text } });

test('timestamps that arrive as 64-bit objects become plain seconds (no "Invalid Date")', () => {
  assert.equal(toSeconds({ low: 1793716136, high: 0, unsigned: true }), 1793716136);
  assert.equal(toSeconds('1793716136'), 1793716136);
  assert.equal(toSeconds(undefined), 0);
});

test('a message addressed by hidden ID is filed under the phone number when WhatsApp sends both', async t => {
  const { store, bridge, wa } = await setup(t);
  store.put('contacts', { id: MUM_PN, name: 'Mum' });
  wa.ingest(msg({ remoteJid: MUM_LID, remoteJidAlt: MUM_PN, addressingMode: 'lid' }, 'I love you', 1794470000));
  assert.equal(store.messages({ chat: MUM_LID }).length, 0);
  assert.equal(store.messages({ chat: MUM_PN })[0].text, 'I love you');
  const chats = await bridge.call('list_chats', {});
  assert.deepEqual(chats.map(c => [c.id, c.name, c.conversationTimestamp]), [[MUM_PN, 'Mum', 1794470000]]);
  // Later messages with only the hidden ID still land in the same chat.
  wa.ingest(msg({ remoteJid: MUM_LID }, 'Newest', 1794480000));
  assert.deepEqual(store.messages({ chat: MUM_PN }).map(m => m.text), ['Newest', 'I love you']);
});

test('chats already stored under a hidden ID are merged into the phone-number chat, newest preview kept', async t => {
  const { store, bridge, wa } = await setup(t);
  // What an older Relay left behind: an old phone-number chat and a newer, nameless hidden-ID chat.
  store.put('contacts', { id: DAD_PN, name: 'Dad', lid: DAD_LID });
  store.put('chats', { id: DAD_PN, conversationTimestamp: 1793000000, preview: 'old' });
  store.message({ chat: DAD_PN, id: 'a', timestamp: 1793000000, text: 'old', fromMe: true });
  store.put('chats', { id: DAD_LID, conversationTimestamp: { low: 1794000000, high: 0, unsigned: true }, preview: 'Hello dear', unreadCount: 1 });
  store.message({ chat: DAD_LID, id: 'b', timestamp: 1794000000, text: 'Hello dear', fromMe: false });
  store.event('message', DAD_LID, { id: 'b' });
  await wa.resolveLids();
  assert.equal(store.getChat(DAD_LID), undefined);
  const dad = (await bridge.call('list_chats', {}))[0];
  assert.deepEqual([dad.id, dad.name, dad.preview, dad.conversationTimestamp, dad.unreadCount], [DAD_PN, 'Dad', 'Hello dear', 1794000000, 1]);
  assert.deepEqual(store.messages({ chat: DAD_PN }).map(m => m.text), ['Hello dear', 'old']);
  assert.equal(store.events(0, 10).at(-1).chat, DAD_PN);
});

test('WhatsApp\'s own ID map resolves hidden-ID chats Relay has no other clue for', async t => {
  const { store, bridge, wa } = await setup(t);
  wa.sock.signalRepository = { lidMapping: { getPNForLID: async lid => (lid === MUM_LID ? MUM_PN + '' : null) } };
  store.put('contacts', { id: MUM_PN, notify: 'Mummy' });
  store.put('chats', { id: MUM_LID, conversationTimestamp: 1794000000 });
  store.message({ chat: MUM_LID, id: 'x', timestamp: 1794000000, text: 'hi', fromMe: false });
  await wa.resolveLids();
  assert.deepEqual((await bridge.call('list_chats', {})).map(c => [c.id, c.name]), [[MUM_PN, 'Mummy']]);
  // Replies and edits look messages up by the key WhatsApp gives, hidden ID or not.
  assert.equal(wa.raw(wa.canonical(MUM_LID), 'x'), undefined, 'raw only exists for ingested messages');
  assert.equal(store.getMessage(wa.canonical(MUM_LID), 'x').text, 'hi');
});

test('load older messages asks the phone for history before the oldest synced message', async t => {
  const { store, wa } = await setup(t);
  const calls = [];
  wa.state = 'connected'; wa.sock.fetchMessageHistory = async (...a) => { calls.push(a); return 'req'; };
  wa.ingest(msg({ remoteJid: MUM_PN }, 'second', 1794000100));
  wa.ingest(msg({ remoteJid: MUM_PN }, 'first', 1794000000));
  const r = await wa.loadOlder(MUM_PN);
  assert.equal(r.before, 1794000000);
  assert.equal(calls[0][0], 50); assert.equal(calls[0][2], 1794000000); assert.equal(calls[0][1].remoteJid, MUM_PN);
  await assert.rejects(wa.loadOlder('6500000000@s.whatsapp.net'), /no messages/);
  assert.equal(store.messages({ chat: MUM_PN }).length, 2);
});

test('encrypted edits (secretEncryptedMessage) are decrypted and applied, never shown as a message', async t => {
  const { store, wa } = await setup(t);
  const { hmacSign, aesEncryptGCM, proto } = await import('@whiskeysockets/baileys');
  const group = '120363000000000001@g.us', dad = '169000000000001@lid', secret = Buffer.alloc(32, 7);
  wa.ingest({ key: { remoteJid: group, id: 'orig-1', fromMe: false, participant: dad }, messageTimestamp: 1794470000, message: { conversation: 'See you at 5', messageContextInfo: { messageSecret: secret } } });
  const inner = proto.Message.encode({ protocolMessage: { type: 14, key: { remoteJid: group, id: 'orig-1', fromMe: true }, editedMessage: { conversation: 'See you at 6' } } }).finish();
  const info = Buffer.concat([Buffer.from('orig-1'), Buffer.from(dad), Buffer.from(dad), Buffer.from('Message Edit'), new Uint8Array([1])]);
  const key = hmacSign(info, hmacSign(secret, new Uint8Array(32), 'sha256'), 'sha256'), iv = Buffer.alloc(12, 3);
  const encPayload = aesEncryptGCM(Buffer.from(inner), key, iv, Buffer.alloc(0));
  // WhatsApp marks the target fromMe from the editor's side.
  wa.ingest({ key: { remoteJid: group, id: 'edit-1', fromMe: false, participant: dad.replace('@', ':12@') }, messageTimestamp: 1794470100, message: { secretEncryptedMessage: { targetMessageKey: { remoteJid: group, id: 'orig-1', fromMe: true }, encPayload, encIv: iv, secretEncType: 2 } } });
  assert.equal(store.getMessage(group, 'orig-1').text, 'See you at 6');
  assert.equal(store.getMessage(group, 'orig-1').edited, true);
  assert.equal(store.getMessage(group, 'edit-1'), undefined, 'the control message is not stored');
  // One that can't be decrypted (unknown original) is dropped rather than shown as "[secretEncryptedMessage]".
  wa.ingest({ key: { remoteJid: group, id: 'edit-2', fromMe: false, participant: dad }, messageTimestamp: 1794470200, message: { secretEncryptedMessage: { targetMessageKey: { remoteJid: group, id: 'missing' }, encPayload, encIv: iv, secretEncType: 2 } } });
  assert.equal(store.getMessage(group, 'edit-2'), undefined);
  // Rows saved by older versions are repaired.
  store.message({ chat: group, id: 'old-row', kind: 'secretEncryptedMessage', timestamp: 1794470300, text: '', raw: JSON.stringify({ key: { remoteJid: group, id: 'old-row', participant: dad }, message: { secretEncryptedMessage: { targetMessageKey: { remoteJid: group, id: 'orig-1', fromMe: true }, encPayload: encPayload.toString('base64'), encIv: iv.toString('base64'), secretEncType: 'MESSAGE_EDIT' } } }) });
  wa.repairStored();
  assert.equal(store.getMessage(group, 'old-row'), undefined);
});
