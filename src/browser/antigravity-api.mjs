import { isAllowedRequestOrigin } from './http-safety.mjs'
import { authorizeOperatorRequest } from './operator-http-auth.mjs'

export async function handleAntigravityRequest({ pathname, request, operatorSessions, connection }) {
  if (!['/api/antigravity/state', '/api/antigravity/refresh', '/api/antigravity/open'].includes(pathname)) return null
  if (!isAllowedRequestOrigin(request.headers?.origin)) return { status: 403, body: { error: 'ORIGIN_BLOCKED' } }
  const auth = authorizeOperatorRequest({ pathname, method: request.method, headers: request.headers }, operatorSessions)
  if (!auth.allowed) return { status: auth.status, body: { error: auth.error } }
  const expected = pathname.endsWith('/state') ? 'GET' : 'POST'
  if (request.method !== expected) return { status: 405, body: { error: 'METHOD_NOT_ALLOWED' } }
  try {
    if (expected === 'GET') return { status: 200, body: connection.state() }
    let size = 0, text = ''
    for await (const chunk of request) {
      size += Buffer.byteLength(chunk)
      if (size > 4096) return { status: 413, body: { error: 'REQUEST_TOO_LARGE' } }
      text += chunk
    }
    let body
    try { body = JSON.parse(text || '{}') } catch { body = null }
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) return { status: 400, body: { error: 'ANTIGRAVITY_REQUEST_INVALID' } }
    return pathname.endsWith('/open')
      ? { status: 202, body: await connection.openDesktop() }
      : { status: 200, body: await connection.refresh() }
  } catch (error) {
    return { status: 503, body: { error: /^ANTIGRAVITY_[A-Z_]+$/.test(error.code) ? error.code : 'ANTIGRAVITY_UNAVAILABLE' } }
  }
}
