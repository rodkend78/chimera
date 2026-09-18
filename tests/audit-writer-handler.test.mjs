import assert from 'node:assert/strict'
import test from 'node:test'
import { createAuditWriterHandler } from '../src/aws/audit-writer-handler.mjs'

const GENESIS_HASH = '0'.repeat(64)

class MemoryConditionalStore {
  constructor() {
    this.streams = new Map()
    this.receipts = new Map()
    this.appendCalls = 0
  }

  async head(streamId) {
    const last = (this.streams.get(streamId) ?? []).at(-1)
    return last
      ? { nextSeq: last.seq + 1, headHash: last.entryHash }
      : { nextSeq: 0, headHash: GENESIS_HASH }
  }

  async receipt(streamId, requestId) {
    return structuredClone(this.receipts.get(`${streamId}:${requestId}`) ?? null)
  }

  async appendIfHead(streamId, entry, expected, { requestId }) {
    this.appendCalls += 1
    assert.deepEqual(await this.head(streamId), expected)
    const entries = this.streams.get(streamId) ?? []
    entries.push(structuredClone(entry))
    this.streams.set(streamId, entries)
    this.receipts.set(`${streamId}:${requestId}`, structuredClone(entry))
  }

  async entries(streamId) {
    return structuredClone(this.streams.get(streamId) ?? [])
  }
}

test('audit writer exposes a verified snapshot and one conditional append operation', async () => {
  const store = new MemoryConditionalStore()
  const handler = createAuditWriterHandler({ store })

  assert.deepEqual(await handler({ operation: 'snapshot', streamId: 'pilot/runtime' }), {
    head: { nextSeq: 0, headHash: GENESIS_HASH },
    entries: [],
  })
  const accepted = await handler({
    operation: 'append',
    streamId: 'pilot/runtime',
    requestId: 'req-writer-first',
    expected: { nextSeq: 0, headHash: GENESIS_HASH },
    fact: { kind: 'pilot.started' },
  })
  assert.equal(accepted.seq, 0)
  assert.equal(accepted.prevHash, GENESIS_HASH)
  assert.deepEqual(accepted.fact, { kind: 'pilot.started' })
  assert.equal(store.appendCalls, 1)
})

test('audit writer rejects stale and unsupported operations without mutating the stream', async () => {
  const store = new MemoryConditionalStore()
  const handler = createAuditWriterHandler({ store })

  assert.deepEqual(await handler({
    operation: 'append',
    streamId: 'pilot/runtime',
    requestId: 'req-writer-stale',
    expected: { nextSeq: 4, headHash: 'a'.repeat(64) },
    fact: { kind: 'pilot.stale' },
  }), { error: { code: 'AUDIT_APPEND_CONFLICT' } })
  assert.deepEqual(await handler({ operation: 'delete', streamId: 'pilot/runtime' }), {
    error: { code: 'AUDIT_WRITER_OPERATION_INVALID' },
  })
  assert.equal(store.appendCalls, 0)
  assert.deepEqual(await store.entries('pilot/runtime'), [])
})

test('audit writer reconciles an already committed request before rejecting a stale expected head', async () => {
  const store = new MemoryConditionalStore()
  const handler = createAuditWriterHandler({ store })
  const request = {
    operation: 'append',
    streamId: 'pilot/runtime',
    requestId: 'req-writer-replay',
    expected: { nextSeq: 0, headHash: GENESIS_HASH },
    fact: { kind: 'pilot.reconciled' },
  }

  const accepted = await handler(request)
  const replayed = await handler(request)

  assert.deepEqual(replayed, accepted)
  assert.equal(store.appendCalls, 1)
  assert.deepEqual(await handler({ ...request, fact: { kind: 'pilot.changed' } }), {
    error: { code: 'AUDIT_REQUEST_ID_REUSE' },
  })
})
