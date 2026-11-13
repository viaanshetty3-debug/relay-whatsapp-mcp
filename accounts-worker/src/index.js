// Relay Accounts: one shared service for every Relay install, so nobody has to set up email or
// OAuth apps themselves.
//
//  • POST /email/code       sends a 5-digit sign-up / password-reset code from the owner's Gmail
//                            (Gmail API), with per-recipient, per-network and daily limits.
//  • GET  /oauth/start      "Sign in with Google / Microsoft / GitHub / Facebook" for a Relay bridge.
//  • GET  /callback/:p      finishes the provider sign-in and sends the bridge a short-lived,
//                            Ed25519-signed assertion (the bridge checks it with a built-in public key).
//  • GET  /admin/gmail/start  the owner connects the Gmail account that sends the codes (once).
//
// It stores no accounts: only rate-limit counters (deleted daily) and the Gmail refresh token.
import { PROVIDERS } from '../../src/providers.js';

const HOUR = 3600000, DAY = 24 * HOUR;
const ASSERTION_TTL = 5 * 60000, STATE_TTL = 15 * 60000;
const enc = new TextEncoder(), dec = new TextDecoder();
const b64u = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - String(s).length % 4) % 4)), c => c.charCodeAt(0));
const SECURITY = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', ...SECURITY } });
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const page = (title, body, status = 200) => new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title><body style="font:15px system-ui;max-width:520px;margin:12vh auto;padding:0 20px;color:#192c29"><h1 style="font-size:24px">${esc(title)}</h1><p>${body}</p></body>`, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'", ...SECURITY } });

// ---------- keys ----------
// ACCOUNTS_SIGNING_KEY: Ed25519 private key (PKCS#8, base64url). STATE_KEY: 32 random bytes (base64url).
const keyCache = new Map();
async function signingKey(env) {
  if (!keyCache.has('sign')) keyCache.set('sign', await crypto.subtle.importKey('pkcs8', unb64u(env.ACCOUNTS_SIGNING_KEY), { name: 'Ed25519' }, false, ['sign']));
  return keyCache.get('sign');
}
async function stateKey(env) {
  if (!keyCache.has('state')) keyCache.set('state', await crypto.subtle.importKey('raw', unb64u(env.STATE_KEY), 'AES-GCM', false, ['encrypt', 'decrypt']));
  return keyCache.get('state');
}
export const resetKeys = () => keyCache.clear();

// OAuth state is encrypted, so the provider and the browser can't read or change it.
async function sealState(env, data) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const box = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await stateKey(env), enc.encode(JSON.stringify({ ...data, exp: Date.now() + STATE_TTL })));
  return b64u(iv) + '.' + b64u(box);
}
async function openState(env, sealed) {
  try {
    const [iv, box] = String(sealed || '').split('.');
    const data = JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(iv) }, await stateKey(env), unb64u(box))));
    return data.exp > Date.now() ? data : null;
  } catch { return null; }
}

export async function signAssertion(env, claims) {
  const payload = b64u(enc.encode(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, await signingKey(env), enc.encode(payload));
  return payload + '.' + b64u(sig);
}

// Where a bridge may ask to be sent back to: its own /auth/broker/callback, on localhost or HTTPS.
export function validReturnTo(value) {
  try {
    const u = new URL(value);
    if (u.pathname !== '/auth/broker/callback' || u.search || u.hash || u.username || u.password) return false;
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname));
  } catch { return false; }
}

const providerConfig = (env, id) => {
  const up = id.toUpperCase(), clientId = env[`${up}_CLIENT_ID`], clientSecret = env[`${up}_CLIENT_SECRET`];
  return PROVIDERS[id] && clientId && clientSecret ? { ...PROVIDERS[id], clientId, clientSecret } : null;
};
const enabled = env => Object.keys(PROVIDERS).filter(id => providerConfig(env, id));

// ---------- rate limits and the Gmail token (Durable Object) ----------
export class AccountsStore {
  constructor(state) { this.storage = state.storage; }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/gmail') {
      if (request.method === 'PUT') { await this.storage.put('gmail', await request.json()); return json({ ok: true }); }
      return json((await this.storage.get('gmail')) || null);
    }
    // POST /limit {limits:[{name,max,ms}]}: fixed windows, all-or-nothing.
    const { limits, now = Date.now() } = await request.json();
    const saved = (await this.storage.get('windows')) || {}, windows = {};
    for (const { name, ms } of limits) {
      const bucket = Math.floor(now / ms);
      windows[name] = saved[name]?.bucket === bucket ? saved[name] : { bucket, count: 0 };
    }
    const blocked = limits.find(({ name, max }) => windows[name].count >= max);
    if (blocked) return json({ ok: false, retryAfter: Math.ceil(((windows[blocked.name].bucket + 1) * blocked.ms - now) / 1000) });
    for (const { name } of limits) windows[name].count++;
    await this.storage.put('windows', { ...saved, ...windows });
    await this.storage.setAlarm((Math.floor(now / DAY) + 1) * DAY);
    return json({ ok: true });
  }
  async alarm() { await this.storage.delete('windows'); } // counters only; the Gmail token stays
}

const store = (env, name) => env.STORE.get(env.STORE.idFromName(name));
async function hash(s) { return b64u(await crypto.subtle.digest('SHA-256', enc.encode(String(s).toLowerCase()))); }
async function limit(env, name, limits) {
  const res = await store(env, name).fetch('https://store/limit', { method: 'POST', body: JSON.stringify({ limits }) });
  return res.json();
}

// ---------- Gmail ----------
async function gmailAccessToken(env, fetchImpl) {
  const saved = await (await store(env, 'vault').fetch('https://store/gmail')).json();
  if (!saved?.refresh_token) throw new Error('Gmail is not connected');
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: saved.refresh_token, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET }),
  });
  if (!res.ok) throw new Error(`Gmail token: HTTP ${res.status}`);
  return (await res.json()).access_token;
}

export function codeEmail({ from, to, code, purpose }) {
  const action = purpose === 'reset' ? 'reset your Relay password' : 'confirm your email for Relay';
  const text = `Your Relay code is ${code}\r\n\r\nUse it to ${action}. It expires in 10 minutes.\r\n\r\nIf you didn't ask for this code, you can ignore this email. Relay is an open-source WhatsApp bridge: https://github.com/viaanshetty3-debug/relay-whatsapp-mcp\r\n`;
  const mime = [`From: Relay <${from}>`, `To: ${to}`, `Subject: Your Relay code: ${code}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit', '', text].join('\r\n');
  return b64u(enc.encode(mime));
}

async function sendCode(request, env, fetchImpl) {
  let body; try { body = await request.json(); } catch { return json({ error: 'Send JSON.' }, 400); }
  const to = String(body?.to || '').trim().toLowerCase(), code = String(body?.code || ''), purpose = body?.purpose === 'reset' ? 'reset' : 'verify';
  if (to.length > 254 || !/^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]{2,}$/.test(to)) return json({ error: 'Invalid email address.' }, 400);
  if (!/^\d{5}$/.test(code)) return json({ error: 'Invalid code.' }, 400);
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  for (const [name, limits] of [
    ['to:' + await hash(to), [{ name: 'hour', max: 5, ms: HOUR }, { name: 'day', max: 15, ms: DAY }]],
    ['ip:' + await hash(ip), [{ name: 'hour', max: 20, ms: HOUR }]],
    ['global', [{ name: 'day', max: Number(env.DAILY_EMAIL_LIMIT || 450), ms: DAY }]],
  ]) {
    const r = await limit(env, name, limits);
    if (!r.ok) return json({ error: 'Too many codes were sent. Try again later.', retryAfter: r.retryAfter }, 429);
  }
  try {
    const token = await gmailAccessToken(env, fetchImpl);
    const res = await fetchImpl('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: codeEmail({ from: env.SENDER_EMAIL, to, code, purpose }) }),
    });
    if (!res.ok) throw new Error(`Gmail send: HTTP ${res.status}`);
    return json({ ok: true });
  } catch (error) {
    console.error('Email error:', String(error?.message || error).slice(0, 200)); // never logs the address or code
    return json({ error: 'The code could not be sent. Try again in a minute.' }, 502);
  }
}

// ---------- sign-in providers ----------
async function oauthStart(url, env) {
  const provider = url.searchParams.get('provider'), returnTo = url.searchParams.get('return_to'), nonce = url.searchParams.get('nonce') || '';
  const p = providerConfig(env, provider || '');
  if (!p) return page('Sign-in option not available', 'That sign-in option is not set up yet.', 404);
  if (!validReturnTo(returnTo) || !/^[\w-]{20,100}$/.test(nonce)) return page('Invalid sign-in request', 'Start again from your Relay dashboard.', 400);
  const state = await sealState(env, { provider, returnTo, nonce });
  const auth = new URL(p.authorize);
  auth.search = new URLSearchParams({
    client_id: p.clientId, redirect_uri: `${url.origin}/callback/${provider}`, response_type: 'code', scope: p.scope, state,
    ...(provider === 'google' ? { prompt: 'select_account' } : {}),
  }).toString();
  return Response.redirect(auth.href, 302);
}

async function oauthCallback(url, env, provider, fetchImpl) {
  const state = await openState(env, url.searchParams.get('state'));
  if (!state || state.provider !== provider || state.admin) return page('Sign-in expired', 'Start again from your Relay dashboard.', 400);
  const back = params => { const to = new URL(state.returnTo); to.search = new URLSearchParams(params).toString(); return Response.redirect(to.href, 302); };
  const p = providerConfig(env, provider);
  if (!p || !url.searchParams.get('code')) return back({ error: 'Sign-in was cancelled.' });
  try {
    const tokenRes = await fetchImpl(p.token, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: url.searchParams.get('code'), redirect_uri: `${url.origin}/callback/${provider}`, client_id: p.clientId, client_secret: p.clientSecret }),
    });
    if (!tokenRes.ok) throw new Error(`token HTTP ${tokenRes.status}`);
    const profile = await p.profile(await tokenRes.json(), fetchImpl);
    if (!profile?.id) throw new Error('no account id');
    const assertion = await signAssertion(env, {
      iss: url.origin, aud: state.returnTo, nonce: state.nonce, provider, id: String(profile.id),
      email: profile.email ? String(profile.email).toLowerCase() : null, verified: profile.verified === true, name: profile.name || '',
      iat: Date.now(), exp: Date.now() + ASSERTION_TTL,
    });
    return back({ assertion });
  } catch (error) {
    console.error(`${p.name} sign-in error:`, String(error?.message || error).slice(0, 200));
    return back({ error: `${p.name} sign-in failed. Try again.` });
  }
}

// ---------- the owner connects the sending Gmail (once) ----------
async function gmailStart(url, env) {
  if (!env.GOOGLE_CLIENT_ID || !env.SENDER_EMAIL) return page('Not ready', 'Set GOOGLE_CLIENT_ID and SENDER_EMAIL first.', 503);
  const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  auth.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID, redirect_uri: `${url.origin}/admin/gmail/callback`, response_type: 'code',
    scope: 'openid email https://www.googleapis.com/auth/gmail.send', access_type: 'offline', prompt: 'consent',
    login_hint: env.SENDER_EMAIL, state: await sealState(env, { admin: true }),
  }).toString();
  return Response.redirect(auth.href, 302);
}

async function gmailCallback(url, env, fetchImpl) {
  const state = await openState(env, url.searchParams.get('state'));
  if (!state?.admin || !url.searchParams.get('code')) return page('Not connected', 'The request expired or was cancelled. Open /admin/gmail/start again.', 400);
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: url.searchParams.get('code'), redirect_uri: `${url.origin}/admin/gmail/callback`, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET }),
  });
  if (!res.ok) return page('Not connected', `Google answered HTTP ${res.status}. Try again.`, 502);
  const tokens = await res.json();
  const who = await PROVIDERS.google.profile(tokens);
  // Only the configured sender may connect, so nobody else can take over the code emails.
  if (!who.verified || who.email?.toLowerCase() !== String(env.SENDER_EMAIL).toLowerCase()) return page('Wrong account', `Sign in as the sending account (${esc(env.SENDER_EMAIL)}).`, 403);
  if (!String(tokens.scope || '').includes('gmail.send') || !tokens.refresh_token) return page('Not connected', 'Allow “Send email on your behalf” and try again.', 400);
  await store(env, 'vault').fetch('https://store/gmail', { method: 'PUT', body: JSON.stringify({ refresh_token: tokens.refresh_token, at: Date.now() }) });
  return page('Gmail connected', `Relay will send sign-in codes from ${esc(env.SENDER_EMAIL)}. You can close this page.`);
}

const REPO = '<a href="https://github.com/viaanshetty3-debug/relay-whatsapp-mcp">Relay</a>';
const PRIVACY = `Relay Accounts helps people sign in to their own ${REPO} bridge, an open-source WhatsApp bridge that runs on their own computer.<br><br>
<b>What it handles.</b> When you sign in with Google, Microsoft, GitHub or Facebook, it receives your account ID, name, email address and whether that email is verified, and passes them, signed, straight back to your own Relay bridge. When Relay emails you a code, it receives the email address and the 5-digit code and sends that one email through Gmail.<br><br>
<b>What it keeps.</b> No accounts, names, emails or codes are stored. It keeps only rate-limit counters (keyed by a one-way hash of the email address and of the network address), which are deleted daily, and the token for the Gmail account that sends the codes. Your account and password live only on your own bridge; the service never sees your password.<br><br>
<b>What it never does.</b> It doesn't sell or share data, show ads, track you, or use data from Google or other providers for anything except signing you in. Use of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements.<br><br>
<b>Questions or removal.</b> Open an issue on the Relay GitHub repository. The source code of this service is public in the repository's accounts-worker folder.`;
const TERMS = `Relay Accounts is a free service for signing in to ${REPO} bridges, provided as is, without warranty. Use it only to sign in to a Relay bridge you own or are allowed to use. Don't use it to send unwanted email; codes are rate-limited. The service may change or stop; Relay can always run without it (set RELAY_ACCOUNTS_URL=off and use your own email server or sign-in apps). See also the <a href="/privacy">privacy policy</a>.`;

export default {
  async fetch(request, env, ctx, fetchImpl = fetch) {
    const url = new URL(request.url);
    try {
      if (request.method === 'OPTIONS') return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type' } });
      if (request.method === 'POST' && url.pathname === '/email/code') return await sendCode(request, env, fetchImpl);
      if (request.method !== 'GET') return json({ error: 'Not found' }, 404);
      if (url.pathname === '/providers') return json(enabled(env).map(id => ({ id, name: PROVIDERS[id].name })));
      if (url.pathname === '/health') {
        const gmail = await (await store(env, 'vault').fetch('https://store/gmail')).json();
        return json({ ok: true, providers: enabled(env), email: Boolean(gmail?.refresh_token) });
      }
      if (url.pathname === '/oauth/start') return await oauthStart(url, env);
      const cb = url.pathname.match(/^\/callback\/(google|microsoft|github|facebook)$/);
      if (cb) return await oauthCallback(url, env, cb[1], fetchImpl);
      if (url.pathname === '/admin/gmail/start') return await gmailStart(url, env);
      if (url.pathname === '/admin/gmail/callback') return await gmailCallback(url, env, fetchImpl);
      if (url.pathname === '/privacy') return page('Relay Accounts privacy policy', PRIVACY);
      if (url.pathname === '/terms') return page('Relay Accounts terms', TERMS);
      if (url.pathname === '/') return page('Relay Accounts', 'Sign-in and email codes for <a href="https://github.com/viaanshetty3-debug/relay-whatsapp-mcp">Relay</a>, the open-source WhatsApp bridge. Nothing to do here: open your Relay dashboard.<br><br><a href="/privacy">Privacy policy</a> · <a href="/terms">Terms</a>');
      return json({ error: 'Not found' }, 404);
    } catch (error) {
      console.error('Unexpected error:', String(error?.message || error).slice(0, 200));
      return json({ error: 'Something went wrong.' }, 500);
    }
  },
};
