import { createTrustedModelCallNotSentError, isTrustedModelCallNotSentError } from './model-call-errors.mjs'
import { normalizeTaskRequirements } from './task-requirements.mjs'
import { validateModelRouter } from './model-router.mjs'
import { isInferenceOnlyLeaf, markInferenceOnlyRouter } from './inference-proof.mjs'

const COOLDOWN_MS = 30_000
const ROUTING_EXPLANATION_SCHEMA = 'chimera.routing-explanation.v1'

function boundedString(value, maximum = 256) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function list(value, maximum = 64) {
  return Array.isArray(value) && value.length <= maximum && value.every(item => boundedString(item, 128))
    ? [...new Set(value)].toSorted()
    : null
}

function taskCapability(prompt, context = {}) {
  if (context.stage === 'decompose' || context.stage === 'synthesize') return 'orchestration'
  if (context.taskKind && boundedString(context.taskKind, 128)) return context.taskKind
  const text = String(prompt ?? '').toLowerCase()
  if (/image|video|audio|visual|screenshot|multimodal/.test(text)) return 'multimodal-understanding'
  if (/code|repository|implement|debug|test|patch|build/.test(text)) return 'coding'
  if (/research|compare|cite|evidence|investigate/.test(text)) return 'research'
  if (/bulk|classify|extract|records|spreadsheet|batch/.test(text)) return 'bulk'
  if (/reason|decision|trade[- ]?off|analy[sz]e/.test(text)) return 'reasoning'
  return 'general'
}

function normalizeRoute(route) {
  if (!route || typeof route !== 'object' || !boundedString(route.id) || !route.router) throw new TypeError('model route is invalid')
  const router = validateModelRouter(route.router)
  const capabilities = route.capabilities === undefined ? [] : list(route.capabilities)
  if (!capabilities) throw new TypeError('model route capabilities are invalid')
  if (!boundedString(route.costClass, 64)) throw new TypeError('model route cost class is required')
  const inputModalities = route.inputModalities === undefined ? [] : list(route.inputModalities, 32)
  const outputModalities = route.outputModalities === undefined ? [] : list(route.outputModalities, 32)
  const requiredTools = route.requiredTools === undefined ? [] : list(route.requiredTools, 64)
  if (!inputModalities || !outputModalities || !requiredTools) throw new TypeError('model route metadata is invalid')
  if (route.contextCapacityTokens !== undefined
    && (!Number.isSafeInteger(route.contextCapacityTokens) || route.contextCapacityTokens < 1)) throw new TypeError('model route context capacity is invalid')
  if (route.maxEstimatedUsd !== undefined
    && (typeof route.maxEstimatedUsd !== 'number' || !Number.isFinite(route.maxEstimatedUsd) || route.maxEstimatedUsd < 0)) throw new TypeError('model route cost bound is invalid')
  return Object.freeze({
    id: route.id,
    router,
    routerId: router.routerId,
    capabilities,
    inputModalities,
    outputModalities,
    requiredTools,
    ...(route.contextCapacityTokens !== undefined ? { contextCapacityTokens: route.contextCapacityTokens } : {}),
    ...(route.maxEstimatedUsd !== undefined ? { maxEstimatedUsd: route.maxEstimatedUsd } : {}),
    ...(boundedString(route.privacy, 64) ? { privacy: route.privacy } : {}),
    ...(boundedString(route.providerId, 512) ? { providerId: route.providerId } : {}),
    ...(boundedString(route.model, 512) ? { model: route.model } : {}),
    ...(boundedString(route.agentId, 256) ? { agentId: route.agentId } : {}),
    ...(boundedString(route.executor, 128) ? { executor: route.executor } : {}),
    ...(boundedString(route.reason, 512) ? { reason: route.reason } : {}),
    ...(route.nativeExecution === true ? { nativeExecution: true } : {}),
    ...(route.authority && typeof route.authority === 'object' && !Array.isArray(route.authority)
      ? { authority: structuredClone(route.authority) }
      : {}),
    ...(route.priorityByPreset && typeof route.priorityByPreset === 'object' && !Array.isArray(route.priorityByPreset)
      ? { priorityByPreset: Object.fromEntries(Object.entries(route.priorityByPreset).filter(([key, value]) => (
        ['balanced', 'quality', 'latency', 'economy'].includes(key)
        && Number.isFinite(value)
      ))) }
      : {}),
    costClass: route.costClass,
    priority: Number.isFinite(route.priority) ? route.priority : 0,
    ...(route.router.nativeExecution === true ? { nativeExecution: true } : {}),
  })
}

