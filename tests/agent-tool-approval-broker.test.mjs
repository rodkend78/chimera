import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoryAuditLog } from '../src/audit-log.mjs'
import { DurableDecisionQueue, HumanDecisionHandler } from '../src/ceo/decisions.mjs'
import { signDecision, generateIdentity } from '../src/identity.mjs'
import { WorkerToolApprovalBroker } from '../src/agents/tool-approval-broker.mjs'

const writeReview = { schema: 'chimera.approval-review.v1', summary: 'Write a test file', fields: { Path: 'scratch/test.txt', 'Content bytes': 4 } }

test('missing semantic review cannot create an approvable decision', async () => {
  const broker = new WorkerToolApprovalBroker({ queue: { post: () => assert.fail('must not enqueue') }, audit: new MemoryAuditLog() })
  await assert.rejects(broker.request({ actionId: 'action', challengeHash: 'a'.repeat(64), agentId: 'ace', grantId: 'grant',
    toolName: 'write', capability: 'filesystem.write', resource: 'dsh-tool:write', callId: 'call', requestHash: 'b'.repeat(64),
  }), /WORKER_APPROVAL_REVIEW_INVALID/)
})

test('a confirm-tier worker tool pauses on the durable Decisions queue and receives only a signed outcome', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-worker-approval-'))
  const audit = new MemoryAuditLog()
  const now = Date.parse('2026-08-30T04:00:00.000Z')
  try {
    const queue = await DurableDecisionQueue.open({ filePath: join(directory, 'decisions.jsonl'), audit, now: () => now })
    const pending = []
    const broker = new WorkerToolApprovalBroker({ queue, audit, now: () => now, onPending: (actionId, scope) => pending.push({ actionId, scope }) })
    const request = {
      actionId: 'dsh-worker-write-1', challengeHash: 'a'.repeat(64), agentId: 'ace', grantId: 'ace-grant',
      sessionId: 'worker-ace', callId: 'call-1', rootCallId: 'call-1', parentCallId: null,
      toolName: 'write', capability: 'filesystem.write', resource: 'dsh-tool:write', requestHash: 'b'.repeat(64),
      taskId: 'task-1', nodeId: 'node-1', assignmentId: 'handoff-peer', canonicalAssignmentId: 'handoff-root',
      review: writeReview,
    }
    const waiting = broker.request(request)
    for (let attempt = 0; attempt < 20 && !queue.get(request.actionId); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.deepEqual(pending, [{ actionId: 'dsh-worker-write-1', scope: { taskId: 'task-1', nodeId: 'node-1', assignmentId: 'handoff-peer', canonicalAssignmentId: 'handoff-root' } }])
    assert.equal(queue.get('dsh-worker-write-1').title, 'Ace wants to use write')
    assert.equal(queue.get('dsh-worker-write-1').taskId, 'task-1')
    assert.equal(queue.get('dsh-worker-write-1').nodeId, 'node-1')
    assert.equal(queue.get('dsh-worker-write-1').assignmentId, 'handoff-peer')
    assert.equal(queue.get('dsh-worker-write-1').canonicalAssignmentId, 'handoff-root')
    assert.deepEqual(queue.get('dsh-worker-write-1').actionDiff, { tool: 'write', callId: 'call-1', requestHash: 'b'.repeat(64), review: writeReview })

    const human = generateIdentity('operator')
    const signed = signDecision({
      actionId: request.actionId, challengeHash: request.challengeHash, outcome: 'approve',
      issuedAt: '2026-08-30T03:59:59.000Z', expiresAt: '2026-08-30T04:05:00.000Z',
    }, human)
    const resolving = broker.resolve(request.actionId, signed)
    assert.deepEqual(await waiting, signed)
    await broker.complete(request.actionId, { status: 'allowed', actionId: request.actionId })
    assert.equal((await resolving).status, 'allowed')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a validated semantic review is preserved in the durable human decision', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-worker-approval-review-'))
  const audit = new MemoryAuditLog()
  const now = Date.parse('2026-08-30T04:00:00.000Z')
  try {
    const queue = await DurableDecisionQueue.open({ filePath: join(directory, 'decisions.jsonl'), audit, now: () => now })
    const broker = new WorkerToolApprovalBroker({ queue, audit, now: () => now })
    const request = {
      actionId: 'dsh-github-merge-review', challengeHash: 'a'.repeat(64), agentId: 'rj', grantId: 'rj-grant',
      sessionId: 'worker-rj', callId: 'merge-call', rootCallId: 'merge-call', parentCallId: null,
      toolName: 'mcp__chimera_github__pr_merge', capability: 'github.pr.merge',
      resource: 'dsh-tool:mcp__chimera_github__pr_merge', requestHash: 'b'.repeat(64),
      review: {
        schema: 'chimera.approval-review.v1',
        summary: 'Merge PR #6 in example-org/example-repo using squash',
        fields: {
          Repository: 'example-org/example-repo',
          'Pull request': '#6',
          'Expected head SHA': 'c'.repeat(40),
          'Merge method': 'squash',
        },
      },
    }
    const waiting = broker.request(request)
    while (!queue.get(request.actionId)) await new Promise((resolve) => setTimeout(resolve, 1))

    assert.deepEqual(queue.get(request.actionId).actionDiff.review, request.review)
    assert.equal(queue.get(request.actionId).detail, request.review.summary)

    await broker.cancelAll('TEST_COMPLETE')
    assert.equal(await waiting, null)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('worker approval returns the actual DSH outcome instead of a premature allowed result', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-worker-approval-result-'))
  const audit = new MemoryAuditLog()
  const now = Date.parse('2026-08-30T04:00:00.000Z')
  try {
    const queue = await DurableDecisionQueue.open({ filePath: join(directory, 'decisions.jsonl'), audit, now: () => now })
    const broker = new WorkerToolApprovalBroker({ queue, audit, now: () => now })
    const request = {
      actionId: 'dsh-worker-write-result', challengeHash: 'c'.repeat(64), agentId: 'ace', grantId: 'ace-grant',
      callId: 'call-result', toolName: 'write', capability: 'filesystem.write', resource: 'dsh-tool:write', requestHash: 'd'.repeat(64),
      review: writeReview,
    }
    const waiting = broker.request(request)
    while (!queue.get(request.actionId)) await new Promise((resolve) => setTimeout(resolve, 1))
    const signed = signDecision({
      actionId: request.actionId, challengeHash: request.challengeHash, outcome: 'approve',
      issuedAt: '2026-08-30T03:59:59.000Z', expiresAt: '2026-08-30T04:05:00.000Z',
    }, generateIdentity('rod'))

    let returned = false
    const resolving = broker.resolve(request.actionId, signed).then((result) => { returned = true; return result })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(returned, false)
    assert.deepEqual(await waiting, signed)

    await broker.complete(request.actionId, { status: 'denied', actionId: request.actionId, reason: 'DECISION_EXPIRED_OR_NOT_ACTIVE' })
    assert.deepEqual(await resolving, { status: 'denied', actionId: request.actionId, reason: 'DECISION_EXPIRED_OR_NOT_ACTIVE' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('expired worker approval becomes terminal and releases the waiting tool without execution', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-worker-approval-expired-'))
  const audit = new MemoryAuditLog()
  let clock = Date.parse('2026-08-30T04:00:00.000Z')
  try {
    const queue = await DurableDecisionQueue.open({ filePath: join(directory, 'decisions.jsonl'), audit, now: () => clock })
    const broker = new WorkerToolApprovalBroker({ queue, audit, now: () => clock })
    const request = {
      actionId: 'dsh-worker-write-expired', challengeHash: 'e'.repeat(64), agentId: 'ace', grantId: 'ace-grant',
      callId: 'call-expired', toolName: 'write', capability: 'filesystem.write', resource: 'dsh-tool:write', requestHash: 'f'.repeat(64),
      review: writeReview,
    }
    const waiting = broker.request(request)
    while (!queue.get(request.actionId)) await new Promise((resolve) => setTimeout(resolve, 1))
    clock += 5 * 60_000 + 1
    const handler = new HumanDecisionHandler({ queue, gateway: { decide() { throw new Error('must not reach gateway') } }, humanIdentity: generateIdentity('rod'), now: () => clock })

    const result = await handler.decide(request.actionId, 'approve', {
      decisionPath: (decision) => broker.resolve(request.actionId, decision),
      expirePath: () => broker.expire(request.actionId, 'DECISION_EXPIRED_OR_NOT_ACTIVE'),
    })

    assert.deepEqual(result, { status: 'denied', actionId: request.actionId, reason: 'DECISION_EXPIRED_OR_NOT_ACTIVE' })
    assert.equal(await waiting, null)
    assert.equal(queue.get(request.actionId).status, 'expired')
    assert.equal(queue.pending().length, 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('restart orphaning closes every restored pending decision', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-worker-approval-orphan-'))
  const filePath = join(directory, 'decisions.jsonl')
  const now = Date.parse('2026-08-30T04:00:00.000Z')
  try {
    const first = await DurableDecisionQueue.open({ filePath, audit: new MemoryAuditLog(), now: () => now })
    await first.post({
      actionId: 'pending-before-restart', challengeHash: '1'.repeat(64), actionDiff: { tool: 'write' }, resource: 'dsh-tool:write',
      expiresAt: '2026-08-30T04:05:00.000Z', agent: { agentId: 'ace', grantId: 'ace-grant' },
      policyRationale: { ruleId: 'dsh-confirm-tool', tier: 'confirm', reason: 'HUMAN_CONFIRMATION_REQUIRED' },
    })
    const restored = await DurableDecisionQueue.open({ filePath, audit: new MemoryAuditLog(), now: () => now })

    assert.deepEqual(await restored.orphanPending('PROCESS_RESTARTED'), ['pending-before-restart'])
    assert.equal(restored.get('pending-before-restart').status, 'orphaned')
    assert.equal(restored.get('pending-before-restart').reason, 'PROCESS_RESTARTED')
    assert.equal(restored.pending().length, 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('runtime shutdown cancels every waiting worker approval and releases its tool call', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-worker-approval-shutdown-'))
  const now = Date.parse('2026-08-30T04:00:00.000Z')
  try {
    const audit = new MemoryAuditLog()
    const queue = await DurableDecisionQueue.open({ filePath: join(directory, 'decisions.jsonl'), audit, now: () => now })
    const broker = new WorkerToolApprovalBroker({ queue, audit, now: () => now })
    const waiting = broker.request({
      actionId: 'dsh-shutdown',
      challengeHash: 'c'.repeat(64),
      agentId: 'ace',
      grantId: 'grant-ace',
      toolName: 'write',
      capability: 'filesystem.write',
      resource: 'dsh-tool:write',
      callId: 'call-shutdown',
      requestHash: 'd'.repeat(64),
      review: writeReview,
    })
    while (!queue.get('dsh-shutdown')) await new Promise((resolve) => setTimeout(resolve, 1))
    assert.deepEqual(await broker.cancelAll('PROCESS_STOPPED'), ['dsh-shutdown'])
    assert.equal(await waiting, null)
    assert.equal(queue.get('dsh-shutdown').status, 'cancelled')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
