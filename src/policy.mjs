const TIERS = new Set(['auto', 'confirm', 'blocked'])

function resourceMatches(selector, resource) {
  if (typeof selector.resource === 'string') return resource === selector.resource
  return resource.startsWith(selector.resourcePrefix)
}

function selectorSpecificity(selector) {
  return typeof selector.resource === 'string'
    ? Number.MAX_SAFE_INTEGER
    : selector.resourcePrefix.length
}

function validateSelector(selector, label) {
  const hasExact = typeof selector.resource === 'string'
  const hasPrefix = typeof selector.resourcePrefix === 'string'
  if (hasExact === hasPrefix) throw new TypeError(`${label} needs exactly one resource or resourcePrefix`)
}

export function validatePolicy(policy) {
  if (policy?.version !== 1) throw new TypeError('policy.version must be 1')
  if (!TIERS.has(policy.defaultTier)) throw new TypeError('policy.defaultTier is invalid')
  if (!Array.isArray(policy.rules)) throw new TypeError('policy.rules must be an array')

  const ids = new Set()
  for (const rule of policy.rules) {
    if (!rule.id || ids.has(rule.id)) throw new TypeError('policy rule ids must be unique and non-empty')
    if (!rule.capability || typeof rule.capability !== 'string') throw new TypeError(`rule ${rule.id} needs a capability`)
    validateSelector(rule, `rule ${rule.id}`)
    if (!TIERS.has(rule.tier)) throw new TypeError(`rule ${rule.id} has an invalid tier`)
    ids.add(rule.id)
  }
  return policy
}

export function evaluatePolicy(policy, action) {
  validatePolicy(policy)
  const matches = policy.rules.filter(rule => (
    rule.capability === action.capability
    && resourceMatches(rule, action.resource)
  ))

  if (matches.length === 0) {
    return { ruleId: 'default', tier: policy.defaultTier }
  }

  matches.sort((left, right) => selectorSpecificity(right) - selectorSpecificity(left))
  const mostSpecific = matches[0]
  const equallySpecific = matches.filter(rule => selectorSpecificity(rule) === selectorSpecificity(mostSpecific))
  if (equallySpecific.length > 1) {
    return { ruleId: 'ambiguous', tier: 'blocked', reason: 'AMBIGUOUS_POLICY' }
  }
  return { ruleId: mostSpecific.id, tier: mostSpecific.tier }
}

export function grantCovers(grant, action, policyTier) {
  if (grant.agentId !== action.agentId) return { covered: false, reason: 'AGENT_MISMATCH' }
  if (grant.taskId && action.capability.startsWith('agent.message.') && action.taskId !== grant.taskId) return { covered: false, reason: 'TASK_OUTSIDE_GRANT_SCOPE' }
  const scope = grant.scopes.find(candidate => (
    candidate.capability === action.capability
    && resourceMatches(candidate, action.resource)
  ))
  if (!scope) return { covered: false, reason: 'OUTSIDE_GRANT_SCOPE' }
  if (policyTier === 'confirm' && grant.maxTier !== 'confirm') {
    return { covered: false, reason: 'GRANT_REQUIRES_AUTO_ONLY' }
  }
  return { covered: true }
}
