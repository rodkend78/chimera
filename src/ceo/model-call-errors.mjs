const trustedNotSentErrors = new WeakSet()

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
