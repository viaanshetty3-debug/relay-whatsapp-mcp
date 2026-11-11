import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Store } from '../src/store.js';
import { WhatsApp } from '../src/whatsapp.js';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<200;i++){if(fn())return;await delay(5);}throw new Error('Session event did not settle');}
function fixture(t,{save}={}) {
  const dir=mkdtempSync(resolve(tmpdir(),'relay-session-'));const store=new Store(':memory:');
  mkdirSync(resolve(dir,'auth'));writeFileSync(resolve(dir,'auth','creds.json'),'expired');writeFileSync(resolve(dir,'owner-token'),'keep-token');store.kv('sentinel',{history:'keep'});
  const sockets=[],loaded=[];
  const library={
    default:()=>{const socket={ev:new EventEmitter(),end:()=>{},requestPairingCode:async()=> '1234-5678'};sockets.push(socket);return socket;},
    useMultiFileAuthState:async path=>{loaded.push(existsSync(resolve(path,'creds.json'))?readFileSync(resolve(path,'creds.json'),'utf8'):null);return {state:{creds:{},keys:{}},saveCreds:save || (async()=>{})};},
    makeCacheableSignalKeyStore:keys=>keys,Browsers:{ubuntu:()=>['Ubuntu','Chrome','1']},DisconnectReason:{loggedOut:401,restartRequired:515},BufferJSON:{}
  };
  const wa=new WhatsApp(store,{dir,allowed:new Set(),demo:false},library);
  t.after(async()=>{await wa.stop();store.close();rmSync(dir,{recursive:true,force:true});});
  return {dir,store,wa,sockets,loaded};
}
function close(socket,code){socket.ev.emit('connection.update',{connection:'close',lastDisconnect:{error:{output:{statusCode:code}}}});}
test('retrying a rejected session clears only invalid WhatsApp auth and generates a new QR',async t=>{
  const {wa,sockets,loaded,dir,store}=fixture(t);await wa.start();close(sockets[0],401);await until(()=>wa.state==='logged_out');
  assert.ok(existsSync(resolve(dir,'auth-invalid')));assert.equal(wa.stopped,true);assert.equal(wa.retry,undefined);
  await wa.start();assert.deepEqual(loaded,['expired',null]);assert.equal(existsSync(resolve(dir,'auth-invalid')),false);
  assert.equal(readFileSync(resolve(dir,'owner-token'),'utf8'),'keep-token');assert.equal(store.kv('sentinel').history,'keep');
  sockets[1].ev.emit('connection.update',{qr:'fresh-pairing-qr'});await until(()=>wa.state==='pairing');assert.ok(wa.qr.startsWith('data:image/png;base64,'));assert.equal(wa.error,null);
  assert.deepEqual(await wa.pair('6591234567'),{code:'1234-5678'});
  // Events from the failed socket cannot replace the new pairing state.
  close(sockets[0],401);await delay(10);assert.equal(wa.state,'pairing');
});
test('a rejected-session marker survives bridge restarts',async t=>{
  const {wa,loaded,dir}=fixture(t);writeFileSync(resolve(dir,'auth-invalid'),'logged_out\n');await wa.start();assert.deepEqual(loaded,[null]);assert.equal(wa.state,'connecting');
});
test('normal post-pairing restarts preserve the saved authentication',async t=>{
  const {wa,sockets,loaded,dir}=fixture(t);await wa.start();close(sockets[0],515);await until(()=>wa.state==='disconnected');
  assert.equal(existsSync(resolve(dir,'auth-invalid')),false);assert.ok(wa.retry);await wa.start();assert.deepEqual(loaded,['expired','expired']);
});
test('logout waits for credential writes before resetting the session',async t=>{
  let release;const blocked=new Promise(r=>{release=r;});let done=false;
  const {wa,sockets,dir,loaded}=fixture(t,{save:async()=>{await blocked;writeFileSync(resolve(dir,'auth','late.json'),'saved');done=true;}});
  await wa.start();sockets[0].ev.emit('creds.update',{});await delay(5);close(sockets[0],401);await delay(5);assert.equal(wa.state,'connecting');
  release();await until(()=>wa.state==='logged_out');assert.equal(done,true);await wa.start();assert.deepEqual(loaded,['expired',null]);assert.equal(existsSync(resolve(dir,'auth','late.json')),false);
});
test('hosted reconnect resumes registered credentials, while rejected sessions still need pairing',async t=>{
  const {wa,dir}=fixture(t);assert.equal(wa.hasSavedSession(),false);
  writeFileSync(resolve(dir,'auth','creds.json'),JSON.stringify({registered:true,me:{id:'15550000000:1@s.whatsapp.net'}}));assert.equal(wa.hasSavedSession(),true);
  writeFileSync(resolve(dir,'auth-invalid'),'logged_out\n');assert.equal(wa.hasSavedSession(),false);
});

test('saved QR pairing resumes without registered flag; pending phone codes do not',async t=>{
  const {wa,dir}=fixture(t);
  const credentials={registered:false,me:{id:'15550000000:1@s.whatsapp.net'},account:{accountSignature:{type:'Buffer',data:[1,2]},deviceSignature:{type:'Buffer',data:[3,4]}}};
  writeFileSync(resolve(dir,'auth','creds.json'),JSON.stringify(credentials));assert.equal(wa.hasSavedSession(),true);
  writeFileSync(resolve(dir,'auth','creds.json'),JSON.stringify({registered:false,me:{id:'15550000000@s.whatsapp.net',name:'~'},pairingCode:'test-code'}));assert.equal(wa.hasSavedSession(),false);
});
