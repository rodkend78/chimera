import { createReadStream } from 'node:fs'
import { access, mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { handleCodexAuthRequest } from './auth-api.mjs'
import { handleAntigravityRequest } from './antigravity-api.mjs'
import { handleConnectionsRequest } from './connections-api.mjs'
import { handleRjAwsRequest } from './rj-aws-api.mjs'
import { assertLoopbackHost, corsAllowOrigin, isAllowedRequestOrigin, resolveAppAsset } from './http-safety.mjs'
import { authorizeOperatorRequest, authorizeOperatorWebSocket } from './operator-http-auth.mjs'
import { OperatorSessionManager } from './operator-session.mjs'
import { ChimeraBrowserRuntime } from './runtime.mjs'
import { createLatestFrameSender } from './executor.mjs'
import { handleTaskMessageRequest } from './task-message-api.mjs'
import { handleTaskWorkspaceRequest } from './task-workspace-api.mjs'
import { createAccountBrowserLauncher } from './account-browser-launcher.mjs'
import { handleAccountBrowserRequest } from './account-browser-api.mjs'
import { handleAccountCompanionRequest } from './account-companion-api.mjs'
import { ClientWorkspaceStore } from '../clients/workspace-store.mjs'
import { handleClientWorkspaceRequest } from './client-workspace-api.mjs'
import { ClientIntakeService } from '../clients/intake-service.mjs'
import { GoogleConnection } from '../clients/google-connection.mjs'
import { GoogleIntake } from '../clients/google-intake.mjs'
import { handleClientIntakeRequest, clientDirectoryAdapter } from './client-intake-api.mjs'
import { handleAgentRequest } from './agent-api-handler.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const APP_DIST = join(ROOT, 'app/dist')
const PROFILE_DIR = join(ROOT, '.chimera/browser-profiles/ceo')
const PORT = Number(process.env.CHIMERA_PORT ?? 4174)
const HOST = assertLoopbackHost(process.env.CHIMERA_HOST ?? '127.0.0.1')
const OPERATOR_SESSION_FILE = join(ROOT, '.chimera/operator/session.json')

await mkdir(PROFILE_DIR, { recursive: true })
const operatorSessions = await OperatorSessionManager.open({ filePath: OPERATOR_SESSION_FILE })
const runtime = new ChimeraBrowserRuntime({ profileDir: PROFILE_DIR })
await runtime.start()
const accountBrowser = createAccountBrowserLauncher({ appendAudit: fact => runtime.audit.append(fact) })
// Lazy loading keeps a corrupt/missing import isolated to Clients responses.
const clientWorkspaces = Object.fromEntries(['list', 'detail', 'document', 'addNote'].map(method => [method, async (...args) => {
  const store = await ClientWorkspaceStore.open({
    directory: join(ROOT, '.chimera/client-workspaces'),
    appendAudit: ({ type, clientId, noteId, status }) => runtime.audit.append({ type, clientId, noteId, status }),
  })
  return store[method](...args)
}]))
const googleConnection = new GoogleConnection({ clientFile: process.env.CHIMERA_GOOGLE_CLIENT_FILE ?? join(ROOT, '.chimera/google/client.json') })
const clientIntake = await ClientIntakeService.open({ directory: join(ROOT, '.chimera/client-intake'), catalog: clientWorkspaces, connection: googleConnection, google: new GoogleIntake({ connection: googleConnection }), runtime })
const clientDirectory = clientDirectoryAdapter(clientIntake)
// Restore validates a refresh token and the verified account before polling can run.
void googleConnection.restore().catch(() => {}).then(() => clientIntake.start()).catch(() => {})
const operatorBootstrap = operatorSessions.issueBootstrap()

function sendJson(response, status, body, extraHeaders = {}, origin = null) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': corsAllowOrigin(origin),
    'access-control-allow-headers': 'content-type,x-chimera-csrf',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-credentials': 'true',
    vary: 'Origin',
    ...extraHeaders,
  })
  response.end(JSON.stringify(body))
}

