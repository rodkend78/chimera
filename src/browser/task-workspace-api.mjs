import { authorizeOperatorRequest } from './operator-http-auth.mjs'

const PATH_PREFIX = '/api/tasks/'
const PATH_SUFFIX = '/workspace'

function errorCode(error, fallback = 'INTERNAL_ERROR') {
  const code = typeof error?.code === 'string' ? error.code : error instanceof Error ? error.message : ''
  return /^[A-Z][A-Z0-9_]{2,127}$/.test(code) ? code : fallback
}

function taskIdFromPath(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith(PATH_PREFIX) || !pathname.endsWith(PATH_SUFFIX)) return null
  const encoded = pathname.slice(PATH_PREFIX.length, -PATH_SUFFIX.length)
  if (!encoded || encoded.includes('/')) return null
  try {
    const taskId = decodeURIComponent(encoded)
    return typeof taskId === 'string' && taskId.length > 0 && taskId.length <= 256 ? taskId : null
  } catch {
    return null
  }
}

// This module is deliberately a small handler seam. Importing it does not
// construct a runtime, open a browser, or start the real server.
export async function handleTaskWorkspaceRequest({ pathname, request, runtime, operatorSessions } = {}) {
  const resolvedPath = pathname ?? (() => {
    try { return new URL(request?.url ?? '', 'http://chimera.invalid').pathname } catch { return null }
  })()
  const matches = typeof resolvedPath === 'string' && resolvedPath.startsWith(PATH_PREFIX) && resolvedPath.endsWith(PATH_SUFFIX)
  if (!matches) return null
  const auth = authorizeOperatorRequest({ pathname: resolvedPath, method: request?.method, headers: request?.headers }, operatorSessions)
  if (!auth.allowed) return { status: auth.status, body: { error: auth.error } }
  if (request?.method !== 'GET') return { status: 405, body: { error: 'METHOD_NOT_ALLOWED' } }
  const taskId = taskIdFromPath(resolvedPath)
  if (!taskId) return { status: 400, body: { error: 'TASK_WORKSPACE_INVALID' } }
  try {
    const body = await runtime.taskWorkspace(taskId)
    if (!body || typeof body !== 'object' || body.schema !== 'chimera.task-workspace.v1'
      || body.task?.taskId !== taskId) {
      return { status: 500, body: { error: 'TASK_WORKSPACE_IDENTITY_INVALID' } }
    }
    return { status: 200, body }
  } catch (error) {
    const code = errorCode(error)
    const status = code === 'TASK_NOT_FOUND' || code === 'PROJECT_SESSION_NOT_FOUND' ? 404
      : code === 'TASK_WORKSPACE_MISMATCH' || code === 'TASK_WORKSPACE_INVALID' ? 400
        : 500
    return { status, body: { error: code } }
  }
}
