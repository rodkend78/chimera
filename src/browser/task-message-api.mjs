import { authorizeOperatorRequest } from './operator-http-auth.mjs'

// Shared by the real server and disposable HTTP acceptance server. No runtime
// initialization here: importing this handler cannot touch the live pilot.
export async function handleTaskMessageRequest({ request, runtime, operatorSessions }) {
  const auth = authorizeOperatorRequest({ pathname: '/api/tasks/message', method: request.method, headers: request.headers }, operatorSessions)
  if (!auth.allowed) return { status: auth.status, body: { error: auth.error } }
  if (request.method !== 'POST') return { status: 405, body: { error: 'METHOD_NOT_ALLOWED' } }
  try {
    const chunks = []; let size = 0
    for await (const chunk of request) {
      size += chunk.length
      if (size > 32768) return { status: 413, body: { error: 'REQUEST_TOO_LARGE' } }
      chunks.push(chunk)
    }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { status: 400, body: { error: 'TASK_MESSAGE_INVALID' } }
    return { status: 200, body: await runtime.messageTask(input) }
  } catch (error) {
    const code = typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{2,127}$/.test(error.code) ? error.code : 'INTERNAL_ERROR'
    return { status: error instanceof SyntaxError || code.startsWith('TASK_MESSAGE_') ? 400 : code === 'TASK_NOT_FOUND' ? 404 : code === 'TASK_NOT_ACTIVE' ? 409 : 500,
      body: { error: error instanceof SyntaxError ? 'TASK_MESSAGE_INVALID' : code } }
  }
}
