import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoryAuditLog } from '../src/audit-log.mjs'
import { DurableConversationLedger } from '../src/ceo/conversation-ledger.mjs'

test('conversation ledger durably preserves linked human and RJ messages', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-conversation-'))
  const filePath = join(directory, 'messages.jsonl')
  let clock = Date.parse('2026-08-29T20:00:00.000Z')
  try {
    const ledger = await DurableConversationLedger.open({
      filePath,
      audit: new MemoryAuditLog(),
      now: () => clock,
    })
    const human = await ledger.append({
      messageId: 'message-human-1',
      conversationId: 'main',
      senderAgentId: 'rod',
      recipientAgentIds: ['ceo'],
      content: 'RJ, prepare a launch checklist.',
      taskId: 'task-1',
    })
    clock += 2_000
    await ledger.append({
      messageId: 'message-rj-1',
      conversationId: 'main',
      senderAgentId: 'ceo',
      recipientAgentIds: ['rod'],
      content: 'The launch checklist is ready.',
      taskId: 'task-1',
      replyTo: human.messageId,
      status: 'completed',
    })
    assert.deepEqual(ledger.list('main').map((message) => message.role), ['human', 'rj'])
    await ledger.close()

    const reopened = await DurableConversationLedger.open({
      filePath,
      audit: new MemoryAuditLog(),
      now: () => clock,
    })
    assert.equal(reopened.list('main')[1].replyTo, 'message-human-1')
    assert.equal(reopened.list('main')[1].status, 'completed')
    await reopened.close()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('conversation ledger stores participant-aware agent messages and lists all channels', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-team-chat-'))
  const filePath = join(directory, 'messages.jsonl')
  try {
    const ledger = await DurableConversationLedger.open({ filePath, audit: new MemoryAuditLog() })
    const handoff = await ledger.append({
      messageId: 'handoff-visible-1',
      conversationId: 'task:task-1',
      senderAgentId: 'ceo',
      recipientAgentIds: ['researcher'],
      kind: 'task_handoff',
      content: 'RJ assigned the bounded research objective.',
      taskId: 'task-1:1',
      provenance: {
        verification: 'verified',
        envelopeHash: 'a'.repeat(64),
        signerAgentId: 'ceo',
        grantId: 'grant-ceo-1',
        gatewayActionId: 'action-handoff-1',
      },
    })
    await ledger.append({
      messageId: 'result-visible-1',
      conversationId: 'task:task-1',
      senderAgentId: 'researcher',
      recipientAgentIds: ['ceo'],
      kind: 'structured_result',
      content: 'Researcher returned the signed result.',
      taskId: 'task-1:1',
      replyTo: handoff.messageId,
      status: 'completed',
    })

    assert.equal(handoff.schema, 'chimera.conversation-message.v2')
    assert.equal(handoff.role, 'rj')
    assert.deepEqual(handoff.recipientAgentIds, ['researcher'])
    assert.equal(handoff.provenance.verification, 'verified')
    assert.deepEqual(ledger.listAll().map((message) => message.kind), ['task_handoff', 'structured_result'])
    assert.deepEqual(ledger.list('task:task-1').map((message) => message.senderAgentId), ['ceo', 'researcher'])
    await ledger.close()

    const reopened = await DurableConversationLedger.open({ filePath, audit: new MemoryAuditLog() })
    assert.equal(reopened.listAll()[1].role, 'agent')
    await reopened.close()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('conversation ledger restores legacy v1 Rod and RJ history into the v2 projection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-team-chat-legacy-'))
  const filePath = join(directory, 'messages.jsonl')
  try {
    await writeFile(filePath, `${JSON.stringify({
      schema: 'chimera.conversation-message.v1',
      messageId: 'legacy-rj-1',
      conversationId: 'main',
      role: 'rj',
      content: 'Legacy RJ reply.',
      status: 'completed',
      createdAt: '2026-08-29T20:00:00.000Z',
    })}\n`)
    const ledger = await DurableConversationLedger.open({ filePath, audit: new MemoryAuditLog() })
    assert.deepEqual(ledger.list('main')[0], {
      schema: 'chimera.conversation-message.v2',
      messageId: 'legacy-rj-1',
      conversationId: 'main',
      role: 'rj',
      senderAgentId: 'ceo',
      recipientAgentIds: ['rod'],
      kind: 'message',
      content: 'Legacy RJ reply.',
      status: 'completed',
      provenance: { verification: 'legacy', source: 'conversation-v1-restore' },
      createdAt: '2026-08-29T20:00:00.000Z',
    })
    await ledger.close()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('conversation ledger rejects unsafe shapes, duplicates, and corrupt history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-conversation-invalid-'))
  const filePath = join(directory, 'messages.jsonl')
  try {
    const ledger = await DurableConversationLedger.open({ filePath, audit: new MemoryAuditLog() })
    await assert.rejects(ledger.append({
      messageId: 'message-bad-role',
      conversationId: 'main',
      senderAgentId: 'System',
      recipientAgentIds: ['ceo'],
      kind: 'message',
      content: 'Do not admit system-shaped content.',
    }), /CONVERSATION_MESSAGE_INVALID/)
    await ledger.append({
      messageId: 'message-one',
      conversationId: 'main',
      senderAgentId: 'rod',
      recipientAgentIds: ['ceo'],
      content: 'One durable message.',
    })
    await assert.rejects(ledger.append({
      messageId: 'message-one',
      conversationId: 'main',
      senderAgentId: 'rod',
      recipientAgentIds: ['ceo'],
      content: 'Duplicate.',
    }), /CONVERSATION_MESSAGE_EXISTS/)
    await assert.rejects(ledger.append({
      messageId: 'message-missing-participants',
      conversationId: 'main',
      content: 'Must not inherit RJ attribution.',
    }), /CONVERSATION_MESSAGE_INVALID/)
    await ledger.close()

    await writeFile(filePath, '{"schema":"wrong"}\n')
    await assert.rejects(
      DurableConversationLedger.open({ filePath, audit: new MemoryAuditLog() }),
      /CONVERSATION_HISTORY_INVALID/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
