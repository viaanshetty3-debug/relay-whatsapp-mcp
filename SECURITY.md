# Security

Relay gives an AI assistant access to a personal WhatsApp account. This document explains what protects that access, where your data lives, and what Relay **does not** protect against. It describes the code as it is; if you find a gap between this document and the code, please report it.

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Use GitHub's private vulnerability reporting (**Security → Report a vulnerability** on this repository). Include steps to reproduce and the affected component (bridge, relay, doorway, setup, auto-start). We aim to acknowledge reports within 7 days. This is a volunteer project with no bug bounty.

Supported version: the latest commit on `main`.

## Where your data and keys live

| Data | Where | Protection |
| --- | --- | --- |
| WhatsApp linked-device keys (Signal protocol session) | Each bridge's `data/auth/` | Never leave the device. Kept in private directories (mode `0700`; on Windows, protected by your user-profile permissions). Not encrypted at rest by Relay; use full-disk encryption. |
| Message history, media cache | Each bridge's `data/` (SQLite) | Same as above. |
| `BRIDGE_TOKEN`, relay keys | `.env` (mode `0600`), Worker secrets | Never committed (`.gitignore`), never logged. |
| Queued AI requests and responses | Relay D1 database | AES-256-GCM, deleted after completion; expired jobs are purged within minutes. |

Each device is a **separate WhatsApp linked device** with its own keys. Relay never copies WhatsApp credentials between machines, and you can revoke any device from your phone under *WhatsApp → Linked devices*.

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

- Turn on full-disk encryption on every bridge machine (FileVault, LUKS, BitLocker).
- Keep `.env`, `data/` and `*.secrets.json` out of backups you don't control. Never commit them.
- Rotate keys if one may have leaked: re-run `npm run setup` (a new `.env` with new keys), re-upload the Worker secrets, and update your AI connectors.
- Remove unused linked devices from WhatsApp.
- Relay uses an unofficial WhatsApp client (Baileys). WhatsApp may restrict accounts that behave like bots. Use it for normal personal conversations.
