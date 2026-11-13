// Sign-in providers, shared by the bridge (direct mode) and the Relay Accounts Worker.
// No Node-only APIs here: this file also runs on Cloudflare Workers.

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
  try {
    const part = String(idToken).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(part + '='.repeat((4 - part.length % 4) % 4)), c => c.charCodeAt(0))));
  } catch { return {}; }
}
async function getJson(fetchImpl, url, headers) {
  const res = await fetchImpl(url, { headers });
  if (!res.ok) throw new Error(`${new URL(url).host}: HTTP ${res.status}`);
  return res.json();
}

