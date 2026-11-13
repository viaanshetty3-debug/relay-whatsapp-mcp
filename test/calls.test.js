// Call logs: missed-call notices, call-log entries and live call events become one entry per call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Bridge } from '../src/tools.js';
import { WhatsApp, callText } from '../src/whatsapp.js';

const MUM = '6590000002@s.whatsapp.net', MUM_LID = '59000000000002@lid';
async function setup(t) {
  const lib = await import('@whiskeysockets/baileys');
  const store = new Store(':memory:'), config = { allowed: new Set(), readOnly: false, demo: false };
  const wa = new WhatsApp(store, config, lib); wa.BufferJSON = lib.BufferJSON; wa.sock = { user: { id: '6589999999@s.whatsapp.net' } };
  t.after(() => store.close());
  return { store, wa, bridge: new Bridge(store, wa, config) };
}
const calls = (store, chat = MUM) => store.messages({ chat }).filter(m => m.kind === 'call');

test('call text reads like WhatsApp', () => {
  assert.equal(callText({ video: false, direction: 'incoming', outcome: 'missed' }), '📞 Missed voice call');
  assert.equal(callText({ video: true, direction: 'outgoing', outcome: 'answered', durationSecs: 125 }), '📹 Outgoing video call · 2 min 5 s');
  assert.equal(callText({ video: false, direction: 'outgoing', outcome: 'declined' }), '📞 Outgoing voice call · declined');
  assert.equal(callText({ video: false, group: true, direction: 'incoming', outcome: 'missed' }), '📞 Missed group voice call');
});

test('missed-call notices and call-log entries are stored in the chat', async t => {
  const { store, wa, bridge } = await setup(t);
  wa.ingest({ key: { remoteJid: MUM, id: 'missed-1', fromMe: false }, messageTimestamp: 1794470000, messageStubType: 41 });
  wa.ingest({ key: { remoteJid: MUM, id: 'log-1', fromMe: true }, messageTimestamp: 1794480000, message: { callLogMesssage: { isVideo: false, callOutcome: 0, durationSecs: 39 } } });
  assert.deepEqual(calls(store).map(m => m.text), ['📞 Outgoing voice call · 39 s', '📹 Missed video call']);
  const chat = (await bridge.call('list_chats', {}))[0];
  assert.equal(chat.preview, '📞 Outgoing voice call · 39 s');
  // The AI sees them in get_messages, with structured details.
  const latest = (await bridge.call('get_messages', { chat: MUM, limit: 1 }))[0];
  assert.deepEqual([latest.kind, latest.call.durationSecs, latest.call.direction], ['call', 39, 'outgoing']);
});

test('live calls: ringing → answered → ended gives one entry with the length; missed and declined too', async t => {
  const { store, wa } = await setup(t);
  const at = s => new Date(s * 1000);
  // Hidden-ID caller with their phone number attached: filed under the phone number.
  wa.onCall({ id: 'c1', chatId: MUM_LID, from: MUM_LID, callerPn: MUM, status: 'offer', isVideo: false, date: at(1794500000) });
  assert.equal(calls(store)[0].text, '📞 Incoming voice call…');
  wa.onCall({ id: 'c1', chatId: MUM_LID, from: MUM_LID, status: 'accept', date: at(1794500005) });
  wa.onCall({ id: 'c1', chatId: MUM_LID, from: MUM_LID, status: 'terminate', date: at(1794500130) });
  assert.deepEqual(calls(store).map(m => m.text), ['📞 Incoming voice call · 2 min 5 s']);
  assert.equal(calls(store)[0].timestamp, 1794500000, 'keeps the time it started ringing');

  wa.onCall({ id: 'c2', chatId: MUM, from: MUM, status: 'offer', isVideo: true, date: at(1794600000) });
  wa.onCall({ id: 'c2', chatId: MUM, from: MUM, status: 'timeout', isVideo: true, date: at(1794600030) });
  // Baileys also emits its own missed-call notice for the same call: still one entry.
  wa.ingest({ key: { remoteJid: MUM, id: 'c2', fromMe: false }, messageTimestamp: 1794600030, messageStubType: 41 });
  wa.onCall({ id: 'c3', chatId: MUM, from: MUM, status: 'offer', isVideo: false, date: at(1794700000) });
  wa.onCall({ id: 'c3', chatId: MUM, from: MUM, status: 'reject', date: at(1794700004) });
  // Rang and stopped without being answered here or elsewhere: missed.
  wa.onCall({ id: 'c4', chatId: MUM, from: MUM, status: 'offer', isVideo: false, date: at(1794800000) });
  wa.onCall({ id: 'c4', chatId: MUM, from: MUM, status: 'terminate', date: at(1794800020) });
  assert.deepEqual(calls(store).map(m => m.text), ['📞 Missed voice call', '📞 Incoming voice call · declined', '📹 Missed video call', '📞 Incoming voice call · 2 min 5 s']);
  assert.equal(store.events(0, 100).filter(e => e.type === 'call').length, 4, 'one "call" event per call for live updates');
});
