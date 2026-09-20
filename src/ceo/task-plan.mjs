import { normalizeTaskRequirements, TASK_REQUIREMENTS_SCHEMA } from './task-requirements.mjs'

export const TASK_PLAN_SCHEMA = 'chimera.task-plan.v2'
export const MAX_TASK_PLAN_NODES = 8
const MAX_NODE_ID = 128
const MAX_OBJECTIVE = 16_384
const MAX_ACCEPTANCE_ITEM = 4_096
const MAX_ACCEPTANCE_ITEMS = 64
const MAX_RESOURCES_BYTES = 16 * 1024
const NODE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

function failure(code, message = code) {
  return Object.assign(new TypeError(message), { code })
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function string(value, maximum) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function nodeId(value) {
  return string(value, MAX_NODE_ID) && NODE_ID.test(value)
}

function cloneBounded(value, maximum, code) {
  let encoded
  try {
    encoded = JSON.stringify(value)
  } catch {
    throw failure(code)
  }
  if (!encoded || Buffer.byteLength(encoded, 'utf8') > maximum) throw failure(code)
  try {
    return JSON.parse(encoded)
  } catch {
    throw failure(code)
  }
}

function normalizeAcceptance(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ACCEPTANCE_ITEMS
    || value.some((item) => !string(item, MAX_ACCEPTANCE_ITEM))) {
    throw failure('TASK_PLAN_ACCEPTANCE_INVALID')
  }
  return [...value]
}

function normalizeRequest(value) {
  if (value === undefined || value === null) return null
  if (!record(value) || !string(value.capability, 128) || !string(value.resource, 2_048)
    || !string(value.operation, 128)
    || Object.keys(value).some((key) => !['capability', 'resource', 'operation'].includes(key))) {
    throw failure('TASK_PLAN_REQUEST_INVALID')
  }
  return { capability: value.capability, resource: value.resource, operation: value.operation }
}

function normalizeResources(value) {
  if (value === undefined || value === null) return null
  if (!record(value)) throw failure('TASK_PLAN_RESOURCES_INVALID')
  return cloneBounded(value, MAX_RESOURCES_BYTES, 'TASK_PLAN_RESOURCES_INVALID')
}

function normalizeDependencies(value, { defaultDependencies = [] } = {}) {
  if (value === undefined) return [...defaultDependencies]
  if (!Array.isArray(value) || value.length > MAX_TASK_PLAN_NODES) throw failure('TASK_PLAN_DEPENDENCIES_INVALID')
  const dependencies = []
  const seen = new Set()
  for (const dependency of value) {
    if (!nodeId(dependency)) throw failure('TASK_PLAN_DEPENDENCIES_INVALID')
    if (seen.has(dependency)) throw failure('TASK_PLAN_DUPLICATE_DEPENDENCY')
    seen.add(dependency)
    dependencies.push(dependency)
  }
  return dependencies
}

function normalizeNode(input, index, { legacy, eligible, enforceEligibility = false }) {
  if (!record(input) || !string(input.specialistAgentId, 256)
    || !string(input.objective, MAX_OBJECTIVE)) throw failure('TASK_PLAN_NODE_INVALID')
  if (enforceEligibility && !eligible.has(input.specialistAgentId)) throw failure('TASK_PLAN_AGENT_INELIGIBLE')
  const id = input.nodeId === undefined ? `step-${index + 1}` : input.nodeId
  if (!nodeId(id)) throw failure('TASK_PLAN_NODE_ID_INVALID')
  // A legacy task has no graph identity.  Its order is the compatibility
  // contract, so an explicit dependency field cannot opt one item out of the
  // sequential predecessor chain.  An empty list is tolerated from loose
  // providers but normalized to the same deterministic chain; non-empty
  // declarations are ambiguous and rejected.  Fully identified v2 nodes
  // retain their explicit DAG edges.
  if (legacy && input.dependsOn !== undefined
    && (!Array.isArray(input.dependsOn) || input.dependsOn.length > 0)) {
    throw failure('TASK_PLAN_LEGACY_DEPENDENCIES_INVALID')
  }
  const dependencies = legacy
    ? (index > 0 ? [`step-${index}`] : [])
    : normalizeDependencies(input.dependsOn, { defaultDependencies: [] })
  const normalized = {
    nodeId: id,
    specialistAgentId: input.specialistAgentId,
    objective: input.objective,
    acceptanceCriteria: normalizeAcceptance(input.acceptanceCriteria),
    dependsOn: dependencies,
  }
  if (input.request !== undefined && input.request !== null) normalized.request = normalizeRequest(input.request)
  if (input.requirements !== undefined && input.requirements !== null) {
    try {
      normalized.requirements = structuredClone(normalizeTaskRequirements(input.requirements))
    } catch (error) {
      throw failure(error.code ?? 'TASK_PLAN_REQUIREMENTS_INVALID', error.message)
    }
  }
  if (input.resources !== undefined && input.resources !== null) normalized.resources = normalizeResources(input.resources)
  return normalized
}

