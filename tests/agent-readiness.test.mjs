import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoryAuditLog } from '../src/audit-log.mjs'
import { buildAgentReadiness, fingerprintAgentReadiness } from '../src/agents/readiness.mjs'
import { DurableAgentReadinessStore } from '../src/agents/readiness-store.mjs'

const manifest = (source = 'chimera') => ({
  schema: source === 'chimera' ? 'chimera.agent-manifest.v2' : 'chimera.agent-manifest.v1',
  agentId: 'researcher',
  displayName: 'Researcher',
  role: 'Research',
  enabled: true,
  source: source === 'chimera'
    ? { type: 'chimera', sourceId: 'local', ref: 'chimera://local/agents/researcher' }
    : { type: 'hermes', sourceId: 'hermes-v1', profileId: 'researcher', ref: 'hermes://fleet/profiles/researcher' },
  personaRefs: [{ type: `${source === 'chimera' ? 'chimera' : 'hermes'}-profile`, ref: `${source === 'chimera' ? 'chimera://local/agents/researcher' : 'hermes://fleet/profiles/researcher'}/persona` }],
  memoryRefs: [{ type: `${source === 'chimera' ? 'chimera' : 'hermes'}-profile`, ref: `${source === 'chimera' ? 'chimera://local/agents/researcher' : 'hermes://fleet/profiles/researcher'}/memory` }],
  skillRefs: [{ type: `${source === 'chimera' ? 'chimera' : 'hermes'}-profile`, ref: `${source === 'chimera' ? 'chimera://local/agents/researcher' : 'hermes://fleet/profiles/researcher'}/skills` }],
})

const continuity = ({ persona = 1, memory = 1, skills = 0, status = 'materialized' } = {}) => ({
  status,
  digest: 'digest-1',
  report: {
    persona: { files: persona, bytes: persona },
    memory: { files: memory, bytes: memory },
    skills: { files: skills, bytes: skills },
  },
})

const selection = {
  mode: 'pinned',
  providerId: 'fixture',
  model: 'fixture-model',
  eligible: true,
  availability: 'catalog-only',
  connectionRevision: 3,
}

test('readiness remains configured until a current pure inference receipt exists', () => {
  const input = {
    manifest: manifest(),
    continuity: continuity({ skills: 0 }),
    selection,
    access: { profileId: 'sandbox', network: 'none' },
    executor: { kind: 'harness', status: 'task-bound', identity: 'runtime-harness-v1' },
    verification: null,
  }
  const readiness = buildAgentReadiness(input)
  assert.equal(readiness.schema, 'chimera.agent-readiness.v1')
  assert.equal(readiness.status, 'configured')
  assert.equal(readiness.checks.find(row => row.name === 'execution').status, 'unknown')
  assert.equal(readiness.lastTest, null)
  assert.match(readiness.fingerprint, /^[a-f0-9]{64}$/)
})

test('required continuity layers block empty persona but optional memory and skills remain valid for native agents', () => {
  const native = buildAgentReadiness({
    manifest: manifest('chimera'),
    continuity: continuity({ persona: 0, memory: 0, skills: 0 }),
    selection,
    access: { profileId: 'sandbox', network: 'none' },
    executor: { kind: 'harness', status: 'task-bound', identity: 'runtime-harness-v1' },
  })
  assert.equal(native.status, 'blocked')
  assert.equal(native.checks.find(row => row.name === 'continuity').status, 'blocked')

  const nativeOptional = buildAgentReadiness({
    manifest: manifest('chimera'),
    continuity: continuity({ persona: 1, memory: 0, skills: 0 }),
    selection,
    access: { profileId: 'sandbox', network: 'none' },
    executor: { kind: 'harness', status: 'task-bound', identity: 'runtime-harness-v1' },
  })
  assert.notEqual(nativeOptional.checks.find(row => row.name === 'continuity').status, 'blocked')

  const hermes = buildAgentReadiness({
    manifest: manifest('hermes'),
    continuity: continuity({ persona: 1, memory: 0, skills: 0 }),
    selection,
    access: { profileId: 'sandbox', network: 'none' },
    executor: { kind: 'harness', status: 'task-bound', identity: 'runtime-harness-v1' },
  })
  assert.equal(hermes.status, 'blocked')
  assert.equal(hermes.checks.find(row => row.name === 'continuity').status, 'blocked')
})

test('a passed receipt verifies only the exact readiness fingerprint and remains historical after a binding change', () => {
  const base = {
    manifest: manifest(),
    continuity: continuity({}),
    selection,
    access: { profileId: 'sandbox', network: 'none' },
    executor: { kind: 'harness', status: 'task-bound', identity: 'runtime-harness-v1' },
  }
  const fingerprint = fingerprintAgentReadiness(base)
  const verified = buildAgentReadiness({
    ...base,
    verification: { requestId: 'test-1', scope: 'inference-only', status: 'passed', fingerprint, observedAt: '2026-09-19T00:00:00.000Z' },
  })
  assert.equal(verified.status, 'verified')
  assert.equal(verified.checks.find(row => row.name === 'execution').status, 'pass')

  const changed = buildAgentReadiness({
    ...base,
    selection: { ...selection, connectionRevision: 4 },
    verification: { requestId: 'test-1', scope: 'inference-only', status: 'passed', fingerprint, observedAt: '2026-09-19T00:00:00.000Z' },
  })
  assert.equal(changed.status, 'configured')
  assert.equal(changed.checks.find(row => row.name === 'execution').status, 'unknown')
  assert.equal(changed.lastTest.historical, true)
})

