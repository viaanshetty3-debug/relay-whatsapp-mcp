import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import express from 'express';
export const digest=s=>createHash('sha256').update(s).digest('base64url');
const secret=()=>randomBytes(32).toString('base64url');
export function equal(a,b) {const x=Buffer.from(String(a||'')),y=Buffer.from(String(b||''));return x.length===y.length&&timingSafeEqual(x,y);}
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const validRedirect=s=>{
  try{const u=new URL(s);return !u.hash&&!u.username&&!u.password&&(u.protocol==='https:'||(u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname)));}catch{return false;}
};
export function mountOAuth(app,config,store) {
  const base=config.base,resource=base+'/mcp',forms=new Map(),codes=new Map();
  const cleanup=setInterval(()=>{for(const map of [forms,codes])for(const [k,v] of map)if(v.expires<Date.now())map.delete(k);},60000);cleanup.unref();
  const clients=()=>store.kv('oauth:clients') || {};
  const metadata={issuer:base,authorization_endpoint:base+'/oauth/authorize',token_endpoint:base+'/oauth/token',registration_endpoint:base+'/oauth/register',response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['none'],scopes_supported:['whatsapp']};
  app.get('/.well-known/oauth-authorization-server',(_q,r)=>r.json(metadata));
  app.get(['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp'],(_q,r)=>r.json({resource,authorization_servers:[base],scopes_supported:['whatsapp'],bearer_methods_supported:['header']}));
  app.post('/oauth/register',express.json({limit:'16kb'}),(q,r)=>{
    const body=q.body;
    if(!Array.isArray(body?.redirect_uris)||!body.redirect_uris.length||body.redirect_uris.length>10||!body.redirect_uris.every(validRedirect))return r.status(400).json({error:'invalid_redirect_uri'});
    if(body.token_endpoint_auth_method && body.token_endpoint_auth_method!=='none')return r.status(400).json({error:'invalid_client_metadata',error_description:'Public clients with PKCE and token_endpoint_auth_method=none are supported'});
    const all=clients();if(Object.keys(all).length>=200)return r.status(429).json({error:'registration_limit',error_description:'Remove unused clients from the local database before registering more'});
    const client={client_id:secret(),client_name:String(body.client_name || 'AI client').slice(0,100),redirect_uris:body.redirect_uris,token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']};
    all[client.client_id]=client;store.kv('oauth:clients',all);r.status(201).json(client);
  });
  app.get('/oauth/authorize',(q,r)=>{
    const a=q.query,c=clients()[a.client_id];
    if(!c || !c.redirect_uris.includes(a.redirect_uri) || a.response_type!=='code' || a.code_challenge_method!=='S256' || !/^[\w-]{43}$/.test(a.code_challenge || '') || (a.resource&&a.resource!==resource) || (a.scope&&a.scope!=='whatsapp'))return r.status(400).send('Invalid OAuth request. The client must register and use PKCE S256 for this bridge.');
    if(forms.size>1000)return r.status(429).send('Too many pending requests');
    const nonce=secret();forms.set(nonce,{clientId:c.client_id,redirect:a.redirect_uri,challenge:a.code_challenge,state:a.state,expires:Date.now()+300000});
    r.set('Cache-Control','no-store').type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/style.css"><title>Connect WhatsApp</title><body class="auth-page"><main class="auth-card"><span class="eyebrow">WHATSAPP BRIDGE</span><h1>Connect ${esc(c.client_name)}</h1><p>This client will be able to read ${config.allowed.size?'your allowed':'your synced'} chats${config.readOnly?'.':' and send, edit, and delete your messages.'}</p><p>Enter the owner token from your local bridge to approve this connection. Never share it inside an AI chat.</p><form method="post" action="/oauth/approve"><input type="hidden" name="nonce" value="${nonce}"><label>Owner token<input name="token" type="password" autocomplete="off" required minlength="32"></label><button>Authorize connection</button></form><p class="muted">Close this window to decline.</p></main></body></html>`);
  });
  app.post('/oauth/approve',express.urlencoded({extended:false,limit:'8kb'}),(q,r)=>{
    const f=forms.get(q.body.nonce);
    if(!f || f.expires<Date.now())return r.status(400).send('Authorization expired. Start again from your AI client.');
    if(!equal(q.body.token,config.token))return r.status(401).send('Incorrect owner token. Go back to try again.');
    forms.delete(q.body.nonce);
    const code=secret();codes.set(code,{...f,expires:Date.now()+120000});
    const redirect=new URL(f.redirect);redirect.searchParams.set('code',code);if(f.state)redirect.searchParams.set('state',f.state);
    r.set('Cache-Control','no-store').redirect(303,redirect.href);
  });
  function issue(clientId,previousRefresh) {
    const access=secret(),refresh=secret(),expires=Date.now()+3600000;
    const tokens=store.kv('oauth:tokens') || {};
    for(const [k,v] of Object.entries(tokens))if(v.expires<Date.now())delete tokens[k];
    if(previousRefresh){const prior=tokens[digest(previousRefresh)];if(prior?.accessHash)delete tokens[prior.accessHash];delete tokens[digest(previousRefresh)];}
    tokens[digest(access)]={clientId,resource,expires,kind:'access'};
    tokens[digest(refresh)]={clientId,resource,expires:Date.now()+30*86400000,kind:'refresh',accessHash:digest(access)};
    store.kv('oauth:tokens',tokens);
    return {access_token:access,refresh_token:refresh,token_type:'Bearer',expires_in:3600,scope:'whatsapp'};
  }
  app.post('/oauth/token',express.urlencoded({extended:false,limit:'16kb'}),(q,r)=>{
    r.set('Cache-Control','no-store');const a=q.body;
    if(a.resource&&a.resource!==resource)return r.status(400).json({error:'invalid_target'});
    if(a.grant_type==='authorization_code') {
      const c=codes.get(a.code);
      if(!c || c.expires<Date.now() || c.clientId!==a.client_id || c.redirect!==a.redirect_uri || !/^[\w.~-]{43,128}$/.test(a.code_verifier || '') || !equal(digest(a.code_verifier),c.challenge))return r.status(400).json({error:'invalid_grant'});
      codes.delete(a.code);return r.json(issue(c.clientId));
    }
    if(a.grant_type==='refresh_token') {
      const t=(store.kv('oauth:tokens') || {})[digest(a.refresh_token || '')];
      if(!t || t.kind!=='refresh' || t.expires<Date.now() || t.clientId!==a.client_id)return r.status(400).json({error:'invalid_grant'});
      return r.json(issue(t.clientId,a.refresh_token));
    }
    return r.status(400).json({error:'unsupported_grant_type'});
  });
  return function authenticate(q,r,next) {
    const supplied=q.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1];
    if(equal(supplied,config.token)){q.owner=true;return next();}
    const t=supplied&&(store.kv('oauth:tokens') || {})[digest(supplied)];
    if(t?.kind==='access'&&t.expires>Date.now()&&t.resource===resource){q.owner=false;return next();}
    r.set('WWW-Authenticate',`Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`).status(401).json({error:'unauthorized'});
  };
}
