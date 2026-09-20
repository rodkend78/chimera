import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DurableAgentCreationReceipts } from '../src/agents/creation-receipts.mjs'

const hash = 'a'.repeat(64)

test('creation receipt reservation survives restart and finalizes without retaining persona content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-create-receipts-'))
  const filePath = join(directory, 'receipts.json')
  try {
    const first = await DurableAgentCreationReceipts.open({ filePath })
    await first.reserve({ requestId: 'request-1', inputHash: hash, agentId: 'native-agent' })
    const reopened = await DurableAgentCreationReceipts.open({ filePath })
    assert.deepEqual(reopened.get('request-1'), {
      requestId: 'request-1', inputHash: hash, agentId: 'native-agent', status: 'reserved',
    })
    const result = {
      schema: 'chimera.agent-create-result.v1', requestId: 'request-1',
      agent: { agentId: 'native-agent' },
      continuity: [{ agentId: 'native-agent', status: 'unavailable', digest: null, report: { dependencyStatus: 'unverified' }, failureCode: 'NATIVE_PERSONA_UNAVAILABLE' }],
    }
    await reopened.put({ requestId: 'request-1', inputHash: hash, result })
    const final = await DurableAgentCreationReceipts.open({ filePath })
    assert.deepEqual(final.get('request-1').result, result)
    assert.equal(JSON.stringify(final.list()).includes('persona content'), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('creation receipt request ids conflict on a different input hash and persistence failure rolls back', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-create-receipts-failure-'))
  try {
    const receipts = await DurableAgentCreationReceipts.open({ filePath: join(directory, 'receipts.json') })
    await receipts.reserve({ requestId: 'request-1', inputHash: hash, agentId: 'native-agent' })
    await assert.rejects(receipts.reserve({ requestId: 'request-1', inputHash: 'b'.repeat(64), agentId: 'native-agent' }), /AGENT_CREATE_REQUEST_CONFLICT/)
    receipts.filePath = join(directory, 'missing', 'receipts.json')
    await assert.rejects(receipts.reserve({ requestId: 'request-2', inputHash: hash, agentId: 'other-agent' }), /ENOENT/)
    assert.equal(receipts.get('request-2'), null)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('creation receipts reject a second durable owner for the same agent identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-create-receipts-owner-'))
  try {
    const receipts = await DurableAgentCreationReceipts.open({ filePath: join(directory, 'receipts.json') })
    await receipts.reserve({ requestId: 'request-a', inputHash: hash, agentId: 'native-agent' })
    await assert.rejects(
      receipts.reserve({ requestId: 'request-b', inputHash: 'b'.repeat(64), agentId: 'native-agent' }),
      /AGENT_ALREADY_REGISTERED/,
    )
    assert.deepEqual(receipts.get('request-b'), null)
    assert.equal(receipts.get('request-a').status, 'reserved')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
