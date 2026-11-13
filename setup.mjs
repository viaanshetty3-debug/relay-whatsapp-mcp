#!/usr/bin/env node
// Relay setup: `npm run setup`
//
// Works the same on macOS, Linux and Windows (plain Node, no shell tools).
// - generates strong random keys,
// - asks for your relay and Cloudflare doorway URLs (both optional),
// - writes .env (and the secret files the relay-worker / claude-proxy deploys read),
// - prints ready-to-paste configs for Claude Desktop, Claude Code and ChatGPT.
//
// Options:
//   npm run setup                  interactive setup
//   npm run setup -- --print       re-print the client configs from an existing .env
// From npm: `npx relay-whatsapp-mcp setup` (files go to ~/.relay-whatsapp-mcp, see src/paths.js).
import { randomBytes, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { command, envFile, home, isNpxCache } from './src/paths.js';

export const root = dirname(fileURLToPath(import.meta.url));
const MIN_NODE = [22, 13];

// ---------- pure helpers (unit-tested) ----------

export const newKey = (bytes = 32) => randomBytes(bytes).toString('base64url');

// Accepts "relay.example.com", "https://relay.example.com/whatsapp/mcp", ...
// Returns the HTTPS origin, or '' for an empty answer.
export function normalizeOrigin(input) {
  const text = String(input || '').trim();
  if (!text) return '';
  const url = new URL(/^[a-z]+:\/\//i.test(text) ? text : 'https://' + text);
  if (url.protocol !== 'https:') throw new Error('Use an https:// address');
  if (url.username || url.password) throw new Error('Do not put credentials in the address');
  return url.origin;
}

export const relayMcpUrl = origin => origin ? origin + '/whatsapp/mcp' : '';
export const doorwayMcpUrl = origin => origin ? origin + '/mcp' : '';

// answers: {mode:'first'|'standby', relayUrl, doorwayUrl, siteKey (optional), ownerEmail (optional),
//           agentKey, agentId (standby only)}
export function buildSettings(answers, gen = { key: newKey, uuid: randomUUID }) {
  const standby = answers.mode === 'standby';
  const relay = normalizeOrigin(answers.relayUrl);
  if (standby && !relay) throw new Error('A standby device needs the relay URL of your existing setup');
  if (standby && (!answers.agentKey || !answers.agentId)) throw new Error('A standby device needs RELAY_AGENT_KEY and RELAY_AGENT_ID from your primary device');
  const env = {
    HOST: '127.0.0.1',
    PORT: '8787',
    AUTO_CONNECT: 'true',
    BRIDGE_TOKEN: gen.key(),
  };
  if (relay) {
    Object.assign(env, {
      RELAY_REMOTE_URL: relay,
      RELAY_AGENT_KEY: standby ? answers.agentKey : gen.key(),
      RELAY_AGENT_ID: standby ? answers.agentId : gen.uuid(),
      RELAY_DEVICE_ID: gen.uuid(),
      RELAY_FAILOVER_ROLE: standby ? 'standby' : 'primary',
    });
    if (answers.siteKey) env.RELAY_SITE_KEY = answers.siteKey;
    // A standby on Cloudflare's free plan checks less often to stay under the daily request quota.
    if (standby && /\.workers\.dev$/i.test(new URL(relay).hostname)) env.RELAY_WATCH_MS = '3000';
  }
  // Keys only the first device creates; a standby reuses the existing relay.
  let relaySecrets = null, doorwaySecrets = null;
  if (relay && !standby) {
    env.RELAY_CLIENT_KEY = gen.key();
    relaySecrets = { WA_AGENT_KEY: env.RELAY_AGENT_KEY, WA_CLIENT_KEY: env.RELAY_CLIENT_KEY };
    if (answers.ownerEmail) relaySecrets.WA_OWNER_EMAIL = answers.ownerEmail;
    const doorway = normalizeOrigin(answers.doorwayUrl);
    env.CLAUDE_DOORWAY_KEY = gen.key();
    if (doorway) env.CLAUDE_DOORWAY_URL = doorway;
    doorwaySecrets = { RELAY_URL: relayMcpUrl(relay), PROXY_KEY: env.CLAUDE_DOORWAY_KEY, CLIENT_KEY: env.RELAY_CLIENT_KEY };
    if (answers.siteKey) doorwaySecrets.SITE_KEY = answers.siteKey;
  }
  return { env, relaySecrets, doorwaySecrets };
}

const quote = value => /^[A-Za-z0-9_@.:\/+=-]*$/.test(value) ? value : JSON.stringify(value);
export function serializeEnv(env) {
  const groups = [
    ['# Local bridge', ['HOST', 'PORT', 'AUTO_CONNECT', 'BRIDGE_TOKEN']],
    ['# Remote agent (connects this device to your relay)', ['RELAY_REMOTE_URL', 'RELAY_SITE_KEY', 'RELAY_AGENT_KEY', 'RELAY_AGENT_ID', 'RELAY_DEVICE_ID', 'RELAY_FAILOVER_ROLE', 'RELAY_WATCH_MS']],
    ['# Keys for AI clients (also uploaded to the relay / Claude doorway)', ['RELAY_CLIENT_KEY', 'CLAUDE_DOORWAY_URL', 'CLAUDE_DOORWAY_KEY']],
  ];
  let text = '# Written by `npm run setup`. Keep this file private; never commit it.\n';
  for (const [title, keys] of groups) {
    const present = keys.filter(k => env[k] !== undefined && env[k] !== '');
    if (!present.length) continue;
    text += '\n' + title + '\n' + present.map(k => `${k}=${quote(env[k])}`).join('\n') + '\n';
  }
  return text;
}

export function parseEnv(text) {
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (v.startsWith('"')) { try { v = JSON.parse(v); } catch { v = v.slice(1, -1); } }
    env[m[1]] = v;
  }
  return env;
}

export function claudeDesktopConfigPath(platform = process.platform, home = homedir(), appData = process.env.APPDATA) {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (platform === 'win32') return join(appData || join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  return null; // Claude Desktop is not available for Linux
}

// Returns [{title, text}] sections. Secrets are included because the output
// is meant to be pasted into your own client settings.
// How a local MCP client starts Relay's stdio adapter. Run from the npx cache,
// the path would disappear when npm clears that cache, so use npx itself.
export function localLauncher({ node = process.execPath, dir = root, npx = isNpxCache(dir) } = {}) {
  return npx ? { command: 'npx', args: ['-y', 'relay-whatsapp-mcp', 'mcp'] } : { command: node, args: [join(dir, 'src', 'stdio.js')] };
}

export function clientConfigs(env, { node = process.execPath, dir = root, platform = process.platform, npx } = {}) {
  const launch = localLauncher({ node, dir, npx });
  const out = [];
  const desktopPath = claudeDesktopConfigPath(platform);
  out.push({
    title: 'Claude Desktop (this computer, local)',
    text: (desktopPath ? `Merge into ${desktopPath}, then restart Claude Desktop:\n` : 'Claude Desktop is not available on Linux; use Claude Code below.\n') +
      JSON.stringify({ mcpServers: { whatsapp: launch } }, null, 2),
  });
  out.push({
    title: 'Claude Code (this computer, local)',
    text: `Run:\n  claude mcp add whatsapp -- ${[launch.command, ...launch.args].map(a => JSON.stringify(a)).join(' ')}\nor put this in .mcp.json:\n` +
      JSON.stringify({ mcpServers: { whatsapp: { type: 'stdio', ...launch } } }, null, 2),
  });
  if (env.CLAUDE_DOORWAY_KEY) {
    const url = env.CLAUDE_DOORWAY_URL ? doorwayMcpUrl(env.CLAUDE_DOORWAY_URL) : 'https://whatsapp-claude.<your-subdomain>.workers.dev/mcp';
    out.push({
      title: 'Claude on any device (claude.ai, Claude Desktop, mobile) via the Cloudflare doorway',
      text: 'Settings → Connectors → Add custom connector:\n' +
        JSON.stringify({ name: 'WhatsApp', url, authentication: 'No sign-in', requestHeaders: { 'x-api-key': env.CLAUDE_DOORWAY_KEY } }, null, 2),
    });
    out.push({
      title: 'Claude Code (any computer) via the Cloudflare doorway',
      text: `Run:\n  claude mcp add --transport http whatsapp ${url} --header "x-api-key: ${env.CLAUDE_DOORWAY_KEY}"\nor put this in .mcp.json:\n` +
        JSON.stringify({ mcpServers: { whatsapp: { type: 'http', url, headers: { 'x-api-key': env.CLAUDE_DOORWAY_KEY } } } }, null, 2),
    });
  }
  out.push({
    title: 'ChatGPT connector',
    text: 'ChatGPT custom connectors cannot send custom headers, so they cannot use the relay client key.\n' +
      'Expose this bridge over HTTPS (set PUBLIC_URL) and connect ChatGPT to it with the built-in OAuth:\n' +
      JSON.stringify({ name: 'WhatsApp', url: '<PUBLIC_URL>/mcp', authentication: 'OAuth' }, null, 2),
  });
  return out;
}

export function nodeVersionOk(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

// ---------- interactive part ----------

function prompter() {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  let muted = false;
  const write = rl._writeToOutput?.bind(rl);
  if (write) rl._writeToOutput = text => { if (!muted || /\n|\r/.test(text)) write(muted ? '\n' : text); };
  const lines = [];
  let waiting = null;
  rl.on('line', line => { if (waiting) { const w = waiting; waiting = null; w(line); } else lines.push(line); });
  const ask = (question, { secret = false } = {}) => new Promise(res => {
    process.stdout.write(question);
    muted = secret && process.stdin.isTTY;
    const done = answer => { muted = false; res(answer.trim()); };
    if (lines.length) done(lines.shift()); else waiting = done;
  });
  return { ask, close: () => rl.close() };
}

async function askUntilValid(ask, question, validate, options) {
  for (;;) {
    const answer = await ask(question, options);
    try { validate(answer); return answer; }
    catch (error) { console.log('  ' + error.message); }
  }
}

function printConfigs(env) {
  for (const { title, text } of clientConfigs(env)) {
    console.log('\n=== ' + title + ' ===\n' + text);
  }
  console.log('\nKeep these keys private: anyone with them can use your WhatsApp through Relay.');
}

function writePrivate(path, text) {
  writeFileSync(path, text, { mode: 0o600 });
}

async function main() {
  if (!nodeVersionOk()) {
    console.error(`Relay needs Node.js ${MIN_NODE.join('.')} or newer (you have ${process.versions.node}).`);
    process.exit(1);
  }
  const envPath = envFile;
  if (process.argv.includes('--print')) {
    if (!existsSync(envPath)) { console.error(`No .env yet. Run \`${command('setup')}\` first.`); process.exit(1); }
    printConfigs(parseEnv(readFileSync(envPath, 'utf8')));
    return;
  }

  const { ask, close } = prompter();
  try {
    console.log('Relay setup. Press Enter to accept [defaults] or skip optional questions.');
    console.log(`Private files (.env, data/) go in ${home}\n`);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    if (existsSync(envPath)) {
      const answer = await ask('A .env already exists. Replace it? It will be backed up first. [y/N] ');
      if (!/^y/i.test(answer)) { console.log(`Nothing changed. To see your client configs: ${command('setup')}${command('setup').startsWith('npm') ? ' --' : ''} --print`); return; }
      const backup = envPath + '.backup-' + new Date().toISOString().replace(/[:.]/g, '-');
      copyFileSync(envPath, backup);
      console.log('Backed up to ' + backup);
    }

    const mode = /^2/.test(await ask('Is this\n  1) your first (primary) Relay device, or\n  2) a standby device added to an existing setup?\n[1] ')) ? 'standby' : 'first';
    const answers = { mode };

    if (mode === 'standby') {
      console.log('\nCopy these from the primary device\'s .env (do NOT copy its data/ folder: link WhatsApp separately here).');
      answers.relayUrl = await askUntilValid(ask, 'RELAY_REMOTE_URL: ', v => { if (!normalizeOrigin(v)) throw new Error('Required'); });
      answers.agentKey = await askUntilValid(ask, 'RELAY_AGENT_KEY (hidden): ', v => { if (v.length < 32) throw new Error('That key looks too short'); }, { secret: true });
      answers.agentId = await askUntilValid(ask, 'RELAY_AGENT_ID: ', v => { if (!/^[a-f0-9-]{36}$/i.test(v)) throw new Error('Expected a UUID'); });
    } else {
      console.log('\nOptional: a hosted relay lets ChatGPT/Claude reach this computer from anywhere.');
      console.log('Skip it to use Relay only with AI apps on this computer.');
      answers.relayUrl = await askUntilValid(ask, 'Relay URL (e.g. https://whatsapp-relay.you.workers.dev) [skip]: ', normalizeOrigin);
      if (answers.relayUrl) {
        console.log('\nOptional: the Cloudflare doorway lets claude.ai connect with an x-api-key header.');
        answers.doorwayUrl = await askUntilValid(ask, 'Cloudflare doorway URL (e.g. https://whatsapp-claude.you.workers.dev) [later]: ', normalizeOrigin);
      }
    }

    const { env, relaySecrets, doorwaySecrets } = buildSettings(answers);
    writePrivate(envPath, serializeEnv(env));
    console.log('\nWrote ' + envPath);
    // The Workers are deployed from a git clone. In a clone the secrets go straight into
    // the Worker folders; an npm install has no Worker folders, so they wait in the Relay home.
    const clone = existsSync(resolve(root, 'relay-worker'));
    const secretsFile = name => clone ? resolve(root, name, '.secrets.json') : join(home, name + '.secrets.json');
    const fromNpm = name => clone ? '' : ` (copy it to ${name}/.secrets.json in a clone of https://github.com/viaanshetty3-debug/relay-whatsapp-mcp first)`;
    if (relaySecrets) {
      writePrivate(secretsFile('relay-worker'), JSON.stringify(relaySecrets, null, 2) + '\n');
      console.log(`Wrote ${secretsFile('relay-worker')}  → deploy the relay: cd relay-worker && npm run deploy${fromNpm('relay-worker')}`);
    }
    if (doorwaySecrets) {
      writePrivate(secretsFile('claude-proxy'), JSON.stringify(doorwaySecrets, null, 2) + '\n');
      console.log(`Wrote ${secretsFile('claude-proxy')}  → deploy the doorway: cd claude-proxy && npm run deploy${fromNpm('claude-proxy')}`);
      if (!env.CLAUDE_DOORWAY_URL) console.log(`After deploying, add CLAUDE_DOORWAY_URL=<the workers.dev address> to ${envPath} and re-print the configs with --print.`);
    }

    printConfigs(env);
    console.log('\nNext steps:');
    console.log(`  1. ${command('start')}  → open http://127.0.0.1:8787 and link WhatsApp (QR code)`);
    console.log(`  2. ${command('service')}  → bridge${env.RELAY_REMOTE_URL ? ' + relay agent' : ''} with automatic restarts`);
    console.log(`  3. ${command('autostart')}  → start automatically when you log in (macOS, Linux, Windows)`);
    if (isNpxCache()) console.log('     (auto-start needs a permanent install first: npm install -g relay-whatsapp-mcp)');
    if (mode === 'first' && env.RELAY_REMOTE_URL) console.log(`  Later: add a standby computer by running \`${command('setup')}\` there and choosing option 2.`);
  } finally {
    close();
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch(error => { console.error('Setup failed: ' + error.message); process.exit(1); });
}
