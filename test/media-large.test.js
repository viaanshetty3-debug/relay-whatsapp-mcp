import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,openSync,ftruncateSync,closeSync,statSync,writeFileSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { Store } from '../src/store.js';
import { Bridge } from '../src/tools.js';
import { WhatsApp } from '../src/whatsapp.js';
import { MEDIA_LIMIT,INLINE_MEDIA_LIMIT,messageContent,mediaToolResult } from '../src/media.js';
const chat='15550100001@s.whatsapp.net',other='15550100002@s.whatsapp.net';
function fixture(t,options={}){
  const dir=mkdtempSync(resolve(tmpdir(),'relay-media-large-')),store=new Store(':memory:'),config={dir,allowed:new Set(),readOnly:false,...options};
  const wa={status:()=>({state:'connected'}),send:async(c,content)=>({chat:c,content,status:'submitted'}),downloadToFile:async(c,id,path)=>{writeFileSync(path,'hello');return {filename:'notes.txt',mimeType:'text/plain',sizeBytes:5};}};
  const bridge=new Bridge(store,wa,config);
  store.message({chat,id:'doc',timestamp:1,text:'',kind:'documentMessage',hasMedia:true,raw:JSON.stringify({message:{documentMessage:{mimetype:'text/plain',fileName:'notes.txt'}}})});
  t.after(()=>{bridge.analysis.stop();store.close();rmSync(dir,{recursive:true,force:true});});return {dir,store,wa,bridge,config};
}
test('500 MB uploads are accepted at the exact boundary and sent from a private disk file',async t=>{
  const {bridge}=fixture(t);
  const upload=await bridge.call('create_media_upload',{chat,sizeBytes:MEDIA_LIMIT,mimeType:'application/octet-stream',filename:'large.bin'});
  assert.equal(upload.sizeBytes,500*1024*1024);assert.ok(!('path' in upload));
  await assert.rejects(bridge.call('create_media_upload',{chat,sizeBytes:MEDIA_LIMIT+1,mimeType:'application/octet-stream',filename:'large.bin'}));
  // A sparse fixture verifies the full 500 MB boundary without allocating 500 MB in memory.
  const entry=bridge.mediaFile(upload.fileId),fd=openSync(entry.path,'r+');ftruncateSync(fd,MEDIA_LIMIT-1);closeSync(fd);
  const chunk=await bridge.call('upload_media_chunk',{fileId:upload.fileId,offset:MEDIA_LIMIT-1,base64:Buffer.from('Z').toString('base64')});assert.equal(chunk.complete,true);
  const sent=await bridge.call('send_media',{chat,fileId:upload.fileId,mimeType:'application/octet-stream',kind:'document'});
  assert.equal(sent.content.document.url,entry.path);assert.equal(statSync(entry.path).size,MEDIA_LIMIT);
  const tail=await bridge.call('read_media_chunk',{fileId:upload.fileId,offset:MEDIA_LIMIT-1,length:1});assert.equal(Buffer.from(tail.base64,'base64').toString(),'Z');assert.equal(tail.eof,true);
});
test('chunked uploads serialize concurrent retries and reject conflicts, gaps and forbidden chats',async t=>{
  const {bridge,config}=fixture(t,{allowed:new Set([chat])});
  const upload=await bridge.call('create_media_upload',{chat,sizeBytes:3,mimeType:'text/plain',filename:'a.txt'});
  const args={fileId:upload.fileId,offset:0,base64:Buffer.from('abc').toString('base64')};
  const [a,b]=await Promise.all([bridge.call('upload_media_chunk',args),bridge.call('upload_media_chunk',args)]);assert.equal(a.complete,true);assert.equal(b.received,3);
  await assert.rejects(bridge.call('upload_media_chunk',{...args,base64:Buffer.from('xyz').toString('base64')}),/Conflicting/);
  await assert.rejects(bridge.call('upload_media_chunk',{...args,offset:4}),/exceeds/);
  config.allowed=new Set([other]);await assert.rejects(bridge.call('read_media_chunk',{fileId:upload.fileId}),/ALLOWED_CHATS/);
  config.allowed=new Set([chat]);config.readOnly=true;await assert.rejects(bridge.call('upload_media_chunk',args),/read-only/);
});
test('attachments above the old limit stream to disk and return chunk handles instead of huge base64 responses',async t=>{
  const {bridge,config,store}=fixture(t);const block=Buffer.alloc(1024*1024,7);
  const library={normalizeMessageContent:messageContent,downloadMediaMessage:async()=>Readable.from((async function*(){for(let n=0;n<17;n++)yield block;})())};
  const wa=new WhatsApp(store,config,library);wa.state='connected';wa.sock={updateMediaMessage:()=>{}};
  store.message({...store.getMessage(chat,'doc'),raw:JSON.stringify({message:{documentMessage:{mediaKey:'test',directPath:'/test',fileLength:17*1024*1024,mimetype:'application/octet-stream'}}})});
  bridge.wa.downloadToFile=wa.downloadToFile.bind(wa);
  const file=await bridge.call('read_media',{chat,id:'doc'});assert.equal(file.sizeBytes,17*1024*1024);assert.equal(file.base64,undefined);assert.equal(file.delivery,'file');
  const response=mediaToolResult('read_media',file);assert.match(response.content[0].text,/analyze_media/);assert.ok(response.content[0].text.length<2000);
  const chunk=await bridge.call('read_media_chunk',{fileId:file.fileId,length:12,offset:16*1024*1024});assert.deepEqual(Buffer.from(chunk.base64,'base64'),Buffer.alloc(12,7));
  await bridge.call('delete_cached_media',{fileId:file.fileId});await assert.rejects(bridge.call('read_media_chunk',{fileId:file.fileId}),/not found/);
});
test('downloaded file handles preserve source-chat permissions and reject deleted messages',async t=>{
  const {bridge,store,config}=fixture(t);const file=await bridge.call('read_media',{chat,id:'doc'});assert.ok(file.base64);
  config.allowed=new Set([other]);assert.throws(()=>bridge.mediaFile(file.fileId),/ALLOWED_CHATS/);
  config.allowed=new Set();store.message({...store.getMessage(chat,'doc'),deleted:true});assert.throws(()=>bridge.mediaFile(file.fileId),/deleted/);
});
test('analysis jobs return promptly, expose paginated results, enforce permissions and survive restart records',async t=>{
  const {bridge,config}=fixture(t);let release;const gate=new Promise(r=>release=r);
  bridge.analysis.run=async()=>{await gate;return {text:'transcript sample',mode:'transcribe'};};
  const job=await bridge.call('analyze_media',{chat,id:'doc',mode:'transcribe'});assert.ok(['queued','running'].includes(job.status));
  const pending=await bridge.call('get_media_analysis',{jobId:job.jobId});assert.notEqual(pending.status,'complete');
  release();await bridge.analysis.get(job.jobId).promise;
  const first=await bridge.call('get_media_analysis',{jobId:job.jobId,limit:5});assert.equal(first.text,'trans');assert.equal(first.hasMore,true);
  const next=await bridge.call('get_media_analysis',{jobId:job.jobId,offset:first.nextOffset});assert.equal(next.text,'cript sample');
  config.allowed=new Set([other]);await assert.rejects(bridge.call('get_media_analysis',{jobId:job.jobId}),/ALLOWED_CHATS/);
  config.allowed=new Set();bridge.analysis.jobs.clear();assert.equal((await bridge.call('get_media_analysis',{jobId:job.jobId})).text,'transcript sample');
});
test('cancelled queued jobs do not run and image/video result blocks remain native',async t=>{
  const {bridge}=fixture(t);let release;bridge.analysis.queue=new Promise(r=>release=r);
  let ran=false;bridge.analysis.run=async()=>{ran=true;return {};};
  const job=await bridge.call('analyze_media',{chat,id:'doc'});await bridge.call('cancel_media_analysis',{jobId:job.jobId});release();await bridge.analysis.get(job.jobId).promise;
  assert.equal(ran,false);assert.equal((await bridge.call('get_media_analysis',{jobId:job.jobId})).status,'cancelled');
  const content=mediaToolResult('get_media_analysis',{text:'Description',frames:[{seconds:2,base64:'dGVzdA=='}]}).content;
  assert.equal(content[2].type,'image');assert.ok(!content[0].text.includes('dGVzdA=='));
});
test('plain document extraction uses the installed local worker and paginates Unicode without lost bytes',async t=>{
  const {bridge}=fixture(t),expected='hello café 世界';
  if(!existsSync(bridge.analysis.python)){t.skip('Optional project-local media engine is not installed');return;}
  bridge.wa.downloadToFile=async(c,id,path)=>{writeFileSync(path,expected);return {filename:'notes.txt',mimeType:'text/plain',sizeBytes:Buffer.byteLength(expected)};};
  const job=await bridge.call('analyze_media',{chat,id:'doc',mode:'extract'});await bridge.analysis.get(job.jobId).promise;
  let offset=0,text='';
  for(let n=0;n<30;n++){const page=await bridge.call('get_media_analysis',{jobId:job.jobId,offset,limit:1});assert.equal(page.status,'complete',page.error);text+=page.text;if(!page.hasMore)break;assert.ok(page.nextOffset>offset);offset=page.nextOffset;}
  assert.equal(text,expected);
});
test('background cache jobs return a full-file handle without running a transcription or vision engine',async t=>{
  const {bridge}=fixture(t);let ran=false;bridge.analysis.run=async()=>{ran=true;throw new Error('No processor should run');};
  const job=await bridge.call('analyze_media',{chat,id:'doc',mode:'cache'});await bridge.analysis.get(job.jobId).promise;
  const result=await bridge.call('get_media_analysis',{jobId:job.jobId});assert.equal(result.status,'complete');assert.equal(result.mode,'cache');assert.ok(result.fileId);assert.equal(ran,false);
  const bytes=await bridge.call('read_media_chunk',{fileId:result.fileId});assert.equal(Buffer.from(bytes.base64,'base64').toString(),'hello');
});
