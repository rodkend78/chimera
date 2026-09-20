import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveTaskOutcomes } from '../src/ceo/task-outcomes.mjs'

const task = { taskId: 'alpha', status: 'completed', objective: 'Produce the alpha result.' }

function receipt({ receiptId, kind, source, outcome, evidenceRef, revision = 'rev-1', observedAt = '2026-09-19T10:00:00.000Z' }) {
  return { receiptId, kind, taskId: 'alpha', source, operationId: `${receiptId}-operation`, revision, observedAt, outcome, evidenceRef }
}

test('completed prose cannot claim verified checks or publication', () => {
  const value = deriveTaskOutcomes({ task: { ...task, summary: 'Tests passed and deployed.' }, receipts: [], review: null, currentRevision: null })
  assert.equal(value.checksPassed.state, 'not-run')
  assert.equal(value.published.state, 'not-published')
  assert.equal(value.readyForReview.state, 'not-reviewed')
  assert.deepEqual(value.checksPassed.evidenceRefs, [])
})

test('runtime receipts derive work, checks, review readiness, and publication only at one revision', () => {
  const receipts = [
    receipt({
      receiptId: 'artifact-1', kind: 'artifact', source: 'worker-artifact-store',
      outcome: { status: 'materialized', artifactId: 'artifact-1', sessionId: 'session-1', agentId: 'ace', hash: 'a'.repeat(64), size: 12, scope: 'task:alpha' },
      evidenceRef: 'artifact-1',
    }),
    receipt({
      receiptId: 'check-1', kind: 'check', source: 'bounded-check',
      outcome: { status: 'passed', command: 'npm test -- alpha', scope: 'task:alpha@rev-1', exitCode: 0, signal: null },
      evidenceRef: 'check-1', observedAt: '2026-09-19T10:01:00.000Z',
    }),
    receipt({
      receiptId: 'review-1', kind: 'review', source: 'project-review',
      outcome: { status: 'current', reviewDigest: 'digest-1', scope: 'task:alpha@rev-1', identity: { checkoutCommit: 'commit-1', workingTreeDigest: 'tree-1' } },
      evidenceRef: 'review-1', observedAt: '2026-09-19T10:02:00.000Z',
    }),
    receipt({
      receiptId: 'publish-1', kind: 'publication', source: 'publishing-adapter',
      outcome: { status: 'published', path: '/alpha', revision: 'rev-1', scope: 'task:alpha@rev-1' },
      evidenceRef: 'publish-1', observedAt: '2026-09-19T10:03:00.000Z',
    }),
    receipt({
      receiptId: 'verify-1', kind: 'publication', source: 'current-path-verifier',
      outcome: { status: 'verified', path: '/alpha', revision: 'rev-1', scope: 'task:alpha@rev-1' },
      evidenceRef: 'verify-1', observedAt: '2026-09-19T10:04:00.000Z',
    }),
  ]
  const value = deriveTaskOutcomes({
    task,
    receipts,
    review: { taskId: 'alpha', reviewDigest: 'digest-1', revision: 'rev-1', observedAt: '2026-09-19T10:02:00.000Z', identity: { checkoutCommit: 'commit-1', workingTreeDigest: 'tree-1' } },
    currentRevision: 'rev-1',
  })
  assert.equal(value.workProduced.state, 'observed')
  assert.equal(value.checksPassed.state, 'passed')
  assert.equal(value.readyForReview.state, 'ready')
  assert.equal(value.published.state, 'published')
  assert.deepEqual(value.checksPassed.evidenceRefs, ['check-1'])
  assert.equal(value.readyForReview.scope, 'task:alpha@rev-1')
  assert.equal(value.published.observedAt, '2026-09-19T10:04:00.000Z')
})

test('a failed required check and stale review keep outcomes conservative', () => {
  const value = deriveTaskOutcomes({
    task,
    receipts: [
      receipt({
        receiptId: 'check-failed', kind: 'check', source: 'bounded-check',
        outcome: { status: 'failed', command: 'npm test -- alpha', scope: 'task:alpha@rev-1', exitCode: 1 }, evidenceRef: 'check-failed',
      }),
      receipt({
        receiptId: 'review-old', kind: 'review', source: 'project-review', revision: 'rev-0',
        outcome: { status: 'current', reviewDigest: 'old-digest', scope: 'task:alpha@rev-0', identity: { checkoutCommit: 'old' } }, evidenceRef: 'review-old',
      }),
    ],
    review: { taskId: 'alpha', reviewDigest: 'old-digest', revision: 'rev-0', observedAt: '2026-09-19T10:00:00.000Z', identity: { checkoutCommit: 'old' } },
    currentRevision: 'rev-1',
  })
  assert.equal(value.checksPassed.state, 'failed')
  assert.equal(value.readyForReview.state, 'stale')
  assert.equal(value.published.state, 'not-published')
})

