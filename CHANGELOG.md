# Changelog

## 1.1.0 — 2026-11-13

### Added
- **Accounts for the dashboard.** Create an account with your name, country, phone, email (confirmed with a 6-digit emailed code) and a strong password, or sign up with Google or GitHub. No more pasting the owner token (it still works for local MCP clients and as a recovery sign-in).
- **Relay Accounts service** (`accounts-worker/`): emails the codes and runs the sign-in buttons for every install, so there's nothing to set up. It stores no accounts and never sees your password; turn it off with `RELAY_ACCOUNTS_URL=off` and use your own SMTP server or OAuth apps instead.
- **Several WhatsApp profiles in one Relay** (up to 10), each its own linked device with its own data. One AI connection reaches all of them: every tool takes an optional `profile`, and the new `list_profiles` tool lists them (38 tools).
- `npx relay-whatsapp-mcp` with no command starts Relay and opens the dashboard in your browser.

### Changed
- Email codes: one per 30 s and five per hour per purpose; five wrong guesses void a code.
- The hosted relay's tool catalog includes the `profile` argument (`scripts/tool-catalog.mjs` keeps it in step).
- Setup no longer asks for a Gmail app password.

### Fixed
- Sign-up no longer offers an email form when codes can't be sent.
- Hosted bridges can sign up with Google or GitHub.
- Behind a hosting proxy, rate limits use the visitor's address.

## 1.0.0 — 2026-11-12

First release: 37 MCP tools, self-hosted bridge, optional Cloudflare relay and doorway, primary/standby failover.
