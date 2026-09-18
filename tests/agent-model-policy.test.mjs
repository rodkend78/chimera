import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoryAuditLog } from '../src/audit-log.mjs'
import { DurableAgentModelPolicy } from '../src/agents/model-policy.mjs'

test('agent model policy defaults to Auto and durably stores Preferred or Pinned choices', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-agent-model-'))
  const filePath = join(directory, 'models.json')
  const audit = new MemoryAuditLog()
  try {
    const policy = await DurableAgentModelPolicy.open({ filePath, audit, now: () => Date.parse('2026-08-30T12:00:00.000Z') })
    assert.deepEqual(policy.get('ceo'), {
      agentId: 'ceo',
      mode: 'auto',
      providerId: null,
      model: null,
      changedBy: null,
      changedAt: null,
    })

    assert.equal((await policy.set('ceo', {
      mode: 'preferred',
      providerId: 'codex',
      model: 'gpt-5.6-sol',
    }, { changedBy: 'rod' })).mode, 'preferred')
    await policy.set('ace', {
      mode: 'pinned',
      providerId: 'aws-bedrock-mantle',
      model: 'xai.grok-4.6',
    }, { changedBy: 'rod' })

    const reopened = await DurableAgentModelPolicy.open({ filePath, audit: new MemoryAuditLog() })
    assert.equal(reopened.get('ceo').model, 'gpt-5.6-sol')
    assert.equal(reopened.get('ace').mode, 'pinned')
    const persisted = await readFile(filePath, 'utf8')
    assert.equal(persisted.includes('apiKey'), false)
    assert.equal(audit.entries().filter((entry) => entry.fact.kind === 'agent.model.changed').length, 2)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('agent model policy rejects malformed, media-shaped, and credential-bearing preferences', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-agent-model-invalid-'))
  try {
    const policy = await DurableAgentModelPolicy.open({ filePath: join(directory, 'models.json'), audit: new MemoryAuditLog() })
    await assert.rejects(policy.set('ace', { mode: 'preferred', providerId: 'codex' }, { changedBy: 'rod' }), /AGENT_MODEL_PREFERENCE_INVALID/)
    await assert.rejects(policy.set('ace', { mode: 'pinned', providerId: 'aws-bedrock', model: 'stability.image', mediaKind: 'image' }, { changedBy: 'rod' }), /AGENT_MODEL_PREFERENCE_INVALID/)
    await assert.rejects(policy.set('ace', { mode: 'pinned', providerId: 'codex', model: 'gpt', apiKey: 'secret' }, { changedBy: 'rod' }), /AGENT_MODEL_PREFERENCE_INVALID/)
    await assert.rejects(policy.set('../ace', { mode: 'auto' }, { changedBy: 'rod' }), /AGENT_ID_INVALID/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a failed durable model-policy write rolls back the in-memory preference', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-agent-model-failure-'))
  const filePath = join(directory, 'models.json')
  const policy = await DurableAgentModelPolicy.open({ filePath, audit: new MemoryAuditLog() })
  await rm(directory, { recursive: true, force: true })
  await writeFile(directory, 'blocks the policy directory')
  try {
    await assert.rejects(policy.set('ace', {
      mode: 'pinned', providerId: 'codex', model: 'gpt-5.6-sol',
    }, { changedBy: 'rod' }))
    assert.equal(policy.get('ace').mode, 'auto')
  } finally {
    await rm(directory, { force: true })
  }
})
