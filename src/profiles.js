// Several WhatsApp profiles in one Relay. Each profile is a separate linked device with its own
// folder (login, messages, media), so profiles never share a WhatsApp session.
//
//   main          → the original data folder (existing installs keep working unchanged)
//   <8 hex id>    → <data>/profiles/<id>/
//
// One AI connection reaches every profile: each tool takes an optional `profile` (id or name),
// and list_profiles shows what's linked. Without `profile`, tools use the main profile.
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { openVault } from './vault.js';
import { Store } from './store.js';
import { WhatsApp } from './whatsapp.js';
import { DemoWhatsApp } from './demo.js';
import { Bridge } from './tools.js';

export const MAX_PROFILES = 10;
const ID = /^[a-f0-9]{8}$/;
const profileArg = z.string().min(1).max(80).optional()
  .describe('Which linked WhatsApp to use: a profile id or name from list_profiles. Leave out for the main profile.');

// Tool definitions with the extra `profile` argument, plus list_profiles. Shared with the stdio adapter.
export function routedDefinitions(definitions) {
  return [
    ...definitions.map(t => ({ ...t, schema: t.schema.extend({ profile: profileArg }) })),
    {
      name: 'list_profiles', schema: z.object({}).strict(), write: false, destructive: false, idempotent: true,
      description: 'List the WhatsApp profiles linked to this Relay (id, name, connection state, phone). Pass a profile id or name as `profile` to any other tool to use that WhatsApp; the default is the main profile.',
    },
  ];
}

const cleanName = value => {
  const name = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
  if (!name) throw new Error('Give the profile a name, for example “Work”.');
  return name;
};
const phoneOf = account => { const m = /^(\d{6,15})[:@]/.exec(String(account || '')); return m ? '+' + m[1] : null; };

