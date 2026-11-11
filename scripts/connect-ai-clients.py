#!/usr/bin/env python3
"""User-run Mac launcher for the existing private Relay Site connection."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import urllib.request

ROOT=Path(__file__).resolve().parent.parent

def node_binary():
    candidates=[os.environ.get('NODE_BINARY'),shutil.which('node')]
    candidates += [str(p) for p in (Path.home()/'.nvm/versions/node').glob('*/bin/node')]
    candidates += ['/opt/homebrew/bin/node','/usr/local/bin/node']
    return next((path for path in candidates if path and Path(path).is_file() and os.access(path,os.X_OK)),None)

def active_agent():
    path=ROOT/'data/remote-agent.pid'
    try:
        pid=int(path.read_text().strip())
        result=subprocess.run(['/bin/ps','-p',str(pid),'-o','command='],capture_output=True,text=True)
        return result.returncode==0 and str(ROOT/'src/remote-agent.js') in result.stdout
    except (OSError,ValueError):return False

def main():
    path=ROOT/'data/remote-link.json'
    if not path.exists():raise RuntimeError('The private relay has not been configured yet. Finish the publishing step first.')
    settings=json.loads(path.read_text())
    if not settings.get('published'):raise RuntimeError('The connector is prepared but the hosted update is not published yet. No WhatsApp session was changed.')
    node=node_binary()
    if not node:raise RuntimeError('Node.js 22.13 or newer is required.')
    if not active_agent():
        spec=importlib.util.spec_from_file_location('relay_session_helpers',ROOT/'scripts/transfer-termux-session.py')
        helpers=importlib.util.module_from_spec(spec);spec.loader.exec_module(helpers)
        helpers.validate_configuration()
        token=(ROOT/'data/owner-token').read_text().strip()
        print('Loading the updated bridge with your saved WhatsApp session.')
        helpers.stop_local(helpers.local_listeners())
        if not helpers.start_local(token):print('The bridge is running. WhatsApp is still reconnecting; check its dashboard.')
        log=ROOT/'data/remote-agent.log'
        fd=os.open(str(log),os.O_WRONLY|os.O_CREAT|os.O_APPEND,0o600)
        with os.fdopen(fd,'ab') as stream:
            child=subprocess.Popen([node,str(ROOT/'src/remote-agent.js')],cwd=str(ROOT),stdin=subprocess.DEVNULL,stdout=stream,stderr=subprocess.STDOUT,start_new_session=True)
        time.sleep(2)
        if child.poll() is not None:raise RuntimeError('The remote agent could not start. Its private log is data/remote-agent.log.')
    # This health check must not claim or discard queued tool requests.
    request=urllib.request.Request(settings['remoteUrl']+'/api/whatsapp/agent/health',data=json.dumps({'agent':settings['agentId']}).encode(),headers={'Content-Type':'application/json','Authorization':'Bearer '+settings['agentKey'],'OAI-Sites-Authorization':'Bearer '+settings['siteAccessKey']})
    with urllib.request.urlopen(request,timeout=20) as response:state=json.load(response)
    if not state.get('online'):raise RuntimeError('The local agent started but its hosted connection is not ready yet. Try this launcher again shortly.')
    print('Verified: your Mac is connected to the private hosted relay.')
    print('Open the setup page and finish adding the connector in each AI account.')
    subprocess.run(['/usr/bin/open','http://127.0.0.1:8787/ai-clients.html'],check=False)
    print('Setup: http://127.0.0.1:8787/ai-clients.html')
    print('Keep your Mac awake and online. Keep the old phone bridge stopped.')

if __name__=='__main__':
    try:main()
    except Exception as error:print('Connection could not finish: '+str(error));raise SystemExit(1)
