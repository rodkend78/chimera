import { randomUUID } from 'node:crypto'
import { canonicalJson, sha256 } from '../canonical.mjs'
import { verifyAuditEntries } from '../audit-log.mjs'

const GENESIS_HASH = '0'.repeat(64)
const OPEN_TOKEN = Symbol('chimera-remote-audit-open')

function bounded(value, maximum = 256) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function validHead(head) {
  return head
    && Number.isSafeInteger(head.nextSeq)
    && head.nextSeq >= 0
    && typeof head.headHash === 'string'
    && /^[a-f0-9]{64}$/.test(head.headHash)
    && ((head.nextSeq === 0) === (head.headHash === GENESIS_HASH))
}

function invalid(code) {
  return Object.assign(new Error(code), { code })
}

function validateEntry(entry, expected, fact) {
  if (!entry
    || entry.seq !== expected.nextSeq
    || entry.prevHash !== expected.headHash
    || canonicalJson(entry.fact) !== canonicalJson(fact)
    || entry.entryHash !== sha256({ seq: entry.seq, prevHash: entry.prevHash, fact: entry.fact })) {
    throw invalid('AUDIT_REMOTE_ACK_INVALID')
  }
}

export class RemoteAuditLog {
  #entries
  #head
  #uncertain = false
  #pending = 0
  #tail = Promise.resolve()
  #closed = false

  constructor({ client, streamId, entries, head }, token) {
    if (token !== OPEN_TOKEN) throw new TypeError('use RemoteAuditLog.open()')
    this.client = client
    this.streamId = streamId
    this.#entries = entries
    this.#head = head
  }

  static async open({ client, streamId } = {}) {
    if (!client || typeof client.snapshot !== 'function'
      || (typeof client.appendSync !== 'function' && typeof client.appendAsync !== 'function')) {
      throw new TypeError('REMOTE_AUDIT_CLIENT_INVALID')
    }
    if (!bounded(streamId) || !/^[A-Za-z0-9._:/-]+$/.test(streamId)) {
      throw new TypeError('REMOTE_AUDIT_STREAM_INVALID')
    }
    const snapshot = await client.snapshot(streamId)
    const entries = structuredClone(snapshot?.entries ?? [])
    const head = structuredClone(snapshot?.head)
    const verification = verifyAuditEntries(entries)
    const verifiedHead = entries.at(-1)?.entryHash ?? GENESIS_HASH
    if (!validHead(head)
      || !verification.valid
      || head.nextSeq !== entries.length
      || head.headHash !== verifiedHead) {
      throw invalid('AUDIT_REMOTE_SNAPSHOT_INVALID')
    }
    return new RemoteAuditLog({ client, streamId, entries, head }, OPEN_TOKEN)
  }

  append(fact, { requestId = randomUUID() } = {}) {
    if (this.#closed) throw invalid('AUDIT_WRITER_CLOSED')
    if (this.#uncertain) throw invalid('AUDIT_WRITER_UNCERTAIN')
    if (this.#pending) throw invalid('AUDIT_WRITER_ASYNC_PENDING')
    if (typeof this.client.appendSync !== 'function') throw invalid('AUDIT_REMOTE_ASYNC_REQUIRED')
    const durableFact = this.#prepare(fact, requestId)
    const expected = structuredClone(this.#head)
    try {
      const accepted = this.client.appendSync({
        streamId: this.streamId,
        fact: durableFact,
        requestId,
        expected,
      })
      if (accepted && typeof accepted.then === 'function') throw invalid('AUDIT_REMOTE_CLIENT_ASYNC')
      return this.#accept(accepted, expected, durableFact)
    } catch (error) {
      this.#uncertain = true
      throw error
    }
  }

  async appendAsync(fact, { requestId = randomUUID() } = {}) {
    if (this.#closed) throw invalid('AUDIT_WRITER_CLOSED')
    if (this.#uncertain) throw invalid('AUDIT_WRITER_UNCERTAIN')
    if (typeof this.client.appendAsync !== 'function') throw invalid('AUDIT_REMOTE_ASYNC_UNSUPPORTED')
    const durableFact = this.#prepare(fact, requestId)
    this.#pending += 1
    const operation = this.#tail.then(async () => {
      if (this.#uncertain) throw invalid('AUDIT_WRITER_UNCERTAIN')
      // Derive the expected head only after the preceding append is acknowledged.
      const expected = structuredClone(this.#head)
      try {
        const accepted = await this.client.appendAsync({ streamId: this.streamId, fact: durableFact, requestId, expected })
        return this.#accept(accepted, expected, durableFact)
      } catch (error) {
        this.#uncertain = true
        throw error
      }
    })
    this.#tail = operation.catch(() => {})
    try {
      return await operation
    } finally {
      this.#pending -= 1
    }
  }

  #prepare(fact, requestId) {
    if (!bounded(requestId, 128) || !/^[A-Za-z0-9._:-]+$/.test(requestId)) {
      throw new TypeError('AUDIT_REQUEST_ID_INVALID')
    }
    let durableFact
    try {
      durableFact = JSON.parse(canonicalJson(fact))
    } catch {
      throw new TypeError('AUDIT_FACT_INVALID')
    }
    return durableFact
  }

  #accept(accepted, expected, durableFact) {
    validateEntry(accepted, expected, durableFact)
    const durableEntry = structuredClone(accepted)
    this.#entries.push(durableEntry)
    this.#head = { nextSeq: durableEntry.seq + 1, headHash: durableEntry.entryHash }
    return structuredClone(durableEntry)
  }

  entries() {
    return structuredClone(this.#entries)
  }

  head() {
    return structuredClone(this.#head)
  }

  recent(limit = 50) {
    return structuredClone(this.#entries.slice(-Math.max(1, Math.min(500, limit))))
  }

  summary() {
    return { valid: !this.#uncertain, entries: this.#entries.length, head: this.#head.headHash,
      verification: 'verified-snapshot-and-acknowledgements', ...(this.#uncertain ? { reason: 'AUDIT_WRITER_UNCERTAIN' } : {}) }
  }

  verify(entries = this.#entries) {
    return verifyAuditEntries(entries)
  }

  async close() {
    this.#closed = true
    await this.#tail
    await this.client.close?.()
  }
}
