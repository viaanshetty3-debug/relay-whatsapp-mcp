"""Relay's Colab model server: a password-protected /chat endpoint in front of Ollama.

It answers in the same streaming format as Cloudflare Workers AI
(`data: {"response": "..."}` lines, then `data: [DONE]`), so the Relay help page can use it
like any other engine. Every request needs `Authorization: Bearer <RELAY_COLAB_KEY>`.
"""
import hmac
import json
import os

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse

KEY = os.environ["RELAY_COLAB_KEY"]
MODEL = os.environ.get("RELAY_MODEL", "qwen3.8:27b")
OLLAMA = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")
MAX_CHARS = 200_000  # the help page sends the docs plus one visitor's chat

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


def check(request: Request):
    given = request.headers.get("authorization", "").removeprefix("Bearer ")
    if not hmac.compare_digest(given.encode(), KEY.encode()):
        raise HTTPException(status_code=401, detail="Wrong key")


@app.get("/health")
async def health(request: Request):
    check(request)
    return {"ok": True, "model": MODEL}


@app.post("/chat")
async def chat(request: Request):
    check(request)
    body = await request.json()
    system = str(body.get("system", ""))
    messages = [
        {"role": "assistant" if m.get("role") == "assistant" else "user", "content": str(m.get("content", ""))}
        for m in body.get("messages", [])
        if isinstance(m, dict)
    ][-20:]
    if not messages or len(system) + sum(len(m["content"]) for m in messages) > MAX_CHARS:
        raise HTTPException(status_code=400, detail="Empty or too long")

    payload = {
        "model": MODEL,
        "messages": [{"role": "system", "content": system}, *messages],
        "stream": True,
        "think": False,  # answer directly: much faster for a help chat
        "options": {"temperature": 0.2, "num_predict": 800},
    }
    # Open the model's stream before answering, so a failure becomes an HTTP error the help page
    # can see (and hand the question to its next engine) instead of a half-sent answer.
    client = httpx.AsyncClient(timeout=httpx.Timeout(300, connect=10))
    res = await client.send(client.build_request("POST", OLLAMA + "/api/chat", json=payload), stream=True)
    if res.status_code != 200:
        await res.aclose(); await client.aclose()
        raise HTTPException(status_code=502, detail="The model returned an error")

    async def stream():
        try:
            async for line in res.aiter_lines():
                if not line.strip():
                    continue
                part = json.loads(line)
                text = (part.get("message") or {}).get("content") or ""
                if text:
                    yield "data: " + json.dumps({"response": text}) + "\n\n"
                if part.get("done"):
                    break
            yield "data: [DONE]\n\n"
        finally:
            await res.aclose(); await client.aclose()

    return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-store"})
