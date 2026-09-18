import { createTrustedModelCallNotSentError } from './model-call-errors.mjs'
import { validateModelRouter } from './model-router.mjs'

function boundedString(value, maximum = 2048) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function taskCapability(prompt, context) {
  if (['decompose', 'synthesize'].includes(context?.stage)) return 'orchestration'
  if (['coding', 'bulk', 'research', 'reasoning', 'multimodal-understanding'].includes(context?.taskKind)) return context.taskKind
  const text = `${prompt} ${context?.objective ?? ''}`.toLowerCase()
  if (/\b(code|coding|implement|implementation|debug|fix|test|repository|repo|commit|build|refactor)\b/.test(text)) return 'coding'
  if (/\b(image|images|photo|photos|video|videos|visual|multimodal|frame|frames)\b/.test(text)
    && /\b(analy[sz]e|inspect|review|understand|describe|compare|extract|summari[sz]e)\b/.test(text)) {
    return 'multimodal-understanding'
  }
  if (/\b(extract|classify|format|bulk|records?|rows?|summari[sz]e|transform|normalize)\b/.test(text)) return 'bulk'
  if (/\b(research|compare|investigate|evidence|citations?|analy[sz]e|analysis)\b/.test(text)) return 'research'
  return 'reasoning'
}

function normalizeRoute(route) {
  if (!route || !boundedString(route.id, 128)
    || !Array.isArray(route.capabilities)
    || route.capabilities.length === 0
    || route.capabilities.some((capability) => !boundedString(capability, 64))
    || !boundedString(route.costClass, 64)) {
    throw new TypeError('invalid task-aware model route')
  }
  return Object.freeze({
    id: route.id,
    router: validateModelRouter(route.router),
    capabilities: Object.freeze([...new Set(route.capabilities)]),
    costClass: route.costClass,
    priority: Number.isFinite(route.priority) ? route.priority : 0,
  })
}

export function createTaskAwareModelRouter({
  routes,
  audit,
  now = () => Date.now(),
  routerId = 'model-fabric:auto',
  model = 'auto',
} = {}) {
  if (!Array.isArray(routes) || routes.length === 0
    || !audit || typeof audit.append !== 'function'
    || typeof now !== 'function'
    || !boundedString(routerId, 256)
    || !boundedString(model, 512)) {
    throw new TypeError('task-aware model router requires routes and audit')
  }
  const normalized = routes.map(normalizeRoute)
  const health = new Map()
  if (new Set(normalized.map((route) => route.id)).size !== normalized.length) {
    throw new TypeError('duplicate task-aware model route')
  }
  return validateModelRouter(Object.freeze({
    routerId,
    nativeExecution: normalized.some(route => route.router.nativeExecution === true),
    descriptor: Object.freeze({
      providerId: 'chimera',
      model,
      protocol: 'task-aware-model-fabric',
    }),
    async route(prompt, context = {}, controls = {}) {
      controls.signal?.throwIfAborted()
      const capability = taskCapability(prompt, context)
      const eligible = normalized.filter((route) => route.capabilities.includes(capability)
        && (health.get(route.router.routerId)?.retryAfter ?? 0) <= now())
      const costs = { subscription: 0, low: 1, medium: 2, high: 3 }
      eligible.sort((a, b) => b.priority - a.priority
        || (context.costPreference === 'economy' ? (costs[a.costClass] ?? 4) - (costs[b.costClass] ?? 4) : 0))
      const selected = eligible[0]
      if (!selected) {
        throw createTrustedModelCallNotSentError(
          `no model route supports ${capability}`,
          { code: 'NO_ELIGIBLE_MODEL_ROUTE', reason: capability },
        )
      }
      audit.append({
        kind: 'model.route.selected',
        taskId: boundedString(context?.taskId, 512) ? context.taskId : 'unknown',
        stage: boundedString(context?.stage, 64) ? context.stage : 'unknown',
        capability,
        routeId: selected.id,
        providerRouterId: selected.router.routerId,
        costClass: selected.costClass,
        selectionReason: `${context.taskKind === capability ? 'explicit task kind' : ['decompose', 'synthesize'].includes(context.stage) ? 'orchestration stage' : 'task-text capability heuristic'}; eligible route priority${context.costPreference === 'economy' ? ' and cost class' : ''}; no recent provider failure`,
        eligibleRouteIds: eligible.map((route) => route.id),
        costMeasured: false,
        at: new Date(now()).toISOString(),
      })
      try {
        const result = await selected.router.route(prompt, structuredClone(context), controls)
        controls.signal?.throwIfAborted()
        health.delete(selected.router.routerId)
        return result
      } catch (error) {
        // Do not retry an ambiguous dispatched request on a second provider.
        // Cooldown affects subsequent independent calls only.
        const cancelled = controls.signal?.aborted === true
        if (!cancelled) health.set(selected.router.routerId, { retryAfter: now() + 30_000 })
        audit.append({ kind: 'model.route.failed', routeId: selected.id,
          taskId: boundedString(context.taskId, 512) ? context.taskId : 'unknown',
          dispatchState: error?.dispatchState === 'not_sent' ? 'not_sent' : 'unknown',
          cancelled,
          retryAfter: cancelled ? null : new Date(now() + 30_000).toISOString(), at: new Date(now()).toISOString() })
        throw error
      }
    },
  }))
}
