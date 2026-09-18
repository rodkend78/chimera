import { constants } from 'node:fs'
import { mkdir, lstat, open, readdir, rename } from 'node:fs/promises'
import { resolve, join, parse } from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { canonicalJson, sha256 } from '../canonical.mjs'
import { signAction, verifyPayload, fingerprint } from '../identity.mjs'
import { verifyRjAwsRequest, verifyRjAwsReconciliation, verifyRjAwsFacts, sanitizeRjAwsResult, normalizeRjAwsSecurity, RJ_RECEIPT_LIMIT, exactFields } from './protocol.mjs'

const owners = new Set()
const unavailable = () => new Error('RJ_STATE_UNAVAILABLE')
const safeMode = stat => stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value

function validateRecord(record, identity, security) {
  try {
    const complete = Object.hasOwn(record, 'receipt')
    if (!exactFields(record, complete ? ['facts', 'acceptedAt', 'receipt'] : ['facts', 'acceptedAt']) || !timestamp(record.acceptedAt)) throw unavailable()
    verifyRjAwsFacts(record.facts, { target: security.target })
    if (!complete) return
    const envelope = record.receipt
    if (!exactFields(envelope, ['agentPublicKey', 'payload', 'signature']) ||
      !exactFields(envelope.payload, ['schema', 'requestId', 'taskId', 'agentId', 'requestHash', 'operation', 'target', 'workerId', 'outcome', 'acceptedAt', 'completedAt', 'result']) ||
      !verifyPayload(envelope.payload, envelope.signature, identity.publicKey) ||
      fingerprint(envelope.agentPublicKey) !== fingerprint(identity.publicKey)) throw unavailable()
    const payload = envelope.payload
    if (payload.schema !== 'chimera.rj-aws.receipt.v1' || payload.workerId !== 'rj-aws-worker' ||
      payload.acceptedAt !== record.acceptedAt || !timestamp(payload.completedAt) || Date.parse(payload.completedAt) < Date.parse(record.acceptedAt)) throw unavailable()
    for (const field of ['requestId', 'taskId', 'agentId', 'requestHash', 'operation', 'target']) {
      if (canonicalJson(payload[field]) !== canonicalJson(record.facts[field])) throw unavailable()
    }
    const expectedResult = payload.outcome === 'succeeded' ? sanitizeRjAwsResult(payload.operation, payload.result, security) :
      payload.outcome === 'failed' ? { code: 'RJ_AWS_UNAVAILABLE' } : payload.outcome === 'uncertain' ? {} : null
    if (expectedResult === null || canonicalJson(payload.result) !== canonicalJson(expectedResult)) throw unavailable()
  } catch { throw unavailable() }
}

// Check every ancestor for symlinks; shared system ancestors may be public but never replace the final owner-only directory.
export async function checkPath(path, { directory = false, writable = false } = {}) {
  const absolute = resolve(path)
  let cursor = parse(absolute).root
  for (const part of absolute.slice(cursor.length).split('/').filter(Boolean)) {
    cursor = join(cursor, part)
    const s = await lstat(cursor)
    if (s.isSymbolicLink()) throw unavailable()
  }
  const stat = await lstat(absolute)
  if (!safeMode(stat) || (directory ? !stat.isDirectory() : !stat.isFile()) || (writable && (stat.mode & 0o200) === 0)) throw unavailable()
  return stat
}

export async function readOwnerFile(path, limit = RJ_RECEIPT_LIMIT) {
  await checkPath(path)
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || !safeMode(stat) || stat.size > limit) throw unavailable()
    const bytes = Buffer.alloc(limit + 1)
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
    if (bytesRead > limit) throw unavailable()
    return bytes.subarray(0, bytesRead).toString('utf8')
  } finally { await file.close() }
}

async function linuxLock(stateDir) {
  const lockPath = join(stateDir, 'worker.lock')
  const fd = await open(lockPath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
  let child
  try {
    if (!safeMode(await fd.stat())) throw unavailable()
    child = spawn('/usr/bin/flock', ['--nonblock', '--conflict-exit-code', '75', '/proc/self/fd/3', '/bin/cat'], {
      stdio: ['pipe', 'pipe', 'ignore', fd.fd], env: { PATH: '/usr/bin:/bin', LANG: 'C' },
    })
    await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(unavailable()), 5000)
      const finish = fn => value => { clearTimeout(timer); fn(value) }
      child.once('error', finish(() => rej(unavailable())))
      child.once('exit', finish(code => rej(new Error(code === 75 ? 'RJ_WORKER_BUSY' : 'RJ_STATE_UNAVAILABLE'))))
      child.stdout.once('data', finish(data => data.toString() === 'owned\n' ? res() : rej(unavailable())))
      child.stdin.on('error', () => {})
      child.stdin.write('owned\n')
    })
    let released = false
    return {
      alive: () => !released && child.exitCode === null && child.signalCode === null,
      async close() { if (released) return; released = true; child.stdin.end(); await new Promise(res => { if (child.exitCode !== null || child.signalCode !== null) res(); else child.once('exit', res) }); await fd.close() },
    }
  } catch (e) { child?.kill(); await fd.close(); throw e }
}

