import { isAllowedRequestOrigin } from './http-safety.mjs'
import { authorizeOperatorRequest } from './operator-http-auth.mjs'

const ROUTES = new Set(['/api/account-browser/state', '/api/account-browser/open'])
const STATUS_BY_ERROR = new Map([
  ['ACCOUNT_BROWSER_URL_INVALID', 400],
  ['ACCOUNT_BROWSER_UNSUPPORTED_PLATFORM', 409],
  ['ACCOUNT_BROWSER_NOT_INSTALLED', 409],
  ['ACCOUNT_BROWSER_UNAVAILABLE', 503],
  ['ACCOUNT_BROWSER_PROFILE_UNAVAILABLE', 503],
  ['ACCOUNT_BROWSER_AUDIT_UNAVAILABLE', 503],
  ['ACCOUNT_BROWSER_LAUNCH_UNCONFIRMED', 502],
  ['ACCOUNT_BROWSER_RESULT_UNRECORDED', 503],
])

async function boundedJson(request) {
  const chunks = []
  let size = 0
  let oversized = false
  for await (const chunk of request) {
    size += chunk.length
    if (size > 4096) oversized = true
    if (!oversized) chunks.push(chunk)
  }
  if (oversized) throw Object.assign(new Error('REQUEST_TOO_LARGE'), { code: 'REQUEST_TOO_LARGE' })
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function validInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false
  const keys = Object.keys(input)
  return keys.every(key => key === 'url')
    && (!Object.hasOwn(input, 'url') || typeof input.url === 'string')
}

export async function handleAccountBrowserRequest({ pathname, request, operatorSessions, launcher }) {
  if (!ROUTES.has(pathname)) return null
  if (!isAllowedRequestOrigin(request.headers?.origin)) {
    return { status: 403, body: { error: 'ORIGIN_BLOCKED' } }
  }
  const auth = authorizeOperatorRequest({ pathname, method: request.method, headers: request.headers }, operatorSessions)
  if (!auth.allowed) return { status: auth.status, body: { error: auth.error } }

  const method = String(request.method ?? 'GET').toUpperCase()
  const expectedMethod = pathname === '/api/account-browser/state' ? 'GET' : 'POST'
  if (method !== expectedMethod) return { status: 405, body: { error: 'METHOD_NOT_ALLOWED' } }

  try {
    if (pathname === '/api/account-browser/state') {
      return { status: 200, body: await launcher.state() }
    }
    let input
    try {
      input = await boundedJson(request)
    } catch (error) {
      if (error?.code === 'REQUEST_TOO_LARGE') return { status: 413, body: { error: 'REQUEST_TOO_LARGE' } }
      return { status: 400, body: { error: 'ACCOUNT_BROWSER_REQUEST_INVALID' } }
    }
    if (!validInput(input)) return { status: 400, body: { error: 'ACCOUNT_BROWSER_REQUEST_INVALID' } }
    return { status: 202, body: await launcher.open(input) }
  } catch (error) {
    const status = STATUS_BY_ERROR.get(error?.code)
    return status
      ? { status, body: { error: error.code } }
      : { status: 500, body: { error: 'INTERNAL_ERROR' } }
  }
}
