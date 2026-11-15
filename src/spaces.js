// Several Relay accounts on one computer (for example "Business" and "Private").
// Each account is a separate space: its own folder, encryption key, owner token, WhatsApp
// profiles, messages and AI-app approvals. Nothing in one space is reachable from another.
//
//   default       → the original data folder (existing installs keep working unchanged)
//   <8 hex id>    → <data>/accounts/<id>/
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openVault } from './vault.js';
import { Store } from './store.js';
import { WhatsApp } from './whatsapp.js';
import { DemoWhatsApp } from './demo.js';
import { Bridge } from './tools.js';
import { Profiles, ProfileRouter } from './profiles.js';

export const MAX_ACCOUNTS = 5;
export const SPACE_ID = /^[a-f0-9]{8}$/;

// Opens one account's main bridge. Without a data folder (tests, in-memory demos) it never
// touches a real WhatsApp session.
function openBridge(cfg) {
  if (!cfg.dir) { const store = new Store(':memory:'); return new Bridge(store, new DemoWhatsApp(store, cfg), cfg); }
  const store = new Store(resolve(cfg.dir, 'bridge.sqlite'), { vault: cfg.demo ? null : openVault(cfg.dir) });
  const wa = cfg.demo ? new DemoWhatsApp(store, cfg) : new WhatsApp(store, cfg);
  return new Bridge(store, wa, cfg);
}

function spaceToken(dir) {
  if (!dir) return randomBytes(32).toString('base64url');
  const file = resolve(dir, 'owner-token');
  const token = existsSync(file) ? readFileSync(file, 'utf8').trim() : randomBytes(32).toString('base64url');
  if (!existsSync(file)) writeFileSync(file, token + '\n', { mode: 0o600 });
  return token;
}

export class Spaces {
  // mainProfiles: the already-built Profiles for the original data folder.
  // open / openProfile: how to open an account's main bridge and its further profiles (tests).
  constructor(config, mainProfiles, { open, openProfile } = {}) {
    this.config = config;
    this.open = open || openBridge;
    this.openProfile = openProfile;
    this.registryPath = config.dir ? resolve(config.dir, 'accounts.json') : null;
    this.entries = new Map([['default', this.wrap('default', config, mainProfiles)]]);
    this.unloaded = []; // saved accounts that failed to open: kept in accounts.json so they come back next start
    for (const a of this.read().accounts || []) {
      if (!SPACE_ID.test(a.id) || this.entries.size >= MAX_ACCOUNTS) continue;
      try { this.entries.set(a.id, this.load(a.id)); }
      catch (e) { console.error(`Account ${a.id}: ${e.message}`); this.unloaded.push({ id: a.id, createdAt: a.createdAt }); }
    }
  }
  wrap(id, config, profiles) {
    return { id, dir: config.dir, config, profiles, router: new ProfileRouter(profiles), get store() { return profiles.main.bridge.store; } };
  }
  get default() { return this.entries.get('default'); }
  read() {
    try { return this.registryPath && existsSync(this.registryPath) ? JSON.parse(readFileSync(this.registryPath, 'utf8')) : {}; }
    catch { return {}; }
  }
  save() {
    if (!this.registryPath) return;
    const accounts = [...this.all().filter(s => s.id !== 'default').map(s => ({ id: s.id, createdAt: s.createdAt })), ...this.unloaded];
    const tmp = this.registryPath + '.tmp';
    writeFileSync(tmp, JSON.stringify({ accounts }, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, this.registryPath);
  }
  load(id, createdAt = Date.now()) {
    const dir = this.config.dir ? resolve(this.config.dir, 'accounts', id) : undefined;
    if (dir) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const config = { ...this.config, dir, token: spaceToken(dir), space: id };
    const main = this.open(config);
    const space = this.wrap(id, config, new Profiles(config, main, this.openProfile ? { open: this.openProfile } : {}));
    space.createdAt = createdAt;
    return space;
  }
  all() { return [...this.entries.values()]; }
  get(id) { return this.entries.get(String(id || '')) || null; }
  full() { return this.entries.size + this.unloaded.length >= MAX_ACCOUNTS; }
  create() {
    if (this.full()) throw new Error(`This computer can hold up to ${MAX_ACCOUNTS} Relay accounts.`);
    let id; do id = randomBytes(4).toString('hex'); while (this.entries.has(id) || this.unloaded.some(a => a.id === id));
    const space = this.load(id);
    this.entries.set(id, space); this.save();
    this.onCreate?.(space);
    return space;
  }
  // Unlinks every WhatsApp in that account and deletes its folder. The first account stays.
  async remove(id) {
    const space = this.get(id);
    if (!space || space.id === 'default') throw new Error('This account can’t be removed here.');
    this.entries.delete(space.id); this.save();
    for (const p of space.profiles.all()) await space.profiles.close(p, { logout: true });
    space.profiles.main.bridge.store.close();
    if (space.dir) rmSync(space.dir, { recursive: true, force: true });
    return { removed: space.id };
  }
  async tick() { await Promise.all(this.all().map(s => s.profiles.tick())); }
  reconnect() { for (const s of this.all()) s.profiles.reconnect(); }
  // The caller closes the default account's main store (it opened it).
  async stop() {
    for (const s of this.all()) { await s.profiles.stop(); if (s.id !== 'default') s.profiles.main.bridge.store.close(); }
  }
}
