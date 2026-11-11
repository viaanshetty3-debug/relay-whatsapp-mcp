const $=selector=>document.querySelector(selector);
let token=sessionStorage.getItem('relay-token')||'';
async function load(){
  const response=await fetch('/api/remote-settings',{headers:{Authorization:'Bearer '+token}});
  if(response.status===401){$('#login').hidden=false;$('#setup').hidden=true;return;}
  const data=await response.json();if(!response.ok)throw new Error(data.error||'Setup is not available');
  if(!data.published){$('#status').textContent='Publication pending';$('#error').textContent='The hosted connector is prepared but has not been published. Your existing dashboard and WhatsApp session are unchanged.';return;}
  sessionStorage.setItem('relay-token',token);$('#login').hidden=true;$('#setup').hidden=false;$('#status').textContent='Your accounts only';
  $('#chatgpt').href=data.chatgptPluginUrl||'https://chatgpt.com/plugins';$('#endpoint').value=data.remoteUrl+'/whatsapp/mcp';
  $('#site-key').value='Bearer '+data.siteAccessKey;$('#client-key').value=data.clientKey;
}
$('#login').onsubmit=async event=>{event.preventDefault();token=$('#owner-token').value.trim();$('#owner-token').value='';try{await load();}catch(error){$('#error').textContent=error.message;}};
for(const button of document.querySelectorAll('[data-copy]'))button.onclick=async()=>{try{await navigator.clipboard.writeText($('#'+button.dataset.copy).value);$('#copied').textContent='Copied. Paste it into your own connector settings.';}catch{$('#copied').textContent='Clipboard access was blocked. Select the field and copy its value manually.';}};
load().catch(error=>{$('#error').textContent=error.message;});
