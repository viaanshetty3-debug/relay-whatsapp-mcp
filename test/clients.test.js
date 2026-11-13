// One-click setup for Claude Desktop / Claude Code, and Relay starting itself when Claude needs it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeDesktopConfigPath, localServerEntry, addToClaudeDesktop, addToClaudeCode } from '../src/clients.js';
import { ensureBridge } from '../src/autolaunch.js';

const tmp = t => { const d = mkdtempSync(join(tmpdir(), 'relay-clients-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
const cfg = { dir: '/home/me/.relay-whatsapp-mcp/data', port: 8787 };

test('Claude Desktop settings live where each OS keeps them', () => {
  assert.equal(claudeDesktopConfigPath({ platform: 'darwin', home: '/Users/me' }), join('/Users/me', 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'));
  assert.equal(claudeDesktopConfigPath({ platform: 'win32', home: 'C:\\Users\\me', env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' } }), join('C:\\Users\\me\\AppData\\Roaming', 'Claude', 'claude_desktop_config.json'));
  assert.equal(claudeDesktopConfigPath({ platform: 'linux', home: '/home/me', env: {} }), join('/home/me', '.config', 'Claude', 'claude_desktop_config.json'));
});

test('the launch command uses absolute paths, and asks npx for the package when run from its cache', () => {
  const installed = localServerEntry(cfg, { packageDir: '/usr/lib/node_modules/relay-whatsapp-mcp', execPath: '/usr/bin/node', env: {} });
  assert.deepEqual(installed, { command: '/usr/bin/node', args: [join('/usr/lib/node_modules/relay-whatsapp-mcp', 'bin', 'relay-whatsapp-mcp.mjs'), 'mcp'], env: { DATA_DIR: cfg.dir } });
  const npx = localServerEntry(cfg, { packageDir: '/Users/me/.npm/_npx/abc/node_modules/relay-whatsapp-mcp', execPath: '/opt/homebrew/bin/node', platform: 'darwin', env: { PATH: '/usr/bin' }, exists: () => true });
  assert.equal(npx.command, join('/opt/homebrew/bin', 'npx'));
  assert.deepEqual(npx.args, ['-y', 'relay-whatsapp-mcp', 'mcp']);
  assert.ok(npx.env.PATH.startsWith('/opt/homebrew/bin'), 'node is findable even though desktop apps skip your shell PATH');
});

test('adding to Claude Desktop keeps your other settings, backs them up, and never overwrites a file it cannot read', t => {
  const dir = tmp(t), path = join(dir, 'Claude', 'claude_desktop_config.json'), entry = { command: '/usr/bin/node', args: ['relay', 'mcp'] };
  assert.equal(addToClaudeDesktop(cfg, { path, entry }).changed, true, 'creates the file when Claude has none yet');
  writeFileSync(path, JSON.stringify({ theme: 'dark', mcpServers: { files: { command: 'x' } } }));
  const r = addToClaudeDesktop(cfg, { path, entry });
  assert.ok(r.changed && existsSync(r.backup));
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(saved.theme, 'dark');
  assert.deepEqual(Object.keys(saved.mcpServers), ['files', 'whatsapp']);
  assert.deepEqual(saved.mcpServers.whatsapp, entry);
  assert.equal(addToClaudeDesktop(cfg, { path, entry }).changed, false, 'running it again changes nothing');
  writeFileSync(path, '{ broken');
  assert.throws(() => addToClaudeDesktop(cfg, { path, entry }), /isn't valid JSON/);
  assert.equal(readFileSync(path, 'utf8'), '{ broken');
});

test('Claude Code is set up with its own command when it is installed', () => {
  const calls = [], entry = { command: '/usr/bin/node', args: ['relay', 'mcp'], env: { DATA_DIR: '/d' } };
  const run = (cmd, args) => { calls.push(args.join(' ')); return { status: 0 }; };
  assert.deepEqual(addToClaudeCode(cfg, { entry, run }), { installed: true, added: true });
  assert.equal(calls.at(-1), 'mcp add --scope user -e DATA_DIR=/d whatsapp -- /usr/bin/node relay mcp');
  assert.deepEqual(addToClaudeCode(cfg, { entry, run: () => ({ error: new Error('ENOENT') }) }), { installed: false });
});

test('Claude starts Relay when it is not running, and leaves a running one alone', async () => {
  let started = 0, upAfter = 0;
  assert.equal(await ensureBridge(cfg, { up: async () => true, start: () => started++ }), 'running');
  assert.equal(started, 0);
  assert.equal(await ensureBridge(cfg, { up: async () => upAfter++ > 1, start: () => started++, wait: 5000 }), 'started');
  assert.equal(started, 1);
  assert.equal(await ensureBridge(cfg, { up: async () => false, start: () => started++, wait: 600 }), 'starting');
});
