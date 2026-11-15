// An account that follows its owner to other computers (optional, off until the owner turns it on).
//
// What travels, through the Relay Accounts service (accounts-worker/):
//   • the account's name, country and phone, the names of its WhatsApp profiles, and which
//     AI apps were set up: all inside one blob that is encrypted on this computer.
// What never leaves this computer:
//   • the password, the WhatsApp session, messages, contacts, media, and AI-app tokens.
//
// Two keys are derived from the password (scrypt): one proves who you are to the service, the
// other encrypts the blob and is never sent. So the service stores something it cannot read.
// A WhatsApp session can't be copied between computers (that breaks the link for both), so each
// computer links its own device once; the blob only says which profiles to set up.
import { randomBytes, scrypt as scryptCb, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const PENDING_TTL = 15 * 60000, PUSH_DELAY = 2000;
const lower = s => String(s || '').trim().toLowerCase();

export async function deriveKeys(password, salt) {
  const out = await scrypt(String(password), 'relay-account-sync:' + salt, 64, SCRYPT);
  return { auth: out.subarray(0, 32).toString('base64url'), enc: out.subarray(32).toString('base64url') };
}
export function sealBlob(enc, email, data) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', Buffer.from(enc, 'base64url'), iv);
  cipher.setAAD(Buffer.from('relay-account:' + lower(email)));
  const box = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return `v1.${iv.toString('base64url')}.${box.toString('base64url')}`;
}
export function openBlob(enc, email, text) {
  const [v, iv, box] = String(text || '').split('.');
  if (v !== 'v1' || !iv || !box) throw new Error('Unreadable account data');
  const raw = Buffer.from(box, 'base64url'), decipher = createDecipheriv('aes-256-gcm', Buffer.from(enc, 'base64url'), Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from('relay-account:' + lower(email)));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]).toString('utf8'));
}

