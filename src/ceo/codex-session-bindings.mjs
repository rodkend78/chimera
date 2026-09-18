import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { sha256 } from '../canonical.mjs'

const OWNERS = new Map()
const SCHEMA = 'chimera.codex-session-journal.v1'
const MAX_JOURNAL_BYTES = 64 * 1024 * 1024
const KEY = /^[a-f0-9]{64}$/
const THREAD = /^[a-zA-Z0-9_-]{1,128}$/

function error(code) { return Object.assign(new Error(code), { code }) }

// A binding is context continuity, never authority to execute or replay a task.
export class CodexSessionBindings {
  #records = new Map()
  #writes = Promise.resolve()
  #handle = null
  #path = null
  #closed = false
  #faulted = false
  #sequence = 0
  #head = '0'.repeat(64)
  #bytes = 0

  static async open({ filePath }) {
    if (typeof filePath !== 'string' || !filePath || filePath.length > 4096) throw error('CODEX_SESSION_PATH_INVALID')
    const store = new CodexSessionBindings()
    const path = resolve(filePath)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    store.#path = join(await realpath(dirname(path)), basename(path))
    if (OWNERS.has(store.#path)) throw error('CODEX_SESSION_STORE_ALREADY_OPEN')
    OWNERS.set(store.#path, store)
    try {
      store.#handle = await open(store.#path, constants.O_CREAT | constants.O_APPEND | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
      const info = await store.#handle.stat()
      if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0) throw error('CODEX_SESSION_FILE_UNSAFE')
      if (info.size > MAX_JOURNAL_BYTES) throw error('CODEX_SESSION_JOURNAL_INVALID')
      const content = await store.#handle.readFile('utf8')
      store.#bytes = Buffer.byteLength(content)
      if (content && !content.endsWith('\n')) throw error('CODEX_SESSION_JOURNAL_INVALID')
      try {
        for (const line of content.split('\n').slice(0, -1)) store.#restore(JSON.parse(line))
      } catch { throw error('CODEX_SESSION_JOURNAL_INVALID') }
      for (const [key, record] of store.#records) {
        if (record.state === 'running') store.#records.set(key, { ...record, state: 'unknown' })
      }
      // Persist the newly created directory entry before any native dispatch.
      const directory = await open(dirname(store.#path), 'r')
      try { await directory.sync() } finally { await directory.close() }
      return store
    } catch (failure) {
      await store.close()
      if (failure?.code === 'ELOOP') throw error('CODEX_SESSION_FILE_UNSAFE')
      throw failure
    }
  }

  async close() {
    if (this.#closed) return
    this.#closed = true
    await this.#writes
    try { await this.#handle?.close() } finally {
      this.#handle = null
      if (OWNERS.get(this.#path) === this) OWNERS.delete(this.#path)
    }
  }

  #restore(entry) {
    const { hash, ...unsigned } = entry
    const record = entry.record
    if (entry.schema !== SCHEMA || entry.seq !== this.#sequence || entry.previous !== this.#head
      || hash !== sha256(unsigned) || !record || !KEY.test(record.key ?? '')
      || !/^[a-f0-9-]{36}$/.test(record.attemptId ?? '')
      || !['running', 'ready', 'unknown'].includes(record.state)
      || !(record.threadId === null || (typeof record.threadId === 'string' && THREAD.test(record.threadId)))
      || (record.state === 'ready' && !record.threadId)) throw error('CODEX_SESSION_JOURNAL_INVALID')
    const previous = this.#records.get(record.key)
    if (record.state === 'running') {
      if (previous && (previous.state !== 'ready' || previous.threadId !== record.threadId || previous.attemptId === record.attemptId)) throw error('CODEX_SESSION_JOURNAL_INVALID')
      if (!previous && record.threadId !== null) throw error('CODEX_SESSION_JOURNAL_INVALID')
    } else if (!previous || previous.state !== 'running' || previous.attemptId !== record.attemptId
      || (previous.threadId !== null && previous.threadId !== record.threadId)) throw error('CODEX_SESSION_JOURNAL_INVALID')
    this.#records.set(record.key, record)
    if (this.#records.size > 10_000) throw error('CODEX_SESSION_JOURNAL_INVALID')
    this.#head = hash
    this.#sequence++
  }

  async #record(record) {
    if (this.#handle) {
      const unsigned = { schema: SCHEMA, seq: this.#sequence, previous: this.#head, record }
      const hash = sha256(unsigned)
      const encoded = `${JSON.stringify({ ...unsigned, hash })}\n`
      try {
        if (this.#bytes + Buffer.byteLength(encoded) > MAX_JOURNAL_BYTES) throw error('CODEX_SESSION_CAPACITY')
        await this.#handle.writeFile(encoded)
        await this.#handle.sync()
      } catch (failure) {
        // A partial append cannot safely be retried by this writer.
        this.#faulted = true
        throw failure
      }
      this.#bytes += Buffer.byteLength(encoded)
      this.#head = hash
      this.#sequence++
    }
    this.#records.set(record.key, record)
  }

  #mutate(operation) {
    const result = this.#writes.then(() => {
      if (this.#closed) throw error('CODEX_SESSION_STORE_CLOSED')
      if (this.#faulted) throw error('CODEX_SESSION_STORE_FAULTED')
      return operation()
    })
    this.#writes = result.catch(() => {})
    return result
  }

  begin(key) {
    return this.#mutate(async () => {
      if (typeof key !== 'string' || !KEY.test(key)) throw error('CODEX_SESSION_KEY_INVALID')
      const previous = this.#records.get(key)
      if (previous?.state === 'running') throw error('CODEX_SESSION_BUSY')
      if (previous?.state === 'unknown') throw error('CODEX_SESSION_OUTCOME_UNKNOWN')
      if (!previous && this.#records.size >= 10_000) throw error('CODEX_SESSION_CAPACITY')
      const record = { key, attemptId: randomUUID(), state: 'running', threadId: previous?.threadId ?? null }
      await this.#record(record)
      return structuredClone(record)
    })
  }

  complete(lease, threadId) {
    return this.#mutate(async () => {
      const current = this.#assertLease(lease)
      if (typeof threadId !== 'string' || !THREAD.test(threadId)
        || (current.threadId && current.threadId !== threadId)) throw error('CODEX_SESSION_THREAD_INVALID')
      await this.#record({ ...current, state: 'ready', threadId })
    })
  }

  ambiguous(lease) {
    return this.#mutate(async () => {
      const current = this.#assertLease(lease)
      await this.#record({ ...current, state: 'unknown' })
    })
  }

  #assertLease(lease) {
    const current = this.#records.get(lease?.key)
    if (!current || current.state !== 'running' || current.attemptId !== lease.attemptId) throw error('CODEX_SESSION_LEASE_INVALID')
    return current
  }
}
