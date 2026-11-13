// Owner account for the dashboard: sign up with full name, country, phone, email (verified with a
// 6-digit emailed code) and a strong password, or sign in with Google, Microsoft, GitHub or Facebook.
// One bridge serves one WhatsApp account, so it has exactly one owner: sign-up closes once the
// account exists. The owner token still works for local MCP clients and as a recovery option.
import { randomBytes, randomInt, scrypt as scryptCb, createHash, createPublicKey, verify as verifySig } from 'node:crypto';
import { promisify } from 'node:util';
import express from 'express';
import { equal } from './oauth.js';
import { PROVIDERS } from './providers.js';
export { PROVIDERS };

const scrypt = promisify(scryptCb);
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const DAY = 86400000, CODE_TTL = 10 * 60000, CODE_TRIES = 5, SESSION_TTL = 30 * DAY;
export const COOKIE = 'relay_session';
// Relay Accounts (accounts-worker/) signs sign-in results with this Ed25519 key.
export const ACCOUNTS_PUBLIC_KEY = 'MCowBQYDK2VwAyEAs94Kep38ad-15GUWSB1tXdRxMJuLGvRnDMpuANpdwt8';
const digest = s => createHash('sha256').update(String(s)).digest('base64url');
const secret = () => randomBytes(32).toString('base64url');
const lower = s => String(s || '').trim().toLowerCase();

export function passwordProblems(password, { email = '', name = '' } = {}) {
  const p = String(password || ''), problems = [];
  if (p.length < 12) problems.push('at least 12 characters');
  if (p.length > 256) problems.push('at most 256 characters');
  if (!/[a-z]/.test(p)) problems.push('a lowercase letter');
  if (!/[A-Z]/.test(p)) problems.push('an uppercase letter');
  if (!/\d/.test(p)) problems.push('a number');
  if (!/[^A-Za-z0-9]/.test(p)) problems.push('a symbol');
  const local = lower(email).split('@')[0];
  const parts = [local, ...lower(name).split(/\s+/)].filter(w => w.length >= 4);
  if (parts.some(w => p.toLowerCase().includes(w))) problems.push('no parts of your name or email');
  if (/(.)\1\1\1/.test(p) || /password|qwerty|123456|relay/i.test(p)) problems.push('no common words or repeated characters');
  return problems;
}

async function hashPassword(password) {
  const salt = randomBytes(16).toString('base64url');
  const key = await scrypt(String(password), salt, 64, SCRYPT);
  return `scrypt$${salt}$${key.toString('base64url')}`;
}
async function checkPassword(password, stored) {
  const [kind, salt, expected] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !expected) return false;
  const key = await scrypt(String(password || ''), salt, 64, SCRYPT);
  return equal(key.toString('base64url'), expected);
}

export function validateProfile(input) {
  const fullName = String(input?.fullName || '').trim().replace(/\s+/g, ' ');
  const country = String(input?.country || '').trim().toUpperCase();
  const phone = String(input?.phone || '').replace(/[\s()-]/g, '');
  const email = lower(input?.email);
  if (fullName.length < 2 || fullName.length > 100 || !/\p{L}/u.test(fullName)) return { error: 'Enter your full name.' };
  if (!/^[A-Z]{2}$/.test(country)) return { error: 'Choose your country.' };
  if (!/^\+[1-9]\d{6,14}$/.test(phone)) return { error: 'Enter your phone number with its country code, for example +65 9123 4567.' };
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return { error: 'Enter a valid email address.' };
  return { profile: { fullName, country, phone, email } };
}

function cookieValue(req) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  return null;
}