export function createCloud(config, spaces) {
  const fetchImpl = config.fetch || fetch;
  // Practice mode never talks to the service: its accounts are pretend.
  const available = () => Boolean(config.accountsUrl) && !config.demo;
  const pending = new Map(); // space id → keys waiting for the emailed code
  const timers = new Map();
  const saved = space => space.store.kv('cloud:sync') || null;
  const save = (space, record) => space.store.kv('cloud:sync', record);

  async function post(path, body) {
    let res;
    try { res = await fetchImpl(config.accountsUrl + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) }); }
    catch { throw new Error('Relay couldn\'t reach the Relay Accounts service. Check the internet connection and try again.'); }
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }
  const fail = (r, fallback) => { const e = new Error(r.body?.error || fallback); e.status = r.status === 429 ? 429 : 400; return e; };

  // The parts of an account that travel.
  const names = space => Object.fromEntries(space.profiles.all().filter(p => p.id !== 'main').map(p => [p.id, p.name]));
  function snapshot(space, owner, sync) {
    return {
      v: 1, profile: { fullName: owner.fullName, country: owner.country, phone: owner.phone },
      mainName: space.profiles.main.name, profiles: Object.entries(names(space)).map(([id, name]) => ({ id, name })),
      aiApps: { ...(sync.aiApps || {}), ...(space.store.kv('apps:here') || {}) }, updatedAt: Date.now(),
    };
  }
  // Brings another computer's changes here. It only ever adds or renames: a profile removed
  // elsewhere stays linked on this computer until its owner removes it here too.
  function merge(space, blob, sync) {
    const base = sync.base || { mainName: null, profiles: {} }, gone = new Set(sync.tombstones || []), mine = names(space);
    if (blob.mainName && blob.mainName !== space.profiles.main.name && (base.mainName === null || space.profiles.main.name === base.mainName))
      try { space.profiles.rename('main', blob.mainName); } catch {}
    for (const p of Array.isArray(blob.profiles) ? blob.profiles : []) {
      if (!/^[a-f0-9]{8}$/.test(p?.id) || gone.has(p.id)) continue;
      try {
        if (!(p.id in mine)) space.profiles.create(p.name, { id: p.id });
        else if (mine[p.id] !== p.name && mine[p.id] === base.profiles?.[p.id]) space.profiles.rename(p.id, p.name);
      } catch (e) { console.error(`Account sync (${String(p.name).slice(0, 40)}): ${e.message}`); }
    }
    return { ...sync, aiApps: { ...(blob.aiApps || {}), ...(sync.aiApps || {}) } };
  }
  const remember = (space, sync, rev) => save(space, { ...sync, rev, base: { mainName: space.profiles.main.name, profiles: names(space) }, at: Date.now(), error: null });

  // Pull, merge, push. Safe to call often; one at a time per account.
  const running = new Map();
  function sync(space) {
    if (!running.has(space.id)) running.set(space.id, run(space).finally(() => running.delete(space.id)));
    return running.get(space.id);
  }
  async function run(space) {
    let record = saved(space);
    if (!available() || !record) return status(space);
    const owner = space.store.kv('account:owner');
    try {
      const got = await post('/account/login', { email: record.email, auth: record.auth });
      if (got.status === 401) { save(space, { ...record, error: 'password' }); return status(space); }
      if (got.status !== 200) throw fail(got, 'The Relay Accounts service did not answer.');
      for (let attempt = 0, rev = got.body.rev, blob = got.body.blob; attempt < 3; attempt++) {
        record = merge(space, openBlob(record.enc, record.email, blob), saved(space));
        const out = await post('/account/save', { email: record.email, auth: record.auth, rev, blob: sealBlob(record.enc, record.email, snapshot(space, owner, record)) });
        if (out.status === 200) { remember(space, record, out.body.rev); break; }
        if (out.status !== 409) throw fail(out, 'The Relay Accounts service did not save the change.');
        rev = out.body.rev; blob = out.body.blob; // another computer saved first: merge that and try again
      }
    } catch (e) {
      console.error('Account sync:', String(e?.message || e).slice(0, 200));
      save(space, { ...saved(space), error: 'offline' });
    }
    return status(space);
  }
  function schedule(space) {
    if (!available() || !saved(space)) return;
    clearTimeout(timers.get(space.id));
    const t = setTimeout(() => { timers.delete(space.id); sync(space).catch(() => {}); }, PUSH_DELAY); t.unref?.();
    timers.set(space.id, t);
  }
  // A profile removed here is remembered, so another computer's copy doesn't bring it back.
  function onChange(space) {
    const record = saved(space); if (!record) return;
    const now = names(space), gone = new Set(record.tombstones || []);
    for (const id of Object.keys(record.base?.profiles || {})) if (!(id in now)) gone.add(id);
    save(space, { ...record, tombstones: [...gone].slice(-100) });
    schedule(space);
  }
  const watched = new WeakSet();
  function watch(space) {
    if (watched.has(space)) return; watched.add(space);
    space.profiles.on('change', () => { try { onChange(space); } catch (e) { console.error('Account sync:', e.message); } });
  }
  for (const s of spaces.all()) watch(s);

  function status(space) {
    const record = saved(space);
    return {
      available: available(), on: Boolean(record), email: record?.email, lastSync: record?.at || null,
      waitingForCode: pending.has(space.id) && pending.get(space.id).expires > Date.now(),
      problem: record?.error === 'password' ? 'The password was changed on another computer. Turn sync off and on again with the new password.'
        : record?.error === 'offline' ? 'The last sync didn\'t go through. Relay will try again.' : null,
    };
  }

  // Turning it on: prove the password (the caller checked it), then prove the email with a code
  // the service sends itself. If this email is already synced with the same password, just join it.
  async function start(space, owner, password) {
    if (!available()) throw new Error('Account sync isn\'t available on this bridge.');
    if (saved(space)) return status(space);
    const existing = await fetchAccount(owner.email, password);
    if (existing) { adopt(space, existing, { restored: false }); await sync(space); return status(space); }
    const salt = randomBytes(16).toString('base64url'), keys = await deriveKeys(password, salt);
    const r = await post('/account/start', { email: owner.email });
    if (r.status !== 200) throw fail(r, 'The code could not be sent. Try again in a minute.');
    pending.set(space.id, { salt, ...keys, expires: Date.now() + PENDING_TTL });
    return status(space);
  }
  async function confirm(space, code, owner, { replace = false } = {}) {
    const p = pending.get(space.id);
    if (!p || p.expires < Date.now()) { pending.delete(space.id); throw new Error('That took too long. Start again.'); }
    const record = { email: owner.email, salt: p.salt, auth: p.auth, enc: p.enc, aiApps: {}, tombstones: [] };
    const r = await post('/account/register', { email: owner.email, code: String(code || '').trim(), salt: p.salt, auth: p.auth, replace, blob: sealBlob(p.enc, owner.email, snapshot(space, owner, record)) });
    if (r.status === 409) { const e = new Error('This email already has a synced account locked with a different password. Sign in with that password, or replace the synced copy with this computer\'s.'); e.status = 409; throw e; }
    if (r.status !== 200) throw fail(r, 'That code is not right.');
    pending.delete(space.id);
    remember(space, record, r.body.rev);
    watch(space);
    return status(space);
  }
  // Turning it off removes the copy held by the service. Other computers keep their own accounts.
  async function off(space) {
    const record = saved(space);
    pending.delete(space.id); clearTimeout(timers.get(space.id));
    if (!record) return status(space);
    let removed = false;
    if (available()) removed = (await post('/account/delete', { email: record.email, auth: record.auth }).catch(() => ({ status: 0 }))).status === 200;
    save(space, null);
    return { ...status(space), cloudCopyRemoved: removed };
  }
  function forget(space) { pending.delete(space.id); clearTimeout(timers.get(space.id)); }

  // Signing in on a computer that doesn't have the account yet.
  async function fetchAccount(email, password) {
    if (!available()) return null;
    email = lower(email);
    const s = await post('/account/salt', { email });
    if (s.status !== 200 || !s.body.salt) return null;
    const keys = await deriveKeys(password, s.body.salt);
    const got = await post('/account/login', { email, auth: keys.auth });
    if (got.status !== 200) return null;
    try { return { email, salt: s.body.salt, ...keys, rev: got.body.rev, blob: openBlob(keys.enc, email, got.body.blob) }; }
    catch { return null; }
  }
  function adopt(space, found, { restored = true } = {}) {
    let record = { email: found.email, salt: found.salt, auth: found.auth, enc: found.enc, aiApps: {}, tombstones: [] };
    record = merge(space, found.blob, record);
    remember(space, record, found.rev);
    if (restored) space.store.kv('cloud:setup', { at: Date.now(), aiApps: found.blob.aiApps || {} });
    watch(space);
    schedule(space);
  }
  // After a password change the copy is locked again with the new password.
  async function rekey(space, password) {
    const record = saved(space);
    if (!record) return undefined;
    if (!available()) return false;
    const owner = space.store.kv('account:owner'), salt = randomBytes(16).toString('base64url'), keys = await deriveKeys(password, salt);
    const next = { ...record, salt, ...keys };
    const r = await post('/account/rekey', { email: record.email, auth: record.auth, salt, newAuth: keys.auth, blob: sealBlob(keys.enc, record.email, snapshot(space, owner, next)) });
    if (r.status !== 200) { save(space, { ...record, error: 'password' }); return false; }
    remember(space, next, r.body.rev);
    return true;
  }

  // The checklist shown after an account arrives on a new computer.
  function setup(space) {
    const s = space.store.kv('cloud:setup');
    if (!s || s.done) return null;
    return { since: s.at, aiApps: s.aiApps || {}, here: space.store.kv('apps:here') || {} };
  }
  function setupDone(space) { const s = space.store.kv('cloud:setup'); if (s) space.store.kv('cloud:setup', { ...s, done: true }); return { ok: true }; }
  function noteApp(space, key) {
    // Which AI apps were set up on this computer; the names travel so another computer can offer the same.
    space.store.kv('apps:here', { ...(space.store.kv('apps:here') || {}), [key]: true });
    schedule(space);
  }
  spaces.onCreate = watch;

  return { available, status, start, confirm, sync, off, forget, fetchAccount, adopt, rekey, setup, setupDone, noteApp };
}
