# Relay AI (docs assistant)

A free question-and-answer page about Relay, running on Cloudflare Workers AI.

- No API key or login for visitors.
- Each visitor's conversation is stored only in their own browser (`localStorage`) and sent with each question. The Worker stores no chats and logs no message text. **New chat** clears it.
- Answers are grounded in `README.md`, `SECURITY.md` and `server.json`, fetched from the repo's `main` branch and cached for 10 minutes.
- Limits: 30 questions per hour and 10 per day per IP address, and 30 per day for the whole site. That matches Workers AI's free 10,000 neurons per day (about 300 neurons per answer with `llama-3.3-70b-instruct-fp8-fast`). Counters live in a Durable Object keyed by a SHA-256 hash of the IP, and they're deleted at the end of each UTC day. On the Workers Free plan, going over the AI allowance can't cost money; the AI just stops answering until 00:00 UTC.

Deploy your own copy (Workers Free plan is enough):

```bash
cd docs-ai-worker
npx wrangler deploy
```

Change `DOCS_BASE` in `wrangler.toml` to point at your fork, and adjust the limits there. Tests: `npm test` in the repo root (`test/docs-ai-worker.test.js`).
