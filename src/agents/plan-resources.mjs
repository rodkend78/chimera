const MAX_RESOURCE_KEY = 2_048

function isClaim(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && typeof value.key === 'string' && value.key.length > 0 && value.key.length <= MAX_RESOURCE_KEY
    && (value.access === 'read' || value.access === 'write')
    && value.verified === true
}

function normalizeClaims(value) {
  if (value === null || value === undefined) return null
  const list = Array.isArray(value) ? value : [value]
  return list.every(isClaim) ? list : null
}

function pathSegments(key) {
  return key.split(/[:/]/u).filter(Boolean)
}

function isPathAncestor(parent, child) {
  if (parent === child) return true
  const parentParts = pathSegments(parent)
  const childParts = pathSegments(child)
  return parentParts.length < childParts.length
    && parentParts.every((part, index) => part === childParts[index])
}

/**
 * Return true when two runtime-owned claim sets must not overlap.
 *
 * Missing, malformed, or unverified claims are unknown future effects and
 * therefore conflict with every claim. Two reads are safe even when one path
 * contains the other; writes use segment-aware ancestor matching so a token
 * prefix such as `workspace:one` does not collide with `workspace:one-shot`.
 */
export function resourcesConflict(left, right) {
  const leftClaims = normalizeClaims(left)
  const rightClaims = normalizeClaims(right)
  if (leftClaims === null || rightClaims === null) return true
  for (const leftClaim of leftClaims) {
    for (const rightClaim of rightClaims) {
      if (leftClaim.access === 'read' && rightClaim.access === 'read') continue
      if (isPathAncestor(leftClaim.key, rightClaim.key)
        || isPathAncestor(rightClaim.key, leftClaim.key)) return true
    }
  }
  return false
}

function stateOf(states, id) {
  if (states && typeof states.get === 'function') return states.get(id)
  if (states && typeof states === 'object') return states[id]
  return undefined
}

/**
 * Project graph dependencies and runtime-owned claims into a scheduler state.
 * This helper never grants authority and never interprets model resource
 * proposals as proof.
 */
export function planNodeReadiness({ node, states, heldResources, claims }) {
  const dependencies = Array.isArray(node?.dependsOn) ? node.dependsOn : []
  if (dependencies.some(id => ['blocked', 'failed', 'cancelled', 'unknown'].includes(stateOf(states, id)))) return 'blocked'
  if (!dependencies.every(id => stateOf(states, id) === 'completed')) return 'waiting'
  if ((heldResources ?? []).some(held => resourcesConflict(claims, held))) return 'waiting'
  return 'ready'
}
