import { randomUUID } from 'node:crypto'
import { canonicalJson, sha256 } from '../canonical.mjs'

const GENESIS_HASH = '0'.repeat(64)
const OPEN_TOKEN = Symbol('chimera-durable-audit-open')

function boundedString(value, maximum = 256) {
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

function validateStore(store) {
  return store
    && typeof store.head === 'function'
    && typeof store.appendIfHead === 'function'
    && typeof store.receipt === 'function'
    && typeof store.entries === 'function'
}

function validateRequestId(value) {
  if (!boundedString(value, 128) || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new TypeError('audit request id is invalid')
  }
}

export class DurableAuditLog {
  #writes = Promise.resolve()
  #head
  #uncertain = false

  constructor({ store, streamId, head }, token) {
    if (token !== OPEN_TOKEN) throw new TypeError('use DurableAuditLog.open()')
    this.store = store
    this.streamId = streamId
    this.#head = head
  }

  static async open({ store, streamId }) {
    if (!validateStore(store)) throw new TypeError('durable audit requires an audit store')
    if (!boundedString(streamId) || !/^[A-Za-z0-9._:/-]+$/.test(streamId)) {
      throw new TypeError('durable audit stream id is invalid')
    }
    const head = await store.head(streamId)
    if (!validHead(head)) throw new Error('AUDIT_HEAD_INVALID')
    return new DurableAuditLog({ store, streamId, head }, OPEN_TOKEN)
  }

  append(fact, { requestId = randomUUID() } = {}) {
    validateRequestId(requestId)
    const operation = async () => {
      if (this.#uncertain) {
        const error = new Error('AUDIT_WRITER_UNCERTAIN')
        error.code = 'AUDIT_WRITER_UNCERTAIN'
        throw error
      }

      const durableFact = JSON.parse(canonicalJson(fact))
      const receipt = await this.store.receipt(this.streamId, requestId)
      if (receipt) {
        if (canonicalJson(receipt.fact) !== canonicalJson(durableFact)) {
          const error = new Error('AUDIT_REQUEST_ID_REUSE')
          error.code = 'AUDIT_REQUEST_ID_REUSE'
          throw error
        }
        return structuredClone(receipt)
      }
      const unsigned = {
        seq: this.#head.nextSeq,
        prevHash: this.#head.headHash,
        fact: durableFact,
      }
      const entry = Object.freeze({ ...unsigned, entryHash: sha256(unsigned) })
      const expected = { ...this.#head }
      try {
        await this.store.appendIfHead(this.streamId, entry, expected, { requestId })
      } catch (error) {
        this.#uncertain = true
        throw error
      }
      this.#head = { nextSeq: entry.seq + 1, headHash: entry.entryHash }
      return structuredClone(entry)
    }

    const result = this.#writes.then(operation, operation)
    this.#writes = result.catch(() => {})
    return result
  }

  async entries() {
    await this.#writes
    return this.store.entries(this.streamId)
  }

  head() {
    return structuredClone(this.#head)
  }
}
