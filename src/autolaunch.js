// Starts the bridge in the background when an AI app needs it and it isn't running yet.
// The bridge itself refuses to run twice (it checks the port), so a race only wastes a process.
import { spawn } from 'node:child_process';
import { openSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { packageDir } from './paths.js';

export const isUp = (port, f = fetch) => f(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) }).then(r => r.ok).catch(() => false);
let pending = null;
export function ensureBridge(cfg, { up = isUp, start = launch, wait = 15000 } = {}) {
  return pending ||= (async () => {
    if (await up(cfg.port)) return 'running';
    start(cfg);
    for (const until = Date.now() + wait; Date.now() < until;) {
      await new Promise(r => setTimeout(r, 500));
      if (await up(cfg.port)) return 'started';
    }
    return 'starting';
  })().finally(() => { pending = null; });
}
export function launch(cfg) {
  mkdirSync(cfg.dir, { recursive: true, mode: 0o700 });
  const log = openSync(join(cfg.dir, 'background.log'), 'a', 0o600);
  const child = spawn(process.execPath, [join(packageDir, 'src', 'main.js')], {
    detached: true, stdio: ['ignore', log, log], windowsHide: true,
    env: { ...process.env, DATA_DIR: cfg.dir, AUTO_CONNECT: 'true', RELAY_NO_BROWSER: '1' },
  });
  child.unref();
  return child.pid;
}
