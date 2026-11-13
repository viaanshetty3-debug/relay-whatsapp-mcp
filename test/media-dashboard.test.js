import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

const tick=()=>new Promise(r=>setTimeout(r,5));
async function until(fn){for(let i=0;i<200;i++){if(fn())return;await tick();}throw new Error('Dashboard did not settle');}
test('dashboard loads media only on request, safely previews it, and releases it on close/lock',async t=>{
  const errors=[],vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));
  const dom=new JSDOM(readFileSync(new URL('../public/index.html',import.meta.url),'utf8'),{url:'http://127.0.0.1:8787',runScripts:'outside-only',virtualConsole:vc});
  const w=dom.window,d=w.document,$=s=>d.querySelector(s),chat='15550100001@s.whatsapp.net';
  const messages=[{chat,id:'image',text:'A photo',kind:'imageMessage',hasMedia:true,timestamp:1,media:{kind:'image',mimeType:'image/png'}},{chat,id:'doc',text:'',kind:'documentMessage',hasMedia:true,timestamp:2,media:{kind:'document',filename:'notes.txt'}}];
  let reads=0,created=0;const revoked=[];
  w.Blob=Blob;w.TextDecoder=TextDecoder;w.AbortController=AbortController;
  w.URL.createObjectURL=()=>`blob:preview-${++created}`;w.URL.revokeObjectURL=url=>revoked.push(url);
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  w.HTMLDialogElement.prototype.close=function(){if(this.open){this.open=false;this.dispatchEvent(new w.Event('close'));}};
  w.HTMLMediaElement.prototype.pause=()=>{};
  w.fetch=async(rawUrl,options={})=>{
    const url=rawUrl.replace(/[?&]profile=main$/,''); // every dashboard request names its WhatsApp profile
    if(url.startsWith('/api/events'))return new Response(new ReadableStream({start(controller){options.signal.addEventListener('abort',()=>controller.close(),{once:true});}}));
    if(url.startsWith('/api/media/')){assert.equal(options.headers.Authorization,'Bearer test-owner');return new Response('photo',{headers:{'Content-Type':'image/png'}});}
    let result;
    if(url==='/api/state')return Response.json({state:'connected',base:'http://127.0.0.1:8787',tools:[],cursor:0});
    if(url==='/api/clients')return Response.json([]);
    const args=JSON.parse(options.body||'{}');
    if(url.endsWith('/list_chats'))result=[{id:chat,name:'Test chat'}];
    else if(url.endsWith('/get_messages'))result=messages;
    else if(url.endsWith('/read_media')){reads++;result={chat,id:args.id,filename:args.id==='doc'?'<script>bad()</script>.txt':'photo.png',mimeType:args.id==='doc'?'text/plain':'image/png',...(args.id==='doc'?{base64:Buffer.from('<script>bad()</script>').toString('base64')}:{fileId:'test-large-file'}),media:{kind:args.id==='doc'?'document':'image'}};}
    else if(url.endsWith('/analyze_media'))result={jobId:'analysis-test',status:'queued'};
    else if(url.endsWith('/get_media_analysis'))result={jobId:'analysis-test',status:'complete',text:'Local visual description',hasMore:false};
    else throw new Error('Unexpected route '+url);
    return Response.json({result});
  };
  t.after(()=>{if(!$('#workspace').hidden)$('#logout').click();w.close();});
  w.eval(readFileSync(new URL('../public/app.js',import.meta.url),'utf8'));
  $('#token').value='test-owner';$('#login-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  await until(()=>d.querySelector('.chat-item'));$('.chat-item').click();await until(()=>d.querySelectorAll('[data-action="view-media"]').length===2);
  assert.equal(reads,0);
  $('[data-message="image"] [data-action="view-media"]').click();await until(()=>$('#media-preview img'));
  assert.equal(reads,1);assert.equal($('#media-preview img').src,'blob:preview-1');assert.equal($('#media-dialog').open,true);
  $('#media-analyze').click();await until(()=>$('#media-analysis-output').textContent.includes('Local visual description'));
  $('#media-dialog').close();assert.deepEqual(revoked,['blob:preview-1']);assert.equal($('#media-preview').children.length,0);
  $('[data-message="doc"] [data-action="view-media"]').click();await until(()=>$('#media-preview pre'));
  assert.equal($('#media-preview pre').textContent,'<script>bad()</script>');assert.equal($('#media-preview script'),null);
  assert.equal($('#media-title').textContent,'<script>bad()</script>.txt');
  $('#logout').click();assert.equal($('#media-dialog').open,false);assert.equal($('#media-preview').children.length,0);assert.equal(revoked.length,2);
  assert.deepEqual(errors,[]);
});
