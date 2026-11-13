import express from 'express';
import { resolve } from 'node:path';
import { readFileSync,existsSync } from 'node:fs';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mountOAuth } from './oauth.js';
import { mountAccounts } from './accounts.js';
import { mcpServer } from './tools.js';
import { Profiles, ProfileRouter } from './profiles.js';
import { root } from './config.js';
import { localServerEntry, addToClaudeDesktop, addToClaudeCode } from './clients.js';

export function createApp(bridgeOrProfiles,config) {
  const profiles=bridgeOrProfiles instanceof Profiles?bridgeOrProfiles:new Profiles(config,bridgeOrProfiles);
  const router=new ProfileRouter(profiles);
  const bridge=profiles.main.bridge; // accounts and AI-client approvals live with the main profile
  // Which WhatsApp a dashboard request is about: ?profile=<id> (default: main).
  const pick=q=>profiles.get(typeof q.query.profile==='string'?q.query.profile:undefined).bridge;
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
  const accounts=mountAccounts(app,config,bridge.store);
  const auth=mountOAuth(app,config,bridge.store,accounts);
  const owner=(q,r,next)=>auth(q,r,()=>q.owner?next():r.status(403).json({error:'Owner token required'}));
  app.use('/api',owner,express.json({limit:'24mb'}));
  app.get('/api/state',(q,r)=>{const b=pick(q);r.json({ ...b.wa.status(),qr:b.wa.qr,cursor:b.store.cursor(),profiles:profiles.list(),readOnly:config.readOnly,base:config.base,remote:remoteSummary(),localConfig:{mcpServers:{whatsapp:localServerEntry(config)}},localApps:!config.production,tools:router.definitions.map(t=>({name:t.name,description:t.description,write:t.write})),allowedChats:[...config.allowed]});});
  app.get('/api/profiles',(_q,r)=>r.json(profiles.list()));
  app.post('/api/profiles',(q,r)=>r.status(201).json(profiles.create(q.body?.name)));
  app.post('/api/profiles/:id/rename',(q,r)=>r.json(profiles.rename(q.params.id,q.body?.name)));
  app.post('/api/profiles/:id/remove',async(q,r)=>r.json(await profiles.remove(q.params.id)));
  app.get('/api/remote-settings',(_q,r)=>{
    const path=resolve(config.dir,'remote-link.json');
    if(!existsSync(path))return r.json({published:false});
    const settings=JSON.parse(readFileSync(path,'utf8'));
    if(settings.published!==true)return r.json({published:false,remoteUrl:settings.remoteUrl});
    r.json({published:settings.published===true,remoteUrl:settings.remoteUrl,chatgptPluginUrl:settings.chatgptPluginUrl||null,siteAccessKey:settings.siteAccessKey,clientKey:settings.clientKey});
  });
  app.get('/api/clients',(_q,r)=>r.json(Object.values(bridge.store.kv('oauth:clients') || {}).map(c=>({id:c.client_id,name:c.client_name}))));
  app.post('/api/clients/:id/revoke',(q,r)=>{
    const clients=bridge.store.kv('oauth:clients') || {};delete clients[q.params.id];bridge.store.kv('oauth:clients',clients);
    const tokens=bridge.store.kv('oauth:tokens') || {};for(const [key,value] of Object.entries(tokens))if(value.clientId===q.params.id)delete tokens[key];bridge.store.kv('oauth:tokens',tokens);r.json({revoked:true});
  });
  // One-click setup for AI apps on this same computer (not offered on hosted deployments).
  app.post('/api/local-apps/:app',(q,r)=>{
    if(config.production)return r.status(404).json({error:'Not available on a hosted Relay'});
    if(q.params.app==='claude-desktop')return r.json(addToClaudeDesktop(config));
    if(q.params.app==='claude-code')return r.json(addToClaudeCode(config));
    r.status(404).json({error:'Unknown app'});
  });
  app.post('/api/connect',async (q,r)=>r.json(await pick(q).wa.start()));
  app.post('/api/disconnect',async(q,r)=>{await pick(q).wa.stop();r.json({ok:true});});
  app.post('/api/history',async(q,r)=>{const b=pick(q);if(!b.wa.loadOlder)return r.status(400).json({error:'Older messages can\'t be loaded in demo mode.'});const chat=String(q.body?.chat||'');b.check(chat);r.json(await b.wa.loadOlder(chat));});
  app.post('/api/pair',async(q,r)=>r.json(await pick(q).wa.pair(String(q.body?.phone || ''))));
  app.post('/api/tools/:name',async(q,r)=>r.json({result:await router.call(q.params.name,q.body || {},typeof q.query.profile==='string'?q.query.profile:undefined)}));
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
    const server=mcpServer(router);
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
    r.on('close',()=>{transport.close().catch(()=>{});server.close().catch(()=>{});});
    await server.connect(transport);await transport.handleRequest(q,r,q.body);
  });
  app.all('/mcp',auth,(_q,r)=>r.status(405).set('Allow','POST').json({error:'Use Streamable HTTP POST'}));
  app.use(express.static(resolve(root,'public'),{etag:false}));
  app.use((e,_q,r,_next)=>{if(!r.headersSent)r.status(e.status || 400).json({error:e.message || 'Request failed'});});
  return app;
}
