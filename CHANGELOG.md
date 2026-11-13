# Changelog

## Unreleased

### Added
- **Encryption at rest.** Messages, chats, contacts, drafts, scheduled messages, your dashboard account and the WhatsApp session files are encrypted with AES-256-GCM, using a per-device key kept in the macOS Keychain or a private key file in your user profile (Windows, Linux, Termux). Phone numbers and group IDs are stored as keyed hashes. Existing data is converted automatically on first start. See SECURITY.md for exactly what this does and doesn't protect.
- `RELAY_ENCRYPTION=off` and `RELAY_DATA_KEY` settings.
- **One-click Claude setup.** "Add to Claude Desktop" and "Add to Claude Code" buttons in the dashboard, and `npx relay-whatsapp-mcp connect` in a terminal. No JSON editing; existing Claude settings are kept and backed up.
- **Help page: your own model on Colab.** `colab/Relay_model_on_Colab.ipynb` runs a model (Qwen 3.8 27B by default) on a Colab GPU; while it runs, the help page answers with it first and falls back to Gemini/Cloudflare when the session ends.
- **Relay starts itself.** When Claude Desktop or Claude Code needs Relay and it isn't running, the adapter starts it in the background (`RELAY_AUTOLAUNCH=off` to disable).

### Changed
- The local adapter reports Relay's real version (it said 1.1.0).
- "Transfer WhatsApp from Phone" carries an encrypted session's key and stores it in the Mac's Keychain.

## 1.1.1 — 2026-11-13

### Added
- **Call logs.** Voice and video calls (missed, declined, answered with their length) appear in the chat and in `get_messages` as `kind: "call"` entries. Calls are captured from the moment you update.
- **Voice-note summaries.** `analyze_media` has a `summarize` mode (transcribe, then summarize with a local model).
- **Load older messages** button in the dashboard asks your phone for earlier history.

### Fixed
- Chats split by WhatsApp's hidden IDs (`@lid`) are merged into one chat under the phone number and contact name; existing split chats are repaired on start.
- Dates showing "Invalid Date" for some chats.
- People not in your contacts show as +number instead of a long ID.
- Edited messages (`secretEncryptedMessage`) are decrypted and applied instead of showing as a separate unreadable message.

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