function legacyOrStructuredRequirements(prompt, context) {
  const explicit = context?.requirements
  if (explicit !== undefined) return { requirements: normalizeTaskRequirements(explicit), structured: true }
  const legacy = normalizeTaskRequirements(undefined, context)
  if (legacy.capabilities || legacy.priorityPreset || legacy.modelPreference) return { requirements: legacy, structured: false }
  const capability = taskCapability(prompt, context)
  return capability === 'general'
    ? { requirements: legacy, structured: false }
    : { requirements: normalizeTaskRequirements({ capabilities: [capability] }), structured: false }
}

function candidateView(route) {
  return {
    routeId: route.id,
    providerId: route.providerId ?? null,
    model: route.model ?? route.routerId,
    ...(route.agentId ? { agentId: route.agentId } : {}),
    ...(route.executor ? { executor: route.executor } : {}),
    ...(route.nativeExecution ? { nativeExecution: true } : {}),
  }
}

function requirementReasons(route, requirements, scope = null) {
  const reasons = []
  const unknown = []
  const requireList = (field, label) => {
    const required = requirements[field]
    if (!required) return
    const available = route[field]
    if (!available?.length) {
      unknown.push(`${label} metadata unavailable`)
      return
    }
    if (required.some(value => !available.includes(value))) reasons.push(`${label} requirement is not declared`)
  }
  requireList('capabilities', 'capability')
  requireList('inputModalities', 'input modality')
  requireList('outputModalities', 'output modality')
  if (requirements.requiredTools?.length) {
    // Route descriptors are descriptive metadata and are not an authority
    // source for tools. Runtime-owned scopes prove tool access; a deferred
    // planner/synthesis stage leaves that proof to the specialist executor.
    if (scope?.toolAuthority !== 'runtime' && scope?.toolAuthority !== 'deferred') {
      if (!route.requiredTools.length) unknown.push('tool metadata unavailable')
      else if (requirements.requiredTools.some(value => !route.requiredTools.includes(value))) reasons.push('required tool is not declared')
    }
  }
  if (requirements.minContextTokens !== undefined) {
    if (route.contextCapacityTokens === undefined) unknown.push('context capacity is unknown')
    else if (route.contextCapacityTokens < requirements.minContextTokens) reasons.push('context capacity is below the requirement')
  }
  if (requirements.privacy) {
    if (!route.privacy) unknown.push('privacy metadata unavailable')
    else if (requirements.privacy === 'local-only' && route.privacy !== 'local-only') reasons.push('route is not local-only')
  }
  if (requirements.maxEstimatedUsd !== undefined) {
    if (route.maxEstimatedUsd === undefined) unknown.push('credible cost bound unavailable')
    else if (route.maxEstimatedUsd > requirements.maxEstimatedUsd) reasons.push('credible cost bound exceeds the requirement')
  }
  return { reasons, unknown }
}

function modelPreferenceReason(route, preference) {
  if (!preference || preference.mode === 'auto') return null
  if (route.providerId === preference.providerId && route.model === preference.model) return null
  return preference.mode === 'pinned' ? 'agent/task pinned model does not match' : 'preferred model is unavailable; fallback may be considered'
}

function dispatchState(error) {
  return isTrustedModelCallNotSentError(error) ? 'not_sent' : 'unknown'
}

function evidenceFor(route, requirements, evidence) {
  return evidence?.snapshot?.({
    providerId: route.providerId ?? 'unknown',
    model: route.model ?? route.routerId,
    capability: requirements.capabilities?.[0] ?? route.capabilities[0] ?? 'general',
  }) ?? null
}

