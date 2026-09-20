import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoryAuditLog } from '../src/audit-log.mjs'
import { DECISION_QUEUE_SCHEMA, DurableDecisionQueue } from '../src/ceo/decisions.mjs'

const expiry = '2026-09-19T04:05:00.000Z'
const rationale = { ruleId: 'dsh-confirm-tool', tier: 'confirm', reason: 'HUMAN_CONFIRMATION_REQUIRED' }

test('durable decisions retain exact task, node, assignment, and canonical ownership', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-ceo-decisions-'))
  const filePath = join(directory, 'decisions.jsonl')
  const actionDiff = { tool: 'write', callId: 'call-7', requestHash: 'b'.repeat(64), review: { schema: 'chimera.approval-review.v1', summary: 'Write one bounded file.', fields: { Path: 'scratch/result' } } }
  try {
    const queue = await DurableDecisionQueue.open({ filePath, audit: new MemoryAuditLog() })
    await queue.post({
      actionId: 'action-7',
      challengeHash: 'a'.repeat(64),
      actionDiff,
      resource: 'dsh-tool:write',
      expiresAt: expiry,
      taskId: 'task-7',
      nodeId: 'node-write',
      assignmentId: 'handoff-peer',
      canonicalAssignmentId: 'handoff-root',
      agent: { agentId: 'ace', grantId: 'grant-ace' },
      policyRationale: rationale,
    })
    const before = queue.get('action-7')
    assert.equal(before.taskId, 'task-7')
    assert.equal(before.nodeId, 'node-write')
    assert.equal(before.assignmentId, 'handoff-peer')
    assert.equal(before.canonicalAssignmentId, 'handoff-root')
    assert.deepEqual(before.actionDiff, actionDiff)
    await queue.close?.()

    const reopened = await DurableDecisionQueue.open({ filePath, audit: new MemoryAuditLog() })
    const restored = reopened.get('action-7')
    assert.deepEqual(restored, before)
    await reopened.cancel('action-7', 'TEST_COMPLETE')
    assert.deepEqual(reopened.get('action-7').actionDiff, actionDiff)
    assert.equal(reopened.get('action-7').canonicalAssignmentId, 'handoff-root')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('legacy decision events reopen with explicit null attribution fields', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-ceo-decisions-legacy-'))
  const filePath = join(directory, 'decisions.jsonl')
  const postedAt = '2026-09-19T04:00:00.000Z'
  try {
    const decision = {
      schema: DECISION_QUEUE_SCHEMA,
      actionId: 'legacy-action',
      challengeHash: 'c'.repeat(64),
      actionDiff: { tool: 'read', requestHash: 'd'.repeat(64) },
      resource: 'dsh-tool:read',
      expiresAt: expiry,
      agent: { agentId: 'ace', grantId: 'grant-ace' },
      policyRationale: rationale,
      status: 'pending',
      postedAt,
    }
    await writeFile(filePath, `${JSON.stringify({ schema: DECISION_QUEUE_SCHEMA, event: 'posted', at: postedAt, decision })}\n`)
    const queue = await DurableDecisionQueue.open({ filePath, audit: new MemoryAuditLog() })
    const restored = queue.get('legacy-action')
    assert.equal(restored.taskId, null)
    assert.equal(restored.nodeId, null)
    assert.equal(restored.assignmentId, null)
    assert.equal(restored.canonicalAssignmentId, null)
    assert.deepEqual(restored.actionDiff, decision.actionDiff)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
