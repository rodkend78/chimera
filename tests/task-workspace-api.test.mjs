import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OperatorSessionManager } from '../src/browser/operator-session.mjs'
import { ChimeraBrowserRuntime } from '../src/browser/runtime.mjs'
import { handleTaskWorkspaceRequest } from '../src/browser/task-workspace-api.mjs'

test('task workspace GET is authenticated, read-only, and task-bound', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-task-workspace-api-'))
  const sessions = await OperatorSessionManager.open({ filePath: join(directory, 'session.json') })
  const session = sessions.exchangeBootstrap(sessions.issueBootstrap())
  const calls = []
  const runtime = {
    taskWorkspace: async taskId => {
      calls.push(taskId)
      return { schema: 'chimera.task-workspace.v1', task: { taskId }, evidence: { status: 'unavailable' }, recovery: { status: 'unavailable' } }
    },
    state: () => { throw new Error('STATE_MUST_NOT_RUN') },
    projectReview: () => { throw new Error('GIT_REVIEW_MUST_NOT_RUN') },
    startWorker: () => { throw new Error('WORKER_MUST_NOT_START') },
    humanCommand: () => { throw new Error('BROWSER_MUST_NOT_RUN') },
  }
  const server = createServer(async (request, response) => {
    const result = await handleTaskWorkspaceRequest({ request, runtime, operatorSessions: sessions })
    response.writeHead(result.status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(result.body))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }) })
  const url = `http://127.0.0.1:${server.address().port}/api/tasks/alpha/workspace`
  assert.equal((await fetch(url)).status, 401)
  const cookie = `${session.cookieName}=${session.cookieToken}`
  const response = await fetch(url, { headers: { cookie } })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).task.taskId, 'alpha')
  assert.deepEqual(calls, ['alpha'])
  assert.equal((await fetch(url, { method: 'POST', headers: { cookie, 'x-chimera-csrf': session.csrfToken } })).status, 405)
})

test('the actual runtime workspace projection is a pure exact-task read and marks continuation reviews stale', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-task-workspace-runtime-fixture-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const runtime = new ChimeraBrowserRuntime({ profileDir: directory })
  const conversationCalls = []
  const task = {
    taskId: 'alpha', objective: 'Alpha objective', model: null, status: 'running', destinationRevision: 4,
    context: { projectSessionTaskId: 'source', projectId: 'demo' },
    plan: { revision: 2, planHash: 'a'.repeat(64), nodes: [{ nodeId: 'alpha-node', specialistAgentId: 'ace', objective: 'Inspect alpha', acceptanceCriteria: ['Report'], dependsOn: [] }] },
    steps: [{ nodeId: 'alpha-node', status: 'running' }],
    routing: { taskId: 'alpha', routeId: 'task-route', providerId: 'fixture', model: 'task-model' },
  }
  runtime.tasks = { get: taskId => taskId === 'alpha' ? task : null }
  runtime.projectSessions = { get: taskId => taskId === 'source' ? {
    taskId: 'source', projectId: 'demo', projectName: 'Demo', status: 'working',
    source: { type: 'local', path: '/private/source' },
    workspace: { path: '/private/workspace', repositoryPath: '/private/workspace/repo' },
  } : null }
  runtime.conversations = { list: (conversationId, options) => {
    conversationCalls.push({ conversationId, options })
    return [{ messageId: 'alpha-message', taskId: 'alpha', conversationId: 'task:alpha', kind: 'message', content: 'Alpha only' }, { messageId: 'beta-message', taskId: 'beta', conversationId: 'task:beta', kind: 'message', content: 'Beta must not join' }]
  } }
  runtime.teamDispatchers = new Map()
  runtime.agentMailbox = null
  runtime.decisions = { all: () => [{ actionId: 'alpha-action', taskId: 'alpha' }, { actionId: 'beta-action', taskId: 'beta' }] }
  runtime.taskAccessLeases = { list: () => [{ leaseId: 'alpha-lease', taskId: 'alpha' }, { leaseId: 'beta-lease', taskId: 'beta' }] }
  runtime.taskWorkspaceReviewCache = new Map([['source', {
    taskId: 'source', changedFiles: [{ path: 'source.txt', status: 'M' }], observedAt: '2026-09-18T12:00:00.000Z', stale: false,
  }]])
  runtime.taskWorkspaceBrowserBindings = [{ leaseId: 'global-browser' }]
  runtime.state = () => { throw new Error('STATE_MUST_NOT_RUN') }
  runtime.projectReview = () => { throw new Error('GIT_REVIEW_MUST_NOT_RUN') }
  runtime.accountCompanion = { state: () => { throw new Error('ACCOUNT_STATE_MUST_NOT_RUN') } }
  runtime.browserAdapter = { state: () => { throw new Error('BROWSER_STATE_MUST_NOT_RUN') } }
  runtime.startWorker = () => { throw new Error('WORKER_MUST_NOT_START') }

  const value = runtime.taskWorkspace('alpha')
  assert.deepEqual(conversationCalls, [{ conversationId: 'task:alpha', options: { limit: 200 } }])
  assert.deepEqual(value.conversation.messages.map(row => row.messageId), ['alpha-message'])
  assert.deepEqual(value.approvals.map(row => row.actionId), ['alpha-action'])
  assert.deepEqual(value.permissions.map(row => row.leaseId), ['alpha-lease'])
  assert.equal(value.session.taskId, 'alpha')
  assert.equal(value.session.sourceTaskId, 'source')
  assert.equal(value.session.workspace.path, undefined)
  assert.equal(value.files.status, 'stale')
  assert.equal(value.files.review.sourceTaskId, 'source')
  assert.equal(value.files.review.stale, true)
  assert.equal(value.browser, null)
  assert.equal(value.routing.taskId, 'alpha')
})
