# Contributing to Relay

Thanks for helping! Relay touches people's private messages, so we care most about **safety, honesty and not breaking anyone's WhatsApp session**. This guide explains how to get set up and what reviewers will look for.

## Ground rules

1. **Never commit secrets or personal data.** No `.env`, `data/`, `*.secrets.json`, WhatsApp IDs, phone numbers or screenshots of real chats. Use the fixtures in `test/` (for example `15550100001@s.whatsapp.net`).
2. **Writes are never retried automatically.** Any change that could resend, re-edit or re-delete a message after a timeout, crash or failover will be rejected. Only read-only work may be re-queued (see `READ_ONLY_TOOLS` in `relay-worker/src/lib/whatsapp-broker.mjs`).
3. **WhatsApp content is untrusted data.** Never feed message text into anything that acts on it (prompts, shell commands, file paths, URLs) without treating it as data. New tools that return WhatsApp content should keep the untrusted-data labelling.
4. **One WhatsApp session per device.** Don't add features that copy `data/auth` between machines.
5. **Be honest in docs and messages.** Don't claim more than the code does (for example "delivered" when WhatsApp only accepted the message).

## Development setup

```sh
git clone https://github.com/<you>/relay.git && cd relay
npm install
npm run demo          # dashboard with demo data on http://127.0.0.1:8787; never contacts WhatsApp
```

To try it with a real account, run `npm run setup` and then `npm start`. Use a **test WhatsApp account** where you can, because the client is unofficial and accounts can be restricted.

Requirements: Node.js 22.13+ (uses the built-in `node:sqlite`, `node:test` and `process.loadEnvFile`). Python 3 is optional, for local media analysis.

## Tests

```sh
npm test                                    # bridge, relay broker, failover, setup, auto-start
(cd relay-worker && npm test)               # standalone relay worker
(cd claude-proxy && npm test)               # Claude doorway
python3 -I -m unittest discover -s test     # optional: media worker + session transfer helpers
```

Every behaviour change needs a test. In particular:
- **Relay/failover changes:** add a case to `test/remote-relay.test.js`. Its fixtures use an in-memory SQLite database that mimics D1, plus a controllable clock, so failover timing tests run in milliseconds.
- **New tools:** add them to `src/tools.js` (schema, `write`/`destructive` flags), add the same name and JSON schema to `relay-worker/src/lib/whatsapp-tools.json` (the relay's catalog), update the tool count in `test/remote-relay.test.js`, and add a row to the tool table in `README.md`.
- **Read-only tools:** if the new tool only reads, add it to `READ_ONLY_TOOLS` so it can be handed over during failover. If it changes *anything*, don't.
- **Setup/auto-start:** `test/setup.test.js` runs setup end to end in a temporary folder and renders every template. Linux and Windows changes should be checked on a real machine too; say in the PR what you tested on.

## Project map

| Path | What |
| --- | --- |
| `src/whatsapp.js` | Baileys session, history sync, live events |
| `src/store.js` | SQLite history, durable event cursor, drafts, scheduled jobs |
| `src/tools.js` | the 37 MCP tools (validated with zod) and the scheduler |
| `src/server.js`, `src/oauth.js` | dashboard API, HTTP MCP, OAuth for public deployments |
| `src/stdio.js` | local MCP adapter for Claude Desktop / Claude Code |
| `src/remote-agent.js` | outbound relay agent: polling, failover roles, read handoff |
| `relay-worker/` | hosted relay: Cloudflare Worker + D1; `src/lib/` has the broker and AES-GCM queue protocol |
| `claude-proxy/` | Cloudflare Worker doorway for claude.ai (`x-api-key`) |
| `setup.mjs`, `scripts/` | setup, service runner, auto-start (`macos/`, `linux/`, `windows/`) |
| `*.command`, `scripts/*.py` | older macOS/Termux helpers; prefer the Node scripts for new work |

## Code style

- Plain ES modules, no build step for the bridge. Keep dependencies minimal. Every new dependency is attack surface on a machine holding WhatsApp keys.
- Match the style of the file you're editing.
- Error messages should say what to do next ("Start the WhatsApp bridge first…").
- Cross-platform: use `node:path`, never shell out to Bash from Node, and test paths with spaces.

## Pull requests

1. Fork, create a branch, and keep each PR focused on one change.
2. Run all the test commands above and paste the summary lines into the PR.
3. Describe user-visible changes and any effect on security, failover or free-tier usage (requests or D1 writes per day).
4. For security issues, **don't open a PR or issue**. Follow [SECURITY.md](SECURITY.md).

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).

## Code of conduct

Be kind and constructive, and assume good intent. Harassment or personal attacks aren't tolerated; maintainers may remove comments or contributors who don't follow this.