test('a source commit and unverified publication text never produce a published outcome', () => {
  const value = deriveTaskOutcomes({
    task: { ...task, result: { summary: 'Committed and deployed.' } },
    receipts: [
      receipt({ receiptId: 'commit-1', kind: 'artifact', source: 'project-review', outcome: { status: 'committed', commit: 'abc123', scope: 'task:alpha@rev-1' }, evidenceRef: 'commit-1' }),
      receipt({ receiptId: 'publish-unknown', kind: 'publication', source: 'publishing-adapter', outcome: { status: 'unverified', path: '/alpha', scope: 'task:alpha@rev-1' }, evidenceRef: 'publish-unknown' }),
    ],
    review: null,
    currentRevision: 'rev-1',
  })
  assert.equal(value.published.state, 'unverified')
  assert.notEqual(value.published.state, 'published')
})

test('a passed check with a nonzero exit or signal is inconsistent evidence', () => {
  const value = deriveTaskOutcomes({
    task,
    receipts: [
      receipt({
        receiptId: 'check-inconsistent-exit', kind: 'check', source: 'bounded-check',
        outcome: { status: 'passed', command: 'npm test -- alpha', scope: 'task:alpha@rev-1', exitCode: 7 },
        evidenceRef: 'check-inconsistent-exit',
      }),
      receipt({
        receiptId: 'check-inconsistent-signal', kind: 'check', source: 'bounded-check',
        outcome: { status: 'passed', command: 'npm test -- alpha', scope: 'task:alpha@rev-1', exitCode: 0, signal: 'SIGTERM' },
        evidenceRef: 'check-inconsistent-signal',
      }),
    ],
    currentRevision: 'rev-1',
  })
  assert.equal(value.checksPassed.state, 'unknown')
})

test('materialized task artifacts stand on their own without a project revision', () => {
  const wrongTask = {
    ...receipt({
      receiptId: 'artifact-wrong-task', kind: 'artifact', source: 'worker-artifact-store',
      outcome: { status: 'materialized', artifactId: 'wrong', sessionId: 'session-wrong', agentId: 'ace', hash: 'b'.repeat(64), size: 2, scope: 'task:other' },
      evidenceRef: 'artifact-wrong-task',
    }),
    taskId: 'other-task',
  }
  const value = deriveTaskOutcomes({
    task,
    receipts: [
      receipt({
        receiptId: 'artifact-standalone', kind: 'artifact', source: 'worker-artifact-store',
        outcome: { status: 'materialized', artifactId: 'artifact-standalone', sessionId: 'session-1', agentId: 'ace', hash: 'a'.repeat(64), size: 12, scope: 'task:alpha' },
        evidenceRef: 'artifact-standalone', revision: 'worker-session-1',
      }),
      wrongTask,
    ],
    review: null,
    currentRevision: null,
  })
  assert.equal(value.workProduced.state, 'observed')
  assert.deepEqual(value.workProduced.evidenceRefs, ['artifact-standalone'])
})

test('an old-revision failed check does not poison a valid current-revision pass', () => {
  const value = deriveTaskOutcomes({
    task,
    receipts: [
      receipt({
        receiptId: 'check-old-failed', kind: 'check', source: 'bounded-check', revision: 'rev-0',
        outcome: { status: 'failed', command: 'npm test -- alpha', scope: 'task:alpha@rev-0', exitCode: 1 },
        evidenceRef: 'check-old-failed',
      }),
      receipt({
        receiptId: 'check-current-passed', kind: 'check', source: 'bounded-check', revision: 'rev-1',
        outcome: { status: 'passed', command: 'npm test -- alpha', scope: 'task:alpha@rev-1', exitCode: 0, signal: null },
        evidenceRef: 'check-current-passed',
      }),
    ],
    currentRevision: 'rev-1',
  })
  assert.equal(value.checksPassed.state, 'passed')
  assert.deepEqual(value.checksPassed.evidenceRefs, ['check-current-passed'])
})

test('an explicitly truncated evidence set fails closed for aggregate outcome stages', () => {
  const value = deriveTaskOutcomes({
    task: { ...task, evidenceTruncated: true },
    receipts: [receipt({
      receiptId: 'check-current-passed', kind: 'check', source: 'bounded-check',
      outcome: { status: 'passed', command: 'npm test -- alpha', scope: 'task:alpha@rev-1', exitCode: 0, signal: null },
      evidenceRef: 'check-current-passed',
    })],
    currentRevision: 'rev-1',
  })
  assert.equal(value.checksPassed.state, 'unknown')
  assert.equal(value.workProduced.state, 'unknown')
  assert.equal(value.published.state, 'unverified')
})
