import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoryAuditLog } from '../src/audit-log.mjs'
import {
  DurableAgentRegistry,
  agentManifestFromHermesCandidate,
  agentManifestFromNativeInput,
  validateAgentManifest,
} from '../src/agents/registry.mjs'

test('native agent creation uses its own bounded source and unchanged authority posture', () => {
  const manifest = agentManifestFromNativeInput({
    agentId: 'test-builder',
    displayName: 'Test Builder',
    role: 'Repository implementation',
    capabilities: ['coding'],
  }, { now: () => 0 })
  assert.equal(manifest.source.ref, 'chimera://local/agents/test-builder')
  assert.equal(manifest.execution.sideEffects, 'dsh-required')
  assert.equal(manifest.modelPreference.mode, 'chimera-auto')
  assert.deepEqual(validateAgentManifest(manifest), manifest)
  assert.throws(() => agentManifestFromNativeInput({
    agentId: 'ceo', displayName: 'Replacement', role: 'CEO', capabilities: ['general'],
  }), /AGENT_MANIFEST_INVALID/)
})

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

test('native registry metadata updates preserve source refs and execution posture across reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-agent-registry-metadata-'))
  const filePath = join(directory, 'registry.json')
  const audit = new MemoryAuditLog()
  try {
    const registry = await DurableAgentRegistry.open({ filePath, audit })
    const manifest = agentManifestFromNativeInput({
      agentId: 'metadata-agent', displayName: 'Metadata Agent', role: 'Before', capabilities: ['coding'],
    })
    await registry.register(manifest)
    const updated = await registry.updateMetadata('metadata-agent', {
      displayName: 'Metadata Agent v2', role: 'After', capabilities: ['research', 'coding'],
    }, { changedBy: 'rod' })
    assert.equal(updated.displayName, 'Metadata Agent v2')
    assert.deepEqual(updated.source, manifest.source)
    assert.deepEqual(updated.personaRefs, manifest.personaRefs)
    assert.deepEqual(updated.memoryRefs, manifest.memoryRefs)
    assert.deepEqual(updated.skillRefs, manifest.skillRefs)
    assert.deepEqual(updated.execution, manifest.execution)
    assert.deepEqual(updated.modelPreference, manifest.modelPreference)
    const reopened = await DurableAgentRegistry.open({ filePath, audit: new MemoryAuditLog() })
    assert.deepEqual(reopened.get('metadata-agent'), updated)
    const fact = audit.entries().at(-1).fact
    assert.equal(fact.kind, 'agent.registry.metadata-updated')
    assert.deepEqual(fact.changedFields, ['capabilities', 'displayName', 'role'])
    assert.equal(JSON.stringify(fact).includes('Before'), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('registry serializes concurrent metadata and registration mutations without losing either result', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-agent-registry-concurrent-'))
  const filePath = join(directory, 'registry.json')
  try {
    const registry = await DurableAgentRegistry.open({ filePath, audit: new MemoryAuditLog() })
    const first = agentManifestFromNativeInput({
      agentId: 'first-agent', displayName: 'First', role: 'One', capabilities: ['coding'],
    })
    const second = agentManifestFromNativeInput({
      agentId: 'second-agent', displayName: 'Second', role: 'Two', capabilities: ['research'],
    })
    await Promise.all([
      registry.register(first),
      registry.register(second),
    ])
    await Promise.all([
      registry.updateMetadata('first-agent', {
        displayName: 'First updated', role: 'One+', capabilities: ['coding', 'testing'],
      }, { changedBy: 'rod' }),
      registry.updateMetadata('second-agent', {
        displayName: 'Second updated', role: 'Two+', capabilities: ['research', 'testing'],
      }, { changedBy: 'rod' }),
    ])
    const reopened = await DurableAgentRegistry.open({ filePath, audit: new MemoryAuditLog() })
    assert.equal(reopened.get('first-agent').displayName, 'First updated')
    assert.equal(reopened.get('second-agent').displayName, 'Second updated')
    assert.deepEqual(reopened.get('first-agent').capabilities, ['coding', 'testing'])
    assert.deepEqual(reopened.get('second-agent').capabilities, ['research', 'testing'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('failed native registry persistence leaves no phantom registration or metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-agent-registry-rollback-'))
  const filePath = join(directory, 'registry.json')
  try {
    const registry = await DurableAgentRegistry.open({ filePath, audit: new MemoryAuditLog() })
    const manifest = agentManifestFromNativeInput({
      agentId: 'rollback-agent', displayName: 'Rollback', role: 'Before', capabilities: ['coding'],
    })
    registry.filePath = join(directory, 'missing', 'registry.json')
    await assert.rejects(registry.register(manifest), /ENOENT/)
    assert.equal(registry.get('rollback-agent'), null)
    assert.deepEqual(registry.list(), [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('metadata audit rejection leaves both the in-memory and durable manifest unchanged', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-agent-registry-audit-failure-'))
  const filePath = join(directory, 'registry.json')
  let rejectMetadata = false
  const audit = { append(fact) { if (rejectMetadata && fact.kind === 'agent.registry.metadata-updated') throw new Error('AUDIT_UNAVAILABLE') } }
  try {
    const registry = await DurableAgentRegistry.open({ filePath, audit })
    const manifest = agentManifestFromNativeInput({
      agentId: 'audit-agent', displayName: 'Audit Agent', role: 'Before', capabilities: ['coding'],
    })
    await registry.register(manifest)
    rejectMetadata = true
    await assert.rejects(registry.updateMetadata('audit-agent', {
      displayName: 'After', role: 'After role', capabilities: ['coding', 'testing'],
    }, { changedBy: 'rod' }), /AUDIT_UNAVAILABLE/)
    assert.equal(registry.get('audit-agent').displayName, 'Audit Agent')
    const reopened = await DurableAgentRegistry.open({ filePath, audit: { append() {} } })
    assert.equal(reopened.get('audit-agent').displayName, 'Audit Agent')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('async metadata audit rejection also aborts before publishing the next manifest', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-agent-registry-async-audit-'))
  const filePath = join(directory, 'registry.json')
  let rejectMetadata = false
  const audit = { async append(fact) { if (rejectMetadata && fact.kind === 'agent.registry.metadata-updated') throw new Error('ASYNC_AUDIT_UNAVAILABLE') } }
  try {
    const registry = await DurableAgentRegistry.open({ filePath, audit })
    await registry.register(agentManifestFromNativeInput({
      agentId: 'async-audit-agent', displayName: 'Async Audit', role: 'Before', capabilities: ['coding'],
    }))
    rejectMetadata = true
    await assert.rejects(registry.updateMetadata('async-audit-agent', {
      displayName: 'After', role: 'After role', capabilities: ['coding'],
    }, { changedBy: 'rod' }), /ASYNC_AUDIT_UNAVAILABLE/)
    assert.equal(registry.get('async-audit-agent').displayName, 'Async Audit')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