function publicErrorCode(error) {
  const code = typeof error?.code === 'string' ? error.code : error instanceof Error ? error.message : ''
  return /^[A-Z][A-Z0-9_]{2,127}$/.test(code) ? code : 'INTERNAL_ERROR'
}

async function bodyOf(request, maximum = 256_000) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > maximum) throw new Error('REQUEST_TOO_LARGE')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

async function serveApp(pathname, response) {
  let file = resolveAppAsset(APP_DIST, pathname)
  try {
    await access(file)
  } catch {
    file = join(APP_DIST, 'index.html')
  }
  response.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  })
  createReadStream(file).pipe(response)
}

const server = createServer(async (request, response) => {
  const origin = request.headers.origin
  const url = new URL(request.url, `http://${request.headers.host ?? `${HOST}:${PORT}`}`)
  const replyJson = (status, body, extraHeaders = {}) => sendJson(response, status, body, extraHeaders, origin)
  if (!isAllowedRequestOrigin(origin)) return replyJson(403, { error: 'ORIGIN_BLOCKED' })
  if (request.method === 'OPTIONS') return replyJson(204, {})
  try {
    if (url.pathname === '/api/operator/bootstrap' && request.method === 'POST') {
      const session = operatorSessions.exchangeBootstrap((await bodyOf(request)).token)
      return replyJson(200, { csrfToken: session.csrfToken, expiresAt: session.expiresAt }, {
        'set-cookie': operatorSessions.cookieHeader(session.cookieToken),
      })
    }
    const operatorAuth = authorizeOperatorRequest({
      pathname: url.pathname,
      method: request.method,
      headers: request.headers,
    }, operatorSessions)
    if (!operatorAuth.allowed) return replyJson(operatorAuth.status, { error: operatorAuth.error })
    const intakeResult = await handleClientIntakeRequest({ pathname: url.pathname, request, service: clientIntake, operatorSessions })
    if (intakeResult) return replyJson(intakeResult.status, intakeResult.body)
    const clientWorkspaceResult = await handleClientWorkspaceRequest({ pathname: url.pathname, request, store: clientDirectory, operatorSessions })
    if (clientWorkspaceResult) return replyJson(clientWorkspaceResult.status, clientWorkspaceResult.body)
    const taskWorkspaceResult = await handleTaskWorkspaceRequest({ pathname: url.pathname, request, runtime, operatorSessions })
    if (taskWorkspaceResult) return replyJson(taskWorkspaceResult.status, taskWorkspaceResult.body)
    if (url.pathname === '/api/operator/session' && request.method === 'GET') {
      return replyJson(200, operatorSessions.issueCsrf())
    }
    const accountResult = await handleAccountBrowserRequest({
      pathname: url.pathname,
      request,
      operatorSessions,
      launcher: accountBrowser,
    })
    if (accountResult) return replyJson(accountResult.status, accountResult.body)
    const companionResult = await handleAccountCompanionRequest({ pathname: url.pathname, request, operatorSessions, companion: runtime.accountCompanion })
    if (companionResult) {
      if (Array.isArray(companionResult.body?.leases)) runtime.taskWorkspaceBrowserBindings = structuredClone(companionResult.body.leases)
      return replyJson(companionResult.status, companionResult.body)
    }
    if (url.pathname === '/api/tasks/message') {
      const result = await handleTaskMessageRequest({ request, runtime, operatorSessions })
      return replyJson(result.status, result.body)
    }
    const authResult = await handleCodexAuthRequest({
      pathname: url.pathname,
      method: request.method,
      runtime,
    })
    if (authResult) return replyJson( authResult.status, authResult.body)
    const antigravityResult = await handleAntigravityRequest({ pathname: url.pathname, request, operatorSessions,
      connection: runtime.antigravity,
      state: runtime.antigravity.state.bind(runtime.antigravity),
      refresh: () => runtime.refreshAntigravity() })
    if (antigravityResult) return replyJson(antigravityResult.status, antigravityResult.body)
    const connectionsResult = await handleConnectionsRequest({
      pathname: url.pathname,
      request,
      operatorSessions,
      service: runtime.connectionService,
    })
    if (connectionsResult) return replyJson(connectionsResult.status, connectionsResult.body)
    const rjAwsResult = await handleRjAwsRequest({ pathname: url.pathname, request, operatorSessions, runtime })
    if (rjAwsResult) return replyJson(rjAwsResult.status, rjAwsResult.body)
    const agentResult = await handleAgentRequest({ pathname: url.pathname, request, operatorSessions, runtime })
    if (agentResult) return replyJson(agentResult.status, agentResult.body)
    if (url.pathname === '/api/state' && request.method === 'GET') return replyJson( 200, await runtime.state())
    if (url.pathname === '/api/models' && request.method === 'GET') return replyJson( 200, runtime.modelState())
    if (url.pathname === '/api/models/check' && request.method === 'POST') return replyJson( 200, await runtime.checkModelAccess(await bodyOf(request)))
    if (url.pathname === '/api/models/select' && request.method === 'POST') return replyJson( 200, await runtime.selectModel(await bodyOf(request)))
    if (url.pathname === '/api/github/state' && request.method === 'GET') return replyJson(200, await runtime.refreshGitHubState())
    if (url.pathname === '/api/github/auth/login' && request.method === 'POST') return replyJson(200, await runtime.startGitHubLogin())
    if (url.pathname === '/api/agents/discover' && request.method === 'POST') return replyJson( 200, await runtime.discoverAgents())
    if (url.pathname === '/api/agents/import' && request.method === 'POST') return replyJson( 201, await runtime.importAgents(await bodyOf(request)))
    if (url.pathname === '/api/agents/main/import' && request.method === 'POST') return replyJson( 201, await runtime.importMainAgent(await bodyOf(request)))
    if (url.pathname === '/api/agents/access' && request.method === 'POST') {
      const body = await bodyOf(request)
      return replyJson( 200, await runtime.setAgentAccess(body.agentId, body.profileId))
    }
    if (url.pathname === '/api/agents/model' && request.method === 'POST') {
      const body = await bodyOf(request)
      return replyJson( 200, await runtime.setAgentModel(body.agentId, {
        mode: body.mode,
        ...(body.providerId ? { providerId: body.providerId } : {}),
        ...(body.model ? { model: body.model } : {}),
      }))
    }
    if (url.pathname === '/api/agents/remove' && request.method === 'POST') {
      return replyJson(200, await runtime.removeAgent((await bodyOf(request)).agentId))
    }
    if (url.pathname === '/api/agents/workers/start' && request.method === 'POST') return replyJson( 200, await runtime.startAgent((await bodyOf(request)).agentId))
    if (url.pathname === '/api/agents/workers/stop' && request.method === 'POST') return replyJson( 200, await runtime.stopAgent((await bodyOf(request)).agentId))
    if (url.pathname === '/api/agents/workers/recover' && request.method === 'POST') return replyJson( 200, await runtime.recoverAgent((await bodyOf(request)).agentId))
    if (url.pathname === '/api/workers' && request.method === 'GET') return replyJson( 200, runtime.workerRuntimeManager.state())
    if (url.pathname === '/api/workers/start' && request.method === 'POST') return replyJson( 201, await runtime.startWorker(await bodyOf(request)))
    if (url.pathname === '/api/workers/stop' && request.method === 'POST') return replyJson( 200, await runtime.stopWorker(await bodyOf(request)))
    if (url.pathname === '/api/workers/control/take' && request.method === 'POST') return replyJson( 200, await runtime.takeWorkerControl(await bodyOf(request)))
    if (url.pathname === '/api/workers/control/return' && request.method === 'POST') return replyJson( 200, await runtime.returnWorkerControl(await bodyOf(request)))
    if (url.pathname === '/api/workers/live-view' && request.method === 'POST') return replyJson( 200, await runtime.workerLiveView(await bodyOf(request)))
    if (url.pathname === '/api/workers/action' && request.method === 'POST') return replyJson( 200, await runtime.workerAction(await bodyOf(request)))
    if (url.pathname === '/api/media/generate' && request.method === 'POST') return replyJson( 202, await runtime.generateMedia(await bodyOf(request)))
    if (url.pathname === '/api/media/status' && request.method === 'POST') return replyJson( 200, await runtime.mediaStatus(await bodyOf(request)))
    if (url.pathname === '/api/projects' && request.method === 'GET') return replyJson( 200, (await runtime.state()).projects)
    if (url.pathname === '/api/projects' && request.method === 'POST') return replyJson( 201, await runtime.registerProject(await bodyOf(request)))
    if (url.pathname === '/api/projects/tasks' && request.method === 'POST') return replyJson( 202, await runtime.submitProjectTask(await bodyOf(request)))
    if (url.pathname === '/api/projects/review' && request.method === 'POST') return replyJson( 200, await runtime.projectReview((await bodyOf(request)).taskId))
    if (url.pathname === '/api/projects/commit' && request.method === 'POST') return replyJson( 200, await runtime.commitProjectSession(await bodyOf(request)))
    if (url.pathname === '/api/tasks' && request.method === 'GET') return replyJson(200, runtime.taskHistory({ limit: Number(url.searchParams.get('limit') ?? 50), before: url.searchParams.get('before') }))
    if (url.pathname.startsWith('/api/tasks/receipts/') && request.method === 'GET') {
      const requestId = decodeURIComponent(url.pathname.slice('/api/tasks/receipts/'.length))
      const result = runtime.taskAdmissionStatus(requestId)
      return result ? replyJson(200, result) : replyJson(404, { error: 'TASK_ADMISSION_NOT_FOUND' })
    }
    if (url.pathname === '/api/conversations/messages' && request.method === 'GET') return replyJson(200, runtime.conversationHistory({ conversationId: url.searchParams.get('conversationId') ?? 'main', limit: Number(url.searchParams.get('limit') ?? 100), before: url.searchParams.get('before') }))
    if (url.pathname.startsWith('/api/conversations/asks/') && request.method === 'GET') {
      const requestId = decodeURIComponent(url.pathname.slice('/api/conversations/asks/'.length))
      const result = await runtime.askStatus(requestId)
      return result ? replyJson(200, result) : replyJson(404, { error: 'ASK_NOT_FOUND' })
    }
    if (url.pathname === '/api/tasks' && request.method === 'POST') return replyJson( 202, await runtime.submitTask(await bodyOf(request)))
    if (url.pathname === '/api/tasks/steer' && request.method === 'POST') return replyJson(200, await runtime.steerTask(await bodyOf(request)))
    if (url.pathname === '/api/tasks/cancel' && request.method === 'POST') return replyJson(200, await runtime.cancelTask(await bodyOf(request)))
    if (url.pathname === '/api/tasks/resume-queued' && request.method === 'POST') return replyJson(202, await runtime.resumeQueuedTask(await bodyOf(request)))
    if (url.pathname === '/api/tasks/continue' && request.method === 'POST') return replyJson(202, await runtime.continueTask(await bodyOf(request)))
    if (url.pathname === '/api/browser/files' && request.method === 'POST') {
      const body = await bodyOf(request, 12 * 1024 * 1024)
      if (!['browser-files', 'upload-files', 'download-file'].includes(body.command)) return replyJson(400, { error: 'INVALID_BROWSER_FILE_COMMAND' })
      return replyJson(200, await runtime.humanCommand(body))
    }
    if (url.pathname === '/api/browser/files' && request.method === 'GET') return replyJson(200, await runtime.browserAdapter.humanFileState())
    if (url.pathname === '/api/conversations/messages' && request.method === 'POST') return replyJson( 202, await runtime.sendMessage(await bodyOf(request)))
    if (url.pathname === '/api/conversations/ask' && request.method === 'POST') return replyJson(200, await runtime.ask(await bodyOf(request)))
    if (url.pathname === '/api/control/take' && request.method === 'POST') return replyJson( 200, runtime.takeControl())
    if (url.pathname === '/api/control/release' && request.method === 'POST') return replyJson( 200, runtime.releaseControl())
    if (url.pathname === '/api/browser/agent' && request.method === 'POST') return replyJson( 200, await runtime.agentCommand(await bodyOf(request)))
    if (url.pathname === '/api/browser/human' && request.method === 'POST') return replyJson( 200, await runtime.humanCommand(await bodyOf(request)))
    if (url.pathname === '/api/session/suspend' && request.method === 'POST') return replyJson( 200, await runtime.suspend())
    if (url.pathname === '/api/session/resume' && request.method === 'POST') return replyJson( 200, await runtime.resume())
    if (url.pathname.startsWith('/api/decisions/') && request.method === 'POST') {
      const actionId = decodeURIComponent(url.pathname.slice('/api/decisions/'.length))
      const body = await bodyOf(request)
      return replyJson( 200, await runtime.decide(actionId, body.outcome))
    }
    if (url.pathname.startsWith('/api/')) return replyJson( 404, { error: 'NOT_FOUND' })
    return serveApp(url.pathname, response)
  } catch (error) {
    const code = publicErrorCode(error)
    const status = ['REQUEST_TOO_LARGE', 'NATIVE_PERSONA_TOO_LARGE'].includes(code) ? 413
          : ['TASK_NOT_FOUND', 'PROJECT_NOT_FOUND', 'TASK_ADMISSION_NOT_FOUND'].includes(code) ? 404
        : ['TASK_NOT_ACTIVE', 'TASK_NOT_TERMINAL', 'TASK_NOT_QUEUED', 'TASK_ALREADY_RUNNING', 'TASK_EXECUTION_BUSY', 'TASK_QUEUE_FULL', 'TASK_QUEUE_CLEANUP_REQUIRED', 'TASK_QUEUE_RESUME_REQUIRED', 'TASK_ADMISSION_CONFLICT', 'TASK_ADMISSION_TERMINAL', 'TASK_DESTINATION_STALE'].includes(code) ? 409
          : ['ASK_REQUEST_INVALID', 'ASK_CONTEXT_INVALID', 'ASK_CONTINUITY_INVALID', 'ASK_CONTINUITY_INCOMPLETE', 'ASK_CONTINUITY_TOO_LARGE', 'ASK_EXECUTOR_NOT_PURE', 'ASK_RESULT_INVALID', 'AGENT_CREATE_REQUEST_INVALID', 'AGENT_CREATE_RECEIPT_INVALID', 'AGENT_METADATA_INPUT_INVALID', 'AGENT_METADATA_ACTOR_INVALID', 'AGENT_PERSONA_ACTOR_INVALID', 'AGENT_CONTINUITY_REPAIR_INPUT_INVALID', 'AGENT_IMPORT_INVALID', 'AGENT_DISCOVERY_INVALID', 'AGENT_DISCOVERY_SOURCE_UNAVAILABLE', 'AGENT_DISCOVERY_CANDIDATE_INVALID', 'AGENT_DISPLAY_NAME_INVALID', 'HERMES_AGENT_CANDIDATE_INVALID', 'NATIVE_PERSONA_CONTENT_INVALID', 'NATIVE_AGENT_ID_INVALID', 'TASK_ADMISSION_INVALID', 'TASK_DESTINATION_REVISION_INVALID', 'TASK_REQUIREMENTS_INPUT_INVALID', 'TASK_REQUIREMENTS_SCHEMA_INVALID', 'TASK_REQUIREMENTS_FIELD_INVALID', 'TASK_REQUIREMENTS_VALUE_INVALID', 'TASK_WORKSPACE_INVALID', 'TASK_WORKSPACE_MISMATCH', 'MODEL_SELECTION_INVALID', 'NO_ELIGIBLE_MODEL_ROUTE'].includes(code)
            || error instanceof SyntaxError || /^(TASK_STEERING_INVALID|AGENT_LOOP_BOUND_INVALID|HISTORY_PAGE_INVALID|CONVERSATION_.*INVALID|TASK_LIST_.*INVALID)$/.test(code) ? 400
          : ['ASK_REQUEST_CONFLICT', 'ASK_CONVERSATION_MISMATCH', 'ASK_CONTINUITY_UNAVAILABLE', 'ASK_CONTINUITY_STALE', 'ASK_OUTCOME_UNKNOWN', 'AGENT_CREATE_REQUEST_CONFLICT', 'AGENT_ALREADY_REGISTERED', 'AGENT_NATIVE_ID_RESERVED', 'AGENT_DISCOVERY_EXPIRED', 'AGENT_DISCOVERY_CANDIDATE_INVALID', 'AGENT_RESERVED_FOR_MAIN_PERSONA', 'AGENT_METADATA_CHANGE_DURING_TASK', 'AGENT_CONTINUITY_REPAIR_DURING_TASK', 'AGENT_IMPORT_DURING_TASK', 'AGENT_MUTATION_IN_PROGRESS'].includes(code) ? 409
          : ['ASK_NOT_FOUND', 'ASK_REQUEST_NOT_FOUND', 'ASK_RECIPIENT_NOT_REGISTERED', 'AGENT_NOT_REGISTERED'].includes(code) ? 404 : 500
    return replyJson(status, { error: code })
  }
})

