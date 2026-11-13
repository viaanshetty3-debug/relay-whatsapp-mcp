// Adds Relay to AI apps on this computer, so nobody has to edit JSON by hand.
import { existsSync, readFileSync, writeFileSync, renameSync, copyFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, delimiter } from 'node:path';
import { packageDir as defaultPackageDir, isNpxCache } from './paths.js';

export function claudeDesktopConfigPath({ platform = process.platform, home = homedir(), env = process.env } = {}) {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'Claude', 'claude_desktop_config.json');
}

// How an AI app should start Relay's local MCP adapter. Absolute paths, because desktop apps
// don't load your shell's PATH (the usual "npx not found" problem).
export function localServerEntry(config, { packageDir = defaultPackageDir, execPath = process.execPath, platform = process.platform, env = process.env, exists = existsSync } = {}) {
  const extra = { DATA_DIR: config.dir, ...(env.LD_LIBRARY_PATH ? { LD_LIBRARY_PATH: env.LD_LIBRARY_PATH } : {}) };
  if (isNpxCache(packageDir)) {
    // npx's cache can be cleared, so ask npx for the package each time instead of pointing into it.
    const npx = join(dirname(execPath), platform === 'win32' ? 'npx.cmd' : 'npx');
    return { command: exists(npx) ? npx : 'npx', args: ['-y', 'relay-whatsapp-mcp', 'mcp'], env: { ...extra, PATH: dirname(execPath) + delimiter + (env.PATH || '') } };
  }
  return { command: execPath, args: [join(packageDir, 'bin', 'relay-whatsapp-mcp.mjs'), 'mcp'], env: extra };
}

// Adds (or updates) the "whatsapp" server in Claude Desktop's config, keeping everything else.
// A config that isn't valid JSON is left alone: we never overwrite something we can't read.
export function addToClaudeDesktop(config, { path = claudeDesktopConfigPath(), name = 'whatsapp', entry = localServerEntry(config) } = {}) {
  let current = {};
  if (existsSync(path)) {
    const text = readFileSync(path, 'utf8');
    try { current = text.trim() ? JSON.parse(text) : {}; }
    catch { throw new Error(`Claude Desktop's settings file isn't valid JSON, so Relay didn't change it: ${path}`); }
    if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error(`Unexpected content in ${path}; Relay didn't change it.`);
  }
  const before = JSON.stringify(current.mcpServers?.[name]);
  if (before === JSON.stringify(entry)) return { path, changed: false, backup: null };
  mkdirSync(dirname(path), { recursive: true });
  let backup = null;
  if (existsSync(path)) { backup = path + '.before-relay'; copyFileSync(path, backup); }
  const next = { ...current, mcpServers: { ...(current.mcpServers || {}), [name]: entry } };
  const tmp = path + '.relay.tmp';
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n'); renameSync(tmp, path);
  return { path, changed: true, replaced: before !== undefined, backup };
}

// Claude Code: uses its own `claude mcp add` command when it's installed.
export function addToClaudeCode(config, { entry = localServerEntry(config), run = spawnSync } = {}) {
  const found = run('claude', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
  if (found.error || found.status !== 0) return { installed: false };
  run('claude', ['mcp', 'remove', '--scope', 'user', 'whatsapp'], { encoding: 'utf8', shell: process.platform === 'win32' });
  const envArgs = Object.entries(entry.env || {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  const r = run('claude', ['mcp', 'add', '--scope', 'user', ...envArgs, 'whatsapp', '--', entry.command, ...entry.args], { encoding: 'utf8', shell: process.platform === 'win32' });
  if (r.status !== 0) return { installed: true, added: false, error: (r.stderr || r.stdout || '').trim().split('\n').pop() };
  return { installed: true, added: true };
}
