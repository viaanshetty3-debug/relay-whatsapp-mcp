const $=s=>document.querySelector(s);
const $$=s=>[...document.querySelectorAll(s)];
let profile=(()=>{try{return localStorage.getItem('relay-profile')||'main';}catch{return 'main';}})();
const byId=new Map();let selecting=null;let token=sessionStorage.getItem('relay-token') || '',state={},chats=[],selected=null,replyTo=null,editing=null,unread=false,view='inbox',events=[],streamAbort,refreshTimer,pageSize=100;
let mediaUrl,mediaRequest=0,mediaAnalysisTimer,mediaJob;
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const time=t=>t?new Date(Number(t)*1000).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):'';
// People not in your contacts show as +number, like WhatsApp does.
const label=id=>{const [user,domain]=String(id||'').split('@');return domain==='s.whatsapp.net'&&/^\d+$/.test(user)?'+'+user:user||'Conversation';};
const name=c=>chats.find(x=>x.id===c)?.name || label(c);
function toast(message){$('#toast').textContent=message;$('#toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('#toast').hidden=true,5000);}
async function api(path,body){
  const response=await fetch(withProfile(path),{method:body===undefined?'GET':'POST',headers:{...authHeaders(),...(body!==undefined?{'Content-Type':'application/json'}:{})},body:body!==undefined?JSON.stringify(body):undefined});
  const result=await response.json();if(!response.ok){if(response.status===401)lock(false);throw new Error(result.error || 'Request failed');}return result;
}
const authHeaders=()=>token?{Authorization:'Bearer '+token}:{};
const withProfile=path=>path+(path.includes('?')?'&':'?')+'profile='+encodeURIComponent(profile);
async function tool(name,args={}){return (await api('/api/tools/'+name,args)).result;}
function guarded(fn){return (...args)=>{if(args[0]?.type==='submit')args[0].preventDefault();return Promise.resolve().then(()=>fn(...args)).catch(e=>toast(e.message));};}
// signOut false: the server already refused this session (signed out elsewhere, or locked after idling), so only show the right page.
function lock(signOut=true){signOut=signOut!==false;streamAbort?.abort();clearTimeout(refreshTimer);$('#media-dialog').close();clearMedia();const hadToken=Boolean(token);token='';sessionStorage.removeItem('relay-token');$('#workspace').hidden=true;$('#login').hidden=false;$('#token').value='';resetWorkspace();
  // Signing out leaves this browser's other accounts signed in; the next one comes to the front.
  (hadToken||!signOut?Promise.resolve():fetch('/auth/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).catch(()=>{})).then(()=>showAuth()).catch(()=>{});}
// Clears everything on screen that belongs to one account or WhatsApp profile.
function resetWorkspace(){
  profile='main';try{localStorage.setItem('relay-profile',profile);}catch{}
  streamAbort?.abort();clearTimeout(refreshTimer);selected=null;replyTo=null;editing=null;events=[];chats=[];$('#message-input').value='';$('#reply-bar').hidden=true;
  $('#view-inbox').classList.remove('chat-open');$('#search-results').hidden=true;$('#messages').hidden=false;$('#chat-list').innerHTML='';
  $('#chat-header').innerHTML='<div><span class="eyebrow">YOUR INBOX, IN SYNC</span><h2>Select a conversation</h2></div>';
  $('#messages').innerHTML='<div class="empty"><div class="empty-symbol">↗</div><h2>Choose a conversation.</h2><p>Showing chats for this account.</p></div>';
}
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
    else if(state.qr)$('#qr-area').innerHTML=`<img src="${escape(state.qr)}" alt="WhatsApp pairing QR code">${state.demo?'<p class="muted"><strong>Practice mode:</strong> there is nothing to scan. Relay links the sample WhatsApp by itself in a few seconds.</p>':''}`;
    else $('#qr-area').innerHTML=`<p>${escape(state.error || (state.state==='connecting'?'Connecting to WhatsApp…':'Waiting for a pairing QR…'))}</p>`;
  }
}
async function loadState(){
  // A remembered profile that was removed (here, in another tab, or before a restart): fall back to Main.
  const toMain=async()=>{profile='main';try{localStorage.setItem('relay-profile',profile);}catch{}return api('/api/state');};
  try{state=await api('/api/state');}catch(e){if(profile==='main'||!/No WhatsApp profile/.test(e.message))throw e;state=await toMain();}
  if(state.profiles&&!state.profiles.some(p=>p.id===profile))state=await toMain();
  paintStatus();paintProfiles();paintSetup();
}
// ----- WhatsApp profiles -----
const STATE_DOT={connected:'●',connecting:'◌',pairing:'◌'};
function paintProfiles(){
  const list=state.profiles||[{id:'main',name:'Main',state:state.state}];const select=$('#profile-select');
  select.innerHTML=list.map(p=>`<option value="${escape(p.id)}">${escape((STATE_DOT[p.state]||'○')+' '+p.name+(p.phone?' · '+p.phone:''))}</option>`).join('')+'<option value="__add">＋ Add another WhatsApp…</option>';
  select.value=profile;$('#profile-select').title=list.length>1?'Switch WhatsApp profile':'Add another WhatsApp';
}
async function switchProfile(id){
  if(id===profile)return;
  if($('#message-input').value.trim()&&!confirm('Switch WhatsApp profile and discard the text in the composer?')){paintProfiles();return;}
  profile=id;try{localStorage.setItem('relay-profile',id);}catch{}
  streamAbort?.abort();clearTimeout(refreshTimer);selected=null;replyTo=null;editing=null;events=[];$('#message-input').value='';clearReply();clearMedia();
  $('#view-inbox').classList.remove('chat-open');$('#search-results').hidden=true;$('#messages').hidden=false;
  $('#chat-header').innerHTML='<div><span class="eyebrow">YOUR INBOX, IN SYNC</span><h2>Select a conversation</h2></div>';
  $('#messages').innerHTML='<div class="empty"><div class="empty-symbol">↗</div><h2>Choose a conversation.</h2><p>Showing chats for this WhatsApp.</p></div>';
  await loadState();await refreshChats();renderIntegrations();renderActivity();if(view==='scheduled')await renderScheduled();if(view==='drafts')await renderDrafts();startEvents();
  const p=state.profiles?.find(x=>x.id===profile);toast('Switched to '+(p?.name||'Main'));
  if(state.state==='disconnected'&&p&&!p.main)await connect();
}
// Other profiles' connection dots, every 15 s (only repaint when something changed, so an open menu isn't disturbed).
setInterval(()=>{if($('#workspace').hidden||document.hidden)return;api('/api/profiles').then(list=>{if(JSON.stringify(list)!==JSON.stringify(state.profiles)){state.profiles=list;paintProfiles();}}).catch(()=>{});},15000);
let profileEditing=null;
function openProfileDialog(editing){
  profileEditing=editing;const p=editing&&state.profiles?.find(x=>x.id===editing);
  $('#profile-dialog-title').textContent=p?'Rename or remove “'+p.name+'”.':'Add another WhatsApp.';
  $('#profile-dialog-note').hidden=Boolean(p);$('#profile-save').textContent=p?'Save name':'Add WhatsApp ↗';
  $('#profile-name').value=p?p.name:'';$('#profile-error').textContent='';
  $('#profile-remove-area').hidden=!p||p.main;$('#profile-remove').textContent='Remove this WhatsApp';$('#profile-remove').dataset.armed='';
  $('#profile-dialog').showModal();$('#profile-name').focus();
}
$('#profile-select').addEventListener('change',guarded(async()=>{const id=$('#profile-select').value;if(id==='__add'){paintProfiles();openProfileDialog(null);return;}await switchProfile(id);}));
$('#profile-manage').onclick=()=>openProfileDialog(profile);
$('#profile-form').addEventListener('submit',async e=>{
  e.preventDefault();$('#profile-error').textContent='';const name=$('#profile-name').value.trim();
  try{
    if(profileEditing){await api('/api/profiles/'+encodeURIComponent(profileEditing)+'/rename',{name});$('#profile-dialog').close();await loadState();toast('Renamed to '+name);}
    else{const created=await api('/api/profiles',{name});$('#profile-dialog').close();await loadState();await switchProfile(created.id);}
  }catch(err){$('#profile-error').textContent=err.message;}
});
$('#profile-remove').addEventListener('click',async()=>{
  const button=$('#profile-remove');
  if(!button.dataset.armed){button.dataset.armed='1';button.textContent='Click again to remove it for good';return;}
  try{const id=profileEditing;await api('/api/profiles/'+encodeURIComponent(id)+'/remove',{});$('#profile-dialog').close();if(profile===id)await switchProfile('main');else await loadState();toast('WhatsApp profile removed');}
  catch(err){$('#profile-error').textContent=err.message;}
});
async function openWorkspace(){
  if(addingAccount){addingAccount=false;resetWorkspace();}$('#auth-back').hidden=true;
  await loadState();if(token)sessionStorage.setItem('relay-token',token);if(afterLogin())return;$('#login').hidden=true;$('#workspace').hidden=false;
  await refreshChats();renderIntegrations();renderToolCatalog();startEvents();
  paintAccounts().catch(()=>{});renderSync().catch(()=>{});
}
// ----- several accounts on this computer -----
let addingAccount=false;
async function paintAccounts(){
  const select=$('#account-select');if(token){select.hidden=true;return;}
  auth=await (await fetch('/auth/status')).json();const list=auth.accounts||[];
  select.innerHTML=list.map(a=>`<option value="${escape(a.id)}">${escape(a.email)}</option>`).join('')+(auth.canAdd?'<option value="__add">＋ Use another account…</option>':'');
  select.value=auth.account||'';select.hidden=!list.length;
}
$('#account-select').addEventListener('change',guarded(async e=>{
  const id=e.target.value;
  if(id==='__add'){ // sign in to (or create) another account without signing out of this one
    e.target.value=auth.account||'';addingAccount=true;streamAbort?.abort();clearTimeout(refreshTimer);
    $('#workspace').hidden=true;$('#login').hidden=false;authTab('signin');$('#auth-back').hidden=false;$('#signin-email').value='';return;
  }
  await authPost('switch',{account:id});resetWorkspace();showView('inbox');await openWorkspace();toast('Switched to '+(auth.accounts?.find(a=>a.id===id)?.email||'the other account'));
}));
$('#auth-back').addEventListener('click',guarded(async()=>{addingAccount=false;await openWorkspace();}));
const clearSignup=()=>{$('#signup-form').reset();$('#verify-code').value='';const guess=(navigator.language||'').split('-')[1];if(guess&&[...$('#signup-country').options].some(o=>o.value===guess))$('#signup-country').value=guess;paintRules();};
// The two tabs on the sign-in page. Both offer the provider buttons; a provider sign-in needs nothing else.
function authTab(name){
  const canCreate=auth.canAdd!==false||!auth.hasAccount;if(name==='signup'&&!canCreate)name='signin';
  panel(name);$('#auth-tabs').hidden=false;for(const b of $$('#auth-tabs [data-tab]')){const on=b.dataset.tab===name;b.classList.toggle('active',on);b.setAttribute('aria-selected',on);b.hidden=b.dataset.tab==='signup'&&!canCreate;}
  paintSocial(name==='signup'?'Sign up':'Continue');$('#signin-note').hidden=!auth.cloud;
  if(name==='signup'){
    $('#setup-token-label').hidden=!auth.hostedSetup;
    // No way to email a code right now: offer the sign-in buttons instead of a form that can't finish.
    const social=(auth.providers||[]).length,noEmail=!auth.emailReady&&social>0;
    $('#signup-form').hidden=noEmail;if(noEmail)$$('#auth-signup [data-social-or]').forEach(e=>e.hidden=true);
    $('#signup-note').textContent=!auth.emailReady?(social?'Sign up with one of these accounts. Email sign-up is unavailable right now.':'Relay can\'t send email codes here: set SMTP_URL in .env (see README) so Relay can send your code.'):auth.hasAccount?'This adds a separate account to this computer, with its own WhatsApp and AI connections. Use a different email from your other account.':'Your account keeps your WhatsApp and AI connections together. You\'ll use it to sign in from now on.';
  }
}
$('#auth-tabs').addEventListener('click',e=>{const b=e.target.closest('[data-tab]');if(!b)return;if(b.dataset.tab==='signup')clearSignup();authTab(b.dataset.tab);});
// ----- an account that follows you to other computers -----
async function renderSync(){
  const card=$('#sync-card');let s;try{s=await api('/api/sync');}catch{card.hidden=true;return;}
  card.hidden=!s.available;if(!s.available)return;
  const noPw=state.account&&state.account.hasPassword===false;$('#sync-password-label').textContent=noPw?'Choose a password for this account (12+ characters)':'Your Relay password';$('#sync-password').autocomplete=noPw?'new-password':'current-password';
  $('#sync-start-form').hidden=s.on||s.waitingForCode;$('#sync-code-form').hidden=!s.waitingForCode;$('#sync-actions').hidden=!s.on;
  $('#sync-text').textContent=s.on?`On for ${s.email}. On another computer, sign in to Relay the same way (your sign-in button and passcode, or your email and password), and this account’s profiles and settings appear there.`:s.waitingForCode?'We emailed you a 6-digit code. Enter it to finish.':(noPw?'Off. You signed in without a password. Choose one here to use this account on another computer; it also locks the synced copy.':'Off. Turn it on to sign in to this account from another computer.');
  $('#sync-note').textContent=s.problem||(s.on?'Each computer links WhatsApp once with its own QR code. Your messages stay on your computers. The synced copy is locked with your password, so the Relay Accounts service can’t read it.':'What travels: your name, country and phone, your WhatsApp profile names, and which AI apps you set up, locked with your password. Your messages and the WhatsApp link itself stay on this computer.');
}
$('#sync-start-form').addEventListener('submit',guarded(async()=>{const s=await api('/api/sync/start',{password:$('#sync-password').value});$('#sync-password').value='';await renderSync();toast(s.on?'This account now follows you to other computers.':'We emailed you a code.');}));
$('#sync-code-form').addEventListener('submit',guarded(async()=>{
  const code=$('#sync-code').value.trim();
  try{await api('/api/sync/confirm',{code});}
  catch(e){if(!/replace the synced copy/.test(e.message)||!confirm(e.message+'\n\nReplace the synced copy with this computer’s account?'))throw e;await api('/api/sync/confirm',{code,replace:true});}
  $('#sync-code').value='';await renderSync();toast('This account now follows you to other computers.');
}));
$('#sync-now').addEventListener('click',guarded(async()=>{await api('/api/sync/now',{});await loadState();await renderSync();toast('Synced');}));
$('#sync-off').addEventListener('click',guarded(async()=>{if(!confirm('Turn this off and delete the synced copy? Your account stays on this computer. Other computers keep their own copy.'))return;await api('/api/sync/off',{});await renderSync();toast('Turned off. The synced copy was deleted.');}));
// The checklist shown after an account arrives on a new computer.
function paintSetup(){
  const el=$('#setup-banner'),s=state.setup;el.hidden=!s;if(!s)return;
  const todo=(state.profiles||[]).filter(p=>p.state!=='connected');
  const apps=[['claudeDesktop','claude-desktop','Claude Desktop'],['claudeCode','claude-code','Claude Code']].filter(([key])=>s.aiApps[key]&&!s.here[key]);
  el.innerHTML='<strong>Welcome back.</strong> This account came from your other computer. To finish on this one: '
    +(todo.length?'link WhatsApp for '+todo.map(p=>`<button class="quiet" data-link="${escape(p.id)}">${escape(p.name)} ↗</button>`).join(' '):'WhatsApp is linked.')
    +apps.map(([,app,label])=>` <button class="quiet" data-app="${app}">Add Relay to ${label} ↗</button>`).join('')
    +' <button class="quiet" data-done>Hide this</button><br><span class="muted">Each computer links WhatsApp with its own QR code. Your messages were not copied here.</span>';
}
$('#setup-banner').addEventListener('click',guarded(async e=>{
  const b=e.target.closest('button');if(!b)return;
  if(b.dataset.link){if(b.dataset.link!==profile)await switchProfile(b.dataset.link);if(state.state!=='connected'&&state.state!=='pairing')await connect();}
  else if(b.dataset.app){await addLocalApp(b.dataset.app);await loadState();}
  else if('done' in b.dataset){await api('/api/setup/done',{});await loadState();}
}));
$('#remove-account-form').addEventListener('submit',guarded(async()=>{
  if(!confirm('Remove this account from this computer? Its WhatsApp will be unlinked and its messages here deleted. This can’t be undone.'))return;
  const typed=$('#remove-account-password').value;await authPost('remove-account',state.account?.hasPassword===false?{email:typed}:{password:typed});$('#remove-account-password').value='';
  streamAbort?.abort();$('#workspace').hidden=true;$('#login').hidden=false;resetWorkspace();await showAuth();
}));
$('#login-form').addEventListener('submit',async e=>{e.preventDefault();token=$('#token').value.trim();try{await openWorkspace();}catch(err){$('#login-error').textContent=err.message;}});
$('#logout').addEventListener('click',lock);
// ----- account sign-in, sign-up, email code and password reset -----
const COUNTRIES='AF93 AL355 DZ213 AD376 AO244 AG1 AR54 AM374 AU61 AT43 AZ994 BS1 BH973 BD880 BB1 BY375 BE32 BZ501 BJ229 BT975 BO591 BA387 BW267 BR55 BN673 BG359 BF226 BI257 KH855 CM237 CA1 CV238 CF236 TD235 CL56 CN86 CO57 KM269 CG242 CD243 CR506 CI225 HR385 CU53 CY357 CZ420 DK45 DJ253 DM1 DO1 EC593 EG20 SV503 GQ240 ER291 EE372 SZ268 ET251 FJ679 FI358 FR33 GA241 GM220 GE995 DE49 GH233 GR30 GD1 GT502 GN224 GW245 GY592 HT509 HN504 HK852 HU36 IS354 IN91 ID62 IR98 IQ964 IE353 IL972 IT39 JM1 JP81 JO962 KZ7 KE254 KI686 KW965 KG996 LA856 LV371 LB961 LS266 LR231 LY218 LI423 LT370 LU352 MO853 MG261 MW265 MY60 MV960 ML223 MT356 MH692 MR222 MU230 MX52 FM691 MD373 MC377 MN976 ME382 MA212 MZ258 MM95 NA264 NR674 NP977 NL31 NZ64 NI505 NE227 NG234 KP850 MK389 NO47 OM968 PK92 PW680 PS970 PA507 PG675 PY595 PE51 PH63 PL48 PT351 PR1 QA974 RO40 RU7 RW250 KN1 LC1 VC1 WS685 SM378 ST239 SA966 SN221 RS381 SC248 SL232 SG65 SK421 SI386 SB677 SO252 ZA27 KR82 SS211 ES34 LK94 SD249 SR597 SE46 CH41 SY963 TW886 TJ992 TZ255 TH66 TL670 TG228 TO676 TT1 TN216 TR90 TM993 TV688 UG256 UA380 AE971 GB44 US1 UY598 UZ998 VU678 VA39 VE58 VN84 YE967 ZM260 ZW263'.split(' ').map(x=>({code:x.slice(0,2),dial:x.slice(2)}));
const PASSWORD_RULES=[['12+ characters',p=>p.length>=12],['a lowercase letter',p=>/[a-z]/.test(p)],['an uppercase letter',p=>/[A-Z]/.test(p)],['a number',p=>/\d/.test(p)],['a symbol',p=>/[^A-Za-z0-9]/.test(p)]];
let auth={},pendingEmail='';
const params=new URLSearchParams(location.search);
function safeNext(){const n=params.get('next')||'';return n.startsWith('/oauth/authorize?')?n:'';}
function afterLogin(){const n=safeNext();if(n){location.href=n;return true;}return false;}
async function authPost(path,body){const r=await fetch('/auth/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||'Something went wrong.');return j;}
function panel(name){for(const id of ['signin','signup','verify','reset','unlock'])$('#auth-'+id).hidden=id!==name;$('#auth-tabs').hidden=!['signin','signup'].includes(name);$('#auth-loading').hidden=true;$('#login-error').textContent='';}
function paintRules(){const p=$('#signup-password').value;$('#password-rules').innerHTML=PASSWORD_RULES.map(([label,ok])=>`<li class="${ok(p)?'ok':''}">${label}</li>`).join('');}
function fillCountries(){
  let names;try{names=new Intl.DisplayNames([navigator.language||'en'],{type:'region'});}catch{names={of:c=>c};}
  const list=COUNTRIES.map(c=>({...c,name:names.of(c.code)||c.code})).sort((a,b)=>a.name.localeCompare(b.name));
  $('#signup-country').innerHTML='<option value="">Choose your country</option>'+list.map(c=>`<option value="${c.code}" data-dial="${c.dial}">${escape(c.name)} (+${c.dial})</option>`).join('');
  const guess=(navigator.language||'').split('-')[1];if(guess&&list.some(c=>c.code===guess))$('#signup-country').value=guess;
}
function paintSocial(verb){
  const html=(auth.providers||[]).map(p=>`<a href="/auth/oauth/${encodeURIComponent(p.id)}"><b>${{google:'G',microsoft:'⊞',github:'⌥',facebook:'f'}[p.id]||'↗'}</b> ${verb} with ${escape(p.name)}</a>`).join('');
  for(const el of $$('[data-social]')){el.innerHTML=html;el.hidden=!html;}for(const el of $$('[data-social-or],[data-social-note]'))el.hidden=!html;
}
async function showAuth(){
  auth=await (await fetch('/auth/status')).json();
  if(auth.signedIn&&!addingAccount)return openWorkspace();
  if(auth.locked&&!addingAccount)return paintUnlock();
  authTab(auth.hasAccount?'signin':'signup');
  if(params.get('auth_error'))$('#login-error').textContent=params.get('auth_error');
}
// A provider sign-in proved who this is; the passcode opens the chats (and is chosen on the first sign-in).
function paintUnlock(){
  panel('unlock');const fresh=auth.needsPasscode;$('#unlock-form').reset();
  $('#unlock-title').textContent=fresh?'Create a passcode':'Enter your passcode';
  $('#unlock-existing-label').hidden=!(fresh&&auth.cloud);$('#unlock-forgot').hidden=fresh;paintUnlockMode();
}
function paintUnlockMode(){
  const fresh=auth.needsPasscode,existing=fresh&&$('#unlock-existing').checked;
  $('#unlock-note').textContent=!fresh?`Signed in as ${auth.lockedEmail}. Your passcode keeps your chats private on this computer.`:existing?`Signed in as ${auth.lockedEmail}. Enter the passcode you chose on your other computer to bring your settings here.`:`Signed in as ${auth.lockedEmail}. Choose a passcode of at least 8 characters. Relay asks for it when you sign in and after 15 minutes away, so your chats stay private.`;
  $('#unlock-label').textContent=fresh&&!existing?'New passcode':'Passcode';$('#unlock-passcode').autocomplete=fresh&&!existing?'new-password':'current-password';
  $('#unlock-confirm-label').hidden=!fresh||existing;$('#unlock-confirm').required=fresh&&!existing;
}
$('#unlock-existing').addEventListener('change',paintUnlockMode);
$('#unlock-forgot').addEventListener('click',()=>{panel('reset');$('#reset-email').value=auth.lockedEmail||'';});
$('#unlock-signout').addEventListener('click',async()=>{await fetch('/auth/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).catch(()=>{});await showAuth();});
// 15 minutes without touching the page locks it again.
let idleTimer;const IDLE_MS=15*60000;
function idleLock(){
  if(token||$('#workspace').hidden)return;
  fetch('/auth/lock',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).catch(()=>{}).then(()=>{streamAbort?.abort();clearTimeout(refreshTimer);$('#media-dialog').close();$('#workspace').hidden=true;$('#login').hidden=false;resetWorkspace();return showAuth();}).catch(()=>{});
}
function touch(){clearTimeout(idleTimer);idleTimer=setTimeout(idleLock,window.RELAY_IDLE_MS||IDLE_MS);}
for(const type of ['pointerdown','keydown','wheel','touchstart'])document.addEventListener(type,touch,{passive:true});touch();
const run=fn=>async e=>{e.preventDefault();$('#login-error').textContent='';const btn=e.target.querySelector('button');if(btn)btn.disabled=true;try{await fn(e);}catch(err){$('#login-error').textContent=err.message;}finally{if(btn)btn.disabled=false;}};
$('#signin-form').addEventListener('submit',run(async()=>{await authPost('login',{email:$('#signin-email').value,password:$('#signin-password').value});$('#signin-password').value='';await openWorkspace();}));
$('#unlock-form').addEventListener('submit',run(async()=>{
  const passcode=$('#unlock-passcode').value;
  if(auth.needsPasscode){
    const existing=$('#unlock-existing').checked;
    if(!existing&&passcode!==$('#unlock-confirm').value)throw new Error('The passcodes don\'t match.');
    await authPost('passcode',{passcode,existing});
  }else await authPost('unlock',{passcode});
  $('#unlock-form').reset();await openWorkspace();
}));
$('#signup-password').addEventListener('input',paintRules);
$('#signup-country').addEventListener('change',()=>{const dial=$('#signup-country').selectedOptions[0]?.dataset.dial;const ph=$('#signup-phone');if(dial&&(!ph.value||/^\+\d{0,4}\s?$/.test(ph.value)))ph.value='+'+dial+' ';});
$('#signup-form').addEventListener('submit',run(async()=>{
  if($('#signup-password').value!==$('#signup-confirm').value)throw new Error('The passwords don\'t match.');
  const body={fullName:$('#signup-name').value,country:$('#signup-country').value,phone:$('#signup-phone').value,email:$('#signup-email').value,password:$('#signup-password').value,setupToken:$('#signup-setup-token').value||undefined};
  const r=await authPost('signup',body);
  if(r.signedIn){history.replaceState(null,'',location.pathname+(safeNext()?'?next='+encodeURIComponent(safeNext()):''));clearSignup();return openWorkspace();}
  pendingEmail=r.email;$('#verify-code').value='';$('#verify-email').textContent=r.email;$('#demo-code').hidden=!r.demoCode;$('#demo-code').textContent=r.demoCode?`Demo mode: your code is ${r.demoCode}`:'';panel('verify');$('#verify-code').focus();
}));
$('#verify-form').addEventListener('submit',run(async()=>{await authPost('verify',{email:pendingEmail,code:$('#verify-code').value.trim(),setupToken:$('#signup-setup-token').value||undefined});clearSignup();await openWorkspace();}));
$('#resend-code').addEventListener('click',()=>authPost('resend',{email:pendingEmail}).then(r=>{if(r.demoCode){$('#demo-code').hidden=false;$('#demo-code').textContent=`Demo mode: your code is ${r.demoCode}`;}toast('A new code is on its way.');}).catch(e=>$('#login-error').textContent=e.message));
$('#reset-request-form').addEventListener('submit',run(async()=>{const r=await authPost('reset/request',{email:$('#reset-email').value});$('#reset-request-form').hidden=true;$('#reset-confirm-form').hidden=false;$('#reset-demo-code').hidden=!r.demoCode;$('#reset-demo-code').textContent=r.demoCode?`Demo mode: your code is ${r.demoCode}`:'';}));
$('#reset-confirm-form').addEventListener('submit',run(async()=>{await authPost('reset/confirm',{email:$('#reset-email').value,code:$('#reset-code').value.trim(),password:$('#reset-password').value});$('#reset-password').value='';await openWorkspace();}));
for(const b of $$('[data-go]'))b.addEventListener('click',()=>{panel(b.dataset.go);if(b.dataset.go==='reset'){$('#reset-request-form').hidden=false;$('#reset-confirm-form').hidden=true;$('#reset-email').value=$('#signin-email').value;}});
fillCountries();paintRules();
if(token)openWorkspace().catch(e=>{$('#login-error').textContent=e.message;lock();});
else showAuth().catch(e=>{$('#auth-loading').hidden=true;$('#login-error').textContent='Could not reach your bridge: '+e.message;});
async function refreshChats(){const asked=profile,list=await tool('list_chats',{limit:500});if(asked!==profile)return; // answer for a profile we've left
  chats=list;$('#chat-count').textContent=chats.length;renderChats();}
function renderChats(){
  const query=$('#chat-search').value.toLowerCase();const filtered=chats.filter(c=>(!unread||Number(c.unreadCount)>0)&&[c.name,c.id].join(' ').toLowerCase().includes(query));
  $('#chat-list').innerHTML=filtered.length?filtered.map(c=>`<button class="chat-item ${c.id===selected?'active':''}" data-chat="${escape(c.id)}"><span class="avatar ${c.id.endsWith('@g.us')?'group':''}">${escape((c.name || c.id).split(' ').slice(0,2).map(s=>s[0]).join('').toUpperCase())}</span><span class="chat-copy"><span class="chat-name-row"><span class="chat-name">${escape(c.name || label(c.id))}</span><span class="chat-time">${time(c.conversationTimestamp)}</span></span><span class="chat-preview">${escape(c.preview || (c.id.endsWith('@g.us')?'Group conversation':'Start a conversation'))}</span></span>${c.unreadCount>0?`<span class="unread-badge">${escape(c.unreadCount)}</span>`:''}</button>`).join(''):'<div class="blank-state">No conversations here yet.<br>Pair WhatsApp to sync your chats.</div>';
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
  if(selecting){selecting=null;paintSelectBar();}closeMenu();
  if(selected && selected!==chat && $('#message-input').value.trim() && !confirm('Switch conversations and discard the text in the composer? Save a draft first if you want to keep it.'))return;
  selected=chat;pageSize=100;replyTo=null;editing=null;$('#message-input').value='';clearReply();showView('inbox');$('#view-inbox').classList.add('chat-open');$('#messages').hidden=false;$('#search-results').hidden=true;
  $('#chat-header').innerHTML=`<div><span class="eyebrow">${chat.endsWith('@g.us')?'GROUP CONVERSATION':'DIRECT CONVERSATION'}</span><h2 title="Back to chats on mobile">${escape(name(chat))}</h2></div><button id="export" class="quiet">Export ↓</button>`;
  $('#chat-header h2').onclick=()=>$('#view-inbox').classList.remove('chat-open');$('#export').onclick=guarded(exportChat);renderChats();paintStatus();await refreshMessages(true);
}
async function refreshMessages(scroll=false){
  if(!selected)return;const chat=selected;const messages=await tool('get_messages',{chat,limit:pageSize});if(selected!==chat)return;
  const container=$('#messages'),nearBottom=container.scrollHeight-container.scrollTop-container.clientHeight<100;
  // Top button: more of what's already synced, or (once that's all shown) ask the phone for older history.
  const more=messages.length===pageSize&&pageSize<500,fromPhone=messages.length&&!more&&!state.demo;
  byId.clear();let date='';container.innerHTML=(more?'<button id="load-more" class="load-more">Load earlier messages ↑</button>':fromPhone?'<button id="load-older" class="load-more">Load older messages from your phone ↑</button>':'')+messages.reverse().map(m=>{
    const d=new Date(m.timestamp*1000).toLocaleDateString([],{month:'long',day:'numeric',year:'numeric'});let divider='';if(d!==date){date=d;divider=`<div class="date-divider">${escape(d)}</div>`;}
    byId.set(m.id,m);
    const actions=m.kind==='call'?'':`${m.hasMedia&&!m.deleted?'<button data-action="view-media">View media</button><button data-action="download">Download</button>':''}<button data-action="menu" aria-label="Message options" aria-haspopup="menu">⋯</button>`;
    const flags=`${m.starred?' · ★ starred':''}${m.pinned&&(!m.pinnedUntil||m.pinnedUntil*1000>Date.now())?' · 📌 pinned':''}`;
    const attachment=m.media&&!m.deleted?`<div class="attachment-label">${escape([m.media.voiceNote?'Voice note':m.media.kind,m.media.filename,m.media.durationSeconds!=null?m.media.durationSeconds+' sec':''].filter(Boolean).join(' · '))}</div>`:'';
    return divider+`<article class="message ${m.fromMe?'mine':''} ${m.deleted?'deleted':''} ${m.kind==='call'?'call-entry':''} ${selecting?.has(m.id)?'selected':''}" data-message="${escape(m.id)}">${selecting?`<input type="checkbox" class="pick" aria-label="Select message" ${selecting.has(m.id)?'checked':''}>`:''}<div class="message-author">${m.fromMe?'You':escape(m.pushName || name(chat))}</div><div class="bubble">${escape(m.deleted?'This message was deleted':m.text || (m.media?'Attachment':'['+m.kind+']'))}${attachment}</div><div class="message-meta"><span>${time(m.timestamp)}${m.edited?' · edited':''}${flags}</span><div class="message-actions">${actions}</div></div></article>`;
  }).join('');
  if(!messages.length)container.innerHTML='<div class="empty"><h2>Start the conversation.</h2><p>Only messages synced by WhatsApp appear here.</p></div>';
  if($('#load-more'))$('#load-more').onclick=guarded(async()=>{const old=container.scrollHeight;pageSize=Math.min(500,pageSize+100);await refreshMessages();container.scrollTop=container.scrollHeight-old;});
  if($('#load-older'))$('#load-older').onclick=guarded(async()=>{
    const button=$('#load-older');button.disabled=true;button.textContent='Asking your phone for older messages…';
    await api('/api/history',{chat});const before=messages.length;
    // They arrive through WhatsApp's history sync, usually within a few seconds (the phone must be online).
    for(const wait of [2000,4000,8000]){await new Promise(r=>setTimeout(r,wait));if(selected!==chat)return;const n=(await tool('get_messages',{chat,limit:500})).length;if(n>before){pageSize=Math.min(500,Math.max(pageSize,n));const old=container.scrollHeight;await refreshMessages();container.scrollTop=container.scrollHeight-old;return;}}
    if($('#load-older')){$('#load-older').disabled=false;$('#load-older').textContent='No older messages arrived. Is your phone online? Try again ↑';}
  });
  if(scroll||nearBottom)container.scrollTop=container.scrollHeight;
}
function clearReply(){replyTo=null;editing=null;$('#reply-bar').hidden=true;$('#send').textContent='Send message ↗';}
$('#clear-reply').onclick=clearReply;
const textKinds=['conversation','extendedTextMessage'];
const msgText=m=>m?.text||'';
const personOf=m=>m?.pushName||label(m?.sender);
function closeMenu(){const menu=$('#msg-menu');menu.hidden=true;menu.innerHTML='';}
function openMenu(button,id){
  const m=byId.get(id);if(!m)return;const menu=$('#msg-menu');
  const group=selected?.endsWith('@g.us'),other=group&&!m.fromMe&&m.sender&&!String(m.sender).endsWith('@g.us');
  const items=[];
  if(!m.deleted){
    items.push(['reply','Reply']);
    if(other)items.push(['reply-privately','Reply privately']);
    items.push(['react','React'],[m.starred?'unstar':'star',m.starred?'Unstar':'Star'],[m.pinned&&(!m.pinnedUntil||m.pinnedUntil*1000>Date.now())?'unpin':'pin',m.pinned&&(!m.pinnedUntil||m.pinnedUntil*1000>Date.now())?'Unpin':'Pin'],['forward','Forward']);
    if(msgText(m))items.push(['copy','Copy']);
    items.push(['info','Info']);
    if(m.fromMe&&textKinds.includes(m.kind))items.push(['edit','Edit']);
  }
  if(other)items.push(['message-person','Message '+personOf(m)]);
  items.push('-');
  if(!m.deleted&&m.fromMe)items.push(['delete','Delete for everyone']);
  items.push(['delete-for-me','Delete for me'],'-',['select','Select messages']);
  menu.innerHTML=items.map(i=>i==='-'?'<hr>':`<button role="menuitem" data-menu="${i[0]}" data-id="${escape(id)}">${escape(i[1])}</button>`).join('');
  menu.hidden=false;const r=button.getBoundingClientRect(),h=menu.offsetHeight,w=menu.offsetWidth;
  menu.style.left=Math.max(8,Math.min(innerWidth-w-8,r.right-w))+'px';menu.style.top=Math.max(8,Math.min(innerHeight-h-8,r.bottom+4))+'px';menu.querySelector('button')?.focus();
}
function setSelecting(on){selecting=on?new Set():null;paintSelectBar();refreshMessages();}
function paintSelectBar(){
  const bar=$('#select-bar');bar.hidden=!selecting;if(!selecting)return;
  const n=selecting.size;bar.querySelector('span').textContent=n?`${n} selected`:'Tap messages to select them';
  for(const b of bar.querySelectorAll('[data-bulk]'))b.disabled=!n;
}
async function copyText(text){try{await navigator.clipboard.writeText(text);}catch{const t=document.createElement('textarea');t.value=text;document.body.append(t);t.select();document.execCommand('copy');t.remove();}}
function snippet(m){return (msgText(m)||'a message').replace(/\s+/g,' ').slice(0,80);}
async function openPerson(jid,prefill=''){
  if(!chats.some(c=>c.id===jid))chats.unshift({id:jid,name:label(jid)});
  await selectChat(jid);if(prefill){$('#message-input').value=prefill;$('#message-input').focus();}
}
async function runMenu(action,id){
  const m=byId.get(id),chat=selected;if(!m||!chat)return;
  switch(action){
    case 'reply':clearReply();replyTo=id;$('#reply-bar span').textContent='Replying to: '+snippet(m);$('#reply-bar').hidden=false;$('#message-input').focus();break;
    case 'reply-privately':await openPerson(m.sender,`Re: “${snippet(m)}” — `);break;
    case 'message-person':await openPerson(m.sender);break;
    case 'react':{const emoji=prompt('Emoji reaction (leave empty to remove):','👍');if(emoji!==null){await tool('react_message',{chat,id,emoji});toast('Reaction submitted');}break;}
    case 'star':case 'unstar':await tool('star_message',{chat,id,starred:action==='star'});await refreshMessages();toast(action==='star'?'Starred':'Unstarred');break;
    case 'pin':{const d=prompt('Pin for how many days? 1, 7 or 30','7');if(d===null)break;const days=Number(d);if(![1,7,30].includes(days))throw new Error('Choose 1, 7 or 30 days.');await tool('pin_message',{chat,id,pinned:true,days});await refreshMessages();toast('Pinned for '+days+(days===1?' day':' days'));break;}
    case 'unpin':await tool('pin_message',{chat,id,pinned:false});await refreshMessages();toast('Unpinned');break;
    case 'forward':openForward([id]);break;
    case 'info':{const i=await tool('message_info',{chat,id});const when=t=>t?new Date(t*1000).toLocaleString():'';
      const rows=[['Sent',when(i.sent)],...(i.fromMe?[['Status',i.status||'unknown']]:[]),...(i.edited?[['Edited','yes']]:[]),...(i.starred?[['Starred','yes']]:[]),...(i.pinned?[['Pinned','yes']]:[])];
      const people=(i.receipts||[]).map(r=>`<li><strong>${escape(r.name&&r.name!==r.who?r.name:label(r.who))}</strong><small>${r.read?'Read '+escape(when(r.read)):r.delivered?'Delivered '+escape(when(r.delivered)):''}${r.played?' · Played '+escape(when(r.played)):''}</small></li>`).join('');
      $('#info-body').innerHTML=`<dl>${rows.filter(r=>r[1]).map(r=>`<dt>${escape(r[0])}</dt><dd>${escape(r[1])}</dd>`).join('')}</dl>${i.fromMe?`<h3>Delivered and read by</h3>${people?`<ul class="receipts">${people}</ul>`:'<p class="muted">No delivery details yet. WhatsApp only reports them while Relay is running.</p>'}`:''}`;
      $('#info-dialog').showModal();break;}
    case 'copy':await copyText(msgText(m));toast('Copied');break;
    case 'edit':clearReply();editing=id;$('#message-input').value=msgText(m);$('#reply-bar span').textContent='Editing your message';$('#reply-bar').hidden=false;$('#send').textContent='Save edit ↗';$('#message-input').focus();break;
    case 'delete':if(confirm('Delete this message for everyone?')){await tool('delete_message',{chat,id});await refreshMessages();toast('Deletion submitted');}break;
    case 'delete-for-me':if(confirm('Delete this message for you? Other people in the chat will still see it.')){await tool('delete_message_for_me',{chat,id});await refreshMessages();toast('Deleted for you');}break;
    case 'select':selecting=new Set([id]);paintSelectBar();await refreshMessages();break;
  }
}
let forwardIds=[];
function openForward(ids){
  forwardIds=ids;const sel=$('#forward-to');
  sel.innerHTML=chats.filter(c=>c.id!==selected).map(c=>`<option value="${escape(c.id)}">${escape(name(c.id))}</option>`).join('');
  if(!sel.options.length)throw new Error('There is no other chat to forward to.');
  $('#forward-count').textContent=ids.length===1?'1 message':ids.length+' messages';$('#forward-dialog').showModal();
}
$('#forward-form').addEventListener('submit',guarded(async e=>{
  e.preventDefault();const to=$('#forward-to').value,from=selected,ids=[...forwardIds];$('#forward-dialog').close();
  for(const id of ids)await tool('forward_message',{chat:from,id,to});
  if(selecting)setSelecting(false);toast(ids.length===1?'Forwarded':'Forwarded '+ids.length+' messages');
}));
$('#select-bar').addEventListener('click',guarded(async e=>{
  const b=e.target.closest('[data-bulk]');if(!b)return;const ids=[...selecting||[]];const chat=selected;
  const ordered=[...byId.keys()].filter(id=>ids.includes(id));
  switch(b.dataset.bulk){
    case 'cancel':setSelecting(false);break;
    case 'copy':await copyText(ordered.map(id=>{const m=byId.get(id);return `[${new Date(m.timestamp*1000).toLocaleString()}] ${m.fromMe?'You':personOf(m)}: ${msgText(m)||'['+m.kind+']'}`;}).join('\n'));toast('Copied '+ordered.length);break;
    case 'forward':openForward(ordered);break;
    case 'star':for(const id of ordered)await tool('star_message',{chat,id,starred:true});setSelecting(false);toast('Starred');break;
    case 'delete':if(confirm(`Delete ${ordered.length} message${ordered.length===1?'':'s'} for you? Other people will still see them.`)){for(const id of ordered)await tool('delete_message_for_me',{chat,id});setSelecting(false);toast('Deleted for you');}break;
  }
}));
document.addEventListener('click',e=>{if(!e.target.closest('#msg-menu')&&!e.target.closest('[data-action="menu"]'))closeMenu();});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeMenu();if(selecting)setSelecting(false);}});
$('#msg-menu').addEventListener('click',guarded(async e=>{const b=e.target.closest('[data-menu]');if(!b)return;closeMenu();await runMenu(b.dataset.menu,b.dataset.id);}));
$('#messages').addEventListener('click',guarded(async e=>{
  const article=e.target.closest('[data-message]');if(!article)return;const id=article.dataset.message;
  if(selecting){if(e.target.closest('[data-action]'))return;selecting.has(id)?selecting.delete(id):selecting.add(id);paintSelectBar();article.classList.toggle('selected',selecting.has(id));const box=article.querySelector('.pick');if(box)box.checked=selecting.has(id);return;}
  const button=e.target.closest('[data-action]');if(!button)return;
  switch(button.dataset.action){
    case 'menu':e.stopPropagation();$('#msg-menu').hidden?openMenu(button,id):closeMenu();break;
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
$('#attach').onclick=e=>{e.stopPropagation();const m=$('#attach-menu');if(!m.hidden){m.hidden=true;return;}m.hidden=false;const r=$('#attach').getBoundingClientRect();m.style.left=Math.max(8,r.left)+'px';m.style.top=Math.max(8,r.top-m.offsetHeight-8)+'px';};
document.addEventListener('click',e=>{if(!e.target.closest('#attach-menu')&&e.target.id!=='attach')$('#attach-menu').hidden=true;});
$('#attach-menu').addEventListener('click',guarded(async e=>{
  const b=e.target.closest('[data-attach]');if(!b)return;$('#attach-menu').hidden=true;if(!selected)return;
  const input=$('#file-input');
  switch(b.dataset.attach){
    case 'file':input.accept='';input.click();break;
    case 'media':input.accept='image/*,video/*';input.click();break;
    case 'poll':$('#poll-form').reset();$('#poll-error').textContent='';$('#poll-dialog').showModal();break;
    case 'event':$('#event-form').reset();$('#event-error').textContent='';$('#event-dialog').showModal();break;
    case 'contact':$('#contact-form').reset();$('#contact-error').textContent='';$('#contact-dialog').showModal();break;
  }
}));
async function sendFrom(dialogId,errorId,run){
  const chat=selected;if(!chat)return;
  try{await run(chat);$(dialogId).close();await refreshMessages(true);await refreshChats();toast('Sent');}
  catch(e){$(errorId).textContent=e.message;}
}
$('#poll-form').addEventListener('submit',e=>{e.preventDefault();sendFrom('#poll-dialog','#poll-error',async chat=>{
  const options=$('#poll-options').value.split('\n').map(x=>x.trim()).filter(Boolean);
  if(options.length<2)throw new Error('Add at least two options, one per line.');
  await tool('create_poll',{chat,name:$('#poll-question').value.trim(),options,selectableCount:$('#poll-multi').checked?options.length:1});});});
$('#event-form').addEventListener('submit',e=>{e.preventDefault();sendFrom('#event-dialog','#event-error',async chat=>{
  const iso=v=>v?new Date(v).toISOString():undefined;
  await tool('send_event',{chat,name:$('#event-name').value.trim(),description:$('#event-description').value.trim()||undefined,startTime:iso($('#event-start').value),endTime:iso($('#event-end').value)});});});
$('#contact-form').addEventListener('submit',e=>{e.preventDefault();sendFrom('#contact-dialog','#contact-error',async chat=>{
  await tool('send_contact',{chat,name:$('#contact-name').value.trim(),phone:$('#contact-phone').value.trim()});});});
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
  const response=await fetch(withProfile('/api/media/'+encodeURIComponent(file.fileId)),{headers:authHeaders()});
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
  $('#local-apps').hidden=!state.localApps;
  $('#account-box').hidden=!state.account?.email;$('#account-line').textContent=state.account?.email?`Signed in as ${state.account.email}.`+(state.account.first?'':' Claude sees this account’s WhatsApp as “'+Object.keys(state.localConfig?.mcpServers||{})[0]+'”.'):'';
  $('#remove-account-form').hidden=!state.account||state.account.first||Boolean(token);{const noPw=state.account?.hasPassword===false,box=$('#remove-account-password');$('#remove-account-label').textContent=noPw?'Type this account’s email to confirm':'Password';box.type=noPw?'email':'password';box.autocomplete=noPw?'off':'current-password';}
}
async function addLocalApp(app){
  const r=await api('/api/local-apps/'+app,{}),out=$('#local-apps-result');out.hidden=false;
  if(app==='claude-desktop')out.textContent=r.changed?`Added. Quit and reopen Claude Desktop, then ask it about your WhatsApp.${r.backup?' Your previous Claude settings were saved next to the file.':''}`:'Claude Desktop is already set up.';
  else out.textContent=!r.installed?'Claude Code isn’t installed on this computer.':r.added?'Added to Claude Code. Start claude and ask about your WhatsApp.':'Claude Code reported a problem: '+(r.error||'unknown');
}
$('#add-claude-desktop').onclick=guarded(()=>addLocalApp('claude-desktop'));
$('#add-claude-code').onclick=guarded(()=>addLocalApp('claude-code'));
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
      const response=await fetch(withProfile('/api/tools/wait_updates'),{method:'POST',headers:{...authHeaders(),'Content-Type':'application/json'},body:JSON.stringify({after:cursor,timeoutSeconds:2,limit:100}),signal:controller.signal});
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
      const response=await fetch(withProfile('/api/events?after='+cursor),{headers:authHeaders(),signal:controller.signal});if(!response.ok)throw new Error('Live stream unavailable');
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
