import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, defaultDataDir } from './paths.js';

export const root = fileURLToPath(new URL('../', import.meta.url));
loadEnv(); // the clone's .env, or ~/.relay-whatsapp-mcp/.env for npm installs (see paths.js)
export function config(demo=process.argv.includes('--demo')) {
  const production=process.env.NODE_ENV==='production';
  if(production && !process.env.BRIDGE_TOKEN)throw new Error('Set BRIDGE_TOKEN as a private hosting variable before deploying');
  const dir=resolve(process.env.DATA_DIR || defaultDataDir(demo));
  mkdirSync(dir,{recursive:true,mode:0o700});
  const tokenFile=resolve(dir,'owner-token');
  let token=process.env.BRIDGE_TOKEN;
  if(!token) {
    token=existsSync(tokenFile)?readFileSync(tokenFile,'utf8').trim():randomBytes(32).toString('base64url');
    writeFileSync(tokenFile,token+'\n',{mode:0o600});
  }
  if(token.length<32) throw new Error('BRIDGE_TOKEN must be at least 32 characters');
  const port=Number(process.env.PORT || 8787);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('PORT must be between 1 and 65535');
  const base=process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN?`https://${process.env.RAILWAY_PUBLIC_DOMAIN}`:process.env.RENDER_EXTERNAL_URL) || `http://127.0.0.1:${port}`;
  const url=new URL(base);
  if(url.pathname!=='/' || url.search || url.hash || url.username || url.password) throw new Error('PUBLIC_URL must be an origin, without a path, credentials, query or fragment');
  if(production && url.protocol!=='https:')throw new Error('Production requires an HTTPS PUBLIC_URL or a host-provided public domain');
  if(url.protocol!=='https:' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new Error('A public URL requires HTTPS');
  const accountsUrl=process.env.RELAY_ACCOUNTS_URL==='off'?null:(process.env.RELAY_ACCOUNTS_URL||'https://relay-accounts.viaan-mcp.workers.dev').replace(/\/+$/,'');
  return {dir,token,port,production,accountsUrl,autoConnect:process.env.AUTO_CONNECT==='true',host:process.env.HOST || (production?'0.0.0.0':'127.0.0.1'),base:url.origin,demo,readOnly:process.env.READ_ONLY==='true',allowed:new Set((process.env.ALLOWED_CHATS||'').split(',').map(s=>s.trim()).filter(Boolean))};
}
