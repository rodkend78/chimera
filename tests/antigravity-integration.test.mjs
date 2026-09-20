import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { LocalModelFabricRegistry } from '../src/ceo/local-model-fabric.mjs'
import { MemoryAuditLog } from '../src/audit-log.mjs'
import { ChimeraBrowserRuntime } from '../src/browser/runtime.mjs'
import { DurableAgentModelPolicy } from '../src/agents/model-policy.mjs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

test('The runtime accepts a boundary-verified Antigravity choice without changing other provider eligibility', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agy-model-choice-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const policy = await DurableAgentModelPolicy.open({ filePath: join(directory, 'models.json'), audit: new MemoryAuditLog() })
  let providerId = 'antigravity', configured = true
  const runtime = { agentId: 'ceo', humanId: 'human:rod', activeTasks: new Map(), tasks: { active: () => [] }, agentModelPolicy: policy,
    models: { state: () => ({ providers: [{ id: providerId, configured, models: [{ id: 'gemini-test', availability: 'local-ready', capabilities: ['conversation'] }] }] }) } }
  const set = () => ChimeraBrowserRuntime.prototype.setAgentModel.call(runtime, 'ceo', { mode: 'pinned', providerId, model: 'gemini-test' })
  assert.equal((await set()).providerId, 'antigravity')
  providerId = 'aws-bedrock'
  await assert.rejects(set(), { code: 'AGENT_MODEL_NOT_ELIGIBLE' })
  providerId = 'antigravity'; configured = false
  await assert.rejects(set(), { code: 'AGENT_MODEL_NOT_ELIGIBLE' })
})

test('The runtime accepts the measured Codex descriptor as a saved work preference without invoking it', async () => {
  const registry = await LocalModelFabricRegistry.open({
    config: { schema: 'chimera.model-routing.v1', region: 'us-west-2', codex: { model: 'gpt-5.6-sol', reasoningEffort: 'high' }, bedrockRoutes: [] },
    audit: new MemoryAuditLog(),
    workingDirectory: '/workspace/chimera',
    codexStatus: { configured: true, authentication: 'chatgpt-subscription' },
    codexClient: { startThread() { return { async run() { throw new Error('Codex invocation is outside this save test') } } } },
    bedrockModels: [],
    bedrockProfiles: [],
  })
  const saved = []
  const runtime = { agentId: 'ceo', humanId: 'human:rod', activeTasks: new Map(), tasks: { active: () => [] }, models: registry,
    agentModelPolicy: { set: async (_agentId, preference) => { saved.push(preference); return structuredClone(preference) } } }
  const description = registry.describeSelection({ mode: 'pinned', providerId: 'codex', model: 'gpt-5.6-sol' })
  assert.equal(description.availability, 'available')
  const result = await ChimeraBrowserRuntime.prototype.setAgentModel.call(runtime, 'ceo', { mode: 'pinned', providerId: 'codex', model: 'gpt-5.6-sol' })
  assert.deepEqual(result, { mode: 'pinned', providerId: 'codex', model: 'gpt-5.6-sol' })
  assert.deepEqual(saved, [result])
})

test('Antigravity is selectable per agent after explicit discovery but does not displace Auto', async () => {
  let ready = false, invocations = 0
  const antigravity = {
    state: () => ({ configured: ready, authenticated: false, status: ready ? 'ready-to-test' : 'not-checked', models: ready ? [{ id: 'gemini-test-high', name: 'Gemini Test' }] : [] }),
    router: model => ({ routerId: `antigravity:${model}`, async route() { invocations++; return { summary: 'Delegated answer' } } }),
  }
  const audit = new MemoryAuditLog()
  const registry = await LocalModelFabricRegistry.open({
    config: { schema: 'chimera.model-routing.v1', region: 'us-west-2', codex: { model: 'fixture', reasoningEffort: 'high' }, bedrockRoutes: [] },
    audit, antigravity, codexStatus: { configured: false }, bedrockModels: [], bedrockProfiles: [], env: {},
  })
  assert.equal(registry.state().providers.find(p => p.id === 'antigravity')?.configured, false)
  ready = true
  const provider = registry.state().providers.find(p => p.id === 'antigravity')
  assert.equal(provider.connectionStatus, 'ready-to-test')
  assert.equal(provider.models[0].availability, 'local-ready')
  assert.throws(() => registry.router(), { code: 'NO_MODEL_PROVIDER_CONFIGURED' })
  assert.equal(invocations, 0, 'Discovery and selection must not consume model quota')
  const router = await registry.routerFor({ mode: 'pinned', providerId: 'antigravity', model: 'gemini-test-high' })
  assert.deepEqual(await router.route('Review', { stage: 'specialist', taskId: 'task-one' }), { summary: 'Delegated answer' })
  assert.equal(invocations, 1)
  const policy = { set: async (_agentId, preference) => structuredClone(preference) }
  const runtime = { agentId: 'ceo', humanId: 'human:rod', activeTasks: new Map(), tasks: { active: () => [] }, agentModelPolicy: policy, models: registry }
  assert.equal(registry.describeSelection({ mode: 'pinned', providerId: 'antigravity', model: 'gemini-test-high' }).availability, 'available')
  assert.equal((await ChimeraBrowserRuntime.prototype.setAgentModel.call(runtime, 'ceo', { mode: 'pinned', providerId: 'antigravity', model: 'gemini-test-high' })).model, 'gemini-test-high')
  const state = await registry.select({ providerId: 'antigravity', model: 'gemini-test-high' })
  assert.equal(state.selected.providerName, 'Antigravity')
  ready = false
  await assert.rejects(registry.routerFor({ mode: 'pinned', providerId: 'antigravity', model: 'gemini-test-high' }), { code: 'ANTIGRAVITY_MODEL_UNAVAILABLE' })
})

