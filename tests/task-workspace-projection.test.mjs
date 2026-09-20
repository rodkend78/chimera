import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTaskWorkspace } from '../src/ceo/task-workspace-projection.mjs'

test('unbound and other-task approvals never appear as this task approval', () => {
  const value = buildTaskWorkspace({
    taskId: 'alpha',
    task: { taskId: 'alpha', status: 'running' },
    decisions: [{ actionId: 'a', taskId: 'alpha' }, { actionId: 'b', taskId: 'beta' }, { actionId: 'legacy' }],
    messages: [],
    leases: [],
    artifacts: [],
    browserBindings: [],
    routing: [],
  })
  assert.deepEqual(value.approvals.map(row => row.actionId), ['a'])
  assert.equal(value.browser, null)
  assert.throws(() => buildTaskWorkspace({ taskId: 'alpha', task: { taskId: 'beta' } }),
    { code: 'TASK_WORKSPACE_MISMATCH' })
})

test('object team and routing envelopes require an exact task binding', () => {
  const value = buildTaskWorkspace({
    taskId: 'alpha',
    task: { taskId: 'alpha', status: 'running' },
    team: { participants: ['unattributed-team'], deliveries: [{ messageId: 'unbound-delivery' }] },
    routing: { selected: { model: 'unattributed-model' } },
    messages: [], decisions: [], leases: [], artifacts: [], browserBindings: [],
  })
  assert.equal(value.team, null)
  assert.equal(value.routing, null)
})

test('selected workspace keeps every collection on the exact task identity', () => {
  const value = buildTaskWorkspace({
    taskId: 'alpha',
    task: { taskId: 'alpha', status: 'completed', summary: 'Alpha summary' },
    plan: { schema: 'chimera.task-plan.v2', revision: 7, planHash: 'a'.repeat(64), nodes: [{ nodeId: 'one', specialistAgentId: 'ace', objective: 'Do alpha', acceptanceCriteria: ['Report'], dependsOn: [] }], steps: [{ nodeId: 'one', status: 'completed' }] },
    team: { taskId: 'alpha', participants: ['ceo', 'ace'], deliveries: [{ messageId: 'alpha-delivery' }, { taskId: 'beta', messageId: 'wrong-delivery' }] },
    messages: [
      { messageId: 'alpha-result', taskId: 'alpha', conversationId: 'task:alpha', kind: 'structured_result', content: 'Alpha result' },
      { messageId: 'beta-result', taskId: 'beta', conversationId: 'task:beta', kind: 'structured_result', content: 'Beta result' },
      { messageId: 'wrong-room', taskId: 'alpha', conversationId: 'main', kind: 'structured_result', content: 'Wrong room' },
    ],
    decisions: [{ actionId: 'alpha-action', taskId: 'alpha' }, { actionId: 'beta-action', taskId: 'beta' }, { actionId: 'legacy' }],
    leases: [{ leaseId: 'alpha-lease', taskId: 'alpha' }, { leaseId: 'beta-lease', taskId: 'beta' }],
    artifacts: [{ artifactId: 'alpha-artifact', taskId: 'alpha', path: '/private/alpha', storageName: 'secret-alpha', name: 'alpha.txt' }, { artifactId: 'beta-artifact', taskId: 'beta', name: 'beta.txt' }],
    browserBindings: [{ leaseId: 'alpha-browser', taskId: 'alpha', agentId: 'ace', status: 'recorded', observedAt: 1789990000000, expiresAt: 1790000000000 }, { leaseId: 'beta-browser', taskId: 'beta' }, { leaseId: 'global-browser' }],
    review: { taskId: 'alpha', changedFiles: [{ path: 'alpha.txt', status: 'M' }], reviewDigest: 'digest', observedAt: '2026-09-18T12:00:00.000Z' },
    routing: [{ routeId: 'alpha-route', taskId: 'alpha' }, { routeId: 'beta-route', taskId: 'beta' }],
  })
  assert.equal(value.plan.revision, 7)
  assert.deepEqual(value.conversation.messages.map(row => row.messageId), ['alpha-result'])
  assert.deepEqual(value.results.reports.map(row => row.messageId), ['alpha-result'])
  assert.deepEqual(value.approvals.map(row => row.actionId), ['alpha-action'])
  assert.deepEqual(value.permissions.map(row => row.leaseId), ['alpha-lease'])
  assert.deepEqual(value.files.artifacts.map(row => row.artifactId), ['alpha-artifact'])
  assert.equal(value.files.artifacts[0].path, undefined)
  assert.equal(value.browser.leaseId, 'alpha-browser')
  assert.equal(value.browser.status, 'recorded')
  assert.deepEqual(value.routing.map(row => row.routeId), ['alpha-route'])
  assert.equal(value.files.status, 'current')
  assert.equal(value.team.deliveries.length, 1)
})

