import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoryAuditLog } from '../src/audit-log.mjs'
import {
  DurableAgentRegistry,
  agentManifestFromHermesCandidate,
} from '../src/agents/registry.mjs'

test('Hermes candidate becomes a bounded manifest without profile contents or credentials', () => {
  const manifest = agentManifestFromHermesCandidate({
    schema: 'chimera.hermes-agent-candidate.v1',
    candidateId: 'hermes-aws:ace',
    profileId: 'ace',
    displayName: 'Ace',
    sourceRef: 'hermes://configured-hermes/profiles/ace',
    profilePath: '/var/lib/chimera/hermes/profiles/ace',
    config: 'telegram: { token: secret }',
  }, {
    role: 'Engineering and security specialist',
    capabilities: ['coding', 'security-review'],
  }, { now: () => Date.parse('2026-08-29T20:00:00.000Z') })

  assert.deepEqual(manifest, {
    schema: 'chimera.agent-manifest.v1',
    agentId: 'ace',
    displayName: 'Ace',
    role: 'Engineering and security specialist',
    capabilities: ['coding', 'security-review'],
    modelPreference: { mode: 'chimera-auto' },
    source: {
      type: 'hermes',
      sourceId: 'hermes-aws',
      profileId: 'ace',
      ref: 'hermes://configured-hermes/profiles/ace',
    },
    personaRefs: [{ type: 'hermes-profile', ref: 'hermes://configured-hermes/profiles/ace/persona' }],
    memoryRefs: [{ type: 'hermes-profile', ref: 'hermes://configured-hermes/profiles/ace/memory' }],
    skillRefs: [{ type: 'hermes-profile', ref: 'hermes://configured-hermes/profiles/ace/skills' }],
    execution: {
      adapter: 'model-fabric',
      isolation: 'per-agent-workspace',
      sideEffects: 'dsh-required',
    },
    enabled: true,
    importedAt: '2026-08-29T20:00:00.000Z',
  })
  assert.equal(JSON.stringify(manifest).includes('/home/'), false)
  assert.equal(JSON.stringify(manifest).includes('secret'), false)
})

test('agent registry durably stores imported manifests and rejects duplicate identities', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-agent-registry-'))
  const filePath = join(directory, 'registry.json')
  const audit = new MemoryAuditLog()
  try {
    const registry = await DurableAgentRegistry.open({ filePath, audit })
    const manifest = agentManifestFromHermesCandidate({
      schema: 'chimera.hermes-agent-candidate.v1',
      candidateId: 'hermes-aws:sample-profile',
      profileId: 'sample-profile',
      displayName: 'Sample Profile',
      sourceRef: 'hermes://configured-hermes/profiles/sample-profile',
    }, { role: 'Operations and research specialist', capabilities: ['operations', 'research'] })

    await registry.register(manifest)
    await assert.rejects(registry.register(manifest), /AGENT_ALREADY_REGISTERED/)

    const reopened = await DurableAgentRegistry.open({ filePath, audit: new MemoryAuditLog() })
    assert.equal(reopened.list().length, 1)
    assert.equal(reopened.get('sample-profile').role, 'Operations and research specialist')
    assert.equal(audit.entries().at(-1).fact.kind, 'agent.registry.registered')

    const persisted = await readFile(filePath, 'utf8')
    assert.equal(persisted.includes('telegram'), false)
    assert.equal(persisted.includes('credential'), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('agent registry rejects an invalid batch without partially importing its valid members', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-agent-registry-batch-'))
  const filePath = join(directory, 'registry.json')
  try {
    const registry = await DurableAgentRegistry.open({ filePath, audit: new MemoryAuditLog() })
    const candidate = {
      schema: 'chimera.hermes-agent-candidate.v1',
      candidateId: 'hermes-aws:ace',
      profileId: 'ace',
      displayName: 'Ace',
      sourceRef: 'hermes://configured-hermes/profiles/ace',
    }
    const valid = agentManifestFromHermesCandidate(candidate)
    await assert.rejects(registry.registerMany([valid, { ...valid, agentId: '../escape' }]), /AGENT_MANIFEST_INVALID/)
    assert.deepEqual(registry.list(), [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('agent registry durably unregisters an imported profile and records why it was removed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-agent-registry-remove-'))
  const filePath = join(directory, 'registry.json')
  const audit = new MemoryAuditLog()
  try {
    const registry = await DurableAgentRegistry.open({ filePath, audit, now: () => Date.parse('2026-09-01T08:00:00.000Z') })
    const manifest = agentManifestFromHermesCandidate({
      schema: 'chimera.hermes-agent-candidate.v1',
      candidateId: 'hermes-aws:example-profile',
      profileId: 'example-profile',
      displayName: 'Example Profile',
      sourceRef: 'hermes://configured-hermes/profiles/example-profile',
    })
    await registry.register(manifest)

    const removed = await registry.unregister('example-profile', { removedBy: 'operator', reason: 'not-configured' })
    assert.equal(removed.agentId, 'example-profile')
    assert.equal(registry.get('example-profile'), null)
    const reopened = await DurableAgentRegistry.open({ filePath, audit: new MemoryAuditLog() })
    assert.equal(reopened.list().length, 0)
    assert.equal(audit.entries().at(-1).fact.kind, 'agent.registry.unregistered')
    assert.equal(audit.entries().at(-1).fact.reason, 'not-configured')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
