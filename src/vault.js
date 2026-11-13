// Encryption at rest for a Relay data folder.
//
// One random 256-bit key per data folder ("data key"). It never sits in the data folder itself:
//   - macOS: the login Keychain (via /usr/bin/security)
//   - Windows: wrapped with DPAPI for the current Windows user, stored in vault.json
//   - Linux, Termux and anything else: a 0600 file outside the data folder
//     (~/.config/relay-whatsapp-mcp/keys/), or RELAY_DATA_KEY if you set one.
// A copy of the data folder, a backup of it, or a lost disk image without your login
// can't be read. Malware running as you, or someone logged in as you, can still read it.
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const PREFIX = 'rv1:';
const SERVICE = 'relay-whatsapp-mcp';
export const isSealed = value => typeof value === 'string' && value.startsWith(PREFIX);

export class Vault {
  constructor(key) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('The data key must be 32 bytes');
    const sub = info => Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), info, 32));
    this.dataKey = sub('relay data v1');
    this.idKey = sub('relay ids v1');
  }
  seal(text, aad = '') {
    const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', this.dataKey, iv);
    c.setAAD(Buffer.from(aad));
    const body = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
    return PREFIX + Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
  }
  open(value, aad = '') {
    if (!isSealed(value)) return value;
    const raw = Buffer.from(value.slice(PREFIX.length), 'base64');
    const d = createDecipheriv('aes-256-gcm', this.dataKey, raw.subarray(0, 12));
    d.setAAD(Buffer.from(aad)); d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  }
  // Keyed hash for IDs (phone numbers, group IDs) that must stay searchable by exact match.
  hash(id) {
    if (id === null || id === undefined) return id;
    return 'h:' + createHmac('sha256', this.idKey).update(String(id)).digest('base64url').slice(0, 27);
  }
}

// ---- where the key lives ------------------------------------------------------------

const run = (cmd, args, input) => execFileSync(cmd, args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000, windowsHide: true }).trim();
const keyDir = (home = homedir()) => join(process.env.XDG_CONFIG_HOME || join(home, '.config'), SERVICE, 'keys');

export const stores = {
  keychain: {
    get: id => Buffer.from(run('/usr/bin/security', ['find-generic-password', '-s', SERVICE, '-a', id, '-w']), 'base64'),
    // `security -i` reads the command from stdin, so the key never appears in the process list.
    put: (id, key) => run('/usr/bin/security', ['-i'], `add-generic-password -U -s ${SERVICE} -a ${id} -l "Relay data key" -w ${key.toString('base64')}\n`),
  },
  dpapi: {
    ps: script => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -AssemblyName System.Security; $in=[Console]::In.ReadLine(); ${script}`]),
    get(id, meta) { return Buffer.from(this.ps("[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($in),$null,'CurrentUser'))", meta.wrapped + '\n'), 'base64'); },
    put(id, key, meta) { meta.wrapped = this.ps("[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Convert]::FromBase64String($in),$null,'CurrentUser'))", key.toString('base64') + '\n'); },
  },
  file: {
    get: id => Buffer.from(readFileSync(join(keyDir(), id + '.key'), 'utf8').trim(), 'base64'),
    put: (id, key) => {
      const dir = keyDir(); mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = join(dir, id + '.key'), tmp = file + '.tmp';
      writeFileSync(tmp, key.toString('base64') + '\n', { mode: 0o600 }); renameSync(tmp, file);
    },
  },
};
export const defaultMethod = (platform = process.platform) => platform === 'darwin' ? 'keychain' : platform === 'win32' ? 'dpapi' : 'file';

const CHECK = 'relay-vault-check';
function writeMeta(file, meta) { const tmp = file + '.tmp'; writeFileSync(tmp, JSON.stringify(meta, null, 2) + '\n', { mode: 0o600 }); renameSync(tmp, file); }

// Opens (or, the first time, creates) the key for a data folder. Never creates a new key
// over an existing vault: losing the key must be a loud error, not silent data loss.
export function openVault(dir, { env = process.env, platform = process.platform, store } = {}) {
  if (env.RELAY_ENCRYPTION === 'off') return null;
  const metaFile = resolve(dir, 'vault.json');
  const fromEnv = env.RELAY_DATA_KEY ? Buffer.from(env.RELAY_DATA_KEY, 'base64') : null;
  if (fromEnv && fromEnv.length !== 32) throw new Error('RELAY_DATA_KEY must be 32 random bytes in base64 (try: openssl rand -base64 32)');
  if (existsSync(metaFile)) {
    const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
    let key = fromEnv;
    if (!key) {
      const s = store || stores[meta.method];
      if (!s) throw new Error(`This data folder's key is stored with "${meta.method}", which isn't available here. Set RELAY_DATA_KEY.`);
      try { key = s.get(meta.keyId, meta); }
      catch (e) { throw new Error(`Can't read this data folder's encryption key (${meta.method}, ${meta.keyId}). Your messages are encrypted and can't be opened without it. ${e.message.split('\n')[0]}`); }
    }
    const vault = new Vault(key);
    try { if (vault.open(meta.check, 'vault') !== CHECK) throw new Error(); }
    catch { throw new Error('The encryption key found for this data folder is not the right one, so Relay stopped instead of creating new data. Check RELAY_DATA_KEY or the saved key.'); }
    return vault;
  }
  // Hosted containers lose anything outside the data volume, so a generated key would vanish on
  // the next deploy. There, encryption needs a key you keep as a hosting secret.
  if (!fromEnv && env.NODE_ENV === 'production') {
    console.log('Data is not encrypted at rest: set RELAY_DATA_KEY (a private hosting variable; openssl rand -base64 32) to turn it on.');
    return null;
  }
  const key = fromEnv || randomBytes(32);
  const meta = { version: 1, method: fromEnv ? 'env' : defaultMethod(platform), keyId: 'relay-' + randomUUID(), created: new Date().toISOString() };
  if (!fromEnv) (store || stores[meta.method]).put(meta.keyId, key, meta);
  const vault = new Vault(key);
  meta.check = vault.seal(CHECK, 'vault');
  if (!fromEnv) {
    // Read it back before relying on it.
    const back = (store || stores[meta.method]).get(meta.keyId, meta);
    if (!back.equals(key)) throw new Error('The system key store returned a different key');
  }
  writeMeta(metaFile, meta);
  return vault;
}

