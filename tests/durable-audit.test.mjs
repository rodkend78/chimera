import assert from 'node:assert/strict'
import test from 'node:test'
import { DurableAuditLog } from '../src/audit/durable-log.mjs'
import { verifyAuditEntries } from '../src/audit-log.mjs'

const GENESIS_HASH = '0'.repeat(64)

class ConditionalAuditStore {
  constructor() {
    this.streams = new Map()
    this.receipts = new Map()
  }

  async head(streamId) {
    const entries = this.streams.get(streamId) ?? []
    const last = entries.at(-1)
    return last
      ? { nextSeq: last.seq + 1, headHash: last.entryHash }
      : { nextSeq: 0, headHash: GENESIS_HASH }
  }

  async appendIfHead(streamId, entry, expected, { requestId }) {
    await new Promise((resolve) => setImmediate(resolve))
    const actual = await this.head(streamId)
    if (actual.nextSeq !== expected.nextSeq || actual.headHash !== expected.headHash) {
      const error = new Error('AUDIT_APPEND_CONFLICT')
      error.code = 'AUDIT_APPEND_CONFLICT'
      throw error
    }
    const entries = this.streams.get(streamId) ?? []
    entries.push(structuredClone(entry))
    this.streams.set(streamId, entries)
    this.receipts.set(`${streamId}:${requestId}`, structuredClone(entry))
  }

  async entries(streamId) {
    return structuredClone(this.streams.get(streamId) ?? [])
  }

  async receipt(streamId, requestId) {
    return structuredClone(this.receipts.get(`${streamId}:${requestId}`) ?? null)
  }
}

test('durable audit serializes concurrent local appends into one valid chain', async () => {
  const store = new ConditionalAuditStore()
  const log = await DurableAuditLog.open({ store, streamId: 'pilot' })

  const entries = await Promise.all(
    Array.from({ length: 20 }, (_, index) => log.append({ kind: 'test.fact', index })),
  )

  assert.deepEqual(entries.map((entry) => entry.seq), Array.from({ length: 20 }, (_, index) => index))
  assert.deepEqual(verifyAuditEntries(await log.entries()), {
    valid: true,
    entries: 20,
    head: entries.at(-1).entryHash,
  })
})

test('two stale writers cannot claim the same durable sequence', async () => {
  const store = new ConditionalAuditStore()
  const first = await DurableAuditLog.open({ store, streamId: 'pilot' })
  const second = await DurableAuditLog.open({ store, streamId: 'pilot' })

  const outcomes = await Promise.allSettled([
    first.append({ kind: 'writer.first' }),
    second.append({ kind: 'writer.second' }),
  ])

  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1)
  const rejected = outcomes.find((outcome) => outcome.status === 'rejected')
  assert.equal(rejected.reason.code, 'AUDIT_APPEND_CONFLICT')
  assert.equal((await store.entries('pilot')).length, 1)
})

test('durable audit rejects invalid configuration and detects retained-entry tampering', async () => {
  await assert.rejects(DurableAuditLog.open({ store: {}, streamId: 'pilot' }), /audit store/i)
  const store = new ConditionalAuditStore()
  const log = await DurableAuditLog.open({ store, streamId: 'pilot' })
  await log.append({ kind: 'test.fact', value: 'original' })
  const entries = await log.entries()
  entries[0].fact.value = 'altered'

  assert.deepEqual(verifyAuditEntries(entries), {
    valid: false,
    index: 0,
    reason: 'ENTRY_HASH_MISMATCH',
  })
})

test('durable audit rejects a non-empty head that still claims the genesis hash', async () => {
  const store = new ConditionalAuditStore()
  store.head = async () => ({ nextSeq: 1, headHash: GENESIS_HASH })

  await assert.rejects(
    DurableAuditLog.open({ store, streamId: 'pilot' }),
    /AUDIT_HEAD_INVALID/,
  )
})

test('a caller-supplied request id reconciles an ambiguously committed append after restart', async () => {
  const store = new ConditionalAuditStore()
  const append = store.appendIfHead.bind(store)
  let loseFirstResponse = true
  store.appendIfHead = async (...args) => {
    await append(...args)
    if (loseFirstResponse) {
      loseFirstResponse = false
      throw new Error('RESPONSE_LOST_AFTER_COMMIT')
    }
  }
  const fact = { kind: 'pilot.started' }
  const requestId = 'req-ambiguous-1'
  const first = await DurableAuditLog.open({ store, streamId: 'pilot' })

  await assert.rejects(first.append(fact, { requestId }), /RESPONSE_LOST_AFTER_COMMIT/)
  await assert.rejects(first.append(fact, { requestId }), (error) => error.code === 'AUDIT_WRITER_UNCERTAIN')

  const recovered = await DurableAuditLog.open({ store, streamId: 'pilot' })
  const replay = await recovered.append(fact, { requestId })
  assert.equal(replay.seq, 0)
  assert.equal((await recovered.entries()).length, 1)
  await assert.rejects(
    recovered.append({ kind: 'different.fact' }, { requestId }),
    (error) => error.code === 'AUDIT_REQUEST_ID_REUSE',
  )
})
