import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import worker,{withoutHostAuth} from '../src/index.js';
class DB{constructor(){this.raw=new DatabaseSync(':memory:');}async exec(sql){this.raw.exec(sql);}
  prepare(sql){const db=this;let v=[];return{bind(...a){v=a;return this;},async first(){return db.raw.prepare(sql).get(...v)||null;},async all(){return{results:db.raw.prepare(sql).all(...v)};},async run(){return{meta:{changes:Number(db.raw.prepare(sql).run(...v).changes)}};}};}
  async batch(s){const r=[];for(const x of s)r.push(await x.run());return r;}}
const env=()=>({DB:new DB(),WA_AGENT_KEY:randomBytes(32).toString('base64url'),WA_CLIENT_KEY:'client-key-'+randomBytes(16).toString('hex'),WA_OWNER_EMAIL:'owner@example.test'});
const list=headers=>new Request('https://relay.example.test/whatsapp/mcp',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});
test('a forged ChatGPT Sites owner header is ignored on a standalone worker',async()=>{
  const e=env();
  assert.equal((await worker.fetch(list({'oai-authenticated-user-email':'owner@example.test'}),e)).status,403);
  assert.equal((await worker.fetch(list({'OAI-Authenticated-User-Email':'owner@example.test'}),e)).status,403);
  assert.equal(withoutHostAuth(list({'oai-authenticated-user-email':'x','x-relay-client-key':'k'})).headers.get('oai-authenticated-user-email'),null);
});
test('clients with the relay client key get all 37 tools',async()=>{
  const e=env();const r=await worker.fetch(list({'X-Relay-Client-Key':e.WA_CLIENT_KEY}),e);
  assert.equal(r.status,200);assert.equal((await r.json()).result.tools.length,37);
  assert.equal((await worker.fetch(list({'X-Relay-Client-Key':'wrong'}),e)).status,403);
});
test('health and unknown paths',async()=>{
  const e=env();assert.equal((await worker.fetch(new Request('https://relay.example.test/health'),e)).status,200);
  assert.equal((await worker.fetch(new Request('https://relay.example.test/nope'),e)).status,404);
});