function validateGraph(nodes) {
  const byId = new Map()
  for (const node of nodes) {
    if (byId.has(node.nodeId)) throw failure('TASK_PLAN_DUPLICATE_NODE')
    byId.set(node.nodeId, node)
  }
  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (dependency === node.nodeId) throw failure('TASK_PLAN_SELF_DEPENDENCY')
      if (!byId.has(dependency)) throw failure('TASK_PLAN_MISSING_DEPENDENCY')
    }
  }

  // Kahn's algorithm is deliberately stable: when multiple nodes are ready,
  // preserve their model order. This keeps result attribution deterministic
  // while still honoring an explicitly supplied dependency graph.
  const indegree = new Map(nodes.map((node) => [node.nodeId, node.dependsOn.length]))
  const dependents = new Map(nodes.map((node) => [node.nodeId, []]))
  for (const node of nodes) for (const dependency of node.dependsOn) dependents.get(dependency).push(node.nodeId)
  const ready = nodes.filter((node) => indegree.get(node.nodeId) === 0).map((node) => node.nodeId)
  const order = []
  while (ready.length > 0) {
    const current = ready.shift()
    order.push(current)
    for (const dependent of dependents.get(current)) {
      const remaining = indegree.get(dependent) - 1
      indegree.set(dependent, remaining)
      if (remaining === 0) {
        const position = nodes.findIndex((node) => node.nodeId === dependent)
        const insertion = ready.findIndex((id) => nodes.findIndex((node) => node.nodeId === id) > position)
        if (insertion === -1) ready.push(dependent)
        else ready.splice(insertion, 0, dependent)
      }
    }
  }
  if (order.length !== nodes.length) throw failure('TASK_PLAN_CYCLE')
  const byOrder = new Map(order.map((id, index) => [id, index]))
  return [...nodes].toSorted((left, right) => byOrder.get(left.nodeId) - byOrder.get(right.nodeId))
}

export function normalizeTaskPlan(input, { eligibleAgentIds = undefined } = {}) {
  if (!record(input) || !Array.isArray(input.tasks)) throw failure('TASK_PLAN_INVALID')
  if (input.tasks.length === 0) throw failure('TASK_PLAN_EMPTY')
  if (input.tasks.length > MAX_TASK_PLAN_NODES) throw failure('TASK_PLAN_TOO_MANY_NODES')
  const hasEligibility = eligibleAgentIds !== undefined
  const eligible = new Set(eligibleAgentIds ?? [])
  if ([...eligible].some((value) => !string(value, 256))) throw failure('TASK_PLAN_ELIGIBLE_AGENTS_INVALID')
  const identified = input.tasks.some((task) => record(task) && task.nodeId !== undefined)
  const unidentified = input.tasks.some((task) => record(task) && task.nodeId === undefined)
  if (identified && unidentified) throw failure('TASK_PLAN_MIXED_NODE_IDENTITY')
  const legacy = !identified
  const nodes = input.tasks.map((task, index) => normalizeNode(task, index, {
    legacy,
    eligible: hasEligibility ? eligible : new Set(),
    enforceEligibility: hasEligibility,
  }))
  const ordered = validateGraph(nodes)
  return {
    schema: TASK_PLAN_SCHEMA,
    tasks: ordered.map((node) => structuredClone(node)),
  }
}

function mergeLists(left, right) {
  return [...new Set([...(left ?? []), ...(right ?? [])])].toSorted()
}

function mergeModelPreference(root, node) {
  if (!root) return node
  if (!node) return root
  if (root.mode === 'pinned') {
    if (node.mode === 'pinned'
      && (root.providerId !== node.providerId || root.model !== node.model)) throw failure('TASK_PLAN_REQUIREMENTS_CONFLICT')
    return root
  }
  if (node.mode === 'pinned') return node
  if (root.mode === 'preferred' && node.mode === 'preferred'
    && (root.providerId !== node.providerId || root.model !== node.model)) throw failure('TASK_PLAN_REQUIREMENTS_CONFLICT')
  if (root.mode === 'preferred') return root
  return node
}

export function combineTaskRequirements(rootInput = undefined, nodeInput = undefined) {
  const root = normalizeTaskRequirements(rootInput)
  const node = normalizeTaskRequirements(nodeInput)
  const result = { schema: TASK_REQUIREMENTS_SCHEMA }
  for (const field of ['capabilities', 'inputModalities', 'outputModalities', 'requiredTools']) {
    const values = mergeLists(root[field], node[field])
    if (values.length > 0) result[field] = values
  }
  if (root.minContextTokens !== undefined || node.minContextTokens !== undefined) {
    result.minContextTokens = Math.max(root.minContextTokens ?? 0, node.minContextTokens ?? 0)
  }
  if (root.privacy === 'local-only' || node.privacy === 'local-only') result.privacy = 'local-only'
  else if (root.privacy ?? node.privacy) result.privacy = root.privacy ?? node.privacy
  if (root.priorityPreset !== undefined || node.priorityPreset !== undefined) result.priorityPreset = root.priorityPreset ?? node.priorityPreset
  const modelPreference = mergeModelPreference(root.modelPreference, node.modelPreference)
  if (modelPreference) result.modelPreference = structuredClone(modelPreference)
  if (root.maxEstimatedUsd !== undefined || node.maxEstimatedUsd !== undefined) {
    result.maxEstimatedUsd = Math.min(root.maxEstimatedUsd ?? Number.POSITIVE_INFINITY, node.maxEstimatedUsd ?? Number.POSITIVE_INFINITY)
  }
  return Object.freeze(result)
}
