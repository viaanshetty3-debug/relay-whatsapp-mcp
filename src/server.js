import express from 'express';
import { resolve } from 'node:path';
import { readFileSync,existsSync } from 'node:fs';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mountOAuth } from './oauth.js';
import { mountAccounts } from './accounts.js';
import { mcpServer } from './tools.js';
import { Profiles } from './profiles.js';
import { Spaces } from './spaces.js';
import { createCloud } from './cloud.js';
import { root } from './config.js';
import { localServerEntry, addToClaudeDesktop, addToClaudeCode } from './clients.js';

// Accepts a Bridge, a Profiles (one account) or a Spaces (several accounts on this computer).
export function createApp(source,config) {
  const spaces=source instanceof Spaces?source:new Spaces(config,source instanceof Profiles?source:new Profiles(config,source));
  // Every /api and /mcp request belongs to one account (q.space, set when it is authenticated).
  // Which WhatsApp in that account a dashboard request is about: ?profile=<id> (default: main).
  const pick=q=>q.space.profiles.get(typeof q.query.profile==='string'?q.query.profile:undefined).bridge;
  const slug=s=>String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,24);
  // The name an account's WhatsApp gets inside Claude: "whatsapp", or "whatsapp-<email>" for further accounts.
  const serverName=space=>space.id==='default'?'whatsapp':'whatsapp-'+(slug(accounts.ownerOf(space)?.email)||space.id);
  const localEntry=space=>localServerEntry(config,space.id==='default'?{}:{account:space.id});
  const app=express();app.disable('x-powered-by');
  if(config.production)app.set('trust proxy',1); // hosted: one proxy in front; req.ip is the visitor
  const remoteSummary=()=>{try{if(!config.dir)return null;const settings=JSON.parse(readFileSync(resolve(config.dir,'remote-link.json'),'utf8'));return {published:settings.published===true,base:settings.remoteUrl,claudeMcpUrl:settings.remoteUrl+'/whatsapp/mcp'};}catch{return null;}};
  const publicOrigin=new URL(config.base).origin;
  const hosts=new Set([new URL(config.base).host,`127.0.0.1:${config.port}`,`localhost:${config.port}`]);
  const origins=new Set([publicOrigin,`http://127.0.0.1:${config.port}`,`http://localhost:${config.port}`]);
  const rates=new Map();
  const sweep=setInterval(()=>{const now=Date.now();for(const [k,v] of rates)if(now>v.reset)rates.delete(k);},60000);sweep.unref();
  app.use((q,r,next)=>{
    r.set({'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'",'Cache-Control':'no-store'});
    if(q.method==='GET' && q.path==='/healthz' && (hosts.has(q.headers.host)||q.headers.host==='healthcheck.railway.app'))return r.json({ok:true});
    if(!hosts.has(q.headers.host))return r.status(403).json({error:'Invalid Host. Set PUBLIC_URL to your public HTTPS origin.'});
    if(q.headers.origin&&!origins.has(q.headers.origin))return r.status(403).json({error:'Origin not allowed'});
    if(q.path.startsWith('/oauth/') || q.path.startsWith('/auth/') || q.path.startsWith('/api/') || q.path==='/mcp'){
      const key=q.ip||q.socket.remoteAddress;let entry=rates.get(key);if(!entry || Date.now()>entry.reset){entry={count:0,reset:Date.now()+60000};rates.set(key,entry);}
      if(++entry.count>600)return r.status(429).json({error:'Too many requests. Retry in a minute.'});
    }
    next();
  });
  const cloud=createCloud(config,spaces);
  // Accounts that follow their owner pick up changes from other computers at start and twice an hour.
  const syncAll=()=>{for(const s of spaces.all())cloud.sync(s).catch(()=>{});};
  setTimeout(syncAll,5000).unref();setInterval(syncAll,30*60000).unref();
  const accounts=mountAccounts(app,config,spaces,{cloud});
  const auth=mountOAuth(app,config,spaces,accounts);
  const owner=(q,r,next)=>auth(q,r,()=>q.owner?next():r.status(403).json({error:'Owner token required'}));
  app.use('/api',owner,express.json({limit:'24mb'}));
  app.get('/api/state',(q,r)=>{const b=pick(q),s=q.space;r.json({ ...b.wa.status(),qr:b.wa.qr,cursor:b.store.cursor(),profiles:s.profiles.list(),account:{id:s.id,email:accounts.ownerOf(s)?.email,first:s.id==='default',hasPassword:accounts.hasPassword(s)},setup:cloud.setup(s),readOnly:config.readOnly,base:config.base,remote:s.id==='default'?remoteSummary():null,localConfig:{mcpServers:{[serverName(s)]:localEntry(s)}},localApps:!config.production,tools:s.router.definitions.map(t=>({name:t.name,description:t.description,write:t.write})),allowedChats:[...config.allowed]});});
  app.get('/api/profiles',(q,r)=>r.json(q.space.profiles.list()));
  app.post('/api/profiles',(q,r)=>r.status(201).json(q.space.profiles.create(q.body?.name)));
  app.post('/api/profiles/:id/rename',(q,r)=>r.json(q.space.profiles.rename(q.params.id,q.body?.name)));
  app.post('/api/profiles/:id/remove',async(q,r)=>r.json(await q.space.profiles.remove(q.params.id)));
  // ----- an account that follows its owner to other computers (cloud.js) -----
  app.get('/api/sync',(q,r)=>r.json(cloud.status(q.space)));
  app.post('/api/sync/start',async(q,r)=>{
    // An account made with Google, GitHub and so on has no password yet: the one chosen here becomes it.
    const first=!accounts.hasPassword(q.space);
    if(first){const problem=await accounts.setFirstPassword(q.space,q.body?.password,{check:true});if(problem)return r.status(400).json({error:problem});}
    else if(!(await accounts.checkPassword(q.space,q.body?.password)))return r.status(401).json({error:'Wrong password.'});
    const started=await cloud.start(q.space,accounts.ownerOf(q.space),q.body.password);
    if(first)await accounts.setFirstPassword(q.space,q.body.password);
    r.json(started);
  });
  app.post('/api/sync/confirm',async(q,r)=>r.json(await cloud.confirm(q.space,q.body?.code,accounts.ownerOf(q.space),{replace:q.body?.replace===true})));
  app.post('/api/sync/now',async(q,r)=>r.json(await cloud.sync(q.space)));
  app.post('/api/sync/off',async(q,r)=>r.json(await cloud.off(q.space)));
  app.post('/api/setup/done',(q,r)=>r.json(cloud.setupDone(q.space)));
  app.get('/api/remote-settings',(q,r)=>{
    if(q.space.id!=='default')return r.json({published:false}); // the relay link serves the first account
    const path=resolve(config.dir,'remote-link.json');
    if(!existsSync(path))return r.json({published:false});
    const settings=JSON.parse(readFileSync(path,'utf8'));
    if(settings.published!==true)return r.json({published:false,remoteUrl:settings.remoteUrl});
    r.json({published:settings.published===true,remoteUrl:settings.remoteUrl,chatgptPluginUrl:settings.chatgptPluginUrl||null,siteAccessKey:settings.siteAccessKey,clientKey:settings.clientKey});
  });
  // AI clients this account has approved. (With one account, also clients that registered but were never approved.)
  const registry=()=>spaces.default.store.kv('oauth:clients') || {};
  const uses=(space,id)=>Object.values(space.store.kv('oauth:tokens') || {}).some(t=>t.clientId===id);
  app.get('/api/clients',(q,r)=>r.json(Object.values(registry()).filter(c=>uses(q.space,c.client_id) || spaces.all().length===1).map(c=>({id:c.client_id,name:c.client_name}))));
  app.post('/api/clients/:id/revoke',(q,r)=>{
    const tokens=q.space.store.kv('oauth:tokens') || {};for(const [key,value] of Object.entries(tokens))if(value.clientId===q.params.id)delete tokens[key];q.space.store.kv('oauth:tokens',tokens);
    // Forget the client itself once no account uses it.
    if(!spaces.all().some(s=>uses(s,q.params.id))){const clients=registry();delete clients[q.params.id];spaces.default.store.kv('oauth:clients',clients);}
    r.json({revoked:true});
  });
  // One-click setup for AI apps on this same computer (not offered on hosted deployments).
  app.post('/api/local-apps/:app',(q,r)=>{
    if(config.production)return r.status(404).json({error:'Not available on a hosted Relay'});
    const name=serverName(q.space),entry=localEntry(q.space);
    if(q.params.app==='claude-desktop'){const out=addToClaudeDesktop(config,{name,entry,...(config.claudeDesktopPath?{path:config.claudeDesktopPath}:{})});cloud.noteApp(q.space,'claudeDesktop');return r.json({...out,name});}
    if(q.params.app==='claude-code'){const out=addToClaudeCode(config,{name,entry,...(config.run?{run:config.run}:{})});if(out.added)cloud.noteApp(q.space,'claudeCode');return r.json({...out,name});}
    r.status(404).json({error:'Unknown app'});
  });
  app.post('/api/connect',async (q,r)=>r.json(await pick(q).wa.start()));
  app.post('/api/disconnect',async(q,r)=>{await pick(q).wa.stop();r.json({ok:true});});
  app.post('/api/history',async(q,r)=>{const b=pick(q);if(!b.wa.loadOlder)return r.status(400).json({error:'Older messages can\'t be loaded in demo mode.'});const chat=String(q.body?.chat||'');b.check(chat);r.json(await b.wa.loadOlder(chat));});
  app.post('/api/pair',async(q,r)=>r.json(await pick(q).wa.pair(String(q.body?.phone || ''))));
  app.post('/api/tools/:name',async(q,r)=>r.json({result:await q.space.router.call(q.params.name,q.body || {},typeof q.query.profile==='string'?q.query.profile:undefined)}));
  app.get('/api/media/:fileId',(q,r,next)=>{try{const entry=pick(q).mediaFile(q.params.fileId);if(!entry.complete)throw new Error('Upload is incomplete');r.set('Content-Type',entry.mimeType);r.sendFile(entry.path,error=>{if(error)next(error);});}catch(error){next(error);}});
  app.get('/api/events',(q,r)=>{
    const bridge=pick(q);
    let cursor=Number(q.query.after || 0);if(!Number.isSafeInteger(cursor)||cursor<0)return r.status(400).json({error:'Invalid cursor'});
    r.set({'Content-Type':'text/event-stream','Connection':'keep-alive','X-Accel-Buffering':'no'});r.flushHeaders();
    const flush=()=>{
      let page;
      do{page=bridge.updates(cursor,undefined,100);for(const e of page.events)r.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);const changed=page.cursor!==cursor;cursor=page.cursor;if(!changed)break;}while(page.events.length===100);
    };
    const state=()=>r.write(`event: status\ndata: ${JSON.stringify(bridge.wa.status())}\n\n`);
    bridge.store.on('update',flush);bridge.wa.on('status',state);flush();state();
    const keep=setInterval(()=>r.write(': keepalive\n\n'),15000);
    q.on('close',()=>{clearInterval(keep);bridge.store.off('update',flush);bridge.wa.off('status',state);});
  });
  app.post('/mcp',auth,express.json({limit:'24mb'}),async(q,r)=>{
    const server=mcpServer(q.space.router);
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
    r.on('close',()=>{transport.close().catch(()=>{});server.close().catch(()=>{});});
    await server.connect(transport);await transport.handleRequest(q,r,q.body);
  });
  app.all('/mcp',auth,(_q,r)=>r.status(405).set('Allow','POST').json({error:'Use Streamable HTTP POST'}));
  app.use(express.static(resolve(root,'public'),{etag:false}));
  app.use((e,_q,r,_next)=>{if(!r.headersSent)r.status(e.status || 400).json({error:e.message || 'Request failed'});});
  return app;
}
