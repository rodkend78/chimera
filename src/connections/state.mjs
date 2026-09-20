const SCHEMA = 'chimera.connection-state.v1'
const MAX_TEXT = 256
const MAX_MODEL = 512
const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,127}$/
const OPERATIONS = Object.freeze([
  'connect',
  'refresh',
  'test-safe',
  'test-model',
  'reconnect',
  'disconnect',
])

function connectionError(code, message = code) {
  const error = new Error(message)
  error.code = code
  return error
}

function providerIdOf(value) {
  if (typeof value !== 'string' || !PROVIDER_PATTERN.test(value)) {
    throw connectionError('CONNECTION_PROVIDER_INVALID')
  }
  return value
}

function safeLabel(value, maximum = MAX_TEXT) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) return null
  if (/[@\r\n]|(?:https?|file):\/\//i.test(value)) return null
  if (/(?:secret|token|password|credential|api[_-]?key|private[_-]?key)/i.test(value)) return null
  return value
}

function safeIdentifier(value, maximum = MAX_TEXT) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) return null
  return SAFE_ID_PATTERN.test(value) ? value : null
}

function safeModel(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_MODEL
    && /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,511}$/.test(value)
    ? value
    : null
}

function safeBoolean(value) {
  return value === true
}

function safeVerification(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const evidence = {
    revision: Number.isSafeInteger(value.revision) && value.revision >= 0 ? value.revision : null,
    machineRef: safeIdentifier(value.machineRef),
    operation: safeIdentifier(value.operation),
    model: safeModel(value.model),
    executor: safeLabel(value.executor),
    costClass: safeIdentifier(value.costClass),
    status: value.status === 'passed' ? 'passed' : value.status === 'failed' ? 'failed' : value.status === 'unknown' ? 'unknown' : null,
    at: typeof value.at === 'string' && value.at.length <= 64 && !/[\r\n]/.test(value.at) ? value.at : null,
    requestId: safeIdentifier(value.requestId),
    bindingFingerprint: typeof value.bindingFingerprint === 'string' && /^[a-f0-9]{64}$/.test(value.bindingFingerprint) ? value.bindingFingerprint : null,
    modelCallSent: typeof value.modelCallSent === 'boolean' ? value.modelCallSent : null,
    accountRef: safeLabel(value.accountRef),
    signedIn: typeof value.signedIn === 'boolean' ? value.signedIn : null,
    sessionStatus: safeLabel(value.sessionStatus),
  }
  return Object.fromEntries(Object.entries(evidence).filter(([, item]) => item !== null))
}

function safeError(value) {
  if (value === null || value === undefined || value === false) return null
  const code = typeof value === 'string' ? value : value && typeof value === 'object' ? value.code : null
  return { code: SAFE_CODE_PATTERN.test(code ?? '') ? code : 'CONNECTION_ERROR' }
}

function operationSupported(value) {
  if (typeof value === 'function') return true
  if (value === true) return true
  return Boolean(value && typeof value === 'object' && value.supported === true)
}

/**
 * Project adapter state into the deliberately small public connection shape.
 * This function is intentionally an allowlist: provider adapters must opt into
 * every operation and evidence field that is safe to expose.
 */
export function projectConnection(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw connectionError('CONNECTION_STATE_INVALID')
  }
  const providerId = providerIdOf(input.providerId)
  const enabled = input.enabled === undefined ? true : input.enabled
  if (typeof enabled !== 'boolean') throw connectionError('CONNECTION_STATE_INVALID')
  const revision = input.revision === undefined ? 0 : input.revision
  if (!Number.isSafeInteger(revision) || revision < 0) throw connectionError('CONNECTION_REVISION_INVALID')

  const machineRef = safeIdentifier(input.machineRef)
  const accountRef = safeLabel(input.accountRef)
  const signedIn = safeBoolean(input.signedIn)
  const catalogAvailable = safeBoolean(input.catalogAvailable)
  const sessionStatus = safeLabel(input.sessionStatus)
  const selectedModel = safeModel(input.selectedModel ?? input.model)
  const executor = safeLabel(input.executor)
  const verification = safeVerification(input.lastVerification)
  const error = safeError(input.error)
  const catalogModels = Array.isArray(input.models)
    ? input.models.map(item => typeof item === 'string' ? item : item?.id).map(safeModel).filter(Boolean)
    : []
  const modelCatalogCurrent = verification?.status !== 'passed' || verification?.model === undefined || verification.operation !== 'test-model'
    || (selectedModel !== null
      ? verification.model === selectedModel && (catalogModels.length === 0 || catalogModels.includes(verification.model))
      : catalogModels.includes(verification.model))
  const executorCurrent = verification?.status !== 'passed' || verification?.operation !== 'test-model'
    ? (verification?.executor === undefined || (executor !== null && verification.executor === executor))
    : (verification?.executor !== undefined && executor !== null && verification.executor === executor)
  const current = Boolean(machineRef)
    && verification?.revision === revision
    && verification.machineRef === machineRef
    && (verification.accountRef === undefined || verification.accountRef === accountRef)
    && (verification.signedIn === undefined || verification.signedIn === signedIn)
    && (verification.sessionStatus === undefined || verification.sessionStatus === sessionStatus)
    && modelCatalogCurrent
    && (verification.model === undefined || selectedModel === null || verification.model === selectedModel)
    && executorCurrent

  let status = 'not-connected'
  if (enabled && error) status = 'needs-attention'
  else if (enabled && current && verification.status === 'passed') status = 'verified'
  else if (enabled && current && verification.status === 'unknown') status = 'needs-attention'
  else if (enabled && current && verification.status === 'failed') status = 'needs-attention'
  else if (enabled && catalogAvailable) status = 'available'
  else if (enabled && signedIn) status = 'signed-in'

  const operations = Object.fromEntries(OPERATIONS.map((operation) => [
    operation,
    operationSupported(input.operations?.[operation]),
  ]))

  return {
    schema: SCHEMA,
    providerId,
    status,
    enabled,
    revision,
    catalogAvailable,
    provenance: {
      machineRef,
      accountRef,
      signedIn,
      ...(sessionStatus ? { sessionStatus } : {}),
      ...(selectedModel ? { selectedModel } : {}),
      ...(executor ? { executor } : {}),
    },
    operations,
    verification,
    error,
  }
}

export const CONNECTION_OPERATIONS = OPERATIONS
export const CONNECTION_STATE_SCHEMA = SCHEMA
export { PROVIDER_PATTERN }