test('Antigravity HTTP actions require operator authentication, CSRF and an empty body', async () => {
  const { handleAntigravityRequest } = await import('../src/browser/antigravity-api.mjs').catch(() => ({}))
  assert.equal(typeof handleAntigravityRequest, 'function')
  let opens = 0, refreshes = 0
  const connection = { state: () => ({ status: 'not-checked' }), refresh: async () => { refreshes++; return { status: 'ready-to-test' } }, openDesktop: async () => { opens++; return { status: 'launch-requested' } } }
  const manager = { authenticate: value => value === 'fixture', verifyCsrf: value => value === 'fixture-csrf' }
  const call = (path, body = '{}', headers = { cookie: 'fixture', 'x-chimera-csrf': 'fixture-csrf' }, method = 'POST') => {
    const request = Readable.from([body]); request.method = method; request.headers = headers
    return handleAntigravityRequest({ pathname: `/api/antigravity/${path}`, request, operatorSessions: manager, connection })
  }
  assert.equal((await call('open', '{}', {})).status, 401)
  assert.equal((await call('open', '{}', { cookie: 'fixture' })).status, 403)
  assert.equal((await call('open', '{"path":"/private"}')).status, 400)
  assert.equal((await call('open', '{}', { cookie: 'fixture', 'x-chimera-csrf': 'fixture-csrf', origin: 'https://evil.test' })).status, 403)
  assert.equal((await call('open', '{}', { cookie: 'fixture' }, 'GET')).status, 405)
  assert.equal(opens, 0)
  assert.equal((await call('open')).status, 202)
  assert.deepEqual((await call('state', '', { cookie: 'fixture', 'x-chimera-csrf': 'fixture-csrf' }, 'GET')).body, { status: 'not-checked' })
  assert.equal((await call('refresh')).body.status, 'ready-to-test')
  assert.equal(opens, 1); assert.equal(refreshes, 1)
})

test('Antigravity HTTP state and refresh preserve the provider receiver binding', async () => {
  const { handleAntigravityRequest } = await import('../src/browser/antigravity-api.mjs')
  const connection = {
    value: 0,
    state() { return { status: `state-${this.value}` } },
    async refresh() { this.value += 1; return this.state() },
    async openDesktop() { this.value += 1; return this.state() },
  }
  const sessions = { authenticate: value => value === 'fixture', verifyCsrf: value => value === 'csrf' }
  const headers = { cookie: 'fixture', 'x-chimera-csrf': 'csrf' }
  const request = (method, body = '') => {
    const stream = Readable.from([body]); stream.method = method; stream.headers = headers
    return stream
  }
  assert.deepEqual((await handleAntigravityRequest({ pathname: '/api/antigravity/state', request: request('GET'), operatorSessions: sessions, connection })).body, { status: 'state-0' })
  assert.deepEqual((await handleAntigravityRequest({ pathname: '/api/antigravity/refresh', request: request('POST', '{}'), operatorSessions: sessions, connection })).body, { status: 'state-1' })
  assert.deepEqual((await handleAntigravityRequest({ pathname: '/api/antigravity/open', request: request('POST', '{}'), operatorSessions: sessions, connection })).body, { status: 'state-2' })
})
