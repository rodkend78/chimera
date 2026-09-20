import { isAllowedRequestOrigin } from './http-safety.mjs'
import { authorizeOperatorRequest } from './operator-http-auth.mjs'

const ACTION_PATH = '/api/connections/action'
const STATE_PATH = '/api/connections'
const RECEIPT_PATH = '/api/connections/receipt'
const ACTIONS = new Set(['connect', 'refresh', 'test-safe', 'test-model', 'reconnect', 'disconnect'])
const FIELDS = new Set(['providerId', 'operation', 'model', 'requestId', 'expectedRevision', 'allowQuotaUse'])
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/

function codeOf(error, fallback = 'CONNECTION_UNAVAILABLE') {
  return typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{2,127}$/.test(error.code) ? error.code : fallback
}

function safeReceipt(error) {
  const receipt = error?.receipt
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return null
  if (typeof receipt.requestId !== 'string' || !IDENTIFIER.test(receipt.requestId)) return null
  const safe = { requestId: receipt.requestId }
  if (typeof receipt.providerId === 'string' && IDENTIFIER.test(receipt.providerId)) safe.providerId = receipt.providerId
  if (typeof receipt.operation === 'string' && ACTIONS.has(receipt.operation)) safe.operation = receipt.operation
  if (typeof receipt.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,511}$/.test(receipt.model)) safe.model = receipt.model
  if (['pending', 'succeeded', 'failed', 'unknown'].includes(receipt.status)) safe.status = receipt.status
  return safe
}

async function bodyOf(request) {
  let text = ''
  let size = 0
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk)
    if (size > 4096) throw Object.assign(new Error('REQUEST_TOO_LARGE'), { code: 'REQUEST_TOO_LARGE' })
    text += chunk
  }
  try {
    const body = JSON.parse(text || '{}')
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null
  } catch {
    return null
  }
}

function validActionBody(body) {
  if (!body || Object.keys(body).some((key) => !FIELDS.has(key))) return false
  if (typeof body.providerId !== 'string' || !IDENTIFIER.test(body.providerId)) return false
  if (typeof body.operation !== 'string' || !ACTIONS.has(body.operation)) return false
  if (typeof body.requestId !== 'string' || !IDENTIFIER.test(body.requestId)) return false
  if (body.model !== undefined && (typeof body.model !== 'string' || body.model.length === 0 || body.model.length > 512)) return false
  if (body.expectedRevision !== undefined && (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0)) return false
  if (body.allowQuotaUse !== undefined && typeof body.allowQuotaUse !== 'boolean') return false
  return true
}

export async function handleConnectionsRequest({ pathname, request, operatorSessions, service } = {}) {
  if (![STATE_PATH, ACTION_PATH, RECEIPT_PATH].includes(pathname)) return null
  if (!request || !service || !operatorSessions) throw new TypeError('Connections API requires request, service, and operator sessions')
  if (!isAllowedRequestOrigin(request.headers?.origin)) return { status: 403, body: { error: 'ORIGIN_BLOCKED' } }

  const auth = authorizeOperatorRequest({ pathname, method: request.method, headers: request.headers }, operatorSessions)
  if (!auth.allowed) return { status: auth.status, body: { error: auth.error } }
  if (pathname === RECEIPT_PATH) {
    if (request.method !== 'GET') return { status: 405, body: { error: 'METHOD_NOT_ALLOWED' } }
    const url = new URL(request.url ?? RECEIPT_PATH, 'http://chimera.local')
    const providerId = url.searchParams.get('providerId')
    const requestId = url.searchParams.get('requestId')
    if (!providerId || !IDENTIFIER.test(providerId) || !requestId || !IDENTIFIER.test(requestId)) return { status: 400, body: { error: 'CONNECTION_RECEIPT_QUERY_INVALID' } }
    try {
      const result = await service.receipt(providerId, requestId)
      return result ? { status: 200, body: result } : { status: 404, body: { error: 'CONNECTION_RECEIPT_NOT_FOUND' } }
    } catch (error) {
      const code = codeOf(error)
      return { status: code === 'CONNECTION_PROVIDER_UNSUPPORTED' ? 404 : 400, body: { error: code } }
    }
  }
  if (pathname === STATE_PATH) {
    if (request.method !== 'GET') return { status: 405, body: { error: 'METHOD_NOT_ALLOWED' } }
    try {
      return { status: 200, body: { schema: 'chimera.connections.v1', connections: await service.list() } }
    } catch (error) {
      return { status: 503, body: { error: codeOf(error) } }
    }
  }
  if (request.method !== 'POST') return { status: 405, body: { error: 'METHOD_NOT_ALLOWED' } }
  let body
  try {
    body = await bodyOf(request)
  } catch (error) {
    return { status: error?.code === 'REQUEST_TOO_LARGE' ? 413 : 400, body: { error: error?.code === 'REQUEST_TOO_LARGE' ? 'REQUEST_TOO_LARGE' : 'CONNECTION_ACTION_INVALID' } }
  }
  if (!validActionBody(body)) return { status: 400, body: { error: 'CONNECTION_ACTION_INVALID' } }
  try {
    return { status: 200, body: await service.act(body) }
  } catch (error) {
    const code = codeOf(error)
    const status = code === 'CONNECTION_DISABLED' || code === 'CONNECTION_REVISION_STALE' || code === 'CONNECTION_REQUEST_CONFLICT'
      || code === 'CONNECTION_OPERATION_UNKNOWN' || code === 'CONNECTION_UNRESOLVED_BINDING' ? 409
      : code === 'CONNECTION_UNAVAILABLE' ? 503 : 400
    const receipt = safeReceipt(error)
    return { status, body: {
      error: code,
      ...(receipt ? { receipt } : {}),
      ...(code === 'CONNECTION_OPERATION_UNKNOWN' || code === 'CONNECTION_UNRESOLVED_BINDING' ? { reconciliationRequired: true, retryAllowed: false } : {}),
    } }
  }
}
