import { spawn } from 'node:child_process'
import { resolve, sep } from 'node:path'

const PROFILES = new Set(['ace', 'sam', 'iris', 'ash', 'ada', 'genie', 'inboxarchitect', 'paul-blart'])
const PROFILE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const TOKEN = /^[A-Za-z0-9._:-]{1,256}$/
const ROOT = /^\//
const MAX_OUTPUT = 256 * 1024

function coded(code, cause = null) {
  const error = new Error(code, cause ? { cause } : undefined)
  error.code = code
  return error
}

function bounded(value, max = 16_384) {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

function validSshTarget(value) {
  if (!bounded(value, 512) || value.startsWith('-') || /\s/.test(value)) return false
  const separator = value.indexOf('@')
  if (separator !== -1 && separator !== value.lastIndexOf('@')) return false
  const user = separator === -1 ? null : value.slice(0, separator)
  const host = separator === -1 ? value : value.slice(separator + 1)
  if (user !== null && !/^[A-Za-z0-9._-]+$/.test(user)) return false
  if (/^\[.*\]$/.test(host)) return /^\[[A-Fa-f0-9:.%~-]+\]$/.test(host)
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,253}$/.test(host)
}

function inside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${sep}`)
}

function validateResponse(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.protocol !== 'chimera-team-run.v1'
    || value.profileId !== expected.profileId
    || value.taskId !== expected.taskId
    || value.requestId !== expected.requestId
    || !TOKEN.test(value.runId ?? '')
    || !['succeeded', 'failed', 'cancelled', 'blocked'].includes(value.status)
    || !bounded(value.summary, 4096)) throw coded('REMOTE_TEAM_RESPONSE_MISMATCH')
  if (value.result !== undefined && (value.result === null || typeof value.result !== 'object' || Array.isArray(value.result))) {
    throw coded('REMOTE_TEAM_RESPONSE_MISMATCH')
  }
  return structuredClone(value)
}

async function defaultRun(command, input, { timeoutMs, signal } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command[0], command.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    const stdout = []; const stderr = []; let bytes = 0; let settled = false
    const finishError = (error) => { if (settled) return; settled = true; clearTimeout(timer); rejectPromise(error) }
    const finish = (value) => { if (settled) return; settled = true; clearTimeout(timer); resolvePromise(value) }
    const stop = () => { try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') } }
    const timer = setTimeout(() => { stop(); finishError(coded('REMOTE_TEAM_TIMEOUT')) }, timeoutMs)
    const onAbort = () => { stop(); finishError(coded('REMOTE_TEAM_CANCELLED')) }
    signal?.addEventListener('abort', onAbort, { once: true })
    const collect = (target) => chunk => { bytes += chunk.length; if (bytes > MAX_OUTPUT) { stop(); finishError(coded('REMOTE_TEAM_OUTPUT_TOO_LARGE')) } else target.push(chunk) }
    child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr))
    child.on('error', error => finishError(coded('REMOTE_TEAM_RESPONSE_LOST', error)))
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (settled) return
      if (code !== 0) return finishError(coded('REMOTE_TEAM_RESPONSE_LOST'))
      try { finish(JSON.parse(Buffer.concat(stdout).toString('utf8'))) } catch (error) { finishError(coded('REMOTE_TEAM_RESPONSE_MISMATCH', error)) }
    })
    child.stdin.end(JSON.stringify(input))
  })
}

export class RemoteTeamTransport {
  constructor({
    target,
    port = 2223,
    identityFile,
    knownHostsFile,
    allowedWorkspaceRoot,
    run = defaultRun,
    timeoutMs = 900_000,
    profiles = PROFILES,
  } = {}) {
    if (!validSshTarget(target) || !Number.isInteger(port) || port < 1 || port > 65535
      || !bounded(identityFile, 4096) || !ROOT.test(identityFile)
      || !bounded(knownHostsFile, 4096) || !ROOT.test(knownHostsFile)
      || !bounded(allowedWorkspaceRoot, 4096) || !ROOT.test(allowedWorkspaceRoot)
      || typeof run !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 1_800_000) {
      throw coded('REMOTE_TEAM_CONFIG_INVALID')
    }
    this.target = target; this.port = port; this.identityFile = identityFile; this.knownHostsFile = knownHostsFile
    this.allowedWorkspaceRoot = resolve(allowedWorkspaceRoot); this.run = run; this.timeoutMs = timeoutMs
    this.profiles = new Set(profiles)
  }

  command(profileId, requestId) {
    return ['/usr/bin/ssh', '-F', '/dev/null', '-p', String(this.port), '-T',
      '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none',
      '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${this.knownHostsFile}`,
      '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'PasswordAuthentication=no',
      '-o', 'KbdInteractiveAuthentication=no', '-o', 'PreferredAuthentications=publickey',
      '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes', '-o', 'ConnectTimeout=8',
      '-i', this.identityFile, this.target, `chimera-team-v1 dispatch ${profileId} ${requestId}`]
  }

  async dispatch({ profileId, taskId, requestId, objective, acceptanceCriteria, workspaceRoot, signal } = {}) {
    if (!this.profiles.has(profileId) || !PROFILE_ID.test(profileId)) throw coded('REMOTE_TEAM_PROFILE_INVALID')
    if (!TOKEN.test(taskId ?? '') || !TOKEN.test(requestId ?? '') || !bounded(objective)
      || !Array.isArray(acceptanceCriteria) || acceptanceCriteria.length < 1 || acceptanceCriteria.length > 64
      || acceptanceCriteria.some(item => !bounded(item, 4096))) throw coded('REMOTE_TEAM_REQUEST_INVALID')
    if (!bounded(workspaceRoot, 4096) || !ROOT.test(workspaceRoot) || !inside(this.allowedWorkspaceRoot, resolve(workspaceRoot))) throw coded('REMOTE_TEAM_WORKSPACE_INVALID')
    const input = { protocol: 'chimera-team-run.v1', profileId, taskId, requestId, objective, acceptanceCriteria, workspaceRoot: resolve(workspaceRoot) }
    let raw
    try { raw = await this.run(this.command(profileId, requestId), input, { timeoutMs: this.timeoutMs, signal }) }
    catch (error) { throw error?.code ? error : coded('REMOTE_TEAM_RESPONSE_LOST', error) }
    return validateResponse(raw, input)
  }
}

export { PROFILES as REMOTE_TEAM_PROFILES }
