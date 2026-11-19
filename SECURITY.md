# Security

Relay gives an AI assistant access to a personal WhatsApp account. This document explains what protects that access, where your data lives, and what Relay **does not** protect against. It describes the code as it is; if you find a gap between this document and the code, please report it.

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Use GitHub's private vulnerability reporting (**Security → Report a vulnerability** on this repository). Include steps to reproduce and the affected component (bridge, relay, doorway, setup, auto-start). We aim to acknowledge reports within 7 days. This is a volunteer project with no bug bounty.

Supported version: the latest commit on `main`.

## Where your data and keys live

| Data | Where | Protection |
| --- | --- | --- |
| WhatsApp linked-device keys (Signal protocol session) | Each bridge's `data/auth/` | Never leave the device. **Encrypted at rest** (AES-256-GCM, see below) in private directories (mode `0700`; on Windows, your user-profile permissions). |
| Message history, contacts, chats, drafts, scheduled messages, dashboard account | Each bridge's `data/bridge.sqlite` | **Encrypted at rest** (see below). |
| Media cache, media-analysis results (transcripts, OCR) | Each bridge's `data/media-cache/`, `data/media-analysis/` | **Not encrypted yet**; private directories only. Use full-disk encryption. |
| `BRIDGE_TOKEN`, relay keys | `.env` (mode `0600`), Worker secrets | Never committed (`.gitignore`), never logged. |
| Queued AI requests and responses | Relay D1 database | AES-256-GCM, deleted after completion; expired jobs are purged within minutes. |

Each device is a **separate WhatsApp linked device** with its own keys. Relay never copies WhatsApp credentials between machines, and you can revoke any device from your phone under *WhatsApp → Linked devices*.

## Encryption at rest on each bridge

Since 1.2.0 each data folder has its own random 256-bit key, and Relay encrypts the WhatsApp session files and the message database with AES-256-GCM. Older plain data is converted automatically on first start, and the database is compacted so the old plain text isn't left in free space.

- **Where the key lives (never in the data folder):** macOS login Keychain; on Windows a file in `%LOCALAPPDATA%\relay-whatsapp-mcp\keys` that only your Windows account can open; on Linux and Termux a `0600` file in `~/.config/relay-whatsapp-mcp/keys/`. You can supply your own with `RELAY_DATA_KEY` (32 random bytes, base64), or turn encryption off with `RELAY_ENCRYPTION=off`. **Hosted containers** (`NODE_ENV=production`, Docker, Railway) are encrypted only when you set `RELAY_DATA_KEY` as a private hosting variable, because a generated key outside the data volume would be lost on the next deploy.
- **What's encrypted:** message text and details, chat and contact names, phone numbers and group IDs (stored as keyed hashes so lookups still work), drafts, scheduled messages, your dashboard account, and every WhatsApp session file.
- **What stays readable**, so the database can sort and filter: message timestamps, WhatsApp's random message IDs, message type (text, photo, call…), whether you sent it, whether it was deleted, and roughly how big each entry is. Someone with the file could see how many messages you have and when, not who they're with or what they say.
- **What it protects against:** a copied or backed-up data folder, a synced folder, or a disk read on another computer without your login.
- **What it doesn't protect against:** malware running as you, or someone signed in as you. They can ask the Keychain (or key file) for the key just as Relay does. On Windows, Linux and Termux the key file is only as safe as your user account. Keep full-disk encryption on.
- **Losing the key means losing the history** (the WhatsApp link can be redone with a new QR code). Relay never makes a new key over existing encrypted data: it stops with an error instead.
- Backups of `data/` made by an older Relay are still plain text. Delete them once you've checked the new version works.

## Encryption: what it covers, and what it doesn't

**This isn't end-to-end encryption between your AI app and your WhatsApp.** We use the term carefully:

1. **WhatsApp ↔ bridge.** WhatsApp's own end-to-end encryption (the Signal protocol) ends at your bridge, because the bridge *is* one of your linked devices. Messages are decrypted on hardware you control.
2. **In transit.** Every hop outside your computer uses HTTPS/TLS: AI app → doorway → relay, and bridge → relay. Bridges make **outbound connections only**, so no inbound port is opened on your network.
3. **At rest in the relay queue.** Each request and response is encrypted with **AES-256-GCM** using `WA_AGENT_KEY` (32 random bytes) and a fresh 96-bit IV. The job ID and direction are bound as additional authenticated data, so a ciphertext can't be replayed as a different job or turned from a request into a response.
4. **Not covered.**
   - The relay Worker holds `WA_AGENT_KEY` (it encrypts incoming requests and decrypts responses), so it handles **plaintext in memory** while processing them. Whoever controls your Cloudflare account, or the hosting platform, can in principle read requests.
   - The Claude doorway sees plaintext while forwarding.
   - **Your AI provider (Anthropic, OpenAI) receives whatever the AI reads through the tools.** That's how the assistant works, and it's governed by your provider's data policies.

## Authentication

