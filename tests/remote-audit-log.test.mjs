import assert from 'node:assert/strict'
import test from 'node:test'
import { RemoteAuditLog } from '../src/audit/remote-log.mjs'
import { sha256 } from '../src/canonical.mjs'

const GENESIS_HASH = '0'.repeat(64)

function entry(fact, seq = 0, prevHash = GENESIS_HASH) {
  const unsigned = { seq, prevHash, fact }
  return { ...unsigned, entryHash: sha256(unsigned) }
}

test('remote audit blocks on the isolated writer and projects its acknowledged entry synchronously', async () => {
  const appended = []
  const client = {
    snapshot: async () => ({
      head: { nextSeq: 0, headHash: GENESIS_HASH },
      entries: [],
    }),
    appendSync(request) {
      const accepted = entry(request.fact)
      appended.push({ ...request, accepted })
      return accepted
    },
  }
  const audit = await RemoteAuditLog.open({ client, streamId: 'pilot/runtime' })

  const accepted = audit.append({ kind: 'pilot.started' }, { requestId: 'req-pilot-started' })

  assert.deepEqual(accepted, entry({ kind: 'pilot.started' }))
  assert.equal(appended[0].streamId, 'pilot/runtime')
  assert.equal(appended[0].requestId, 'req-pilot-started')
  assert.deepEqual(audit.entries(), [accepted])
  assert.deepEqual(audit.verify(), {
    valid: true,
    entries: 1,
    head: accepted.entryHash,
  })
})

test('remote audit rejects a malformed writer acknowledgement and remains fail closed', async () => {
  let calls = 0
  const client = {
    snapshot: async () => ({
      head: { nextSeq: 0, headHash: GENESIS_HASH },
      entries: [],
    }),
    appendSync(request) {
      calls += 1
      return entry(request.fact, 1, 'a'.repeat(64))
    },
  }
  const audit = await RemoteAuditLog.open({ client, streamId: 'pilot/runtime' })

  assert.throws(
    () => audit.append({ kind: 'pilot.started' }, { requestId: 'req-malformed' }),
    (error) => error.code === 'AUDIT_REMOTE_ACK_INVALID',
  )
  assert.throws(
    () => audit.append({ kind: 'pilot.second' }, { requestId: 'req-after-malformed' }),
    (error) => error.code === 'AUDIT_WRITER_UNCERTAIN',
  )
  assert.equal(calls, 1)
  assert.deepEqual(audit.entries(), [])
})

test('async remote audit waits for each verified acknowledgement before advancing the chain or executing its caller', async () => {
  const requests = []
  let release
  const client = {
    snapshot: async () => ({ head: { nextSeq: 0, headHash: GENESIS_HASH }, entries: [] }),
    appendAsync: async (request) => {
      requests.push(request)
      if (requests.length === 1) await new Promise((resolve) => { release = resolve })
      return entry(request.fact, request.expected.nextSeq, request.expected.headHash)
    },
    appendSync: (request) => entry(request.fact, request.expected.nextSeq, request.expected.headHash),
  }
  const audit = await RemoteAuditLog.open({ client, streamId: 'pilot/runtime' })
  const fact = { kind: 'first' }
  let sideEffects = 0
  const first = audit.appendAsync(fact).then(() => { sideEffects += 1 })
  fact.kind = 'mutated'
  const second = audit.appendAsync({ kind: 'second' })
  assert.throws(() => audit.append({ kind: 'overlap' }), /AUDIT_WRITER_ASYNC_PENDING/)
  await Promise.resolve()
  assert.equal(requests.length, 1)
  assert.equal(sideEffects, 0)
  assert.equal(audit.entries().length, 0)
  release()
  const [, accepted] = await Promise.all([first, second])
  assert.equal(sideEffects, 1)
  assert.equal(requests[0].fact.kind, 'first')
  assert.equal(requests[1].expected.nextSeq, 1)
  assert.equal(accepted.prevHash, audit.entries()[0].entryHash)
  assert.equal(audit.append({ kind: 'sync-after-drain' }).seq, 2)
  assert.equal(audit.verify().valid, true)
})

test('malformed async acknowledgement prevents queued writes and all dependent side effects', async () => {
  let calls = 0
  let sideEffects = 0
  const audit = await RemoteAuditLog.open({ streamId: 'pilot/runtime', client: {
    snapshot: async () => ({ head: { nextSeq: 0, headHash: GENESIS_HASH }, entries: [] }),
    appendAsync: async (request) => { calls += 1; return entry(request.fact, 9) },
  } })
  const results = await Promise.allSettled([
    audit.appendAsync({ kind: 'first' }).then(() => { sideEffects += 1 }),
    audit.appendAsync({ kind: 'second' }).then(() => { sideEffects += 1 }),
  ])
  assert.equal(results[0].reason.code, 'AUDIT_REMOTE_ACK_INVALID')
  assert.equal(results[1].reason.code, 'AUDIT_WRITER_UNCERTAIN')
  assert.equal(calls, 1)
  assert.equal(sideEffects, 0)
  assert.equal(audit.entries().length, 0)
  assert.equal(audit.summary().valid, false)
})

test('remote close drains admitted async writes and rejects new work', async () => {
  let release
  let closed = false
  const audit = await RemoteAuditLog.open({ streamId: 'pilot/runtime', client: {
    snapshot: async () => ({ head: { nextSeq: 0, headHash: GENESIS_HASH }, entries: [] }),
    appendAsync: async (request) => {
      await new Promise((resolve) => { release = resolve })
      return entry(request.fact)
    },
    close: async () => { closed = true },
  } })
  const append = audit.appendAsync({ kind: 'last' })
  const closing = audit.close()
  await Promise.resolve()
  assert.equal(closed, false)
  await assert.rejects(audit.appendAsync({ kind: 'too-late' }), /AUDIT_WRITER_CLOSED/)
  release()
  await Promise.all([append, closing])
  assert.equal(closed, true)
  assert.equal(audit.entries().length, 1)
})
