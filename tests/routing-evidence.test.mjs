import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoryAuditLog } from '../src/audit-log.mjs'
import { RoutingEvidenceStore } from '../src/ceo/routing-evidence.mjs'

test('routing evidence is durable and only reports thresholds from real bounded invocations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-routing-evidence-'))
  try {
    const audit = new MemoryAuditLog()
    const path = join(directory, 'routing-evidence.json')
    const store = await RoutingEvidenceStore.open({ filePath: path, audit, now: () => 1_700_000_000_000 })
    for (const durationMs of [100, 120, 80]) {
      await store.recordInvocation({ providerId: 'aws-bedrock', model: 'research', capability: 'research', outcome: 'succeeded', durationMs, cost: { usd: 0.2, source: 'measured', evidenceRef: 'fixture-call' } })
    }
    for (let index = 0; index < 2; index += 1) {
      await store.recordInvocation({ providerId: 'aws-bedrock', model: 'research', capability: 'research', outcome: 'failed-not-sent', durationMs: null, cost: null })
    }
    await store.recordInvocation({ providerId: 'aws-bedrock', model: 'research', capability: 'research', outcome: 'unknown', durationMs: 200, cost: null })

    const snapshot = store.snapshot({ providerId: 'aws-bedrock', model: 'research', capability: 'research' })
    assert.equal(snapshot.schema, 'chimera.routing-evidence-snapshot.v1')
    assert.equal(snapshot.resolvedSamples, 5)
    assert.equal(snapshot.successSamples, 3)
    assert.equal(snapshot.reliability.status, 'measured')
    assert.equal(snapshot.reliability.successRatio, 0.6)
    assert.equal(snapshot.latency.status, 'measured')
    assert.equal(snapshot.latency.successSamples, 3)
    assert.equal(snapshot.latency.medianMs, 100)
    assert.equal(snapshot.quality.status, 'declared-unknown')
    assert.equal(snapshot.cost.status, 'measured')
    assert.equal(snapshot.cost.medianUsd, 0.2)

    const reopened = await RoutingEvidenceStore.open({ filePath: path, audit, now: () => 1_700_000_000_001 })
    assert.deepEqual(reopened.snapshot({ providerId: 'aws-bedrock', model: 'research', capability: 'research' }), snapshot)
    const persisted = await readFile(path, 'utf8')
    assert.equal(persisted.includes('fixture-call'), true)
    assert.equal(persisted.includes('prompt'), false)
    assert.equal(persisted.includes('persona'), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('unknown samples do not become successes, zero-cost estimates, or a proven route', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-routing-evidence-'))
  try {
    const store = await RoutingEvidenceStore.open({ filePath: join(directory, 'evidence.json'), audit: new MemoryAuditLog() })
    await store.recordInvocation({ providerId: 'codex', model: 'subscription', capability: 'coding', outcome: 'unknown', durationMs: 900, cost: null })
    const snapshot = store.snapshot({ providerId: 'codex', model: 'subscription', capability: 'coding' })
    assert.equal(snapshot.resolvedSamples, 0)
    assert.equal(snapshot.reliability.status, 'insufficient-evidence')
    assert.equal(snapshot.latency.status, 'insufficient-evidence')
    assert.equal(snapshot.cost.status, 'unknown')
    assert.equal(snapshot.eligible, false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('operator cost estimates remain comparable but are never labeled as measured', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-routing-evidence-'))
  try {
    const store = await RoutingEvidenceStore.open({ filePath: join(directory, 'evidence.json'), audit: new MemoryAuditLog() })
    const identity = { providerId: 'fixture', model: 'economy', capability: 'general' }
    await store.recordInvocation({ ...identity, outcome: 'succeeded', durationMs: 10, cost: { usd: 0.04, source: 'operator-estimate', evidenceRef: 'operator-estimate-1' } })
    let snapshot = store.snapshot(identity)
    assert.equal(snapshot.cost.status, 'estimated')
    assert.equal(snapshot.cost.source, 'operator-estimate')
    await store.recordInvocation({ ...identity, outcome: 'succeeded', durationMs: 11, cost: { usd: 0.03, source: 'measured', evidenceRef: 'measured-1' } })
    snapshot = store.snapshot(identity)
    assert.equal(snapshot.cost.status, 'estimated')
    assert.equal(snapshot.cost.source, 'mixed')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('evidence recording rejects forged outcomes and unbounded provider metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-routing-evidence-'))
  try {
    const store = await RoutingEvidenceStore.open({ filePath: join(directory, 'evidence.json'), audit: new MemoryAuditLog() })
    await assert.rejects(store.recordInvocation({ providerId: 'codex', model: 'm', capability: 'coding', outcome: 'succeeded', durationMs: 4, cost: null, prompt: 'do not persist' }), { code: 'ROUTING_EVIDENCE_INPUT_INVALID' })
    await assert.rejects(store.recordInvocation({ providerId: 'codex', model: 'm', capability: 'coding', outcome: 'succeeded', durationMs: 4, cost: { usd: 0, source: 'measured', evidenceRef: 'https://provider.example/token' } }), { code: 'ROUTING_EVIDENCE_VALUE_INVALID' })
    await assert.rejects(store.recordInvocation({ providerId: 'codex', model: 'm', capability: 'coding', outcome: 'provider-claimed-not-sent', durationMs: null, cost: null }), { code: 'ROUTING_EVIDENCE_VALUE_INVALID' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('evidence restore rejects samples attributed to a different bucket identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-routing-evidence-'))
  try {
    const path = join(directory, 'evidence.json')
    await writeFile(path, JSON.stringify({
      schema: 'chimera.routing-evidence.v1',
      buckets: {
        'provider-a\u0000model-a\u0000research': {
          providerId: 'provider-a', model: 'model-a', capability: 'research',
          samples: [{ providerId: 'provider-b', model: 'model-b', capability: 'research', outcome: 'succeeded', durationMs: 10, cost: null, observedAt: new Date(1_700_000_000_000).toISOString() }],
        },
      },
    }))
    await assert.rejects(RoutingEvidenceStore.open({ filePath: path }), { code: 'ROUTING_EVIDENCE_CORRUPT' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('evidence accepts the task model identifier bound of 512 characters', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-routing-evidence-'))
  try {
    const model = 'm'.repeat(512)
    const store = await RoutingEvidenceStore.open({ filePath: join(directory, 'evidence.json') })
    await store.recordInvocation({ providerId: 'fixture', model, capability: 'research', outcome: 'succeeded', durationMs: 10, cost: null })
    assert.equal(store.snapshot({ providerId: 'fixture', model, capability: 'research' }).model, model)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