test('failed and unknown receipts for the current binding remain current but never verify execution', () => {
  const base = {
    manifest: manifest(),
    continuity: continuity({}),
    selection,
    access: { profileId: 'sandbox', network: 'none' },
    executor: { kind: 'harness', status: 'task-bound', identity: 'runtime-harness-v1' },
  }
  const fingerprint = fingerprintAgentReadiness(base)
  for (const status of ['failed', 'unknown']) {
    const readiness = buildAgentReadiness({
      ...base,
      verification: { requestId: `test-${status}`, scope: 'inference-only', status, fingerprint, observedAt: '2026-09-19T00:00:00.000Z' },
    })
    assert.equal(readiness.status, 'configured')
    assert.equal(readiness.checks.find(row => row.name === 'execution').status, 'unknown')
    assert.equal(readiness.lastTest.current, true)
    assert.equal(readiness.lastTest.historical, false)
  }
})

test('durable readiness receipts preserve unknown state and reject request collisions after reopen', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-agent-readiness-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filePath = join(directory, 'readiness.json')
  const audit = new MemoryAuditLog()
  const store = await DurableAgentReadinessStore.open({ filePath, audit })
  await store.record({
    agentId: 'researcher',
    requestId: 'test-unknown',
    requestScope: 'agent-readiness',
    intentFingerprint: 'a'.repeat(64),
    fingerprint: 'b'.repeat(64),
    scope: 'inference-only',
    status: 'pending',
    observedAt: '2026-09-19T00:00:00.000Z',
  })
  const reopened = await DurableAgentReadinessStore.open({ filePath, audit: new MemoryAuditLog() })
  assert.equal(reopened.getRequest({ agentId: 'researcher', requestScope: 'agent-readiness', requestId: 'test-unknown' }).status, 'unknown')
  await assert.rejects(() => reopened.record({
    agentId: 'researcher',
    requestId: 'test-unknown',
    requestScope: 'agent-readiness',
    intentFingerprint: 'c'.repeat(64),
    fingerprint: 'd'.repeat(64),
    scope: 'inference-only',
    status: 'passed',
    observedAt: '2026-09-19T00:01:00.000Z',
  }), { code: 'AGENT_READINESS_REQUEST_CONFLICT' })
  const document = JSON.parse(await readFile(filePath, 'utf8'))
  assert.equal(document.schema, 'chimera.agent-readiness.v1')
  assert.equal(document.records[0].status, 'unknown')
  assert.equal(document.records.length, 1)
})

test('auto selection without a positive eligible status cannot pass readiness', () => {
  const readiness = buildAgentReadiness({
    manifest: { ...manifest(), enabled: true },
    continuity: continuity({}),
    selection: { mode: 'auto', eligible: false },
    access: { profileId: 'sandbox', network: 'none' },
    executor: { kind: 'harness', status: 'task-bound', identity: 'runtime-harness-v1' },
  })
  assert.equal(readiness.status, 'blocked')
  assert.equal(readiness.checks.find(row => row.name === 'model').status, 'blocked')
})

test('concurrent receipt writes serialize collisions and terminal receipts cannot be downgraded', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-agent-readiness-race-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = await DurableAgentReadinessStore.open({ filePath: join(directory, 'readiness.json'), audit: new MemoryAuditLog() })
  const base = {
    agentId: 'researcher',
    requestId: 'test-race',
    requestScope: 'agent-readiness',
    fingerprint: 'b'.repeat(64),
    scope: 'inference-only',
    observedAt: '2026-09-19T00:00:00.000Z',
  }
  const [first, second] = await Promise.allSettled([
    store.record({ ...base, intentFingerprint: 'a'.repeat(64), status: 'pending' }),
    store.record({ ...base, intentFingerprint: 'c'.repeat(64), status: 'pending' }),
  ])
  assert.equal([first, second].filter(result => result.status === 'fulfilled').length, 1)
  assert.equal([first, second].find(result => result.status === 'rejected').reason.code, 'AGENT_READINESS_REQUEST_CONFLICT')
  await store.record({ ...base, intentFingerprint: 'a'.repeat(64), status: 'passed', result: { status: 'passed', answer: 'must not persist' } })
  const terminal = await store.record({ ...base, intentFingerprint: 'a'.repeat(64), status: 'pending' })
  assert.equal(terminal.status, 'passed')
  assert.equal(terminal.result.answer, undefined)
})
