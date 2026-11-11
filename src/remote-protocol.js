// Shared by the Mac agent and the private hosted relay. Queue data is encrypted at rest.
export const REMOTE_PART_SIZE=256*1024;
export const REMOTE_MAX_BYTES=7*1024*1024;
export function b64(bytes){let value='';for(let i=0;i<bytes.length;i+=8192)value+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(value);}
export function unb64(value){return Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));}
export async function hash(value){return b64(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))));}
export async function sameSecret(a,b){if(!a||!b)return false;const left=await hash(a),right=await hash(b);let diff=0;for(let i=0;i<left.length;i++)diff|=left.charCodeAt(i)^right.charCodeAt(i);return diff===0;}
async function key(secret){const bytes=unb64(secret);if(bytes.length!==32)throw new Error('Remote relay key must contain 32 random bytes');return crypto.subtle.importKey('raw',bytes,'AES-GCM',false,['encrypt','decrypt']);}
export async function seal(value,secret,context){const iv=crypto.getRandomValues(new Uint8Array(12));const data=new TextEncoder().encode(JSON.stringify(value));if(data.length>REMOTE_MAX_BYTES)throw new Error('Use smaller media chunks or a background analysis job for this payload');const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(context)},await key(secret),data);return JSON.stringify({iv:b64(iv),data:b64(new Uint8Array(ciphertext))});}
export async function open(value,secret,context){const message=JSON.parse(value);const data=await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(message.iv),additionalData:new TextEncoder().encode(context)},await key(secret),unb64(message.data));return JSON.parse(new TextDecoder().decode(data));}
export function parts(value){const out=[];for(let i=0;i<value.length;i+=REMOTE_PART_SIZE)out.push(value.slice(i,i+REMOTE_PART_SIZE));return out;}
