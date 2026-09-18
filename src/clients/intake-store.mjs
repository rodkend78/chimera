import { constants, lstatSync, mkdirSync, openSync, closeSync, fstatSync, readSync, writeFileSync, fsyncSync, renameSync, unlinkSync } from 'node:fs'
import { resolve, parse, join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export const intakeError = code => Object.assign(new Error(`CLIENT_INTAKE_${code}`), { code: `CLIENT_INTAKE_${code}` })
export const credentialLike = value => /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:password|passwd|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret)\s*[:=]\s*\S+|\b(?:sk-[\w-]{20,}|gh[pousr]_[\w]{20,}|github_pat_[\w]{20,}|AKIA[A-Z0-9]{16})\b|\bBearer\s+\S+/i.test(value)
export function safeDirectory(directory) {
  let current = parse(directory).root
  for (const part of directory.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, part)
    if (lstatSync(current).isSymbolicLink() || !lstatSync(current).isDirectory()) throw intakeError('CORRUPT')
  }
}
export function privateJson(path, limit = 8 * 1024 * 1024) {
  safeDirectory(dirname(path))
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.nlink !== 1 || info.size > limit || (info.mode & 0o077) || info.uid !== process.getuid()) throw intakeError('CORRUPT')
    // A fixed-size buffer prevents a concurrently growing file exceeding the budget.
    const buffer = Buffer.alloc(limit + 1)
    let size = 0, count
    while (size <= limit && (count = readSync(fd, buffer, size, limit + 1 - size, null)) > 0) size += count
    if (size > limit) throw intakeError('CORRUPT')
    return JSON.parse(buffer.subarray(0, size).toString('utf8'))
  } finally { closeSync(fd) }
}
const empty = () => ({ schemaVersion: 1, clients: [], queue: [], requests: {}, sources: {}, sync: { running: false, lastAttemptAt: null, lastSuccessAt: null, error: null }, recovery: null })
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value, max = 32000) => typeof value === 'string' && value.length <= max && !value.includes('\0')
const identifier = value => text(value, 128) && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)
function validate(data) {
  if (data?.schemaVersion !== 1 || !Array.isArray(data.clients) || !Array.isArray(data.queue) || !record(data.requests) || !record(data.sources) || !record(data.sync) || data.clients.length > 10000 || data.queue.length > 10000) throw intakeError('CORRUPT')
  const ids = new Set(), queues = new Set()
  for (const c of data.clients) {
    if (!record(c) || !identifier(c.id) || ids.has(c.id) || !text(c.name, 200) || !c.name || !text(c.email, 254) || !text(c.summary) || !Array.isArray(c.services) || c.services.length > 20 || c.services.some(s => !text(s, 200))) throw intakeError('CORRUPT')
    ids.add(c.id)
  }
  for (const q of data.queue) {
    if (!record(q) || !identifier(q.id) || queues.has(q.id) || !ids.has(q.clientId) || !text(q.clientName, 200) || !['ready', 'review_required', 'handed_off'].includes(q.status) || !Array.isArray(q.issues) || q.issues.some(x => !text(x, 100)) || !record(q.brief) || q.brief.clientId !== q.clientId || !Array.isArray(q.evidence) || !Array.isArray(q.references) || !/^intake-[a-f0-9]{40}$/.test(q.taskId)) throw intakeError('CORRUPT')
    queues.add(q.id)
  }
  for (const [key, request] of Object.entries(data.requests)) if (!/^[a-f0-9]{64}$/.test(key) || !record(request) || !ids.has(request.id) || !/^[a-f0-9]{64}$/.test(request.hash)) throw intakeError('CORRUPT')
  for (const [key, source] of Object.entries(data.sources)) if (!/^[a-f0-9]{64}$/.test(key) || !record(source) || !queues.has(source.queueId) || !Array.isArray(source.versions) || source.versions.some(v => !text(v, 256))) throw intakeError('CORRUPT')
  for (const field of ['lastAttemptAt', 'lastSuccessAt']) if (data.sync[field] !== null && (!text(data.sync[field], 40) || !Number.isFinite(Date.parse(data.sync[field])))) throw intakeError('CORRUPT')
  if (data.sync.error !== null && !/^CLIENT_INTAKE_[A-Z_]+$/.test(data.sync.error)) throw intakeError('CORRUPT')
  if (data.notes !== undefined) {
    if (!Array.isArray(data.notes)) throw intakeError('CORRUPT')
    for (const note of data.notes) if (!record(note) || !identifier(note.id) || !ids.has(note.clientId) || !text(note.title, 160) || !text(note.body) || !['note', 'email', 'text', 'call', 'form'].includes(note.sourceType) || note.status !== 'unreviewed' || !Number.isFinite(Date.parse(note.createdAt))) throw intakeError('CORRUPT')
  }
}
function acquireLock(store) {
  const create = () => { const fd = openSync(store.lock, 'wx', 0o600); try { writeFileSync(fd, JSON.stringify({ pid: process.pid, token: store.token })); fsyncSync(fd) } finally { closeSync(fd) } }
  try { create(); return } catch (error) { if (error.code !== 'EEXIST') throw intakeError('CORRUPT') }
  const guard = join(store.directory, 'recovery.lock')
  let fd
  try {
    fd = openSync(guard, 'wx', 0o600)
    const owner = privateJson(store.lock, 1024)
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw intakeError('LOCKED')
    try { process.kill(owner.pid, 0); throw intakeError('LOCKED') } catch (error) { if (error.code !== 'ESRCH') throw intakeError('LOCKED') }
    unlinkSync(store.lock)
    try { create() } catch { throw intakeError('LOCKED') }
  } catch (error) { throw intakeError(error.code === 'CLIENT_INTAKE_CORRUPT' ? 'CORRUPT' : 'LOCKED') }
  finally { if (fd !== undefined) { closeSync(fd); unlinkSync(guard) } }
}
export class IntakeStore {
  static async open({ directory }) {
    const store = new IntakeStore(); store.directory = resolve(directory)
    // Validate existing ancestors before recursively creating a private leaf.
    let ancestor = store.directory
    while (true) { try { safeDirectory(ancestor); break } catch (error) { if (error.code !== 'ENOENT') throw intakeError('CORRUPT'); ancestor = dirname(ancestor) } }
    mkdirSync(store.directory, { recursive: true, mode: 0o700 }); safeDirectory(store.directory)
    const info = lstatSync(store.directory)
    if ((info.mode & 0o077) || info.uid !== process.getuid()) throw intakeError('CORRUPT')
    store.lock = join(store.directory, 'writer.lock'); store.token = randomUUID()
    acquireLock(store)
    try {
      try { store.data = privateJson(join(store.directory, 'intake.json')) } catch (error) { if (error.code !== 'ENOENT') throw error; store.data = empty() }
      validate(store.data)
      store.data.sync.running = false
      return store
    } catch { await store.close(); throw intakeError('CORRUPT') }
  }
  read() { if (this.closed) throw intakeError('CLOSED'); return structuredClone(this.data) }
  update(change) {
    if (this.closed) throw intakeError('CLOSED')
    const next = this.read(); const result = change(next); validate(next); const bytes = JSON.stringify(next)
    if (Buffer.byteLength(bytes) > 8 * 1024 * 1024) throw intakeError('LIMIT')
    safeDirectory(this.directory)
    const path = join(this.directory, `.intake-${randomUUID()}.tmp`)
    try {
      const fd = openSync(path, 'wx', 0o600)
      try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
      renameSync(path, join(this.directory, 'intake.json'))
      const dir = openSync(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try { fsyncSync(dir) } finally { closeSync(dir) }
      this.data = next; return structuredClone(result)
    } finally { try { unlinkSync(path) } catch {} }
  }
  async close() {
    if (this.closed) return
    this.closed = true
    try { if (privateJson(this.lock, 1024).token === this.token) unlinkSync(this.lock) } catch {}
  }
}