// ---- encrypted WhatsApp session files ---------------------------------------------------
// Same layout as Baileys' useMultiFileAuthState, with each file sealed. Plain files from older
// versions are read and re-written sealed. A file that fails to decrypt throws instead of being
// treated as missing, so a wrong key never makes Baileys start a fresh session over the old one.
export async function useEncryptedAuthState(folder, vault, lib) {
  const { BufferJSON, initAuthCreds, proto } = lib;
  const { readFile, writeFile, rename, unlink, mkdir } = await import('node:fs/promises');
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const fix = file => file.replace(/\//g, '__').replace(/:/g, '-');
  const queues = new Map();
  const locked = (path, fn) => { const next = (queues.get(path) || Promise.resolve()).then(fn, fn); queues.set(path, next.catch(() => {})); return next; };
  const write = (data, file) => { const path = join(folder, fix(file)); return locked(path, async () => {
    const json = JSON.stringify(data, BufferJSON.replacer), tmp = path + '.' + randomBytes(4).toString('hex') + '.tmp';
    await writeFile(tmp, vault ? vault.seal(json, 'auth:' + fix(file)) : json, { mode: 0o600 }); await rename(tmp, path);
  }); };
  const read = file => { const path = join(folder, fix(file)); return locked(path, async () => {
    let text; try { text = await readFile(path, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    return JSON.parse(vault ? vault.open(text, 'auth:' + fix(file)) : text, BufferJSON.reviver);
  }); };
  const remove = file => { const path = join(folder, fix(file)); return locked(path, () => unlink(path).catch(() => {})); };
  const creds = (await read('creds.json')) || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(ids.map(async id => {
            let value = await read(`${type}-${id}.json`).catch(() => null);
            if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
            data[id] = value;
          }));
          return data;
        },
        set: async data => {
          const tasks = [];
          for (const category in data) for (const id in data[category]) {
            const value = data[category][id], file = `${category}-${id}.json`;
            tasks.push(value ? write(value, file) : remove(file));
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => write(creds, 'creds.json'),
  };
}

// Seals any plain files left in an auth folder by older versions (synchronous, at start-up).
export function sealAuthFolder(folder, vault) {
  if (!vault || !existsSync(folder)) return 0;
  let count = 0;
  for (const name of readDirSafe(folder)) {
    if (!name.endsWith('.json')) { if (name.endsWith('.tmp')) rmSync(join(folder, name), { force: true }); continue; }
    const path = join(folder, name), text = readFileSync(path, 'utf8');
    if (isSealed(text)) continue;
    const tmp = path + '.seal.tmp';
    writeFileSync(tmp, vault.seal(text, 'auth:' + name), { mode: 0o600 }); renameSync(tmp, path); count++;
  }
  return count;
}
function readDirSafe(dir) { try { return readdirSync(dir); } catch { return []; } }

export function readAuthFile(folder, name, vault) {
  const text = readFileSync(join(folder, name), 'utf8');
  return vault ? vault.open(text, 'auth:' + name) : text;
}
