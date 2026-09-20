import assert from 'node:assert/strict'
import test from 'node:test'
import { projectConnection } from '../src/connections/state.mjs'

test('catalog discovery is not verification and a new revision invalidates it', () => {
  const base = {
    providerId: 'fixture',
    enabled: true,
    revision: 2,
    machineRef: 'fixture-machine',
    accountRef: null,
    signedIn: true,
    catalogAvailable: true,
    error: null,
  }

  assert.equal(projectConnection(base).status, 'available')
  assert.equal(projectConnection({ ...base, lastVerification: {
    revision: 1,
    machineRef: 'fixture-machine',
    operation: 'model-invoke',
    status: 'passed',
    at: '2026-09-18T00:00:00.000Z',
  } }).status, 'available')
  assert.equal(projectConnection({ ...base, enabled: false }).status, 'not-connected')
})

test('current verification identifies its operation and never projects provider output', () => {
  const state = projectConnection({
    providerId: 'fixture',
    enabled: true,
    revision: 4,
    machineRef: 'fixture-machine',
    accountRef: 'fixture-account',
    signedIn: true,
    catalogAvailable: true,
    lastVerification: {
      revision: 4,
      machineRef: 'fixture-machine',
      operation: 'model-invoke',
      model: 'fixture-model',
      status: 'passed',
      at: '2026-09-18T00:00:00.000Z',
      output: 'provider output must not be retained',
      token: 'provider token must not be retained',
    },
    operations: { refresh: true, 'test-safe': true, 'test-model': true, disconnect: true },
  })

  assert.equal(state.status, 'verified')
  assert.deepEqual(state.provenance, {
    machineRef: 'fixture-machine',
    accountRef: 'fixture-account',
    signedIn: true,
  })
  assert.deepEqual(state.verification, {
    revision: 4,
    machineRef: 'fixture-machine',
    operation: 'model-invoke',
    model: 'fixture-model',
    status: 'passed',
    at: '2026-09-18T00:00:00.000Z',
  })
  assert.equal(state.operations.connect, false)
  assert.equal(state.operations.refresh, true)
  assert.equal(state.operations['test-safe'], true)
  assert.equal(state.operations['test-model'], true)
  assert.equal(state.operations.disconnect, true)
  assert.doesNotMatch(JSON.stringify(state), /provider output|provider token/i)
})

test('errors take precedence over catalog and signed-in claims without leaking error text', () => {
  const state = projectConnection({
    providerId: 'fixture',
    enabled: true,
    revision: 1,
    machineRef: 'fixture-machine',
    signedIn: true,
    catalogAvailable: true,
    error: { code: 'FIXTURE_AUTH_REQUIRED', message: 'secret=do-not-project' },
  })

  assert.equal(state.status, 'needs-attention')
  assert.deepEqual(state.error, { code: 'FIXTURE_AUTH_REQUIRED' })
  assert.doesNotMatch(JSON.stringify(state), /do-not-project|secret=/i)
})

test('verification becomes historical when the selected model or executor binding changes', () => {
  const base = {
    providerId: 'fixture', enabled: true, revision: 4, machineRef: 'fixture-machine',
    accountRef: 'fixture-account', signedIn: true, catalogAvailable: true,
    selectedModel: 'fixture-model', executor: 'inference-only',
    lastVerification: {
      revision: 4, machineRef: 'fixture-machine', accountRef: 'fixture-account', signedIn: true,
      operation: 'test-model', model: 'fixture-model', executor: 'inference-only', status: 'passed',
      at: '2026-09-18T00:00:00.000Z',
    },
  }
  assert.equal(projectConnection(base).status, 'verified')
  assert.equal(projectConnection({ ...base, selectedModel: 'other-model' }).status, 'available')
  assert.equal(projectConnection({ ...base, executor: 'task-harness' }).status, 'available')
})

test('inference verification requires positive current catalog and executor evidence', () => {
  const base = {
    providerId: 'fixture', enabled: true, revision: 4, machineRef: 'fixture-machine',
    accountRef: 'fixture-account', signedIn: true, catalogAvailable: true,
    models: [{ id: 'fixture-model' }], executor: 'inference-only',
    lastVerification: {
      revision: 4, machineRef: 'fixture-machine', accountRef: 'fixture-account', signedIn: true,
      operation: 'test-model', model: 'fixture-model', executor: 'inference-only', status: 'passed',
      at: '2026-09-18T00:00:00.000Z',
    },
  }
  assert.equal(projectConnection(base).status, 'verified')
  assert.equal(projectConnection({ ...base, models: [{ id: 'replacement-model' }] }).status, 'available')
  assert.equal(projectConnection({ ...base, models: [], catalogAvailable: false }).status, 'signed-in')
  assert.equal(projectConnection({ ...base, executor: undefined }).status, 'available')
})
