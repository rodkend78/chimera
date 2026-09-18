import { authorizeOperatorRequest } from './operator-http-auth.mjs'
import { isAllowedRequestOrigin } from './http-safety.mjs'
import { intakeError } from '../clients/intake-store.mjs'
import { publicRow } from '../clients/intake-service.mjs'

export function clientDirectoryAdapter(service) {
  return Object.fromEntries(['list', 'detail', 'document', 'addNote'].map(method => [method, async (...args) => {
    try { return await service[method](...args) }
    catch (cause) {
      const code = { CLIENT_INTAKE_INVALID: 'CLIENT_WORKSPACE_INVALID', CLIENT_INTAKE_NOT_FOUND: 'CLIENT_WORKSPACE_NOT_FOUND', CLIENT_INTAKE_CORRUPT: 'CLIENT_WORKSPACE_CORRUPT' }[cause?.code]
      if (code) throw Object.assign(new Error(code), { code })
      throw cause
    }
  }]))
}

export async function handleClientIntakeRequest({ pathname, request, service, operatorSessions }) {
  if (pathname !== '/api/client-intake' && !pathname.startsWith('/api/client-intake/')) return null
  const auth = authorizeOperatorRequest({ pathname, method: request.method, headers: request.headers }, operatorSessions)
  const error = (status, code) => ({ status, body: { error: code } })
  if (!auth.allowed) return error(auth.status, auth.error)
  const origin = Object.entries(request.headers ?? {}).find(([key]) => key.toLowerCase() === 'origin')?.[1]
  if (!isAllowedRequestOrigin(origin)) return error(403, 'ORIGIN_BLOCKED')
  const route = pathname.slice('/api/client-intake'.length)
  const routes = { '': ['GET', 'status'], '/clients': ['POST', 'createClient'], '/sync': ['POST', 'sync'], '/connect': ['POST', 'connect'], '/disconnect': ['POST', 'disconnect'], '/handoff': ['POST', 'handoff'] }
  if (!Object.hasOwn(routes, route)) return error(404, 'CLIENT_INTAKE_NOT_FOUND')
  const [method, action] = routes[route]
  if (request.method !== method) return error(405, 'METHOD_NOT_ALLOWED')
  try {
    let body = {}
    if (method === 'POST') {
      let size = 0; const chunks = []
      for await (const chunk of request) { const buffer = Buffer.from(chunk); size += buffer.length; if (size > 160 * 1024) throw intakeError('INVALID'); chunks.push(buffer) }
      body = size ? JSON.parse(Buffer.concat(chunks).toString()) : {}
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw intakeError('INVALID')
    }
    const value = await service[action](action === 'handoff' ? body.id : action === 'createClient' ? body : undefined)
    // Never return private evidence through mutation responses either.
    if (action === 'handoff') return { status: 200, body: publicRow(value) }
    return { status: action === 'createClient' ? 201 : 200, body: value }
  } catch (cause) {
    const code = /^CLIENT_INTAKE_[A-Z_]+$/.test(cause?.code) ? cause.code : cause instanceof SyntaxError ? 'CLIENT_INTAKE_INVALID' : 'CLIENT_INTAKE_UNAVAILABLE'
    return error(code.endsWith('_INVALID') ? 400 : code.endsWith('_NOT_FOUND') ? 404 : /_(?:CONFLICT|LOCKED|CORRUPT|REVIEW_REQUIRED)$/.test(code) ? 409 : 503, code)
  }
}
