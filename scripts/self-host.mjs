import { randomBytes } from 'node:crypto';
import { existsSync, openSync, writeFileSync, closeSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname, resolve } from 'node:path';
import { domainToASCII, fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export function domainName(input) {
  let url;
  try{url=new URL(input.includes('://')?input:'https://'+input);}catch{throw new Error('Enter a public domain, for example relay.yourdomain.com');}
  if(url.protocol!=='https:'||url.username||url.password||url.port||url.pathname!=='/'||url.search||url.hash)throw new Error('Use only the HTTPS domain, without a path, port, password or query');
  const host=domainToASCII(url.hostname).toLowerCase();
  if(!host || host.length>253 || isIP(host) || !host.includes('.') || host.endsWith('.local') || host.endsWith('.localhost') || host.endsWith('.internal') || !host.split('.').every(s=>s.length<=63&&/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(s)))throw new Error('A public DNS domain is required for this automatic HTTPS setup');
  return host;
}
export function deploymentSettings(domain,email) {
  const host=domainName(domain);
  if(typeof email!=='string'||email.length>254||!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email))throw new Error('Enter a valid email address for certificate renewal notices');
  return {domain:host,email,token:randomBytes(32).toString('base64url')};
}
export function saveSettings(filename,settings) {
  // Exclusive creation prevents accidental owner-token changes on repeated setup.
  const fd=openSync(filename,'wx',0o600);
  try{writeFileSync(fd,`RELAY_DOMAIN=${settings.domain}\nRELAY_ACME_EMAIL=${settings.email}\nRELAY_OWNER_TOKEN=${settings.token}\n`);}finally{closeSync(fd);}
}
export function composeArguments(action,filename) {
  const operations={start:['up','--detach','--build'],stop:['stop'],status:['ps'],logs:['logs','--tail','100']};
  if(!operations[action])throw new Error('Use setup, start, status, logs or stop');
  return ['compose','--project-directory',project,'--env-file',filename,'--file',resolve(project,'compose.selfhost.yaml'),...operations[action]];
}
export function main(args) {
  const [action,...rest]=args;const filename=resolve(project,'deploy/selfhost.env');
  if(action==='setup') {
    const values={};for(let i=0;i<rest.length;i+=2){if(!['--domain','--email'].includes(rest[i])||!rest[i+1])throw new Error('Setup requires --domain and --email');values[rest[i]]=rest[i+1];}
    if(!values['--domain']||!values['--email'])throw new Error('Setup requires --domain and --email');
    const settings=deploymentSettings(values['--domain'],values['--email']);saveSettings(filename,settings);
    console.log(`Self-host configuration prepared for https://${settings.domain}\nPrivate owner token saved in ${filename}\nThe HTTPS endpoint is not live until DNS points to this server, ports 80/443 are reachable, and the service starts.`);return;
  }
  if(!existsSync(filename))throw new Error('Configure the domain and certificate email before starting the host');
  const options=composeArguments(action,filename);
  const result=spawnSync('docker',options,{cwd:project,stdio:'inherit'});
  if(result.error)throw new Error('Docker with Compose must be installed and running on the public server');
  if(result.status!==0)throw new Error(`Hosting operation failed (exit ${result.status ?? 'unknown'}). Check the Docker service and network configuration.`);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{main(process.argv.slice(2));}catch(e){console.error(e.message);process.exitCode=1;}}
