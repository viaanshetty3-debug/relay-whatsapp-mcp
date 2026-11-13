#!/usr/bin/env node
// Keeps relay-worker/src/lib/whatsapp-tools.json (the tool list remote AI clients see) in step with
// the bridge: every tool gets the bridge's `profile` argument and list_profiles is included.
// The catalog keeps its own remote-specific descriptions.
//   node scripts/tool-catalog.mjs          update the file
//   node scripts/tool-catalog.mjs --check  exit 1 if it is out of date
import { readFileSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Bridge, mcpServer } from '../src/tools.js';
import { ProfileRouter } from '../src/profiles.js';

const path = new URL('../relay-worker/src/lib/whatsapp-tools.json', import.meta.url);
const router = new ProfileRouter({ main: { bridge: new Bridge(null, null, { allowed: new Set(), readOnly: false }) } });
const server = mcpServer(router), client = new Client({ name: 'catalog', version: '1.0.0' });
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a); await client.connect(b);
const live = (await client.listTools()).tools;
await client.close();

const current = readFileSync(path, 'utf8');
const catalog = JSON.parse(current);
const byName = new Map(live.map(t => [t.name, t]));
for (const tool of catalog) {
  const profile = byName.get(tool.name)?.inputSchema.properties?.profile;
  if (profile) tool.inputSchema.properties.profile = profile;
}
if (!catalog.some(t => t.name === 'list_profiles')) catalog.push(byName.get('list_profiles'));
const text = JSON.stringify(catalog, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (current !== text) { console.error('✗ relay tool catalog is out of date: run node scripts/tool-catalog.mjs'); process.exit(1); }
  console.log('✓ relay tool catalog is up to date');
} else { writeFileSync(path, text); console.log('Updated ' + path.pathname); }
