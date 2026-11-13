import test from 'node:test';
import { createServer, request as httpRequest } from 'node:http';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Store } from '../src/store.js';
import { DemoWhatsApp } from '../src/demo.js';
import { Bridge, mcpServer } from '../src/tools.js';
import { createApp } from '../src/server.js';
import { digest } from '../src/oauth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
const chat='15550100001@s.whatsapp.net',other='15550100002@s.whatsapp.net';
function fixture(options={}) {
  const store=new Store(':memory:');const config={token:'test-token-'.repeat(5),allowed:new Set(),readOnly:false,demo:true,base:'http://127.0.0.1:0',port:0,...options};
  const wa=new DemoWhatsApp(store,config),bridge=new Bridge(store,wa,config);
  return {store,wa,bridge,config};
}
test('send, reply, edit, react, delete and raw payload handling',async t=>{
  const {bridge,store}=fixture();t.after(()=>store.close());
  const sent=await bridge.call('send_message',{chat,text:'First version',requestId:'a'});
  assert.equal(store.getMessage(chat,sent.id).text,'First version');
  const duplicate=await bridge.call('send_message',{chat,text:'First version',requestId:'a'});assert.equal(duplicate.id,sent.id);
  await assert.rejects(bridge.call('send_message',{chat,text:'Different message',requestId:'a'}),/different content/);
  const reply=await bridge.call('send_message',{chat,text:'A reply',replyTo:sent.id});assert.ok(reply.id);
  await bridge.call('edit_message',{chat,id:sent.id,text:'Revised'});assert.equal(store.getMessage(chat,sent.id).text,'Revised');
  await bridge.call('react_message',{chat,id:sent.id,emoji:'👍'});
  await bridge.call('delete_message',{chat,id:sent.id});assert.equal(store.getMessage(chat,sent.id).deleted,true);
  const result=await bridge.call('get_messages',{chat});assert.ok(result.every(m=>!('raw' in m)));
});
test('edits and deletions reject messages from other senders and expired edits',async t=>{
  const {bridge,store,wa}=fixture();t.after(()=>store.close());
  const incoming=wa.insert(chat,'incoming',false);
  await assert.rejects(bridge.call('edit_message',{chat,id:incoming.id,text:'Changed'}),/your own/);
  await assert.rejects(bridge.call('delete_message',{chat,id:incoming.id}),/your own/);
  const old=wa.insert(chat,'old',true,Math.floor(Date.now()/1000)-901);
  await assert.rejects(bridge.call('edit_message',{chat,id:old.id,text:'Changed'}),/15-minute/);
});
test('allowlist applies to every chat read, cross-chat search, forwarding, drafts and jobs',async t=>{
  const {bridge,store}=fixture({allowed:new Set([chat])});t.after(()=>store.close());
  assert.deepEqual((await bridge.call('list_chats')).map(c=>c.id),[chat]);
  await assert.rejects(bridge.call('get_messages',{chat:other}),/ALLOWED_CHATS/);
  const results=await bridge.call('search_messages',{query:''});assert.ok(results.length);assert.ok(results.every(m=>m.chat===chat));
  const m=store.messages({chat})[0];await assert.rejects(bridge.call('forward_message',{chat,id:m.id,to:other}),/ALLOWED_CHATS/);
  const draft=store.draft(other,'private');await assert.rejects(bridge.call('delete_draft',{id:draft.id}),/ALLOWED_CHATS/);
  await assert.rejects(bridge.call('save_draft',{chat,text:'steal',id:draft.id}),/ALLOWED_CHATS/);
  const job=store.newJob(other,'private',Date.now()+60000);await assert.rejects(bridge.call('cancel_scheduled',{id:job.id}),/ALLOWED_CHATS/);
});
test('read-only mode blocks writes and scheduling while preserving reads',async t=>{
  const {bridge,store}=fixture({readOnly:true});t.after(()=>store.close());
  for(const tool of ['send_message','save_draft'])await assert.rejects(bridge.call(tool,{chat,text:'no'}),/read-only/);
  await assert.rejects(bridge.call('schedule_message',{chat,text:'no',sendAt:new Date(Date.now()+60000).toISOString()}),/read-only/);
  store.newJob(chat,'not sent',Date.now()-1);await bridge.tick();assert.equal(store.jobs()[0].status,'pending');
  assert.ok((await bridge.call('get_messages',{chat})).length);
});
test('live updates resume without loss across filtered page boundaries',async t=>{
  const {bridge,store}=fixture({allowed:new Set([chat])});t.after(()=>store.close());const after=store.cursor();
  for(let i=0;i<8;i++)store.event('message',i%2?chat:other,{text:String(i)});
  const first=await bridge.call('wait_updates',{after,limit:2});assert.deepEqual(first.events.map(e=>e.data.text),['1','3']);
  const second=await bridge.call('wait_updates',{after:first.cursor,limit:2});assert.deepEqual(second.events.map(e=>e.data.text),['5','7']);
  assert.equal(second.cursor,store.cursor());
});
test('long polling waits for a permitted event and removes listeners',async t=>{
  const {bridge,store}=fixture({allowed:new Set([chat])});t.after(()=>store.close());const after=store.cursor();
  const pending=bridge.call('wait_updates',{after,timeoutSeconds:1});
  store.event('message',other,{text:'private'});store.event('message',chat,{text:'visible'});
  const result=await pending;assert.equal(result.events.length,1);assert.equal(result.events[0].data.text,'visible');assert.equal(store.listenerCount('update'),0);
});
test('search escapes SQL wildcards and supports pagination',async t=>{
  const {bridge,store,wa}=fixture();t.after(()=>store.close());wa.insert(chat,'Literal 100%_discount',false);wa.insert(chat,'Literal 100ANYdiscount',false);
  const literal=await bridge.call('search_messages',{query:'100%_'});assert.equal(literal.length,1);
  const all=await bridge.call('get_messages',{chat,limit:2});const next=await bridge.call('get_messages',{chat,limit:2,offset:2});assert.equal(new Set([...all,...next].map(m=>m.id)).size,4);
});
test('scheduler sends once during overlapping ticks, blocks forbidden jobs, and keeps uncertain failures',async t=>{
  const {bridge,store,wa}=fixture({allowed:new Set([chat])});t.after(()=>store.close());
  const original=wa.send.bind(wa);let attempts=0;wa.send=async(...args)=>{attempts++;await new Promise(r=>setTimeout(r,10));return original(...args);};
  const job=store.newJob(chat,'schedule',Date.now()-1);store.newJob(other,'forbidden',Date.now()-1);
  await Promise.all([bridge.tick(),bridge.tick()]);assert.equal(attempts,1);assert.equal(store.jobs().find(j=>j.id===job.id).status,'sent');assert.equal(store.jobs().find(j=>j.chat===other).status,'failed');
  const failed=store.newJob(chat,'uncertain',Date.now()-1);wa.send=async()=>{throw new Error('Network interrupted');};await bridge.tick();await bridge.tick();assert.equal(store.jobs().find(j=>j.id===failed.id).status,'uncertain');
});
test('pending jobs persist and interrupted sends become uncertain on restart',()=>{
  const dir=mkdtempSync(resolve(tmpdir(),'relay-test-'));try{
    let s=new Store(resolve(dir,'test.sqlite'));const p=s.newJob(chat,'pending',Date.now()+1000),u=s.newJob(chat,'in progress',Date.now());s.updateJob(u.id,'sending');s.close();
    s=new Store(resolve(dir,'test.sqlite'));assert.equal(s.jobs().find(j=>j.id===p.id).status,'pending');assert.equal(s.jobs().find(j=>j.id===u.id).status,'uncertain');s.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('failed direct send is not blindly retried with the same idempotency key',async t=>{
  const {bridge,store,wa}=fixture();t.after(()=>store.close());let sends=0;wa.send=async()=>{sends++;throw new Error('Lost connection');};
  await assert.rejects(bridge.call('send_message',{chat,text:'once',requestId:'unique'}),/Lost connection/);
  await assert.rejects(bridge.call('send_message',{chat,text:'once',requestId:'unique'}),/uncertain/);assert.equal(sends,1);
});
test('MCP discovery, resource reads and error flags work through the official SDK',async t=>{
  const {bridge,store}=fixture();const server=mcpServer(bridge);const client=new Client({name:'test-client',version:'1.0'});
  const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
  t.after(async()=>{await client.close();await server.close();store.close();});
  const list=await client.listTools();assert.ok(list.tools.length>=25);assert.equal(list.tools.find(t=>t.name==='send_message').annotations.readOnlyHint,false);
  const result=await client.callTool({name:'get_messages',arguments:{chat}});assert.ok(JSON.parse(result.content[0].text).length);
  const error=await client.callTool({name:'edit_message',arguments:{chat,id:'missing',text:'test'}});assert.equal(error.isError,true);
  const recent=await client.readResource({uri:'whatsapp://recent'});assert.ok(JSON.parse(recent.contents[0].text).length);
});
async function httpFixture(t) {
  const f=fixture();const server=createServer();server.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const port=server.address().port;f.config.port=port;f.config.base='http://127.0.0.1:'+port;
  server.on('request',createApp(f.bridge,f.config));const base=f.config.base;
  const request=(path,options={})=>new Promise((resolve,reject)=>{
    const req=httpRequest(base+path,{method:options.method || 'GET',headers:options.headers},res=>{
      const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:res.headers})));
    });req.on('error',reject);if(options.body)req.write(String(options.body));req.end();
  });
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));f.store.close();});
  return {...f,base,request};
}
test('HTTP blocks unauthenticated access, DNS rebinding, hostile origins, and OAuth tokens on owner routes',async t=>{
  const {request,config,store}=await httpFixture(t);
  assert.equal((await request('/api/state')).status,401);
  assert.equal((await request('/api/state',{headers:{Authorization:'Bearer '+config.token}})).status,200);
  assert.equal((await request('/api/state',{headers:{Host:'attacker.test',Authorization:'Bearer '+config.token}})).status,403);
  assert.equal((await request('/api/state',{headers:{Origin:'https://attacker.test',Authorization:'Bearer '+config.token}})).status,403);
  store.kv('oauth:tokens',{[digest('access')]:{kind:'access',resource:config.base+'/mcp',expires:Date.now()+60000}});
  assert.equal((await request('/api/state',{headers:{Authorization:'Bearer access'}})).status,403);
});
test('remote account setup credentials are owner-only and never expose the Mac agent key',async t=>{
  const {request,config,store}=await httpFixture(t),dir=mkdtempSync(resolve(tmpdir(),'relay-account-setup-'));
  config.dir=dir;t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const file=resolve(dir,'remote-link.json');
  writeFileSync(file,JSON.stringify({published:true,remoteUrl:'https://private.example.test',siteAccessKey:'site-private-key',clientKey:'claude-private-key',agentKey:'mac-agent-private-key'}),{mode:0o600});
  assert.equal((await request('/api/remote-settings')).status,401);
  store.kv('oauth:tokens',{[digest('ai-access')]:{kind:'access',resource:config.base+'/mcp',expires:Date.now()+60000}});
  assert.equal((await request('/api/remote-settings',{headers:{Authorization:'Bearer ai-access'}})).status,403);
  const response=await request('/api/remote-settings',{headers:{Authorization:'Bearer '+config.token}}),settings=await response.json();
  assert.equal(response.status,200);assert.equal(settings.clientKey,'claude-private-key');assert.equal(settings.siteAccessKey,'site-private-key');assert.ok(!('agentKey' in settings));
  const state=await (await request('/api/state',{headers:{Authorization:'Bearer '+config.token}})).json();assert.equal(state.remote.claudeMcpUrl,'https://private.example.test/whatsapp/mcp');assert.ok(!JSON.stringify(state).includes('site-private-key'));assert.ok(!JSON.stringify(state).includes('claude-private-key'));
  writeFileSync(file,JSON.stringify({published:false,remoteUrl:'https://private.example.test',siteAccessKey:'site-private-key',clientKey:'claude-private-key'}));
  const pending=await (await request('/api/remote-settings',{headers:{Authorization:'Bearer '+config.token}})).json();assert.deepEqual(pending,{published:false,remoteUrl:'https://private.example.test'});
});
test('OAuth registration, owner consent, PKCE, single-use codes, and refresh rotation',async t=>{
  const {request,config}=await httpFixture(t);
  const postJSON=(path,body)=>request(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const form=(path,body,more={})=>request(path,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(body),...more});
  assert.equal((await postJSON('/oauth/register',{redirect_uris:['http://evil.test/callback']})).status,400);
  const registration=await postJSON('/oauth/register',{redirect_uris:['https://client.test/callback'],client_name:'Test AI'});assert.equal(registration.status,201);const c=await registration.json();
  const verifier='v'.repeat(43),params=new URLSearchParams({client_id:c.client_id,redirect_uri:c.redirect_uris[0],response_type:'code',code_challenge:digest(verifier),code_challenge_method:'S256',state:'state-123',resource:config.base+'/mcp'});
  const consent=await request('/oauth/authorize?'+params);assert.equal(consent.status,200);const html=await consent.text();const nonce=html.match(/name="nonce" value="([^"]+)"/)[1];
  assert.equal((await form('/oauth/approve',{nonce,token:'wrong'})).status,401);
  const approved=await form('/oauth/approve',{nonce,token:config.token},{redirect:'manual'});assert.equal(approved.status,303);const location=new URL(approved.headers.get('location'));assert.equal(location.searchParams.get('state'),'state-123');
  assert.equal((await form('/oauth/approve',{nonce,token:config.token},{redirect:'manual'})).status,400);
  const args={grant_type:'authorization_code',code:location.searchParams.get('code'),redirect_uri:c.redirect_uris[0],client_id:c.client_id};
  assert.equal((await form('/oauth/token',{...args,code_verifier:'w'.repeat(43)})).status,400);
  const tokenResponse=await form('/oauth/token',{...args,code_verifier:verifier});assert.equal(tokenResponse.status,200);const tokens=await tokenResponse.json();
  assert.equal((await form('/oauth/token',{...args,code_verifier:verifier})).status,400);
  const mcp=await request('/mcp',{method:'POST',headers:{Authorization:'Bearer '+tokens.access_token,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}})});assert.equal(mcp.status,200);assert.ok((await mcp.json()).result.tools.length>=25);
  const refresh={grant_type:'refresh_token',client_id:c.client_id,refresh_token:tokens.refresh_token};const rotated=await form('/oauth/token',refresh);assert.equal(rotated.status,200);
  assert.equal((await form('/oauth/token',refresh)).status,400);
  const old=await request('/mcp',{headers:{Authorization:'Bearer '+tokens.access_token}});assert.equal(old.status,401);
});
test('real WhatsApp adapter normalizes protocol edits and deletes without leaking control messages',async t=>{
  const {WhatsApp}=await import('../src/whatsapp.js');const lib=await import('@whiskeysockets/baileys');const {store,config}=fixture();t.after(()=>store.close());
  const wa=new WhatsApp(store,config);wa.lib=lib;wa.BufferJSON=lib.BufferJSON;wa.sock={user:{id:'15550000000@s.whatsapp.net'}};
  const key={id:'real-message',remoteJid:chat,fromMe:true},timestamp=Math.floor(Date.now()/1000);
  wa.ingest({key,messageTimestamp:timestamp,message:{conversation:'Original'}});
  wa.ingest({key:{...key,id:'edit-control'},messageTimestamp:timestamp+1,message:{protocolMessage:{type:14,key,editedMessage:{conversation:'Changed'}}}});
  assert.equal(store.getMessage(chat,key.id).text,'Changed');assert.equal(store.getMessage(chat,key.id).timestamp,timestamp);assert.equal(store.getMessage(chat,'edit-control'),undefined);
  wa.ingest({key:{...key,id:'delete-control'},message:{protocolMessage:{type:0,key}}});assert.equal(store.getMessage(chat,key.id).deleted,true);assert.equal(store.getMessage(chat,'delete-control'),undefined);
  wa.ingest({key:{...key,id:'history-control'},message:{protocolMessage:{type:5}}});assert.equal(store.getMessage(chat,'history-control'),undefined);
});
test('official MCP HTTP client initializes and calls tools on the running endpoint',async t=>{
  const {base,config}=await httpFixture(t);const client=new Client({name:'http-integration',version:'1.0.0'});
  const transport=new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:'Bearer '+config.token}}});
  await client.connect(transport);t.after(()=>client.close());
  assert.equal((await client.listTools()).tools.length,38);
  const result=await client.callTool({name:'status',arguments:{}});assert.equal(JSON.parse(result.content[0].text).state,'connected');
});
test('owner can revoke a remote client and invalidate all its issued tokens',async t=>{
  const {request,store,config}=await httpFixture(t);store.kv('oauth:clients',{abc:{client_id:'abc',client_name:'Test AI'}});store.kv('oauth:tokens',{[digest('access')]:{clientId:'abc',kind:'access',resource:config.base+'/mcp',expires:Date.now()+60000}});
  const headers={Authorization:'Bearer '+config.token};const list=await request('/api/clients',{headers});assert.equal((await list.json())[0].name,'Test AI');
  assert.equal((await request('/api/clients/abc/revoke',{method:'POST',headers})).status,200);assert.deepEqual(store.kv('oauth:tokens'),{});assert.deepEqual(store.kv('oauth:clients'),{});
});
