import test from 'node:test'
import assert from 'node:assert/strict'
import { buildComposerRequest, resolveMention, mentionSuggestions } from '../app/src/conversation-composer-contract.js'

const base = {
  mode: 'guidance', workspaceId: 'workspace-fixture', operatorId: 'operator-fixture',
  conversationId: 'task:alpha', taskId: 'alpha', recipientAgentIds: ['ace'], replyTo: 'parent-1', destinationRevision: 7,
}

test('Ask request builder emits the strict four-field pure Ask payload', () => {
  const request = buildComposerRequest({ target: { ...base, mode: 'ask', conversationId: 'agent:ace', taskId: null, recipientAgentIds: ['ace'], replyTo: null }, content: 'Answer with evidence.', requestId: 'ask-1', budget: 'extended' })
  assert.equal(request.endpoint, '/api/conversations/ask')
  assert.deepEqual(request.body, { requestId: 'ask-1', conversationId: 'agent:ace', recipientAgentId: 'ace', content: 'Answer with evidence.' })
})

test('new-task request preserves selected specialist and explicit queue intent', () => {
  const request = buildComposerRequest({ target: { ...base, mode: 'new-task', conversationId: 'agent:ace', taskId: null, recipientAgentIds: [], replyTo: null, requestedSpecialistAgentId: 'ace' }, content: 'Inspect only the selected workspace.', requestId: 'task-1', budget: 'standard' })
  assert.equal(request.endpoint, '/api/tasks')
  assert.deepEqual(request.body, { objective: 'Inspect only the selected workspace.', budget: { maxTurns: 32, maxToolCalls: 24 }, queue: true, requestId: 'task-1', requestedSpecialistAgentId: 'ace', conversationId: 'agent:ace' })
})

test('guidance and continuation preserve destination revision and reply parent', () => {
  const guidance = buildComposerRequest({ target: base, content: 'Recheck the source.', requestId: 'guidance-1' })
  assert.equal(guidance.endpoint, '/api/tasks/message')
  assert.deepEqual(guidance.body, { taskId: 'alpha', recipientAgentIds: ['ace'], replyTo: 'parent-1', content: 'Recheck the source.', requestId: 'guidance-1', expectedDestinationRevision: 7 })

  const continuation = buildComposerRequest({ target: { ...base, mode: 'continuation', replyTo: null, recipientAgentIds: [] }, content: 'Continue from the checkpoint.', requestId: 'continue-1', budget: 'extended' })
  assert.equal(continuation.endpoint, '/api/tasks/continue')
  assert.deepEqual(continuation.body, { taskId: 'alpha', objective: 'Continue from the checkpoint.', budget: { maxTurns: 64, maxToolCalls: 48 }, requestId: 'continue-1', expectedDestinationRevision: 7 })
})

test('composer request measurement and budget wire format remain browser-safe', () => {
  const previousBuffer = globalThis.Buffer
  try {
    globalThis.Buffer = undefined
    const request = buildComposerRequest({ target: { ...base, mode: 'new-task', taskId: null, recipientAgentIds: [] }, content: 'héllo', requestId: 'task-utf8', budget: 'standard' })
    assert.deepEqual(request.body.budget, { maxTurns: 32, maxToolCalls: 24 })
  } finally { globalThis.Buffer = previousBuffer }
})

test('mention suggestions use eligible IDs and reject ambiguous display names', () => {
  const agents = [
    { agentId: 'ace-one', displayName: 'Ace', eligible: true },
    { agentId: 'ace-two', displayName: 'Ace', eligible: true },
    { agentId: 'iris', displayName: 'Iris', eligible: false },
  ]
  assert.deepEqual(mentionSuggestions('ac', agents).map(agent => agent.agentId), ['ace-one', 'ace-two'])
  assert.throws(() => resolveMention('Ace', agents), { code: 'MENTION_AMBIGUOUS' })
  assert.deepEqual(resolveMention('ace-one', agents), agents[0])
  assert.throws(() => resolveMention('Iris', agents), { code: 'MENTION_NOT_ELIGIBLE' })
})

test('work requests carry bounded routing intent while Ask remains a strict four-field contract', () => {
  const requirements = { priorityPreset: 'latency', outputModalities: ['TEXT'] }
  const task = buildComposerRequest({
    target: { ...base, mode: 'new-task', taskId: null, recipientAgentIds: [], replyTo: null },
    content: 'Route this work by observed speed.', requestId: 'task-routing-1', routingRequirements: requirements,
  })
  assert.deepEqual(task.body.requirements, requirements)
  const continuation = buildComposerRequest({
    target: { ...base, mode: 'continuation', recipientAgentIds: [], replyTo: null },
    content: 'Continue with the captured routing intent.', requestId: 'continue-routing-1', routingRequirements: requirements,
  })
  assert.deepEqual(continuation.body.requirements, requirements)
  assert.throws(() => buildComposerRequest({
    target: { ...base, mode: 'ask', conversationId: 'agent:ace', taskId: null, recipientAgentIds: ['ace'], replyTo: null },
    content: 'Ask only.', requestId: 'ask-routing-1', routingRequirements: requirements,
  }), { code: 'ASK_ROUTING_REQUIREMENTS_FORBIDDEN' })
  assert.throws(() => buildComposerRequest({
    target: { ...base, mode: 'new-task', taskId: null, recipientAgentIds: [], replyTo: null },
    content: 'Reject unknown authority.', requestId: 'task-routing-2', routingRequirements: { grant: 'allow-all' },
  }), { code: 'COMPOSER_ROUTING_REQUIREMENTS_INVALID' })
})

test('composer routing validation matches the canonical requirement grammar and bounds', () => {
  const target = { ...base, mode: 'new-task', taskId: null, recipientAgentIds: [], replyTo: null }
  assert.throws(() => buildComposerRequest({ target, content: 'empty capability', requestId: 'empty-capabilities', routingRequirements: { capabilities: [] } }), { code: 'COMPOSER_ROUTING_REQUIREMENTS_INVALID' })
  assert.throws(() => buildComposerRequest({ target, content: 'empty input', requestId: 'empty-input', routingRequirements: { inputModalities: [] } }), { code: 'COMPOSER_ROUTING_REQUIREMENTS_INVALID' })
  assert.doesNotThrow(() => buildComposerRequest({ target, content: 'no required tools', requestId: 'empty-tools', routingRequirements: { requiredTools: [] } }))
  assert.throws(() => buildComposerRequest({ target, content: 'too much context', requestId: 'context-too-large', routingRequirements: { minContextTokens: 4_000_001 } }), { code: 'COMPOSER_ROUTING_REQUIREMENTS_INVALID' })
  assert.throws(() => buildComposerRequest({ target, content: 'numeric model', requestId: 'numeric-model', routingRequirements: { modelPreference: { mode: 'preferred', providerId: 1, model: 'fixture' } } }), { code: 'COMPOSER_ROUTING_REQUIREMENTS_INVALID' })
  assert.throws(() => buildComposerRequest({ target, content: 'unknown model field', requestId: 'unknown-model-field', routingRequirements: { modelPreference: { mode: 'preferred', providerId: 'fixture', model: 'fixture', grant: 'all' } } }), { code: 'COMPOSER_ROUTING_REQUIREMENTS_INVALID' })
})
