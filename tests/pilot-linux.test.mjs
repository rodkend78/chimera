import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, lstat, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile as callback } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:net'
import { submitPilotService, removePilotService, inspectPilotService, waitForPilotService } from '../src/pilot/service-manager.mjs'

test('Linux lifecycle registers a private restartable user service without shell expansion', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pilot-linux-'))
  t.after(() => rm(directory, {recursive:true,force:true}))
  const outputPath=join(directory,'pilot.log'), calls=[]
  const execFileImpl=async (file,args)=>{calls.push([file,args]); return {stdout:'active\n'}}
  await submitPilotService({platform:'linux', label:'chimera-test', program:'/opt/node', args:['/tmp/$literal%name.mjs'], workingDirectory:directory, outputPath, env:{PATH:'/usr/bin',WAYLAND_DISPLAY:'wayland-1',AWS_SECRET_ACCESS_KEY:'SECRET'}, execFileImpl})
  assert.equal(calls[0][0],'systemctl')
  assert.deepEqual(calls.map(c=>c[1]), [['--user','daemon-reload'],['--user','enable','--now',join(directory,'chimera-test.service')]])
  const unit=await readFile(join(directory,'chimera-test.service'),'utf8')
  assert.match(unit,/ExecStart=:"\/opt\/node" "\/tmp\/\$literal%%name.mjs"/)
  assert.match(unit,/Restart=on-failure/)
  assert.match(unit,/UMask=0077/)
  assert.match(unit,/Environment="WAYLAND_DISPLAY=wayland-1"/)
  assert.doesNotMatch(unit,/SECRET|AWS_SECRET|\/bin\/(ba)?sh/)
  assert.equal((await lstat(join(directory,'chimera-test.service'))).mode&0o777,0o600)
  assert.equal((await lstat(outputPath)).mode&0o777,0o600)
  assert.equal((await inspectPilotService({platform:'linux',label:'chimera-test',port:1,execFileImpl})).jobLoaded,true)
  await removePilotService({platform:'linux',label:'chimera-test',execFileImpl})
  assert.deepEqual(calls.at(-1),['systemctl',['--user','disable','--now','chimera-test.service']])
})

test('Linux unit refuses command injection and foreign files before invoking systemctl', async t => {
  const directory=await mkdtemp(join(tmpdir(),'pilot-unsafe-'));t.after(()=>rm(directory,{recursive:true,force:true}))
  const options={platform:'linux',label:'chimera-test',program:'/opt/node',workingDirectory:directory,outputPath:join(directory,'pilot.log'),execFileImpl:async()=>{throw Error('must not dispatch')}}
  await assert.rejects(submitPilotService({...options,args:['bad\nExecStart=/bin/evil']}),/invalid/i)
  const foreign=join(directory,'foreign');await writeFile(foreign,'keep')
  await symlink(foreign,join(directory,'chimera-test.service'))
  await assert.rejects(submitPilotService(options))
  assert.equal(await readFile(foreign,'utf8'),'keep')
})

test('real Linux user service preserves literal paths, survives launcher exit, restarts and stops', {skip:process.platform!=='linux'||process.env.CHIMERA_TEST_SYSTEMD!=='1'},async()=>{
  const exec=promisify(callback), directory=await mkdtemp(join(tmpdir(),'chimera-linux live-'))
  const label=`chimera-test-${process.pid}-${Date.now()}`,outputPath=join(directory,'private output.log')
  const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r))
  const code=`console.log(JSON.stringify({arg:process.argv[1],cwd:process.cwd()}));require('node:net').createServer(s=>s.end()).listen(${port},'127.0.0.1')`
  try{
    await submitPilotService({label,program:process.execPath,args:['-e',code,'$literal%value'],workingDirectory:directory,outputPath})
    assert.equal((await waitForPilotService({label,port,timeoutMs:8000})).status,'running')
    const first=Number((await exec('systemctl',['--user','show','--property=MainPID','--value',label+'.service'])).stdout.trim())
    assert.ok(first>0)
    const log=JSON.parse((await readFile(outputPath,'utf8')).trim().split('\n')[0]);assert.deepEqual(log,{arg:'$literal%value',cwd:directory})
    process.kill(first,'SIGKILL')
    let changed=false
    for(let i=0;i<100;i++){
      const pid=Number((await exec('systemctl',['--user','show','--property=MainPID','--value',label+'.service'])).stdout.trim())
      if(pid>0&&pid!==first){changed=true;break}await new Promise(r=>setTimeout(r,100))
    }
    assert.ok(changed,'service must restart its test process')
    assert.equal((await waitForPilotService({label,port,timeoutMs:8000})).status,'running')
    await removePilotService({label});assert.equal((await inspectPilotService({label,port})).status,'stopped')
  }finally{await removePilotService({label}).catch(()=>{});await rm(directory,{recursive:true,force:true})}
})
