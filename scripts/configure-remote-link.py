#!/usr/bin/env python3
"""Prepare private runtime settings from hidden stdin; never package this output."""
import json
import os
from pathlib import Path
import secrets
import sys
import termios
from urllib.parse import urlparse
import uuid

ROOT=Path(__file__).resolve().parent.parent
def main():
    original=None
    if sys.stdin.isatty():
        original=termios.tcgetattr(sys.stdin.fileno());hidden=termios.tcgetattr(sys.stdin.fileno());hidden[3]&=~termios.ECHO;termios.tcsetattr(sys.stdin.fileno(),termios.TCSANOW,hidden)
        print('Ready for private runtime settings on stdin (input is hidden).',flush=True)
    try:incoming=json.loads(sys.stdin.readline())
    finally:
        if original:termios.tcsetattr(sys.stdin.fileno(),termios.TCSANOW,original)
    url=urlparse(incoming['remoteUrl'])
    if url.scheme!='https' or url.username or url.password or url.path not in ('','/') or url.query or url.fragment:raise RuntimeError('Expected a verified HTTPS Site origin')
    if not incoming.get('siteAccessKey') or any(c in incoming['siteAccessKey'] for c in '\r\n'):raise RuntimeError('A private Site service credential is required')
    path=ROOT/'data/remote-link.json';path.parent.mkdir(mode=0o700,exist_ok=True)
    data=json.loads(path.read_text()) if path.exists() else {}
    if data.get('projectId') and data['projectId']!=incoming['projectId']:raise RuntimeError('Another hosted relay is already configured; refusing to replace its identity')
    data.update({'projectId':incoming['projectId'],'remoteUrl':incoming['remoteUrl'].rstrip('/'),'siteAccessKey':incoming['siteAccessKey'],'ownerEmail':incoming['ownerEmail'],'published':False})
    data.setdefault('agentKey',secrets.token_urlsafe(32));data.setdefault('clientKey',secrets.token_urlsafe(32));data.setdefault('agentId',str(uuid.uuid4()));data.setdefault('localUrl','http://127.0.0.1:8787')
    fd=os.open(str(path),os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
    with os.fdopen(fd,'w') as stream:json.dump(data,stream,indent=2);stream.write('\n')
    path.chmod(0o600);print('Private runtime settings prepared; hosted activation remains pending.')
if __name__=='__main__':main()
