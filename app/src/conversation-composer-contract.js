const MAX_CONTENT = 16 * 1024
const BUDGETS = Object.freeze({
  standard: Object.freeze({ maxTurns: 32, maxToolCalls: 24 }),
  extended: Object.freeze({ maxTurns: 64, maxToolCalls: 48 }),
})
const ROUTING_KEYS = new Set(['capabilities', 'inputModalities', 'outputModalities', 'requiredTools', 'minContextTokens', 'privacy', 'priorityPreset', 'modelPreference', 'maxEstimatedUsd'])
const ROUTING_PRESETS = new Set(['balanced', 'quality', 'latency', 'economy'])
const ROUTING_PRIVACY = new Set(['approved-providers', 'local-only'])
const MODEL_MODES = new Set(['auto', 'preferred', 'pinned'])
const MAX_TOKEN = 128
const MAX_CONTEXT_TOKENS = 4_000_000
const MAX_ESTIMATED_USD = 1_000_000
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,511}$/
const MODALITY = /^[A-Z][A-Z0-9._:-]{0,31}$/

function fail(code) {
  return Object.assign(new Error(code), { code })
}

function contentOf(content) {
  const bytes = typeof TextEncoder === 'function'
    ? new TextEncoder().encode(String(content ?? '')).byteLength
    : encodeURIComponent(String(content ?? '')).replace(/%[0-9A-F]{2}/g, 'x').length
  if (typeof content !== 'string' || !content.trim() || bytes > MAX_CONTENT) throw fail('COMPOSER_CONTENT_INVALID')
  return content.trim()
}

function budgetOf(budget) {
  if (typeof budget === 'string' && BUDGETS[budget]) return { ...BUDGETS[budget] }
  if (budget && typeof budget === 'object' && Number.isSafeInteger(budget.maxTurns) && Number.isSafeInteger(budget.maxToolCalls)) {
    return { maxTurns: budget.maxTurns, maxToolCalls: budget.maxToolCalls }
  }
  throw fail('COMPOSER_BUDGET_INVALID')
}

function revisionFields(target) {
  return Number.isSafeInteger(target?.destinationRevision) && target.destinationRevision >= 0
    ? { expectedDestinationRevision: target.destinationRevision } : {}
}

function routingList(value, maximum = 32, { modality = false, allowEmpty = false } = {}) {
  const grammar = modality ? MODALITY : TOKEN
  if (!Array.isArray(value) || value.length > maximum || (!allowEmpty && value.length === 0)
    || value.some(item => typeof item !== 'string' || item.length < 1 || item.length > MAX_TOKEN || !grammar.test(item))) {
    throw fail('COMPOSER_ROUTING_REQUIREMENTS_INVALID')
  }
  return [...new Set(value)].toSorted()
}

function routingRequirementsOf(value) {
  if (value === undefined || value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !ROUTING_KEYS.has(key))) {
    throw fail('COMPOSER_ROUTING_REQUIREMENTS_INVALID')
  }
  const result = {}
  for (const field of ['capabilities', 'inputModalities', 'outputModalities', 'requiredTools']) {
    if (value[field] !== undefined) result[field] = routingList(value[field], field === 'requiredTools' ? 32 : 32, {
      modality: field === 'inputModalities' || field === 'outputModalities',
      allowEmpty: field === 'requiredTools',
    })
  }
  if (value.minContextTokens !== undefined
    && (!Number.isSafeInteger(value.minContextTokens) || value.minContextTokens < 1 || value.minContextTokens > MAX_CONTEXT_TOKENS)) {
    throw fail('COMPOSER_ROUTING_REQUIREMENTS_INVALID')
  }
  if (value.minContextTokens !== undefined) result.minContextTokens = value.minContextTokens
  if (value.privacy !== undefined && !ROUTING_PRIVACY.has(value.privacy)) throw fail('COMPOSER_ROUTING_REQUIREMENTS_INVALID')
  if (value.privacy !== undefined) result.privacy = value.privacy
  if (value.priorityPreset !== undefined && !ROUTING_PRESETS.has(value.priorityPreset)) throw fail('COMPOSER_ROUTING_REQUIREMENTS_INVALID')
  if (value.priorityPreset !== undefined) result.priorityPreset = value.priorityPreset
  if (value.maxEstimatedUsd !== undefined
    && (typeof value.maxEstimatedUsd !== 'number' || !Number.isFinite(value.maxEstimatedUsd) || value.maxEstimatedUsd < 0 || value.maxEstimatedUsd > MAX_ESTIMATED_USD)) {
    throw fail('COMPOSER_ROUTING_REQUIREMENTS_INVALID')
  }
  if (value.maxEstimatedUsd !== undefined) result.maxEstimatedUsd = value.maxEstimatedUsd
  if (value.modelPreference !== undefined) {
    const preference = value.modelPreference
    if (!preference || typeof preference !== 'object' || Array.isArray(preference)
      || Object.keys(preference).some(key => !['mode', 'providerId', 'model'].includes(key))
      || !MODEL_MODES.has(preference.mode)
      || (preference.mode === 'auto' && (preference.providerId !== undefined || preference.model !== undefined))
      || (preference.providerId !== undefined && (typeof preference.providerId !== 'string' || !TOKEN.test(preference.providerId) || preference.providerId.length > MAX_TOKEN))
      || (preference.model !== undefined && (typeof preference.model !== 'string' || !MODEL_ID.test(preference.model) || preference.model.length > 512))
      || (preference.mode !== 'auto' && (typeof preference.providerId !== 'string' || typeof preference.model !== 'string'))) {
      throw fail('COMPOSER_ROUTING_REQUIREMENTS_INVALID')
    }
    result.modelPreference = preference.mode === 'auto' ? { mode: 'auto' } : {
      mode: preference.mode, providerId: preference.providerId, model: preference.model,
    }
  }
  return Object.keys(result).length ? result : null
}

