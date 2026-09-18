import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'

const unavailable = () => Object.assign(new Error('CLIENT_INTAKE_KEYCHAIN_UNAVAILABLE'), { code: 'CLIENT_INTAKE_KEYCHAIN_UNAVAILABLE' })
const valid = value => value && Object.keys(value).join(',') === 'refreshToken'
  && typeof value.refreshToken === 'string' && value.refreshToken.length > 0
  && Buffer.byteLength(JSON.stringify(value)) <= 8192

// Secret Service owns encryption and unlocking. No plaintext fallback, shell,
// token-bearing argv, or credential output in logs/API responses.
export class LinuxSecretStore {
  constructor({ service = 'com.team-rsi.chimera.client-intake', account = 'chimera-google',
    platform = process.platform, spawnImpl = spawn, accessImpl = access, timeoutMs = 30000 } = {}) {
    if (![service,account].every(x=>typeof x==='string'&&x.length>0&&x.length<=256&&!/[\x00-\x1f]/.test(x))
      || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new TypeError('Invalid secret store configuration')
    Object.assign(this,{service,account,platform,spawnImpl,accessImpl,timeoutMs})
  }
  async available() {
    if (this.platform !== 'linux') return false
    try { await this.accessImpl('/usr/bin/secret-tool',constants.X_OK); return true } catch { return false }
  }
  command(action,value) {
    if (action==='store'&&!valid(value)) return Promise.reject(unavailable())
    const args=[action,...(action==='store'?['--label=Chimera Google client intake']:[]),'service',this.service,'account',this.account]
    return new Promise((resolve,reject)=>{
      let child, timer, settled=false, output='', outputBytes=0, diagnostic=false
      const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(unavailable()):resolve(result)}
      const stop=()=>{finish(true);child?.kill('SIGKILL')}
      try { child=this.spawnImpl('/usr/bin/secret-tool',args,{stdio:['pipe','pipe','pipe']}) }
      catch { finish(true);return }
      timer=setTimeout(stop,this.timeoutMs)
      child.on('error',()=>finish(true))
      child.stdout.on('data',chunk=>{outputBytes+=chunk.length;if(outputBytes>65536)stop();else output+=chunk})
      child.stderr.on('data',()=>{diagnostic=true})
      child.stdin.on('error',()=>finish(true))
      child.on('close',code=>{
        if(settled)return
        if(code===1&&!diagnostic&&outputBytes===0&&action!=='store'){finish(false,null);return}
        if(code!==0||diagnostic){finish(true);return}
        if(action!=='lookup'){finish(false,null);return}
        try {const result=JSON.parse(output);finish(!valid(result),result)} catch {finish(true)}
      })
      child.stdin.end(action==='store'?JSON.stringify(value):'')
    })
  }
  get(){return this.command('lookup')}
  set(value){return this.command('store',value)}
  delete(){return this.command('clear')}
}
