import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { Store } from '../src/store.js';
import { WhatsApp } from '../src/whatsapp.js';
import { Bridge, mcpServer } from '../src/tools.js';
import { mediaInfo, mediaThumbnail, messageContent, MEDIA_LIMIT } from '../src/media.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const chat='15550100001@s.whatsapp.net',other='15550100002@s.whatsapp.net';
const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
function fixture(t,options={}) {
  const store=new Store(':memory:'),config={allowed:new Set(),readOnly:false,...options},files=new Map();
  const wa={status:()=>({state:'connected'}),download:async(c,id)=>{const file=files.get(id);if(!file)throw new Error('Media is no longer available');return file;}};
  const bridge=new Bridge(store,wa,config);t.after(()=>store.close());
  function insert(id,kind,content,bytes=image,c=chat,timestamp=100){
    // Match an imported database: no new media metadata fields, with BufferJSON-encoded thumbnails.
    store.message({chat:c,id,key:{remoteJid:c,id},kind,text:content.caption||'',timestamp,hasMedia:true,raw:JSON.stringify({message:{[kind]:content}})});
    files.set(id,{mimeType:content.mimetype,filename:content.fileName||id,base64:bytes.toString('base64')});
  }
  return {store,config,wa,bridge,files,insert};
}
test('existing synced attachments expose safe metadata without media keys, paths or raw payloads',async t=>{
  const {bridge,insert}=fixture(t);
  insert('photo','imageMessage',{mimetype:'image/png',width:320,height:200,fileLength:{low:1234,high:0},caption:'Invoice',mediaKey:'secret',directPath:'/secret'});
  const [m]=await bridge.call('get_messages',{chat});
  assert.equal(m.media.sizeBytes,1234);assert.equal(m.media.width,320);assert.equal(m.media.kind,'image');
  assert.ok(!JSON.stringify(m).includes('secret'));assert.ok(!('raw' in m));
  assert.equal(mediaInfo({message:{audioMessage:{ptt:true,seconds:7}}}).voiceNote,true);
});
test('list_media filters before pagination, excludes deleted/forbidden attachments and finds old wrapped document filenames',async t=>{
  const {bridge,insert,store}=fixture(t,{allowed:new Set([chat])});
  for(let n=0;n<505;n++)insert('private'+n,'imageMessage',{mimetype:'image/png'},image,other,200+n);
  insert('photo','imageMessage',{mimetype:'image/png',caption:'trip'},image,chat,10);
  insert('voice','audioMessage',{mimetype:'audio/ogg; codecs=opus',ptt:true,seconds:4},Buffer.from('audio'),chat,20);
  insert('doc','documentMessage',{mimetype:'text/plain',fileName:'Bill_100%.txt'},Buffer.from('Total: 30'),chat,30);
  const doc=store.getMessage(chat,'doc');
  store.message({...doc,raw:JSON.stringify({message:{ephemeralMessage:{message:{documentWithCaptionMessage:{message:{documentMessage:{fileName:'Bill_100%.txt',mimetype:'text/plain'}}}}}}})});
  insert('gone','videoMessage',{mimetype:'video/mp4'},image,chat,40);store.message({...store.getMessage(chat,'gone'),deleted:true});
  assert.deepEqual((await bridge.call('list_media',{limit:1})).map(m=>m.id),['doc']);
  assert.deepEqual((await bridge.call('list_media',{limit:1,offset:1})).map(m=>m.id),['voice']);
  assert.equal((await bridge.call('list_media',{query:'100%',kind:'document'}))[0].id,'doc');
  assert.equal((await bridge.call('list_media',{kind:'audio'}))[0].media.voiceNote,true);
  await assert.rejects(bridge.call('list_media',{chat:other}),/ALLOWED_CHATS/);
});
test('official MCP client receives native images/audio and embedded text, PDF and video attachments',async t=>{
  const {bridge,insert}=fixture(t);
  insert('photo','imageMessage',{mimetype:'image/png'});
  insert('voice','audioMessage',{mimetype:'audio/ogg; codecs=opus',ptt:true},Buffer.from('audio'));
  insert('doc','documentMessage',{mimetype:'text/plain',fileName:'notes.txt'},Buffer.from('Meeting at 10'));
  insert('pdf','documentMessage',{mimetype:'application/pdf',fileName:'notes.pdf'},Buffer.from('%PDF-1.7 example'));
  insert('video','videoMessage',{mimetype:'video/mp4',jpegThumbnail:{type:'Buffer',data:image.toString('base64')}},Buffer.from('video'));
  insert('sticker','stickerMessage',{mimetype:'image/webp'},Buffer.from('sticker'));
  const server=mcpServer(bridge),client=new Client({name:'media-test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
  await server.connect(a);await client.connect(b);t.after(async()=>{await client.close();await server.close();});
  const read=id=>client.callTool({name:'read_media',arguments:{chat,id}});
  const photo=await read('photo');assert.equal(photo.content[1].type,'image');assert.equal(photo.content[1].data,image.toString('base64'));assert.ok(!photo.content[0].text.includes(image.toString('base64')));
  const voice=await read('voice');assert.equal(voice.content[1].type,'audio');assert.equal(voice.content[1].mimeType,'audio/ogg; codecs=opus');
  const doc=await read('doc');assert.equal(doc.content[1].resource.text,'Meeting at 10');assert.ok(doc.content[1].resource.uri.startsWith('whatsapp://media/'));
  const pdf=await read('pdf');assert.equal(pdf.content[1].resource.mimeType,'application/pdf');assert.ok(pdf.content[1].resource.blob);
  const video=await read('video');assert.equal(video.content[1].resource.mimeType,'video/mp4');assert.equal(video.content[2].type,'image');assert.equal(video.content[2].data,image.toString('base64'));assert.match(video.content[0].text,/only a preview/);
  assert.equal((await read('sticker')).content[1].type,'image');
  assert.equal((await read('missing')).isError,true);
});
test('read_media respects allowlist and deletions before download, works read-only, and preserves original download API',async t=>{
  const {bridge,insert,store,wa}=fixture(t,{allowed:new Set([chat]),readOnly:true});let downloads=0;const original=wa.download;wa.download=(...a)=>{downloads++;return original(...a);};
  insert('photo','imageMessage',{mimetype:'image/png'});insert('private','imageMessage',{mimetype:'image/png'},image,other);
  await assert.rejects(bridge.call('read_media',{chat:other,id:'private'}),/ALLOWED_CHATS/);assert.equal(downloads,0);
  const read=await bridge.call('read_media',{chat,id:'photo'});assert.equal(read.base64,image.toString('base64'));
  assert.equal((await bridge.call('download_media',{chat,id:'photo'})).base64,read.base64);
  store.message({...store.getMessage(chat,'photo'),deleted:true});await assert.rejects(bridge.call('read_media',{chat,id:'photo'}),/deleted/);assert.equal(downloads,2);
});
test('WhatsApp download decrypts with the library and enforces both declared and streamed byte limits',async t=>{
  const store=new Store(':memory:');t.after(()=>store.close());let requests=0;
  const library={normalizeMessageContent:messageContent,downloadMediaMessage:async()=>{requests++;return Readable.from([image]);}};
  const wa=new WhatsApp(store,{allowed:new Set()},library);wa.state='connected';wa.sock={updateMediaMessage:()=>{}};
  const put=length=>store.message({chat,id:'photo',timestamp:1,text:'',raw:JSON.stringify({message:{imageMessage:{mediaKey:'test',directPath:'/test',mimetype:'image/png',fileLength:length}}})});
  put(100);assert.equal((await wa.download(chat,'photo')).base64,image.toString('base64'));assert.equal(requests,1);
  put(MEDIA_LIMIT+1);await assert.rejects(wa.download(chat,'photo'),/500 MB/);assert.equal(requests,1);
  put(0);let destroyed=false;library.downloadMediaMessage=async()=>({async *[Symbol.asyncIterator](){const chunk=Buffer.alloc(1024*1024);for(let n=0;n<500;n++)yield chunk;yield Buffer.from('x');},destroy(){destroyed=true;}});
  await assert.rejects(wa.download(chat,'photo'),/500 MB/);assert.equal(destroyed,true);
});
test('BufferJSON thumbnails decode correctly and oversized previews are omitted',()=>{
  const raw=JSON.stringify({message:{videoMessage:{jpegThumbnail:{type:'Buffer',data:image.toString('base64')}}}});
  assert.equal(mediaThumbnail({raw}).base64,image.toString('base64'));
  assert.equal(mediaThumbnail({message:{videoMessage:{jpegThumbnail:Buffer.alloc(256*1024+1)}}}),undefined);
});