- **Local bridge:** listens on `127.0.0.1` only by default. Dashboard and MCP calls need the owner `BRIDGE_TOKEN` (≥ 32 characters). If you expose it with `PUBLIC_URL`, it requires HTTPS and uses OAuth (authorization code + PKCE S256, single-use codes, rotating refresh tokens, owner consent).
- **Relay:** AI clients must present `X-Relay-Client-Key`. Bridges authenticate with `WA_AGENT_KEY`, and a second agent ID is refused while one is active. All secret comparisons hash both values with SHA-256 and compare in constant time.
- **No forgeable identity headers:** the broker can recognise a platform-signed owner header (`oai-authenticated-user-email`), which is only trustworthy behind ChatGPT Sites. `relay-worker/` **strips every `oai-*` header** before processing, so it can't be forged on a plain Worker (covered by a test).
- **Claude doorway:** checks `x-api-key` in constant time, reaches a same-account relay through a private service binding, accepts only the `/mcp` path, forwards only MCP headers (no cookies or other credentials), and returns only MCP response headers.
- **Setup:** keys come from `crypto.randomBytes(32)` and are written with mode `0600`. Answers that ask for keys are hidden as you type.

## Several accounts, and account sync

- **Accounts on one computer are separated inside Relay, not from the computer's user.** Each account has its own folder, database, encryption key, owner token and sessions, and every dashboard, tool and MCP request is tied to exactly one account. This stops one account's sign-in or AI client from reaching another account. It does not protect accounts from someone who can already read your files as your operating-system user.
- **Accounts made with a sign-in provider use a passcode.** Google, Microsoft, GitHub or Facebook confirms the email, and Relay stores the provider's account id, your name and email: no country or phone. A provider sign-in alone opens nothing: the session stays locked, and reaches no chats, tools or settings, until the account's passcode is entered (chosen on the first sign-in, at least 8 characters, stored as a salted scrypt hash). Ten wrong tries lock sign-in for 15 minutes. On a local bridge any provider account can create its own empty account (as any email can); on a hosted bridge creating an account still needs the owner token.
- **Idle lock.** The dashboard locks its session on the server after 15 minutes without input and asks for the password or passcode again. Sessions opened with the owner token are not affected.
- **A short passcode is weaker than a password where it matters most.** It also locks that account's synced copy, if sync is on. Someone who stole the Relay Accounts service's storage could try passcodes offline; scrypt slows this, but an 8-character passcode is far easier to guess than a 12-character password with mixed characters. Choose a longer passcode if you turn sync on.
- **Account sync is optional and off by default.** When on, the Relay Accounts service stores, under a one-way hash of your email: a SHA-256 hash of a sign-in key, a random salt, and one blob encrypted with AES-256-GCM. Both keys come from your password through scrypt on your computer. The blob holds your name, country, phone number, WhatsApp profile names and which AI apps you set up. It never holds a WhatsApp session, a message, a contact or a token.
- **What the service operator could do.** The operator can't read the blob without your password. Like any service that stores password-derived hashes, an operator (or someone who stole the service's storage) could try guessing weak passwords offline; Relay's 12-character rule and scrypt make that expensive, and a strong unique password makes it impractical. The operator can also see when an account syncs and from which network address, and could delete or withhold the blob.
- **Sign-in on a new computer** sends the email address and the derived sign-in key to the service, never the password. Ten wrong keys lock that account's sync sign-in for an hour. An email with no synced account gets a made-up salt and the same error, so the service can't be used to check who has an account.
- **Your bridge keeps the two keys** in its (encrypted at rest) database so it can sync changes. Anyone who can already read that database has the account's data anyway.
- **Turning sync off** deletes the service's copy. Other computers keep their local accounts.

## Prompt-injection safeguards

Anyone who can message you can put text in front of your AI. Relay treats all WhatsApp content (message text, captions, file names, documents, transcripts, contact and group names) as **untrusted data**:

- **Server instructions.** Every MCP endpoint (local stdio, the bridge's HTTP MCP, the relay) sends instructions to the client saying that WhatsApp content is untrusted data, that instructions inside messages, attachments or contact names must not be followed, and that messages may be sent or changed only at the user's request.
- **Labelled results.** Attachment and analysis results carry an explicit untrusted-content note, and the `whatsapp://recent` resource is described as untrusted.
- **Explicit, validated actions.** Nothing is sent as a side effect of reading. Every write is a separate tool call validated with a schema (zod), and tools carry MCP `readOnlyHint`/`destructiveHint` annotations so clients can ask you before destructive actions.
- **Least privilege.** `READ_ONLY=true` blocks every outgoing action, draft change and schedule. `ALLOWED_CHATS` limits which chats exist as far as the AI is concerned. Reading never sends read receipts.
- **No autonomous loop.** Relay never runs an AI on its own or auto-replies. Tools run only when your AI client calls them during a conversation you started.

**Limits:** these safeguards *reduce* risk; they can't guarantee a model will ignore a cleverly written message. Keep your AI client's tool-approval prompts on for write actions, consider `READ_ONLY=true` for read-only use, and review anything an AI proposes to send.

## Write safety (no duplicate sends)

- Queued jobs are claimed atomically by exactly one device.
- Only read-only jobs are handed to another device when the claiming device goes silent. **Writes are never re-queued or retried automatically.** A timed-out write is reported as *may have executed*.
- A response from a device that no longer owns a job is rejected.
- `send_message` supports a client `requestId` for de-duplication. Interrupted scheduled sends become *uncertain* and are not retried.

## Hardening checklist

- Turn on full-disk encryption on every bridge machine (FileVault, LUKS, BitLocker). Relay's own encryption covers the database and session, not the media cache.
- Keep `.env`, `data/` and `*.secrets.json` out of backups you don't control. Never commit them.
- Rotate keys if one may have leaked: re-run `npm run setup` (a new `.env` with new keys), re-upload the Worker secrets, and update your AI connectors.
- Remove unused linked devices from WhatsApp.
- Relay uses an unofficial WhatsApp client (Baileys). WhatsApp may restrict accounts that behave like bots. Use it for normal personal conversations.
