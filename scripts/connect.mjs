// `relay-whatsapp-mcp connect`: adds Relay to Claude Desktop and Claude Code on this computer.
import { config } from '../src/config.js';
import { addToClaudeDesktop, addToClaudeCode } from '../src/clients.js';

const cfg = config();
let ok = true;
try {
  const r = addToClaudeDesktop(cfg);
  console.log(r.changed ? `✓ Claude Desktop: added Relay (${r.path})${r.backup ? `\n  Your previous settings were saved to ${r.backup}` : ''}\n  Quit and reopen Claude Desktop to load it.` : '✓ Claude Desktop: already set up.');
} catch (e) { ok = false; console.error('✗ Claude Desktop: ' + e.message); }
const code = addToClaudeCode(cfg);
if (!code.installed) console.log('· Claude Code: not installed here (skipped).');
else if (code.added) console.log('✓ Claude Code: added Relay for your user (try: claude, then ask about your WhatsApp).');
else { ok = false; console.error('✗ Claude Code: ' + code.error); }
console.log('\nRelay starts by itself when Claude needs it. To link WhatsApp, open http://127.0.0.1:' + cfg.port);
process.exit(ok ? 0 : 1);
