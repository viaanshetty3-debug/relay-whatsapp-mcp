#!/usr/bin/env node
// `npm run doctor`: checks a Relay install in a few seconds and says what to fix.
// Never prints secret values.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { command, defaultDataDir, envFile, home } from '../src/paths.js';

const TIMEOUT = 2500;

// ---------- pure checks (unit-tested) ----------

export function checkNode(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  const ok = major > 22 || (major === 22 && minor >= 13);
  return { name: 'Node.js', status: ok ? 'ok' : 'fail', detail: `v${version}` + (ok ? '' : ' (needs 22.13 or newer: https://nodejs.org)') };
}

const KEY = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function checkEnv(env, envFileExists) {
  const results = [];
  if (!envFileExists) results.push({ name: '.env', status: 'warn', detail: `not found. Run \`${command('setup')}\` (defaults are used meanwhile)` });
  else results.push({ name: '.env', status: 'ok', detail: 'found in ' + home });
  if (env.BRIDGE_TOKEN !== undefined && env.BRIDGE_TOKEN.length < 32) results.push({ name: 'BRIDGE_TOKEN', status: 'fail', detail: 'must be at least 32 characters' });
  if (!env.RELAY_REMOTE_URL) {
    results.push({ name: 'Relay', status: 'info', detail: 'not configured: local-only mode (Claude Desktop / Claude Code on this computer)' });
    return results;
  }
  let url;
  try { url = new URL(env.RELAY_REMOTE_URL); } catch { results.push({ name: 'RELAY_REMOTE_URL', status: 'fail', detail: 'is not a valid URL' }); return results; }
  if (url.protocol !== 'https:') results.push({ name: 'RELAY_REMOTE_URL', status: 'fail', detail: 'must start with https://' });
  if (!KEY.test(env.RELAY_AGENT_KEY || '')) results.push({ name: 'RELAY_AGENT_KEY', status: 'fail', detail: `missing or not a 32-byte base64url key (re-run \`${command('setup')}\`)` });
  if (!UUID.test(env.RELAY_AGENT_ID || '')) results.push({ name: 'RELAY_AGENT_ID', status: 'fail', detail: 'missing or not a UUID' });
  if (!UUID.test(env.RELAY_DEVICE_ID || '')) results.push({ name: 'RELAY_DEVICE_ID', status: 'warn', detail: 'missing: failover read hand-off is disabled for this device' });
  const role = env.RELAY_FAILOVER_ROLE || 'primary';
  if (!['primary', 'standby'].includes(role)) results.push({ name: 'RELAY_FAILOVER_ROLE', status: 'fail', detail: 'must be primary or standby' });
  if (role === 'standby' && /\.workers\.dev$/i.test(url.hostname) && Number(env.RELAY_WATCH_MS || 750) < 3000) {
    results.push({ name: 'RELAY_WATCH_MS', status: 'warn', detail: 'below 3000 on a workers.dev relay: may exceed the Cloudflare free request quota' });
  }
  if (!results.some(r => r.status === 'fail' && r.name.startsWith('RELAY'))) results.push({ name: 'Relay settings', status: 'ok', detail: `${role} → ${url.origin}` });
  return results;
}

// ---------- live checks ----------

async function timed(fn) {
  try { return await fn(AbortSignal.timeout(TIMEOUT)); }
  catch (error) { return { error: error.name === 'TimeoutError' ? 'timed out' : error.cause?.code || error.message }; }
}

async function checkBridge(env) {
  const port = Number(env.PORT || 8787);
  const dataDir = env.DATA_DIR ? resolve(home, env.DATA_DIR) : defaultDataDir();
  let token = env.BRIDGE_TOKEN;
  if (!token) try { token = readFileSync(join(dataDir, 'owner-token'), 'utf8').trim(); } catch {}
  const r = await timed(async signal => {
    const res = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: token ? { Authorization: 'Bearer ' + token } : {}, signal });
    return { status: res.status, body: res.ok ? await res.json() : null };
  });
  if (r.error) return [{ name: 'Bridge', status: 'fail', detail: `not reachable on 127.0.0.1:${port} (${r.error}). Start it: ${command('start')} or ${command('service')}` }];
  if (r.status === 401 || r.status === 403) return [{ name: 'Bridge', status: 'fail', detail: 'running, but the owner token does not match (check BRIDGE_TOKEN / DATA_DIR)' }];
  if (!r.body) return [{ name: 'Bridge', status: 'fail', detail: `HTTP ${r.status}` }];
  const s = r.body;
  const out = [{ name: 'Bridge', status: 'ok', detail: `running on port ${port}${s.demo ? ' (demo mode)' : ''}` }];
  const session = s.state === 'connected' ? { status: 'ok', detail: 'connected' }
    : s.state === 'pairing' ? { status: 'warn', detail: 'waiting for QR / pairing code: open the dashboard' }
    : s.state === 'logged_out' ? { status: 'fail', detail: 'logged out by WhatsApp: choose Retry pairing in the dashboard' }
    : { status: 'warn', detail: `${s.state || 'unknown'}${s.error ? ': ' + s.error : ''}` };
  out.push({ name: 'WhatsApp session', ...session });
  return out;
}

