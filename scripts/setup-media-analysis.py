#!/usr/bin/env python3
"""Install the optional free media engine into this project, without account keys."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import urllib.request

ROOT=Path(__file__).resolve().parent.parent

def main():
    python=next((p for p in ['/Library/Frameworks/Python.framework/Versions/3.12/bin/python3',shutil.which('python3.12'),shutil.which('python3.11'),shutil.which('python3')] if p and Path(p).is_file()),None)
    if not python:raise RuntimeError('Install Python 3.10 or newer, then run this launcher again.')
    environment=ROOT/'.media-venv';executable=environment/('Scripts/python.exe' if os.name=='nt' else 'bin/python')
    if not executable.exists():subprocess.run([python,'-m','venv',str(environment)],check=True)
    subprocess.run([str(executable),'-m','pip','install','--disable-pip-version-check','--cache-dir',str(ROOT/'.media-models/pip-cache'),'-r',str(ROOT/'deploy/media-requirements.txt')],check=True)
    manifest=json.loads((ROOT/'deploy/whisper-model.json').read_text());folder=ROOT/'.media-models/whisper-tiny';folder.mkdir(mode=0o700,parents=True,exist_ok=True)
    for name,sha in manifest['files'].items():
        target=folder/name
        if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest()==sha:continue
        print('Downloading transcription model: '+name,flush=True)
        url='https://huggingface.co/'+manifest['repository']+'/resolve/'+manifest['revision']+'/'+name
        temp=target.with_suffix(target.suffix+'.partial')
        with urllib.request.urlopen(url,timeout=120) as response,temp.open('wb') as output:shutil.copyfileobj(response,output,1024*1024)
        if hashlib.sha256(temp.read_bytes()).hexdigest()!=sha:temp.unlink();raise RuntimeError('Transcription model checksum did not match')
        temp.replace(target);target.chmod(0o600)
    subprocess.run([str(executable),str(ROOT/'scripts/media-worker.py'),'capabilities'],check=True)
    print('Local transcription and document extraction are ready. FFmpeg enables video frames; an installed local Ollama vision model enables visual descriptions and image/scanned-page OCR.')

if __name__=='__main__':
    try:main()
    except Exception as error:print('Media setup could not finish: '+str(error));raise SystemExit(1)
