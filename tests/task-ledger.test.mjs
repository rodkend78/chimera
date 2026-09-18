import assert from 'node:assert/strict'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoryAuditLog } from '../src/audit-log.mjs'
import { DurableTaskLedger } from '../src/ceo/task-ledger.mjs'

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
