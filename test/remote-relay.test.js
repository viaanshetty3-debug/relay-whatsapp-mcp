import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {Store} from '../src/store.js';
import {DemoWhatsApp} from '../src/demo.js';
import {Bridge} from '../src/tools.js';
import {createApp} from '../src/server.js';
import {WhatsAppBroker} from '../relay-worker/src/lib/whatsapp-broker.mjs';
import {RemoteAgent,compactMediaResponse,FAILOVER_SILENT_MS,FAILOVER_WATCH_MS,FAILOVER_SETTLE_MS,FAILOVER_POLL_MS} from '../src/remote-agent.js';
import {seal,open,parts} from '../src/remote-protocol.js';
const key=()=>randomBytes(32).toString('base64url');
class DB {
  constructor(){this.raw=new DatabaseSync(':memory:');}
  async exec(sql){this.raw.exec(sql);}
  prepare(sql){const db=this;let values=[];return {bind(...args){values=args;return this;},async first(){return db.raw.prepare(sql).get(...values)||null;},async all(){return {results:db.raw.prepare(sql).all(...values)};},async run(){const result=db.raw.prepare(sql).run(...values);return {meta:{changes:Number(result.changes)}};}};}
  async batch(statements){const results=[];for(const statement of statements)results.push(await statement.run());return results;}
}
async function until(fn){for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,5));}throw new Error('Relay did not settle');}
function fixture(t,options={}){
  const db=new DB(),env={DB:db,WA_AGENT_KEY:key(),WA_CLIENT_KEY:key(),WA_OWNER_EMAIL:'owner@example.test'};
  const catalog=JSON.parse(readFileSync(new URL('../relay-worker/src/lib/whatsapp-tools.json',import.meta.url),'utf8'));
  const broker=new WhatsAppBroker(env,catalog,{wait:()=>new Promise(r=>setTimeout(r,5)),...options});t.after(()=>db.raw.close());
  const request=(path,body,headers={})=>new Request('https://relay.example.test'+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  const owner=body=>broker.handle(request('/mcp',body,{'oai-authenticated-user-email':'owner@example.test'}));
  return {db,env,catalog,broker,request,owner};
}
test('private relay discovery exposes all 37 real schemas and rejects unauthorized accounts',async t=>{
  const {broker,request,owner,catalog,env}=fixture(t);
  assert.equal((await broker.handle(request('/mcp',{jsonrpc:'2.0',id:1,method:'tools/list'}))).status,403);
  assert.equal((await broker.handle(request('/mcp',{jsonrpc:'2.0',id:1,method:'tools/list'},{'oai-authenticated-user-email':'someone-else@example.test'}))).status,403);
  const result=await (await owner({jsonrpc:'2.0',id:1,method:'tools/list'})).json();assert.equal(result.result.tools.length,37);assert.deepEqual(result.result.tools,catalog);
  assert.ok(result.result.tools.find(t=>t.name==='analyze_media').inputSchema.properties.mode.enum.includes('cache'));
  const claude=await broker.handle(request('/mcp',{jsonrpc:'2.0',id:2,method:'tools/list'},{'X-Relay-Client-Key':env.WA_CLIENT_KEY}));assert.equal(claude.status,200);
  const external=await broker.handle(request('/whatsapp/mcp',{jsonrpc:'2.0',id:3,method:'tools/list'},{'X-Relay-Client-Key':env.WA_CLIENT_KEY}));assert.equal(external.status,200);assert.equal((await external.json()).result.tools.length,37);
  assert.equal((await owner(null)).status,400);
});
test('Mac agent and hosted relay forward a harmless MCP call with encrypted queue records and no duplicate execution',async t=>{
  const {db,broker,env,owner,request}=fixture(t),dir=mkdtempSync(resolve(tmpdir(),'relay-agent-'));writeFileSync(resolve(dir,'owner-token'),'test-owner-token');
  t.after(()=>rmSync(dir,{recursive:true,force:true}));let executions=0;
  const settings={remoteUrl:'https://relay.example.test',localUrl:'http://127.0.0.1:8787',agentKey:env.WA_AGENT_KEY,siteAccessKey:'test-site-key',agentId:randomUUID(),dataDir:dir};
  const agent=new RemoteAgent(settings,{log:()=>{},fetchImpl:async(url,options={})=>{
    if(url.endsWith('/api/state'))return Response.json({state:'connected',tools:Array(37).fill({})});
    if(url==='http://127.0.0.1:8787/mcp'){assert.equal(options.headers.Authorization,'Bearer test-owner-token');const body=JSON.parse(options.body);if(body.method==='initialize')return Response.json({jsonrpc:'2.0',id:body.id,result:{protocolVersion:'2025-11-25'}});executions++;return Response.json({jsonrpc:'2.0',id:body.id,result:{content:[{type:'text',text:'private fixture result'}]}});}
    assert.equal(options.headers['OAI-Sites-Authorization'],'Bearer test-site-key');return broker.handle(new Request(url,options));
  }});
  t.after(()=>agent.stop());await agent.poll();
  const response=owner({jsonrpc:'2.0',id:9,method:'tools/call',params:{name:'status',arguments:{privateMarker:'do-not-store-plaintext'}}});
  await until(()=>db.raw.prepare("SELECT COUNT(*) AS n FROM wa_relay_jobs WHERE status='queued'").get().n===1);
  const records=db.raw.prepare('SELECT * FROM wa_relay_parts').all();assert.ok(!JSON.stringify(records).includes('do-not-store-plaintext'));
  await agent.poll();await agent.poll();const result=await (await response).json();assert.equal(result.result.content[0].text,'private fixture result');assert.equal(executions,1);
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM wa_relay_jobs').get().n,0);
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM wa_relay_parts').get().n,0);
});
test('only the configured agent can claim work; a second active agent is refused',async t=>{
  const {broker,request,env}=fixture(t);const first=randomUUID(),second=randomUUID();
  assert.equal((await broker.handle(request('/api/whatsapp/agent/poll',{agent:first},{}))).status,403);
  assert.equal((await broker.handle(request('/api/whatsapp/agent/poll',{agent:first,bridge:{state:'connected',tools:37}},{Authorization:'Bearer '+env.WA_AGENT_KEY}))).status,200);
  assert.equal((await broker.handle(request('/api/whatsapp/agent/poll',{agent:second,bridge:{state:'connected'}},{Authorization:'Bearer '+env.WA_AGENT_KEY}))).status,409);
});
test('timed-out requests are marked expired and never requeued for a possible duplicate send',async t=>{
  const {broker,request,env,owner,db}=fixture(t,{deadline:400});const agent=randomUUID(); // 400 ms: long enough for slow CI machines to claim first
  await broker.handle(request('/api/whatsapp/agent/poll',{agent,bridge:{state:'connected'}},{Authorization:'Bearer '+env.WA_AGENT_KEY}));
  const pending=owner({jsonrpc:'2.0',id:10,method:'tools/call',params:{name:'send_message',arguments:{chat:'15550100001@s.whatsapp.net',text:'fixture'}}});
  await until(()=>db.raw.prepare("SELECT COUNT(*) AS n FROM wa_relay_jobs WHERE status='queued'").get().n===1);
  const claimed=await (await broker.handle(request('/api/whatsapp/agent/poll',{agent},{Authorization:'Bearer '+env.WA_AGENT_KEY}))).json();assert.equal(claimed.jobs.length,1);
  const result=await (await pending).json();assert.equal(result.result.isError,true);assert.match(result.result.content[0].text,/may have executed/);
  const retry=await (await broker.handle(request('/api/whatsapp/agent/poll',{agent},{Authorization:'Bearer '+env.WA_AGENT_KEY}))).json();assert.equal(retry.jobs.length,0);assert.equal(db.raw.prepare('SELECT status FROM wa_relay_jobs').get().status,'expired');
});
test('queue encryption authenticates request identity and large native media becomes a complete-file handle',async()=>{
  const secret=key(),payload=await seal({text:'private'},secret,'request:one');assert.deepEqual(await open(payload,secret,'request:one'),{text:'private'});
  await assert.rejects(open(payload,secret,'request:two'));
  const response={result:{content:[{type:'text',text:JSON.stringify({fileId:randomUUID(),mimeType:'image/png',sizeBytes:500*1024*1024})},{type:'image',mimeType:'image/png',data:'A'.repeat(5*1024*1024+1)}]}};
  const result=compactMediaResponse(response);assert.equal(result.result.content.length,1);assert.equal(JSON.parse(result.result.content[0].text).sizeBytes,500*1024*1024);assert.match(result.result.content[0].text,/read_media_chunk/);
  assert.equal(readFileSync(new URL('../src/remote-protocol.js',import.meta.url),'utf8'),readFileSync(new URL('../relay-worker/src/lib/whatsapp-protocol.mjs',import.meta.url),'utf8'));
});
test('agent health checks do not claim jobs and zero-capacity polls leave work queued',async t=>{
  const {db,broker,request,env}=fixture(t);const agent=randomUUID(),headers={Authorization:'Bearer '+env.WA_AGENT_KEY};
  await broker.handle(request('/api/whatsapp/agent/poll',{agent},headers));
  const job=randomUUID();db.raw.prepare('INSERT INTO wa_relay_jobs(id,status,created,expires,request_parts) VALUES(?,?,?,?,?)').run(job,'queued',Date.now(),Date.now()+90000,1);
  db.raw.prepare('INSERT INTO wa_relay_parts VALUES(?,?,?,?)').run(job,'request',0,'encrypted fixture');
  const health=await (await broker.handle(request('/api/whatsapp/agent/health',{agent},headers))).json();assert.equal(health.online,true);assert.equal(db.raw.prepare('SELECT status FROM wa_relay_jobs WHERE id=?').get(job).status,'queued');
  const poll=await (await broker.handle(request('/api/whatsapp/agent/poll',{agent,capacity:0},headers))).json();assert.equal(poll.jobs.length,0);assert.equal(db.raw.prepare('SELECT status FROM wa_relay_jobs WHERE id=?').get(job).status,'queued');
});
test('2026 hosted requests negotiate a supported local SDK version once across concurrent tool calls',async t=>{
  const {db,broker,env,request}=fixture(t),dir=mkdtempSync(resolve(tmpdir(),'relay-protocol-'));
  const token='regression-owner-token';writeFileSync(resolve(dir,'owner-token'),token);
  const store=new Store(':memory:'),config={token,allowed:new Set(),readOnly:true,demo:true,dir};
  const wa=new DemoWhatsApp(store,config),bridge=new Bridge(store,wa,config),server=createServer();
  await new Promise((accept,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',accept);});
  config.port=server.address().port;config.base='http://127.0.0.1:'+config.port;server.on('request',createApp(bridge,config));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));store.close();rmSync(dir,{recursive:true,force:true});});
  const calls=[];
  const agent=new RemoteAgent({remoteUrl:'https://relay.example.test',localUrl:config.base,agentKey:env.WA_AGENT_KEY,siteAccessKey:'fixture-site-key',agentId:randomUUID(),dataDir:dir},{log:()=>{},fetchImpl:async(url,options)=>{
    if(url.startsWith(config.base)){if(url.endsWith('/mcp'))calls.push({method:JSON.parse(options.body).method,version:options.headers['MCP-Protocol-Version']});return fetch(url,options);}
    return broker.handle(new Request(url,options));
  }});t.after(()=>agent.stop());await agent.poll();
  const remoteHeaders={'oai-authenticated-user-email':env.WA_OWNER_EMAIL,'MCP-Protocol-Version':'2026-07-28'};
  const first=broker.handle(request('/mcp',{jsonrpc:'2.0',id:101,method:'tools/call',params:{name:'status',arguments:{}}},remoteHeaders));
  const second=broker.handle(request('/mcp',{jsonrpc:'2.0',id:102,method:'tools/call',params:{name:'list_chats',arguments:{}}},remoteHeaders));
  await until(()=>db.raw.prepare("SELECT COUNT(*) AS n FROM wa_relay_jobs WHERE status='queued'").get().n===2);await agent.poll();
  const [status,chats]=await Promise.all([first,second].map(async response=>(await response).json()));
  assert.equal(status.result.isError,undefined);assert.equal(JSON.parse(status.result.content[0].text).state,'connected');assert.ok(JSON.parse(chats.result.content[0].text).length);
  assert.equal(calls.filter(c=>c.method==='initialize').length,1);assert.equal(calls.find(c=>c.method==='initialize').version,undefined);
  assert.equal(calls.filter(c=>c.method==='tools/call').length,2);assert.ok(calls.filter(c=>c.method==='tools/call').every(c=>c.version==='2025-11-25'));
});
test('local negotiation errors include the HTTP reason and do not forward or retry a tool call',async t=>{
  const dir=mkdtempSync(resolve(tmpdir(),'relay-protocol-error-'));writeFileSync(resolve(dir,'owner-token'),'fixture-token');t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const methods=[];const agent=new RemoteAgent({remoteUrl:'https://relay.example.test',dataDir:dir},{fetchImpl:async(url,options)=>{methods.push(JSON.parse(options.body).method);return Response.json({error:{code:-32000,message:'Bad Request: Unsupported protocol version: fixture'}},{status:400});}});
  await assert.rejects(agent.localRequest({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'send_message',arguments:{}}},'2026-07-28'),/400.*Unsupported protocol version/);
  assert.deepEqual(methods,['initialize']);assert.equal(agent.localProtocolPromise,null);
});
function failoverPair(t){
  const clock={now:1_000_000};const now=()=>clock.now;
  const {broker,env,db}=fixture(t,{now}),dir=mkdtempSync(resolve(tmpdir(),'relay-failover-'));writeFileSync(resolve(dir,'owner-token'),'fixture-token');
  let bridgeState='connected';
  const fetchImpl=async(url,options={})=>{
    if(url.endsWith('/api/state'))return Response.json({state:bridgeState,tools:[]});
    if(url==='http://127.0.0.1:8787/mcp'){const body=JSON.parse(options.body);return Response.json({jsonrpc:'2.0',id:body.id,result:body.method==='initialize'?{protocolVersion:'2025-11-25'}:{content:[{type:'text',text:'local'}]}});}
    return broker.handle(new Request(url,options));
  };
  const base={remoteUrl:'https://relay.example.test',localUrl:'http://127.0.0.1:8787',agentKey:env.WA_AGENT_KEY,siteAccessKey:'fixture-site-key',dataDir:dir,agentId:randomUUID()};
  const make=role=>new RemoteAgent({...base,failoverRole:role},{fetchImpl,log:()=>{},now,sleep:async ms=>{clock.now+=ms;}});
  const phone=make('standby'),mac=make('primary');
  t.after(()=>{phone.stop();mac.stop();rmSync(dir,{recursive:true,force:true});});
  return {clock,db,phone,mac,setBridge:s=>{bridgeState=s;}};
}
test('failover: phone starts serving within 5 s of the Mac going silent; the shared agent ID is never refused',async t=>{
  const {clock,phone,mac}=failoverPair(t);
  await mac.poll();
  assert.equal(await phone.watchStep(),false);
  clock.now+=FAILOVER_POLL_MS+600;await mac.poll();
  assert.equal(await phone.watchStep(),false,'a moving lastSeen means the primary is alive');
  const silentFrom=clock.now;let takeover=null;
  while(takeover===null&&clock.now-silentFrom<10000){clock.now+=FAILOVER_WATCH_MS;if(await phone.watchStep())takeover=clock.now-silentFrom;}
  assert.ok(takeover!==null&&takeover>=FAILOVER_SILENT_MS&&takeover<5000,'takeover after '+takeover+' ms');
  await phone.poll();await mac.poll();
});
test('failover: a serving phone notices the Mac is back only while the Mac is actually polling',async t=>{
  const {clock,phone,mac}=failoverPair(t);
  await phone.poll();
  assert.equal(await phone.primaryActive(),false,'nobody else polled during the probe');
  phone.sleep=async ms=>{clock.now+=ms;await mac.poll();};
  assert.equal(await phone.primaryActive(),true,'the Mac polled during the probe');
  phone.sleep=async ms=>{clock.now+=ms;};
  assert.equal(await phone.watchStep(),false,'after standing down the phone keeps watching instead of re-serving at once');
});
test('failover: a Mac whose WhatsApp has never connected or is disconnected does not serve',async t=>{
  const {clock,mac,setBridge}=failoverPair(t);
  setBridge('pairing');assert.equal(await mac.primaryReady(),false);clock.now+=10*FAILOVER_SETTLE_MS;assert.equal(await mac.primaryReady(),false);
  setBridge('connected');assert.equal(await mac.primaryReady(),false);clock.now+=FAILOVER_SETTLE_MS;assert.equal(await mac.primaryReady(),true);
  setBridge('disconnected');assert.equal(await mac.primaryReady(),false);
});
function clocked(t,options={}){
  const clock={now:1_000_000};
  const f=fixture(t,{now:()=>clock.now,wait:async ms=>{clock.now+=ms;await new Promise(r=>setTimeout(r,1));},...options});
  const agent=randomUUID(),auth={Authorization:'Bearer '+f.env.WA_AGENT_KEY};
  const poll=(device,extra={})=>f.broker.handle(f.request('/api/whatsapp/agent/poll',{agent,device,bridge:{state:'connected'},...extra},auth)).then(r=>r.json());
  const complete=async(device,job,response)=>{const payload=parts(await seal(response,f.env.WA_AGENT_KEY,job.id+':response'));let res;for(let index=0;index<payload.length;index++)res=await f.broker.handle(f.request('/api/whatsapp/agent/complete',{agent,device,job:job.id,index,total:payload.length,data:payload[index]},auth));return res;};
  const queued=()=>f.db.raw.prepare("SELECT COUNT(*) AS n FROM wa_relay_jobs WHERE status='queued'").get().n;
  return {...f,clock,agent,poll,complete,queued};
}
test('read-only work claimed by a device that goes silent is handed to the other device',async t=>{
  const {owner,poll,complete,queued}=clocked(t);const mac=randomUUID(),phone=randomUUID();
  await poll(mac);
  const pending=owner({jsonrpc:'2.0',id:21,method:'tools/call',params:{name:'list_chats',arguments:{}}});
  await until(()=>queued()===1);
  const [claimed]=(await poll(mac)).jobs;assert.ok(claimed,'the Mac claimed the read');
  let handed;for(let i=0;i<2000&&!handed;i++){await new Promise(r=>setTimeout(r,1));[handed]=(await poll(phone)).jobs;}
  assert.equal(handed?.id,claimed.id,'the phone received the same read-only job after the Mac went silent');
  assert.equal((await complete(mac,claimed,{jsonrpc:'2.0',id:21,result:{content:[{type:'text',text:'stale mac'}]}})).status,409,'the silent Mac can no longer answer it');
  assert.equal((await complete(phone,handed,{jsonrpc:'2.0',id:21,result:{content:[{type:'text',text:'from phone'}]}})).status,200);
  const result=await (await pending).json();assert.equal(result.result.content[0].text,'from phone');
});
test('a write claimed by a device that goes silent is never handed to another device',async t=>{
  const {owner,poll,queued,db,clock}=clocked(t,{deadline:8000});const mac=randomUUID(),phone=randomUUID();
  await poll(mac);
  const pending=owner({jsonrpc:'2.0',id:22,method:'tools/call',params:{name:'send_message',arguments:{chat:'15550100001@s.whatsapp.net',text:'fixture'}}});
  await until(()=>queued()===1);
  assert.equal((await poll(mac)).jobs.length,1);const from=clock.now;
  let stolen=0;while(clock.now-from<6000){await new Promise(r=>setTimeout(r,1));stolen+=(await poll(phone)).jobs.length;}
  assert.equal(stolen,0);assert.equal(db.raw.prepare('SELECT status FROM wa_relay_jobs').get().status,'claimed');
  const result=await (await pending).json();assert.match(result.result.content[0].text,/may have executed/);
});
test('long polls pick up a request that arrives during the wait; old agents get an immediate answer',async t=>{
  const {owner,poll}=clocked(t);const device=randomUUID();
  const idle=await poll(device,{wait:2000});assert.deepEqual([idle.jobs.length,idle.wait],[0,2000]);
  const legacy=await poll(device);assert.equal(legacy.wait,0);
  assert.equal((await poll(device,{wait:2000,capacity:0})).wait,0,'a full agent is never held open');
  const waiting=poll(device,{wait:2000});
  owner({jsonrpc:'2.0',id:23,method:'tools/call',params:{name:'status',arguments:{}}});
  assert.equal((await waiting).jobs.length,1);
});
test('the relay upgrades a database created by the previous version',async t=>{
  const {db,poll,owner,complete,queued}=clocked(t);
  db.raw.exec(`CREATE TABLE wa_relay_state(id INTEGER PRIMARY KEY CHECK(id=1),agent TEXT,seen INTEGER,status TEXT);
    CREATE TABLE wa_relay_jobs(id TEXT PRIMARY KEY,status TEXT,created INTEGER,expires INTEGER,agent TEXT,request_parts INTEGER,response_parts INTEGER DEFAULT 0);
    CREATE TABLE wa_relay_parts(job TEXT,direction TEXT,idx INTEGER,data TEXT,PRIMARY KEY(job,direction,idx));`);
  const device=randomUUID();await poll(device);
  const pending=owner({jsonrpc:'2.0',id:24,method:'tools/call',params:{name:'status',arguments:{}}});
  await until(()=>queued()===1);const [job]=(await poll(device)).jobs;
  await complete(device,job,{jsonrpc:'2.0',id:24,result:{content:[{type:'text',text:'upgraded'}]}});
  assert.equal((await (await pending).json()).result.content[0].text,'upgraded');
});
test('agents send their device ID and only skip the poll pause when the relay long-polls',async t=>{
  const {mac}=failoverPair(t);
  await mac.poll();assert.equal(mac.longPoll,true);
  const legacy=new RemoteAgent({remoteUrl:'https://relay.example.test',agentKey:'k',siteAccessKey:'s',agentId:randomUUID(),deviceId:randomUUID(),dataDir:'/nonexistent'},{log:()=>{},fetchImpl:async(url,options={})=>{if(url.endsWith('/poll')){assert.match(JSON.parse(options.body).device,/^[a-f0-9-]{36}$/);return Response.json({jobs:[]});}return new Response('',{status:503});}});
  t.after(()=>legacy.stop());await legacy.poll({state:'connected',tools:0});assert.equal(legacy.longPoll,false);
});
test('RELAY_* environment variables override the saved link file',async()=>{
  const {settingsFromEnv}=await import('../src/remote-agent.js');
  assert.equal(settingsFromEnv({},null),null);
  const file={remoteUrl:'https://a.example.test',agentKey:'file',agentId:'x',published:true};
  assert.deepEqual(settingsFromEnv({RELAY_AGENT_KEY:'env'},file),{...file,agentKey:'env'});
  assert.equal(settingsFromEnv({RELAY_REMOTE_URL:'https://b.example.test',RELAY_AGENT_KEY:'k',RELAY_AGENT_ID:randomUUID()},null).published,true);
});