function compareKnownNumber(left, right, direction = 'asc') {
  const leftKnown = Number.isFinite(left)
  const rightKnown = Number.isFinite(right)
  if (leftKnown !== rightKnown) return leftKnown ? -1 : 1
  if (!leftKnown) return 0
  return direction === 'desc' ? right - left : left - right
}

function comparableCost(snapshot) {
  return snapshot?.cost?.status === 'measured' || snapshot?.cost?.status === 'estimated'
    ? snapshot.cost.medianUsd
    : undefined
}

function rankCandidates(left, right, requirements, evidence) {
  const preset = requirements.priorityPreset ?? 'balanced'
  const leftEvidence = evidenceFor(left.route, requirements, evidence)
  const rightEvidence = evidenceFor(right.route, requirements, evidence)
  const leftPriority = Number.isFinite(left.route.priorityByPreset?.[preset])
    ? left.route.priorityByPreset[preset]
    : left.route.priority
  const rightPriority = Number.isFinite(right.route.priorityByPreset?.[preset])
    ? right.route.priorityByPreset[preset]
    : right.route.priority

  const leftPreferred = modelPreferenceReason(left.route, requirements.modelPreference) === null
  const rightPreferred = modelPreferenceReason(right.route, requirements.modelPreference) === null

  // Preferred is a pre-dispatch preference. Once its hard requirements are
  // satisfied it wins before preset ranking; an ineligible preferred route is
  // handled by the runtime's captured-default fallback.
  if (leftPreferred !== rightPreferred) return leftPreferred ? -1 : 1
  if (preset === 'latency') {
    const latency = compareKnownNumber(leftEvidence?.latency?.status === 'measured' ? leftEvidence.latency.medianMs : undefined,
      rightEvidence?.latency?.status === 'measured' ? rightEvidence.latency.medianMs : undefined)
    if (latency !== 0) return latency
  }
  if (preset === 'economy') {
    const leftCost = comparableCost(leftEvidence)
    const rightCost = comparableCost(rightEvidence)
    const cost = compareKnownNumber(leftCost, rightCost)
    if (cost !== 0) return cost
  }
  const priority = compareKnownNumber(leftPriority, rightPriority, 'desc')
  if (priority !== 0) return priority

  const reliability = compareKnownNumber(
    leftEvidence?.reliability?.status === 'measured' ? leftEvidence.reliability.successRatio : undefined,
    rightEvidence?.reliability?.status === 'measured' ? rightEvidence.reliability.successRatio : undefined,
    'desc',
  )
  if (reliability !== 0) return reliability

  const latency = compareKnownNumber(
    leftEvidence?.latency?.status === 'measured' ? leftEvidence.latency.medianMs : undefined,
    rightEvidence?.latency?.status === 'measured' ? rightEvidence.latency.medianMs : undefined,
  )
  if (latency !== 0) return latency

  if (preset === 'quality') {
    const qualityPriority = compareKnownNumber(left.route.priorityByPreset?.quality, right.route.priorityByPreset?.quality, 'desc')
    if (qualityPriority !== 0) return qualityPriority
  }
  return left.route.id.localeCompare(right.route.id)
}

