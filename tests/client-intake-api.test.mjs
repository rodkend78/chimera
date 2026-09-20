import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtemp, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OperatorSessionManager } from '../src/browser/operator-session.mjs'
import { ClientIntakeService } from '../src/clients/intake-service.mjs'
import { IntakeStore } from '../src/clients/intake-store.mjs'
import { ChimeraBrowserRuntime } from '../src/browser/runtime.mjs'
import { createDeterministicModelRouter } from '../src/ceo/model-router.mjs'
import { handleClientWorkspaceRequest } from '../src/browser/client-workspace-api.mjs'
const api = await import('../src/browser/client-intake-api.mjs').catch(() => ({}))
async function fixture(t) {
  assert.equal(typeof api.handleClientIntakeRequest, 'function')
  const directory = await mkdtemp(join(realpathSync(tmpdir()), 'chimera-intake-api-'))
  const service = new ClientIntakeService({ store: await IntakeStore.open({ directory }) })
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }) })
  const operatorSessions = new OperatorSessionManager({ filePath: join(directory, 'session.json') })
  const session = operatorSessions.exchangeBootstrap(operatorSessions.issueBootstrap())
  const headers = { cookie: `chimera_operator=${session.cookieToken}`, 'x-chimera-csrf': session.csrfToken, origin: 'http://127.0.0.1:4174' }
  const call = (pathname, method = 'GET', body = '', overrides = {}) => api.handleClientIntakeRequest({ pathname, service, operatorSessions, request: Object.assign(Readable.from([Buffer.from(body)]), { method, headers: { ...headers, ...overrides } }) })
  return { call, headers, operatorSessions, service }
}
test('authenticated intake endpoints create and replay client with public queue projection', async t => {
  const { call } = await fixture(t)
  const input = JSON.stringify({ requestId: 'request1', name: 'Example', email: 'owner@example.test', services: ['Website'], summary: '' })
  const first = await call('/api/client-intake/clients', 'POST', input)
  assert.equal(first.status, 201)
  assert.deepEqual(await call('/api/client-intake/clients', 'POST', input), first)
  const status = await call('/api/client-intake')
  assert.equal(status.body.clients.length, 1)
  assert.equal(status.body.queue[0].status, 'ready')
  assert.equal(status.body.queue[0].evidence, undefined)
  assert.equal((await call('/api/client-intake/sync', 'POST', '{}')).body.sync.error, 'CLIENT_INTAKE_DISCONNECTED')
  assert.equal((await call('/api/client-intake/connect', 'POST', '{}')).body.connection.state, 'setup_required')
  assert.equal(await call('/api/other'), null)
})
test('auth, CSRF and origin reject before service or body consumption; invalid routes fail closed', async t => {
  const { call, headers, operatorSessions } = await fixture(t)
  for (const [overrides, status] of [[{ cookie: '' }, 401], [{ 'x-chimera-csrf': '' }, 403], [{ origin: 'https://evil.example' }, 403]]) {
    const request = { method: 'POST', headers: { ...headers, ...overrides }, [Symbol.asyncIterator]() { assert.fail('body consumed') } }
    assert.equal((await api.handleClientIntakeRequest({ pathname: '/api/client-intake/clients', request, service: new Proxy({}, { get() { assert.fail('service touched') } }), operatorSessions })).status, status)
  }
  assert.equal((await call('/api/client-intake/clients', 'GET')).status, 405)
  assert.equal((await call('/api/client-intake/not-real', 'POST', '{}')).status, 404)
  for (const body of ['{', 'null', 'x'.repeat(180000)]) assert.equal((await call('/api/client-intake/clients', 'POST', body)).status, 400)
  assert.equal((await call('/api/client-intake/handoff', 'POST', '{"id":"missing"}')).status, 404)
})
test('real runtime and durable ledger deduplicate intake task across concurrent requests and restart', async t => {
  assert.equal(typeof ChimeraBrowserRuntime.prototype.submitIntakeTask, 'function')
  const directory = await mkdtemp(join(realpathSync(tmpdir()), 'chimera-intake-runtime-'))
  let calls = 0
  const router = createDeterministicModelRouter({ routerId: 'openai-compatible:fixture:intake', responder: async (_prompt, context) => { calls++; return context.stage === 'decompose' ? { tasks: [{ agentId: 'researcher', objective: 'Review synthetic client facts' }] } : { summary: 'Synthetic result' } } })
  const modelRegistry = { state: () => ({ selected: { providerId: 'fixture', model: 'intake' }, providers: [] }), router: () => router, routerFor: async () => router }
  const options = { profileDir: join(directory, 'profiles/ceo'), modelRegistry, browserExecutor: { start: async () => ({ running: true, tabs: [] }), state: async () => ({ running: true, tabs: [] }), suspend: async () => ({ running: false, tabs: [] }), close: async () => {} } }
  let runtime = new ChimeraBrowserRuntime(options)
  t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }) })
  await runtime.start()
  const input = { taskId: 'intake-' + 'a'.repeat(40), objective: 'Prepare synthetic client plan' }
  const results = await Promise.all([runtime.submitIntakeTask(input), runtime.submitIntakeTask(input)])
  assert.equal(results[0].taskId, results[1].taskId)
  await runtime.waitForTask(input.taskId)
  const count = calls
  await runtime.close(); runtime = new ChimeraBrowserRuntime(options); await runtime.start()
  assert.equal((await runtime.submitIntakeTask(input)).taskId, input.taskId)
  assert.equal(calls, count)
  assert.equal(runtime.tasks.list().length, 1)
  await assert.rejects(runtime.submitIntakeTask({ ...input, objective: 'Different task' }), { code: 'CLIENT_INTAKE_CONFLICT' })
})

