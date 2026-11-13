#!/usr/bin/env node
// `npm run lint`: syntax-checks every JavaScript file (no extra dependencies)
// and makes sure the bridge and relay agree on the tool catalog (see scripts/tool-catalog.mjs).
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const skip = new Set(['node_modules', '.git', 'data', 'demo-data', '.wrangler']);
const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (/\.(m?js)$/.test(entry.name)) files.push(path);
  }
})(root);

let failed = 0;
for (const file of files) {
  try { execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }); }
  catch (error) { failed++; console.error('✗ ' + file.slice(root.length + 1) + '\n' + error.stderr.toString()); }
}

const catalog = JSON.parse(readFileSync(join(root, 'relay-worker', 'src', 'lib', 'whatsapp-tools.json'), 'utf8')).map(t => t.name).sort();
const source = readFileSync(join(root, 'src', 'tools.js'), 'utf8');
const bridge = [...[...source.matchAll(/\badd\('([a-z_]+)'/g)].map(m => m[1]), 'list_profiles'].sort(); // list_profiles: src/profiles.js
const missing = catalog.filter(n => !bridge.includes(n)), extra = bridge.filter(n => !catalog.includes(n));
if (missing.length || extra.length) { failed++; console.error('✗ tool catalogs differ. Relay only: ' + missing.join(', ') + ' | bridge only: ' + extra.join(', ')); }

// The full schema check (scripts/tool-catalog.mjs --check) needs the installed packages,
// so it runs in the test suite (test/package.test.js); lint stays dependency-free.
console.log(`${failed ? '✗' : '✓'} ${files.length} files syntax-checked; bridge and relay share ${catalog.length} tools`);
process.exitCode = failed ? 1 : 0;
