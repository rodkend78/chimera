import test from 'node:test'
import assert from 'node:assert/strict'
import { draftKey, resolveComposerTarget } from '../app/src/conversation-target.js'

test('draft keys stay distinct by scope, mode, room, task, recipients, and reply parent', () => {
  const base = {
    workspaceId: 'workspace-fixture', operatorId: 'operator-fixture', mode: 'guidance',
    conversationId: 'task:alpha', taskId: 'alpha', recipientAgentIds: ['ace'], replyTo: null,
  }
  assert.notEqual(draftKey(base), draftKey({ ...base, taskId: 'beta', conversationId: 'task:beta' }))
  assert.notEqual(draftKey(base), draftKey({ ...base, mode: 'ask' }))
  assert.notEqual(draftKey(base), draftKey({ ...base, operatorId: 'other-operator' }))
  assert.notEqual(draftKey(base), draftKey({ ...base, replyTo: 'message-parent' }))
  assert.equal(draftKey({ ...base, recipientAgentIds: ['ace', 'iris'] }), draftKey({ ...base, recipientAgentIds: ['iris', 'ace'] }))
})

test('composer target resolves the selected agent and never substitutes the running task', () => {
  const state = {
    draftScope: { workspaceId: 'workspace-fixture', operatorId: 'operator-fixture' },
    tasks: [{ taskId: 'running-task', status: 'running', objective: 'Unrelated active task' }],
    agents: { main: { agentId: 'ceo' }, specialists: [{ agentId: 'ace', displayName: 'Ace' }] },
    teamMessaging: { tasks: [{ taskId: 'selected-task', destinationRevision: 9, eligibleRecipients: ['ace'] }] },
  }
  const target = resolveComposerTarget({
    selection: { taskId: 'selected-task', conversationId: 'task:selected-task', replyTo: 'parent-1', replyLabel: 'Earlier guidance' },
    mode: 'guidance',
    recipients: ['ace'],
    state,
  })
  assert.deepEqual(target, {
    mode: 'guidance', workspaceId: 'workspace-fixture', operatorId: 'operator-fixture',
    conversationId: 'task:selected-task', taskId: 'selected-task', recipientAgentIds: ['ace'],
    replyTo: 'parent-1', replyLabel: 'Earlier guidance', destinationRevision: 9,
  })
  assert.notEqual(target.taskId, 'running-task')
})

test('new task target preserves an explicitly selected specialist through submission', () => {
  const target = resolveComposerTarget({
    selection: { agentId: 'ace', conversationId: 'agent:ace' },
    mode: 'new-task',
    recipients: [],
    state: { draftScope: { workspaceId: 'workspace-fixture', operatorId: 'operator-fixture' } },
  })
  assert.equal(target.requestedSpecialistAgentId, 'ace')
  assert.equal(target.conversationId, 'agent:ace')
  assert.equal(target.taskId, null)
})

test('target resolution rejects an unbound destination instead of inventing a namespace', () => {
  assert.throws(() => resolveComposerTarget({ selection: {}, mode: 'ask', recipients: ['ceo'], state: {} }), { code: 'DRAFT_SCOPE_UNAVAILABLE' })
})

test('unaddressed guidance resolves to the selected task for the steer endpoint', () => {
  const target = resolveComposerTarget({
    selection: { taskId: 'selected-task', conversationId: 'task:selected-task' },
    mode: 'guidance', recipients: [],
    state: { draftScope: { workspaceId: 'workspace-fixture', operatorId: 'operator-fixture' }, teamMessaging: { tasks: [{ taskId: 'selected-task', destinationRevision: 4 }] } },
  })
  assert.equal(target.taskId, 'selected-task')
  assert.deepEqual(target.recipientAgentIds, [])
})
