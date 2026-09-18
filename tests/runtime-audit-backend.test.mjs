import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openRuntimeAudit } from '../src/audit/runtime-audit.mjs'
import { sha256 } from '../src/canonical.mjs'

const GENESIS_HASH = '0'.repeat(64)

test('runtime audit keeps the local backend unless Gate 2 is configured explicitly', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-audit-local-'))
  try {
    const audit = await openRuntimeAudit({
      filePath: join(directory, 'audit.jsonl'),
      env: {},
    })
    const accepted = audit.append({ kind: 'local.fact' })
    assert.equal(accepted.seq, 0)
    assert.deepEqual(audit.verify(), {
      valid: true,
      entries: 1,
      head: accepted.entryHash,
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('runtime audit fails startup on partial Gate 2 configuration', async () => {
  await assert.rejects(openRuntimeAudit({
    filePath: '/unused/audit.jsonl',
    env: { CHIMERA_AUDIT_WRITER_FUNCTION: 'chimera-audit-writer' },
  }), (error) => error.code === 'GATE2_AUDIT_CONFIG_INCOMPLETE')
})

test('runtime audit activates the exact configured remote writer and stream', async () => {
  const calls = []
  const client = {
    snapshot: async (streamId) => {
      calls.push({ operation: 'snapshot', streamId })
      return { head: { nextSeq: 0, headHash: GENESIS_HASH }, entries: [] }
    },
    appendSync(request) {
      calls.push({ operation: 'append', ...request })
      const unsigned = { seq: 0, prevHash: GENESIS_HASH, fact: request.fact }
      return { ...unsigned, entryHash: sha256(unsigned) }
    },
  }
  const audit = await openRuntimeAudit({
    filePath: '/unused/audit.jsonl',
    env: {
      CHIMERA_AUDIT_WRITER_FUNCTION: 'chimera-pilot-audit-writer',
      CHIMERA_AUDIT_STREAM_ID: 'pilot/runtime',
      AWS_REGION: 'us-west-2',
    },
    clientFactory: async (configuration) => {
      calls.push({ operation: 'client', ...configuration })
      return client
    },
  })

  const accepted = audit.append({ kind: 'remote.fact' }, { requestId: 'req-runtime-remote' })
  assert.equal(accepted.seq, 0)
  assert.deepEqual(calls[0], {
    operation: 'client',
    functionName: 'chimera-pilot-audit-writer',
    region: 'us-west-2',
  })
  assert.deepEqual(calls[1], { operation: 'snapshot', streamId: 'pilot/runtime' })
  assert.equal(calls[2].streamId, 'pilot/runtime')
})
