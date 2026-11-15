# Relay accounts that follow you (design)

**Status (2026-11-15):** built in `src/spaces.js`, `src/cloud.js`, `src/accounts.js`, `src/oauth.js` and `accounts-worker/`, with tests in `test/multi-account.test.js` and `test/accounts-worker.test.js`. Not released. The service side (`accounts-worker/`) is **not deployed yet**, so sync can't be turned on against the live service until it is.

Decisions taken while building: the service stores hashes of password-derived keys (needed to sign in on a new computer); there is no email-only password reset for the synced copy (a computer that still has the account re-locks it; otherwise the owner replaces it after proving the email); turning sync off deletes the service's copy.

## What the user wants
- A person signs in to **one Relay account** (for example "Business"). That account has its own WhatsApp connections, Claude connections and ChatGPT connections.
- Signing in to the same account on **another laptop** brings those connections along.
- One laptop can hold **two accounts** (for example "Business" and "Private"), each with different WhatsApp, Claude and ChatGPT connections, and the person can sign in to both and switch.

## What can and cannot be synced (honest limits)
| Thing | Can it sync? | How |
|---|---|---|
| Account identity (email, name) | Yes | Cloud accounts service |
| Settings: profile names, which chats the AI may see, read-only mode, which AI apps are set up | Yes | End-to-end encrypted blob stored in the cloud; the server can't read it |
| **The WhatsApp link itself (session files)** | **No** | Copying session files to a second computer breaks WhatsApp's link for both. Each laptop links itself once as its own "linked device" (one QR scan; WhatsApp allows several). The synced settings tell Relay which profiles to set up, so the second laptop only needs the scan. |
| Message history | **No, by design** | It stays encrypted on each computer. Relay's promise is that your chats stay on your computers. |
| Claude Desktop / Claude Code setup | Per computer | After sign-in, Relay offers one click: "Add to Claude Desktop on this computer". |
| ChatGPT connector | Lives in the user's ChatGPT account | Already follows them. Relay only shows the address to paste. |

## Phases
**Phase 1: two accounts on one laptop (local only, no cloud).**
Each account gets its own folder, its own encryption key, its own WhatsApp profiles and its own AI-app settings. The dashboard gets an account switcher. Nothing about one account is visible from the other. Fully testable on one machine.

**Phase 2: sign in on another laptop (cloud).**
Add to the existing accounts Worker: email + password sign-in (password stored only as a slow salted hash), rate limiting, email verification, and encrypted settings sync. The key that encrypts the settings is derived from the password on the device, so the cloud never sees it.

**Phase 3: guided setup on the new laptop.**
After sign-in the dashboard lists the profiles from the account and walks through "scan this QR on your phone" for each, plus the Claude one-click.

## Rules this must keep
- Never copy WhatsApp session files between computers.
- One account never sees another account's chats, settings or keys.
- The cloud stores no messages, no WhatsApp keys and no readable settings.
- Changing the live accounts Worker needs the owner's OK each time.

## Questions asked before Phase 2 (answered above)
1. Is it OK to store password hashes in the cloud accounts service? (Needed for email + password on a new laptop. Google or GitHub sign-in avoids passwords but still needs the service.)
2. Password reset by email: yes or no? (Without it, a forgotten password means the synced settings are lost, because only the password unlocks them.)
3. Account deletion: a "delete my cloud data" button, yes or no? (Strongly recommended.)

## Tests planned
Two accounts isolated on one data folder; wrong password rejected and rate limited; settings blob unreadable without the password; second laptop receives profile names but no session files; deleting an account removes its cloud data.
