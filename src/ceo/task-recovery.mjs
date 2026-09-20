export const TASK_RECOVERY_SCHEMA = 'chimera.task-recovery.v1'

const MAX_RETAINED = 256
const MAX_INPUT = 4096
const ACTIONS = Object.freeze({
  inspect: Object.freeze({ id: 'inspect', label: 'Inspect retained work' }),
  reconnect: Object.freeze({ id: 'reconnect', label: 'Reconnect' }),
  reconcile: Object.freeze({ id: 'reconcile', label: 'Reconcile outcome' }),
  resumeQueued: Object.freeze({ id: 'resume-queued', label: 'Resume queued work' }),
  continuation: Object.freeze({ id: 'continue', label: 'Start explicit continuation' }),
  retryRead: Object.freeze({ id: 'retry-read', label: 'Retry reading' }),
  retry: Object.freeze({ id: 'retry', label: 'Retry this attempt' }),
})

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function bounded(value, maximum = 4096) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function clone(value) {
  try { return structuredClone(value) } catch { return null }
}

function action(name, enabled = true) {
  return { ...ACTIONS[name], enabled }
}

function exactBinding(call, taskId) {
  const binding = call?.binding
  const rootSlots = binding?.nodeId === null && binding?.assignmentId === null
  const specialistSlots = bounded(binding?.nodeId, 256) && bounded(binding?.assignmentId, 256)
  return record(binding)
    && binding.taskId === taskId
    && (rootSlots || specialistSlots)
    && bounded(binding.agentId, 128)
    && bounded(binding.stage, 128)
}

function operationId(value, fallback) {
  return bounded(value?.operationId, 256)
    ? value.operationId
    : bounded(value?.callId, 256) ? value.callId : fallback
}

function retained(kind, value, fallback) {
  const copy = clone(value)
  if (!record(copy)) return { kind, operationId: fallback, status: 'unknown' }
  return {
    kind,
    ...copy,
    operationId: operationId(copy, fallback),
  }
}

function hasUnknownStep(step) {
  if (!record(step)) return true
  if (step.effectOutcome === 'unknown' || step.status === 'unknown') return true
  if (['started', 'running', 'interrupted'].includes(step.status)) return true
  if (step.stage === 'tool-dispatch' && step.effectOutcome !== 'completed' && step.effectOutcome !== 'succeeded') return true
  return false
}

function expiredApproval(approval) {
  if (!record(approval)) return false
  if (approval.status === 'expired' || approval.expired === true) return true
  if (approval.status !== 'pending') return false
  const expiresAt = typeof approval.expiresAt === 'number'
    ? new Date(approval.expiresAt).getTime() : Date.parse(approval.expiresAt ?? '')
  return Number.isFinite(expiresAt) && expiresAt <= Date.now()
}

function uniqueActions(names) {
  return [...new Set(names)].map(name => action(name)).filter(value => value.id)
}

function unknownSummary() {
  return 'An external effect may have started; inspect before continuing.'
}

function supportsReconciliation(connection) {
  return connection?.supportsReconciliation === true
    || connection?.canReconcile === true
    || connection?.providerSupportsReconciliation === true
    || typeof connection?.reconcile === 'function'
}

