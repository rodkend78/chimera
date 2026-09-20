import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoryAuditLog } from '../src/audit-log.mjs'
import { DurableConnectionPolicy } from '../src/connections/policy.mjs'
import { ConnectionService } from '../src/connections/service.mjs'
import { DurableVerificationReceiptStore } from '../src/agents/readiness-store.mjs'

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-connection-service-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const policy = await DurableConnectionPolicy.open({ filePath: join(directory, 'connections.json'), audit: new MemoryAuditLog() })
  const calls = []
  const adapter = {
    state: () => ({ signedIn: true, catalogAvailable: true, models: [{ id: 'fixture-model' }], executor: 'inference-only', ...(overrides.state ?? {}) }),
    operations: {
      refresh: async () => { calls.push('refresh') },
      'test-safe': async () => { calls.push('test-safe'); return { costClass: 'free' } },
      'test-model': async input => { calls.push({ operation: 'test-model', ...input }); return { costClass: 'quota', modelCallSent: true } },
      reconnect: async () => { calls.push('reconnect') },
      connect: async () => { calls.push('connect') },
      disconnect: true,
      ...(overrides.operations ?? {}),
    },
  }
  const service = new ConnectionService({ policy, adapters: { fixture: adapter }, machineRef: 'fixture-machine' })
  return { directory, policy, adapter, service, calls }
}

test('connection service lists adapter state without refreshing or probing', async t => {
  const f = await fixture(t)
  assert.equal(f.service.list()[0].status, 'available')
  assert.deepEqual(f.calls, [])
})

test('disconnect fences a captured model or connector dispatch after restart', async t => {
  const f = await fixture(t)
  const dispatch = f.service.guard('fixture', async () => { f.calls.push('dispatch'); return 'done' })
  assert.equal(await dispatch(), 'done')
  const action = await f.service.act({ providerId: 'fixture', operation: 'disconnect', requestId: 'disconnect-1' })
  assert.equal(action.state.status, 'not-connected')
  await assert.rejects(() => dispatch(), { code: 'CONNECTION_DISABLED' })
  assert.deepEqual(f.calls, ['dispatch'])
  const reopened = await DurableConnectionPolicy.open({ filePath: join(f.directory, 'connections.json'), audit: new MemoryAuditLog() })
  const restarted = new ConnectionService({ policy: reopened, adapters: { fixture: f.adapter }, machineRef: 'fixture-machine' })
  await assert.rejects(() => restarted.guard('fixture', async () => 'must-not-run')(), { code: 'CONNECTION_DISABLED' })
})

test('model testing is explicit, exact, quota-confirmed, and single-flight', async t => {
  const f = await fixture(t)
  await assert.rejects(() => f.service.act({ providerId: 'fixture', operation: 'test-model', model: 'fixture-model', requestId: 'model-no-consent' }), { code: 'CONNECTION_QUOTA_CONFIRMATION_REQUIRED' })
  await assert.rejects(() => f.service.act({ providerId: 'fixture', operation: 'test-model', model: 'other-model', requestId: 'model-wrong', allowQuotaUse: true }), { code: 'CONNECTION_MODEL_MISMATCH' })
  const first = f.service.act({ providerId: 'fixture', operation: 'test-model', model: 'fixture-model', requestId: 'model-1', allowQuotaUse: true })
  const second = f.service.act({ providerId: 'fixture', operation: 'test-model', model: 'fixture-model', requestId: 'model-1', allowQuotaUse: true })
  const [one, two] = await Promise.all([first, second])
  assert.deepEqual(one.receipt, two.receipt)
  assert.equal(f.calls.filter(call => call.operation === 'test-model').length, 1)
})

test('unknown provider acknowledgement is retained and never automatically resubmitted', async t => {
  const f = await fixture(t, { operations: {
    'test-safe': async () => { f?.calls.push('unknown'); throw Object.assign(new Error('lost'), { code: 'CONNECTION_RESPONSE_LOST' }) },
  } })
  await assert.rejects(() => f.service.act({ providerId: 'fixture', operation: 'test-safe', requestId: 'unknown-1' }), error => error.code === 'CONNECTION_OPERATION_UNKNOWN' && error.receipt.status === 'unknown')
  await assert.rejects(() => f.service.act({ providerId: 'fixture', operation: 'test-safe', requestId: 'unknown-1' }), error => error.code === 'CONNECTION_OPERATION_UNKNOWN' && error.receipt.status === 'unknown')
  assert.equal(f.calls.filter(call => call === 'unknown').length, 1)
})

