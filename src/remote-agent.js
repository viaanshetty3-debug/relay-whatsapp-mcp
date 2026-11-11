// Outbound connection to the owner's existing private Relay Site. Opens no inbound port.
import { readFileSync,writeFileSync,existsSync,mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open,seal,parts,REMOTE_MAX_BYTES } from './remote-protocol.js';
const root=fileURLToPath(new URL('../',import.meta.url));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
// Failover between two devices that are SEPARATE WhatsApp linked devices and
// share one relay agent ID, so the hosted relay never makes either wait for a
// lease. Overlap is harmless: each queued request is claimed by exactly one
// agent, and both bridges are independently connected to WhatsApp.
// - primary (Mac): serves whenever its own WhatsApp is connected.
// - standby (phone): while not serving, watches the relay's lastSeen (which
//   only the primary is moving) and serves once it has been still for
//   FAILOVER_SILENT_MS. While serving it pauses for FAILOVER_PROBE_MS every
//   FAILOVER_RECHECK_MS; if lastSeen still moves then, the primary is back
//   and the standby stops serving.
// With a relay that supports long polls, each poll is held open for up to
// LONG_POLL_MS, so lastSeen moves every ~2 s plus network time; SILENT_MS and
// PROBE_MS are sized above that so a working primary never looks silent.
export const FAILOVER_POLL_MS=750,FAILOVER_WATCH_MS=750,FAILOVER_SILENT_MS=4000,FAILOVER_SETTLE_MS=500,FAILOVER_PROBE_MS=3000,FAILOVER_RECHECK_MS=15000,LONG_POLL_MS=2000;
export function compactMediaResponse(response){
  if(!response?.result?.content)return response;
  const content=response.result.content;
  const metadata=content.find(block=>block.type==='text');let data;
  try{data=JSON.parse(metadata.text);}catch{return response;}
  if(data.fileId&&(data.base64?.length>5*1024*1024||content.some(block=>((block.type==='image'||block.type==='audio')&&block.data?.length>5*1024*1024)||(block.type==='resource'&&block.resource?.blob?.length>5*1024*1024)))){
    const {base64,...metadata}=data;
    response.result.content=[{type:'text',text:JSON.stringify({...metadata,delivery:'file',note:'The complete attachment is cached privately. Use read_media_chunk for the file, or analyze_media for transcription/analysis. Native bytes were omitted only to fit the remote tool transport.'})}];
  }
  return response;
}
export class RemoteAgent {
  constructor(settings,{fetchImpl=fetch,log=message=>console.error(message),now=Date.now,sleep=pause}={}){
    this.settings=settings;this.fetch=fetchImpl;this.log=log;this.now=now;this.abort=new AbortController();this.running=new Set();
    this.localProtocolPromise=null;
    // A single device needs no configuration: it is the primary. A standby is
    // optional and can be added later (same agentId/agentKey, its own deviceId).
    this.role=settings.failoverRole==='standby'?'standby':'primary';
    this.sleep=sleep;this.connectedSince=null;this.longPoll=false;
    // How often a standby checks the primary. Raise it (e.g. 3000) to stay
    // inside free-tier request quotas; failover then takes about watchMs longer.
    this.watchMs=Math.max(FAILOVER_WATCH_MS,Number(settings.watchMs)||FAILOVER_WATCH_MS);
    // Per-device identity (both devices share agentId) so the relay can tell
    // which device claimed a request and hand read-only work to the other one
    // if this device goes silent.
    this.device=/^[a-f0-9-]{36}$/.test(settings.deviceId||'')?settings.deviceId:undefined;
    const origin=new URL(settings.remoteUrl);if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/')throw new Error('Remote relay must be an HTTPS origin');
    const local=new URL(settings.localUrl||'http://127.0.0.1:8787');if(!['127.0.0.1','localhost','[::1]'].includes(local.hostname))throw new Error('The WhatsApp bridge must remain local');
    this.remote=origin.origin;this.local=local.origin;
  }
  async remoteRequest(path,body){
    const response=await this.fetch(this.remote+'/api/whatsapp/agent/'+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+this.settings.agentKey,...(this.settings.siteAccessKey?{'OAI-Sites-Authorization':'Bearer '+this.settings.siteAccessKey}:{})},body:JSON.stringify(body),signal:AbortSignal.any([this.abort.signal,AbortSignal.timeout(20000)])});
    if(!response.ok){
      const message=response.status===409&&path==='complete'?'A request this device was answering had already been handed to another device (normal after a failover); its result was discarded.'
        :response.status===409?'Relay refused this device (409): another agent ID is active. A standby must use the primary\'s RELAY_AGENT_ID.'
        :'Relay request failed ('+response.status+'). Check RELAY_REMOTE_URL and that RELAY_AGENT_KEY matches the relay\'s WA_AGENT_KEY.';
      const error=new Error(message);error.status=response.status;throw error;
    }return response.json();
  }
  health(){return this.remoteRequest('health',{agent:this.settings.agentId});}
  // Primary: WhatsApp connected here for FAILOVER_SETTLE_MS.
  async primaryReady(){
    const now=this.now();
    if((await this.bridgeStatus()).state!=='connected'){this.connectedSince=null;return false;}
    this.connectedSince??=now;return now-this.connectedSince>=FAILOVER_SETTLE_MS;
  }
  // Standby, while not polling: does lastSeen move during a short window?
  async primaryActive(){
    const first=await this.health().catch(()=>null);
    if(!first?.lastSeen)return false;
    await this.sleep(FAILOVER_PROBE_MS);
    const second=await this.health().catch(()=>null);
    if(!second||second.lastSeen===first.lastSeen)return false;
    this.seen=second.lastSeen;this.changedAt=this.now();return true;
  }
  // Standby: one observation of the relay. Returns true when the primary has gone silent.
  async watchStep(){
    const state=await this.health().catch(()=>undefined),now=this.now();
    if(state===undefined)return false;
    if(!state.lastSeen)return true;
    if(state.lastSeen!==this.seen){this.seen=state.lastSeen;this.changedAt=now;}
    return now-this.changedAt>=FAILOVER_SILENT_MS;
  }
  async postLocal(body,headers){
    const response=await this.fetch(this.local+'/mcp',{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.any([this.abort.signal,AbortSignal.timeout(70000)])});
    const data=await response.json().catch(()=>null);
    if(!response.ok){const detail=typeof data?.error?.message==='string'?': '+data.error.message.slice(0,600):'';throw new Error('Local WhatsApp bridge request failed ('+response.status+')'+detail);}
    if(!data)throw new Error('Local WhatsApp bridge returned an invalid MCP response');
    return data;
  }
  async localProtocol(headers){
    if(!this.localProtocolPromise){
      this.localProtocolPromise=this.postLocal({jsonrpc:'2.0',id:'relay-local-initialize',method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'relay-remote-agent',version:'1.0.0'}}},headers).then(response=>{
        const version=response.result?.protocolVersion;
        if(typeof version!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(version))throw new Error('Local WhatsApp bridge did not negotiate an MCP protocol version');
        return version;
      }).catch(error=>{this.localProtocolPromise=null;throw error;});
    }
    return this.localProtocolPromise;
  }
  async localRequest(body,_clientProtocol){
    const token=readFileSync(resolve(this.settings.dataDir||resolve(root,'data'),'owner-token'),'utf8').trim();
    const headers={'Content-Type':'application/json',Accept:'application/json, text/event-stream',Authorization:'Bearer '+token};
    // The hosted endpoint and local SDK terminate separate MCP connections.
    // Never forward a newer caller's protocol header to an older local SDK.
    const protocol=await this.localProtocol(headers);
    return compactMediaResponse(await this.postLocal(body,{...headers,'MCP-Protocol-Version':protocol}));
  }
  async bridgeStatus(){
    try{
      const token=readFileSync(resolve(this.settings.dataDir||resolve(root,'data'),'owner-token'),'utf8').trim();
      const response=await this.fetch(this.local+'/api/state',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.any([this.abort.signal,AbortSignal.timeout(5000)])});
      if(!response.ok)throw new Error('Unavailable');const state=await response.json();return {state:state.state,tools:state.tools?.length||0};
    }catch{return {state:'disconnected',tools:0};}
  }
  async execute(job){
    let request,response;
    try{
      request=await open(job.payload,this.settings.agentKey,job.id+':request');
      response=await this.localRequest(request.body,request.protocol);
    }
    catch(error){response={jsonrpc:'2.0',id:request?.body?.id??null,result:{isError:true,content:[{type:'text',text:error.message+'. A write may have executed; inspect WhatsApp history before retrying.'}]}};}
    if(new TextEncoder().encode(JSON.stringify(response)).length>REMOTE_MAX_BYTES)response={jsonrpc:'2.0',id:request?.body?.id??null,result:{isError:true,content:[{type:'text',text:'Result exceeds the remote response budget. Request fewer frames, a smaller text page, or use cached file chunks. The attachment limit remains 500 MB.'}]}};
    const payload=parts(await seal(response,this.settings.agentKey,job.id+':response'));
    for(let index=0;index<payload.length;index++){
      let sent=false;
      for(let attempt=0;attempt<3;attempt++){
        try{await this.remoteRequest('complete',{agent:this.settings.agentId,device:this.device,job:job.id,index,total:payload.length,data:payload[index]});sent=true;break;}
        catch(error){if(this.abort.signal.aborted||error.status===409)throw error;if(attempt===2)throw error;await pause(1000*2**attempt);}
      }
      if(!sent)throw new Error('Could not return the result');
    }
  }
  async poll(bridge){
    const response=await this.remoteRequest('poll',{agent:this.settings.agentId,device:this.device,wait:LONG_POLL_MS,bridge:bridge||await this.bridgeStatus(),capacity:Math.max(0,4-this.running.size)});
    // An older relay ignores `wait` and answers at once; then keep the normal pause.
    this.longPoll=response.wait>0;
    for(const job of response.jobs||[]){if(this.running.has(job.id))continue;this.running.add(job.id);this.execute(job).catch(error=>{if(!this.abort.signal.aborted)this.log(error.message);}).finally(()=>this.running.delete(job.id));}
    return response.jobs?.length||0;
  }
  async run(){
    return this.role==='standby'?this.runStandby():this.runPrimary();
  }
  async runPrimary(){
    let serving=false,errors=0,waitingLogged=false;
    while(!this.abort.signal.aborted){
      if(!await this.primaryReady()){
        if(serving||!waitingLogged)this.log('WhatsApp is not connected on this device yet; requests wait (or a standby device serves, if you added one).');
        serving=false;waitingLogged=true;await this.sleep(500);continue;
      }
      if(!serving){serving=true;waitingLogged=false;this.log('This device is now serving AI requests.');}
      try{await this.poll();if(errors)this.log('Remote relay reconnected.');errors=0;await this.sleep(this.longPoll?0:FAILOVER_POLL_MS);}
      catch(error){if(this.abort.signal.aborted)break;errors++;if(errors===1)this.log(error.message);await this.sleep(Math.min(5000,500*2**Math.min(errors,3)));}
    }
  }
  async runStandby(){
    let serving=false,errors=0,recheckAt=0;this.seen=undefined;this.changedAt=this.now();
    this.log('Standing by; watching the primary device.');
    while(!this.abort.signal.aborted){
      if(!serving){
        if(await this.watchStep()){serving=true;errors=0;recheckAt=this.now()+FAILOVER_RECHECK_MS;this.log('Primary device is silent; this device is now serving AI requests.');continue;}
        await this.sleep(this.watchMs);continue;
      }
      if(this.now()>=recheckAt){
        if(await this.primaryActive()){serving=false;this.log('Primary device is back; standing by.');continue;}
        recheckAt=this.now()+FAILOVER_RECHECK_MS;
      }
      try{await this.poll();if(errors)this.log('Remote relay reconnected.');errors=0;await this.sleep(this.longPoll?0:FAILOVER_POLL_MS);}
      catch(error){if(this.abort.signal.aborted)break;errors++;if(errors===1)this.log(error.message);await this.sleep(Math.min(5000,500*2**Math.min(errors,3)));}
    }
  }
  stop(){this.abort.abort();}
}
// Environment variables override data/remote-link.json, so no deployment
// values need to live in the source tree.
export function settingsFromEnv(env,file){
  const map={remoteUrl:'RELAY_REMOTE_URL',siteAccessKey:'RELAY_SITE_KEY',agentKey:'RELAY_AGENT_KEY',agentId:'RELAY_AGENT_ID',deviceId:'RELAY_DEVICE_ID',failoverRole:'RELAY_FAILOVER_ROLE',localUrl:'RELAY_LOCAL_URL',watchMs:'RELAY_WATCH_MS'};
  const fromEnv=Object.fromEntries(Object.entries(map).filter(([,name])=>env[name]).map(([key,name])=>[key,env[name]]));
  if(!Object.keys(fromEnv).length)return file;
  const merged={...(file||{}),...fromEnv};if(!file&&merged.remoteUrl&&merged.agentKey&&merged.agentId)merged.published=true;
  return merged;
}
async function main(){
  if(existsSync(resolve(root,'.env')))process.loadEnvFile(resolve(root,'.env'));
  const path=resolve(root,'data','remote-link.json');let settings;
  try{settings=JSON.parse(readFileSync(path,'utf8'));}catch{settings=null;}
  settings=settingsFromEnv(process.env,settings);
  if(!settings)throw new Error('Remote access is not configured yet. Set the RELAY_* variables (see .env.example) or finish publishing the private Relay integration first.');
  if(process.env.DATA_DIR)settings={...settings,dataDir:resolve(process.env.DATA_DIR)};
  if(settings.published!==true)throw new Error('The private relay has not been activated after hosted verification yet.');
  const agent=new RemoteAgent(settings,{log:message=>console.error(new Date().toISOString()+' '+message)});const dataDir=settings.dataDir||resolve(root,'data');mkdirSync(dataDir,{recursive:true,mode:0o700});writeFileSync(resolve(dataDir,'remote-agent.pid'),String(process.pid)+'\n',{mode:0o600});
  process.on('SIGINT',()=>agent.stop());process.on('SIGTERM',()=>agent.stop());
  console.error('Relay remote agent started as '+agent.role+'. Your WhatsApp session stays on this device.');await agent.run();
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