export function createTaskAwareModelRouter({
  routes = [],
  audit,
  now = () => Date.now(),
  routerId = 'model-fabric:auto',
  model = 'auto',
  eligibility = null,
  evidence = null,
  scope = null,
  decisionService = null,
} = {}) {
  if (!Array.isArray(routes) || routes.length === 0) throw new TypeError('at least one model route is required')
  if (eligibility !== null && typeof eligibility !== 'function') throw new TypeError('route eligibility must be a function')
  if (decisionService !== null && typeof decisionService.choose !== 'function') throw new TypeError('decision service is invalid')
  const normalized = routes.map(normalizeRoute)
  if (new Set(normalized.map(route => route.id)).size !== normalized.length) {
    throw new TypeError('duplicate task-aware model route')
  }
  const unavailableUntil = new Map()

  function authorityFor(route, requirements, context) {
    if (!eligibility) {
      const declared = route.authority
      return declared && typeof declared === 'object' && !Array.isArray(declared) ? structuredClone(declared) : null
    }
    const result = eligibility(route, { requirements: structuredClone(requirements), context: structuredClone(context), scope: scope ? structuredClone(scope) : null })
    if (!result || typeof result !== 'object' || Array.isArray(result)) return null
    return result
  }

  function selectionPath({ prompt = '', context = {}, requirements: supplied = undefined } = {}) {
    const derived = supplied === undefined ? legacyOrStructuredRequirements(prompt, context) : { requirements: normalizeTaskRequirements(supplied), structured: true }
    const requirements = derived.requirements
    const candidates = normalized.map(route => {
      const reasons = []
      const metadata = requirementReasons(route, requirements, scope)
      reasons.push(...metadata.reasons)
      const preference = requirements.modelPreference
      if (preference?.mode === 'pinned' && modelPreferenceReason(route, preference)) reasons.push('pinned model does not match')
      const until = unavailableUntil.get(route.id) ?? 0
      if (until > now()) reasons.push('route is cooling down after a failure')
      const authority = authorityFor(route, requirements, context)
      if (!authority) return { route, status: 'unknown', reasons: [...reasons, 'trusted eligibility is unavailable'], unknown: true, authority: null, metadata }
      const authorityFields = ['connectionEnabled', 'agentAllowed', 'executorAllowed', 'requirementsSatisfied', 'pinSatisfied']
      const missing = authorityFields.filter(field => typeof authority[field] !== 'boolean')
      if (missing.length) return { route, status: 'unknown', reasons: [...reasons, `trusted eligibility missing: ${missing.join(', ')}`], unknown: true, authority, metadata }
      if (authority.connectionEnabled !== true) reasons.push('connection is disabled')
      if (authority.agentAllowed !== true) reasons.push('agent policy does not allow this route')
      if (authority.executorAllowed !== true) reasons.push('executor is not allowed')
      if (authority.requirementsSatisfied !== true) reasons.push(...(Array.isArray(authority.reasons) && authority.reasons.length
        ? authority.reasons
        : ['requirements are not satisfied']))
      if (authority.pinSatisfied !== true) reasons.push('agent pin is not satisfied')
      if (metadata.unknown.length) reasons.push(...metadata.unknown)
      const hardRejection = reasons.some(reason => !metadata.unknown.includes(reason)
        && reason !== 'trusted eligibility unavailable')
      const unresolved = metadata.unknown.length > 0
      const status = unresolved && !hardRejection ? 'unknown' : reasons.length ? 'rejected' : 'eligible'
      return { route, status, reasons, unknown: status === 'unknown', authority, metadata }
    })
    const eligible = candidates.filter(candidate => candidate.status === 'eligible')
    const selected = eligible.toSorted((left, right) => rankCandidates(left, right, requirements, evidence))
    return { requirements, structured: derived.structured, candidates, selected: selected[0] ?? null }
  }

  function explanationFor(path, context) {
    const eligible = path.candidates.filter(candidate => candidate.status === 'eligible')
    const preferred = path.requirements.modelPreference?.mode === 'preferred'
      && eligible.some(candidate => modelPreferenceReason(candidate.route, path.requirements.modelPreference) === null)
    // The pre-dispatch explanation must not claim Jev's yet-unmade choice.
    const pendingDecision = decisionService && eligible.length > 1 && eligible.length <= 8 && !preferred
    const selected = pendingDecision ? null : path.selected
    const selectedReason = selected
      ? selected.route.reason ?? (path.requirements.priorityPreset === 'economy'
        ? (evidenceFor(selected.route, path.requirements, evidence)?.cost?.status === 'measured'
          ? 'selected by measured cost evidence'
          : evidenceFor(selected.route, path.requirements, evidence)?.cost?.status === 'estimated'
            ? 'selected by operator-estimate cost evidence (not measured)'
            : 'selected by trusted hard filters and ranking; cost evidence is unknown')
        : 'selected by trusted hard filters and ranking')
      : null
    const selectedProjection = selected ? {
      ...candidateView(selected.route),
      reason: selectedReason,
    } : null
    return {
      schema: ROUTING_EXPLANATION_SCHEMA,
      taskId: boundedString(context?.taskId, 256) ? context.taskId : null,
      selected: selectedProjection,
      ...(pendingDecision ? { selectionPending: true } : {}),
      candidates: path.candidates.map(candidate => {
        const trustedEligible = candidate.authority
          ? ['connectionEnabled', 'agentAllowed', 'executorAllowed', 'requirementsSatisfied', 'pinSatisfied']
            .every(field => candidate.authority[field] === true)
          : false
        return {
          ...candidateView(candidate.route),
          status: candidate.status,
          reasons: candidate.reasons,
          // This bounded boolean lets a runtime-owned Preferred preflight
          // distinguish a route that is trusted but missing descriptive
          // metadata from one whose authority is itself unresolved. It does
          // not expose grants, scopes, or provider response data.
          trustedEligible,
          ...(candidate.status !== 'eligible' ? { details: candidate.reasons } : {}),
        }
      }),
      reasons: pendingDecision ? ['Jev selection pending among trusted eligible routes']
        : selected ? ['eligible after trusted hard filters', selectedReason] : ['NO_ELIGIBLE_MODEL_ROUTE'],
      evidence: selected ? (evidenceFor(selected.route, path.requirements, evidence) ?? { status: 'unknown' }) : { status: 'unknown' },
      observedAt: new Date(now()).toISOString(),
    }
  }

  function inferenceResourceClaims() {
    const claims = []
    const keys = new Set()
    for (const route of normalized) {
      // Eligibility, evidence, and cooldowns may change between admission
      // and invocation. A claim is safe only when every cached leaf is a
      // runtime-owned inference leaf; descriptive metadata cannot make a
      // native or custom fallback safe.
      if (route.nativeExecution === true || !isInferenceOnlyLeaf(route.router)) return null
      if (!boundedString(route.providerId, 512) || !boundedString(route.model, 512)) return null
      const key = `model:${route.providerId}:${route.model}`
      if (keys.has(key)) continue
      keys.add(key)
      claims.push({ key, access: 'read', verified: true })
    }
    if (decisionService && !keys.has('model:typesafe:jev-latest')) claims.push({ key: 'model:typesafe:jev-latest', access: 'read', verified: true })
    return claims.length > 0 ? claims : null
  }

  async function route(prompt, context = {}, controls = {}) {
    controls?.signal?.throwIfAborted()
    const path = selectionPath({ prompt, context })
    if (!path.selected) {
      const error = createTrustedModelCallNotSentError('no eligible model route', { code: 'NO_ELIGIBLE_MODEL_ROUTE', reason: path.candidates.some(candidate => candidate.status === 'unknown') ? 'TRUSTED_ROUTE_ELIGIBILITY_UNKNOWN' : 'NO_ELIGIBLE_MODEL_ROUTE' })
      audit?.append({ kind: 'model.route.rejected', taskId: context?.taskId ?? null, requirements: path.requirements, reasons: path.candidates.flatMap(candidate => candidate.reasons), dispatchState: 'not_sent', at: new Date(now()).toISOString() })
      throw error
    }
    const eligible = path.candidates.filter(candidate => candidate.status === 'eligible')
      .toSorted((left, right) => rankCandidates(left, right, path.requirements, evidence))
    let selected = path.selected
    let jevConfidence = null
    const preferred = path.requirements.modelPreference?.mode === 'preferred'
      && eligible.some(candidate => modelPreferenceReason(candidate.route, path.requirements.modelPreference) === null)
    if (decisionService && eligible.length > 1 && eligible.length <= 8 && !preferred) {
      const criteria = Object.fromEntries(eligible.map((candidate, index) => [
        `route${index}`,
        `${candidate.route.id}; provider: ${candidate.route.providerId ?? 'unknown'}; model: ${candidate.route.model ?? candidate.route.routerId}; capabilities: ${candidate.route.capabilities.join(', ')}; cost: ${candidate.route.costClass}; privacy: ${candidate.route.privacy ?? 'unknown'}`.slice(0, 512),
      ]))
      try {
        const answer = await decisionService.choose({
          state: JSON.stringify({ task: String(prompt).slice(0, 4000), stage: context?.stage ?? null,
            requirements: path.requirements }).slice(0, 8192),
          criteria,
          taskId: boundedString(context?.taskId, 512) ? context.taskId : 'unknown',
          use: 'model-route',
        })
        const index = answer ? Number(answer.choice.slice(5)) : -1
        if (answer && Number.isInteger(index) && answer.choice === `route${index}` && eligible[index]) {
          selected = eligible[index]
          jevConfidence = answer.confidence
        } else {
          audit?.append({ kind: 'jev.decision.fallback', use: 'model-route', taskId: context?.taskId ?? null,
            reason: 'JEV_LOW_CONFIDENCE', at: new Date(now()).toISOString() })
        }
      } catch (error) {
        audit?.append({ kind: 'jev.decision.fallback', use: 'model-route', taskId: context?.taskId ?? null,
          reason: boundedString(error?.code, 128) ? error.code : 'JEV_UNAVAILABLE', at: new Date(now()).toISOString() })
      }
      controls?.signal?.throwIfAborted()
    }
    const startedAt = now()
    const selectedEvidence = evidenceFor(selected.route, path.requirements, evidence)
    const selectionReason = jevConfidence !== null ? 'Jev choice among trusted eligible routes'
      : selected.route.reason
      ?? (path.requirements.priorityPreset === 'economy'
        ? (selectedEvidence?.cost?.status === 'measured'
          ? 'selected by measured cost evidence'
          : selectedEvidence?.cost?.status === 'estimated'
            ? 'selected by operator-estimate cost evidence (not measured)'
            : 'selected by trusted hard filters and ranking; cost evidence is unknown')
        : 'selected by trusted hard filters and ranking')
    audit?.append({ kind: 'model.route.selected', routeId: selected.route.id, routerId: selected.route.routerId, taskId: context?.taskId ?? null,
      requirements: path.requirements, selectionReason, ...(jevConfidence === null ? {} : { jevConfidence }),
      costMeasured: selectedEvidence?.cost?.status === 'measured', at: new Date(startedAt).toISOString() })
    try {
      const result = await selected.route.router.route(prompt, structuredClone(context), controls)
      controls?.signal?.throwIfAborted()
      if (evidence?.recordInvocation) await evidence.recordInvocation({
        providerId: selected.route.providerId ?? 'unknown', model: selected.route.model ?? selected.route.routerId,
        capability: path.requirements.capabilities?.[0] ?? selected.route.capabilities[0] ?? 'general', outcome: 'succeeded',
        durationMs: Math.max(0, now() - startedAt), cost: null,
      }).catch(() => {})
      return result
    } catch (error) {
      const cancelled = controls?.signal?.aborted === true || error?.name === 'AbortError' || error?.code === 'ABORT_ERR'
      if (!cancelled) unavailableUntil.set(selected.route.id, now() + COOLDOWN_MS)
      const state = dispatchState(error)
      audit?.append({ kind: 'model.route.failed', routeId: selected.route.id, taskId: context?.taskId ?? null, dispatchState: state, cancelled, at: new Date(now()).toISOString() })
      if (evidence?.recordInvocation) await evidence.recordInvocation({
        providerId: selected.route.providerId ?? 'unknown', model: selected.route.model ?? selected.route.routerId,
        capability: path.requirements.capabilities?.[0] ?? selected.route.capabilities[0] ?? 'general', outcome: state === 'not_sent' ? 'failed-not-sent' : 'unknown',
        durationMs: state === 'not_sent' ? null : Math.max(0, now() - startedAt), cost: null,
      }).catch(() => {})
      throw error
    }
  }

  const taskAwareRouter = validateModelRouter(Object.freeze({
    routerId,
    model,
    nativeExecution: normalized.some(route => route.nativeExecution === true),
    descriptor: Object.freeze({
      providerId: 'chimera',
      model,
      protocol: 'task-aware-model-fabric',
    }),
    explain({ requirements, context = {}, prompt = '' } = {}) {
      return explanationFor(selectionPath({ requirements, context, prompt }), context)
    },
    resourceClaim() {
      return inferenceResourceClaims()
    },
    route,
  }))
  if (inferenceResourceClaims() !== null) markInferenceOnlyRouter(taskAwareRouter)
  return taskAwareRouter
}

export { normalizeRoute, taskCapability }