test('signed model outcome ambiguity is retained and never treated as retryable', async t => {
  const f = await fixture(t, { operations: {
    'test-model': async () => {
      f?.calls.push('model-unknown')
      throw Object.assign(new Error('model outcome unknown'), { code: 'MODEL_CALL_OUTCOME_UNKNOWN' })
    },
  } })
  await assert.rejects(() => f.service.act({ providerId: 'fixture', operation: 'test-model', model: 'fixture-model', requestId: 'model-unknown-1', allowQuotaUse: true }), error => error.code === 'CONNECTION_OPERATION_UNKNOWN' && error.receipt.status === 'unknown')
  await assert.rejects(() => f.service.act({ providerId: 'fixture', operation: 'test-model', model: 'fixture-model', requestId: 'model-unknown-1', allowQuotaUse: true }), error => error.code === 'CONNECTION_OPERATION_UNKNOWN' && error.receipt.status === 'unknown')
  assert.equal(f.calls.filter(call => call === 'model-unknown').length, 1)
})

test('failed reconnect does not re-enable the old disabled binding', async t => {
  const f = await fixture(t, { operations: {
    reconnect: async () => { throw Object.assign(new Error('offline'), { code: 'FIXTURE_OFFLINE' }) },
  } })
  await f.service.act({ providerId: 'fixture', operation: 'disconnect', requestId: 'disconnect-before-reconnect' })
  await assert.rejects(() => f.service.act({ providerId: 'fixture', operation: 'reconnect', requestId: 'reconnect-fails' }), { code: 'FIXTURE_OFFLINE' })
  assert.equal(f.service.state('fixture').enabled, false)
})

test('a reconnect that started before disconnect cannot re-enable a newer revision', async t => {
  let startedResolve
  let releaseResolve
  const started = new Promise(resolve => { startedResolve = resolve })
  const released = new Promise(resolve => { releaseResolve = resolve })
  const f = await fixture(t, { operations: {
    reconnect: async () => { startedResolve(); await released },
  } })
  const reconnect = f.service.act({ providerId: 'fixture', operation: 'reconnect', requestId: 'reconnect-race' })
  await started
  await f.service.act({ providerId: 'fixture', operation: 'disconnect', requestId: 'disconnect-race' })
  releaseResolve()
  await assert.rejects(() => reconnect, { code: 'CONNECTION_REVISION_STALE' })
  assert.equal(f.service.state('fixture').enabled, false)
})

test('disconnect captures its revision so a concurrent policy mutation cannot be overwritten', async t => {
  let startedResolve
  let releaseResolve
  const started = new Promise(resolve => { startedResolve = resolve })
  const released = new Promise(resolve => { releaseResolve = resolve })
  const f = await fixture(t)
  const originalSetEnabled = f.policy.setEnabled.bind(f.policy)
  let disconnectArguments
  f.policy.setEnabled = async (...args) => {
    if (args[1] === false && args[2]?.changedBy === 'operator') {
      disconnectArguments = args
      startedResolve()
      await released
    }
    return originalSetEnabled(...args)
  }

  const disconnect = f.service.act({ providerId: 'fixture', operation: 'disconnect', requestId: 'disconnect-revision-race' })
  await started
  await originalSetEnabled('fixture', true, { changedBy: 'external' })
  releaseResolve()
  await assert.rejects(() => disconnect, { code: 'CONNECTION_REVISION_STALE' })
  assert.equal(disconnectArguments[2].expectedRevision, 0)
  assert.equal(f.service.state('fixture').enabled, true)
})

test('an explicit refresh records an account/session binding change as a new revision', async t => {
  const state = { accountRef: 'account-one', signedIn: true }
  const f = await fixture(t, {
    state,
    operations: {
      refresh: async () => { state.accountRef = 'account-two' },
    },
  })
  assert.equal(f.service.state('fixture').revision, 0)
  const result = await f.service.act({ providerId: 'fixture', operation: 'refresh', requestId: 'account-change' })
  assert.equal(result.state.revision, 1)
  assert.equal(result.state.provenance.accountRef, 'account-two')
  assert.equal(f.service.state('fixture').revision, 1)
})

