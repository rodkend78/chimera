import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { openGoogleConsent } from '../src/clients/google-connection.mjs'
const module = await import('../src/clients/linux-secret-store.mjs').catch(()=>({}))

function native({code=0,stdout='',stderr='',hang=false}={}) {
  const calls=[]
  const spawnImpl=(file,args,options)=>{
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough()
    const call={file,args,options,input:''};calls.push(call);child.stdin.on('data',x=>call.input+=x)
    child.kill=()=>{child.killed=true;child.emit('close',null)}
    child.stdin.on('finish',()=>{if(!hang)queueMicrotask(()=>{child.stdout.end(stdout);child.stderr.end(stderr);child.emit('close',code)})})
    return child
  }
  return {calls,spawnImpl}
}
test('Linux credentials use exact Secret Service attributes and pipes, never argv or disk',async()=>{
  assert.equal(typeof module.LinuxSecretStore,'function')
  const f=native(), store=new module.LinuxSecretStore({spawnImpl:f.spawnImpl,platform:'linux',accessImpl:async()=>{}})
  assert.equal(await store.available(),true)
  await store.set({refreshToken:'fixture-sensitive'})
  assert.deepEqual(f.calls[0].args,['store','--label=Chimera Google client intake','service','com.team-rsi.chimera.client-intake','account','chimera-google'])
  assert.equal(f.calls[0].file,'/usr/bin/secret-tool')
  assert.equal(f.calls[0].input,'{"refreshToken":"fixture-sensitive"}')
  assert.doesNotMatch(JSON.stringify(f.calls[0].args),/fixture-sensitive/)
})
test('Linux restore distinguishes missing credentials from an unavailable or corrupt keyring',async()=>{
  assert.equal(typeof module.LinuxSecretStore,'function')
  for(const [response,want] of [[{stdout:'{"refreshToken":"fixture"}'},{refreshToken:'fixture'}],[{code:1},null]]){
    const f=native(response);assert.deepEqual(await new module.LinuxSecretStore({spawnImpl:f.spawnImpl}).get(),want)
    assert.equal(f.calls[0].args[0],'lookup')
  }
  for(const response of [{code:1,stderr:'Private error detail'},{stdout:'not-json'},{stdout:'{"accessToken":"wrong"}'},{stdout:'x'.repeat(65537)}]){
    const f=native(response)
    await assert.rejects(new module.LinuxSecretStore({spawnImpl:f.spawnImpl}).get(),e=>e.code==='CLIENT_INTAKE_KEYCHAIN_UNAVAILABLE'&&!e.message.includes('Private'))
  }
})
test('Linux disconnect clears only Chimera credentials and a stalled keyring is bounded',async()=>{
  assert.equal(typeof module.LinuxSecretStore,'function')
  const f=native({code:1});await new module.LinuxSecretStore({spawnImpl:f.spawnImpl}).delete()
  assert.deepEqual(f.calls[0].args,['clear','service','com.team-rsi.chimera.client-intake','account','chimera-google'])
  const stalled=native({hang:true})
  await assert.rejects(new module.LinuxSecretStore({spawnImpl:stalled.spawnImpl,timeoutMs:20}).get(),{code:'CLIENT_INTAKE_KEYCHAIN_UNAVAILABLE'})
})

test('Google consent opens the OS browser without substituting a Mac command on Linux',async()=>{
  const calls=[]
  await openGoogleConsent('https://accounts.google.com/o/oauth2/v2/auth',{platform:'linux',execFileImpl:(...args)=>{calls.push(args.slice(0,3));args.at(-1)(null)}})
  assert.equal(calls[0][0],'/usr/bin/xdg-open')
  assert.deepEqual(calls[0][1],['https://accounts.google.com/o/oauth2/v2/auth'])
  assert.equal(calls[0][2].timeout,10000)
})
