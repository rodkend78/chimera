import assert from 'node:assert/strict'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoryAuditLog } from '../src/audit-log.mjs'
import { sha256 } from '../src/canonical.mjs'
import { createTaskEvidenceReceiptIssuer, DurableTaskLedger } from '../src/ceo/task-ledger.mjs'
import { createTaskFailureFromError, createTrustedModelCallNotSentError } from '../src/ceo/model-call-errors.mjs'

test('task ledger persists one complete CEO task lifecycle', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-task-ledger-'))
  const filePath = join(directory, 'tasks.jsonl')
  const audit = new MemoryAuditLog()
  let clock = Date.parse('2026-08-27T21:00:00.000Z')
  try {
    const ledger = await DurableTaskLedger.open({ filePath, audit, now: () => clock })
    const submitted = await ledger.submit({
      taskId: 'task-1',
      objective: 'Prepare a bounded launch readiness summary.',
      model: { providerId: 'openrouter', model: 'openrouter/free' },
    })
    clock += 1_000
    await ledger.start(submitted.taskId)
    clock += 2_000
    await ledger.complete(submitted.taskId, {
      summary: 'The bounded readiness summary is complete.',
      result: { synthesis: { summary: 'The bounded readiness summary is complete.' } },
    })

    assert.equal(ledger.get('task-1').status, 'completed')
    assert.equal(ledger.get('task-1').summary, 'The bounded readiness summary is complete.')
    assert.deepEqual(ledger.list().map((record) => record.taskId), ['task-1'])
    const kinds = audit.entries().map((entry) => entry.fact.kind)
    assert.deepEqual(kinds, ['ceo.task.submitted', 'ceo.task.started', 'ceo.task.completed'])

    const expected = ledger.get('task-1')
    await ledger.close()
    const restarted = await DurableTaskLedger.open({
      filePath,
      audit: new MemoryAuditLog(),
      now: () => clock,
    })
    assert.deepEqual(restarted.get('task-1'), expected)
    await restarted.close()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('task routing explanation is durable and projected without exposing task input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-task-routing-projection-'))
  const filePath = join(directory, 'tasks.jsonl')
  const routing = {
    schema: 'chimera.routing-explanation.v1',
    taskId: 'task-routing',
    selected: { routeId: 'fixture-fast', providerId: 'fixture', model: 'fast', agentId: 'ceo', executor: 'inference-only', reason: 'selected by trusted hard filters and ranking' },
    candidates: [
      { routeId: 'fixture-fast', model: 'fast', status: 'eligible', reasons: [] },
      { routeId: 'fixture-slow', model: 'slow', status: 'rejected', details: ['connection is disabled'] },
    ],
    reasons: ['eligible after trusted hard filters'],
    evidence: { status: 'unknown', cost: { status: 'unknown' } },
    observedAt: '2026-09-19T00:00:00.000Z',
  }
  try {
    const first = await DurableTaskLedger.open({ filePath, audit: new MemoryAuditLog() })
    await first.submit({ taskId: 'task-routing', objective: 'Explain the selected route.', model: null })
    await first.setRouting('task-routing', routing)
    assert.deepEqual(first.get('task-routing').routing, routing)
    await first.close()

    const reopened = await DurableTaskLedger.open({ filePath, audit: new MemoryAuditLog() })
    assert.deepEqual(reopened.get('task-routing').routing, routing)
    const blocked = await reopened.setRouting('task-routing', {
      ...routing,
      selected: null,
      reasons: ['NO_ELIGIBLE_MODEL_ROUTE'],
    })
    assert.equal(blocked.routing.selected, null)
    await reopened.close()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('task admission identity is persisted with the task and rejects malformed bindings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-task-admission-binding-'))
  const filePath = join(directory, 'tasks.jsonl')
  const requestHash = 'a'.repeat(64)
  try {
    const ledger = await DurableTaskLedger.open({ filePath, audit: new MemoryAuditLog() })
    const submitted = await ledger.submit({
      taskId: 'task-bound', objective: 'Retain the exact admission identity.', model: null,
      admissionRequestId: 'request-bound', admissionRequestHash: requestHash,
    })
    assert.equal(submitted.admissionRequestId, 'request-bound')
    assert.equal(submitted.admissionRequestHash, requestHash)
    await ledger.close()

    const reopened = await DurableTaskLedger.open({ filePath, audit: new MemoryAuditLog() })
    assert.equal(reopened.get('task-bound').admissionRequestId, 'request-bound')
    assert.equal(reopened.get('task-bound').admissionRequestHash, requestHash)
    await reopened.close()

    const invalid = await DurableTaskLedger.open({ filePath: join(directory, 'invalid.jsonl'), audit: new MemoryAuditLog() })
    await assert.rejects(
      invalid.submit({ taskId: 'task-invalid', objective: 'Reject a partial identity.', model: null, admissionRequestId: 'request-bound' }),
      { code: 'TASK_ADMISSION_INVALID' },
    )
    await assert.rejects(
      invalid.submit({ taskId: 'task-invalid-hash', objective: 'Reject an invalid hash.', model: null, admissionRequestId: 'request-bound', admissionRequestHash: 'not-a-hash' }),
      { code: 'TASK_ADMISSION_INVALID' },
    )
    await invalid.close()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a task left running by a crash is durably interrupted and never auto-retried', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-task-interrupt-'))
  const filePath = join(directory, 'tasks.jsonl')
  let clock = Date.parse('2026-08-27T21:30:00.000Z')
  try {
    const first = await DurableTaskLedger.open({
      filePath,
      audit: new MemoryAuditLog(),
      now: () => clock,
    })
    await first.submit({ taskId: 'task-running', objective: 'Do not silently repeat me.', model: null })
    await first.start('task-running')
    await first.close()

    clock += 5_000
    const recovered = await DurableTaskLedger.open({
      filePath,
      audit: new MemoryAuditLog(),
      now: () => clock,
    })
    const record = recovered.get('task-running')
    assert.equal(record.status, 'interrupted')
    assert.equal(record.failure.code, 'TASK_INTERRUPTED_BY_RESTART')
    assert.equal(record.retryable, false)
    await recovered.close()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('task ledger rejects duplicate IDs and invalid lifecycle transitions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-task-invalid-'))
  try {
    const ledger = await DurableTaskLedger.open({
      filePath: join(directory, 'tasks.jsonl'),
      audit: new MemoryAuditLog(),
    })
    await ledger.submit({ taskId: 'task-duplicate', objective: 'One task only.', model: null })
    await assert.rejects(
      ledger.submit({ taskId: 'task-duplicate', objective: 'Duplicate.', model: null }),
      /TASK_ALREADY_EXISTS/,
    )
    await assert.rejects(
      ledger.complete('task-duplicate', { summary: 'Too early.', result: {} }),
      /TASK_NOT_RUNNING/,
    )
    await ledger.close()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('task ledger admits only one active task across concurrent submissions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-task-admission-'))
  const audit = new MemoryAuditLog()
  try {
    const ledger = await DurableTaskLedger.open({
      filePath: join(directory, 'tasks.jsonl'),
      audit,
    })
    const settlements = await Promise.allSettled([
      ledger.submit({ taskId: 'task-race-a', objective: 'First concurrent task.', model: null }),
      ledger.submit({ taskId: 'task-race-b', objective: 'Second concurrent task.', model: null }),
    ])
    const accepted = settlements.filter((settlement) => settlement.status === 'fulfilled')
    const denied = settlements.filter((settlement) => settlement.status === 'rejected')
    assert.equal(accepted.length, 1)
    assert.equal(denied.length, 1)
    assert.equal(denied[0].reason.message, 'TASK_ALREADY_RUNNING')
    assert.equal(denied[0].reason.code, 'TASK_ALREADY_RUNNING')
    assert.equal(ledger.active().length, 1)
    assert.equal(audit.entries().filter((entry) => entry.fact.kind === 'ceo.task.submitted').length, 1)

    await ledger.start(accepted[0].value.taskId)
    await ledger.fail(accepted[0].value.taskId, { code: 'EXPECTED_TEST_END', message: 'End the control task.' })
    const later = await ledger.submit({ taskId: 'task-after-terminal', objective: 'Allowed after terminal state.', model: null })
    assert.equal(later.status, 'queued')
    await ledger.close()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a durable task file has one live ledger owner and reopens only for recovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-task-owner-'))
  const filePath = join(directory, 'tasks.jsonl')
  let first
  let recovered
  try {
    first = await DurableTaskLedger.open({ filePath, audit: new MemoryAuditLog() })
    await first.submit({ taskId: 'task-live-owner', objective: 'Owned by the first ledger.', model: null })
    await first.start('task-live-owner')
    await assert.rejects(
      DurableTaskLedger.open({ filePath, audit: new MemoryAuditLog() }),
      (error) => error?.code === 'TASK_LEDGER_ALREADY_OPEN',
    )
    const aliasPath = join(directory, 'tasks-alias.jsonl')
    await symlink(filePath, aliasPath)
    await assert.rejects(
      DurableTaskLedger.open({ filePath: aliasPath, audit: new MemoryAuditLog() }),
      (error) => error?.code === 'TASK_LEDGER_ALREADY_OPEN',
    )
    assert.equal(first.get('task-live-owner').status, 'running')

    await first.close()
    first = null
    recovered = await DurableTaskLedger.open({ filePath, audit: new MemoryAuditLog() })
    assert.equal(recovered.get('task-live-owner').status, 'interrupted')
    assert.equal(recovered.get('task-live-owner').retryable, false)
  } finally {
    await first?.close()
    await recovered?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('task ledger fails closed when durable history contains concurrent active tasks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-task-corrupt-'))
  const filePath = join(directory, 'tasks.jsonl')
  const submittedAt = '2026-08-27T22:00:00.000Z'
  const event = (taskId) => ({
    schema: 'chimera.task-ledger.v1',
    event: 'submitted',
    at: submittedAt,
    task: {
      schema: 'chimera.task-ledger.v1',
      taskId,
      objective: `Objective for ${taskId}.`,
      model: null,
      status: 'queued',
      retryable: false,
      submittedAt,
    },
  })
  try {
    await writeFile(filePath, `${JSON.stringify(event('task-a'))}\n${JSON.stringify(event('task-b'))}\n`)
    await assert.rejects(
      DurableTaskLedger.open({ filePath, audit: new MemoryAuditLog() }),
      /invalid concurrent task submission event/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('task ledger durably reserves request identities and replays exact receipts without dispatch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-task-admission-receipt-'))
  const filePath = join(directory, 'tasks.jsonl')
  const requestHash = 'a'.repeat(64)
  try {
    const ledger = await DurableTaskLedger.open({ filePath, audit: new MemoryAuditLog() })
    const first = await ledger.reserveAdmission({ requestId: 'request-1', requestHash, operation: 'new-task', destination: { scope: 'root' } })
    assert.equal(first.status, 'reserved')
    const replay = await ledger.reserveAdmission({ requestId: 'request-1', requestHash, operation: 'new-task', destination: { scope: 'root' } })
    assert.equal(replay.replayed, true)
    assert.equal(replay.requestId, first.requestId)
    await assert.rejects(
      ledger.reserveAdmission({ requestId: 'request-1', requestHash: 'b'.repeat(64), operation: 'new-task', destination: { scope: 'root' } }),
      { code: 'TASK_ADMISSION_CONFLICT' },
    )
    await assert.rejects(
      ledger.reserveAdmission({ requestId: 'request-1', requestHash, operation: 'project-task', destination: { scope: 'project' } }),
      { code: 'TASK_ADMISSION_CONFLICT' },
    )
    const accepted = await ledger.completeAdmission({ requestId: 'request-1', status: 'accepted', taskId: 'task-1' })
    assert.equal(accepted.status, 'accepted')
    assert.equal(ledger.getAdmission('request-1').taskId, 'task-1')
    await ledger.close()
    const restarted = await DurableTaskLedger.open({ filePath, audit: new MemoryAuditLog() })
    assert.equal(restarted.getAdmission('request-1').status, 'accepted')
    assert.equal(restarted.getAdmission('request-1').taskId, 'task-1')
    await restarted.close()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('task ledger keeps an uncertain admission terminal until explicit reconciliation exists', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-task-admission-unknown-'))
  const ledger = await DurableTaskLedger.open({ filePath: join(directory, 'tasks.jsonl'), audit: new MemoryAuditLog() })
  try {
    await ledger.reserveAdmission({ requestId: 'unknown-1', requestHash: 'c'.repeat(64), operation: 'task-message', destination: { taskId: 'task-1' }, messageId: 'message-1' })
    const unknown = await ledger.completeAdmission({ requestId: 'unknown-1', status: 'unknown', taskId: 'task-1', messageId: 'message-1', reason: 'ADMISSION_RECEIPT_UNCERTAIN' })
    assert.equal(unknown.status, 'unknown')
    await assert.rejects(
      ledger.completeAdmission({ requestId: 'unknown-1', status: 'accepted', taskId: 'task-1', messageId: 'message-1' }),
      { code: 'TASK_ADMISSION_TERMINAL' },
    )
  } finally {
    await ledger.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('task ledger counts root and project queued work in one shared bounded queue', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-task-shared-queue-'))
  const ledger = await DurableTaskLedger.open({ filePath: join(directory, 'tasks.jsonl'), audit: new MemoryAuditLog() })
  try {
    await Promise.all(Array.from({ length: 32 }, (_, index) => ledger.submit({
      taskId: `queued-${index}`, objective: `Queued ${index}`, model: null,
      queue: true, context: index === 0 ? { queueScope: 'root' } : { projectId: 'project-1' },
    })))
    await assert.rejects(ledger.submit({ taskId: 'queued-overflow', objective: 'Overflow', model: null, queue: true, context: { queueScope: 'root' } }), { code: 'TASK_QUEUE_FULL' })
  } finally { await ledger.close(); await rm(directory, { recursive: true, force: true }) }
})

test('task ledger binds a queued resume to one durable admission across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-task-resume-admission-'))
  const filePath = join(directory, 'tasks.jsonl')
  const requestHash = 'd'.repeat(64)
  try {
    const first = await DurableTaskLedger.open({ filePath, audit: new MemoryAuditLog() })
    await first.submit({ taskId: 'queued-resume', objective: 'Resume only this queued task.', model: null,
      queue: true, context: { projectId: 'project-resume' } })
    await first.close()

    const recovered = await DurableTaskLedger.open({ filePath, audit: new MemoryAuditLog() })
    const paused = recovered.get('queued-resume')
    assert.equal(paused.recoveryRequired, true)
    const reservation = await recovered.reserveAdmission({
      requestId: 'resume-request', requestHash, operation: 'resume-queued',
      destination: { scope: 'project', taskId: 'queued-resume', expectedDestinationRevision: paused.destinationRevision },
      taskId: 'queued-resume',
    })
    assert.equal(reservation.status, 'reserved')
    const resumed = await recovered.resumeQueued('queued-resume', {
      requestId: 'resume-request', requestHash, expectedDestinationRevision: paused.destinationRevision,
    })
    assert.equal(resumed.recoveryRequired, false)
    assert.equal(resumed.queueResume.requestId, 'resume-request')
    assert.equal(recovered.getAdmission('resume-request').status, 'accepted')
    await recovered.close()

    const restarted = await DurableTaskLedger.open({ filePath, audit: new MemoryAuditLog() })
    // A process restart pauses a resumed-but-not-started queue item again;
    // the durable effect and admission identity remain available for a fresh
    // explicit resume without silently redispatching the task.
    assert.equal(restarted.get('queued-resume').recoveryRequired, true)
    assert.equal(restarted.get('queued-resume').queueResume.requestHash, requestHash)
    assert.equal(restarted.getAdmission('resume-request').status, 'accepted')
    await restarted.close()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('durable task plans and bounded node transitions survive restart with revision fencing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-task-plan-ledger-'))
  const filePath = join(directory, 'tasks.jsonl')
  const nodes = [
    { nodeId: 'research', specialistAgentId: 'researcher', objective: 'Research.', acceptanceCriteria: ['Facts.'], dependsOn: [] },
    { nodeId: 'write', specialistAgentId: 'writer', objective: 'Write.', acceptanceCriteria: ['Draft.'], dependsOn: ['research'] },
  ]
  const planHash = sha256({ schema: 'chimera.task-plan.v2', tasks: nodes })
  try {
    const first = await DurableTaskLedger.open({ filePath, audit: new MemoryAuditLog() })
    await first.submit({ taskId: 'task-plan', objective: 'Persist the graph.', model: null })
    const planned = await first.recordPlan('task-plan', { revision: 1, planHash, nodes })
    assert.equal(planned.plan.revision, 1)
    assert.deepEqual(planned.plan.nodes, nodes)
    await assert.rejects(
      first.recordPlan('task-plan', { revision: 2, planHash: 'b'.repeat(64), nodes }),
      { code: 'TASK_PLAN_HASH_MISMATCH' },
    )
    await first.recordStep('task-plan', { revision: 1, nodeId: 'research', status: 'queued' })
    await first.recordStep('task-plan', { revision: 1, nodeId: 'write', status: 'queued', messageId: 'queued-write' })
    assert.equal(first.get('task-plan').steps[1].messageId, 'queued-write')
    await first.start('task-plan')
    await first.recordStep('task-plan', { revision: 1, nodeId: 'research', status: 'running', messageId: 'handoff-research' })
    await first.recordStep('task-plan', { revision: 1, nodeId: 'research', status: 'completed', resultId: 'result-research' })
    await first.recordStep('task-plan', { revision: 1, nodeId: 'write', status: 'running', messageId: 'handoff-write' })
    const running = first.get('task-plan')
    assert.equal(running.steps.length, 2)
    assert.equal(running.steps[0].status, 'completed')
    assert.equal(running.steps[1].status, 'running')

    await assert.rejects(
      first.recordPlan('task-plan', { revision: 0, planHash: 'b'.repeat(64), nodes }),
      { code: 'TASK_PLAN_STALE_REVISION' },
    )
    await assert.rejects(
      first.recordStep('task-plan', { revision: 0, nodeId: 'write', status: 'completed' }),
      { code: 'TASK_PLAN_STALE_REVISION' },
    )
    await assert.rejects(
      first.recordStep('task-plan', { revision: 1, nodeId: 'research', status: 'running' }),
      { code: 'TASK_STEP_TERMINAL' },
    )
    await first.close()

    const recovered = await DurableTaskLedger.open({ filePath, audit: new MemoryAuditLog() })
    assert.equal(recovered.get('task-plan').status, 'interrupted')
    assert.equal(recovered.get('task-plan').plan.revision, 1)
    assert.equal(recovered.get('task-plan').steps[0].status, 'completed')
    assert.equal(recovered.get('task-plan').steps[1].status, 'running')
    await recovered.close()

    const restarted = await DurableTaskLedger.open({ filePath, audit: new MemoryAuditLog() })
    assert.equal(restarted.get('task-plan').status, 'interrupted')
    assert.equal(restarted.get('task-plan').steps[1].status, 'running')
    await restarted.close()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('concurrent node events serialize and invalid terminal transitions do not mutate history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-task-step-race-'))
  const filePath = join(directory, 'tasks.jsonl')
  try {
    const ledger = await DurableTaskLedger.open({ filePath, audit: new MemoryAuditLog() })
    await ledger.submit({ taskId: 'task-step-race', objective: 'Serialize node events.', model: null })
    await ledger.recordPlan('task-step-race', {
      revision: 7,
      nodes: [{ nodeId: 'one', specialistAgentId: 'researcher', objective: 'One.', acceptanceCriteria: ['One.'], dependsOn: [] }],
      planHash: sha256({ schema: 'chimera.task-plan.v2', tasks: [{ nodeId: 'one', specialistAgentId: 'researcher', objective: 'One.', acceptanceCriteria: ['One.'], dependsOn: [] }] }),
    })
    await Promise.all([
      ledger.recordStep('task-step-race', { revision: 7, nodeId: 'one', status: 'queued' }),
      ledger.recordStep('task-step-race', { revision: 7, nodeId: 'one', status: 'running' }),
    ])
    assert.equal(ledger.get('task-step-race').steps[0].status, 'running')
    await ledger.recordStep('task-step-race', { revision: 7, nodeId: 'one', status: 'failed', reason: 'fixture failure' })
    const before = ledger.get('task-step-race')
    await assert.rejects(
      ledger.recordStep('task-step-race', { revision: 7, nodeId: 'one', status: 'completed' }),
      { code: 'TASK_STEP_TERMINAL' },
    )
    assert.deepEqual(ledger.get('task-step-race').steps, before.steps)
    await ledger.close()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('task evidence is issued by an opaque runtime authority and survives restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-task-evidence-'))
  const filePath = join(directory, 'tasks.jsonl')
  try {
    const ledger = await DurableTaskLedger.open({ filePath, audit: new MemoryAuditLog() })
    await ledger.submit({ taskId: 'evidence-alpha', objective: 'Retain task evidence.', model: null })
    const issuer = createTaskEvidenceReceiptIssuer({ taskId: 'evidence-alpha', source: 'bounded-check' })
    const receipt = issuer.issue({
      receiptId: 'check-1', kind: 'check', operationId: 'op-check', revision: 'rev-1',
      observedAt: '2026-09-19T10:00:00.000Z',
      outcome: { status: 'passed', command: 'npm test -- alpha', scope: 'task:evidence-alpha@rev-1', exitCode: 0 },
      evidenceRef: 'check-1',
    })
    await ledger.recordEvidence('evidence-alpha', receipt)
    assert.deepEqual(ledger.listEvidence('evidence-alpha').map(item => item.receiptId), ['check-1'])
    await assert.rejects(
      ledger.recordEvidence('evidence-alpha', structuredClone(receipt)),
      { code: 'TASK_EVIDENCE_UNTRUSTED' },
    )
    await ledger.close()

    const reopened = await DurableTaskLedger.open({ filePath, audit: new MemoryAuditLog() })
    assert.equal(reopened.listEvidence('evidence-alpha')[0].outcome.status, 'passed')
    await reopened.close()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('task evidence rejects invalid sources and cross-task receipts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-task-evidence-fences-'))
  try {
    const ledger = await DurableTaskLedger.open({ filePath: join(directory, 'tasks.jsonl'), audit: new MemoryAuditLog() })
    await ledger.submit({ taskId: 'evidence-alpha', objective: 'Alpha.', model: null })
    await ledger.submit({ taskId: 'evidence-beta', objective: 'Beta.', model: null, queue: true, context: { projectId: 'project-1' } })
    assert.throws(() => createTaskEvidenceReceiptIssuer({ taskId: 'evidence-alpha', source: 'model-prose' }), { code: 'TASK_EVIDENCE_SOURCE_INVALID' })
    const betaReceipt = createTaskEvidenceReceiptIssuer({ taskId: 'evidence-beta', source: 'bounded-check' }).issue({
      receiptId: 'beta-check', kind: 'check', operationId: 'beta-op', revision: 'rev-1', observedAt: '2026-09-19T10:00:00.000Z',
      outcome: { status: 'passed', command: 'npm test', scope: 'task:evidence-beta@rev-1', exitCode: 0 }, evidenceRef: 'beta-check',
    })
    await assert.rejects(ledger.recordEvidence('evidence-alpha', betaReceipt), { code: 'TASK_EVIDENCE_TASK_MISMATCH' })
    await ledger.close()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('the runtime evidence issuer supplies a receipt identity when the caller has no endpoint identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-task-evidence-generated-id-'))
  try {
    const ledger = await DurableTaskLedger.open({ filePath: join(directory, 'tasks.jsonl'), audit: new MemoryAuditLog() })
    await ledger.submit({ taskId: 'evidence-generated', objective: 'Generate a runtime receipt identity.', model: null })
    const receipt = createTaskEvidenceReceiptIssuer({ taskId: 'evidence-generated', source: 'bounded-check' }).issue({
      kind: 'check', operationId: 'generated-op', revision: 'rev-1', observedAt: '2026-09-19T10:00:00.000Z',
      outcome: { status: 'passed', command: 'npm test -- generated', scope: 'task:evidence-generated@rev-1', exitCode: 0 },
      evidenceRef: 'generated-op',
    })
    assert.equal(typeof receipt.receiptId, 'string')
    assert.ok(receipt.receiptId.length > 0)
    await ledger.recordEvidence('evidence-generated', receipt)
    assert.equal(ledger.listEvidence('evidence-generated').length, 1)
    await ledger.close()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('trusted model-call denial is durably retryable while public dispatch metadata stays unknown', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-task-failure-classification-'))
  const filePath = join(directory, 'tasks.jsonl')
  try {
    const ledger = await DurableTaskLedger.open({ filePath, audit: new MemoryAuditLog() })
    await ledger.submit({ taskId: 'task-trusted-denial', objective: 'Persist trusted denial.', model: null })
    await ledger.start('task-trusted-denial')
    await ledger.fail('task-trusted-denial', createTaskFailureFromError(createTrustedModelCallNotSentError('denied before dispatch')))
    assert.equal(ledger.get('task-trusted-denial').failure.dispatchState, 'not_sent')

    await ledger.submit({ taskId: 'task-public-denial', objective: 'Reject public metadata.', model: null, queue: true, context: { projectId: 'p1' } })
    await ledger.start('task-public-denial')
    await ledger.fail('task-public-denial', createTaskFailureFromError(Object.assign(new Error('provider says not sent'), { code: 'TIMEOUT', dispatchState: 'not_sent' })))
    assert.notEqual(ledger.get('task-public-denial').failure.dispatchState, 'not_sent')
    await ledger.close()

    const reopened = await DurableTaskLedger.open({ filePath, audit: new MemoryAuditLog() })
    assert.equal(reopened.get('task-trusted-denial').failure.dispatchState, 'not_sent')
    assert.notEqual(reopened.get('task-public-denial').failure.dispatchState, 'not_sent')
    await reopened.close()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('evidence truncation is marked durably when an older check can fall out of the bounded ledger', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-task-evidence-truncation-'))
  const filePath = join(directory, 'tasks.jsonl')
  try {
    const ledger = await DurableTaskLedger.open({ filePath, audit: new MemoryAuditLog() })
    await ledger.submit({ taskId: 'evidence-truncated', objective: 'Retain bounded evidence truth.', model: null })
    const issuer = createTaskEvidenceReceiptIssuer({ taskId: 'evidence-truncated', source: 'bounded-check' })
    for (let index = 0; index < 257; index += 1) {
      const receipt = issuer.issue({
        receiptId: `check-${index}`, kind: 'check', operationId: `operation-${index}`, revision: 'rev-1',
        observedAt: '2026-09-19T10:00:00.000Z',
        outcome: {
          status: index === 0 ? 'failed' : 'passed', command: 'npm test -- bounded',
          scope: 'task:evidence-truncated@rev-1', exitCode: index === 0 ? 1 : 0, signal: null,
        }, evidenceRef: `check-${index}`,
      })
      await ledger.recordEvidence('evidence-truncated', receipt)
    }
    assert.equal(ledger.get('evidence-truncated').evidenceTruncated, true)
    assert.equal(ledger.listEvidence('evidence-truncated').some(item => item.receiptId === 'check-0'), false)
    await ledger.close()

    const reopened = await DurableTaskLedger.open({ filePath, audit: new MemoryAuditLog() })
    assert.equal(reopened.get('evidence-truncated').evidenceTruncated, true)
    assert.equal(reopened.listEvidence('evidence-truncated').length, 256)
    await reopened.close()
  } finally { await rm(directory, { recursive: true, force: true }) }
})
