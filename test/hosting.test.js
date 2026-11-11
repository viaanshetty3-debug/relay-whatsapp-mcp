import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, request } from 'node:http';
import { config } from '../src/config.js';
import { Store } from '../src/store.js';
import { Bridge } from '../src/tools.js';
import { DemoWhatsApp } from '../src/demo.js';
import { createApp } from '../src/server.js';
function configured(values,fn){
  const keys=['NODE_ENV','BRIDGE_TOKEN','PUBLIC_URL','RAILWAY_PUBLIC_DOMAIN','RENDER_EXTERNAL_URL','HOST','PORT','DATA_DIR','AUTO_CONNECT'];
  const previous=Object.fromEntries(keys.map(k=>[k,process.env[k]]));const dir=mkdtempSync(resolve(tmpdir(),'relay-hosting-'));
  try{for(const k of keys)delete process.env[k];Object.assign(process.env,{DATA_DIR:dir,...values});return fn();}
  finally{for(const k of keys){if(previous[k]===undefined)delete process.env[k];else process.env[k]=previous[k];}rmSync(dir,{recursive:true,force:true});}
}
test('production requires a secret owner token and HTTPS',()=>{
  configured({NODE_ENV:'production'},()=>assert.throws(()=>config(),/BRIDGE_TOKEN/));
  configured({NODE_ENV:'production',BRIDGE_TOKEN:'x'.repeat(40)},()=>assert.throws(()=>config(),/HTTPS/));
});
test('Railway domain configures a fixed public origin and production listening address',()=>{
  configured({NODE_ENV:'production',BRIDGE_TOKEN:'x'.repeat(40),RAILWAY_PUBLIC_DOMAIN:'relay-example.up.railway.app',PORT:'3000',AUTO_CONNECT:'true'},()=>{
    const c=config();assert.equal(c.base,'https://relay-example.up.railway.app');assert.equal(c.host,'0.0.0.0');assert.equal(c.port,3000);assert.equal(c.autoConnect,true);assert.equal(c.production,true);
  });
});
test('explicit domain overrides host-provided domain; invalid ports are rejected',()=>{
  configured({PUBLIC_URL:'https://relay.example.com',RAILWAY_PUBLIC_DOMAIN:'relay-example.up.railway.app'},()=>assert.equal(config().base,'https://relay.example.com'));
  for(const port of ['0','65536','abc'])configured({PORT:port},()=>assert.throws(()=>config(),/PORT/));
});
test('health-check hostname cannot access admin routes or expose private status',async t=>{
  const store=new Store(':memory:'),server=createServer();server.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const port=server.address().port,c={port,base:'https://relay-example.up.railway.app',token:'x'.repeat(40),allowed:new Set(),readOnly:false,demo:true};
  server.on('request',createApp(new Bridge(store,new DemoWhatsApp(store,c),c),c));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));store.close();});
  const get=path=>new Promise((resolve,reject)=>{
    request({hostname:'127.0.0.1',port,path,headers:{Host:'healthcheck.railway.app'}},r=>{let body='';r.on('data',c=>body+=c);r.on('end',()=>resolve({status:r.statusCode,body:JSON.parse(body)}));}).on('error',reject).end();
  });
  assert.deepEqual(await get('/healthz'),{status:200,body:{ok:true}});assert.equal((await get('/api/state')).status,403);assert.equal((await get('/mcp')).status,403);
});
