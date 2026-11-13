import { resolve } from 'node:path';
import { config } from './config.js';
import { Store } from './store.js';
import { WhatsApp } from './whatsapp.js';
import { DemoWhatsApp } from './demo.js';
import { Bridge } from './tools.js';
import { createApp } from './server.js';
import { openBrowser, shouldOpenBrowser } from './open-browser.js';
const cfg=config();
const store=new Store(resolve(cfg.dir,'bridge.sqlite'));
const wa=cfg.demo?new DemoWhatsApp(store,cfg):new WhatsApp(store,cfg);
const bridge=new Bridge(store,wa,cfg);
const app=createApp(bridge,cfg);
const server=app.listen(cfg.port,cfg.host,()=>{
  console.log(`WhatsApp AI Bridge${cfg.demo?' — DEMO':''}\nDashboard: ${cfg.base}\nMCP: ${cfg.base}/mcp`);
  console.log('Open the dashboard to sign in or create your account.');
  if(shouldOpenBrowser({production:cfg.production}))openBrowser(cfg.base);
  if(cfg.autoConnect && wa.hasSavedSession?.())wa.start().catch(e=>console.error('WhatsApp reconnect:',e.message));
  else console.log('Click Connect WhatsApp in the dashboard to pair.');
});
server.on('error',async e=>{
  // Already running (for example, the background service): just open it.
  if(e.code==='EADDRINUSE'){
    const ok=await fetch(`http://127.0.0.1:${cfg.port}/healthz`).then(r=>r.ok).catch(()=>false);
    if(ok){console.log(`Relay is already running: ${cfg.base}`);if(shouldOpenBrowser({production:cfg.production}))openBrowser(cfg.base);store.close();process.exit(0);}
    console.error(`Port ${cfg.port} is in use by another program. Set PORT in .env to use a different one.`);process.exit(1);
  }
  console.error(e.message);process.exit(1);
});
const timer=setInterval(()=>bridge.tick().catch(e=>console.error('Scheduler:',e.message)),1000);
let closing=false;
async function shutdown(){if(closing)return;closing=true;clearInterval(timer);bridge.analysis?.stop();await wa.stop();while(bridge.ticking)await new Promise(r=>setTimeout(r,50));server.close();server.closeAllConnections();store.close();process.exit(0);}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
