// Successful QR pairing writes me + signed account credentials. The registered
// flag is also used by phone-code flows, but is not set by every QR-pairing path.
function hasBytes(value) {
  if(typeof value==='string' || Array.isArray(value))return value.length>0;
  if(ArrayBuffer.isView(value))return value.byteLength>0;
  return !!value && typeof value==='object' && value.type==='Buffer' && hasBytes(value.data);
}
export function hasLinkedCredentials(credentials) {
  if(!credentials || typeof credentials.me?.id!=='string' || !credentials.me.id.trim())return false;
  return credentials.registered===true ||
    (hasBytes(credentials.account?.accountSignature) && hasBytes(credentials.account?.deviceSignature));
}
