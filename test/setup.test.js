import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,cpSync,readFileSync,existsSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {buildSettings,serializeEnv,parseEnv,clientConfigs,normalizeOrigin,claudeDesktopConfigPath,nodeVersionOk} from '../setup.mjs';
import {plan,render,xmlEscape,systemdQuote} from '../scripts/install-autostart.mjs';
import {nextDelay,relayConfigured} from '../scripts/relay-service.mjs';
import {RemoteAgent} from '../src/remote-agent.js';

const repo=resolve(import.meta.dirname,'..');
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('setup: URLs are normalised to HTTPS origins',()=>{
  assert.equal(normalizeOrigin(''),'');
  assert.equal(normalizeOrigin('relay.example.com'),'https://relay.example.com');
  assert.equal(normalizeOrigin('https://relay.example.com/whatsapp/mcp'),'https://relay.example.com');
  assert.throws(()=>normalizeOrigin('http://relay.example.com'),/https/);
  assert.throws(()=>normalizeOrigin('https://user:pw@relay.example.com'),/credentials/);
});
test('setup: a local-only install needs no relay and gets a strong bridge token',()=>{
  const {env,relaySecrets,doorwaySecrets}=buildSettings({mode:'first'});
  assert.ok(env.BRIDGE_TOKEN.length>=43);assert.equal(env.RELAY_REMOTE_URL,undefined);
  assert.equal(relaySecrets,null);assert.equal(doorwaySecrets,null);
});
test('setup: first device generates distinct random keys and matching relay/doorway secrets',()=>{
  const a=buildSettings({mode:'first',relayUrl:'https://relay.example.com',doorwayUrl:'whatsapp-claude.example.workers.dev'});
  const b=buildSettings({mode:'first',relayUrl:'https://relay.example.com'});
  const keys=['BRIDGE_TOKEN','RELAY_AGENT_KEY','RELAY_CLIENT_KEY','CLAUDE_DOORWAY_KEY'];
  for(const k of keys){assert.match(a.env[k],/^[A-Za-z0-9_-]{43}$/);assert.notEqual(a.env[k],b.env[k]);}
  assert.equal(new Set(keys.map(k=>a.env[k])).size,keys.length,'every key is different');
  assert.match(a.env.RELAY_AGENT_ID,uuid);assert.match(a.env.RELAY_DEVICE_ID,uuid);assert.equal(a.env.RELAY_FAILOVER_ROLE,'primary');
  assert.deepEqual(a.relaySecrets,{WA_AGENT_KEY:a.env.RELAY_AGENT_KEY,WA_CLIENT_KEY:a.env.RELAY_CLIENT_KEY});
  assert.deepEqual(a.doorwaySecrets,{RELAY_URL:'https://relay.example.com/whatsapp/mcp',PROXY_KEY:a.env.CLAUDE_DOORWAY_KEY,CLIENT_KEY:a.env.RELAY_CLIENT_KEY});
  assert.equal(a.env.CLAUDE_DOORWAY_URL,'https://whatsapp-claude.example.workers.dev');
});
test('setup: a standby reuses the shared agent key/id but gets its own device id and token',()=>{
  const first=buildSettings({mode:'first',relayUrl:'relay.example.com'}).env;
  const {env,relaySecrets,doorwaySecrets}=buildSettings({mode:'standby',relayUrl:first.RELAY_REMOTE_URL,agentKey:first.RELAY_AGENT_KEY,agentId:first.RELAY_AGENT_ID});
  assert.equal(env.RELAY_AGENT_KEY,first.RELAY_AGENT_KEY);assert.equal(env.RELAY_AGENT_ID,first.RELAY_AGENT_ID);
  assert.notEqual(env.RELAY_DEVICE_ID,first.RELAY_DEVICE_ID);assert.notEqual(env.BRIDGE_TOKEN,first.BRIDGE_TOKEN);
  assert.equal(env.RELAY_FAILOVER_ROLE,'standby');assert.equal(relaySecrets,null);assert.equal(doorwaySecrets,null);
  assert.throws(()=>buildSettings({mode:'standby',relayUrl:'relay.example.com'}),/RELAY_AGENT_KEY/);
});
test('setup: .env round-trips',()=>{
  const {env}=buildSettings({mode:'first',relayUrl:'relay.example.com',siteKey:'with space "quoted"'});
  const parsed=parseEnv(serializeEnv(env));
  for(const [k,v] of Object.entries(env))assert.equal(parsed[k],v,k);
});
test('setup: client configs are valid JSON and only include remote keys when configured',()=>{
  const local=clientConfigs(buildSettings({mode:'first'}).env,{node:'/usr/bin/node',dir:'/opt/relay',platform:'linux'});
  assert.ok(local.some(s=>s.title.startsWith('Claude Code')));assert.ok(!local.some(s=>/doorway/.test(s.title)));
  const {env}=buildSettings({mode:'first',relayUrl:'relay.example.com',doorwayUrl:'d.example.workers.dev'});
  const remote=clientConfigs(env,{node:'C:\\Program Files\\nodejs\\node.exe',dir:'C:\\relay',platform:'win32'});
  for(const s of remote){const m=s.text.match(/\{[\s\S]*\}/);if(m)JSON.parse(m[0]);}
  const code=remote.find(s=>s.title==='Claude Code (any computer) via the Cloudflare doorway').text;
  assert.ok(code.includes('https://d.example.workers.dev/mcp'));assert.ok(code.includes(env.CLAUDE_DOORWAY_KEY));
  assert.match(remote.find(s=>s.title==='ChatGPT connector').text,/OAuth/);
  assert.match(claudeDesktopConfigPath('win32','C:\\Users\\a','C:\\Users\\a\\AppData\\Roaming'),/Claude.claude_desktop_config\.json$/);
  assert.equal(claudeDesktopConfigPath('linux','/home/a'),null);
  assert.equal(nodeVersionOk('22.12.0'),false);assert.equal(nodeVersionOk('22.13.0'),true);assert.equal(nodeVersionOk('24.0.0'),true);
});
test('setup: interactive run writes .env and secret files without echoing hidden input',()=>{
  const dir=mkdtempSync(join(tmpdir(),'relay-setup-'));
  try{
    cpSync(join(repo,'setup.mjs'),join(dir,'setup.mjs'));
    for(const d of ['relay-worker','claude-proxy'])cpSync(join(repo,d,'.gitignore'),join(dir,d,'.gitignore'));
    const input=['1','https://relay.example.com','https://whatsapp-claude.example.workers.dev',''].join('\n');
    const r=spawnSync(process.execPath,[join(dir,'setup.mjs')],{input,encoding:'utf8'});
    assert.equal(r.status,0,r.stderr);
    const env=parseEnv(readFileSync(join(dir,'.env'),'utf8'));
    assert.equal(env.RELAY_REMOTE_URL,'https://relay.example.com');assert.equal(env.RELAY_SITE_KEY,undefined);
    assert.ok(r.stdout.includes('claude mcp add --transport http whatsapp https://whatsapp-claude.example.workers.dev/mcp'));
    const doorway=JSON.parse(readFileSync(join(dir,'claude-proxy','.secrets.json'),'utf8'));assert.equal(doorway.PROXY_KEY,env.CLAUDE_DOORWAY_KEY);
    const relay=JSON.parse(readFileSync(join(dir,'relay-worker','.secrets.json'),'utf8'));assert.deepEqual(Object.keys(relay).sort(),['WA_AGENT_KEY','WA_CLIENT_KEY']);
    if(process.platform!=='win32')assert.equal(statSync(join(dir,'.env')).mode&0o077,0,'.env is private');
    const again=spawnSync(process.execPath,[join(dir,'setup.mjs')],{input:'n\n',encoding:'utf8'});
    assert.equal(again.status,0);assert.match(again.stdout,/Nothing changed/);
    const printed=spawnSync(process.execPath,[join(dir,'setup.mjs'),'--print'],{encoding:'utf8'});
    assert.ok(printed.stdout.includes(env.CLAUDE_DOORWAY_KEY));
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('autostart: templates render for macOS and Linux, escaping awkward paths',()=>{
  const dir='/Users/someone/My Relay & Co';
  const mac=plan({platform:'darwin',node:'/opt/node/bin/node',dir:repo,home:'/Users/someone',env:{}});
  const posix=p=>p.replaceAll('\\','/');
  assert.equal(mac.label,'com.example.whatsapp-relay.service');assert.ok(posix(mac.target).endsWith('Library/LaunchAgents/com.example.whatsapp-relay.service.plist'));
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(mac.body));assert.ok(mac.body.includes('<string>/opt/node/bin/node</string>'));
  assert.equal(render('<string>{{RELAY_DIR}}</string>',{RELAY_DIR:dir},xmlEscape),'<string>/Users/someone/My Relay &amp; Co</string>');
  const linux=plan({platform:'linux',node:'/usr/bin/node',dir:repo,home:'/home/someone',env:{}});
  assert.ok(posix(linux.target).endsWith('.config/systemd/user/whatsapp-relay.service'));
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(linux.body));assert.match(posix(linux.body),/^ExecStart=\/usr\/bin\/node .*scripts\/+relay-service\.mjs"?$/m);
  assert.equal(systemdQuote('/home/a b/100%'),'"/home/a b/100%%"');
  const win=plan({platform:'win32',node:'C:\\node\\node.exe',dir:repo});assert.ok(win.script.endsWith('install-autostart.ps1'));
  assert.ok(existsSync(win.script));
  assert.throws(()=>render('{{NOPE}}',{}),/Missing/);
});
test('service: restarts back off while crashing and reset after a stable run; relay is optional',()=>{
  assert.equal(nextDelay(0,100),2000);assert.equal(nextDelay(2000,100),4000);assert.equal(nextDelay(16000,100),30000);assert.equal(nextDelay(30000,100),30000);
  assert.equal(nextDelay(30000,61000),2000);
  assert.equal(relayConfigured({},'/nonexistent'),false);
  assert.equal(relayConfigured({RELAY_REMOTE_URL:'https://r.example',RELAY_AGENT_KEY:'k',RELAY_AGENT_ID:'i'},'/nonexistent'),true);
});
test('agent: with no failover role configured a single device acts as the primary',()=>{
  const base={remoteUrl:'https://relay.example.test',agentKey:'k',agentId:'a'};
  assert.equal(new RemoteAgent(base).role,'primary');
  assert.equal(new RemoteAgent({...base,failoverRole:'standby'}).role,'standby');
});
test('agent: the standby check interval is configurable but never faster than the default',()=>{
  const base={remoteUrl:'https://relay.example.test',agentKey:'k',agentId:'a',failoverRole:'standby'};
  assert.equal(new RemoteAgent(base).watchMs,750);assert.equal(new RemoteAgent({...base,watchMs:'3000'}).watchMs,3000);assert.equal(new RemoteAgent({...base,watchMs:'10'}).watchMs,750);
});
test('setup: a standby on a workers.dev relay checks less often (free tier)',()=>{
  const first=buildSettings({mode:'first',relayUrl:'whatsapp-relay.someone.workers.dev'}).env;
  const standby=buildSettings({mode:'standby',relayUrl:first.RELAY_REMOTE_URL,agentKey:first.RELAY_AGENT_KEY,agentId:first.RELAY_AGENT_ID}).env;
  assert.equal(standby.RELAY_WATCH_MS,'3000');assert.equal(first.RELAY_WATCH_MS,undefined);
  assert.equal(parseEnv(serializeEnv(standby)).RELAY_WATCH_MS,'3000');
});