// Checks a Relay Accounts assertion: "payload.signature", both base64url, Ed25519 over the payload text.
export function verifyAssertion(assertion, publicKey = ACCOUNTS_PUBLIC_KEY) {
  try {
    const [payload, sig] = String(assertion || '').split('.');
    const key = createPublicKey({ key: Buffer.from(publicKey, 'base64url'), format: 'der', type: 'spki' });
    if (!payload || !sig || !verifySig(null, Buffer.from(payload), key, Buffer.from(sig, 'base64url'))) return null;
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch { return null; }
}

export function createMailer(config, fetchImpl = fetch) {
  if (config.mailer) return config.mailer; // tests
  const url = process.env.SMTP_URL;
  if (!url) {
    if (!config.accountsUrl || config.demo) return null;
    // Default: codes are emailed by the shared Relay Accounts service, so there's nothing to set up.
    return {
      broker: true,
      async send({ to, code, purpose }) {
        const res = await fetchImpl(`${config.accountsUrl}/email/code`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to, code, purpose }), signal: AbortSignal.timeout(15000) });
        if (!res.ok) { const j = await res.json().catch(() => ({})); const e = new Error(`Relay Accounts: HTTP ${res.status}`); e.userMessage = j.error; throw e; }
      },
    };
  }
  let transport;
  return {
    async send({ to, subject, text }) {
      if (!transport) transport = (await import('nodemailer')).default.createTransport(url);
      await transport.sendMail({ from: process.env.MAIL_FROM || new URL(url).username.replace('%40', '@') || 'Relay', to, subject, text });
    },
  };
}

