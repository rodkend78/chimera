const MODES = new Set(['new-task', 'ask', 'guidance', 'continuation'])
const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const MAX_ID = 256

function fail(code) {
  return Object.assign(new Error(code), { code })
}

function bounded(value, maximum = MAX_ID) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function recipientsOf(value) {
  if (!Array.isArray(value)) throw fail('COMPOSER_RECIPIENTS_INVALID')
  const recipients = [...new Set(value)]
  if (recipients.some(id => typeof id !== 'string' || !AGENT_ID.test(id))) throw fail('COMPOSER_RECIPIENTS_INVALID')
  return recipients.toSorted()
}

function scopeOf(state) {
  const scope = state?.draftScope
  if (!scope || !bounded(scope.workspaceId, 256) || !bounded(scope.operatorId, 256)) throw fail('DRAFT_SCOPE_UNAVAILABLE')
  return { workspaceId: scope.workspaceId, operatorId: scope.operatorId }
}

function taskDestinationRevision(state, taskId, selection) {
  if (Number.isSafeInteger(selection?.destinationRevision) && selection.destinationRevision >= 0) return selection.destinationRevision
  const rows = [
    state?.teamMessaging?.tasks?.find(task => task.taskId === taskId),
    state?.tasks?.find(task => task.taskId === taskId),
  ]
  for (const row of rows) {
    if (Number.isSafeInteger(row?.destinationRevision) && row.destinationRevision >= 0) return row.destinationRevision
    if (Number.isSafeInteger(row?.revision) && row.revision >= 0) return row.revision
  }
  return null
}

export function draftKey(target = {}) {
  const scope = {
    workspaceId: target.workspaceId ?? null,
    operatorId: target.operatorId ?? null,
    mode: target.mode ?? null,
    conversationId: target.conversationId ?? null,
    taskId: target.taskId ?? null,
    recipientAgentIds: recipientsOf(target.recipientAgentIds ?? []),
    replyTo: target.replyTo ?? null,
  }
  return `chimera-draft-v1:${JSON.stringify(scope)}`
}

export function resolveComposerTarget({ selection = {}, mode, recipients = [], state = {} } = {}) {
  if (!MODES.has(mode)) throw fail('COMPOSER_MODE_INVALID')
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) throw fail('COMPOSER_SELECTION_INVALID')
  const scope = scopeOf(state)
  const recipientAgentIds = recipientsOf(recipients)
  const selectedAgentId = selection.agentId ?? selection.requestedSpecialistAgentId ?? selection.recipientAgentId ?? null
  if (selectedAgentId !== null && !AGENT_ID.test(selectedAgentId)) throw fail('COMPOSER_AGENT_INVALID')

  if (mode === 'ask' && recipientAgentIds.length !== 1) throw fail('ASK_RECIPIENT_REQUIRED')
  if (mode === 'guidance' && !bounded(selection.taskId)) throw fail('GUIDANCE_TARGET_REQUIRED')
  if (mode === 'continuation' && !bounded(selection.taskId)) throw fail('CONTINUATION_TARGET_REQUIRED')

  const taskId = ['guidance', 'continuation'].includes(mode) ? selection.taskId : null
  const recipientAgentId = mode === 'ask' ? recipientAgentIds[0] : selectedAgentId
  const conversationId = selection.conversationId
    ?? (taskId ? `task:${taskId}` : recipientAgentId ? recipientAgentId === 'ceo' ? 'main' : `agent:${recipientAgentId}` : null)
  if (!bounded(conversationId)) throw fail('COMPOSER_CONVERSATION_REQUIRED')

  const target = {
    mode,
    ...scope,
    conversationId,
    taskId,
    recipientAgentIds,
    replyTo: selection.replyTo ?? null,
    ...(selection.replyLabel ? { replyLabel: String(selection.replyLabel).slice(0, MAX_ID) } : {}),
    ...(taskId ? { destinationRevision: taskDestinationRevision(state, taskId, selection) } : {}),
    ...(mode === 'new-task' && selectedAgentId && selectedAgentId !== 'ceo'
      ? { requestedSpecialistAgentId: selectedAgentId } : {}),
  }
  if (target.replyTo !== null && !bounded(target.replyTo)) throw fail('COMPOSER_REPLY_INVALID')
  return target
}

export { MODES }