test('exact intake replay returns its durable receipt while unrelated work is active', async t => {
  const directory = await mkdtemp(join(realpathSync(tmpdir()), 'chimera-intake-replay-active-'))
  const options = {
    profileDir: join(directory, 'browser/ceo'),
    decisionFile: join(directory, 'decisions.jsonl'),
    taskFile: join(directory, 'tasks.jsonl'),
    modelCallFile: join(directory, 'model-calls.jsonl'),
    agentFile: join(directory, 'agents/registry.json'),
    modelRegistry: { state: () => ({ selected: null, providers: [] }), router: () => { throw new Error('MODEL_MUST_NOT_RUN') }, async select() {} },
    browserExecutor: { start: async () => ({ running: true, tabs: [] }), state: async () => ({ running: true, tabs: [] }), suspend: async () => ({ running: false, tabs: [] }), close: async () => {} },
  }
  let runtime
  try {
    runtime = new ChimeraBrowserRuntime(options)
    await runtime.start()
    const taskId = 'intake-' + 'b'.repeat(40)
    const objective = 'Return the already durable intake task.'
    const existing = await runtime.tasks.submit({ taskId, objective, model: null, context: { source: 'client-intake' } })
    await runtime.tasks.submit({ taskId: 'unrelated-active', objective: 'Unrelated active work.', model: null, context: { projectId: 'fixture' }, queue: true })
    await runtime.tasks.start('unrelated-active')
    const replay = await runtime.submitIntakeTask({ taskId, objective, budget: { maxTurns: 0 } })
    assert.equal(replay.taskId, existing.taskId)
    assert.equal(runtime.tasks.get(taskId).objective, objective)
  } finally {
    await runtime?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
test('existing Clients note route accepts new clients and preserves validation error codes', async t => {
  const { headers, operatorSessions, service } = await fixture(t)
  assert.equal(typeof api.clientDirectoryAdapter, 'function')
  const { client } = await service.createClient({ requestId: 'note-route', name: 'New', email: 'new@example.test', services: ['Website'], summary: '' })
  const call = input => handleClientWorkspaceRequest({ pathname: `/api/clients/${client.id}/notes`, operatorSessions, store: api.clientDirectoryAdapter(service), request: Object.assign(Readable.from([JSON.stringify(input)]), { method: 'POST', headers }) })
  assert.equal((await call({ title: 'Notes', body: 'Public briefing', sourceType: 'note' })).status, 201)
  assert.equal((await call({ title: 'Notes', body: 'password=secret', sourceType: 'note' })).status, 400)
})
test('handoff mutation uses the same public brief projection as queue status', async t => {
  const { service, call } = await fixture(t)
  service.runtime = { async submitIntakeTask({ taskId }) { return { taskId } } }
  await service.createClient({ requestId: 'public-handoff', name: 'Public', email: 'public@example.test', services: ['Website'], summary: '' })
  const row = (await call('/api/client-intake')).body.queue[0]
  const result = await call('/api/client-intake/handoff', 'POST', JSON.stringify({ id: row.id }))
  assert.equal(result.status, 200)
  assert.deepEqual(result.body, { ...row, status: 'handed_off' })
  assert.equal(result.body.brief.questionnaire, undefined)
  assert.equal(result.body.brief.references, undefined)
})
