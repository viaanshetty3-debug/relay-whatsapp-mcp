// Used by transfer-termux-session.py after receiving an encrypted session from another device:
// moves the received data key into this computer's key store (Keychain / DPAPI / key file),
// deletes the copy, and prints the decrypted credentials summary so the pairing can be checked.
import { readFileSync, rmSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { openVault, readAuthFile, stores, defaultMethod } from '../src/vault.js';

const dir = process.argv[2];
if (!dir) { console.error('usage: import-data-key.mjs <data folder>'); process.exit(2); }
const metaFile = join(dir, 'vault.json'), keyFile = join(dir, 'data-key');
if (existsSync(keyFile)) {
  const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
  const key = Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'base64');
  if (key.length !== 32) throw new Error('The received data key is not 32 bytes');
  meta.method = defaultMethod();
  stores[meta.method].put(meta.keyId, key, meta);
  const tmp = metaFile + '.tmp'; writeFileSync(tmp, JSON.stringify(meta, null, 2) + '\n', { mode: 0o600 }); renameSync(tmp, metaFile);
  rmSync(keyFile, { force: true });
}
const vault = openVault(dir, { env: {} });
const creds = JSON.parse(readAuthFile(join(dir, 'auth'), 'creds.json', vault));
process.stdout.write(JSON.stringify({ registered: creds.registered, me: creds.me, account: creds.account ? { accountSignature: creds.account.accountSignature, deviceSignature: creds.account.deviceSignature } : undefined }));
