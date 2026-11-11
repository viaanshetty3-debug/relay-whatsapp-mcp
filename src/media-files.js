import { mkdirSync,writeFileSync,readFileSync,existsSync,statSync,readdirSync,rmSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MEDIA_LIMIT,INLINE_MEDIA_LIMIT } from './media.js';

export class MediaFiles {
  constructor(config){this.dir=resolve(config.dir,'media-cache');mkdirSync(this.dir,{recursive:true,mode:0o700});this.preparing=new Map();this.writes=new Map();}
  path(id){if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('Invalid media file ID');return resolve(this.dir,id+'.bin');}
  save(entry){writeFileSync(this.path(entry.fileId)+'.json',JSON.stringify(entry),{mode:0o600});return entry;}
  get(id){const path=this.path(id);if(!existsSync(path+'.json')||!existsSync(path))throw new Error('Media file not found; download it again');const entry=JSON.parse(readFileSync(path+'.json','utf8'));if(Date.now()>entry.expires){this.remove(id);throw new Error('Media cache expired; download it again');}if(entry.complete&&statSync(path).size!==entry.sizeBytes)throw new Error('Cached media file is incomplete; download it again');return {...entry,path};}
  remove(id){const path=this.path(id);rmSync(path,{force:true});rmSync(path+'.json',{force:true});}
  cleanup(){for(const name of readdirSync(this.dir))if(name.endsWith('.bin.json')){try{const entry=JSON.parse(readFileSync(resolve(this.dir,name),'utf8'));if(entry.expires<Date.now())this.remove(entry.fileId);}catch{}}}
  create(properties){this.cleanup();const entry={...properties,fileId:randomUUID(),created:Date.now(),expires:Date.now()+24*60*60*1000};writeFileSync(this.path(entry.fileId),'',{flag:'wx',mode:0o600});this.save(entry);return this.get(entry.fileId);}
  async prepare(wa,chat,id){
    const key=chat+'\0'+id;if(this.preparing.has(key))return this.preparing.get(key);
    const promise=(async()=>{
      for(const name of readdirSync(this.dir))if(name.endsWith('.bin.json')){try{const entry=this.get(name.slice(0,-9));if(entry.chat===chat&&entry.messageId===id&&entry.complete)return entry;}catch{}}
      const entry=this.create({chat,messageId:id,complete:false,type:'download'});
      try{
        const info=await wa.downloadToFile(chat,id,entry.path);
        return this.get(this.save({...entry,...info,complete:true}).fileId);
      }catch(error){this.remove(entry.fileId);throw error;}
    })();this.preparing.set(key,promise);try{return await promise;}finally{this.preparing.delete(key);}
  }
  public(entry){return {fileId:entry.fileId,filename:entry.filename,mimeType:entry.mimeType,sizeBytes:entry.sizeBytes,expiresAt:new Date(entry.expires).toISOString(),delivery:'file',chunkTool:'read_media_chunk',analysisTool:'analyze_media'};}
  response(entry){return entry.sizeBytes<=INLINE_MEDIA_LIMIT?{...this.public(entry),delivery:'inline',base64:readFileSync(entry.path).toString('base64')}:this.public(entry);}
  createUpload({chat,sizeBytes,mimeType,filename}){
    if(!Number.isSafeInteger(sizeBytes)||sizeBytes<1||sizeBytes>MEDIA_LIMIT)throw new Error('Attachment must be between 1 byte and 500 MB');
    return this.public(this.create({type:'upload',chat,sizeBytes,mimeType,filename,received:0,complete:false}));
  }
  async append(id,offset,data){
    const previous=this.writes.get(id)||Promise.resolve();
    const next=previous.catch(()=>{}).then(()=>this.appendUnlocked(id,offset,data));this.writes.set(id,next);
    try{return await next;}finally{if(this.writes.get(id)===next)this.writes.delete(id);}
  }
  async appendUnlocked(id,offset,data){
    const entry=this.get(id);if(entry.type!=='upload')throw new Error('This is not an upload');
    if(offset+data.length>entry.sizeBytes)throw new Error('Chunk exceeds the declared attachment size');
    const file=await open(entry.path,'r+');try{
      const received=statSync(entry.path).size;
      if(offset>received)throw new Error('Upload offset does not match received bytes');
      const overlap=Math.min(data.length,received-offset);
      if(overlap){const previous=Buffer.alloc(overlap);await file.read(previous,0,overlap,offset);if(!previous.equals(data.subarray(0,overlap)))throw new Error('Conflicting upload retry');}
      let written=overlap;while(written<data.length){const result=await file.write(data,written,data.length-written,offset+written);if(!result.bytesWritten)throw new Error('Unable to write upload chunk');written+=result.bytesWritten;}
      const total=statSync(entry.path).size;this.save({...entry,received:total,complete:total===entry.sizeBytes});
      return {fileId:id,received:total,complete:total===entry.sizeBytes};
    }finally{await file.close();}
  }
  async chunk(id,offset,length){const entry=this.get(id);if(!entry.complete)throw new Error('Upload is incomplete');const file=await open(entry.path,'r');try{const buffer=Buffer.alloc(Math.min(length,Math.max(0,entry.sizeBytes-offset)));const {bytesRead}=await file.read(buffer,0,buffer.length,offset);return {...this.public(entry),offset,base64:buffer.subarray(0,bytesRead).toString('base64'),nextOffset:offset+bytesRead,eof:offset+bytesRead>=entry.sizeBytes};}finally{await file.close();}}
}
