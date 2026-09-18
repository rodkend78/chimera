import { authorizeOperatorRequest } from './operator-http-auth.mjs'
import { isAllowedRequestOrigin } from './http-safety.mjs'

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const BODY_LIMIT = 160 * 1024
const response = (status, error) => ({ status, body: { error } })

async function noteBody(request) {
  const chunks = []; let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > BODY_LIMIT) throw Object.assign(new Error('CLIENT_WORKSPACE_INVALID'), { code: 'CLIENT_WORKSPACE_INVALID' })
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export async function handleClientWorkspaceRequest({ pathname, request, store, operatorSessions }) {
  if (typeof pathname !== 'string' || (pathname !== '/api/clients' && !pathname.startsWith('/api/clients/'))) return null
  const auth = authorizeOperatorRequest({ pathname, method: request.method, headers: request.headers }, operatorSessions)
  if (!auth.allowed) return response(auth.status, auth.error)
  const originKey = Object.keys(request.headers ?? {}).find(key => key.toLowerCase() === 'origin')
  if (!isAllowedRequestOrigin(request.headers?.[originKey])) return response(403, 'ORIGIN_BLOCKED')
  try {
    const parts = pathname.split('/').slice(3).map(part => decodeURIComponent(part))
    if (parts.some(part => !ID.test(part))) return response(400, 'CLIENT_WORKSPACE_INVALID')
    const route = parts.length === 0 ? 'list' : parts.length === 1 ? 'detail'
      : parts.length === 3 && parts[1] === 'documents' ? 'document'
        : parts.length === 2 && parts[1] === 'notes' ? 'note' : null
    if (!route) return response(404, 'CLIENT_WORKSPACE_NOT_FOUND')
    if (request.method !== (route === 'note' ? 'POST' : 'GET')) return response(405, 'METHOD_NOT_ALLOWED')
    if (route === 'list') return { status: 200, body: await store.list() }
    if (route === 'detail') return { status: 200, body: await store.detail(parts[0]) }
    if (route === 'document') return { status: 200, body: await store.document(parts[0], parts[2]) }
    return { status: 201, body: await store.addNote(parts[0], await noteBody(request)) }
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof URIError || error?.code === 'CLIENT_WORKSPACE_INVALID') return response(400, 'CLIENT_WORKSPACE_INVALID')
    if (error?.code === 'CLIENT_WORKSPACE_NOT_FOUND') return response(404, 'CLIENT_WORKSPACE_NOT_FOUND')
    if (error?.code === 'CLIENT_WORKSPACE_CORRUPT') return response(409, 'CLIENT_WORKSPACE_CORRUPT')
    return response(500, 'CLIENT_WORKSPACE_UNAVAILABLE')
  }
}
