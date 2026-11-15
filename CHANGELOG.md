# Changelog

## 1.2.0 — 2026-11-15

### Added
- **Several accounts on one computer.** Up to five Relay accounts (for example Business and Private), each with its own WhatsApp profiles, messages, encryption key, owner token and AI-app approvals. Switch from the account menu without signing out. "Add to Claude Desktop" gives each account its own entry (`whatsapp`, `whatsapp-<email>`). Existing installs keep working: your account becomes the first one.
- **Use an account on another computer (optional, off by default).** Turn it on under Connections, then sign in on another computer with the same email and password. Your profile names and settings arrive, encrypted with a key made from your password that the Relay Accounts service never sees. WhatsApp itself is linked again on each computer with a QR code, and messages never leave your computers. See README and SECURITY.md.
- `RELAY_ACCOUNT` (set for you by "Add to Claude Desktop") tells the local adapter which account to use.
- **Encryption at rest.** Messages, chats, contacts, drafts, scheduled messages, your dashboard account and the WhatsApp session files are encrypted with AES-256-GCM, using a per-device key kept in the macOS Keychain or a private key file in your user profile (Windows, Linux, Termux). Phone numbers and group IDs are stored as keyed hashes. Existing data is converted automatically on first start. See SECURITY.md for exactly what this does and doesn't protect.
- `RELAY_ENCRYPTION=off` and `RELAY_DATA_KEY` settings.
- **One-click Claude setup.** "Add to Claude Desktop" and "Add to Claude Code" buttons in the dashboard, and `npx relay-whatsapp-mcp connect` in a terminal. No JSON editing; existing Claude settings are kept and backed up.
- **Help page: your own model on Colab.** `colab/Relay_model_on_Colab.ipynb` runs a model (Qwen 3.8 27B by default) on a Colab GPU; while it runs, the help page answers with it first and falls back to Gemini/Cloudflare when the session ends.
- **Relay starts itself.** When Claude Desktop or Claude Code needs Relay and it isn't running, the adapter starts it in the background (`RELAY_AUTOLAUNCH=off` to disable).

### Fixed
- @mentions in group chats show the person's name (saved contact name, else their WhatsApp profile name, else +phone) instead of WhatsApp's hidden ID number. Older messages are fixed on connect.

### Changed
- Sign-up no longer closes after the first account: on a local bridge, anyone using the computer can add an account of their own (it starts empty and can't see the others). Hosted bridges still require the owner token to create any account.
- A Google/GitHub sign-in that doesn't match an existing account is offered a new account instead of an error (hosted bridges still refuse it).
- Signing out signs out of the account in front; other accounts in the same browser stay signed in.
- "Registered AI clients" lists the clients the account in front approved. Revoking removes that account's access.
- **Practice mode starts unlinked.** `npx relay-whatsapp-mcp demo` now begins like a first run: create an account, click Connect WhatsApp, see a clearly labelled pretend QR code (nothing to scan), and the sample chats appear after a few seconds. `RELAY_DEMO_LINKED=1` restores the old always-connected demo.
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
