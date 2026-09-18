import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryAuditLog } from '../src/audit-log.mjs'
import { DurableTaskLedger } from '../src/ceo/task-ledger.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'chimera-project-queue-'))
  const options = { filePath: join(root, 'tasks.jsonl'), audit: new MemoryAuditLog() }
  let ledger = await DurableTaskLedger.open(options)
  t.after(async () => { await ledger.close(); await rm(root, { recursive: true, force: true }) })
  return { get ledger() { return ledger }, async reopen() { await ledger.close(); ledger = await DurableTaskLedger.open(options); return ledger } }
}

const job = taskId => ({ taskId, objective: `Project work ${taskId}`, model: null,
  queue: true, context: { projectId: 'project-one' } })

test('project jobs can queue atomically but cannot start overlapping executors', async t => {
  const { ledger } = await fixture(t)
  await Promise.all(['one', 'two', 'three'].map(id => ledger.submit(job(id))))
  assert.deepEqual(ledger.active().map(row => row.taskId), ['one', 'two', 'three'])
  await ledger.start('one')
  await assert.rejects(ledger.start('two'), { code: 'TASK_EXECUTION_BUSY' })
  await ledger.cancel('two')
  assert.equal(ledger.get('one').status, 'running')
  await ledger.complete('one', { summary: 'First artifact retained', result: { artifact: 'one.txt' } })
  await ledger.start('three')
  assert.equal(ledger.get('three').status, 'running')
})

test('restart preserves unstarted project jobs paused, interrupts in-flight work, and requires explicit resume', async t => {
  const fixtureState = await fixture(t)
  let ledger = fixtureState.ledger
  await ledger.submit(job('running'))
  await ledger.start('running')
  await ledger.checkpoint('running', { stage: 'tool-dispatch', effectOutcome: 'unknown' })
  await ledger.submit(job('waiting'))
  await ledger.steer('waiting', 'Keep this project isolated')
  ledger = await fixtureState.reopen()
  assert.equal(ledger.get('running').status, 'interrupted')
  assert.equal(ledger.get('running').checkpoint.effectOutcome, 'unknown')
  assert.equal(ledger.get('waiting').status, 'queued')
  assert.equal(ledger.get('waiting').recoveryRequired, true)
  assert.equal(ledger.get('waiting').steering[0].content, 'Keep this project isolated')
  await assert.rejects(ledger.start('waiting'), { code: 'TASK_QUEUE_RESUME_REQUIRED' })
  await assert.rejects(ledger.resumeQueued('running'), { code: 'TASK_NOT_QUEUED' })
  await ledger.resumeQueued('waiting')
  await ledger.start('waiting')
  await ledger.complete('waiting', { summary: 'Recovered queue completed', result: {} })
  ledger = await fixtureState.reopen()
  assert.equal(ledger.get('waiting').status, 'completed')
  assert.equal(ledger.get('running').status, 'interrupted')
})

test('queue rejects unscoped jobs and bounds concurrent pending submissions', async t => {
  const { ledger } = await fixture(t)
  await assert.rejects(ledger.submit({ ...job('bad'), context: {} }), { code: 'TASK_QUEUE_PROJECT_REQUIRED' })
  const rows = await Promise.allSettled(Array.from({ length: 33 }, (_, index) => ledger.submit(job(`bounded-${index}`))))
  assert.equal(rows.filter(row => row.status === 'fulfilled').length, 32)
  assert.equal(rows.find(row => row.status === 'rejected').reason.code, 'TASK_QUEUE_FULL')
  await ledger.cancel('bounded-0')
  assert.equal((await ledger.submit(job('replacement'))).status, 'queued')
})
