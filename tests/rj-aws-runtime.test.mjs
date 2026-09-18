import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { toolsForAccessProfile } from '../src/agents/access-policy.mjs'
import { MemoryAuditLog } from '../src/audit-log.mjs'
import { ChimeraBrowserRuntime } from '../src/browser/runtime.mjs'
import { loadDshEffectInventory } from '../src/dsh/effect-inventory.mjs'
import { evaluatePolicy } from '../src/policy.mjs'
import { readFile } from 'node:fs/promises'
import { fingerprint, signGrant, generateIdentity, exportPublicKey } from '../src/identity.mjs'
import { RjAwsWorker } from '../src/rj-aws/worker.mjs'

function browserExecutor() {
  const state = { running: true, tabs: [{ tabId: 'tab-1', title: 'New tab', url: 'about:blank', active: true }] }
  return { async start() { return state }, async state() { return state }, async suspend() {}, async close() {}, allowTemporaryNavigation() {} }
}

function workerRuntimeManager() {
  return { state: () => ({ schema: 'chimera.worker-runtime.v1', sessions: [], artifacts: [] }), executors: () => ({}), async reconcile() {}, async reapExpired() {} }
}

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

async function fixture(t, connector, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-rj-aws-runtime-'))
  const modelRegistry = {
    state: () => ({ schema: 'chimera.model-provider-registry.v2', selected: null, providers: [] }),
    router: () => { throw new Error('MODEL_ROUTER_MUST_NOT_RUN') },
    async select() {},
  }
  const runtime = new ChimeraBrowserRuntime({ profileDir: join(directory, 'browser/ceo'), modelRegistry,
    workerRuntimeManager: workerRuntimeManager(), agentDiscovery: { async discover() { return { schema: 'chimera.agent-discovery.v1', source: { id: 'fixture' }, candidates: [] } } },
    rjAwsConnector: connector, browserExecutor: browserExecutor(), ...overrides })
  await runtime.start()
  t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }) })
  return runtime
}

for (const terminal of ['failed', 'interrupted']) test(`operator reconciliation after runtime restart preserves the expired ${terminal} task and original request identity`, async t => {
  let clock = Date.parse('2026-09-08T12:00:00Z'), executions = 0, worker, original
  const identity = generateIdentity('rj-aws-worker')
  const config = { workerPublicKey: exportPublicKey(identity.publicKey) }
  const runtime = await fixture(t, undefined, { now: () => clock, rjAwsConfig: config, rjAwsTransport: async request => {
    original = request
    await worker.handle(request)
    throw Object.assign(new Error('RJ_AWS_OUTCOME_UNKNOWN'), { code: 'RJ_AWS_OUTCOME_UNKNOWN' })
  } })
  const { realpath } = await import('node:fs/promises')
  const options = { stateDir: join(await realpath(join(runtime.profileDir, '../..')), 'remote-journal'), identity,
    humanKeys: [[runtime.human.keyId, runtime.human.publicKey]], now: () => clock,
    execute: async () => { executions++; return { account: '000000000000', arn: 'arn:aws:sts::000000000000:assumed-role/example-rj-aws-worker/chimera', userId: 'AROAEXAMPLE:chimera' } } }
  worker = await RjAwsWorker.open(options)
  if (terminal === 'failed') await assert.rejects(runtime.verifyRjAwsConnection(), { code: 'RJ_AWS_OUTCOME_UNKNOWN' })
  else {
    await runtime.tasks.submit({ taskId: 'interrupted-original', objective: 'Original interrupted task', model: null, context: {} })
    await runtime.tasks.start('interrupted-original')
    await assert.rejects(runtime.rjAwsConnector.execute('rj.aws.identity', { agentId: 'ceo', taskId: 'interrupted-original',
      assertActive: () => ({ agentId: 'ceo', taskId: 'interrupted-original', profileId: 'connected', expiresAt: new Date(clock + 300000).toISOString() }) }), { code: 'RJ_AWS_OUTCOME_UNKNOWN' })
  }
  const taskId = original.action.payload.taskId
  const priorTask = runtime.tasks.get(taskId)
  await runtime.close()
  await worker.close()
  clock += 600000
  worker = await RjAwsWorker.open(options)
  t.after(() => worker.close())
  const restarted = await fixture(t, undefined, { profileDir: runtime.profileDir, now: () => clock, rjAwsConfig: config,
    rjAwsTransport: async request => JSON.stringify(await worker.handle(request)) })
  assert.equal(typeof restarted.reconcileRjAwsRequest, 'function', 'runtime exposes explicit same-request recovery')
  const recovered = await restarted.reconcileRjAwsRequest({ requestId: original.action.payload.requestId })
  assert.equal(recovered.receipt.payload.requestHash, original.action.payload.requestHash)
  assert.equal(restarted.tasks.get(taskId).status, terminal)
  assert.equal(restarted.tasks.get(taskId).startedAt, priorTask.startedAt)
  assert.equal(restarted.tasks.list().length, 1)
  assert.equal(restarted.tasks.get(taskId).checkpoint.receipt.signature, recovered.receipt.signature)
  assert.equal(executions, 1)
})

