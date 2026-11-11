# RelayHost: HTTPS on your own server

This deployment runs the existing WhatsApp web app on a computer you control, with automatic HTTPS certificates, renewal, restarts and persistent data. Railway, Cloudflare Tunnel and a hosting subscription are not used by this setup. Caddy handles certificates; Docker runs the app. Internet access, hardware and a public domain must already be available.

**No public URL has been provisioned by adding these files.** You need an internet-reachable Linux server with Docker Compose, a domain whose DNS points to that server, and inbound ports 80 and 443 available. A phone behind a private network does not acquire a public address from installing this tool. Certificate issuance also requires successful validation by a public certificate authority.

## Operator workflow

The operator or assistant runs these on the actual public server, from the project root:

```sh
node scripts/self-host.mjs setup --domain relay.yourdomain.com --email you@yourdomain.com
node scripts/self-host.mjs start
```

Setup creates private `deploy/selfhost.env` with the domain, certificate contact email and a new owner token. Repeating setup refuses to overwrite the existing file, protecting the login token and domain configuration. It never embeds credentials into source or a source archive. The app and HTTPS certificate files are stored in separate persistent Docker volumes.

The management tool supports `status`, `logs`, and `stop`. Stopping preserves all volumes. Restarting uses `start` and resumes an already registered WhatsApp session. A restart after a deliberate stop does not change the domain or owner token. Keep exactly one deployment using the same WhatsApp authentication files.

Only the HTTPS proxy exposes ports to the internet. The app's port 8787 is internal to Docker. Existing app OAuth and dashboard owner authentication remain in force.

## Connect the app

After the service is running, verify `https://YOUR_DOMAIN/healthz`, OAuth metadata, and protected MCP access before calling it live. Open the HTTPS dashboard, sign in with the generated owner token, and link WhatsApp. Add `https://YOUR_DOMAIN/mcp` as the custom MCP endpoint in the AI client, using the existing OAuth flow.

The address remains tied to your DNS and server. The server, internet connection, domain and certificates must remain operational. The management software cannot guarantee perpetual hosting or invent a public server or domain.

## Verification on this development device

Configuration generation, validation, secret-file creation and command construction can be tested here. This Android environment has no running Docker daemon and no supplied public server or domain. Container execution, certificate issuance, renewal and public AI-client connectivity must be verified on the selected server.

Caddy requirements: https://caddyserver.com/docs/automatic-https