test('action rejects extra fields instead of allowing an unregistered dispatch shape', async t => {
  const f = await fixture(t)
  await assert.rejects(() => f.service.act({ providerId: 'fixture', operation: 'refresh', requestId: 'extra-1', forged: true }), { code: 'CONNECTION_ACTION_INVALID' })
  assert.deepEqual(f.calls, [])
})

test('durable connection receipts preserve unknown outcomes across reopen and exact lookup', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-connection-receipts-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const policy = await DurableConnectionPolicy.open({ filePath: join(directory, 'connections.json'), audit: new MemoryAuditLog() })
  const receiptFile = join(directory, 'receipts.json')
  const firstStore = await DurableVerificationReceiptStore.open({ filePath: receiptFile, audit: new MemoryAuditLog() })
  let calls = 0
  const adapter = {
    state: () => ({ signedIn: true, catalogAvailable: true, models: [{ id: 'fixture-model' }], executor: 'inference-only' }),
    operations: {
      'test-model': async () => { calls += 1; throw Object.assign(new Error('lost'), { code: 'CONNECTION_RESPONSE_LOST' }) },
    },
  }
  const first = new ConnectionService({ policy, adapters: { fixture: adapter }, machineRef: 'fixture-machine', receiptStore: firstStore })
  await assert.rejects(() => first.act({ providerId: 'fixture', operation: 'test-model', model: 'fixture-model', requestId: 'durable-unknown', allowQuotaUse: true }), error => error.code === 'CONNECTION_OPERATION_UNKNOWN' && error.receipt.status === 'unknown')
  assert.equal(calls, 1)
  const reopenedStore = await DurableVerificationReceiptStore.open({ filePath: receiptFile, audit: new MemoryAuditLog() })
  const restarted = new ConnectionService({ policy, adapters: { fixture: adapter }, machineRef: 'fixture-machine', receiptStore: reopenedStore })
  await assert.rejects(() => restarted.act({ providerId: 'fixture', operation: 'test-model', model: 'fixture-model', requestId: 'durable-unknown', allowQuotaUse: true }), error => Boolean(error.code === 'CONNECTION_OPERATION_UNKNOWN' && error.receipt.status === 'unknown' && error.receipt.at))
  assert.equal(calls, 1)
  const receipt = await restarted.receipt('fixture', 'durable-unknown')
  assert.equal(receipt.receipt.status, 'unknown')
})

test('durable connection unknown binding fences a fresh request id after reopen', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-connection-fresh-id-fence-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const policy = await DurableConnectionPolicy.open({ filePath: join(directory, 'connections.json'), audit: new MemoryAuditLog() })
  const receiptFile = join(directory, 'receipts.json')
  const calls = []
  const adapter = {
    state: () => ({ signedIn: true, catalogAvailable: true, models: [{ id: 'fixture-model' }], executor: 'inference-only' }),
    operations: {
      'test-model': async () => {
        calls.push('test-model')
        throw Object.assign(new Error('lost'), { code: 'CONNECTION_RESPONSE_LOST' })
      },
    },
  }
  const firstStore = await DurableVerificationReceiptStore.open({ filePath: receiptFile, audit: new MemoryAuditLog() })
  const first = new ConnectionService({ policy, adapters: { fixture: adapter }, machineRef: 'fixture-machine', receiptStore: firstStore })
  await assert.rejects(() => first.act({ providerId: 'fixture', operation: 'test-model', model: 'fixture-model', requestId: 'fresh-fence-a', allowQuotaUse: true }), { code: 'CONNECTION_OPERATION_UNKNOWN' })

  const reopenedStore = await DurableVerificationReceiptStore.open({ filePath: receiptFile, audit: new MemoryAuditLog() })
  const restarted = new ConnectionService({ policy, adapters: { fixture: adapter }, machineRef: 'fixture-machine', receiptStore: reopenedStore })
  await assert.rejects(() => restarted.act({ providerId: 'fixture', operation: 'test-model', model: 'fixture-model', requestId: 'fresh-fence-b', allowQuotaUse: true }), error => error.code === 'CONNECTION_OPERATION_UNKNOWN' && error.receipt.requestId === 'fresh-fence-a')
  assert.deepEqual(calls, ['test-model'])
  const projected = restarted.state('fixture')
  assert.equal(projected.verification.status, 'unknown')
  assert.equal(projected.status, 'needs-attention')
})

