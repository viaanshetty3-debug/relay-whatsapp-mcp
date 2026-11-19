import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { DemoWhatsApp } from '../src/demo.js';
import { Bridge } from '../src/tools.js';
const chat='15550100001@s.whatsapp.net',other='15550100002@s.whatsapp.net';
function fixture(options={}){
  const store=new Store(':memory:');const config={token:'t'.repeat(40),allowed:new Set(),readOnly:false,demo:true,base:'http://127.0.0.1:0',port:0,...options};
  return {store,bridge:new Bridge(store,new DemoWhatsApp(store,config),config)};
}
test('star, pin and delete-for-me work on any message and respect read-only mode',async t=>{
  const {bridge,store}=fixture();t.after(()=>store.close());
  const sent=await bridge.call('send_message',{chat,text:'Keep this',requestId:'m1'});
  await bridge.call('star_message',{chat,id:sent.id,starred:true});assert.equal(store.getMessage(chat,sent.id).starred,true);
  await bridge.call('star_message',{chat,id:sent.id,starred:false});assert.equal(store.getMessage(chat,sent.id).starred,false);
  await bridge.call('pin_message',{chat,id:sent.id,pinned:true,days:7});
  const pinned=store.getMessage(chat,sent.id);assert.equal(pinned.pinned,true);assert.ok(pinned.pinnedUntil>Date.now()/1000);
  await bridge.call('pin_message',{chat,id:sent.id,pinned:false});assert.equal(store.getMessage(chat,sent.id).pinned,false);
  await assert.rejects(bridge.call('pin_message',{chat,id:sent.id,days:3}),/./);
  const gone=await bridge.call('delete_message_for_me',{chat,id:sent.id});assert.equal(gone.status,'removed_for_me');
  assert.equal(store.getMessage(chat,sent.id),undefined);
});
test('the new message tools are write tools: blocked in read-only mode and outside the allowed chats',async t=>{
  const ro=fixture({readOnly:true});t.after(()=>ro.store.close());
  const m=ro.store.message({chat,id:'x1',text:'hi',timestamp:1,fromMe:false,key:{remoteJid:chat,id:'x1'}});
  for(const tool of ['star_message','pin_message','delete_message_for_me'])await assert.rejects(ro.bridge.call(tool,{chat,id:'x1'}),/read-only|READ_ONLY/i);
  const al=fixture({allowed:new Set([chat])});t.after(()=>al.store.close());
  al.store.message({chat:other,id:'y1',text:'hi',timestamp:1,fromMe:false,key:{remoteJid:other,id:'y1'}});
  for(const tool of ['star_message','pin_message','delete_message_for_me'])await assert.rejects(al.bridge.call(tool,{chat:other,id:'y1'}),/ALLOWED_CHATS/);
});
test('message info reports status and who read your message',async t=>{
  const {bridge,store}=fixture();t.after(()=>store.close());
  const sent=await bridge.call('send_message',{chat,text:'Hello',requestId:'i1'});
  store.message({...store.getMessage(chat,sent.id),status:4,receipts:{[other]:{delivered:100,read:200}}});
  const info=await bridge.call('message_info',{chat,id:sent.id});
  assert.equal(info.status,'read');assert.equal(info.receipts[0].read,200);assert.equal(info.fromMe,true);
});
test('send_event and send_contact validate their input and reach the chat',async t=>{
  const {bridge,store}=fixture();t.after(()=>store.close());
  const ev=await bridge.call('send_event',{chat,name:'Study session',startTime:'2026-12-01T18:30:00+08:00'});assert.ok(ev.id);
  await assert.rejects(bridge.call('send_event',{chat,name:'Bad',startTime:'not a date'}),/date and time/);
  await assert.rejects(bridge.call('send_event',{chat,name:'Bad',startTime:'2026-12-01T18:30:00Z',endTime:'2026-12-01T17:00:00Z'}),/after the start/);
  const c=await bridge.call('send_contact',{chat,name:'Sam; Lee',phone:'+65 8123 4567'});assert.ok(c.id);
  await assert.rejects(bridge.call('send_contact',{chat,name:'X',phone:'+12'}),/./);
});
