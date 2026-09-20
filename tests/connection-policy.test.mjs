import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoryAuditLog } from '../src/audit-log.mjs'
import { DurableConnectionPolicy } from '../src/connections/policy.mjs'

test('connection policy persists a durable local disconnect and re-enable revision', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-connection-policy-'))
  const filePath = join(directory, 'connections.json')
  const audit = new MemoryAuditLog()
  t.after(() => rm(directory, { recursive: true, force: true }))

  const policy = await DurableConnectionPolicy.open({ filePath, audit })
  assert.deepEqual(policy.get('fixture'), { enabled: true, revision: 0 })
  assert.deepEqual(policy.setEnabled ? await policy.setEnabled('fixture', false, { changedBy: 'rod' }) : null, {
    providerId: 'fixture',
    enabled: false,
    revision: 1,
    changedBy: 'rod',
  })
  assert.deepEqual(policy.get('fixture'), { enabled: false, revision: 1 })
  assert.throws(() => policy.assertEnabled('fixture'), { code: 'CONNECTION_DISABLED' })

  const mode = (await stat(filePath)).mode & 0o777
  assert.equal(mode, 0o600)
  assert.doesNotMatch(await readFile(filePath, 'utf8'), /secret|token|credential/i)

  const reopened = await DurableConnectionPolicy.open({ filePath, audit })
  assert.deepEqual(reopened.get('fixture'), { enabled: false, revision: 1 })
  const enabled = await reopened.setEnabled('fixture', true, { changedBy: 'rod' })
  assert.equal(enabled.enabled, true)
  assert.equal(enabled.revision, 2)
  assert.doesNotThrow(() => reopened.assertEnabled('fixture'))
  assert.deepEqual(audit.entries().map(entry => entry.fact.kind), [
    'connection.policy.changed',
    'connection.policy.changed',
  ])
})

test('connection policy rejects malformed provider identities and actors', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-connection-policy-invalid-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const policy = await DurableConnectionPolicy.open({ filePath: join(directory, 'connections.json'), audit: new MemoryAuditLog() })

  assert.throws(() => policy.get('../fixture'), { code: 'CONNECTION_PROVIDER_INVALID' })
  await assert.rejects(() => policy.setEnabled('fixture', false, { changedBy: '' }), { code: 'CONNECTION_POLICY_ACTOR_INVALID' })
  await assert.rejects(() => policy.setEnabled('fixture', 'false', { changedBy: 'rod' }), { code: 'CONNECTION_ENABLED_INVALID' })
})

test('connection policy refuses an un-audited store and malformed persisted container', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-connection-policy-corrupt-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filePath = join(directory, 'connections.json')
  await assert.rejects(() => DurableConnectionPolicy.open({ filePath }), { code: 'CONNECTION_AUDIT_REQUIRED' })
  await writeFile(filePath, JSON.stringify({ providers: {} }), { mode: 0o600 })
  await assert.rejects(() => DurableConnectionPolicy.open({ filePath, audit: new MemoryAuditLog() }), { code: 'CONNECTION_POLICY_CORRUPT' })
  await writeFile(filePath, JSON.stringify({ schema: 'chimera.connection-policy.v1' }), { mode: 0o600 })
  await assert.rejects(() => DurableConnectionPolicy.open({ filePath, audit: new MemoryAuditLog() }), { code: 'CONNECTION_POLICY_CORRUPT' })
  await writeFile(filePath, JSON.stringify({ schema: 'chimera.connection-policy.v1', providers: null }), { mode: 0o600 })
  await assert.rejects(() => DurableConnectionPolicy.open({ filePath, audit: new MemoryAuditLog() }), { code: 'CONNECTION_POLICY_CORRUPT' })
  await writeFile(filePath, JSON.stringify({ schema: 'chimera.connection-policy.v1', providers: { fixture: { enabled: true, revision: 0, extra: 'reject-me' } } }), { mode: 0o600 })
  await assert.rejects(() => DurableConnectionPolicy.open({ filePath, audit: new MemoryAuditLog() }), { code: 'CONNECTION_POLICY_CORRUPT' })
})

test('connection policy fails closed when auditing a mutation is unavailable', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-connection-policy-audit-down-'))
  const filePath = join(directory, 'connections.json')
  t.after(() => rm(directory, { recursive: true, force: true }))
  let auditAvailable = true
  const audit = {
    append() {
      if (!auditAvailable) throw Object.assign(new Error('audit unavailable'), { code: 'CONNECTION_AUDIT_UNAVAILABLE' })
    },
  }
  const policy = await DurableConnectionPolicy.open({ filePath, audit })
  await policy.setEnabled('fixture', false, { changedBy: 'rod' })
  auditAvailable = false
  await assert.rejects(() => policy.setEnabled('fixture', true, { changedBy: 'rod' }), { code: 'CONNECTION_AUDIT_UNAVAILABLE' })
  assert.deepEqual(policy.get('fixture'), { enabled: false, revision: 1 })

  const reopened = await DurableConnectionPolicy.open({ filePath, audit: new MemoryAuditLog() })
  assert.deepEqual(reopened.get('fixture'), { enabled: false, revision: 1 })
})
