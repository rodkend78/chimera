import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryAuditLog } from '../src/audit-log.mjs'
import { DurableTaskLedger } from '../src/ceo/task-ledger.mjs'
import { DurableConversationLedger } from '../src/ceo/conversation-ledger.mjs'

test('restart restores steering, cancellation, progress and continuation provenance without replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chimera-control-ledger-'))
  let ledger
  try {
    const options = { filePath: join(root, 'tasks.jsonl'), audit: new MemoryAuditLog() }
    ledger = await DurableTaskLedger.open(options)
    await ledger.submit({ taskId: 'task-original', objective: 'Original work', model: null, context: { projectId: 'project-1', projectSessionTaskId: 'task-original' } })
    await ledger.start('task-original')
    await ledger.steer('task-original', 'Preserve the completed artifact.')
    await ledger.checkpoint('task-original', { stage: 'tool-completed', tool: 'write', summary: 'Saved result.txt', observation: { status: 'completed' } })
    await ledger.checkpoint('task-original', { stage: 'tool-dispatch', tool: 'web_fetch', effectOutcome: 'unknown', summary: 'Checking external state' })
    await ledger.cancel('task-original')
    await ledger.submit({ taskId: 'task-next', objective: 'Verify external state before further work.', model: null,
      context: { priorTaskId: 'task-original', projectId: 'project-1', projectSessionTaskId: 'task-original' } })
    await ledger.close()
    ledger = await DurableTaskLedger.open(options)
    const original = ledger.get('task-original')
    assert.equal(original.status, 'cancelled')
    assert.equal(original.steering[0].content, 'Preserve the completed artifact.')
    assert.equal(original.checkpoint.effectOutcome, 'unknown')
    assert.equal(original.lastCompletedWork.summary, 'Saved result.txt')
    assert.equal(ledger.get('task-next').status, 'interrupted')
    assert.equal(ledger.get('task-next').context.priorTaskId, original.taskId)
    assert.equal(ledger.get('task-next').retryable, false)
  } finally { await ledger?.close(); await rm(root, { recursive: true, force: true }) }
})

test('bounded task and conversation pages retain full history and expose stable older cursors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chimera-ledger-pages-'))
  let tasks
  let conversations
  try {
    let now = Date.now()
    const audit = new MemoryAuditLog()
    tasks = await DurableTaskLedger.open({ filePath: join(root, 'tasks.jsonl'), audit, now: () => now++ })
    conversations = await DurableConversationLedger.open({ filePath: join(root, 'messages.jsonl'), audit, now: () => now++ })
    for (let index = 1; index <= 5; index += 1) {
      const taskId = `task-page-${index}`
      await tasks.submit({ taskId, objective: `Task ${index}`, model: null })
      await tasks.start(taskId)
      await tasks.complete(taskId, { summary: `Result ${index}`, result: { artifact: `result-${index}.txt` } })
      await conversations.append({ messageId: `message-${index}`, conversationId: 'main', senderAgentId: 'rod', recipientAgentIds: ['ceo'], content: `Message ${index}`, taskId })
    }
    assert.deepEqual(tasks.list({ limit: 2 }).map(({ taskId }) => taskId), ['task-page-5', 'task-page-4'])
    assert.deepEqual(tasks.list({ limit: 2, before: 'task-page-4' }).map(({ taskId }) => taskId), ['task-page-3', 'task-page-2'])
    assert.deepEqual(conversations.listAll({ limit: 2 }).map(({ messageId }) => messageId), ['message-4', 'message-5'])
    assert.deepEqual(conversations.list('main', { limit: 2, before: 'message-4' }).map(({ messageId }) => messageId), ['message-2', 'message-3'])
    assert.equal(conversations.listAll({ limit: 1 })[0].role, 'human')
    assert.equal(tasks.list().length, 5)
    assert.equal(conversations.listAll().length, 5)
    assert.throws(() => tasks.list({ before: 'missing' }), /CURSOR_INVALID/)
    assert.throws(() => conversations.listAll({ before: 'missing' }), /CURSOR_INVALID/)
  } finally { await tasks?.close(); await conversations?.close(); await rm(root, { recursive: true, force: true }) }
})