test('reconciliation HTTP endpoint authenticates lookup-only request IDs and rejects execution inputs', async () => {
  const { handleRjAwsRequest } = await import('../src/browser/rj-aws-api.mjs')
  const calls = []
  const runtime = { async reconcileRjAwsRequest(body) { calls.push(body); return { status: 'reconciled' } } }
  const sessions = { authenticate: value => value === 'fixture', verifyCsrf: value => value === 'csrf' }
  const call = (body, headers = { cookie: 'fixture', 'x-chimera-csrf': 'csrf' }, method = 'POST') => {
    const request = Readable.from([JSON.stringify(body)]); request.method = method; request.headers = headers
    return handleRjAwsRequest({ pathname: '/api/rj-aws/reconcile', request, operatorSessions: sessions, runtime })
  }
  assert.equal((await call({ requestId: 'original-request' }, {}))?.status, 401)
  assert.equal((await call({ requestId: 'original-request' }, { cookie: 'fixture' }))?.status, 403)
  assert.equal((await call({ requestId: 'original-request' }, { cookie: 'fixture', 'x-chimera-csrf': 'csrf', origin: 'https://evil.test' }))?.status, 403)
  assert.equal((await call({}, { cookie: 'fixture' }, 'GET'))?.status, 405)
  assert.equal((await call({ requestId: 'original-request', operation: 'rj.aws.identity' }))?.status, 400)
  assert.equal((await call({ requestId: '../bad' }))?.status, 400)
  assert.deepEqual(calls, [])
  assert.equal((await call({ requestId: 'original-request' }))?.status, 200)
  assert.deepEqual(calls, [{ requestId: 'original-request' }])
})

test('manual RJ AWS verification uses one deterministic model:null task and durably retains both pinned receipts', async t => {
  const operations = []
  const remoteTeamCalls = []
  const connector = {
    state: () => ({ schema: 'chimera.rj-aws-connection.v1', configured: true, status: 'transport-ready', transport: { status: 'ready' }, execution: { status: 'not-verified' } }),
    executors: () => ({}),
    async execute(operation, context) {
      operations.push({ operation, args: {}, authority: context.assertActive() })
      return { schema: 'chimera.rj-aws-execution.v1', operation, outcome: 'succeeded', result: { operation }, receipt: { schema: 'chimera.rj-aws.receipt.v1', agentPublicKey: 'fixture-public-key', payload: { requestId: `request-${operation}`, operation, outcome: 'succeeded' }, signature: `signature-${operation}` } }
    },
  }
  const runtime = await fixture(t, connector, { teamTransport: { async dispatch(input) { remoteTeamCalls.push(input); throw new Error('REMOTE_TEAM_MUST_NOT_RUN') } } })
  const result = await runtime.verifyRjAwsConnection()
  assert.deepEqual(operations.map(({ operation, args }) => [operation, args]), [['rj.aws.identity', {}], ['rj.aws.instance_status', {}]])
  assert.deepEqual(remoteTeamCalls, [])
  assert.ok(operations.every(({ authority }) => authority.agentId === 'ceo' && authority.profileId === 'connected'))
  const task = runtime.tasks.get(result.taskId)
  assert.equal(task.model, null)
  assert.equal(task.status, 'completed')
  assert.deepEqual(task.result.receipts.map(receipt => receipt.payload.operation), ['rj.aws.identity', 'rj.aws.instance_status'])
  assert.equal(task.context.source, 'rj-aws-verification')
  assert.equal(task.context.deterministic, true)
  const durableEvents = await readFile(runtime.tasks.filePath, 'utf8')
  assert.match(durableEvents, /signature-rj\.aws\.identity/)
  assert.match(durableEvents, /signature-rj\.aws\.instance_status/)
  assert.equal((await runtime.state()).connectors.rjAws.execution.status, 'not-verified')
})

