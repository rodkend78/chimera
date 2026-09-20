const trustedNotSentErrors = new WeakSet()
const trustedTaskFailures = new WeakSet()

function bounded(value, maximum) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

export function createTrustedModelCallNotSentError(message, details = {}) {
  const error = new Error(message)
  error.name = details.name ?? 'ModelCallNotSentError'
  error.code = details.code ?? 'MODEL_CALL_NOT_SENT'
  if (details.reason !== undefined) error.reason = details.reason
  if (details.actionId !== undefined) error.actionId = details.actionId
  error.dispatchState = 'not_sent'
  trustedNotSentErrors.add(error)
  return error
}

export function isTrustedModelCallNotSentError(error) {
  return error instanceof Error && trustedNotSentErrors.has(error)
}

// This is the only runtime-owned conversion from a model-call error into a
// task failure. The returned object is opaque to callers: task-ledger accepts
// its dispatch classification only while this exact object remains branded in
// memory. A structured clone or provider-supplied object is therefore never a
// source of retry authority.
export function createTaskFailureFromError(error) {
  const failure = Object.freeze({
    code: bounded(error?.code, 256) ? error.code : 'TASK_FAILED',
    message: bounded(error?.message, 4_096) ? error.message : 'The task failed.',
    dispatchState: isTrustedModelCallNotSentError(error) ? 'not_sent' : 'unknown',
  })
  trustedTaskFailures.add(failure)
  return failure
}

export function isTrustedTaskFailure(failure) {
  return failure !== null && typeof failure === 'object' && trustedTaskFailures.has(failure)
}
