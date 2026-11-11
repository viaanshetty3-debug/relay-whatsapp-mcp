import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { domainName, deploymentSettings, saveSettings, composeArguments } from '../scripts/self-host.mjs';

test('self-host setup accepts only a domain without credentials or URL configuration injection',()=>{
  assert.equal(domainName('Relay.Example.com'),'relay.example.com');
  assert.equal(domainName('https://relay.example.com/'),'relay.example.com');
  for(const input of ['localhost','127.0.0.1','http://relay.example.com','https://secret@relay.example.com','relay.example.com:444','relay.example.com/admin','relay.example.com?q=secret','host.local','host.internal','*.example.com','https://relay.example.com/#fragment'])assert.throws(()=>domainName(input));
});
test('self-host setup generates independent strong owner tokens and rejects malformed certificate emails',()=>{
  const a=deploymentSettings('relay.example.com','owner@example.com'),b=deploymentSettings('relay.example.com','owner@example.com');
  assert.equal(a.domain,'relay.example.com');assert.match(a.token,/^[A-Za-z0-9_-]{43}$/);assert.notEqual(a.token,b.token);
  for(const email of ['invalid','a@example.com\nRELAY_OWNER_TOKEN=inject','a b@example.com'])assert.throws(()=>deploymentSettings('relay.example.com',email));
});
test('repeated setup preserves the original owner token and limits secret file access',()=>{
  const directory=mkdtempSync(resolve(tmpdir(),'relay-selfhost-'));try{
    const filename=resolve(directory,'selfhost.env'),first=deploymentSettings('relay.example.com','owner@example.com');
    saveSettings(filename,first);const contents=readFileSync(filename,'utf8');assert.match(contents,/RELAY_DOMAIN=relay.example.com/);assert.ok(contents.includes(first.token));
    if(process.platform!=='win32')assert.equal(statSync(filename).mode&0o777,0o600); // Windows has no POSIX modes
    assert.throws(()=>saveSettings(filename,deploymentSettings('second.example.com','owner@example.com')),/EEXIST/);assert.equal(readFileSync(filename,'utf8'),contents);
  }finally{rmSync(directory,{recursive:true,force:true});}
});
test('host manager uses structured Docker arguments and stop preserves persistent volumes',()=>{
  const filename='/a path/selfhost.env';const start=composeArguments('start',filename),stop=composeArguments('stop',filename);
  assert.equal(start[start.indexOf('--env-file')+1],filename);assert.deepEqual(start.slice(-3),['up','--detach','--build']);
  assert.equal(stop.at(-1),'stop');assert.ok(!stop.includes('--volumes'));assert.throws(()=>composeArguments('delete-everything',filename));
});
