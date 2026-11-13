// Owner account for the dashboard: sign up with full name, country, phone, email (verified with a
// 5-digit emailed code) and a strong password, or sign in with Google, Microsoft, GitHub or Facebook.
// One bridge serves one WhatsApp account, so it has exactly one owner: sign-up closes once the
// account exists. The owner token still works for local MCP clients and as a recovery option.
import { randomBytes, randomInt, scrypt as scryptCb, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import express from 'express';
import { equal } from './oauth.js';

const scrypt = promisify(scryptCb);
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const DAY = 86400000, CODE_TTL = 10 * 60000, CODE_TRIES = 5, SESSION_TTL = 30 * DAY;
export const COOKIE = 'relay_session';
const digest = s => createHash('sha256').update(String(s)).digest('base64url');
const secret = () => randomBytes(32).toString('base64url');
const lower = s => String(s || '').trim().toLowerCase();

export const PROVIDERS = {
  google: {
    name: 'Google', scope: 'openid email profile',
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token',
    async profile({ id_token }) {
      const c = claims(id_token);
      return { id: c.sub, email: c.email, verified: c.email_verified === true, name: c.name };
    },
  },
  microsoft: {
    name: 'Microsoft', scope: 'openid email profile',
    authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    async profile({ id_token }) {
      const c = claims(id_token);
      // Work/school tenants let admins set any email, so only personal Microsoft accounts count as verified.
      return { id: `${c.tid}:${c.oid || c.sub}`, email: c.email, verified: c.tid === '9188040d-6c67-4c5b-b112-36a304b66dad', name: c.name };
    },
  },
  github: {
    name: 'GitHub', scope: 'read:user user:email',
    authorize: 'https://github.com/login/oauth/authorize', token: 'https://github.com/login/oauth/access_token',
    async profile({ access_token }, fetchImpl) {
      const headers = { Authorization: `Bearer ${access_token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'relay-whatsapp-mcp' };
      const user = await getJson(fetchImpl, 'https://api.github.com/user', headers);
      const emails = await getJson(fetchImpl, 'https://api.github.com/user/emails', headers);
      const primary = (emails || []).find(e => e.primary) || {};
      return { id: String(user.id), email: primary.email, verified: primary.verified === true, name: user.name || user.login };
    },
  },
  facebook: {
    name: 'Facebook', scope: 'email,public_profile',
    authorize: 'https://www.facebook.com/v21.0/dialog/oauth', token: 'https://graph.facebook.com/v21.0/oauth/access_token',
    async profile({ access_token }, fetchImpl) {
      const me = await getJson(fetchImpl, 'https://graph.facebook.com/v21.0/me?fields=id,name,email', { Authorization: `Bearer ${access_token}` });
      // Facebook only returns an email address the person has confirmed.
      return { id: me.id, email: me.email, verified: Boolean(me.email), name: me.name };
    },
  },
};

// ID tokens here come straight from the provider's token endpoint over TLS (code flow), so the
// claims are trusted without a signature check, as OpenID Connect allows for this case.
function claims(idToken) {
  try { return JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8')); } catch { return {}; }
}
async function getJson(fetchImpl, url, headers) {
  const res = await fetchImpl(url, { headers });
  if (!res.ok) throw new Error(`${new URL(url).host}: HTTP ${res.status}`);
  return res.json();
}

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

export function createMailer(config) {
  if (config.mailer) return config.mailer; // tests
  const url = process.env.SMTP_URL;
  if (!url) return null;
  let transport;
  return {
    async send({ to, subject, text }) {
      if (!transport) transport = (await import('nodemailer')).default.createTransport(url);
      await transport.sendMail({ from: process.env.MAIL_FROM || new URL(url).username.replace('%40', '@') || 'Relay', to, subject, text });
    },
  };
}

export function mountAccounts(app, config, store) {
  const mailer = createMailer(config);
  const fetchImpl = config.fetch || fetch;
  const secureCookie = new URL(config.base).protocol === 'https:';
  const localBase = ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(config.base).hostname);
  // Sign-in providers redirect back to http://localhost on a local bridge (every provider accepts it).
  const oauthBase = localBase ? `http://localhost:${new URL(config.base).port || config.port}` : config.base;
  const providerConfig = id => {
    const up = id.toUpperCase();
    const clientId = process.env[`${up}_CLIENT_ID`], clientSecret = process.env[`${up}_CLIENT_SECRET`];
    return clientId && clientSecret ? { ...PROVIDERS[id], clientId, clientSecret } : null;
  };
  const enabledProviders = () => Object.keys(PROVIDERS).filter(id => (config.providers ? config.providers[id] : providerConfig(id)));
  const getProvider = id => (config.providers ? (config.providers[id] && { ...PROVIDERS[id], ...config.providers[id] }) : providerConfig(id));

  const owner = () => store.kv('account:owner');
  const failures = new Map(); // ip → { count, reset }
  const pendingSocial = new Map(); // state → { provider, verifier, mode, expires }, and ticket → profile
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const map of [failures, pendingSocial]) for (const [k, v] of map) if ((v.reset || v.expires) < now) map.delete(k);
  }, 60000); sweep.unref();

  function throttled(req) {
    const f = failures.get(req.socket.remoteAddress);
    return f && f.reset > Date.now() && f.count >= 10;
  }
  function failed(req) {
    const key = req.socket.remoteAddress; let f = failures.get(key);
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
    const code = String(randomInt(0, 100000)).padStart(5, '0');
    const what = purpose === 'reset' ? 'reset your Relay password' : 'confirm your email for Relay';
    if (mailer) await mailer.send({ to: email, subject: `Your Relay code: ${code}`, text: `Use this code to ${what}: ${code}\n\nIt expires in 10 minutes. If you didn't ask for it, ignore this email.` });
    return code;
  }
  const codeRecord = (code, extra) => ({ ...extra, codeHash: digest(code), expires: Date.now() + CODE_TTL, tries: 0 });
  const demoCode = code => (config.demo && !mailer ? { demoCode: code } : {});
  const noMail = r => r.status(503).json({ error: 'Email sending is not set up yet, so Relay cannot send your code. Run `npx relay-whatsapp-mcp setup` and choose email, or set SMTP_URL in .env.' });

  function checkCode(record, code) {
    if (!record || record.expires < Date.now()) return 'That code has expired. Ask for a new one.';
    if (record.tries >= CODE_TRIES) return 'Too many wrong codes. Ask for a new one.';
    if (!/^\d{5}$/.test(String(code || '')) || !equal(digest(code), record.codeHash)) { record.tries++; return 'That code is not right.'; }
    return null;
  }

  const router = express.Router();
  router.use(express.json({ limit: '16kb' }));

  router.get('/status', (req, res) => {
    const o = owner();
    res.json({
      hasAccount: Boolean(o), signedIn: sessionValid(req), email: sessionValid(req) ? o.email : undefined,
      name: sessionValid(req) ? o.fullName : undefined, providers: enabledProviders().map(id => ({ id, name: PROVIDERS[id].name })),
      emailReady: Boolean(mailer) || Boolean(config.demo), hostedSetup: !localBase && !o,
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
    try {
      const code = await sendCode(profile.email, 'verify');
      store.kv('account:pending', codeRecord(code, { profile, passwordHash }));
      res.json({ ok: true, verify: true, email: profile.email, ...demoCode(code) });
    } catch (e) { console.error('Email error:', String(e?.message || e).slice(0, 200)); res.status(502).json({ error: 'Relay could not send the email. Check the email settings and try again.' }); }
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
    if (record.sentAt && Date.now() - record.sentAt < 30000) return res.status(429).json({ error: 'Wait 30 seconds before asking for another code.' });
    const code = await sendCode(email, req.body.purpose);
    store.kv(kind, { ...record, ...codeRecord(code, {}), sentAt: Date.now() });
    res.json({ ok: true, ...demoCode(code) });
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
    const code = await sendCode(o.email, 'reset');
    store.kv('account:reset', codeRecord(code, { email: o.email, sentAt: Date.now() }));
    res.json({ ok: true, ...demoCode(code) });
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
  router.get('/oauth/:provider', (req, res) => {
    const p = getProvider(req.params.provider);
    if (!p) return res.status(404).send('That sign-in option is not set up on this bridge.');
    if (localBase && req.headers.host !== new URL(oauthBase).host) return res.redirect(302, `${oauthBase}/auth/oauth/${req.params.provider}`);
    const state = secret(), verifier = secret();
    pendingSocial.set(state, { provider: req.params.provider, verifier, expires: Date.now() + 10 * 60000 });
    const url = new URL(p.authorize);
    url.search = new URLSearchParams({
      client_id: p.clientId, redirect_uri: `${oauthBase}/auth/callback/${req.params.provider}`, response_type: 'code', scope: p.scope, state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
      ...(req.params.provider === 'google' ? { prompt: 'select_account' } : {}),
    }).toString();
    res.redirect(302, url.href);
  });

  router.get('/callback/:provider', async (req, res) => {
    const back = (msg) => res.redirect(302, `/?auth_error=${encodeURIComponent(msg)}`);
    const pending = pendingSocial.get(String(req.query.state || ''));
    if (!pending || pending.provider !== req.params.provider || pending.expires < Date.now()) return back('That sign-in expired. Try again.');
    pendingSocial.delete(String(req.query.state));
    const p = getProvider(req.params.provider);
    if (!p || !req.query.code) return back('Sign-in was cancelled.');
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
      return back(`${p.name} sign-in failed. Try again.`);
    }
    if (!profile?.id) return back(`${p.name} did not return an account.`);
    const o = owner();
    if (o) {
      const linked = o.providers?.[req.params.provider] === profile.id;
      const sameEmail = profile.verified && lower(profile.email) === o.email;
      if (!linked && !sameEmail) { failed(req); return back(`This ${p.name} account isn't the one that owns this bridge.`); }
      if (!linked) store.kv('account:owner', { ...o, providers: { ...o.providers, [req.params.provider]: profile.id } });
      startSession(res); return res.redirect(302, '/');
    }
    // No account yet: finish signing up with the name and verified email from the provider.
    if (maySignUp(req, {})) return back('Create the account on the computer running Relay.');
    if (!profile.verified || !profile.email) return back(`${p.name} didn't share a verified email. Sign up with your email instead.`);
    const ticket = secret();
    pendingSocial.set(`ticket:${ticket}`, { provider: req.params.provider, id: profile.id, email: lower(profile.email), name: profile.name, expires: Date.now() + 15 * 60000 });
    res.redirect(302, `/?signup=${encodeURIComponent(ticket)}`);
  });

  router.get('/ticket/:ticket', (req, res) => {
    const t = pendingSocial.get(`ticket:${req.params.ticket}`);
    if (!t || t.expires < Date.now()) return res.status(404).json({ error: 'Your sign-in expired. Start again.' });
    res.json({ email: t.email, name: t.name || '', provider: PROVIDERS[t.provider].name });
  });

  app.use('/auth', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); }, router);
  return { sessionValid, hasAccount: () => Boolean(owner()) };
}
