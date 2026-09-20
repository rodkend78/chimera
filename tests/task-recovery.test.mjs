import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyTaskRecovery } from '../src/ceo/task-recovery.mjs'

const specialistBinding = {
  taskId: 'alpha', nodeId: 'one', assignmentId: 'assignment-1', agentId: 'ace', stage: 'specialist',
}

test('an unknown dispatched call has no retry action', () => {
  const value = classifyTaskRecovery({
    task: { taskId: 'alpha', status: 'failed' },
    modelCalls: [{ binding: specialistBinding, status: 'ambiguous', operationId: 'call-1' }],
    approvals: [], connection: null, cleanup: null,
  })
  assert.equal(value.state, 'unknown')
  assert.equal(value.retryAllowed, false)
  assert.equal(value.actions.some(action => action.id === 'retry'), false)
  assert.equal(value.actions.some(action => action.id === 'inspect'), true)
  assert.equal(value.retained[0].operationId, 'call-1')
})

test('a trusted pre-dispatch denial permits one explicit retry', () => {
  const value = classifyTaskRecovery({
    task: { taskId: 'alpha', status: 'failed', failure: { code: 'CONNECTION_DISABLED', dispatchState: 'not_sent' } },
    modelCalls: [{ binding: specialistBinding, status: 'failed-not-sent', operationId: 'call-1', failure: { dispatchState: 'not_sent' } }],
    steps: [], approvals: [], connection: { status: 'connected' }, cleanup: null,
  })
  assert.equal(value.state, 'retryable')
  assert.equal(value.retryAllowed, true)
  assert.equal(value.actions.some(action => action.id === 'retry'), true)
})

test('a later parallel success cannot erase an unknown sibling or permit retry', () => {
  const value = classifyTaskRecovery({
    task: { taskId: 'alpha', status: 'failed', failure: { dispatchState: 'not_sent' }, checkpoint: { effectOutcome: 'completed' } },
    modelCalls: [],
    steps: [
      { nodeId: 'one', status: 'completed', effectOutcome: 'completed', operationId: 'op-one' },
      { nodeId: 'two', status: 'completed', effectOutcome: 'unknown', operationId: 'op-two' },
    ],
    approvals: [], connection: { status: 'connected' }, cleanup: { status: 'complete' },
  })
  assert.equal(value.state, 'unknown')
  assert.equal(value.retryAllowed, false)
  assert.equal(value.retained.some(item => item.operationId === 'op-one'), true)
  assert.equal(value.retained.some(item => item.operationId === 'op-two'), true)
})

test('restart-paused queued work offers resume only, while disconnected reads remain safe', () => {
  const value = classifyTaskRecovery({
    task: { taskId: 'queued', status: 'queued', recoveryRequired: true, queuedForExecution: true },
    modelCalls: [], steps: [], approvals: [], connection: { status: 'disconnected' }, cleanup: null,
  })
  assert.equal(value.state, 'paused')
  assert.equal(value.retryAllowed, false)
  assert.equal(value.actions.some(action => action.id === 'resume-queued'), true)
  assert.equal(value.actions.some(action => action.id === 'retry-read'), true)
  assert.equal(value.actions.some(action => action.id === 'retry'), false)
})

test('cleanup failure remains unknown and cannot be hidden by a completed checkpoint', () => {
  const value = classifyTaskRecovery({
    task: { taskId: 'alpha', status: 'failed', checkpoint: { effectOutcome: 'completed' } },
    modelCalls: [], steps: [{ nodeId: 'one', status: 'completed', effectOutcome: 'completed', operationId: 'op-one' }],
    approvals: [], connection: { status: 'connected' }, cleanup: { status: 'blocked', operationId: 'cleanup-1' },
  })
  assert.equal(value.state, 'unknown')
  assert.equal(value.retryAllowed, false)
  assert.equal(value.actions.some(action => action.id === 'inspect'), true)
  assert.equal(value.retained.some(item => item.operationId === 'cleanup-1'), true)
})