export function buildComposerRequest({ target, content, requestId, budget = 'standard', routingRequirements = undefined } = {}) {
  if (!target || typeof target !== 'object' || typeof requestId !== 'string' || !requestId) throw fail('COMPOSER_REQUEST_INVALID')
  const text = contentOf(content)
  const normalizedBudget = budgetOf(budget)
  const requirements = routingRequirementsOf(routingRequirements)
  if (target.mode === 'ask') {
    if (target.recipientAgentIds?.length !== 1 || !target.conversationId) throw fail('ASK_TARGET_INVALID')
    if (requirements) throw fail('ASK_ROUTING_REQUIREMENTS_FORBIDDEN')
    return { endpoint: '/api/conversations/ask', body: { requestId, conversationId: target.conversationId, recipientAgentId: target.recipientAgentIds[0], content: text } }
  }
  if (target.mode === 'new-task') {
    const body = { objective: text, budget: normalizedBudget, queue: target.queue !== false, requestId }
    if (requirements) body.requirements = requirements
    if (target.requestedSpecialistAgentId) body.requestedSpecialistAgentId = target.requestedSpecialistAgentId
    if (target.conversationId) body.conversationId = target.conversationId
    return { endpoint: '/api/tasks', body }
  }
  if (!target.taskId) throw fail('TASK_TARGET_INVALID')
  if (target.mode === 'continuation') {
    return { endpoint: '/api/tasks/continue', body: { taskId: target.taskId, objective: text, budget: normalizedBudget, requestId, ...(requirements ? { requirements } : {}), ...revisionFields(target) } }
  }
  if (target.mode === 'guidance') {
    if (requirements) throw fail('GUIDANCE_ROUTING_REQUIREMENTS_UNSUPPORTED')
    if (target.recipientAgentIds?.length) {
      return { endpoint: '/api/tasks/message', body: { taskId: target.taskId, recipientAgentIds: [...target.recipientAgentIds], ...(target.replyTo ? { replyTo: target.replyTo } : {}), content: text, requestId, ...revisionFields(target) } }
    }
    return { endpoint: '/api/tasks/steer', body: { taskId: target.taskId, content: text, requestId, ...revisionFields(target) } }
  }
  throw fail('COMPOSER_MODE_INVALID')
}

export function mentionSuggestions(query, agents = []) {
  const needle = String(query ?? '').trim().toLowerCase()
  return agents.filter(agent => agent?.eligible === true
    && (String(agent.agentId ?? '').toLowerCase().includes(needle) || String(agent.displayName ?? '').toLowerCase().includes(needle)))
}

export function resolveMention(value, agents = []) {
  const needle = String(value ?? '').trim().replace(/^@/, '').toLowerCase()
  const exactId = agents.filter(agent => String(agent?.agentId ?? '').toLowerCase() === needle)
  const matching = exactId.length ? exactId : agents.filter(agent => String(agent?.displayName ?? '').toLowerCase() === needle)
  if (!matching.length) throw fail('MENTION_NOT_FOUND')
  if (matching.some(agent => agent?.eligible !== true)) throw fail('MENTION_NOT_ELIGIBLE')
  if (matching.length !== 1) throw fail('MENTION_AMBIGUOUS')
  return structuredClone(matching[0])
}

export { routingRequirementsOf }
