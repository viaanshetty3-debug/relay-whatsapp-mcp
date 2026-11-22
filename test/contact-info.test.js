// The WhatsApp "Contact info" and "Edit contact" screens as tools (calls excluded).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { DemoWhatsApp } from '../src/demo.js';
import { Bridge } from '../src/tools.js';
const alex='15550100001@s.whatsapp.net',jamie='15550100002@s.whatsapp.net',group='120363000001@g.us';
function fixture(options={}){
  const store=new Store(':memory:');const config={token:'t'.repeat(40),allowed:new Set(),readOnly:false,demo:true,base:'http://127.0.0.1:0',port:0,...options};
  return {store,bridge:new Bridge(store,new DemoWhatsApp(store,config),config)};
}

test('get_contact_info gathers the contact page: about, groups in common, starred, block state',async t=>{
  const {bridge,store}=fixture();t.after(()=>store.close());
  const sent=await bridge.call('send_message',{chat:alex,text:'See https://example.com/notes and http://example.org',requestId:'c1'});
  await bridge.call('star_message',{chat:alex,id:sent.id});
  const info=await bridge.call('get_contact_info',{chat:alex});
  assert.equal(info.phone,'+15550100001');assert.match(info.about,/sample About/);
  assert.deepEqual(info.groupsInCommon.map(g=>g.id),[group]);assert.equal(info.starredMessages,1);assert.equal(info.blocked,false);
  await assert.rejects(bridge.call('get_contact_info',{chat:group}),/not a group/);
  const links=await bridge.call('list_links',{chat:alex});assert.deepEqual(links.map(l=>l.url),['https://example.com/notes','http://example.org']);
  const starred=await bridge.call('list_starred',{});assert.equal(starred.length,1);assert.equal(starred[0].id,sent.id);
});

test('edit, block, disappearing messages, delete contact',async t=>{
  const {bridge,store}=fixture();t.after(()=>store.close());
  const saved=await bridge.call('edit_contact',{chat:alex,firstName:'Alex',lastName:'Morgan',saveOnPhone:true});
  assert.equal(saved.name,'Alex Morgan');assert.equal(store.getRow('contacts',alex).name,'Alex Morgan');
  await bridge.call('block_contact',{chat:alex,blocked:true});assert.equal((await bridge.call('get_contact_info',{chat:alex})).blocked,true);
  await bridge.call('block_contact',{chat:alex,blocked:false});assert.equal((await bridge.call('get_contact_info',{chat:alex})).blocked,false);
  await bridge.call('set_disappearing_messages',{chat:alex,duration:'7d'});assert.equal(store.getChat(alex).ephemeralExpiration,604800);
  await bridge.call('set_disappearing_messages',{chat:alex,duration:'off'});assert.equal(store.getChat(alex).ephemeralExpiration,0);
  await assert.rejects(bridge.call('delete_contact',{chat:alex}),/./);
  assert.equal((await bridge.call('delete_contact',{chat:alex,confirm:true})).status,'contact_deleted');
  assert.equal(store.getRow('contacts',alex).name,undefined);
});

test('clear_chat needs confirm and empties only that chat',async t=>{
  const {bridge,store}=fixture();t.after(()=>store.close());
  const before=store.messages({chat:jamie}).length;assert.ok(before>0);
  await assert.rejects(bridge.call('clear_chat',{chat:alex}),/./);
  const r=await bridge.call('clear_chat',{chat:alex,confirm:true});assert.ok(r.removed>0);
  assert.equal(store.messages({chat:alex}).length,0);assert.equal(store.messages({chat:jamie}).length,before);
});

test('create_group and add_to_group, with chat permissions applied to every participant',async t=>{
  const {bridge,store}=fixture();t.after(()=>store.close());
  const g=await bridge.call('create_group',{subject:'Study group',participants:[alex,'+15550100002']});
  assert.match(g.id,/@g\.us$/);assert.equal(g.participants,2);
  const added=await bridge.call('add_to_group',{chat:group,participants:[jamie]});assert.equal(added.results[0].status,'200');
  await assert.rejects(bridge.call('add_to_group',{chat:alex,participants:[jamie]}),/group chat/);
  const al=fixture({allowed:new Set([group,alex])});t.after(()=>al.store.close());
  await assert.rejects(al.bridge.call('add_to_group',{chat:group,participants:[jamie]}),/ALLOWED_CHATS/);
});

test('the changing contact tools are blocked in read-only mode',async t=>{
  const {bridge,store}=fixture({readOnly:true});t.after(()=>store.close());
  for(const [tool,args] of [['edit_contact',{chat:alex,firstName:'A'}],['block_contact',{chat:alex,blocked:true}],['set_disappearing_messages',{chat:alex,duration:'24h'}],
    ['clear_chat',{chat:alex,confirm:true}],['delete_contact',{chat:alex,confirm:true}],['add_to_group',{chat:group,participants:[jamie]}]])
    await assert.rejects(bridge.call(tool,args),/read-only/i,tool);
  assert.ok((await bridge.call('get_contact_info',{chat:alex})).id);
});
