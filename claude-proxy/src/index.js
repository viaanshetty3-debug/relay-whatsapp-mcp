// Private forwarder: claude.ai custom connectors only allow approved header
// names (e.g. x-api-key). This Worker checks x-api-key, then forwards MCP
// requests to the private WhatsApp relay with its client key (and, optionally,
// a host access credential).
// Only MCP-relevant headers are forwarded; nothing is logged or stored.
const FORWARD_REQUEST_HEADERS = ['content-type', 'accept', 'mcp-protocol-version', 'mcp-session-id', 'last-event-id'];
const FORWARD_RESPONSE_HEADERS = ['content-type', 'mcp-session-id', 'cache-control'];

async function sameSecret(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || !expected) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([given, expected].map(v => crypto.subtle.digest('SHA-256', enc.encode(v))));
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

const json = (body, status) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/mcp') return json({ error: 'Not found' }, 404);
    if (!(await sameSecret(request.headers.get('x-api-key'), env.PROXY_KEY))) return json({ error: 'Unauthorized' }, 401);
    if (!env.CLIENT_KEY || !env.RELAY_URL) return json({ error: 'Forwarder is not configured' }, 500);
    const headers = new Headers();
    for (const name of FORWARD_REQUEST_HEADERS) { const v = request.headers.get(name); if (v !== null) headers.set(name, v); }
    // Optional: only relays hosted behind ChatGPT Sites need this host credential.
    if (env.SITE_KEY) headers.set('OAI-Sites-Authorization', 'Bearer ' + env.SITE_KEY);
    headers.set('X-Relay-Client-Key', env.CLIENT_KEY);
    const hasBody = !['GET', 'HEAD'].includes(request.method);
    const init = { method: request.method, headers, body: hasBody ? request.body : undefined, redirect: 'manual' };
    // A relay Worker on the same Cloudflare account must be reached through a
    // service binding (Workers can't fetch each other's workers.dev URLs).
    const upstream = await (env.RELAY ? env.RELAY.fetch(env.RELAY_URL, init) : fetch(env.RELAY_URL, init));
    const out = new Headers();
    for (const name of FORWARD_RESPONSE_HEADERS) { const v = upstream.headers.get(name); if (v !== null) out.set(name, v); }
    return new Response(upstream.body, { status: upstream.status, headers: out });
  },
};
