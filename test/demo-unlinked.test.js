import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { DemoWhatsApp } from '../src/demo.js';
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('practice mode can start unlinked: a clearly pretend QR first, sample chats only after linking', async t => {
  const store = new Store(':memory:');
  const wa = new DemoWhatsApp(store, { demo: true, demoUnlinked: true });
  t.after(async () => { await wa.stop(); store.close(); });
  assert.equal(wa.status().state, 'disconnected');
  assert.equal(wa.status().account, null);
  assert.equal(store.list('chats').length, 0, 'no sample chats before linking');
  const s = await wa.start();
  assert.equal(s.state, 'pairing');
  assert.match(wa.qr, /^data:image\/png;base64,/);
  assert.equal(store.list('chats').length, 0, 'still no chats while the pretend QR shows');
  await assert.rejects(() => wa.send('15550100001@s.whatsapp.net', { text: 'hi' }), /disconnected/);
  for (let i = 0; i < 200 && wa.state !== 'connected'; i++) await sleep(50);
  assert.equal(wa.state, 'connected');
  assert.equal(wa.qr, null);
  assert.equal(store.list('chats').length, 3);
  assert.ok(wa.status().account);
  const sent = await wa.send('15550100001@s.whatsapp.net', { text: 'Sure, sending the notes now.' });
  assert.equal(sent.status, 'demo_submitted');
});

test('practice mode without demoUnlinked still starts linked (existing behaviour)', async t => {
  const store = new Store(':memory:');
  const wa = new DemoWhatsApp(store, { demo: true });
  t.after(() => store.close());
  assert.equal(wa.status().state, 'connected');
  assert.equal(store.list('chats').length, 3);
});
