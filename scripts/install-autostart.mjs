#!/usr/bin/env node
// Install Relay as a background service that starts automatically:
//   macOS   → launchd user agent   (scripts/macos/whatsapp-relay.plist)
//   Linux   → systemd user service (scripts/linux/whatsapp-relay.service)
//   Windows → Task Scheduler       (scripts/windows/install-autostart.ps1)
//
//   npm run autostart                 install and start
//   npm run autostart -- --dry-run    show what would be installed
//   npm run autostart -- --uninstall  remove it
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { home as relayHome, isNpxCache, loadEnv } from '../src/paths.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv();

export const xmlEscape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// systemd: quote paths with spaces; escape % (specifier) and backslashes/quotes.
export const systemdQuote = value => {
  const text = String(value).replace(/%/g, '%%');
  return /[\s"\\]/.test(text) ? '"' + text.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"' : text;
};

export function render(template, vars, escape = v => v) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (match, name) => {
    if (!(name in vars)) throw new Error('Missing template value ' + name);
    return escape(vars[name], name);
  });
}

export function plan({ platform = process.platform, node = process.execPath, dir = root, home = homedir(), env = process.env, relay = relayHome } = {}) {
  // The npx cache can be cleared at any time, which would break the installed service.
  if (isNpxCache(dir)) throw new Error('Relay is running from the temporary npx cache. Install it permanently first:\n  npm install -g relay-whatsapp-mcp\n  relay-whatsapp-mcp autostart');
  const logFile = join(relay, 'data', 'service.log');
  if (platform === 'darwin') {
    const label = (env.RELAY_LAUNCHD_PREFIX || 'com.example.whatsapp-relay') + '.service';
    const target = join(home, 'Library', 'LaunchAgents', label + '.plist');
    const template = readFileSync(join(dir, 'scripts', 'macos', 'whatsapp-relay.plist'), 'utf8');
    // Drop the explanatory comment from the installed copy.
    const body = render(template.replace(/<!--[\s\S]*?-->\n/, ''), { LABEL: label, NODE: node, RELAY_DIR: dir, RELAY_HOME: relay, LOG_FILE: logFile }, xmlEscape);
    return { platform, label, target, body, logFile };
  }
  if (platform === 'linux') {
    const target = join(home, '.config', 'systemd', 'user', 'whatsapp-relay.service');
    const template = readFileSync(join(dir, 'scripts', 'linux', 'whatsapp-relay.service'), 'utf8');
    const lines = template.split(/\r?\n/); // tolerate CRLF checkouts
    const body = lines.map(line => {
      if (line.startsWith('WorkingDirectory=')) return 'WorkingDirectory=' + systemdQuote(dir);
      if (line.startsWith('Environment=RELAY_HOME=')) return 'Environment=' + systemdQuote('RELAY_HOME=' + relay);
      if (line.startsWith('ExecStart=')) return 'ExecStart=' + systemdQuote(node) + ' ' + systemdQuote(join(dir, 'scripts', 'relay-service.mjs'));
      return line;
    }).join('\n');
    return { platform, label: 'whatsapp-relay.service', target, body, logFile };
  }
  if (platform === 'win32') {
    return { platform, label: 'WhatsApp Relay', script: join(dir, 'scripts', 'windows', 'install-autostart.ps1'), node, dir, relay, logFile };
  }
  throw new Error('Unsupported platform: ' + platform);
}

const run = (command, args, { ignore = false } = {}) => {
  try { return execFileSync(command, args, { stdio: ignore ? 'ignore' : 'inherit' }); }
  catch (error) { if (!ignore) throw error; }
};

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const uninstall = process.argv.includes('--uninstall');
  const p = plan();
  mkdirSync(dirname(p.logFile), { recursive: true, mode: 0o700 });

  if (p.platform === 'win32') {
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', p.script, '-NodePath', p.node, '-RelayDir', p.dir, '-RelayHome', p.relay];
    if (uninstall) args.push('-Uninstall');
    if (dryRun) args.push('-DryRun');
    run('powershell.exe', args);
    return;
  }

  if (dryRun) {
    console.log((uninstall ? 'Would remove ' : 'Would write ') + p.target + (uninstall ? '' : ':\n\n' + p.body));
    return;
  }

  if (p.platform === 'darwin') {
    const domain = 'gui/' + userInfo().uid;
    run('launchctl', ['bootout', domain + '/' + p.label], { ignore: true });
    if (uninstall) { rmSync(p.target, { force: true }); console.log('Removed ' + p.label); return; }
    mkdirSync(dirname(p.target), { recursive: true });
    writeFileSync(p.target, p.body, { mode: 0o644 });
    run('launchctl', ['bootstrap', domain, p.target]);
    console.log(`Installed ${p.target}\nRelay now starts when you log in. Logs: ${p.logFile}`);
    return;
  }

  // linux
  if (uninstall) {
    run('systemctl', ['--user', 'disable', '--now', p.label], { ignore: true });
    rmSync(p.target, { force: true });
    run('systemctl', ['--user', 'daemon-reload'], { ignore: true });
    console.log('Removed ' + p.label);
    return;
  }
  mkdirSync(dirname(p.target), { recursive: true });
  writeFileSync(p.target, p.body, { mode: 0o644 });
  run('systemctl', ['--user', 'daemon-reload']);
  run('systemctl', ['--user', 'enable', '--now', p.label]);
  console.log(`Installed ${p.target}\nLogs: journalctl --user -u whatsapp-relay -f`);
  console.log('To start at boot without logging in, run once: sudo loginctl enable-linger "$USER"');
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try { main(); } catch (error) { console.error('Autostart failed: ' + error.message); process.exit(1); }
}