export function classifyTaskRecovery({ task, modelCalls, steps = [], approvals, connection, cleanup } = {}) {
  const taskId = bounded(task?.taskId, 256) ? task.taskId : null
  const callOverflow = Array.isArray(modelCalls) && modelCalls.length > MAX_INPUT
  const stepOverflow = Array.isArray(steps) && steps.length > MAX_INPUT
  const approvalOverflow = Array.isArray(approvals) && approvals.length > MAX_INPUT
  const calls = Array.isArray(modelCalls) ? modelCalls.slice(0, MAX_INPUT).map(clone) : []
  const taskSteps = Array.isArray(steps) ? steps.slice(0, MAX_INPUT).map(clone) : []
  const taskApprovals = Array.isArray(approvals) ? approvals.slice(0, MAX_INPUT).map(clone) : []
  const retainedItems = []
  let unknownEffect = callOverflow || stepOverflow || approvalOverflow
  let unboundCall = false
  let disconnected = connection?.status === 'disconnected' || connection?.connected === false
  let cleanupBlocked = cleanup?.status === 'blocked' || cleanup?.status === 'unknown' || cleanup?.effectOutcome === 'unknown'

  for (const [index, call] of calls.entries()) {
    const item = retained('model-call', call, `model-call-${index + 1}`)
    retainedItems.push(item)
    if (!exactBinding(call, taskId)) unboundCall = true
    if (['started', 'ambiguous', 'unknown'].includes(call.status)
      || call.effectOutcome === 'unknown'
      || call.failure?.dispatchState === 'unknown') unknownEffect = true
  }
  for (const [index, step] of taskSteps.entries()) {
    retainedItems.push(retained('step', step, `step-${index + 1}`))
    if (hasUnknownStep(step)) unknownEffect = true
  }
  if (record(task?.checkpoint)) {
    retainedItems.push(retained('checkpoint', task.checkpoint, 'checkpoint'))
    if (task.checkpoint.effectOutcome === 'unknown' || task.checkpoint.stage === 'tool-dispatch') unknownEffect = true
  }
  if (cleanup) {
    retainedItems.push(retained('cleanup', cleanup, 'cleanup'))
    if (cleanupBlocked) unknownEffect = true
  }
  const expired = taskApprovals.some(expiredApproval)
  if (expired) retainedItems.push(...taskApprovals.filter(expiredApproval).map((value, index) => retained('approval', value, `approval-${index + 1}`)))
  if (task?.failure?.effectOutcome === 'unknown' || task?.failure?.dispatchState === 'unknown') unknownEffect = true
  if (task?.status === 'interrupted') unknownEffect = true
  if (unboundCall) unknownEffect = true

  const retainedBounded = retainedItems.slice(0, MAX_RETAINED)
  let state = 'failed'
  let summary = 'The task stopped with a known failure.'
  let retryAllowed = false
  const actionNames = []

  if (unknownEffect) {
    state = 'unknown'
    summary = unknownSummary()
    actionNames.push('inspect')
    if (supportsReconciliation(connection)) actionNames.push('reconcile')
  } else if (task?.status === 'queued' && task?.recoveryRequired === true) {
    state = 'paused'
    summary = 'This queued task needs explicit resumption after restart.'
    actionNames.push('resumeQueued')
  } else if (expired) {
    state = 'blocked'
    summary = 'The approval expired before this task could continue.'
    actionNames.push('inspect', 'continuation')
  } else if (disconnected) {
    state = 'disconnected'
    summary = 'The required connection is unavailable; reconnect before choosing a new action.'
    actionNames.push('reconnect')
  } else if (task?.failure?.dispatchState === 'not_sent') {
    state = 'retryable'
    summary = 'The task was denied before dispatch and can be explicitly retried.'
    retryAllowed = true
    actionNames.push('retry')
  } else if (task?.status === 'queued') {
    state = 'queued'
    summary = 'The task is queued and has not been resumed automatically.'
    actionNames.push('resumeQueued')
  } else if (task?.status === 'completed') {
    state = 'completed'
    summary = 'The task reached a durable completed state; inspect its retained evidence.'
    actionNames.push('inspect')
  } else if (task?.status === 'running') {
    state = 'running'
    summary = 'The task is still running; inspect retained progress before intervening.'
    actionNames.push('inspect')
  } else if (task?.status === 'waiting-for-approval') {
    state = 'waiting-for-approval'
    summary = 'The task is waiting for an approval decision.'
    actionNames.push('inspect')
  } else {
    actionNames.push('inspect', 'continuation')
  }

  if (disconnected && !actionNames.includes('retryRead')) actionNames.push('retryRead')
  return {
    schema: TASK_RECOVERY_SCHEMA,
    state,
    summary,
    retained: retainedBounded,
    actions: uniqueActions(actionNames),
    retryAllowed,
  }
}

export { ACTIONS as TASK_RECOVERY_ACTIONS }
