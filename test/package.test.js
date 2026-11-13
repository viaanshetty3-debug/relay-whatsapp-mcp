// npm packaging: where private files live, the bin entry, the MCP Registry
// metadata, and what `npm pack` would publish.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { command, isInstalledPackage, isNpxCache, relayHome } from '../src/paths.js';
import { clientConfigs, localLauncher } from '../setup.mjs';
import { plan } from '../scripts/install-autostart.mjs';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
const server = JSON.parse(readFileSync(join(repo, 'server.json'), 'utf8'));
const npxDir = join('/home/someone/.npm/_npx/0a1b2c/node_modules/relay-whatsapp-mcp');
const globalDir = join('/usr/local/lib/node_modules/relay-whatsapp-mcp');

test('paths: a clone keeps .env and data in the clone; npm installs use ~/.relay-whatsapp-mcp', () => {
  assert.equal(relayHome({ env: {}, dir: '/src/relay', home: '/home/someone' }), '/src/relay');
  assert.equal(relayHome({ env: {}, dir: globalDir, home: '/home/someone' }), join('/home/someone', '.relay-whatsapp-mcp'));
  assert.equal(relayHome({ env: {}, dir: npxDir, home: '/home/someone' }), join('/home/someone', '.relay-whatsapp-mcp'));
  assert.equal(relayHome({ env: { RELAY_HOME: '/data/relay' }, dir: npxDir, home: '/home/someone' }), resolve('/data/relay'));
  assert.equal(isInstalledPackage('C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\relay-whatsapp-mcp'), true);
  assert.equal(isNpxCache(npxDir), true);
  assert.equal(isNpxCache(globalDir), false);
  assert.equal(isInstalledPackage(repo), false, 'the repo itself must not be treated as an npm install');
});

test('paths: commands are shown the way the user can run them', () => {
  assert.equal(command('doctor', { dir: '/src/relay' }), 'npm run doctor');
  assert.equal(command('start', { dir: '/src/relay' }), 'npm start');
  assert.equal(command('doctor', { dir: globalDir }), 'relay-whatsapp-mcp doctor');
  assert.equal(command('setup', { dir: npxDir }), 'npx relay-whatsapp-mcp setup');
});

test('setup: npx installs get npx-based client configs that survive cache clean-up', () => {
  assert.deepEqual(localLauncher({ dir: npxDir }), { command: 'npx', args: ['-y', 'relay-whatsapp-mcp', 'mcp'] });
  assert.deepEqual(localLauncher({ node: '/usr/bin/node', dir: '/src/relay', npx: false }), { command: '/usr/bin/node', args: [join('/src/relay', 'src', 'stdio.js')] });
  const text = clientConfigs({}, { dir: npxDir, platform: 'darwin' }).map(s => s.text).join('\n');
  assert.match(text, /"command": "npx"/);
  assert.match(text, /claude mcp add whatsapp -- "npx" "-y" "relay-whatsapp-mcp" "mcp"/);
});

test('autostart: refuses the npx cache and passes RELAY_HOME to the service', () => {
  assert.throws(() => plan({ platform: 'darwin', dir: npxDir, home: '/home/someone', env: {} }), /npm install -g relay-whatsapp-mcp/);
  const mac = plan({ platform: 'darwin', node: '/opt/node', dir: repo, home: '/Users/someone', env: {}, relay: '/Users/someone/.relay-whatsapp-mcp' });
  assert.match(mac.body, /<key>RELAY_HOME<\/key><string>\/Users\/someone\/\.relay-whatsapp-mcp<\/string>/);
  assert.equal(mac.logFile, join('/Users/someone/.relay-whatsapp-mcp', 'data', 'service.log'));
  assert.ok(mac.body.includes(`<key>StandardOutPath</key><string>${mac.logFile}</string>`));
  const linux = plan({ platform: 'linux', node: '/usr/bin/node', dir: repo, home: '/home/someone', env: {}, relay: '/home/some one/relay' });
  assert.match(linux.body, /^Environment="RELAY_HOME=\/home\/some one\/relay"$/m);
  const win = plan({ platform: 'win32', node: 'C:\\node.exe', dir: repo, relay: 'C:\\Users\\a\\.relay-whatsapp-mcp' });
  assert.equal(win.relay, 'C:\\Users\\a\\.relay-whatsapp-mcp');
});

test('package.json and server.json agree, as the MCP Registry requires', () => {
  assert.equal(pkg.name, 'relay-whatsapp-mcp');
  assert.equal(pkg.private, undefined);
  assert.equal(pkg.mcpName, server.name);
  assert.match(server.name, /^io\.github\.viaanshetty3-debug\//);
  assert.equal(server.version, pkg.version);
  assert.ok(server.description.length <= 100, 'registry limit is 100 characters');
  const [npm] = server.packages;
  assert.deepEqual([npm.registryType, npm.identifier, npm.version, npm.transport.type], ['npm', pkg.name, pkg.version, 'stdio']);
  assert.deepEqual(npm.packageArguments, [{ type: 'positional', value: 'mcp' }]);
  for (const target of Object.values(pkg.bin)) assert.ok(existsSync(join(repo, target)), target);
  assert.match(readFileSync(join(repo, pkg.bin['relay-whatsapp-mcp']), 'utf8'), /^#!\/usr\/bin\/env node\n/);
});

test('bin: help and --version work without a WhatsApp session', () => {
  const bin = join(repo, pkg.bin['relay-whatsapp-mcp']);
  assert.equal(execFileSync(process.execPath, [bin, '--version'], { encoding: 'utf8' }).trim(), pkg.version);
  const help = execFileSync(process.execPath, [bin, 'help'], { encoding: 'utf8' });
  for (const cmd of ['setup', 'start', 'doctor', 'service', 'autostart', 'mcp']) assert.match(help, new RegExp('^  ' + cmd + ' ', 'm'));
});

test('npm pack: only source, scripts and docs; never .env, sessions, keys or tests', () => {
  const out = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json', '--ignore-scripts'],
    { cwd: repo, encoding: 'utf8', shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'ignore'] });
  const files = JSON.parse(out)[0].files.map(f => f.path.replace(/\\/g, '/'));
  for (const required of ['package.json', 'README.md', 'LICENSE', 'bin/relay-whatsapp-mcp.mjs', 'src/stdio.js', 'src/main.js', 'src/paths.js',
    'setup.mjs', 'scripts/relay-service.mjs', 'scripts/child-watchdog.mjs', 'scripts/macos/whatsapp-relay.plist', 'public/index.html', '.env.example']) {
    assert.ok(files.includes(required), 'missing ' + required);
  }
  const forbidden = /(^|\/)(\.env($|\.(?!example$))|data\/|demo-data\/|auth|node_modules\/|test\/|\.secrets\.json$|.*\.sqlite|.*\.db$|owner-token|remote-link\.json|\.proxy-key|.*\.pem$|.*\.key$|\.git\/|relay-worker\/|claude-proxy\/|CONTINUE-ON-MAC)/;
  const leaked = files.filter(f => forbidden.test(f));
  assert.deepEqual(leaked, [], 'must never be packed');
});
