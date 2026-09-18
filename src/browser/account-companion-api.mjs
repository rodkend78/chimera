import { isAllowedRequestOrigin } from './http-safety.mjs'
import { authorizeOperatorRequest } from './operator-http-auth.mjs'
import { safeId } from '../account-browser/protocol.mjs'

const ROUTES = new Map([
  ['/api/account-companion/state', null],
  ['/api/account-companion/pair/approve', ['approvePair', 'pairingId']],
  ['/api/account-companion/pair/revoke', ['revokePair', 'profileId']],
  ['/api/account-companion/lease/revoke', ['revokeLease', 'leaseId']],
])

export async function handleAccountCompanionRequest({ pathname, request, operatorSessions, companion }) {
  if (!ROUTES.has(pathname)) return null
  const reply = (status, error) => ({ status, body: { error } })
  if (!isAllowedRequestOrigin(request.headers?.origin)) return reply(403, 'ORIGIN_BLOCKED')
  // The shared helper exempts preflight. These exact routes still require a
  // session for every method, including methods they ultimately reject.
  if (!operatorSessions.authenticate(request.headers?.cookie)) return reply(401, 'OPERATOR_AUTH_REQUIRED')
  const auth = authorizeOperatorRequest({ pathname, method: request.method, headers: request.headers }, operatorSessions)
  if (!auth.allowed) return reply(auth.status, auth.error)
  const operation = ROUTES.get(pathname)
  if (request.method !== (operation ? 'POST' : 'GET')) return reply(405, 'METHOD_NOT_ALLOWED')
  if (!operation) {
    try { return { status: 200, body: companion.state() } } catch { return reply(503, 'ACCOUNT_COMPANION_UNAVAILABLE') }
  }
  let input
  try {
    const chunks = []; let size = 0
    for await (const chunk of request) {
      size += chunk.length
      if (size <= 4096) chunks.push(chunk)
    }
    if (size > 4096) return reply(413, 'REQUEST_TOO_LARGE')
    input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch { return reply(400, 'ACCOUNT_COMPANION_REQUEST_INVALID') }
  const [method, key] = operation
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || !safeId(input[key])) return reply(400, 'ACCOUNT_COMPANION_REQUEST_INVALID')
  if (!companion?.broker) return reply(503, 'ACCOUNT_COMPANION_UNAVAILABLE')
  try {
    await companion.broker[method](input)
    return { status: 200, body: companion.state() }
  } catch { return reply(409, 'ACCOUNT_COMPANION_OPERATION_UNCONFIRMED') }
}
