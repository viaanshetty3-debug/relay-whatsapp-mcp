## What does this change?

## How was it tested?
<!-- Paste the summary lines of: npm run lint, npm test, (cd relay-worker && npm test), (cd claude-proxy && npm test). Say which OS you tried it on. -->

## Checklist
- [ ] No secrets, `.env` contents, phone numbers or real messages in the diff
- [ ] Writes (send/edit/delete/…) are never retried or re-queued automatically
- [ ] WhatsApp content is still treated as untrusted data
- [ ] Docs updated (README tool table, if a tool changed)