export class RjAwsWorker {
  static async open(options) {
    const worker = new RjAwsWorker()
    let security
    try { security = normalizeRjAwsSecurity({ target: options?.target, roleArn: options?.roleArn, assumedRolePrefix: options?.assumedRolePrefix }) } catch { throw unavailable() }
    worker.stateDir = resolve(options.stateDir)
    worker.options = options
    worker.security = security
    worker.queue = Promise.resolve()
    if (owners.has(worker.stateDir)) throw new Error('RJ_WORKER_BUSY')
    owners.add(worker.stateDir)
    try {
      await mkdir(worker.stateDir, { mode: 0o700, recursive: true })
      await checkPath(worker.stateDir, { directory: true, writable: true })
      // The production CLI is Linux-only. macOS local unit tests use process-local exclusion.
      if (process.platform === 'linux') worker.lock = await linuxLock(worker.stateDir)
      worker.records = new Map()
      for (const name of await readdir(worker.stateDir)) {
        if (name === 'worker.lock' || /^[a-f0-9]{64}\.[a-f0-9-]+\.tmp$/.test(name)) continue
        if (!/^[a-f0-9]{64}\.json$/.test(name)) throw unavailable()
        const record = JSON.parse(await readOwnerFile(join(worker.stateDir, name)))
        validateRecord(record, options.identity, security)
        if (name !== sha256(record.facts.requestId) + '.json') throw unavailable()
        worker.records.set(record.facts.requestId, record)
      }
      return worker
    } catch (e) {
      await worker.lock?.close()
      owners.delete(worker.stateDir)
      throw e.message === 'RJ_WORKER_BUSY' ? e : unavailable()
    }
  }
  handle(request) {
    // Snapshot before queuing so caller mutation cannot change the admitted operation.
    let snapshot
    try { snapshot = JSON.parse(canonicalJson(request)) } catch { return Promise.reject(new Error('RJ_REQUEST_INVALID')) }
    const task = this.queue.then(() => this.run(snapshot))
    this.queue = task.catch(() => {})
    return task
  }
  async persist(record) {
    try {
      validateRecord(record, this.options.identity, this.security)
      if (this.lock && !this.lock.alive()) throw unavailable()
      await checkPath(this.stateDir, { directory: true, writable: true })
      const name = sha256(record.facts.requestId)
      const temp = join(this.stateDir, `${name}.${randomUUID()}.tmp`)
      const bytes = canonicalJson(record)
      if (Buffer.byteLength(bytes) > RJ_RECEIPT_LIMIT) throw unavailable()
      const file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
      await rename(temp, join(this.stateDir, name + '.json'))
      const dir = await open(this.stateDir, constants.O_RDONLY)
      try { await dir.sync() } finally { await dir.close() }
    } catch { this.poisoned = true; throw unavailable() }
  }
  async run(request) {
    if (this.closed || this.poisoned || (this.lock && !this.lock.alive())) throw unavailable()
    const time = this.options.now ?? Date.now
    const lookup = request.schema === 'chimera.rj-aws.reconcile.v1'
    const facts = (lookup ? verifyRjAwsReconciliation : verifyRjAwsRequest)(request, { humanKeys: this.options.humanKeys, now: time(), target: this.security.target })
    let record = this.records.get(facts.requestId)
    if (record) {
      validateRecord(record, this.options.identity, this.security)
      // Fresh authority may renew expiry. Every other admitted fact must still match the original request.
      for (const field of Object.keys(facts)) {
        if ((lookup || field !== 'expiresAt') && canonicalJson(record.facts[field]) !== canonicalJson(facts[field])) throw new Error('RJ_REQUEST_CONFLICT')
      }
      if (record.receipt) return structuredClone(record.receipt)
      record.receipt = this.receipt(record, 'uncertain', {}, time())
      await this.persist(record)
      return structuredClone(record.receipt)
    }
    if (lookup) throw new Error('RJ_REQUEST_NOT_ACCEPTED')
    record = { facts, acceptedAt: new Date(time()).toISOString() }
    await this.persist(record)
    this.records.set(facts.requestId, record)
    let outcome = 'succeeded', result = {}
    try {
      // Acceptance fsync can take time; expiry is checked again at actual dispatch.
      verifyRjAwsRequest(request, { humanKeys: this.options.humanKeys, now: time(), target: this.security.target })
      result = sanitizeRjAwsResult(facts.operation, await this.options.execute(facts.operation, { requestId: facts.requestId }), this.security)
    } catch { outcome = 'failed'; result = { code: 'RJ_AWS_UNAVAILABLE' } }
    record.receipt = this.receipt(record, outcome, result, time())
    await this.persist(record)
    return structuredClone(record.receipt)
  }
  receipt(record, outcome, result, now) {
    if (!Number.isFinite(now) || now < Date.parse(record.acceptedAt)) throw unavailable()
    const { requestId, taskId, agentId, requestHash, operation, target } = record.facts
    const receipt = signAction({ schema: 'chimera.rj-aws.receipt.v1', requestId, taskId, agentId, requestHash,
      operation, target, workerId: 'rj-aws-worker', outcome, acceptedAt: record.acceptedAt, completedAt: new Date(now).toISOString(), result }, this.options.identity)
    if (Buffer.byteLength(canonicalJson(receipt)) > RJ_RECEIPT_LIMIT) throw unavailable()
    return receipt
  }
  async close() {
    if (this.closed) return
    this.closed = true
    await this.queue
    await this.lock?.close()
    owners.delete(this.stateDir)
  }
}
