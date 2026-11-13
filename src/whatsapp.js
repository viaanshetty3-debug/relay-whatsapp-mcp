import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { mkdirSync, existsSync, rmSync, writeFileSync, readFileSync, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import QRCode from 'qrcode';
import pino from 'pino';
import { hasLinkedCredentials } from './session-state.js';
import { mediaInfo, MEDIA_KINDS, MEDIA_LIMIT } from './media.js';

// ----- call logs -----
// WhatsApp reports calls three ways: live call events on this linked device, "missed call" notices,
// and call-log entries inside chats. Relay keeps one entry per call in the chat, like WhatsApp does.
const MISSED_STUBS={40:{video:false},41:{video:true},45:{video:false,group:true},46:{video:true,group:true}};
const OUTCOMES=['answered','missed','failed','declined','answered on another device','ongoing','silenced (Do Not Disturb)','silenced (unknown caller)'];
export function callText({video,direction,outcome,durationSecs,group}) {
  const what=`${group?'group ':''}${video?'video':'voice'} call`;
  const length=durationSecs>0?(durationSecs>=60?`${Math.floor(durationSecs/60)} min ${durationSecs%60} s`:`${durationSecs} s`):'';
  if(outcome==='missed')return `${video?'📹':'📞'} Missed ${what}`;
  if(outcome==='ringing')return `${video?'📹':'📞'} Incoming ${what}…`;
  const head=`${video?'📹':'📞'} ${direction==='outgoing'?'Outgoing ':direction==='incoming'?'Incoming ':''}${what}`;
  return [head,outcome&&outcome!=='answered'&&outcome!=='ended'?outcome:'',length].filter(Boolean).join(' · ');
}
export class WhatsApp extends EventEmitter {
  constructor(store,config,library) {
    super(); this.store=store;this.config=config;this.state='disconnected';this.qr=null;this.stopped=true;this.attempt=0;this.lib=library;this.credentialWrites=Promise.resolve();
  }
  permitted(chat) { return !this.config.allowed.size || this.config.allowed.has(chat); }
  // ----- hidden IDs ("…@lid") → phone numbers -----
  // WhatsApp increasingly addresses people by a hidden ID instead of their number. Relay files every
  // one-to-one chat under the phone number, so a person has one chat, with their contact name.
  lidMap() { if(!this._lids)this._lids=new Map(Object.entries(this.store.kv('lid:map') || {}));return this._lids; }
  learnLid(lid,pn) {
    const bare=j=>String(j||'').replace(/:\d+@/,'@');lid=bare(lid);pn=bare(pn);
    if(!lid.endsWith('@lid') || !pn.endsWith('@s.whatsapp.net') || this.lidMap().get(lid)===pn)return false;
    this.lidMap().set(lid,pn);this.store.kv('lid:map',Object.fromEntries(this.lidMap()));
    if(this.store.getChat(lid) || this.store.messages({chat:lid,limit:1}).length)this.store.mergeChat(lid,pn);
    return true;
  }
  canonical(jid) { const bare=String(jid||'').replace(/:\d+@/,'@');return bare.endsWith('@lid')?(this.lidMap().get(bare) || jid):jid; }
  // Merge chats still filed under a hidden ID, asking WhatsApp's own ID map for the ones Relay hasn't seen yet.
  async resolveLids() {
    for(const c of this.store.list('contacts'))if(c.lid&&c.id?.endsWith('@s.whatsapp.net'))this.learnLid(c.lid,c.id);
    const repo=this.sock?.signalRepository?.lidMapping;
    for(const c of this.store.list('chats')){
      if(!c.id?.endsWith('@lid'))continue;
      const known=this.lidMap().get(c.id);
      if(known){this.store.mergeChat(c.id,known);continue;}
      try{const pn=await repo?.getPNForLID?.(c.id);if(pn)this.learnLid(c.id,pn);}catch{}
    }
  }
  // Older messages: asks the phone for up to 50 messages before the oldest one Relay has for this chat.
  // They arrive a few seconds later through the normal history sync.
  async loadOlder(chat) {
    const sock=this.connected();chat=this.canonical(chat);
    const oldest=this.store.db.prepare('SELECT data FROM messages WHERE chat=? ORDER BY timestamp ASC,id ASC LIMIT 1').get(chat);
    if(!oldest)throw new Error('There are no messages in this chat yet to load older ones from.');
    const m=JSON.parse(oldest.data);
    if(typeof sock.fetchMessageHistory!=='function')throw new Error('This WhatsApp library version can\'t load older messages.');
    await sock.fetchMessageHistory(50,m.key,m.timestamp);
    return {requested:true,before:m.timestamp};
  }
  status() { return {state:this.state,account:this.sock?.user?.id || null,error:this.error || null,demo:this.config.demo}; }
  hasSavedSession() {
    if(existsSync(resolve(this.config.dir,'auth-invalid')))return false;
    try{return hasLinkedCredentials(JSON.parse(readFileSync(resolve(this.config.dir,'auth','creds.json'),'utf8')));}catch{return false;}
  }
  async start() {
    if(!this.stopped && ['connecting','connected','pairing'].includes(this.state)) return this.status();
    const invalidSession=this.state==='logged_out' || existsSync(resolve(this.config.dir,'auth-invalid'));
    clearTimeout(this.retry);this.stopped=false;this.state='connecting';this.error=null;
    this.emit('status',this.status());
    try {
      if(invalidSession) {
        await this.credentialWrites;
        rmSync(resolve(this.config.dir,'auth'),{recursive:true,force:true});
        rmSync(resolve(this.config.dir,'auth-invalid'),{force:true});
        this.attempt=0;
      }
      this.lib ||= await import('@whiskeysockets/baileys');
      const {default:makeWASocket,useMultiFileAuthState,makeCacheableSignalKeyStore,Browsers,DisconnectReason,BufferJSON}=this.lib;
      this.BufferJSON=BufferJSON;
      const authDir=resolve(this.config.dir,'auth');mkdirSync(authDir,{recursive:true,mode:0o700});
      const {state,saveCreds}=await useMultiFileAuthState(authDir);
      const logger=pino({level:'silent'});
      const sock=makeWASocket({auth:{creds:state.creds,keys:makeCacheableSignalKeyStore(state.keys,logger)},logger,browser:Browsers.ubuntu('Chrome'),markOnlineOnConnect:false,syncFullHistory:true,
        getMessage:async key=>this.raw(this.canonical(key.remoteJid),key.id)?.message});
      this.sock=sock;
      const on=(name,fn)=>sock.ev.on(name,(...args)=>{if(this.sock!==sock || this.stopped)return;Promise.resolve().then(()=>{if(this.sock!==sock || this.stopped)return;return fn(...args);}).catch(e=>{this.error=e.message;this.emit('status',this.status());});});
      on('creds.update',()=>{this.credentialWrites=this.credentialWrites.then(saveCreds);return this.credentialWrites;});
      on('connection.update',async ({connection,qr,lastDisconnect})=>{
        if(qr) { const image=await QRCode.toDataURL(qr);if(this.sock!==sock || this.stopped)return;this.state='pairing';this.qr=image;this.error=null;this.emit('status',this.status()); }
        if(connection==='open') {this.state='connected';this.qr=null;this.error=null;this.attempt=0;this.emit('status',this.status());this.resolveLids().catch(()=>{});}
        if(connection==='close') {
          await this.credentialWrites;
          if(this.sock!==sock || this.stopped)return;
          this.qr=null;this.sock=null;
          const code=lastDisconnect?.error?.output?.statusCode;
          this.state=code===DisconnectReason.loggedOut?'logged_out':'disconnected';
          if(code===DisconnectReason.loggedOut) {
            writeFileSync(resolve(this.config.dir,'auth-invalid'),'logged_out\n',{mode:0o600});
            this.stopped=true;
          }
          this.error=code===DisconnectReason.loggedOut?'WhatsApp rejected this session. Select Retry pairing to create a fresh QR or phone pairing code.':`Connection closed${code?' ('+code+')':''}`;
          this.emit('status',this.status());
          if(!this.stopped && code!==DisconnectReason.loggedOut) this.retry=setTimeout(()=>this.start().catch(()=>{}),Math.min(30000,1000*2**this.attempt++));
        }
      });
      on('messaging-history.set',({chats=[],contacts=[],messages=[]})=>{
        for(const c of contacts)this.noteContact(c);
        for(const m of messages)this.noteKey(m.key);
        this.store.transaction(()=>{for(const c of chats){const id=this.canonical(c.id);if(this.permitted(id))this.store.put('chats',{...c,id});}for(const c of contacts)if(this.permitted(c.id))this.store.put('contacts',c);for(const m of messages)this.ingest(m,false);});
        this.store.event('history',null,{messages:messages.length});
      });
      on('call',calls=>{for(const c of calls || [])this.onCall(c);});
      on('lid-mapping.update',value=>{for(const v of Array.isArray(value)?value:[value])this.learnLid(v?.lid,v?.pn);});
      on('messages.upsert',({messages,type})=>{for(const m of messages)this.ingest(m,type==='notify');});
      for(const type of ['chats.upsert','chats.update','contacts.upsert','contacts.update'])on(type,items=>{
        for(const raw of items){
          if(type.startsWith('contacts')){this.noteContact(raw);if(this.permitted(raw.id))this.store.put('contacts',raw);continue;}
          const item={...raw,id:this.canonical(raw.id)};if(this.permitted(item.id))this.store.put('chats',item);
        }
        this.store.event(type,null,{count:items.length});
      });
      on('messages.update',updates=>{for(const {key:k,update} of updates){
        const key={...k,remoteJid:this.canonical(k.remoteJid)};
        if(!this.permitted(key.remoteJid))continue;
        const old=this.store.getMessage(key.remoteJid,key.id);
        if(old) {
          if(update.message) {
            this.ingest({...this.raw(key.remoteJid,key.id),...update,key,messageTimestamp:old.timestamp},false);
            if(update.message.editedMessage)this.store.message({...this.store.getMessage(key.remoteJid,key.id),edited:true});
          }
          const current=this.store.getMessage(key.remoteJid,key.id);
          this.store.message({...current,status:update.status??current.status,deleted:update.messageStubType===1 || current.deleted});
        }
        this.store.event('message.update',key.remoteJid,{id:key.id,status:update.status,deleted:update.messageStubType===1});
      }});
      on('messages.delete',value=>{
        if(value.keys)for(const k of value.keys){const key={...k,remoteJid:this.canonical(k.remoteJid)};const old=this.store.getMessage(key.remoteJid,key.id);if(old)this.store.message({...old,deleted:true});if(this.permitted(key.remoteJid))this.store.event('message.delete',key.remoteJid,{id:key.id});}
      });
      for(const type of ['messages.reaction','message-receipt.update','presence.update','groups.update','group-participants.update'])on(type,value=>{
        const items=Array.isArray(value)?value:[value];
        for(const item of items){const chat=this.canonical(item.key?.remoteJid || item.id);if(chat && this.permitted(chat))this.store.event(type,chat,item);}
      });
      on('chats.delete',ids=>{for(const id of ids)if(this.permitted(id)){this.store.db.prepare('DELETE FROM chats WHERE id=?').run(id);this.store.event('chat.delete',id,{id});}});
      return this.status();
    } catch(e) {this.state='disconnected';this.stopped=true;this.error=e.message;throw e;}
  }
  raw(chat,id) { const m=this.store.getMessage(chat,id);return m?.raw?JSON.parse(m.raw,this.BufferJSON?.reviver):undefined; }
  // Contacts and message keys often carry both IDs for a person: remember the pair.
  noteContact(c) { if(c?.lid&&c.id?.endsWith('@s.whatsapp.net'))this.learnLid(c.lid,c.id);if(c?.id?.endsWith('@lid')&&c.phoneNumber)this.learnLid(c.id,c.phoneNumber); }
  noteKey(k) { if(!k)return;this.learnLid(k.remoteJid,k.remoteJidAlt);this.learnLid(k.participant,k.participantAlt); }
  ingest(m,live=true) {
    this.noteKey(m.key);
    const chat=this.canonical(m.key?.remoteJid),id=m.key?.id;if(!chat || !id || !this.permitted(chat) || chat==='status@broadcast')return;
    let body=this.lib.normalizeMessageContent(m.message) || {};
    if(body.protocolMessage?.editedMessage) {
      const key=body.protocolMessage.key;
      const old=this.raw(chat,key?.id);
      if(old)this.ingest({...old,message:body.protocolMessage.editedMessage},false);
      this.store.event('message.edit',chat,{id:key?.id});return;
    }
    if(body.protocolMessage) {
      const p=body.protocolMessage;
      if(p.type===0 && p.key?.id){const old=this.store.getMessage(chat,p.key.id);if(old)this.store.message({...old,deleted:true});this.store.event('message.delete',chat,{id:p.key.id});}
      return;
    }
    const missed=MISSED_STUBS[m.messageStubType];
    if(missed)return this.storeCall(chat,id,Number(m.messageTimestamp)||Math.floor(Date.now()/1000),{...missed,direction:'incoming',outcome:'missed'},live,m.key);
    if(body.callLogMesssage){
      const c=body.callLogMesssage,duration=Number(c.durationSecs?.low ?? c.durationSecs) || 0;
      return this.storeCall(chat,id,Number(m.messageTimestamp)||Math.floor(Date.now()/1000),{video:!!c.isVideo,direction:m.key.fromMe?'outgoing':'incoming',outcome:OUTCOMES[c.callOutcome] || 'ended',durationSecs:duration,group:(c.participants||[]).length>1},live,m.key);
    }
    const kind=Object.keys(body).find(k=>!['messageContextInfo','senderKeyDistributionMessage'].includes(k));
    if(!kind)return;
    const content=body[kind];
    const text=body.conversation || content?.text || content?.caption || content?.name || content?.displayName || '';
    const timestamp=Number(m.messageTimestamp || Math.floor(Date.now()/1000));
    const media=mediaInfo({message:body});
    const value={chat,id,key:m.key,fromMe:!!m.key.fromMe,sender:(m.key.participant&&this.canonical(m.key.participant)) || (m.key.fromMe?this.sock?.user?.id:chat),pushName:m.pushName,text,kind,timestamp,status:m.status,hasMedia:!!media,media,raw:JSON.stringify(m,this.BufferJSON.replacer)};
    const fresh=this.store.message(value);
    const oldChat=this.store.getChat(chat);
    this.store.put('chats',{id:chat,...(!oldChat?.conversationTimestamp || timestamp>=Number(oldChat.conversationTimestamp)?{conversationTimestamp:timestamp,preview:text}:{}),...(!m.key.fromMe&&m.pushName&&!chat.endsWith('@g.us')&&!oldChat?.name?{name:m.pushName}:{})});
    if(live&&fresh)this.store.event('message',chat,{...value,raw:undefined});
  }
  // One entry per call, keyed by the call ID, so later updates (answered, ended) refine the same entry.
  storeCall(chat,id,timestamp,info,live,key) {
    if(!chat || !id || !this.permitted(chat))return;
    const old=this.store.getMessage(chat,id),merged={...(old?.call||{}),...info};
    if(old?.call?.outcome&&old.call.outcome!=='ringing'&&info.outcome==='ringing')return; // don't go backwards
    const text=callText(merged);
    const value={chat,id,key:key || {remoteJid:chat,id,fromMe:merged.direction==='outgoing'},fromMe:merged.direction==='outgoing',sender:merged.direction==='outgoing'?this.sock?.user?.id:chat,text,kind:'call',timestamp:old?.timestamp || timestamp,call:merged,hasMedia:false};
    const fresh=this.store.message(value);
    const chatRow=this.store.getChat(chat);
    if(!chatRow?.conversationTimestamp || value.timestamp>=Number(chatRow.conversationTimestamp))this.store.put('chats',{id:chat,conversationTimestamp:value.timestamp,preview:text});
    if(live)this.store.event(fresh?'call':'call.update',chat,{...value});
  }
  // Live call events reach Relay because it's a linked device: incoming calls ring here too.
  onCall(c) {
    this.learnLid(c.from,c.callerPn);
    const chat=this.canonical(c.isGroup&&c.groupJid?c.groupJid:(c.callerPn || c.chatId || c.from)),at=Math.floor(new Date(c.date).getTime()/1000) || Math.floor(Date.now()/1000);
    const live=this._calls || (this._calls=new Map()),state=live.get(c.id) || {};
    const base={video:!!c.isVideo,group:!!c.isGroup,direction:'incoming'};
    if(c.status==='offer' || c.status==='ringing'){live.set(c.id,{...state,start:at});return this.storeCall(chat,c.id,at,{...base,outcome:'ringing'},true);}
    if(c.status==='accept'){live.set(c.id,{...state,accepted:at});return this.storeCall(chat,c.id,at,{...base,outcome:'answered'},true);}
    if(c.status==='reject'){live.delete(c.id);return this.storeCall(chat,c.id,at,{...base,outcome:'declined'},true);}
    if(c.status==='timeout'){live.delete(c.id);return this.storeCall(chat,c.id,at,{...base,outcome:'missed'},true);}
    if(c.status==='terminate'){
      live.delete(c.id);
      const durationSecs=state.accepted?Math.max(0,at-state.accepted):0;
      const outcome=state.accepted?'answered':(this.store.getMessage(chat,c.id)?.call?.outcome==='ringing'?'missed':undefined);
      return this.storeCall(chat,c.id,at,{...base,...(outcome?{outcome}:{}),...(durationSecs?{durationSecs}:{})},true);
    }
  }
  connected() { if(this.state!=='connected' || !this.sock)throw new Error('WhatsApp is not connected. Pair it in the dashboard first.');return this.sock; }
  async pair(phone) {
    if(!/^\d{7,15}$/.test(phone))throw new Error('Use 7–15 digits including country code, without +');
    if(!this.sock || this.state!=='pairing')throw new Error('Connect first, then wait until the QR code appears before requesting a phone code');
    return {code:await this.sock.requestPairingCode(phone)};
  }
  async send(chat,content,options={}) {
    const m=await this.connected().sendMessage(chat,content,options);
    if(!m)throw new Error('WhatsApp returned no message acknowledgment');
    this.ingest(m,true);return {id:m.key.id,chat,key:m.key,status:'submitted'};
  }
  async download(chat,id) {
    const raw=this.raw(chat,id);if(!raw)throw new Error('Message not found');
    const body=this.lib.normalizeMessageContent(raw.message);
    const media=Object.entries(body || {}).find(([kind,value])=>MEDIA_KINDS[kind] && value?.mediaKey)?.[1];
    if(!media)throw new Error('No downloadable media');
    if((mediaInfo({message:body})?.sizeBytes || 0)>MEDIA_LIMIT)throw new Error('Media exceeds the 500 MB attachment limit');
    const stream=await this.lib.downloadMediaMessage(raw,'stream',{}, {logger:pino({level:'silent'}),reuploadRequest:this.connected().updateMediaMessage});
    const chunks=[];let size=0;for await(const c of stream){size+=c.length;if(size>MEDIA_LIMIT){stream.destroy?.();throw new Error('Media exceeds the 500 MB attachment limit');}chunks.push(c);}
    return {mimeType:media.mimetype || 'application/octet-stream',filename:media.fileName || id,base64:Buffer.concat(chunks).toString('base64')};
  }
  async downloadToFile(chat,id,destination) {
    const raw=this.raw(chat,id);if(!raw)throw new Error('Message not found');
    const body=this.lib.normalizeMessageContent(raw.message),media=Object.entries(body||{}).find(([kind,value])=>MEDIA_KINDS[kind]&&value?.mediaKey)?.[1];
    if(!media)throw new Error('No downloadable media');
    if((mediaInfo({message:body})?.sizeBytes||0)>MEDIA_LIMIT)throw new Error('Media exceeds the 500 MB attachment limit');
    const stream=await this.lib.downloadMediaMessage(raw,'stream',{}, {logger:pino({level:'silent'}),reuploadRequest:this.connected().updateMediaMessage});
    let size=0;const guard=new Transform({transform(chunk,_encoding,callback){size+=chunk.length;callback(size>MEDIA_LIMIT?new Error('Media exceeds the 500 MB attachment limit'):null,chunk);}});
    try{await pipeline(stream,guard,createWriteStream(destination,{flags:'w',mode:0o600}));}
    catch(error){rmSync(destination,{force:true});throw error;}
    return {mimeType:media.mimetype||'application/octet-stream',filename:media.fileName||id,sizeBytes:size};
  }
  // Unlinks this device from the WhatsApp account (used when a profile is removed).
  async logout() {const sock=this.sock;if(sock&&this.state==='connected'){try{await sock.logout();}catch{}}await this.stop();}
  async stop() {this.stopped=true;clearTimeout(this.retry);const sock=this.sock;this.sock=null;sock?.end(new Error('Bridge stopped'));await this.credentialWrites;this.state='disconnected';this.qr=null;this.emit('status',this.status());}
}
