import { isAllowedRequestOrigin } from './http-safety.mjs'
import { authorizeOperatorRequest } from './operator-http-auth.mjs'

export async function handleRjAwsRequest({ pathname, request, operatorSessions, runtime }) {
  if (!['/api/rj-aws/verify', '/api/rj-aws/reconcile'].includes(pathname)) return null
  const reconcile = pathname === '/api/rj-aws/reconcile'
  if (!isAllowedRequestOrigin(request.headers?.origin)) return { status: 403, body: { error: 'ORIGIN_BLOCKED' } }
  const auth = authorizeOperatorRequest({ pathname, method: request.method, headers: request.headers }, operatorSessions)
  if (!auth.allowed) return { status: auth.status, body: { error: auth.error } }
  if (request.method !== 'POST') return { status: 405, body: { error: 'METHOD_NOT_ALLOWED' } }
  let text = ''
  let size = 0
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk)
    if (size > 4096) return { status: 413, body: { error: 'REQUEST_TOO_LARGE' } }
    text += chunk
  }
  let body
  try { body = JSON.parse(text || '{}') } catch { body = null }
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || (reconcile ? Object.keys(body).join(',') !== 'requestId' || typeof body.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(body.requestId) : Object.keys(body).length !== 0)) {
    return { status: 400, body: { error: 'RJ_AWS_REQUEST_INVALID' } }
  }
  try {
    return { status: 200, body: await (reconcile ? runtime.reconcileRjAwsRequest(body) : runtime.verifyRjAwsConnection()) }
  } catch (error) {
    const code = /^RJ_[A-Z0-9_]+$/.test(error?.code) || error?.code === 'TASK_ALREADY_RUNNING'
      ? error.code
      : 'RJ_AWS_UNAVAILABLE'
    return { status: code === 'TASK_ALREADY_RUNNING' ? 409 : 503, body: { error: code } }
  }
}