test('runtime registers no RJ tools without config and rechecks real task owner, grant and access profile for configured execution', async t => {
  const authorities = []
  const connector = {
    state: () => ({ configured: true }),
    executors: () => ({ mcp__chimera_rj_aws__identity() {}, mcp__chimera_rj_aws__instance_status() {} }),
    async execute(_operation, context) { authorities.push(await context.assertActive()); return { outcome: 'succeeded' } },
  }
  const runtime = await fixture(t, connector)
  await runtime.tasks.submit({ taskId: 'task-authority', objective: 'Use the bounded connector', model: null, context: {} })
  await runtime.tasks.start('task-authority')
  await runtime.agentAccessPolicy.set('researcher', 'connected', { changedBy: 'rod' })
  const identity = runtime.identityStore.getOrCreate('researcher')
  const expiresAt = new Date(runtime.now() + 120_000).toISOString()
  const grant = signGrant({ grantId: 'grant-rj-aws-authority', humanId: 'rod', agentId: 'researcher',
    agentKeyFingerprint: fingerprint(identity.publicKey), taskId: 'task-authority', maxTier: 'confirm', scopes: [],
    issuedAt: new Date(runtime.now() - 1_000).toISOString(), expiresAt }, runtime.human)
  runtime.specialistSecurity.set('researcher', { identity, grant })
  runtime.workerOwners.set('researcher', 'task-authority')
  const executor = runtime.workerToolExecutors.mcp__chimera_rj_aws__identity
  await executor({}, { agentId: 'researcher', taskId: 'task-authority', assertActive() {} })
  assert.deepEqual(authorities, [{ agentId: 'researcher', taskId: 'task-authority', profileId: 'connected', expiresAt }])
  await assert.rejects(executor([], { agentId: 'researcher', taskId: 'task-authority', assertActive() {} }), { code: 'RJ_AWS_ARGUMENTS_INVALID' })
  runtime.workerOwners.delete('researcher')
  await assert.rejects(executor({}, { agentId: 'researcher', taskId: 'task-authority', assertActive() {} }), { code: 'RJ_TASK_AUTHORITY_INACTIVE' })

  const unconfigured = await fixture(t, { state: () => ({ configured: false, status: 'not-configured' }), executors: () => ({}), async execute() { throw new Error('must not execute') } })
  assert.equal(unconfigured.workerToolExecutors.mcp__chimera_rj_aws__identity, undefined)
  assert.equal((await unconfigured.state()).connectors.rjAws.status, 'not-configured')
})

test('manual verification refuses every other active task and persists partial receipt evidence before failure', async t => {
  let calls = 0
  const connector = { state: () => ({ configured: true }), executors: () => ({}), async execute(operation) {
    calls += 1
    if (operation === 'rj.aws.instance_status') throw Object.assign(new Error('RJ_AWS_TRANSPORT_UNKNOWN'), { code: 'RJ_AWS_TRANSPORT_UNKNOWN' })
    return { operation, outcome: 'succeeded', receipt: { operation, outcome: 'succeeded', receiptHash: 'hash-one' }, result: {} }
  } }
  const runtime = await fixture(t, connector)
  await runtime.tasks.submit({ taskId: 'already-active', objective: 'Already active', model: null, context: {} })
  await assert.rejects(runtime.verifyRjAwsConnection(), { code: 'TASK_ALREADY_RUNNING' })
  assert.equal(calls, 0)
  await runtime.tasks.fail('already-active', { code: 'FIXTURE_DONE', message: 'fixture' })
  await assert.rejects(runtime.verifyRjAwsConnection(), { code: 'RJ_AWS_TRANSPORT_UNKNOWN' })
  const task = runtime.tasks.list().find(row => row.context?.source === 'rj-aws-verification')
  assert.equal(task.status, 'failed')
  assert.equal(task.checkpoint.receipts.length, 1)
})

