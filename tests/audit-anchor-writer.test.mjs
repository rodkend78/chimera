import assert from 'node:assert/strict'
import test from 'node:test'
import { sha256 } from '../src/canonical.mjs'
import { createAuditAnchorWriter } from '../src/aws/audit-anchor-writer.mjs'

const GENESIS_HASH = '0'.repeat(64)

function makeEntry(fact, seq = 0, prevHash = GENESIS_HASH) {
  const unsigned = { seq, prevHash, fact }
  return { ...unsigned, entryHash: sha256(unsigned) }
}

test('anchor writer verifies the durable chain and writes a deterministic immutable head document', async () => {
  const accepted = makeEntry({ type: 'task.completed', taskId: 'task-1' })
  const puts = []
  const writer = createAuditAnchorWriter({
    bucket: 'locked-anchors',
    now: () => new Date('2026-09-02T04:15:00.000Z'),
    store: {
      head: async () => ({ nextSeq: 1, headHash: accepted.entryHash }),
      entries: async () => [accepted],
    },
    putObject: async (request) => {
      puts.push(request)
      return { ETag: '"etag"', VersionId: 'version-1' }
    },
  })

  const result = await writer({ streamId: 'pilot/runtime' })

  assert.equal(puts.length, 1)
  assert.equal(puts[0].Bucket, 'locked-anchors')
  assert.equal(puts[0].Key, `anchors/pilot%2Fruntime/00000000000000000001-${accepted.entryHash}.json`)
  assert.equal(puts[0].IfNoneMatch, '*')
  assert.equal(puts[0].ContentType, 'application/json')
  assert.deepEqual(JSON.parse(puts[0].Body), {
    anchoredAt: '2026-09-02T04:15:00.000Z',
    headHash: accepted.entryHash,
    nextSeq: 1,
    schema: 'chimera.audit-anchor.v1',
    streamId: 'pilot/runtime',
  })
  assert.deepEqual(result, {
    bucket: 'locked-anchors',
    key: puts[0].Key,
    nextSeq: 1,
    headHash: accepted.entryHash,
    etag: '"etag"',
    versionId: 'version-1',
  })
})

test('anchor writer refuses a mismatched or corrupted audit head before touching S3', async () => {
  let putCalls = 0
  const accepted = makeEntry({ type: 'task.completed' })
  const writer = createAuditAnchorWriter({
    bucket: 'locked-anchors',
    store: {
      head: async () => ({ nextSeq: 1, headHash: 'a'.repeat(64) }),
      entries: async () => [accepted],
    },
    putObject: async () => { putCalls += 1 },
  })

  await assert.rejects(() => writer({ streamId: 'pilot/runtime' }), /AUDIT_ANCHOR_SOURCE_INVALID/)
  assert.equal(putCalls, 0)
})