test('file review projection distinguishes unloaded, empty, and stale evidence', () => {
  const base = { taskId: 'alpha', task: { taskId: 'alpha', status: 'running' }, messages: [], decisions: [], leases: [], artifacts: [], browserBindings: [] }
  assert.equal(buildTaskWorkspace(base).files.status, 'unloaded')
  assert.equal(buildTaskWorkspace({ ...base, review: { taskId: 'alpha', changedFiles: [], observedAt: '2026-09-18T12:00:00.000Z' } }).files.status, 'empty')
  assert.equal(buildTaskWorkspace({ ...base, review: { taskId: 'alpha', stale: true, staleReason: 'commit', changedFiles: [{ path: 'a', status: 'M' }] } }).files.status, 'stale')
  assert.equal(buildTaskWorkspace(base).evidence.status, 'unavailable')
  assert.equal(buildTaskWorkspace(base).recovery.status, 'unavailable')
})

test('oversized review patches cannot erase stale evidence metadata', () => {
  const patch = '\\'.repeat(1_100_000)
  const value = buildTaskWorkspace({
    taskId: 'alpha', task: { taskId: 'alpha', status: 'running' }, messages: [], decisions: [], leases: [], artifacts: [], browserBindings: [],
    review: {
      taskId: 'alpha', stale: true, staleReason: 'known-session-mutation', observedAt: '2026-09-18T12:00:00.000Z', reviewDigest: 'digest',
      changedFiles: [{ path: 'large.txt', status: 'M' }], patch,
    },
  })
  assert.equal(value.files.status, 'stale')
  assert.equal(value.files.review.stale, true)
  assert.equal(value.files.review.staleReason, 'known-session-mutation')
  assert.equal(value.files.review.observedAt, '2026-09-18T12:00:00.000Z')
  assert.equal(value.files.review.reviewDigest, 'digest')
  assert.equal(value.files.review.patch, undefined)
  assert.equal(value.files.review.patchStatus, 'truncated')
})

test('selected workspace preserves receipt-backed outcomes and conservative recovery state', () => {
  const value = buildTaskWorkspace({
    taskId: 'alpha',
    task: { taskId: 'alpha', status: 'failed', failure: { code: 'MODEL_CALL_OUTCOME_UNKNOWN', message: 'An effect may have started.' } },
    messages: [], decisions: [], leases: [], artifacts: [], browserBindings: [],
    evidence: {
      workProduced: { state: 'observed', evidenceRefs: ['artifact-1'], observedAt: '2026-09-19T10:00:00.000Z', scope: 'task:alpha' },
      checksPassed: { state: 'passed', evidenceRefs: ['check-1'], observedAt: '2026-09-19T10:01:00.000Z', scope: 'task:alpha@rev-1' },
      readyForReview: { state: 'ready', evidenceRefs: ['review-1'], observedAt: '2026-09-19T10:02:00.000Z', scope: 'task:alpha@rev-1' },
      published: { state: 'not-published', evidenceRefs: [], observedAt: '2026-09-19T10:02:00.000Z', scope: 'task:alpha@rev-1' },
    },
    recovery: {
      state: 'unknown',
      summary: 'An external effect may have started; inspect before continuing.',
      retained: [{ kind: 'model-call', status: 'ambiguous', operationId: 'call-1' }],
      actions: [{ id: 'inspect', label: 'Inspect retained work', enabled: true }],
      retryAllowed: false,
    },
  })
  assert.equal(value.evidence.checksPassed.state, 'passed')
  assert.equal(value.evidence.published.state, 'not-published')
  assert.equal(value.recovery.state, 'unknown')
  assert.equal(value.recovery.retryAllowed, false)
  assert.equal(value.recovery.actions[0].id, 'inspect')
})
