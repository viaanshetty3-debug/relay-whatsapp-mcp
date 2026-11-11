const $=s=>document.querySelector(s);
const $$=s=>[...document.querySelectorAll(s)];
let token=sessionStorage.getItem('relay-token') || '',state={},chats=[],selected=null,replyTo=null,editing=null,unread=false,view='inbox',events=[],streamAbort,refreshTimer,pageSize=100;
let mediaUrl,mediaRequest=0,mediaAnalysisTimer,mediaJob;
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const time=t=>t?new Date(Number(t)*1000).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):'';
const name=c=>chats.find(x=>x.id===c)?.name || c?.split('@')[0] || 'Conversation';
function toast(message){$('#toast').textContent=message;$('#toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('#toast').hidden=true,5000);}
async function api(path,body){
  const response=await fetch(path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,...(body!==undefined?{'Content-Type':'application/json'}:{})},body:body!==undefined?JSON.stringify(body):undefined});
  const result=await response.json();if(!response.ok){if(response.status===401)lock();throw new Error(result.error || 'Request failed');}return result;
}
async function tool(name,args={}){return (await api('/api/tools/'+name,args)).result;}
function guarded(fn){return (...args)=>{if(args[0]?.type==='submit')args[0].preventDefault();return Promise.resolve().then(()=>fn(...args)).catch(e=>toast(e.message));};}
function lock(){streamAbort?.abort();clearTimeout(refreshTimer);$('#media-dialog').close();clearMedia();token='';sessionStorage.removeItem('relay-token');$('#workspace').hidden=true;$('#login').hidden=false;$('#token').value='';}
function paintStatus(){
  const badge=$('#connection-state');badge.textContent=state.state==='connected'?'Connected':state.state==='pairing'?'Ready to pair':state.state==='connecting'?'Connecting…':'Disconnected';badge.classList.toggle('connected',state.state==='connected');
  $('#connect').textContent=state.state==='connected'?'Manage connection ↗':'Connect WhatsApp ↗';$('#demo-badge').hidden=!state.demo;$('#read-only').textContent=state.readOnly?'· Read-only mode':'';
  const disabled=!selected || state.readOnly || state.state!=='connected';$('#message-input').disabled=!selected || state.readOnly;$('#send').disabled=disabled;
  for(const id of ['attach','schedule'])$('#'+id).disabled=disabled;
  $('#save-draft').disabled=!selected||state.readOnly;
  $('#retry-pair').hidden=!['logged_out','disconnected'].includes(state.state);
  $('#phone-form button').disabled=state.state!=='pairing';
  if(['logged_out','disconnected'].includes(state.state))$('#pair-code').textContent='';
  if($('#pair-dialog').open){
    if(state.state==='connected'){$('#qr-area').innerHTML='<p>Your WhatsApp account is connected.</p>';}
    else if(state.qr)$('#qr-area').innerHTML=`<img src="${escape(state.qr)}" alt="WhatsApp pairing QR code">`;
    else $('#qr-area').innerHTML=`<p>${escape(state.error || (state.state==='connecting'?'Connecting to WhatsApp…':'Waiting for a pairing QR…'))}</p>`;
  }
}
async function loadState(){state=await api('/api/state');paintStatus();}
async function openWorkspace(){
  await loadState();sessionStorage.setItem('relay-token',token);$('#login').hidden=true;$('#workspace').hidden=false;
  await refreshChats();renderIntegrations();renderToolCatalog();startEvents();
}
$('#login-form').addEventListener('submit',async e=>{e.preventDefault();token=$('#token').value.trim();try{await openWorkspace();}catch(err){$('#login-error').textContent=err.message;}});
$('#logout').addEventListener('click',lock);
if(token)openWorkspace().catch(e=>{$('#login-error').textContent=e.message;lock();});
async function refreshChats(){chats=await tool('list_chats',{limit:500});$('#chat-count').textContent=chats.length;renderChats();}
function renderChats(){
  const query=$('#chat-search').value.toLowerCase();const filtered=chats.filter(c=>(!unread||Number(c.unreadCount)>0)&&[c.name,c.id].join(' ').toLowerCase().includes(query));
  $('#chat-list').innerHTML=filtered.length?filtered.map(c=>`<button class="chat-item ${c.id===selected?'active':''}" data-chat="${escape(c.id)}"><span class="avatar ${c.id.endsWith('@g.us')?'group':''}">${escape((c.name || c.id).split(' ').slice(0,2).map(s=>s[0]).join('').toUpperCase())}</span><span class="chat-copy"><span class="chat-name-row"><span class="chat-name">${escape(c.name || c.id.split('@')[0])}</span><span class="chat-time">${time(c.conversationTimestamp)}</span></span><span class="chat-preview">${escape(c.preview || (c.id.endsWith('@g.us')?'Group conversation':'Start a conversation'))}</span></span>${c.unreadCount>0?`<span class="unread-badge">${escape(c.unreadCount)}</span>`:''}</button>`).join(''):'<div class="blank-state">No conversations here yet.<br>Pair WhatsApp to sync your chats.</div>';
}
$('#chat-list').addEventListener('click',guarded(async e=>{const b=e.target.closest('[data-chat]');if(b)await selectChat(b.dataset.chat);}));
$('#chat-search').addEventListener('input',renderChats);
$('#all-filter').onclick=()=>{unread=false;$('#all-filter').classList.add('selected');$('#unread-filter').classList.remove('selected');renderChats();};
$('#unread-filter').onclick=()=>{unread=true;$('#unread-filter').classList.add('selected');$('#all-filter').classList.remove('selected');renderChats();};
$('#new-chat').onclick=guarded(async()=>{
  const value=prompt('Phone number including country code, or exact WhatsApp chat JID:');if(!value)return;
  let chat=value.trim();if(/^\+?\d{7,15}$/.test(chat))chat=chat.replace('+','')+'@s.whatsapp.net';
  await tool('get_messages',{chat,limit:1});
  if(!chats.some(c=>c.id===chat))chats.unshift({id:chat,name:chat.split('@')[0]});await selectChat(chat);
});
async function selectChat(chat){
  if(selected && selected!==chat && $('#message-input').value.trim() && !confirm('Switch conversations and discard the text in the composer? Save a draft first if you want to keep it.'))return;
  selected=chat;pageSize=100;replyTo=null;editing=null;$('#message-input').value='';clearReply();showView('inbox');$('#view-inbox').classList.add('chat-open');$('#messages').hidden=false;$('#search-results').hidden=true;
  $('#chat-header').innerHTML=`<div><span class="eyebrow">${chat.endsWith('@g.us')?'GROUP CONVERSATION':'DIRECT CONVERSATION'}</span><h2 title="Back to chats on mobile">${escape(name(chat))}</h2></div><button id="export" class="quiet">Export ↓</button>`;
  $('#chat-header h2').onclick=()=>$('#view-inbox').classList.remove('chat-open');$('#export').onclick=guarded(exportChat);renderChats();paintStatus();await refreshMessages(true);
}
async function refreshMessages(scroll=false){
  if(!selected)return;const chat=selected;const messages=await tool('get_messages',{chat,limit:pageSize});if(selected!==chat)return;
  const container=$('#messages'),nearBottom=container.scrollHeight-container.scrollTop-container.clientHeight<100;
  let date='';container.innerHTML=(messages.length===pageSize&&pageSize<500?'<button id="load-more" class="load-more">Load earlier messages ↑</button>':'')+messages.reverse().map(m=>{
    const d=new Date(m.timestamp*1000).toLocaleDateString([],{month:'long',day:'numeric',year:'numeric'});let divider='';if(d!==date){date=d;divider=`<div class="date-divider">${escape(d)}</div>`;}
    const actions=m.deleted?'':`<button data-action="reply">Reply</button><button data-action="react">React</button>${m.fromMe?`${['conversation','extendedTextMessage'].includes(m.kind)?'<button data-action="edit">Edit</button>':''}<button data-action="delete">Delete</button>`:''}${m.hasMedia?'<button data-action="view-media">View media</button><button data-action="download">Download</button>':''}`;
    const attachment=m.media&&!m.deleted?`<div class="attachment-label">${escape([m.media.voiceNote?'Voice note':m.media.kind,m.media.filename,m.media.durationSeconds!=null?m.media.durationSeconds+' sec':''].filter(Boolean).join(' · '))}</div>`:'';
    return divider+`<article class="message ${m.fromMe?'mine':''} ${m.deleted?'deleted':''}" data-message="${escape(m.id)}"><div class="message-author">${m.fromMe?'You':escape(m.pushName || name(chat))}</div><div class="bubble">${escape(m.deleted?'This message was deleted':m.text || (m.media?'Attachment':'['+m.kind+']'))}${attachment}</div><div class="message-meta"><span>${time(m.timestamp)}${m.edited?' · edited':''}</span><div class="message-actions">${actions}</div></div></article>`;
  }).join('');
  if(!messages.length)container.innerHTML='<div class="empty"><h2>Start the conversation.</h2><p>Only messages synced by WhatsApp appear here.</p></div>';
  if($('#load-more'))$('#load-more').onclick=guarded(async()=>{const old=container.scrollHeight;pageSize=Math.min(500,pageSize+100);await refreshMessages();container.scrollTop=container.scrollHeight-old;});
  if(scroll||nearBottom)container.scrollTop=container.scrollHeight;
}
function clearReply(){replyTo=null;editing=null;$('#reply-bar').hidden=true;$('#send').textContent='Send message ↗';}
$('#clear-reply').onclick=clearReply;
$('#messages').addEventListener('click',guarded(async e=>{
  const button=e.target.closest('[data-action]'),article=e.target.closest('[data-message]');if(!button||!article)return;const id=article.dataset.message;const content=article.querySelector('.bubble').textContent;
  switch(button.dataset.action){
    case 'reply':clearReply();replyTo=id;$('#reply-bar span').textContent='Replying to: '+content.slice(0,100);$('#reply-bar').hidden=false;$('#message-input').focus();break;
    case 'edit':clearReply();editing=id;$('#message-input').value=content;$('#reply-bar span').textContent='Editing your message';$('#reply-bar').hidden=false;$('#send').textContent='Save edit ↗';$('#message-input').focus();break;
    case 'delete':if(confirm('Delete this message for everyone?')){await tool('delete_message',{chat:selected,id});await refreshMessages();toast('Deletion submitted');}break;
    case 'react':{const emoji=prompt('Emoji reaction (leave empty to remove):','👍');if(emoji!==null){await tool('react_message',{chat:selected,id,emoji});toast('Reaction submitted');}break;}
    case 'download':{toast('Downloading attachment…');const media=await tool('download_media',{chat:selected,id});download(await mediaBlob(media),media.filename);break;}
    case 'view-media':await showMedia(selected,id);break;
  }
}));
$('#composer').addEventListener('submit',guarded(async e=>{
  e.preventDefault();const text=$('#message-input').value.trim(),chat=selected;if(!chat||!text)return;
  $('#send').disabled=true;
  try{await tool(editing?'edit_message':'send_message',editing?{chat,id:editing,text}:{chat,text,...(replyTo?{replyTo}:{}),requestId:crypto.randomUUID()});$('#message-input').value='';clearReply();await refreshMessages(true);await refreshChats();toast(state.demo?'Saved in demo chat':'Message submitted');}finally{paintStatus();}
}));
$('#message-input').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();if(!$('#send').disabled)$('#composer').requestSubmit();}});
$('#save-draft').onclick=guarded(async()=>{const text=$('#message-input').value.trim();if(!selected||!text)return toast('Write a message first');await tool('save_draft',{chat:selected,text});toast('Draft saved');});
$('#schedule').onclick=()=>{if(!selected||!$('#message-input').value.trim())return toast('Write a message first');$('#schedule-preview').textContent=$('#message-input').value;const d=new Date(Date.now()+3600000);d.setMinutes(d.getMinutes()-d.getTimezoneOffset());$('#send-at').value=d.toISOString().slice(0,16);$('#schedule-dialog').showModal();};
$('#schedule-form').addEventListener('submit',guarded(async e=>{e.preventDefault();await tool('schedule_message',{chat:selected,text:$('#message-input').value.trim(),sendAt:new Date($('#send-at').value).toISOString()});$('#schedule-dialog').close();$('#message-input').value='';toast('Message scheduled');}));
$('#attach').onclick=()=>$('#file-input').click();
$('#file-input').addEventListener('change',guarded(async()=>{
  const file=$('#file-input').files[0];$('#file-input').value='';if(!file||!selected)return;if(file.size>500*1024*1024)throw new Error('Choose an attachment up to 500 MB');
  const chat=selected,caption=$('#message-input').value;if(!confirm(`Send ${file.name} to ${name(chat)}?`))return;
  const mime=file.type||'application/octet-stream',category=mime.split('/')[0],kind=['image','video','audio'].includes(category)?category:'document';
  const upload=await tool('create_media_upload',{chat,sizeBytes:file.size,mimeType:mime,filename:file.name});
  for(let offset=0;offset<file.size;offset+=1024*1024){
    const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=reject;reader.readAsDataURL(file.slice(offset,offset+1024*1024));});
    await tool('upload_media_chunk',{fileId:upload.fileId,offset,base64:data});toast('Uploading attachment: '+Math.min(100,Math.round((offset+1024*1024)/file.size*100))+'%');
  }
  await tool('send_media',{chat,fileId:upload.fileId,mimeType:mime,filename:file.name,kind,caption});if(selected===chat)$('#message-input').value='';toast('Attachment submitted');await refreshMessages(true);
}));
function download(blob,filename){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=filename.replace(/[\x00-\x1f/\\]/g,'_');a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
async function mediaBlob(file){
  if(file.base64)return new Blob([Uint8Array.from(atob(file.base64),c=>c.charCodeAt(0))],{type:file.mimeType});
  const response=await fetch('/api/media/'+encodeURIComponent(file.fileId),{headers:{Authorization:'Bearer '+token}});
  if(!response.ok)throw new Error((await response.json()).error||'Attachment download failed');return response.blob();
}
function clearMedia(){
  mediaRequest++;clearTimeout(mediaAnalysisTimer);mediaJob=null;$('#media-analyze').disabled=false;$('#media-analysis').hidden=true;$('#media-analysis-output').replaceChildren();$('#media-cancel').hidden=true;for(const player of $('#media-preview').querySelectorAll('audio,video'))player.pause();
  $('#media-preview').replaceChildren();if(mediaUrl)URL.revokeObjectURL(mediaUrl);mediaUrl=null;$('#media-save').onclick=null;$('#media-save').hidden=true;
}
$('#media-dialog').addEventListener('close',()=>{if(!$('#media-dialog').open)clearMedia();});
async function showMedia(chat,id){
  clearMedia();const request=mediaRequest,dialog=$('#media-dialog');$('#media-title').textContent='Attachment';$('#media-details').textContent='Loading attachment…';if(!dialog.open)dialog.showModal();
  let file;
  try{file=await tool('read_media',{chat,id});}catch(e){if(request===mediaRequest)$('#media-details').textContent=e.message;return;}
  if(request!==mediaRequest||!dialog.open)return;
  const mime=file.mimeType.split(';')[0].toLowerCase();let blob;
  try{blob=await mediaBlob(file);}catch(e){if(request===mediaRequest)$('#media-details').textContent=e.message;return;}
  if(request!==mediaRequest||!dialog.open)return;
  mediaUrl=URL.createObjectURL(blob);$('#media-title').textContent=file.filename;
  $('#media-details').textContent=[file.media?.voiceNote?'Voice note':file.media?.kind,file.mimeType,(blob.size/1024/1024).toFixed(2)+' MB',file.caption].filter(Boolean).join(' · ');
  let element;
  if(['image/jpeg','image/png','image/webp','image/gif'].includes(mime)){element=document.createElement('img');element.alt=file.caption||file.filename;element.src=mediaUrl;}
  else if(mime.startsWith('audio/')||mime.startsWith('video/')){element=document.createElement(mime.startsWith('audio/')?'audio':'video');element.controls=true;element.preload='metadata';element.src=mediaUrl;}
  else if(mime.startsWith('text/')||['application/json','application/xml','application/csv'].includes(mime)){element=document.createElement('pre');const text=await blob.slice(0,256000).text();element.textContent=text.slice(0,64000)+(blob.size>256000||text.length>64000?'\n[Preview truncated; download the original for the complete file.]':'');}
  else{element=document.createElement('p');element.textContent='Download this document to open it in a compatible app.';}
  if(request!==mediaRequest||!dialog.open)return;
  $('#media-preview').append(element);$('#media-save').hidden=false;$('#media-save').onclick=()=>download(blob,file.filename);
  $('#media-analysis').hidden=false;$('#media-analyze').onclick=guarded(async()=>{
    const job=await tool('analyze_media',{chat,id,mode:$('#media-analysis-mode').value});if(request!==mediaRequest)return;
    mediaJob=job.jobId;$('#media-analyze').disabled=true;$('#media-cancel').hidden=false;$('#media-analysis-output').textContent='Queued for local processing…';await pollAnalysis(job.jobId,request);
  });
}
$('#media-cancel').onclick=guarded(async()=>{if(mediaJob)await tool('cancel_media_analysis',{jobId:mediaJob});});
async function pollAnalysis(jobId,request,offset=0){
  if(request!==mediaRequest)return;
  const result=await tool('get_media_analysis',{jobId,offset,waitSeconds:2});if(request!==mediaRequest)return;
  const output=$('#media-analysis-output');
  if(result.status==='failed'||result.status==='cancelled'){output.textContent=result.error||'Analysis cancelled';$('#media-analyze').disabled=false;$('#media-cancel').hidden=true;return;}
  if(result.status!=='complete'){output.textContent=result.stage||result.status;mediaAnalysisTimer=setTimeout(()=>pollAnalysis(jobId,request).catch(e=>{output.textContent=e.message;}),1500);return;}
  $('#media-analyze').disabled=false;$('#media-cancel').hidden=true;output.replaceChildren();const text=document.createElement('pre');text.textContent=result.text||'Processing complete.';output.append(text);
  for(const frame of result.frames||[]){const label=document.createElement('p');label.textContent='Frame at '+frame.seconds+' sec';const image=document.createElement('img');image.src='data:image/jpeg;base64,'+frame.base64;image.alt=label.textContent;output.append(label,image);}
  if(result.warnings?.length){const note=document.createElement('p');note.textContent=result.warnings.join(' ');output.append(note);}
  if(result.hasMore){const next=document.createElement('button');next.className='quiet';next.textContent='Next page of text →';next.onclick=guarded(()=>pollAnalysis(jobId,request,result.nextOffset));output.append(next);}
}
async function exportChat(){
  const data=[];let offset=0;toast('Exporting synced messages…');
  while(true){const page=await tool('export_chat',{chat:selected,format:'json',limit:500,offset});data.unshift(...page.data);if(page.count<500)break;offset=page.nextOffset;}
  download(new Blob([JSON.stringify({chat:selected,exportedAt:new Date().toISOString(),messages:data},null,2)],{type:'application/json'}),'whatsapp-'+name(selected)+'.json');toast('Chat exported');
}
$('#global-search').onclick=guarded(async()=>{
  const query=prompt('Search message text across your synced chats:');if(!query)return;const results=await tool('search_messages',{query,limit:100});
  $('#view-inbox').classList.add('chat-open');$('#messages').hidden=true;$('#search-results').hidden=false;$('#search-results').innerHTML=`<h3>Results for “${escape(query)}”</h3><button id="close-search" class="quiet">← Back to conversation</button>`+(results.length?results.map(m=>`<button class="search-hit" data-chat="${escape(m.chat)}"><small>${escape(name(m.chat))} · ${new Date(m.timestamp*1000).toLocaleString()}</small>${escape(m.deleted?'[deleted]':m.text)}</button>`).join(''):'<p class="muted">No matching messages in synced history.</p>');
  $('#close-search').onclick=()=>{$('#search-results').hidden=true;$('#messages').hidden=false;if(!selected)$('#view-inbox').classList.remove('chat-open');};
});
$('#search-results').addEventListener('click',guarded(async e=>{const hit=e.target.closest('[data-chat]');if(hit)await selectChat(hit.dataset.chat);}));
function showView(next){view=next;$$('.view').forEach(v=>v.hidden=v.id!=='view-'+next);$$('.nav').forEach(n=>n.classList.toggle('active',n.dataset.view===next));$('#view-title').innerHTML=({inbox:'Your conversations',scheduled:'A little ahead',drafts:'Room for a thought',connections:'Better, connected',tools:'The possibilities'}[next] || 'Workspace')+'<span class="mint">.</span>';if(next==='scheduled')renderScheduled().catch(e=>toast(e.message));if(next==='drafts')renderDrafts().catch(e=>toast(e.message));if(next==='connections')renderClients().catch(e=>toast(e.message));}
$$('[data-view]').forEach(b=>b.onclick=()=>showView(b.dataset.view));
async function renderScheduled(){
  const jobs=await tool('list_scheduled');$('#scheduled-list').innerHTML=jobs.length?jobs.map(j=>`<article class="list-card"><div><h3>${escape(name(j.chat))}</h3><p>${escape(j.text)}</p><small>${new Date(j.due).toLocaleString()} · ${escape(j.status)}${j.error?' · '+escape(j.error):''}</small></div>${j.status==='pending'?`<button class="quiet danger" data-cancel="${escape(j.id)}">Cancel</button>`:''}</article>`).join(''):'<div class="blank-state">No scheduled messages. Write one in a conversation and select Schedule.</div>';
}
$('#scheduled-list').addEventListener('click',guarded(async e=>{const b=e.target.closest('[data-cancel]');if(b){await tool('cancel_scheduled',{id:b.dataset.cancel});await renderScheduled();toast('Schedule cancelled');}}));
async function renderDrafts(){
  const drafts=await tool('list_drafts');$('#draft-list').innerHTML=drafts.length?drafts.map(d=>`<article class="list-card"><div><h3>${escape(name(d.chat))}</h3><p>${escape(d.text)}</p><small>Saved ${new Date(d.updated).toLocaleString()}</small></div><div><button class="quiet" data-open-draft="${escape(d.id)}">Continue ↗</button><br><button class="quiet danger" data-delete-draft="${escape(d.id)}">Delete</button></div></article>`).join(''):'<div class="blank-state">A place for messages you’re still thinking about. Save a draft from any conversation.</div>';
}
$('#draft-list').addEventListener('click',guarded(async e=>{
  const open=e.target.closest('[data-open-draft]'),del=e.target.closest('[data-delete-draft]');
  if(open){const d=(await tool('list_drafts')).find(d=>d.id===open.dataset.openDraft);if(!d)return;await selectChat(d.chat);$('#message-input').value=d.text;}
  if(del){await tool('delete_draft',{id:del.dataset.deleteDraft});await renderDrafts();}
}));
async function renderClients(){
  const clients=await api('/api/clients');
  $('#client-list').innerHTML=clients.length?clients.map(c=>`<div class="list-card"><strong>${escape(c.name)}</strong><button class="quiet danger" data-revoke="${escape(c.id)}">Revoke access</button></div>`).join(''):'<p class="muted">No remote clients registered yet. Local adapters use your owner token.</p>';
}
$('#client-list').addEventListener('click',guarded(async e=>{const button=e.target.closest('[data-revoke]');if(!button || !confirm('Revoke this AI client’s access? It will need to register and sign in again.'))return;await api('/api/clients/'+encodeURIComponent(button.dataset.revoke)+'/revoke',{});await renderClients();toast('AI client access revoked');}));
function renderIntegrations(){
  $('#mcp-url').textContent=state.remote?.published?state.remote.claudeMcpUrl:state.base+'/mcp';
  $('#remote-setup-link').hidden=!state.remote?.published;
  if(state.remote?.published){$('#remote-instructions').textContent='Your private HTTPS relay is live. Open account setup to use the installed ChatGPT plugin and add Claude’s custom web connector.';$('#remote-note').textContent='This is Claude’s MCP address. ChatGPT uses the private Relay plugin. Keep the Mac awake and online.';}
  $('#claude-config').textContent=JSON.stringify(state.localConfig,null,2);
}
$('.copy-config').onclick=guarded(async()=>{await navigator.clipboard.writeText($('#claude-config').textContent);toast('Local MCP configuration copied.');});
$('#copy-url').onclick=guarded(async()=>{await navigator.clipboard.writeText($('#mcp-url').textContent);toast('MCP URL copied');});
const samples={get_messages:()=>({chat:selected||chats[0]?.id||'15551234567@s.whatsapp.net'}),send_message:()=>({chat:selected||chats[0]?.id||'15551234567@s.whatsapp.net',text:'Hello!'}),search_messages:()=>({query:'meeting'}),wait_updates:()=>({after:state.cursor||0,timeoutSeconds:5}),list_chats:()=>({}),status:()=>({})};
function renderToolCatalog(){
  $('#tool-select').innerHTML=state.tools.map(t=>`<option value="${t.name}">${t.name}${t.write?' · write':' · read'}</option>`).join('');
  $('#tool-catalog').innerHTML=state.tools.map(t=>`<button class="tool-card" data-tool="${t.name}"><small>${t.write?'TAKES ACTION':'READS DATA'}</small><h3>${escape(t.name)}</h3><p>${escape(t.description)}</p></button>`).join('');chooseTool();
}
function chooseTool(){const t=state.tools.find(t=>t.name===$('#tool-select').value);$('#tool-description').textContent=t?.description;$('#tool-args').value=JSON.stringify(samples[t?.name]?.()||{},null,2);}
$('#tool-select').onchange=chooseTool;
$('#tool-catalog').onclick=e=>{const b=e.target.closest('[data-tool]');if(b){$('#tool-select').value=b.dataset.tool;chooseTool();$('#tool-select').scrollIntoView({behavior:'smooth',block:'start'});}};
$('#run-tool').onclick=guarded(async()=>{const t=state.tools.find(t=>t.name===$('#tool-select').value);if(t.write&&!confirm(`Run ${t.name}? This can change WhatsApp data or local drafts/schedules.`))return;$('#tool-result').textContent='Running…';try{$('#tool-result').textContent=JSON.stringify(await tool(t.name,JSON.parse($('#tool-args').value)),null,2);}catch(e){$('#tool-result').textContent=e.message;}});
async function connect(){
  if(state.state==='connected'){$('#pair-dialog').showModal();$('#qr-area').innerHTML='<p>Your WhatsApp account is connected.</p>';return;}
  $('#pair-dialog').showModal();$('#pair-code').textContent='';$('#qr-area').innerHTML='<p>Connecting to WhatsApp…</p>';
  await api('/api/connect',{});await loadState();
}
$('#retry-pair').onclick=guarded(connect);$('#connect').onclick=guarded(connect);$('#empty-connect').onclick=guarded(connect);
$('#phone-form').addEventListener('submit',guarded(async e=>{e.preventDefault();const response=await api('/api/pair',{phone:$('#phone').value});$('#pair-code').textContent=response.code;}));
$('#disconnect').onclick=guarded(async()=>{await api('/api/disconnect',{});await loadState();$('#pair-dialog').close();toast('Bridge disconnected');});
function renderActivity(){
  $('#activity-list').innerHTML=events.length?events.slice(-6).reverse().map(e=>`<div class="activity-item"><strong>${escape(e.type==='message'?(e.data.fromMe?'Message sent':'New message'):e.type.replaceAll('.',' '))}</strong><p>${escape(e.data.text || name(e.chat) || 'Bridge updated')}</p><small>${new Date(e.time).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</small></div>`).join(''):'<div class="activity-item"><strong>All set to connect</strong><p>Updates will appear here.</p><small>Listening for activity</small></div>';
}
async function pollEvents(controller,cursor){
  while(!controller.signal.aborted){
    try{
      const response=await fetch('/api/tools/wait_updates',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({after:cursor,timeoutSeconds:2,limit:100}),signal:controller.signal});
      if(!response.ok)throw new Error('Live updates unavailable');
      const {result}=await response.json();cursor=result.cursor;
      if(result.events.length){events.push(...result.events);events=events.slice(-40);renderActivity();await refreshChats();if(selected)await refreshMessages();if(view==='scheduled')await renderScheduled();}
      await loadState();
    }catch(e){if(controller.signal.aborted)return;await new Promise(r=>setTimeout(r,2000));}
  }
}
async function startEvents(){
  streamAbort?.abort();const controller=new AbortController();streamAbort=controller;let cursor=state.cursor||0;renderActivity();
  if(!['localhost','127.0.0.1','[::1]'].includes(location.hostname))return pollEvents(controller,cursor);
  while(!controller.signal.aborted){
    try{
      const response=await fetch('/api/events?after='+cursor,{headers:{Authorization:'Bearer '+token},signal:controller.signal});if(!response.ok)throw new Error('Live stream unavailable');
      const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
      while(true){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let end;
        while((end=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);const data=frame.split('\n').filter(s=>s.startsWith('data: ')).map(s=>s.slice(6)).join('\n');if(!data)continue;
          const item=JSON.parse(data);if(frame.startsWith('event: status')){state={...state,...item};await loadState();continue;}
          cursor=item.seq;events.push(item);events=events.slice(-40);renderActivity();clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>Promise.all([refreshChats(),selected?refreshMessages():Promise.resolve(),view==='scheduled'?renderScheduled():Promise.resolve()]).catch(e=>toast(e.message)),200);
        }
      }
    }catch(e){if(controller.signal.aborted)return;$('#connection-state').textContent='Live feed reconnecting…';}
    if(!controller.signal.aborted)await new Promise(r=>{const timer=setTimeout(r,2000);controller.signal.addEventListener('abort',()=>{clearTimeout(timer);r();},{once:true});});
  }
}
