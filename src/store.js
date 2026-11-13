import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { MEDIA_KINDS } from './media.js';

// WhatsApp timestamps can arrive as 64-bit "Long" objects ({low, high}); store plain seconds.
export function toSeconds(v) {
  if (v && typeof v === 'object' && 'low' in v) return (v.low >>> 0) + (v.high >>> 0) * 4294967296;
  const n = Number(v); return Number.isFinite(n) ? n : 0;
}
export class Store extends EventEmitter {
  constructor(filename) {
    super();
    this.setMaxListeners(0);
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS chats(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS contacts(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(chat TEXT, id TEXT, timestamp INTEGER, text TEXT, data TEXT NOT NULL, PRIMARY KEY(chat,id));
      CREATE INDEX IF NOT EXISTS message_time ON messages(chat,timestamp);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, chat TEXT, time INTEGER, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, due INTEGER, status TEXT, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS drafts(id TEXT PRIMARY KEY, chat TEXT, text TEXT, updated INTEGER);
      CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, data TEXT NOT NULL);`);
    // An interrupted send may have reached WhatsApp. Never automatically resend it.
    this.db.prepare("UPDATE jobs SET status='uncertain' WHERE status='sending'").run();
  }
  transaction(fn) {
    this.db.exec('BEGIN');
    try { const r = fn(); this.db.exec('COMMIT'); return r; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  put(table, value) {
    if (!['chats','contacts'].includes(table) || !value.id) return;
    const old = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(value.id);
    const merged = { ...(old ? JSON.parse(old.data) : {}), ...value };
    if (merged.conversationTimestamp !== undefined) merged.conversationTimestamp = toSeconds(merged.conversationTimestamp) || undefined;
    this.db.prepare(`INSERT OR REPLACE INTO ${table}(id,data) VALUES(?,?)`).run(value.id, JSON.stringify(merged));
  }
  // WhatsApp sometimes uses a hidden ID ("…@lid") for a person instead of their phone number.
  // Moves everything stored under one chat ID to another, merging with what's already there.
  mergeChat(from, to) {
    if (!from || !to || from === to) return false;
    return this.transaction(() => {
      for (const r of this.db.prepare('SELECT data FROM messages WHERE chat=?').all(from)) {
        const m = { ...JSON.parse(r.data), chat: to };
        if (!this.getMessage(to, m.id)) this.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?)').run(to, m.id, m.timestamp, m.text, JSON.stringify(m));
      }
      this.db.prepare('DELETE FROM messages WHERE chat=?').run(from);
      this.db.prepare('UPDATE events SET chat=? WHERE chat=?').run(to, from);
      this.db.prepare('UPDATE drafts SET chat=? WHERE chat=?').run(to, from);
      const a = this.getChat(from), b = this.getChat(to);
      if (a) {
        const ts = c => toSeconds(c?.conversationTimestamp);
        const newer = ts(a) > ts(b) ? a : b;
        const merged = { ...a, ...(b || {}), id: to, name: b?.name || a.name, unreadCount: (Number(a.unreadCount) || 0) + (Number(b?.unreadCount) || 0) };
        if (newer) { merged.conversationTimestamp = ts(newer) || undefined; if (newer.preview !== undefined) merged.preview = newer.preview; }
        this.db.prepare('INSERT OR REPLACE INTO chats(id,data) VALUES(?,?)').run(to, JSON.stringify(merged));
        this.db.prepare('DELETE FROM chats WHERE id=?').run(from);
      }
      return true;
    });
  }
  getChat(id) { const row=this.db.prepare('SELECT data FROM chats WHERE id=?').get(id); return row&&JSON.parse(row.data); }
  list(table) {
    if (!['chats','contacts'].includes(table)) throw new Error('Invalid table');
    return this.db.prepare(`SELECT data FROM ${table}`).all().map(r=>JSON.parse(r.data));
  }
  message(value) {
    const previous = this.getMessage(value.chat, value.id);
    const merged = { ...previous, ...value };
    this.db.prepare('INSERT OR REPLACE INTO messages VALUES(?,?,?,?,?)').run(merged.chat, merged.id, merged.timestamp, merged.text, JSON.stringify(merged));
    return !previous;
  }
  getMessage(chat, id) {
    const r = this.db.prepare('SELECT data FROM messages WHERE chat=? AND id=?').get(chat,id);
    return r && JSON.parse(r.data);
  }
  messages({chat, query='', before, after, limit=100, offset=0, fromMe,mediaOnly=false,mediaKind='all'}={}) {
    const clauses = [], values=[];
    if(chat) { clauses.push('chat=?'); values.push(chat); }
    if(query) { clauses.push("text LIKE ? ESCAPE '\\'"); values.push('%'+query.replace(/[\\%_]/g,'\\$&')+'%'); }
    if(mediaOnly){
      const kinds=Object.keys(MEDIA_KINDS).filter(k=>mediaKind==='all'||MEDIA_KINDS[k]===mediaKind);
      clauses.push(`json_extract(data,'$.kind') IN (${kinds.map(()=>'?').join(',')})`);values.push(...kinds);
      clauses.push("COALESCE(json_extract(data,'$.deleted'),0)=0");
    }
    if(before !== undefined) { clauses.push('timestamp<?'); values.push(before); }
    if(after !== undefined) { clauses.push('timestamp>=?'); values.push(after); }
    if(fromMe !== undefined) { clauses.push("json_extract(data,'$.fromMe')=?"); values.push(Number(fromMe)); }
    return this.db.prepare(`SELECT data FROM messages ${clauses.length?'WHERE '+clauses.join(' AND '):''} ORDER BY timestamp DESC,id DESC LIMIT ? OFFSET ?`).all(...values,limit,offset).map(r=>JSON.parse(r.data));
  }
  event(type,chat,data) {
    const time=Date.now();
    const r=this.db.prepare('INSERT INTO events(type,chat,time,data) VALUES(?,?,?,?)').run(type,chat || null,time,JSON.stringify(data));
    const event={seq:Number(r.lastInsertRowid),type,chat,time,data};
    this.emit('update',event);
    return event;
  }
  cursor() { return this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events').get().seq; }
  events(after=0,limit=100,chat) {
    return this.db.prepare(`SELECT * FROM events WHERE seq>? ${chat?'AND chat=?':''} ORDER BY seq LIMIT ?`).all(...(chat?[after,chat,limit]:[after,limit])).map(r=>({...r,data:JSON.parse(r.data)}));
  }
  kv(key,value) {
    if(value !== undefined) { this.db.prepare('INSERT OR REPLACE INTO kv VALUES(?,?)').run(key,JSON.stringify(value)); return value; }
    const r=this.db.prepare('SELECT data FROM kv WHERE key=?').get(key); return r && JSON.parse(r.data);
  }
  newJob(chat,text,due) {
    const value={id:randomUUID(),chat,text,due,created:Date.now()};
    this.db.prepare('INSERT INTO jobs VALUES(?,?,?,?)').run(value.id,due,'pending',JSON.stringify(value)); return {...value,status:'pending'};
  }
  jobs() { return this.db.prepare('SELECT * FROM jobs ORDER BY due DESC').all().map(r=>({...JSON.parse(r.data),status:r.status})); }
  updateJob(id,status,extra={}) {
    const row=this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
    if(!row) throw new Error('Scheduled message not found');
    this.db.prepare('UPDATE jobs SET status=?,data=? WHERE id=?').run(status,JSON.stringify({...JSON.parse(row.data),...extra}),id);
  }
  draft(chat,text,id=randomUUID()) {
    const d={id,chat,text,updated:Date.now()}; this.db.prepare('INSERT OR REPLACE INTO drafts VALUES(?,?,?,?)').run(id,chat,text,d.updated); return d;
  }
  drafts() { return this.db.prepare('SELECT * FROM drafts ORDER BY updated DESC').all(); }
  close() { this.db.close(); }
}