export function mountAccounts(app, config, store) {
  const fetchImpl = config.fetch || fetch;
  const mailer = createMailer(config, fetchImpl);
  const accountsKey = config.accountsPublicKey || process.env.RELAY_ACCOUNTS_PUBLIC_KEY || ACCOUNTS_PUBLIC_KEY;
  // What the shared Relay Accounts service can do right now: sign-in buttons, and whether it can email codes.
  let brokerCache = { at: 0, list: [], email: false };
  async function brokerHealth() {
    if (!config.accountsUrl) return brokerCache;
    const healthy = brokerCache.list.length && brokerCache.email;
    if (Date.now() - brokerCache.at < (healthy ? 10 * 60000 : 60000)) return brokerCache;
    try {
      const res = await fetchImpl(`${config.accountsUrl}/health`, { signal: AbortSignal.timeout(3000) });
      const h = res.ok ? await res.json() : {};
      brokerCache = { at: Date.now(), list: (Array.isArray(h.providers) ? h.providers : []).filter(id => PROVIDERS[id]), email: h.email === true };
    } catch { brokerCache = { at: Date.now(), list: [], email: false }; }
    return brokerCache;
  }
  const brokerProviders = async () => (await brokerHealth()).list;
  // Can this bridge email a code right now? (Your own SMTP server, or the shared service when its Gmail is connected.)
  const emailReady = async () => Boolean(config.demo) || (Boolean(mailer) && (!mailer.broker || (await brokerHealth()).email));
  const directProviders = () => Object.keys(PROVIDERS).filter(id => (config.providers ? config.providers[id] : providerConfig(id)));
  const secureCookie = new URL(config.base).protocol === 'https:';
  const localBase = ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(config.base).hostname);
  // Sign-in providers redirect back to http://localhost on a local bridge (every provider accepts it).
  const oauthBase = localBase ? `http://localhost:${new URL(config.base).port || config.port}` : config.base;
  const providerConfig = id => {
    const up = id.toUpperCase();
    const clientId = process.env[`${up}_CLIENT_ID`], clientSecret = process.env[`${up}_CLIENT_SECRET`];
    return clientId && clientSecret ? { ...PROVIDERS[id], clientId, clientSecret } : null;
  };
  // Your own OAuth apps (in .env) take over from the shared Relay Accounts service.
  const enabledProviders = async () => (directProviders().length ? directProviders() : brokerProviders());
  const getProvider = id => (config.providers ? (config.providers[id] && { ...PROVIDERS[id], ...config.providers[id] }) : providerConfig(id));

  const owner = () => store.kv('account:owner');
  const failures = new Map(); // ip → { count, reset }
  const pendingSocial = new Map(); // state → { provider, verifier, mode, expires }, and ticket → profile
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const map of [failures, pendingSocial]) for (const [k, v] of map) if ((v.reset || v.expires) < now) map.delete(k);
  }, 60000); sweep.unref();

  // Behind a hosting proxy (production), req.ip is the visitor's address (server.js sets 'trust proxy').
  const clientIp = req => req.ip || req.socket.remoteAddress;
  function throttled(req) {
    const f = failures.get(clientIp(req));
    return f && f.reset > Date.now() && f.count >= 10;
  }
  function failed(req) {
    const key = clientIp(req); let f = failures.get(key);
    if (!f || f.reset < Date.now()) { f = { count: 0, reset: Date.now() + 15 * 60000 }; failures.set(key, f); }
    f.count++;
  }

  function startSession(res) {
    const token = secret(), sessions = store.kv('account:sessions') || {};
    for (const [k, v] of Object.entries(sessions)) if (v.expires < Date.now()) delete sessions[k];
    sessions[digest(token)] = { expires: Date.now() + SESSION_TTL };
    store.kv('account:sessions', sessions);
    res.append('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}${secureCookie ? '; Secure' : ''}`);
  }
  function sessionValid(req) {
    const token = cookieValue(req);
    if (!token || !owner()) return false;
    const s = (store.kv('account:sessions') || {})[digest(token)];
    return Boolean(s && s.expires > Date.now());
  }
  function endSession(req, res) {
    const token = cookieValue(req);
    if (token) { const sessions = store.kv('account:sessions') || {}; delete sessions[digest(token)]; store.kv('account:sessions', sessions); }
    res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureCookie ? '; Secure' : ''}`);
  }

  // Who may create the one owner account: anyone on this computer for a local bridge; on a public
  // deployment, only someone who also has the owner token from the server's settings.
  function maySignUp(req, body) {
    if (owner()) return 'An account already exists for this bridge. Sign in instead.';
    if (localBase) {
      const ip = req.socket.remoteAddress || '';
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return 'Create the account on the computer running Relay.';
      return null;
    }
    return equal(body?.setupToken, config.token) ? null : 'On a hosted bridge, enter the owner token from your hosting settings to create the first account.';
  }

  async function sendCode(email, purpose) {
    const code = String(randomInt(0, 1000000)).padStart(6, '0');
    const what = purpose === 'reset' ? 'reset your Relay password' : 'confirm your email for Relay';
    if (mailer) await mailer.send({ to: email, code, purpose, subject: `Your Relay code: ${code}`, text: `Use this code to ${what}: ${code}\n\nIt expires in 10 minutes. If you didn't ask for it, ignore this email.` });
    return code;
  }
  // New codes: at most one per 30 s and 5 per hour per purpose. With 5 guesses per code that caps
  // guessing at 25 an hour against a 6-digit code, and it stops inbox flooding.
  const codeLimit = record => {
    if (record?.sentAt && Date.now() - record.sentAt < 30000) return 'Wait 30 seconds before asking for another code.';
    if (codeHistory(record).length > 5) return 'Too many codes were sent. Try again in an hour.';
    return null;
  };
  const codeHistory = record => [...(record?.history || []).filter(t => Date.now() - t < 3600000), Date.now()];
  const codeRecord = (code, extra) => ({ ...extra, codeHash: digest(code), expires: Date.now() + CODE_TTL, tries: 0 });
  const demoCode = code => (config.demo && !mailer ? { demoCode: code } : {});
  const noMail = r => r.status(503).json({ error: 'Relay can\'t send email codes here: set SMTP_URL in .env (see README), or use a sign-in button.' });
  const mailError = (r, e) => { console.error('Email error:', String(e?.message || e).slice(0, 200)); r.status(502).json({ error: e?.userMessage || 'Relay could not send the email. Try again in a minute.' }); };

  function checkCode(record, code) {
    if (!record || record.expires < Date.now()) return 'That code has expired. Ask for a new one.';
    if (record.tries >= CODE_TRIES) return 'Too many wrong codes. Ask for a new one.';
    if (!/^\d{6}$/.test(String(code || '')) || !equal(digest(code), record.codeHash)) { record.tries++; return 'That code is not right.'; }
    return null;
  }

  const router = express.Router();
  router.use(express.json({ limit: '16kb' }));

  router.get('/status', async (req, res) => {
    const o = owner(), providers = await enabledProviders();
    res.json({
      hasAccount: Boolean(o), signedIn: sessionValid(req), email: sessionValid(req) ? o.email : undefined,
      name: sessionValid(req) ? o.fullName : undefined, providers: providers.map(id => ({ id, name: PROVIDERS[id].name })),
      emailReady: await emailReady(), hostedSetup: !localBase && !o,
    });
  });

  router.post('/signup', async (req, res) => {
    const denied = maySignUp(req, req.body); if (denied) return res.status(403).json({ error: denied });
    const social = req.body.ticket ? pendingSocial.get(`ticket:${req.body.ticket}`) : null;
    if (req.body.ticket && (!social || social.expires < Date.now())) return res.status(400).json({ error: 'Your sign-in expired. Start again.' });
    const { profile, error } = validateProfile({ ...req.body, email: social ? social.email : req.body.email });
    if (error) return res.status(400).json({ error });
    const problems = passwordProblems(req.body.password, { email: profile.email, name: profile.fullName });
    if (problems.length) return res.status(400).json({ error: `Your password needs ${problems.join(', ')}.` });
    const passwordHash = await hashPassword(req.body.password);
    if (social) { // the provider already verified this email
      pendingSocial.delete(`ticket:${req.body.ticket}`);
      store.kv('account:owner', { ...profile, passwordHash, providers: { [social.provider]: social.id }, createdAt: Date.now() });
      startSession(res); return res.json({ ok: true, signedIn: true });
    }
    if (!mailer && !config.demo) return noMail(res);
    const prev = store.kv('account:pending'), limit = codeLimit(prev);
    if (limit) return res.status(429).json({ error: limit });
    try {
      const code = await sendCode(profile.email, 'verify');
      store.kv('account:pending', codeRecord(code, { profile, passwordHash, sentAt: Date.now(), history: codeHistory(prev) }));
      res.json({ ok: true, verify: true, email: profile.email, ...demoCode(code) });
    } catch (e) { mailError(res, e); }
  });

  router.post('/verify', (req, res) => {
    const denied = maySignUp(req, req.body); if (denied) return res.status(403).json({ error: denied });
    const pending = store.kv('account:pending');
    if (!pending || pending.profile.email !== lower(req.body.email)) return res.status(400).json({ error: 'Start creating your account again.' });
    const problem = checkCode(pending, req.body.code);
    if (problem) { store.kv('account:pending', pending); return res.status(400).json({ error: problem }); }
    store.kv('account:owner', { ...pending.profile, passwordHash: pending.passwordHash, providers: {}, createdAt: Date.now() });
    store.kv('account:pending', null);
    startSession(res); res.json({ ok: true, signedIn: true });
  });

  router.post('/resend', async (req, res) => {
    const kind = req.body.purpose === 'reset' ? 'account:reset' : 'account:pending';
    const record = store.kv(kind);
    const email = kind === 'account:reset' ? record?.email : record?.profile?.email;
    if (!record || email !== lower(req.body.email)) return res.json({ ok: true }); // don't reveal anything
    if (!mailer && !config.demo) return noMail(res);
    const limit = codeLimit(record); if (limit) return res.status(429).json({ error: limit });
    try {
      const code = await sendCode(email, req.body.purpose);
      store.kv(kind, { ...record, ...codeRecord(code, {}), sentAt: Date.now(), history: codeHistory(record) });
      res.json({ ok: true, ...demoCode(code) });
    } catch (e) { mailError(res, e); }
  });

  router.post('/login', async (req, res) => {
    if (throttled(req)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    const o = owner();
    const ok = o && lower(req.body.email) === o.email && await checkPassword(req.body.password, o.passwordHash);
    if (!ok) { failed(req); return res.status(401).json({ error: 'Wrong email or password.' }); }
    startSession(res); res.json({ ok: true, signedIn: true });
  });

  router.post('/logout', (req, res) => { endSession(req, res); res.json({ ok: true }); });

  // Recovery for someone who still has the owner token (for example, email isn't set up).
  router.post('/token-login', (req, res) => {
    if (throttled(req)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    if (!owner() || !equal(req.body.token, config.token)) { failed(req); return res.status(401).json({ error: 'That owner token is not right.' }); }
    startSession(res); res.json({ ok: true, signedIn: true });
  });

  router.post('/reset/request', async (req, res) => {
    const o = owner();
    if (!mailer && !config.demo) return noMail(res);
    if (!o || lower(req.body.email) !== o.email) return res.json({ ok: true }); // same answer either way
    const prev = store.kv('account:reset'), limit = codeLimit(prev);
    if (limit) return res.status(429).json({ error: limit });
    try {
      const code = await sendCode(o.email, 'reset');
      store.kv('account:reset', codeRecord(code, { email: o.email, sentAt: Date.now(), history: codeHistory(prev) }));
      res.json({ ok: true, ...demoCode(code) });
    } catch (e) { mailError(res, e); }
  });

  router.post('/reset/confirm', async (req, res) => {
    const o = owner(), record = store.kv('account:reset');
    if (!o || !record || record.email !== lower(req.body.email)) return res.status(400).json({ error: 'Ask for a new code.' });
    const problem = checkCode(record, req.body.code);
    if (problem) { store.kv('account:reset', record); return res.status(400).json({ error: problem }); }
    const problems = passwordProblems(req.body.password, { email: o.email, name: o.fullName });
    if (problems.length) return res.status(400).json({ error: `Your password needs ${problems.join(', ')}.` });
    store.kv('account:owner', { ...o, passwordHash: await hashPassword(req.body.password) });
    store.kv('account:reset', null);
    store.kv('account:sessions', {}); // sign out everywhere else
    startSession(res); res.json({ ok: true, signedIn: true });
  });

  // ----- sign in with a provider -----
  router.get('/oauth/:provider', async (req, res) => {
    const id = req.params.provider, p = getProvider(id);
    if (!p) {
      // Shared Relay Accounts service: it holds the OAuth apps and signs the result for this bridge.
      if (!PROVIDERS[id] || !(await brokerProviders()).includes(id)) return res.status(404).send('That sign-in option is not set up on this bridge.');
      const nonce = secret(), returnTo = `${localBase ? `http://${req.headers.host}` : config.base}/auth/broker/callback`;
      pendingSocial.set(nonce, { provider: id, broker: true, returnTo, expires: Date.now() + 15 * 60000 });
      const to = new URL(`${config.accountsUrl}/oauth/start`);
      to.search = new URLSearchParams({ provider: id, return_to: returnTo, nonce }).toString();
      return res.redirect(302, to.href);
    }
    if (localBase && req.headers.host !== new URL(oauthBase).host) return res.redirect(302, `${oauthBase}/auth/oauth/${id}`);
    const state = secret(), verifier = secret();
    pendingSocial.set(state, { provider: id, verifier, expires: Date.now() + 10 * 60000 });
    const url = new URL(p.authorize);
    url.search = new URLSearchParams({
      client_id: p.clientId, redirect_uri: `${oauthBase}/auth/callback/${id}`, response_type: 'code', scope: p.scope, state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
      ...(id === 'google' ? { prompt: 'select_account' } : {}),
    }).toString();
    res.redirect(302, url.href);
  });

  const back = (res, msg) => res.redirect(302, `/?auth_error=${encodeURIComponent(msg)}`);

  router.get('/callback/:provider', async (req, res) => {
    const pending = pendingSocial.get(String(req.query.state || ''));
    if (!pending || pending.broker || pending.provider !== req.params.provider || pending.expires < Date.now()) return back(res, 'That sign-in expired. Try again.');
    pendingSocial.delete(String(req.query.state));
    const p = getProvider(req.params.provider);
    if (!p || !req.query.code) return back(res, 'Sign-in was cancelled.');
    let profile;
    try {
      const tokenRes = await fetchImpl(p.token, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code: String(req.query.code), redirect_uri: `${oauthBase}/auth/callback/${req.params.provider}`, client_id: p.clientId, client_secret: p.clientSecret, code_verifier: pending.verifier }),
      });
      if (!tokenRes.ok) throw new Error(`token HTTP ${tokenRes.status}`);
      profile = await p.profile(await tokenRes.json(), fetchImpl);
    } catch (e) {
      console.error(`${p.name} sign-in error:`, String(e?.message || e).slice(0, 200));
      return back(res, `${p.name} sign-in failed. Try again.`);
    }
    finishSocial(req, res, req.params.provider, profile);
  });

  // Result from the Relay Accounts service: a signed assertion bound to this bridge's request.
  router.get('/broker/callback', (req, res) => {
    const claims = req.query.assertion ? verifyAssertion(req.query.assertion, accountsKey) : null;
    const pending = claims && pendingSocial.get(String(claims.nonce || ''));
    if (req.query.error && !req.query.assertion) return back(res, String(req.query.error).slice(0, 200));
    if (!claims) { failed(req); return back(res, 'That sign-in could not be verified. Try again.'); }
    if (!pending?.broker || pending.expires < Date.now() || claims.provider !== pending.provider || claims.aud !== pending.returnTo || !(claims.exp > Date.now())
        || (config.accountsUrl && claims.iss !== new URL(config.accountsUrl).origin)) return back(res, 'That sign-in expired. Try again.');
    pendingSocial.delete(String(claims.nonce));
    finishSocial(req, res, claims.provider, { id: claims.id, email: claims.email, verified: claims.verified === true, name: claims.name });
  });

  function finishSocial(req, res, providerId, profile) {
    const name = PROVIDERS[providerId].name;
    if (!profile?.id) return back(res, `${name} did not return an account.`);
    const o = owner();
    if (o) {
      const linked = o.providers?.[providerId] === String(profile.id);
      const sameEmail = profile.verified && lower(profile.email) === o.email;
      if (!linked && !sameEmail) { failed(req); return back(res, `This ${name} account isn't the one that owns this bridge.`); }
      if (!linked) store.kv('account:owner', { ...o, providers: { ...o.providers, [providerId]: String(profile.id) } });
      startSession(res); return res.redirect(302, '/');
    }
    // No account yet: finish signing up with the name and verified email from the provider.
    if (localBase && !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress || '')) return back(res, 'Create the account on the computer running Relay.');
    if (!profile.verified || !profile.email) return back(res, `${name} didn't share a verified email. Sign up with your email instead.`);
    const ticket = secret();
    pendingSocial.set(`ticket:${ticket}`, { provider: providerId, id: String(profile.id), email: lower(profile.email), name: profile.name, expires: Date.now() + 15 * 60000 });
    res.redirect(302, `/?signup=${encodeURIComponent(ticket)}`);
  }

  router.get('/ticket/:ticket', (req, res) => {
    const t = pendingSocial.get(`ticket:${req.params.ticket}`);
    if (!t || t.expires < Date.now()) return res.status(404).json({ error: 'Your sign-in expired. Start again.' });
    res.json({ email: t.email, name: t.name || '', provider: PROVIDERS[t.provider].name });
  });

  app.use('/auth', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); }, router);
  return { sessionValid, hasAccount: () => Boolean(owner()) };
}