test('cancelling verification during transport retains exclusive task ownership until the physical call settles', async t => {
  const entered = deferred(), release = deferred()
  const connector = { state: () => ({ configured: true }), executors: () => ({}), async execute(_operation, context) {
    entered.resolve()
    await release.promise
    context.assertActive()
    return { outcome: 'succeeded', receipt: { signature: 'fixture' }, result: {} }
  } }
  const runtime = await fixture(t, connector)
  const verification = runtime.verifyRjAwsConnection()
  await entered.promise
  const task = runtime.tasks.active().find(row => row.context?.source === 'rj-aws-verification')
  assert.equal(task.status, 'running')
  await runtime.cancelTask({ taskId: task.taskId })
  try {
    await assert.rejects(runtime.verifyRjAwsConnection(), { code: 'TASK_ALREADY_RUNNING' })
    await assert.rejects(runtime.submitTask({ objective: 'Must wait for physical settlement.' }), { code: 'TASK_ALREADY_RUNNING' })
  } finally {
    release.resolve()
    await assert.rejects(verification, { code: 'TASK_CANCELLED' })
  }
  assert.equal(runtime.tasks.get(task.taskId).status, 'cancelled')
})

test('a project task queued during verification starts after verification cleanup', async t => {
  const entered = deferred(), release = deferred()
  let first = true
  const connector = { state: () => ({ configured: true }), executors: () => ({}), async execute(operation, context) {
    context.assertActive()
    if (first) { first = false; entered.resolve(); await release.promise }
    context.assertActive()
    return { operation, outcome: 'succeeded', receipt: { operation, signature: `signature-${operation}` }, result: {} }
  } }
  const runtime = await fixture(t, connector)
  const verification = runtime.verifyRjAwsConnection()
  await entered.promise
  const project = await runtime.registerProject({ mode: 'managed', name: 'Queued after verification' })
  const queued = await runtime.submitProjectTask({ projectId: project.projectId, objective: 'Advance after verification.' })
  assert.equal(runtime.tasks.get(queued.taskId).status, 'queued')
  release.resolve()
  await verification
  const settled = await runtime.waitForTask(queued.taskId)
  assert.notEqual(settled.status, 'queued')
  assert.equal(typeof settled.startedAt, 'string')
})

test('RJ AWS HTTP verification requires operator auth, CSRF, allowed origin, POST and an exact empty body', async () => {
  const { handleRjAwsRequest } = await import('../src/browser/rj-aws-api.mjs').catch(() => ({}))
  assert.equal(typeof handleRjAwsRequest, 'function')
  let calls = 0
  const runtime = { async verifyRjAwsConnection() { calls += 1; return { status: 'verified' } } }
  const sessions = { authenticate: value => value === 'fixture', verifyCsrf: value => value === 'fixture-csrf' }
  const call = (body = '{}', headers = { cookie: 'fixture', 'x-chimera-csrf': 'fixture-csrf' }, method = 'POST') => {
    const request = Readable.from([body]); request.method = method; request.headers = headers
    return handleRjAwsRequest({ pathname: '/api/rj-aws/verify', request, operatorSessions: sessions, runtime })
  }
  assert.equal((await call('{}', {})).status, 401)
  assert.equal((await call('{}', { cookie: 'fixture' })).status, 403)
  assert.equal((await call('{"operation":"aws ec2 stop-instances"}')).status, 400)
  assert.equal((await call('{}', { cookie: 'fixture', 'x-chimera-csrf': 'fixture-csrf', origin: 'https://evil.test' })).status, 403)
  assert.equal((await call('{}', { cookie: 'fixture' }, 'GET')).status, 405)
  assert.equal(calls, 0)
  assert.equal((await call()).status, 200)
  assert.equal(calls, 1)
})

test('only connected and live profiles advertise the exact two RJ AWS tools with exact auto DSH policy', async () => {
  const names = ['mcp__chimera_rj_aws__identity', 'mcp__chimera_rj_aws__instance_status']
  assert.ok(names.every(name => !toolsForAccessProfile('sandbox').includes(name)))
  assert.ok(names.every(name => toolsForAccessProfile('connected').includes(name)))
  assert.ok(names.every(name => toolsForAccessProfile('live').includes(name)))
  const inventory = await loadDshEffectInventory()
  const policy = JSON.parse(await readFile(new URL('../config/policy.json', import.meta.url), 'utf8'))
  for (const name of names) {
    assert.deepEqual(inventory.classify(name), { id: 'chimera-rj-aws-read', capability: 'aws.read' })
    assert.equal(evaluatePolicy(policy, { capability: 'aws.read', resource: `dsh-tool:${name}` }).tier, 'auto')
  }
})
