// Standalone Relay worker: the WhatsApp job queue on plain Cloudflare Workers + D1
// (free tier). The broker and queue protocol live in ./lib.
//
// Security: the shared broker treats the `oai-authenticated-user-email` header as
// a signed-in owner, which is only trustworthy behind ChatGPT Sites. On a plain
// Worker anyone could send it, so every `oai-*` header is stripped here and
// clients must present X-Relay-Client-Key.
import { WhatsAppBroker } from './lib/whatsapp-broker.mjs';
import tools from './lib/whatsapp-tools.json' with { type: 'json' };

export function withoutHostAuth(request) {
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) if (name.toLowerCase().startsWith('oai-')) headers.delete(name);
  return new Request(request, { headers });
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/' || path === '/health') return Response.json({ service: 'relay', ok: true }, { headers: { 'Cache-Control': 'no-store' } });
    const response = await new WhatsAppBroker(env, tools).handle(withoutHostAuth(request));
    return response || Response.json({ error: 'Not found' }, { status: 404 });
  },
};