test('a model-call uncertainty beyond the retained output cap still blocks retry', () => {
  const modelCalls = Array.from({ length: 256 }, (_, index) => ({
    taskId: 'alpha', nodeId: 'one', assignmentId: `assignment-${index}`, agentId: 'ace', stage: 'specialist',
    status: 'succeeded', operationId: `call-${index}`,
  }))
  modelCalls.push({
    taskId: 'alpha', nodeId: 'one', assignmentId: 'assignment-unknown', agentId: 'ace', stage: 'specialist',
    status: 'ambiguous', operationId: 'call-unknown',
  })
  const value = classifyTaskRecovery({
    task: { taskId: 'alpha', status: 'failed', failure: { dispatchState: 'not_sent' } },
    modelCalls, steps: [], approvals: [], connection: { status: 'connected' }, cleanup: null,
  })
  assert.equal(value.state, 'unknown')
  assert.equal(value.retryAllowed, false)
})

test('legacy flat model-call fields are unbound, while a root binding may omit node and assignment IDs', () => {
  const legacy = classifyTaskRecovery({
    task: { taskId: 'alpha', status: 'failed', failure: { dispatchState: 'not_sent' } },
    modelCalls: [{ taskId: 'alpha', nodeId: 'one', assignmentId: 'assignment-1', agentId: 'ace', stage: 'specialist', status: 'succeeded' }],
    steps: [], approvals: [], connection: { status: 'connected' }, cleanup: null,
  })
  assert.equal(legacy.state, 'unknown')
  assert.equal(legacy.retryAllowed, false)

  const root = classifyTaskRecovery({
    task: { taskId: 'alpha', status: 'failed', failure: { dispatchState: 'not_sent' } },
    modelCalls: [{ binding: { taskId: 'alpha', nodeId: null, assignmentId: null, agentId: 'ceo', stage: 'decompose' }, status: 'succeeded' }],
    steps: [], approvals: [], connection: { status: 'connected' }, cleanup: null,
  })
  assert.equal(root.state, 'retryable')
  assert.equal(root.retryAllowed, true)
})

test('completed, running, and waiting-for-approval tasks retain truthful recovery states', () => {
  for (const [status, expected] of [
    ['completed', 'completed'],
    ['running', 'running'],
    ['waiting-for-approval', 'waiting-for-approval'],
  ]) {
    const value = classifyTaskRecovery({
      task: { taskId: 'alpha', status },
      modelCalls: [], steps: [], approvals: [], connection: { status: 'connected' }, cleanup: null,
    })
    assert.equal(value.state, expected)
    assert.equal(value.retryAllowed, false)
  }
})

test('unknown recovery exposes reconcile only when the connection explicitly supports it', () => {
  const unsupported = classifyTaskRecovery({
    task: { taskId: 'alpha', status: 'failed' },
    modelCalls: [{ binding: specialistBinding, status: 'ambiguous', operationId: 'call-unknown' }],
    steps: [], approvals: [], connection: { status: 'connected', supportsReconciliation: false }, cleanup: null,
  })
  assert.equal(unsupported.actions.some(action => action.id === 'inspect'), true)
  assert.equal(unsupported.actions.some(action => action.id === 'reconcile'), false)

  const supported = classifyTaskRecovery({
    task: { taskId: 'alpha', status: 'failed' },
    modelCalls: [{ binding: specialistBinding, status: 'ambiguous', operationId: 'call-unknown' }],
    steps: [], approvals: [], connection: { status: 'connected', supportsReconciliation: true }, cleanup: null,
  })
  assert.equal(supported.actions.some(action => action.id === 'reconcile'), true)
})

test('expired numeric approval timestamps block continuation without permitting replay', () => {
  const value = classifyTaskRecovery({
    task: { taskId: 'alpha', status: 'waiting-for-approval' },
    modelCalls: [], steps: [], approvals: [{ taskId: 'alpha', status: 'pending', expiresAt: Date.now() - 60_000 }],
    connection: { status: 'connected' }, cleanup: null,
  })
  assert.equal(value.state, 'blocked')
  assert.equal(value.retryAllowed, false)
  assert.equal(value.actions.some(action => action.id === 'retry'), false)
  assert.equal(value.retained.some(item => item.kind === 'approval'), true)
})

test('a resolved approval cannot expire later and turn a completed task into a blocker', () => {
  for (const expiresAt of [Date.now() - 60_000, new Date(Date.now() - 60_000).toISOString()]) {
    const value = classifyTaskRecovery({
      task: { taskId: 'alpha', status: 'completed' }, modelCalls: [], steps: [],
      approvals: [{ taskId: 'alpha', status: 'approved', expiresAt }],
      connection: { status: 'connected' }, cleanup: null,
    })
    assert.equal(value.state, 'completed')
    assert.equal(value.actions.some(action => action.id === 'retry'), false)
  }
})
