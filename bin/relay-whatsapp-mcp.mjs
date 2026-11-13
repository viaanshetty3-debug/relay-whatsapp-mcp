#!/usr/bin/env node
// `npx relay-whatsapp-mcp <command>`: one entry point for the npm package.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { home, packageDir } from '../src/paths.js';

const COMMANDS = {
  setup: ['setup.mjs', 'create .env with fresh keys and print your AI client configs'],
  start: ['src/main.js', 'run the bridge; link WhatsApp in its dashboard at http://127.0.0.1:8787'],
  demo: ['src/main.js --demo', 'run with sample chats (no WhatsApp account needed)'],
  service: ['scripts/relay-service.mjs', 'run the bridge (and relay agent, if configured) with automatic restarts'],
  autostart: ['scripts/install-autostart.mjs', 'start Relay at login (--dry-run, --uninstall)'],
  doctor: ['scripts/doctor.mjs', 'check the install and say what to fix'],
  agent: ['src/remote-agent.js', 'run only the relay agent'],
  mcp: ['src/stdio.js', 'stdio MCP server for Claude Desktop / Claude Code (the bridge must be running)'],
};

const [name, ...rest] = process.argv.slice(2);
const version = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).version;

if (!name || name === 'help' || name === '--help' || name === '-h') {
  console.log(`relay-whatsapp-mcp ${version}: WhatsApp as MCP tools for Claude and ChatGPT\n\nUsage: npx relay-whatsapp-mcp <command>\n`);
  for (const [cmd, [, text]] of Object.entries(COMMANDS)) console.log(`  ${cmd.padEnd(10)} ${text}`);
  console.log(`\nPrivate files (.env, WhatsApp session, data): ${home}\nSet RELAY_HOME to use another folder. Docs: https://github.com/viaanshetty3-debug/relay-whatsapp-mcp`);
  process.exit(0);
}
if (name === '--version' || name === '-v') { console.log(version); process.exit(0); }
if (!COMMANDS[name]) { console.error(`Unknown command "${name}". Run: npx relay-whatsapp-mcp help`); process.exit(2); }

const [script, ...fixedArgs] = COMMANDS[name][0].split(' ');
if (name === 'mcp') {
  // Run in this process: MCP clients talk to it over stdin/stdout and stop it by closing them.
  process.argv = [process.argv[0], join(packageDir, script), ...rest];
  await import('../src/stdio.js');
} else {
  const child = spawn(process.execPath, [join(packageDir, script), ...fixedArgs, ...rest], { stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}
