# Stable hosted WhatsApp plugin

This is the prepared deployment configuration, not an already deployed endpoint. It runs the complete WhatsApp connection on an always-on host. Your phone does not run a tunnel or keep Termux open after you link the hosted service.

## Railway deployment specification

The hosting account must be connected before a deployment can be created. Use its existing free allowance first. Do not upgrade or enable paid usage without the owner's explicit approval. Railway has usage-based charges and finite free credits; the code does not promise free hosting forever.

Deploy the project root as one Docker service with:

- `Dockerfile` and `railway.json` from this directory's parent.
- Exactly one replica and automatic restarts.
- A persistent volume mounted at `/data`. Attach it before linking WhatsApp. This stores WhatsApp credentials, SQLite history, OAuth clients, drafts and scheduled sends.
- An HTTPS Railway service domain on the app's assigned `PORT`.
- `BRIDGE_TOKEN`: a new randomly generated secret of at least 32 characters, supplied through hosting secrets. Do not put it in Git, ZIP files or chat.
- `NODE_ENV=production`, `HOST=0.0.0.0`, `DATA_DIR=/data`, `AUTO_CONNECT=true` (provided by the Docker image).
- `PUBLIC_URL` set to the service's HTTPS origin, or allow the app to use Railway's `RAILWAY_PUBLIC_DOMAIN` automatically.
- No scheduled sleeping or serverless mode: WhatsApp needs a continuous WebSocket connection.

Health checks use `GET /healthz`. It exposes only `{ "ok": true }`, not chat or account data. The standard Railway health-check Host is accepted only for that route. All dashboard administration still requires the owner token, and MCP still requires OAuth/bearer authentication.

After deployment, verify the health check, protected-resource metadata, OAuth issuer and MCP tool discovery. The actual MCP endpoint is the returned HTTPS origin plus `/mcp`; do not invent a hostname before the service provisions it.

## User connection

1. Open the deployed dashboard and sign in using the configured owner token.
2. Select **Connect WhatsApp** and link using a QR or phone code. Link this hosted service once. Do not run another copy with the same WhatsApp credential directory.
3. Add the deployed `/mcp` URL as a custom MCP plugin in ChatGPT, choose OAuth and automatic client registration, then authorize it on the bridge's own login page. Enable the plugin in the conversation.
4. Ask the plugin for its connection status and then a chat list. Verify write actions with a message that the owner explicitly chooses to send.

The hostname stays the same across ordinary app restarts and redeployments while that service and hostname remain assigned. The session is restored automatically only when saved registered credentials exist. A rejected or unlinked WhatsApp session still needs pairing again. No host or app can guarantee literal perpetual availability.

## Other persistent hosts

The Docker image can run on another always-on server with HTTPS termination and a persistent `/data` mount. Set `PUBLIC_URL` explicitly to that host's HTTPS origin, inject a secret `BRIDGE_TOKEN`, and route HTTPS to the container's `PORT`.

This app cannot run unchanged as a static website or request-only serverless function. Its WhatsApp WebSocket, scheduled sender, authentication files and SQLite database require a continuously running process and persistent storage.

## Validation limits

The deployment source is covered by configuration, authentication and session-restoration tests. A Docker daemon and a connected hosting account are required to build and verify the hosted container and actual public URL. Those checks must succeed before reporting the service as deployed.
