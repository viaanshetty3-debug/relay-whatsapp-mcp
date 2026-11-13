// Where Relay keeps its private files (.env and data/).
//
// - A git clone keeps them in the clone, as before.
// - An npm install (npx, `npm i -g`, or a dependency) lives inside node_modules,
//   which npm may replace or delete at any time, so Relay uses ~/.relay-whatsapp-mcp.
// - RELAY_HOME overrides both.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const packageDir = resolve(fileURLToPath(new URL('../', import.meta.url)));

const segments = dir => dir.split(/[\\/]+/);
export const isInstalledPackage = (dir = packageDir) => segments(dir).includes('node_modules');
// npx keeps packages in a temporary cache (…/_npx/<hash>/node_modules/…) that npm may clear.
export const isNpxCache = (dir = packageDir) => segments(dir).includes('_npx');

export function relayHome({ env = process.env, dir = packageDir, home = homedir() } = {}) {
  if (env.RELAY_HOME) return resolve(env.RELAY_HOME);
  return isInstalledPackage(dir) ? join(home, '.relay-whatsapp-mcp') : dir;
}

// How to tell the user to run a command: `npm run doctor` in a clone,
// `npx relay-whatsapp-mcp doctor` / `relay-whatsapp-mcp doctor` when installed.
export function command(name, { dir = packageDir } = {}) {
  if (isNpxCache(dir)) return 'npx relay-whatsapp-mcp ' + name;
  if (isInstalledPackage(dir)) return 'relay-whatsapp-mcp ' + name;
  return name === 'start' ? 'npm start' : 'npm run ' + name;
}

export const home = relayHome();
export const envFile = join(home, '.env');
export const defaultDataDir = (demo = false) => join(home, demo ? 'demo-data' : 'data');

export function loadEnv(file = envFile) {
  if (existsSync(file)) process.loadEnvFile(file);
  return existsSync(file);
}