async function checkRelay(env) {
  if (!env.RELAY_REMOTE_URL || !KEY.test(env.RELAY_AGENT_KEY || '') || !UUID.test(env.RELAY_AGENT_ID || '')) return [];
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.RELAY_AGENT_KEY };
  if (env.RELAY_SITE_KEY) headers['OAI-Sites-Authorization'] = 'Bearer ' + env.RELAY_SITE_KEY;
  const r = await timed(async signal => {
    const res = await fetch(new URL('/api/whatsapp/agent/health', env.RELAY_REMOTE_URL), { method: 'POST', headers, body: JSON.stringify({ agent: env.RELAY_AGENT_ID }), signal });
    return { status: res.status, body: await res.json().catch(() => null) };
  });
  if (r.error) return [{ name: 'Relay', status: 'fail', detail: `not reachable (${r.error})` }];
  if (r.status === 403) return [{ name: 'Relay', status: 'fail', detail: 'reachable, but RELAY_AGENT_KEY does not match the relay\'s WA_AGENT_KEY' }];
  if (r.status !== 200 || !r.body) return [{ name: 'Relay', status: 'fail', detail: `HTTP ${r.status}` }];
  const age = r.body.lastSeen ? Math.round((Date.now() - r.body.lastSeen) / 1000) : null;
  return [{ name: 'Relay', status: r.body.online ? 'ok' : 'warn',
    detail: r.body.online ? `online; a device polled ${age}s ago${r.body.bridge?.state ? ` (WhatsApp ${r.body.bridge.state})` : ''}`
      : `reachable, but no device of this agent is polling${age !== null ? ` (last seen ${age}s ago)` : ''}. Is ${command('service')} running?` }];
}

async function checkDoorway(env) {
  if (!env.CLAUDE_DOORWAY_URL) return [];
  const r = await timed(async signal => {
    const res = await fetch(new URL('/mcp', env.CLAUDE_DOORWAY_URL), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal });
    return { status: res.status };
  });
  if (r.error) return [{ name: 'Claude doorway', status: 'fail', detail: `not reachable (${r.error})` }];
  // Without a key the doorway must refuse; anything else means it is misconfigured or not ours.
  return [r.status === 401 ? { name: 'Claude doorway', status: 'ok', detail: 'deployed and requires x-api-key' }
    : { name: 'Claude doorway', status: 'fail', detail: `unexpected HTTP ${r.status} without a key (expected 401)` }];
}

function checkAutostart(platform = process.platform, home = homedir(), env = process.env) {
  let installed = null;
  if (platform === 'darwin') installed = existsSync(join(home, 'Library', 'LaunchAgents', (env.RELAY_LAUNCHD_PREFIX || 'com.example.whatsapp-relay') + '.service.plist'));
  else if (platform === 'linux') installed = existsSync(join(home, '.config', 'systemd', 'user', 'whatsapp-relay.service'));
  if (installed === null) return [{ name: 'Auto-start', status: 'info', detail: `run \`${command('autostart')}\` to start at login (check Task Scheduler for "WhatsApp Relay")` }];
  return [{ name: 'Auto-start', status: installed ? 'ok' : 'info', detail: installed ? 'installed' : `not installed. Run \`${command('autostart')}\` to start at login` }];
}

const ICON = { ok: '✓', warn: '!', fail: '✗', info: '·' };

async function main() {
  const envPath = envFile;
  const envFileExists = existsSync(envPath);
  if (envFileExists) process.loadEnvFile(envPath);
  const env = process.env;
  const started = Date.now();
  const results = [checkNode(), ...checkEnv(env, envFileExists)];
  const live = await Promise.all([checkBridge(env), checkRelay(env), checkDoorway(env)]);
  results.push(...live.flat(), ...checkAutostart());
  for (const r of results) console.log(`${ICON[r.status]} ${r.name.padEnd(18)} ${r.detail}`);
  const failed = results.filter(r => r.status === 'fail').length, warned = results.filter(r => r.status === 'warn').length;
  console.log(`\n${failed ? `${failed} problem(s)` : 'No problems'}${warned ? `, ${warned} warning(s)` : ''} · ${((Date.now() - started) / 1000).toFixed(1)} s`);
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