test('durable passed verification is restored only for the same account and session binding', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-connection-binding-projection-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const policy = await DurableConnectionPolicy.open({ filePath: join(directory, 'connections.json'), audit: new MemoryAuditLog() })
  const receiptFile = join(directory, 'receipts.json')
  const state = { accountRef: 'account-a', signedIn: true, sessionStatus: 'ready' }
  const adapter = {
    state: () => ({ ...state, catalogAvailable: true, models: [{ id: 'fixture-model' }], executor: 'inference-only' }),
    operations: { 'test-model': async () => ({ costClass: 'free', modelCallSent: false }) },
  }
  const firstStore = await DurableVerificationReceiptStore.open({ filePath: receiptFile, audit: new MemoryAuditLog() })
  const first = new ConnectionService({ policy, adapters: { fixture: adapter }, machineRef: 'fixture-machine', receiptStore: firstStore })
  const result = await first.act({ providerId: 'fixture', operation: 'test-model', model: 'fixture-model', requestId: 'binding-pass', allowQuotaUse: true })
  assert.equal(result.state.status, 'verified')

  const reopenedStore = await DurableVerificationReceiptStore.open({ filePath: receiptFile, audit: new MemoryAuditLog() })
  const restarted = new ConnectionService({ policy, adapters: { fixture: adapter }, machineRef: 'fixture-machine', receiptStore: reopenedStore })
  assert.equal(restarted.state('fixture').status, 'verified')
  state.accountRef = 'account-b'
  assert.notEqual(restarted.state('fixture').status, 'verified')
  state.accountRef = 'account-a'
  state.sessionStatus = 'expired'
  assert.notEqual(restarted.state('fixture').status, 'verified')
})

test('a model test records the dispatch binding when account and session change while it is held', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-connection-held-binding-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const policy = await DurableConnectionPolicy.open({ filePath: join(directory, 'connections.json'), audit: new MemoryAuditLog() })
  const receiptFile = join(directory, 'receipts.json')
  const state = { accountRef: 'account-a', signedIn: true, sessionStatus: 'ready' }
  let startedResolve
  let releaseResolve
  const started = new Promise(resolve => { startedResolve = resolve })
  const released = new Promise(resolve => { releaseResolve = resolve })
  const adapter = {
    state: () => ({ ...state, catalogAvailable: true, models: [{ id: 'fixture-model' }], executor: 'inference-only' }),
    operations: {
      'test-model': async () => {
        startedResolve()
        await released
        return { costClass: 'free', modelCallSent: false }
      },
    },
  }
  const firstStore = await DurableVerificationReceiptStore.open({ filePath: receiptFile, audit: new MemoryAuditLog() })
  const first = new ConnectionService({ policy, adapters: { fixture: adapter }, machineRef: 'fixture-machine', receiptStore: firstStore })
  const operation = first.act({ providerId: 'fixture', operation: 'test-model', model: 'fixture-model', requestId: 'held-binding', allowQuotaUse: true })
  await started
  state.accountRef = 'account-b'
  state.sessionStatus = 'expired'
  releaseResolve()
  const result = await operation
  assert.notEqual(result.state.status, 'verified')
  const persisted = await firstStore.getRequest({ agentId: 'connection', requestScope: 'fixture', requestId: 'held-binding' })
  assert.equal(persisted.status, 'passed')
  assert.equal(persisted.result.accountRef, 'account-a')
  assert.equal(persisted.result.sessionStatus, 'ready')
  assert.equal(persisted.result.revision, 0)

  const reopenedStore = await DurableVerificationReceiptStore.open({ filePath: receiptFile, audit: new MemoryAuditLog() })
  const restarted = new ConnectionService({ policy, adapters: { fixture: adapter }, machineRef: 'fixture-machine', receiptStore: reopenedStore })
  assert.notEqual(restarted.state('fixture').status, 'verified')
  const restored = await restarted.receipt('fixture', 'held-binding')
  assert.equal(restored.receipt.accountRef, 'account-a')
  assert.equal(restored.receipt.sessionStatus, 'ready')
})