export class Profiles extends EventEmitter {
  // main: the already-built Bridge for the original data folder.
  constructor(config, main, { open } = {}) {
    super();
    this.config = config;
    this.open = open || (cfg => {
      const store = new Store(resolve(cfg.dir, 'bridge.sqlite'), { vault: cfg.demo ? null : openVault(cfg.dir) });
      const wa = cfg.demo ? new DemoWhatsApp(store, cfg) : new WhatsApp(store, cfg);
      return new Bridge(store, wa, cfg);
    });
    this.registryPath = config.dir ? resolve(config.dir, 'profiles.json') : null;
    const saved = this.read();
    this.entries = new Map([['main', { id: 'main', name: saved.mainName || 'Main', dir: config.dir, bridge: main }]]);
    this.unloaded = []; // saved profiles that failed to open: kept in profiles.json so they come back next start
    for (const p of saved.profiles || []) {
      if (!ID.test(p.id) || this.entries.size >= MAX_PROFILES) continue;
      try { this.entries.set(p.id, this.load(p.id, p.name, p.createdAt)); }
      catch (e) { console.error(`Profile ${p.name}: ${e.message}`); this.unloaded.push({ id: p.id, name: p.name, createdAt: p.createdAt }); }
    }
  }
  get main() { return this.entries.get('main'); }
  read() {
    try { return this.registryPath && existsSync(this.registryPath) ? JSON.parse(readFileSync(this.registryPath, 'utf8')) : {}; }
    catch { return {}; }
  }
  save() {
    if (!this.registryPath) return;
    const extra = [...[...this.entries.values()].filter(p => p.id !== 'main').map(({ id, name, createdAt }) => ({ id, name, createdAt })), ...this.unloaded];
    const tmp = this.registryPath + '.tmp';
    writeFileSync(tmp, JSON.stringify({ mainName: this.main.name, profiles: extra }, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, this.registryPath);
  }
  load(id, name, createdAt = Date.now()) {
    const dir = resolve(this.config.dir, 'profiles', id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const bridge = this.open({ ...this.config, dir });
    return { id, name: cleanName(name), dir, bridge, createdAt };
  }
  all() { return [...this.entries.values()]; }
  // Accepts an id or a name (case-insensitive). Missing → main.
  get(ref) {
    if (ref === undefined || ref === null || ref === '') return this.main;
    const key = String(ref).trim();
    const hit = this.entries.get(key) || this.all().find(p => p.name.toLowerCase() === key.toLowerCase());
    if (!hit) throw new Error(`No WhatsApp profile “${key.slice(0, 80)}”. Use list_profiles to see them.`);
    return hit;
  }
  describe(p) {
    const status = p.bridge.wa.status();
    return { id: p.id, name: p.name, main: p.id === 'main', state: status.state, phone: phoneOf(status.account) };
  }
  list() { return this.all().map(p => this.describe(p)); }
  // Names and ids share one namespace for the `profile` argument, so a name can't be "main",
  // look like an id, or match another profile's name.
  checkName(name, self) {
    const clean = cleanName(name), key = clean.toLowerCase();
    if (key === 'main' && self?.id !== 'main') throw new Error('“main” is reserved for the main profile. Pick another name.');
    if (ID.test(key)) throw new Error('Pick a name with letters, for example “Work”.');
    if (this.all().some(p => p !== self && p.name.toLowerCase() === key)) throw new Error('A profile with that name already exists.');
    return clean;
  }
  create(name) {
    if (!this.config.dir) throw new Error('Profiles need a data folder.');
    if (this.entries.size + this.unloaded.length >= MAX_PROFILES) throw new Error(`You can link up to ${MAX_PROFILES} WhatsApp profiles.`);
    const clean = this.checkName(name);
    let id; do id = randomBytes(4).toString('hex'); while (this.entries.has(id));
    const entry = this.load(id, clean);
    this.entries.set(id, entry); this.save(); this.emit('change');
    return this.describe(entry);
  }
  rename(ref, name) {
    const p = this.get(ref), clean = this.checkName(name, p);
    p.name = clean; this.save(); this.emit('change');
    return this.describe(p);
  }
  // Unlinks the device from that WhatsApp account and deletes the profile's folder.
  async remove(ref) {
    const p = this.get(ref);
    if (p.id === 'main') throw new Error('The main profile can’t be removed. Disconnect it instead.');
    this.entries.delete(p.id); this.save(); this.emit('change');
    await this.close(p, { logout: true });
    rmSync(p.dir, { recursive: true, force: true });
    return { removed: p.id };
  }
  async close(p, { logout = false } = {}) {
    const { bridge } = p;
    try { if (logout && bridge.wa.logout) await bridge.wa.logout(); } catch (e) { console.error(`Profile ${p.name} logout: ${e.message}`); }
    await bridge.wa.stop().catch(() => {});
    while (bridge.ticking) await new Promise(r => setTimeout(r, 50));
    bridge.analysis?.stop?.();
    if (p.id !== 'main') bridge.store.close();
  }
  async tick() {
    const results = await Promise.allSettled(this.all().map(p => p.bridge.tick()));
    results.forEach((r, i) => { if (r.status === 'rejected') console.error(`Scheduler (${this.all()[i]?.name}):`, r.reason?.message || r.reason); });
  }
  reconnect() {
    for (const p of this.all()) if (p.bridge.wa.hasSavedSession?.())
      p.bridge.wa.start().catch(e => console.error(`WhatsApp reconnect (${p.name}):`, e.message));
  }
  async stop() { for (const p of this.all()) await this.close(p); }
}

// Looks like a Bridge to mcpServer and the HTTP tool route, and sends each call to the right profile.
export class ProfileRouter {
  constructor(profiles) {
    this.profiles = profiles;
    this.definitions = routedDefinitions(profiles.main.bridge.definitions);
  }
  async call(name, args = {}, fallbackProfile) {
    if (name === 'list_profiles') return this.profiles.list();
    if (!this.definitions.some(d => d.name === name)) throw new Error('Unknown tool');
    const { profile, ...rest } = args && typeof args === 'object' ? args : {};
    if (profile !== undefined && typeof profile !== 'string') throw new Error('profile must be a profile id or name');
    return this.profiles.get(profile ?? fallbackProfile).bridge.call(name, rest);
  }
}
