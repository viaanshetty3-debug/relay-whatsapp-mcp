import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { mkdirSync, existsSync, rmSync, writeFileSync, readFileSync, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import QRCode from 'qrcode';
import pino from 'pino';
import { hasLinkedCredentials } from './session-state.js';
import { mediaInfo, MEDIA_KINDS, MEDIA_LIMIT } from './media.js';

export class WhatsApp extends EventEmitter {
  constructor(store,config,library) {
    super(); this.store=store;this.config=config;this.state='disconnected';this.qr=null;this.stopped=true;this.attempt=0;this.lib=library;this.credentialWrites=Promise.resolve();
  }
  permitted(chat) { return !this.config.allowed.size || this.config.allowed.has(chat); }
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
        getMessage:async key=>this.raw(key.remoteJid,key.id)?.message});
      this.sock=sock;
      const on=(name,fn)=>sock.ev.on(name,(...args)=>{if(this.sock!==sock || this.stopped)return;Promise.resolve().then(()=>{if(this.sock!==sock || this.stopped)return;return fn(...args);}).catch(e=>{this.error=e.message;this.emit('status',this.status());});});
      on('creds.update',()=>{this.credentialWrites=this.credentialWrites.then(saveCreds);return this.credentialWrites;});
      on('connection.update',async ({connection,qr,lastDisconnect})=>{
        if(qr) { const image=await QRCode.toDataURL(qr);if(this.sock!==sock || this.stopped)return;this.state='pairing';this.qr=image;this.error=null;this.emit('status',this.status()); }
        if(connection==='open') {this.state='connected';this.qr=null;this.error=null;this.attempt=0;this.emit('status',this.status());}
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
        this.store.transaction(()=>{for(const c of chats)if(this.permitted(c.id))this.store.put('chats',c);for(const c of contacts)if(this.permitted(c.id))this.store.put('contacts',c);for(const m of messages)this.ingest(m,false);});
        this.store.event('history',null,{messages:messages.length});
      });
      on('messages.upsert',({messages,type})=>{for(const m of messages)this.ingest(m,type==='notify');});
      for(const type of ['chats.upsert','chats.update','contacts.upsert','contacts.update'])on(type,items=>{
        for(const item of items)if(this.permitted(item.id))this.store.put(type.startsWith('chats')?'chats':'contacts',item);
        this.store.event(type,null,{count:items.length});
      });
      on('messages.update',updates=>{for(const {key,update} of updates){
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
        if(value.keys)for(const key of value.keys){const old=this.store.getMessage(key.remoteJid,key.id);if(old)this.store.message({...old,deleted:true});if(this.permitted(key.remoteJid))this.store.event('message.delete',key.remoteJid,{id:key.id});}
      });
      for(const type of ['messages.reaction','message-receipt.update','presence.update','groups.update','group-participants.update'])on(type,value=>{
        const items=Array.isArray(value)?value:[value];
        for(const item of items){const chat=item.key?.remoteJid || item.id;if(chat && this.permitted(chat))this.store.event(type,chat,item);}
      });
      on('chats.delete',ids=>{for(const id of ids)if(this.permitted(id)){this.store.db.prepare('DELETE FROM chats WHERE id=?').run(id);this.store.event('chat.delete',id,{id});}});
      return this.status();
    } catch(e) {this.state='disconnected';this.stopped=true;this.error=e.message;throw e;}
  }
  raw(chat,id) { const m=this.store.getMessage(chat,id);return m?.raw?JSON.parse(m.raw,this.BufferJSON?.reviver):undefined; }
  ingest(m,live=true) {
    const chat=m.key?.remoteJid,id=m.key?.id;if(!chat || !id || !this.permitted(chat) || chat==='status@broadcast')return;
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
    const kind=Object.keys(body).find(k=>!['messageContextInfo','senderKeyDistributionMessage'].includes(k));
    if(!kind)return;
    const content=body[kind];
    const text=body.conversation || content?.text || content?.caption || content?.name || content?.displayName || '';
    const timestamp=Number(m.messageTimestamp || Math.floor(Date.now()/1000));
    const media=mediaInfo({message:body});
    const value={chat,id,key:m.key,fromMe:!!m.key.fromMe,sender:m.key.participant || (m.key.fromMe?this.sock?.user?.id:chat),pushName:m.pushName,text,kind,timestamp,status:m.status,hasMedia:!!media,media,raw:JSON.stringify(m,this.BufferJSON.replacer)};
    const fresh=this.store.message(value);
    const oldChat=this.store.getChat(chat);
    this.store.put('chats',{id:chat,...(!oldChat?.conversationTimestamp || timestamp>=Number(oldChat.conversationTimestamp)?{conversationTimestamp:timestamp,preview:text}:{}),...(!m.key.fromMe&&m.pushName&&!chat.endsWith('@g.us')&&!oldChat?.name?{name:m.pushName}:{})});
    if(live&&fresh)this.store.event('message',chat,{...value,raw:undefined});
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
  async stop() {this.stopped=true;clearTimeout(this.retry);const sock=this.sock;this.sock=null;sock?.end(new Error('Bridge stopped'));await this.credentialWrites;this.state='disconnected';this.qr=null;this.emit('status',this.status());}
}
