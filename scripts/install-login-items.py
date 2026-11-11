#!/usr/bin/env python3
"""Configure next-login startup without interrupting the current connected processes."""
import json
import os
from pathlib import Path
import plistlib

ROOT=Path(__file__).resolve().parent.parent

def main():
    if os.uname().sysname!='Darwin':raise RuntimeError('This installer is for the Mac host')
    config=json.loads((ROOT/'data/remote-link.json').read_text())
    if not config.get('published'):raise RuntimeError('Publish and verify the private relay before enabling login startup')
    folder=Path.home()/'Library/LaunchAgents';folder.mkdir(parents=True,exist_ok=True)
    for kind,script,log in [('bridge','start.sh','server.log'),('agent','start-remote.sh','remote-agent.log')]:
        label=os.environ.get('RELAY_LAUNCHD_PREFIX','com.example.whatsapp-relay')+'.'+kind;path=folder/(label+'.plist');entry=ROOT/script
        if path.exists():
            previous=plistlib.loads(path.read_bytes())
            if previous.get('Label')!=label or str(entry) not in previous.get('ProgramArguments',[]):raise RuntimeError('A different service already owns '+label)
        logfile=ROOT/'data'/log
        fd=os.open(str(logfile),os.O_WRONLY|os.O_CREAT|os.O_APPEND,0o600);os.close(fd);logfile.chmod(0o600)
        data={'Label':label,'ProgramArguments':['/bin/sh',str(entry)],'WorkingDirectory':str(ROOT),'RunAtLoad':True,'StandardOutPath':str(logfile),'StandardErrorPath':str(logfile),'ProcessType':'Background'}
        if kind=='bridge':data['EnvironmentVariables']={'AUTO_CONNECT':'true'}
        fd=os.open(str(path),os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
        with os.fdopen(fd,'wb') as stream:plistlib.dump(data,stream)
        path.chmod(0o600)
        print('Configured next-login startup:',label)
    print('Current connected processes were retained. Startup after a full logout/reboot has not been tested.')

if __name__=='__main__':main()
