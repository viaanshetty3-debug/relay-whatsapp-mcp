import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
export class DemoWhatsApp extends EventEmitter {
  constructor(store,config) {
    super();this.store=store;this.config=config;this.state='connected';this.qr=null;
    const ids=['15550100001@s.whatsapp.net','120363000001@g.us','15550100002@s.whatsapp.net'];
    if(!store.list('chats').length){
      const now=Math.floor(Date.now()/1000);
      ids.forEach((id,i)=>{store.put('chats',{id,name:['Alex Morgan','Weekend crew','Jamie Chen'][i],unreadCount:[2,5,0][i],conversationTimestamp:now-i*500,preview:['Can you send the project notes?','Saturday at 10 works for everyone?','Thanks, see you then!'][i]});store.put('contacts',{id,name:['Alex Morgan','Weekend crew','Jamie Chen'][i]});});
      ['Hey! Have you had a chance to look at the proposal?','Yes, just wrapped up my review. The direction looks great.','Perfect. Can you send the project notes?'].forEach((text,i)=>this.insert(ids[0],text,i===1,now-300+i*100));
      ['Anyone up for a hike this weekend?','I’m in! Let’s try the coastal trail.','Saturday at 10 works for everyone?'].forEach((text,i)=>this.insert(ids[1],text,i===1,now-800+i*100));
      this.insert(ids[2],'Thanks, see you then!',false,now-1200);
    }
    this.sock={user:{id:'15550000000@s.whatsapp.net'},readMessages:async()=>{},sendPresenceUpdate:async()=>{},presenceSubscribe:async()=>{},chatModify:async()=>{},groupMetadata:async id=>({id,subject:'Weekend crew',desc:'Plans for the weekend',participants:[{id:ids[0],admin:'admin'},{id:ids[2]}]}),groupUpdateSubject:async()=>{},groupUpdateDescription:async()=>{}};
  }
  insert(chat,text,fromMe,timestamp=Math.floor(Date.now()/1000)) {
    const id=randomUUID(),key={remoteJid:chat,id,fromMe};const m={chat,id,key,text,fromMe,timestamp,kind:'conversation',sender:fromMe?'You':chat,pushName:fromMe?'You':'Alex',raw:JSON.stringify({key,message:{conversation:text},messageTimestamp:timestamp})};
    this.store.message(m);this.store.event('message',chat,{...m,raw:undefined});return m;
  }
  status(){return {state:this.state,account:this.sock?.user.id,demo:true,error:null};}
  connected(){if(this.state!=='connected')throw new Error('Demo is disconnected');return this.sock;}
  raw(c,id){const m=this.store.getMessage(c,id);return m&&JSON.parse(m.raw);}
  async send(chat,content) {
    this.connected();
    if(content.edit||content.delete||content.react)return {chat,id:randomUUID(),status:'demo_submitted'};
    const m=this.insert(chat,content.text || content.caption || content.poll?.name || '[attachment]',true);
    this.store.put('chats',{id:chat,preview:m.text,conversationTimestamp:m.timestamp});return {id:m.id,chat,key:m.key,status:'demo_submitted'};
  }
  async download(){throw new Error('The demo does not contain downloadable media');}
  async pair(){return {code:'DEMO-ONLY'};}
  async start(){this.state='connected';this.emit('status',this.status());return this.status();}
  async stop(){this.state='disconnected';this.emit('status',this.status());}
}
