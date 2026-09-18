import assert from 'node:assert/strict'
import test from 'node:test'
import { LambdaAuditClient } from '../src/audit/lambda-client.mjs'

const GENESIS_HASH = '0'.repeat(64)
const workerUrl = new URL('./fixtures/lambda-audit-worker.mjs', import.meta.url)
const delayedWorkerUrl = new URL(workerUrl)
delayedWorkerUrl.searchParams.set('startupDelayMs', '50')

test('Lambda audit client blocks until its isolated worker returns the acknowledged entry', async () => {
  const client = await LambdaAuditClient.open({
    functionName: 'chimera-audit-writer',
    region: 'us-west-2',
    workerUrl,
    snapshotInvoker: async (request) => ({
      operation: request.operation,
      streamId: request.streamId,
      head: { nextSeq: 0, headHash: GENESIS_HASH },
      entries: [],
    }),
  })
  try {
    assert.deepEqual(await client.snapshot('pilot/runtime'), {
      operation: 'snapshot',
      streamId: 'pilot/runtime',
      head: { nextSeq: 0, headHash: GENESIS_HASH },
      entries: [],
    })
    const accepted = client.appendSync({
      streamId: 'pilot/runtime',
      fact: { kind: 'fixture.accepted' },
      requestId: 'req-fixture-accepted',
      expected: { nextSeq: 0, headHash: GENESIS_HASH },
    })
    assert.equal(accepted.seq, 0)
    assert.equal(accepted.prevHash, GENESIS_HASH)
    assert.deepEqual(accepted.fact, { kind: 'fixture.accepted' })
    assert.match(accepted.entryHash, /^[a-f0-9]{64}$/)
  } finally {
    await client.close()
  }
})

test('Lambda audit client fails closed when its isolated writer exceeds the append deadline', async () => {
  const client = await LambdaAuditClient.open({
    functionName: 'chimera-audit-writer',
    region: 'us-west-2',
    workerUrl,
    timeoutMs: 25,
    snapshotInvoker: async () => ({
      head: { nextSeq: 0, headHash: GENESIS_HASH },
      entries: [],
    }),
  })
  try {
    assert.throws(
      () => client.appendSync({
        streamId: 'pilot/runtime',
        fact: { kind: 'fixture.stall' },
        requestId: 'req-fixture-stall',
        expected: { nextSeq: 0, headHash: GENESIS_HASH },
      }),
      (error) => error.code === 'AUDIT_WRITER_TIMEOUT',
    )
  } finally {
    await client.close()
  }
})

test('a short append deadline does not become the isolated worker startup deadline', async () => {
  const client = await LambdaAuditClient.open({
    functionName: 'chimera-audit-writer',
    region: 'us-west-2',
    workerUrl: delayedWorkerUrl,
    timeoutMs: 5,
    startupTimeoutMs: 250,
    snapshotInvoker: async () => ({ head: { nextSeq: 0, headHash: GENESIS_HASH }, entries: [] }),
  })
  try {
    assert.throws(
      () => client.appendSync({
        streamId: 'pilot/runtime',
        fact: { kind: 'fixture.stall' },
        requestId: 'req-short-append-timeout',
        expected: { nextSeq: 0, headHash: GENESIS_HASH },
      }),
      (error) => error.code === 'AUDIT_WRITER_TIMEOUT',
    )
  } finally {
    await client.close()
  }
})

test('async Lambda append keeps main-thread timers responsive, serializes buffers, and rejects overlapping sync calls', async () => {
  const client = await LambdaAuditClient.open({ functionName: 'fixture', region: 'us-west-2', workerUrl,
    timeoutMs: 2000, snapshotInvoker: async () => ({}) })
  let ticks = 0
  const timer = setInterval(() => { ticks += 1 }, 5)
  try {
    const expected = { nextSeq: 0, headHash: GENESIS_HASH }
    const first = client.appendAsync({ fact: { kind: 'fixture.stall' }, requestId: 'first', expected })
    const secondFact = { kind: 'fixture.second' }
    const second = client.appendAsync({ fact: secondFact, requestId: 'second', expected })
    secondFact.kind = 'mutated'
    assert.throws(() => client.appendSync({ fact: {}, expected }), /AUDIT_WRITER_ASYNC_PENDING/)
    const [a, b] = await Promise.all([first, second])
    assert.equal(a.fact.kind, 'fixture.stall')
    assert.equal(b.fact.kind, 'fixture.second')
    assert.ok(ticks >= 3, `main-thread timer advanced only ${ticks} times`)
    assert.equal(client.appendSync({ fact: { kind: 'after' }, expected }).fact.kind, 'after')
  } finally {
    clearInterval(timer)
    await client.close()
  }
})

test('an async append timeout poisons queued work before another remote request is dispatched', async () => {
  const client = await LambdaAuditClient.open({ functionName: 'fixture', region: 'us-west-2', workerUrl,
    timeoutMs: 25, snapshotInvoker: async () => ({}) })
  try {
    const expected = { nextSeq: 0, headHash: GENESIS_HASH }
    const results = await Promise.allSettled([
      client.appendAsync({ fact: { kind: 'fixture.stall' }, expected }),
      client.appendAsync({ fact: { kind: 'must-not-dispatch' }, expected }),
    ])
    assert.equal(results[0].reason.code, 'AUDIT_WRITER_TIMEOUT')
    assert.equal(results[1].reason.code, 'AUDIT_WRITER_UNCERTAIN')
    assert.throws(() => client.appendSync({ fact: {}, expected }), /AUDIT_WRITER_UNCERTAIN/)
  } finally {
    await client.close()
  }
})
