# Your own model on Google Colab (optional)

`Relay_model_on_Colab.ipynb` runs **Qwen 3.8 27B** (any Ollama model works: change `MODEL`) on a Colab GPU and
lets the Relay help page answer with it. While the notebook runs, the help page asks your model first; when the
Colab session ends, it automatically uses Gemini, Claude or Cloudflare Workers AI again. Nothing breaks.

**How it fits together**

```
help page Worker ──(your password)──▶ https://….trycloudflare.com ──▶ relay_colab_server.py ──▶ Ollama on the GPU
        ▲                                                                                  │
        └─────────── the notebook checks in every 2 minutes with its current address ◀─────┘
```

- `relay_colab_server.py` answers only requests carrying your password, and streams in the same format as
  Workers AI. It keeps no chats.
- The help page accepts an address only from someone with the password, only `https://….trycloudflare.com`,
  and only while it keeps checking in (5 minutes). Stopping the last cell removes it straight away.

**Set up (once)**
1. Make a long password and give it to the help page (it is never printed):
   `openssl rand -base64 32 | pbcopy`, then in `docs-ai-worker/`: `pbpaste | npx wrangler secret put COLAB_KEY`
2. In Colab: open the notebook, *Runtime → Change runtime type → L4 or A100 GPU*, and add a Colab secret named
   `RELAY_COLAB_KEY` with the same password (paste it, then clear your clipboard).
3. *Runtime → Run all.*

**Good to know**
- Colab sessions end when idle and after a time limit, and use your plan's compute units while running.
  Follow Colab's terms of use. The help page doesn't depend on the notebook: it just falls back.
- 27B needs about 20 GB of GPU memory. On a T4 (16 GB) it runs partly on the CPU and is slow.
