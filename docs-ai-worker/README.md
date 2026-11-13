# Relay Help (troubleshooting + Relay AI)

A free help page for Relay: a troubleshooting guide plus an openable **Ask Relay AI** sidebar, running on Cloudflare Workers AI. Live at https://relay-docs-ai.viaan-mcp.workers.dev.

- **Troubleshooting:** built live from the README's Troubleshooting table, so it never goes out of date. You can filter the list, and each problem has an "Ask Relay AI about this" button.
- **No key or login:** every visitor gets their own private chat. It's stored only in their browser (`localStorage`) and sent with each question. The Worker stores no chats and logs no message text. **New chat** clears it.
- **Grounded answers:** answers come from `README.md`, `SECURITY.md` and `server.json`, fetched from `main` and cached for 10 minutes. The model is `@cf/google/gemma-4-26b-a4b-it`, at about 90–100 neurons per answer.
- **Always answers:** Workers AI Free includes 10,000 neurons a day, about 100 AI answers. When that runs out (it resets at 00:00 UTC), or when one network asks more than 30 questions in an hour, the chat answers from a search of the docs instead. That has no limit and never shows an error. On the Workers Free plan, nothing here can cost money.
- **Rate-limit counters:** they live in a Durable Object keyed by a SHA-256 hash of the IP address, and they're deleted at the end of each UTC day.

Deploy your own copy (the Workers Free plan is enough):

```bash
cd docs-ai-worker
npx wrangler deploy
```

Point `DOCS_BASE` in `wrangler.toml` at your fork. Tests are in `test/docs-ai-worker.test.js`; run `npm test` from the repo root.
