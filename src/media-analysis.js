import { spawn } from 'node:child_process';
import { existsSync,mkdirSync,readFileSync,writeFileSync,openSync,readSync,closeSync,statSync } from 'node:fs';
import { resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');

export class MediaAnalysis {
  constructor(config){this.dir=resolve(config.dir,'media-analysis');mkdirSync(this.dir,{recursive:true,mode:0o700});this.jobs=new Map();this.queue=Promise.resolve();this.python=process.env.MEDIA_PYTHON||resolve(root,'.media-venv/bin/python');}
  async capabilities(){
    if(!existsSync(this.python))return {ready:false,setup:'Double-click Enable Media Analysis.command',maxAttachmentBytes:500*1024*1024};
    return this.run(['capabilities'],null,30000);
  }
  run(args,job,timeout=0){return new Promise((accept,reject)=>{
    const child=spawn(this.python,[resolve(root,'scripts/media-worker.py'),...args],{cwd:root,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
    if(job)job.child=child;let output='',error='';
    const timer=timeout?setTimeout(()=>child.kill('SIGTERM'),timeout):null;
    child.stdout.on('data',data=>{output+=data;if(output.length>10*1024*1024)child.kill('SIGTERM');});child.stderr.on('data',data=>{error=(error+data).slice(-4000);});
    child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('close',code=>{clearTimeout(timer);if(job)delete job.child;if(code!==0)return reject(new Error(error||'Local media processor stopped'));try{accept(JSON.parse(output));}catch{reject(new Error('Local processor returned invalid output'));}});
  });}
  save(job){const {child,promise,...data}=job;writeFileSync(resolve(this.dir,job.jobId+'.json'),JSON.stringify(data),{mode:0o600});}
  submit(input,prepare){
    const job={...input,jobId:randomUUID(),status:'queued',created:Date.now(),stage:'Waiting for local processor'};this.jobs.set(job.jobId,job);this.save(job);
    job.promise=this.queue.then(async()=>{
      if(job.status==='cancelled')return;
      try{
        job.status='running';job.stage='Downloading attachment';this.save(job);const file=await prepare();if(job.status==='cancelled')return;
        const work=resolve(this.dir,job.jobId);mkdirSync(work,{mode:0o700});
        if(input.mode==='cache'){
          const result={mode:'cache',fileId:file.fileId,filename:file.filename,mimeType:file.mimeType,sizeBytes:file.sizeBytes,text:'Attachment cached privately. Use read_media_chunk with this fileId to transfer the complete file.'};
          writeFileSync(resolve(work,'result.json'),JSON.stringify(result),{mode:0o600});job.status='complete';job.stage='Done';job.finished=Date.now();this.save(job);return;
        }
        const request={...input,input:file.path,mimeType:file.mimeType,filename:file.filename,output:work};
        const requestPath=resolve(work,'request.json');writeFileSync(requestPath,JSON.stringify(request),{mode:0o600});
        job.stage='Processing locally';this.save(job);
        const result=await this.run(['process',requestPath],job);
        if(job.status!=='cancelled'){if(!result.stored)writeFileSync(resolve(work,'result.json'),JSON.stringify(result),{mode:0o600});job.status='complete';job.stage='Done';job.finished=Date.now();this.save(job);}
      }catch(error){if(job.status!=='cancelled'){job.status='failed';job.error=error.message;this.save(job);}}
    });this.queue=job.promise.catch(()=>{});
    return {jobId:job.jobId,status:job.status,nextTool:'get_media_analysis'};
  }
  get(id){
    if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('Invalid analysis job ID');
    if(this.jobs.has(id))return this.jobs.get(id);
    const path=resolve(this.dir,id+'.json');if(!existsSync(path))throw new Error('Analysis job not found');
    const job=JSON.parse(readFileSync(path,'utf8'));
    if(['queued','running'].includes(job.status)){job.status='failed';job.error='Bridge restarted during processing. Start the analysis again.';this.save(job);}this.jobs.set(id,job);return job;
  }
  async result(id,{offset=0,limit=20000,waitSeconds=0}={}){
    const job=this.get(id);
    if(job.promise&&['queued','running'].includes(job.status)&&waitSeconds){let timer;try{await Promise.race([job.promise,new Promise(r=>{timer=setTimeout(r,waitSeconds*1000);})]);}finally{clearTimeout(timer);}}
    const base={jobId:id,status:job.status,stage:job.stage,error:job.error};if(job.status!=='complete')return base;
    const result=JSON.parse(readFileSync(resolve(this.dir,id,'result.json'),'utf8'));
    const {text='',textFile,frames,...metadata}=result;
    if(textFile){
      const path=resolve(this.dir,id,'text.txt'),size=statSync(path).size,fd=openSync(path,'r');let chunk;
      try{const bytes=Buffer.alloc(Math.min(limit+3,Math.max(0,size-offset)));const count=readSync(fd,bytes,0,bytes.length,offset);chunk=bytes.subarray(0,count);}finally{closeSync(fd);}
      // Keep UTF-8 characters intact between byte-based result pages.
      let count=Math.min(limit,chunk.length);while(count<chunk.length&&(chunk[count]&0xc0)===0x80)count++;
      return {...base,...metadata,text:chunk.subarray(0,count).toString('utf8'),offset,nextOffset:offset+count,hasMore:offset+count<size,offsetUnit:'UTF-8 bytes'};
    }
    return {...base,...metadata,text:text.slice(offset,offset+limit),offset,nextOffset:offset+Math.min(limit,Math.max(0,text.length-offset)),hasMore:offset+limit<text.length,...(offset===0&&frames?{frames}:{})};
  }
  cancel(id){const job=this.get(id);if(['queued','running'].includes(job.status)){job.status='cancelled';if(job.child){try{if(process.platform==='win32')job.child.kill('SIGTERM');else process.kill(-job.child.pid,'SIGTERM');}catch{}}this.save(job);}return {jobId:id,status:job.status};}
  stop(){for(const job of this.jobs.values())if(['queued','running'].includes(job.status))this.cancel(job.jobId);}
}
