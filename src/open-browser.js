// Opens the dashboard in the default browser when Relay is started by a person in a terminal
// (not by the background service, auto-start, CI or a hosted deployment).
import { spawn } from 'node:child_process';

export function shouldOpenBrowser({ env = process.env, isTTY = process.stdout.isTTY, production = false } = {}) {
  if (production || !isTTY || env.CI || env.RELAY_NO_BROWSER === '1' || env.RELAY_NO_BROWSER === 'true') return false;
  if (process.platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) return false; // headless server
  return true;
}

export function openBrowserCommand(url, platform = process.platform) {
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'win32') return ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]];
  return ['xdg-open', [url]];
}

export function openBrowser(url) {
  const [cmd, args] = openBrowserCommand(url);
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {}); child.unref();
  } catch { /* no browser available: the URL is printed anyway */ }
}
