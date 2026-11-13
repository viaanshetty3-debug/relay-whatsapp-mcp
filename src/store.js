import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { MEDIA_KINDS } from './media.js';
import { isSealed } from './vault.js';

// WhatsApp timestamps can arrive as 64-bit "Long" objects ({low, high}); store plain seconds.
export function toSeconds(v) {
  if (v && typeof v === 'object' && 'low' in v) return (v.low >>> 0) + (v.high >>> 0) * 4294967296;
  const n = Number(v); return Number.isFinite(n) ? n : 0;
}
const likeText = (text, query) => String(text ?? '').toLowerCase().includes(query.toLowerCase());

// With a vault (see vault.js), everything that says who or what is encrypted:
//   - message, chat, contact, event, job, draft and setting contents: AES-256-GCM
//   - chat and contact IDs (phone numbers, group IDs): keyed hashes, so lookups still work
// Left readable so the database can sort and filter: timestamps, message IDs (random),
// message kind (text, image, call…), whether you sent it, whether it was deleted, and sizes.
export class Store extends EventEmitter {
  constructor(filename, { vault = null } = {}) {
    super();
    this.setMaxListeners(0);
    this.vault = vault;
    this.db = new DatabaseSync(filename);
    try { this.init(vault); } catch (e) { this.db.close(); throw e; }
  }
  init(vault) {
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS chats(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS contacts(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(chat TEXT, id TEXT, timestamp INTEGER, text TEXT, data TEXT NOT NULL, PRIMARY KEY(chat,id));
      CREATE INDEX IF NOT EXISTS message_time ON messages(chat,timestamp);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, chat TEXT, time INTEGER, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, due INTEGER, status TEXT, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS drafts(id TEXT PRIMARY KEY, chat TEXT, text TEXT, updated INTEGER);
      CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);`);
    const cols = new Set(this.db.prepare('PRAGMA table_info(messages)').all().map(c => c.name));
    if (!cols.has('kind')) {
      for (const col of ['kind TEXT', 'fromMe INTEGER', 'deleted INTEGER'])
        try { this.db.exec(`ALTER TABLE messages ADD COLUMN ${col}`); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
      this.db.exec(`UPDATE messages SET kind=json_extract(data,'$.kind'), fromMe=COALESCE(json_extract(data,'$.fromMe'),0), deleted=COALESCE(json_extract(data,'$.deleted'),0) WHERE data NOT LIKE 'rv1:%'`);
    }
    this.encrypted = this.meta('encryption') === 'v1';
    if (this.encrypted && !vault) throw new Error('This Relay database is encrypted, but no key was given. Your data is safe; Relay needs its key to open it.');
    if (vault && this.encrypted) {
      try { vault.open(this.meta('check'), 'store'); }
      catch { throw new Error("This database was encrypted with a different key, so Relay stopped instead of touching it."); }
    }
    if (vault && !this.encrypted) {
      this.encrypt();
      try { vault.open(this.meta('check'), 'store'); }
      catch { throw new Error("This database was encrypted with a different key, so Relay stopped instead of touching it."); }
    }
    // An interrupted send may have reached WhatsApp. Never automatically resend it.
    this.db.prepare("UPDATE jobs SET status='uncertain' WHERE status='sending'").run();
  }
  meta(key, value) {
    if (value !== undefined) { this.db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run(key, value); return value; }
    return this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value;
  }
  // ---- encryption helpers: no-ops without a vault ----
  h(id) { return this.vault ? this.vault.hash(id) : id; }
  seal(value, aad) { const json = JSON.stringify(value); return this.vault ? this.vault.seal(json, aad) : json; }
  unseal(text, aad) { return JSON.parse(this.vault && isSealed(text) ? this.vault.open(text, aad) : text); }

  // One-time upgrade of a plain database: rewrites every row encrypted, then compacts the file
  // so the old plain text doesn't linger in free pages or the write-ahead log.
  encrypt() {
    const v = this.vault, plain = t => JSON.parse(t);
    // IMMEDIATE takes the write lock first, so two Relays starting together can't both convert.
    this.db.exec('BEGIN IMMEDIATE'); this.inTransaction = true;
    try {
      if (this.meta('encryption') === 'v1') { this.db.exec('COMMIT'); this.encrypted = true; return; }
      this.encryptRows(v, plain);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    finally { this.inTransaction = false; }
    this.encrypted = true;
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');
  }
  encryptRows(v, plain) {
      for (const table of ['chats', 'contacts']) {
        const rows = this.db.prepare(`SELECT data FROM ${table}`).all();
        this.db.prepare(`DELETE FROM ${table}`).run();
        const ins = this.db.prepare(`INSERT OR REPLACE INTO ${table}(id,data) VALUES(?,?)`);
        for (const r of rows) { const d = plain(r.data); ins.run(v.hash(d.id), this.seal(d, table)); }
      }
      const msgs = this.db.prepare('SELECT data, kind, fromMe, deleted FROM messages').all();
      this.db.prepare('DELETE FROM messages').run();
      for (const r of msgs) this.writeMessage(plain(r.data));
      for (const r of this.db.prepare('SELECT seq, chat, data FROM events').all())
        this.db.prepare('UPDATE events SET chat=?, data=? WHERE seq=?').run(r.chat ? v.hash(r.chat) : null, this.seal({ chat: r.chat, data: plain(r.data) }, 'event'), r.seq);
      for (const r of this.db.prepare('SELECT id, data FROM jobs').all())
        this.db.prepare('UPDATE jobs SET data=? WHERE id=?').run(this.seal(plain(r.data), 'job'), r.id);
      for (const r of this.db.prepare('SELECT id, chat, text FROM drafts').all())
        this.db.prepare('UPDATE drafts SET chat=?, text=? WHERE id=?').run(v.hash(r.chat), this.seal({ chat: r.chat, text: r.text }, 'draft'), r.id);
      const kv = this.db.prepare('SELECT key, data FROM kv').all();
      this.db.prepare('DELETE FROM kv').run();
      for (const r of kv) this.db.prepare('INSERT INTO kv VALUES(?,?)').run(v.hash('kv:' + r.key), this.seal(plain(r.data), 'kv'));
      this.meta('check', v.seal('relay-store', 'store'));
      this.meta('encryption', 'v1');
  }

  transaction(fn) {
    if (this.inTransaction) return fn();
    this.db.exec('BEGIN'); this.inTransaction = true;
    try { const r = fn(); this.db.exec('COMMIT'); return r; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
    finally { this.inTransaction = false; }
  }
  put(table, value) {
    if (!['chats','contacts'].includes(table) || !value.id) return;
    const old = this.getRow(table, value.id);
    const merged = { ...(old || {}), ...value };
    if (merged.conversationTimestamp !== undefined) merged.conversationTimestamp = toSeconds(merged.conversationTimestamp) || undefined;
    this.db.prepare(`INSERT OR REPLACE INTO ${table}(id,data) VALUES(?,?)`).run(this.h(value.id), this.seal(merged, table));
  }
  getRow(table, id) { const row = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(this.h(id)); return row && this.unseal(row.data, table); }
  writeMessage(m, replace = true) {
    const enc = !!this.vault;
    this.db.prepare(`INSERT OR ${replace ? 'REPLACE' : 'IGNORE'} INTO messages(chat,id,timestamp,text,data,kind,fromMe,deleted) VALUES(?,?,?,?,?,?,?,?)`)
      .run(this.h(m.chat), m.id, m.timestamp ?? null, enc ? null : (m.text ?? null), this.seal(m, 'message'), m.kind ?? null, m.fromMe ? 1 : 0, m.deleted ? 1 : 0);
  }
  // WhatsApp sometimes uses a hidden ID ("…@lid") for a person instead of their phone number.
  // Moves everything stored under one chat ID to another, merging with what's already there.
  mergeChat(from, to) {
    if (!from || !to || from === to) return false;
    return this.transaction(() => {
      for (const r of this.db.prepare('SELECT data FROM messages WHERE chat=?').all(this.h(from))) {
        const m = { ...this.unseal(r.data, 'message'), chat: to };
        this.writeMessage(m, false);
      }
      this.db.prepare('DELETE FROM messages WHERE chat=?').run(this.h(from));
      for (const r of this.db.prepare('SELECT seq, data FROM events WHERE chat=?').all(this.h(from))) {
        if (!this.vault) { this.db.prepare('UPDATE events SET chat=? WHERE seq=?').run(to, r.seq); continue; }
        const e = this.unseal(r.data, 'event');
        this.db.prepare('UPDATE events SET chat=?, data=? WHERE seq=?').run(this.h(to), this.seal({ ...e, chat: to }, 'event'), r.seq);
      }
      for (const d of this.drafts().filter(d => d.chat === from)) this.draft(to, d.text, d.id, d.updated);
      const a = this.getChat(from), b = this.getChat(to);
      if (a) {
        const ts = c => toSeconds(c?.conversationTimestamp);
        const newer = ts(a) > ts(b) ? a : b;
        const merged = { ...a, ...(b || {}), id: to, name: b?.name || a.name, unreadCount: (Number(a.unreadCount) || 0) + (Number(b?.unreadCount) || 0) };
        if (newer) { merged.conversationTimestamp = ts(newer) || undefined; if (newer.preview !== undefined) merged.preview = newer.preview; }
        this.db.prepare('INSERT OR REPLACE INTO chats(id,data) VALUES(?,?)').run(this.h(to), this.seal(merged, 'chats'));
        this.db.prepare('DELETE FROM chats WHERE id=?').run(this.h(from));
      }
      return true;
    });
  }
  getChat(id) { return this.getRow('chats', id); }
  list(table) {
    if (!['chats','contacts'].includes(table)) throw new Error('Invalid table');
    return this.db.prepare(`SELECT data FROM ${table}`).all().map(r => this.unseal(r.data, table));
  }
  message(value) {
    const previous = this.getMessage(value.chat, value.id);
    this.writeMessage({ ...previous, ...value });
    return !previous;
  }
  getMessage(chat, id) {
    const r = this.db.prepare('SELECT data FROM messages WHERE chat=? AND id=?').get(this.h(chat), id);
    return r && this.unseal(r.data, 'message');
  }
  messages({chat, query='', before, after, limit=100, offset=0, fromMe,mediaOnly=false,mediaKind='all'}={}) {
    const clauses = [], values=[];
    if(chat) { clauses.push('chat=?'); values.push(this.h(chat)); }
    // Encrypted text can't be searched by the database: matching rows are decrypted and filtered below.
    const scan = !!(query && this.vault);
    if(query && !scan) { clauses.push("text LIKE ? ESCAPE '\\'"); values.push('%'+query.replace(/[\\%_]/g,'\\$&')+'%'); }
    if(mediaOnly){
      const kinds=Object.keys(MEDIA_KINDS).filter(k=>mediaKind==='all'||MEDIA_KINDS[k]===mediaKind);
      clauses.push(`kind IN (${kinds.map(()=>'?').join(',')})`);values.push(...kinds);
      clauses.push('COALESCE(deleted,0)=0');
    }
    if(before !== undefined) { clauses.push('timestamp<?'); values.push(before); }
    if(after !== undefined) { clauses.push('timestamp>=?'); values.push(after); }
    if(fromMe !== undefined) { clauses.push('COALESCE(fromMe,0)=?'); values.push(Number(fromMe)); }
    const sql = `SELECT data FROM messages ${clauses.length?'WHERE '+clauses.join(' AND '):''} ORDER BY timestamp DESC,id DESC`;
    if (!scan) return this.db.prepare(sql + ' LIMIT ? OFFSET ?').all(...values,limit,offset).map(r=>this.unseal(r.data, 'message'));
    const out = []; let skipped = 0;
    for (const r of this.db.prepare(sql).iterate(...values)) {
      const m = this.unseal(r.data, 'message');
      if (!likeText(m.text, query)) continue;
      if (skipped++ < offset) continue;
      out.push(m); if (out.length >= limit) break;
    }
    return out;
  }
  oldestMessage(chat) {
    const r = this.db.prepare('SELECT data FROM messages WHERE chat=? ORDER BY timestamp ASC,id ASC LIMIT 1').get(this.h(chat));
    return r && this.unseal(r.data, 'message');
  }
  messagesOfKind(kind) { return this.db.prepare('SELECT data FROM messages WHERE kind=?').all(kind).map(r => this.unseal(r.data, 'message')); }
  deleteMessage(chat, id) { this.db.prepare('DELETE FROM messages WHERE chat=? AND id=?').run(this.h(chat), id); }
  deleteChat(id) { this.db.prepare('DELETE FROM chats WHERE id=?').run(this.h(id)); }
  deleteDraft(id) { this.db.prepare('DELETE FROM drafts WHERE id=?').run(id); }
  event(type,chat,data) {
    const time=Date.now();
    const stored = this.vault ? this.seal({ chat, data }, 'event') : JSON.stringify(data);
    const r=this.db.prepare('INSERT INTO events(type,chat,time,data) VALUES(?,?,?,?)').run(type,chat ? this.h(chat) : null,time,stored);
    const event={seq:Number(r.lastInsertRowid),type,chat,time,data};
    this.emit('update',event);
    return event;
  }
  cursor() { return this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events').get().seq; }
  events(after=0,limit=100,chat) {
    return this.db.prepare(`SELECT * FROM events WHERE seq>? ${chat?'AND chat=?':''} ORDER BY seq LIMIT ?`).all(...(chat?[after,this.h(chat),limit]:[after,limit])).map(r=>{
      if (!isSealed(r.data)) return {...r,data:JSON.parse(r.data)};
      const e = this.unseal(r.data, 'event'); return {...r, chat: e.chat ?? null, data: e.data};
    });
  }
  kv(key,value) {
    const k = this.vault ? this.vault.hash('kv:' + key) : key;
    if(value !== undefined) { this.db.prepare('INSERT OR REPLACE INTO kv VALUES(?,?)').run(k,this.seal(value, 'kv')); return value; }
    const r=this.db.prepare('SELECT data FROM kv WHERE key=?').get(k); return r && this.unseal(r.data, 'kv');
  }
  newJob(chat,text,due) {
    const value={id:randomUUID(),chat,text,due,created:Date.now()};
    this.db.prepare('INSERT INTO jobs VALUES(?,?,?,?)').run(value.id,due,'pending',this.seal(value, 'job')); return {...value,status:'pending'};
  }
  jobs() { return this.db.prepare('SELECT * FROM jobs ORDER BY due DESC').all().map(r=>({...this.unseal(r.data, 'job'),status:r.status})); }
  updateJob(id,status,extra={}) {
    const row=this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
    if(!row) throw new Error('Scheduled message not found');
    this.db.prepare('UPDATE jobs SET status=?,data=? WHERE id=?').run(status,this.seal({...this.unseal(row.data, 'job'),...extra}, 'job'),id);
  }
  draft(chat,text,id=randomUUID(),updated=Date.now()) {
    const d={id,chat,text,updated};
    if (this.vault) this.db.prepare('INSERT OR REPLACE INTO drafts VALUES(?,?,?,?)').run(id,this.h(chat),this.seal({chat,text}, 'draft'),updated);
    else this.db.prepare('INSERT OR REPLACE INTO drafts VALUES(?,?,?,?)').run(id,chat,text,updated);
    return d;
  }
  drafts() {
    return this.db.prepare('SELECT * FROM drafts ORDER BY updated DESC').all().map(r => {
      if (!isSealed(r.text)) return r;
      const d = this.unseal(r.text, 'draft'); return { ...r, chat: d.chat, text: d.text };
    });
  }
  close() { this.db.close(); }
}
