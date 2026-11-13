#!/usr/bin/env node
// Cross-platform runner used by the auto-start templates (launchd, systemd,
// Windows Task Scheduler). It runs the WhatsApp bridge and, when a relay is
// configured, the remote agent, restarting either if it exits.
//
//   node scripts/relay-service.mjs [--log <file>]
//
// Only standard Node APIs are used, so it behaves the same on macOS, Linux
// and Windows.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, writeSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defaultDataDir, home, loadEnv } from '../src/paths.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv();

export function relayConfigured(env = process.env, dataDir = env.DATA_DIR || defaultDataDir()) {
  if (env.RELAY_REMOTE_URL && env.RELAY_AGENT_KEY && env.RELAY_AGENT_ID) return true;
  try { return JSON.parse(readFileSync(resolve(dataDir, 'remote-link.json'), 'utf8')).published === true; }
  catch { return false; }
}

// Restart delay: quick at first, backing off to 30 s while a process keeps
// crashing; reset once it has stayed up for a minute.
export function nextDelay(previous, uptimeMs) {
  if (uptimeMs >= 60000) return 2000;
  return Math.min(30000, previous ? previous * 2 : 2000);
}

function main() {
  const logIndex = process.argv.indexOf('--log');
  let output = 'inherit';
  if (logIndex !== -1 && process.argv[logIndex + 1]) {
    const file = resolve(home, process.argv[logIndex + 1]); // relative paths are relative to the Relay home
    mkdirSync(dirname(file), { recursive: true });
    output = openSync(file, 'a', 0o600);
  }
  const log = message => {
    const line = new Date().toISOString() + ' [service] ' + message + '\n';
    if (output === 'inherit') process.stderr.write(line); else writeSync(output, line);
  };
  const children = new Map();
  let stopping = false;

  function run(name, script, extraEnv = {}) {
    let delay = 0;
    const start = () => {
      if (stopping) return;
      const began = Date.now();
      const watchdog = pathToFileURL(resolve(root, 'scripts', 'child-watchdog.mjs')).href;
      const child = spawn(process.execPath, ['--import', watchdog, script], {
        cwd: root,
        env: { ...process.env, ...extraEnv },
        stdio: ['ignore', output, output, 'ipc'],
        windowsHide: true,
      });
      children.set(name, child);
      log(`${name} started (pid ${child.pid})`);
      child.on('exit', (code, signal) => {
        children.delete(name);
        if (stopping) return;
        delay = nextDelay(delay, Date.now() - began);
        log(`${name} exited (${signal || code}); restarting in ${delay / 1000} s`);
        setTimeout(start, delay);
      });
    };
    start();
  }

  run('bridge', 'src/main.js', { AUTO_CONNECT: process.env.AUTO_CONNECT || 'true' });
  if (relayConfigured()) run('agent', 'src/remote-agent.js');
  else log('No relay configured (RELAY_REMOTE_URL); running the local bridge only.');

  const stop = () => {
    if (stopping) return;
    stopping = true;
    log('stopping');
    for (const child of children.values()) child.kill();
    setTimeout(() => process.exit(0), 5000).unref();
    const check = setInterval(() => { if (!children.size) { clearInterval(check); process.exit(0); } }, 100);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  if (process.platform === 'win32') process.on('SIGBREAK', stop);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