const sockets = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 })
server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host ?? `${HOST}:${PORT}`}`)
  if (!isAllowedRequestOrigin(request.headers.origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
    return socket.destroy()
  }
  if (url.pathname !== '/api/browser/stream') return socket.destroy()
  const operatorAuth = authorizeOperatorWebSocket({ headers: request.headers }, operatorSessions)
  if (!operatorAuth.allowed) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
    return socket.destroy()
  }
  sockets.handleUpgrade(request, socket, head, (ws) => sockets.emit('connection', ws, request))
})

sockets.on('connection', async (ws, request) => {
  const frameSender = createLatestFrameSender(ws, { minimumFrameIntervalMs: 33 })
  let stop = null
  let closed = false
  const cleanup = () => {
    closed = true
    frameSender.close()
    void stop?.()
    void runtime.browserAdapter.releaseHumanInput?.().catch(() => {})
  }
  ws.on('close', cleanup)
  ws.on('error', cleanup)
  try {
    stop = await runtime.subscribeScreencast((frame) => {
      if (!authorizeOperatorWebSocket({ headers: request.headers }, operatorSessions).allowed) return ws.close(1008, 'Operator session expired')
      frameSender.push(frame)
    })
    if (closed) { await stop(); return }
  } catch { ws.close(1011, 'Browser stream unavailable'); return }
  ws.on('message', async (raw) => {
    try {
      if (!authorizeOperatorWebSocket({ headers: request.headers }, operatorSessions).allowed) return ws.close(1008, 'Operator session expired')
      const result = await runtime.humanStreamInput(JSON.parse(String(raw)))
      if (result.status === 'denied' && ws.readyState === 1) ws.send(JSON.stringify({ type: 'input-denied', reason: result.reason }))
    } catch (error) {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'error', error: publicErrorCode(error) }))
    }
  })
})

server.listen(PORT, HOST, () => {
  const displayHost = HOST.includes(':') ? `[${HOST}]` : HOST
  console.info(`Chimera secure launch: http://${displayHost}:${PORT}/#operator=${operatorBootstrap}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    sockets.close()
    server.close()
    await clientIntake.close()
    await runtime.close()
    process.exit(0)
  })
}
