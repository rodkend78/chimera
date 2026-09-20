import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoryAuditLog } from '../src/audit-log.mjs'
import { WorkerArtifactStore } from '../src/agents/worker-artifact-store.mjs'
import { ChimeraBrowserRuntime } from '../src/browser/runtime.mjs'
import { createDeterministicModelRouter } from '../src/ceo/model-router.mjs'

function browserExecutor() {
  const state = { running: true, tabs: [{ tabId: 'tab-1', title: 'New tab', url: 'about:blank', active: true }] }
  return { async start() { return state }, async state() { return state }, async suspend() { state.running = false; return state }, async close() {}, allowTemporaryNavigation() {} }
}

test('browser runtime exposes safe worker state and delegates the worker API', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-workers-'))
  const calls = []
  const artifacts = await WorkerArtifactStore.open({ rootDir: join(directory, 'artifacts'), audit: new MemoryAuditLog() })
  const workerRuntimeManager = {
    artifacts,
    state: () => ({ schema: 'chimera.worker-runtime.v1', sessions: [], artifacts: artifacts.list() }),
    executors: () => ({
      mcp__chimera_worker__code: async (_args, context) => context?.taskScoped
        ? { status: 'completed', artifact: await artifacts.save({ workerSessionId: context.workerSessionId, agentId: context.agentId, name: 'runtime.txt', mimeType: 'text/plain', content: 'runtime artifact' }) }
        : { ok: true },
      mcp__chimera_worker__computer: async () => ({ ok: true }),
    }),
    async start(input) { calls.push(['start', input]); return { workerSessionId: 'worker-1' } },
    async stop(id) { calls.push(['stop', id]); return { workerSessionId: id, status: 'stopped' } },
    async takeControl(id, input) { calls.push(['take', id, input]); return { workerSessionId: id, controller: { type: 'human' } } },
    async returnControl(id, input) { calls.push(['return', id, input]); return { workerSessionId: id, controller: { type: 'agent' } } },
    async liveView(id, input) { calls.push(['live', id, input]); return 'https://signed.example/live' },
    async action(id, input, context) { calls.push(['action', id, input, context]); return { ok: true } },
    async reconcile() { calls.push(['reconcile']); return [] },
    async reapExpired() { return [] },
  }
  const modelRegistry = {
    state: () => ({ schema: 'chimera.model-provider-registry.v2', selected: null, providers: [] }),
    router: () => createDeterministicModelRouter({ responder: async () => ({ summary: 'unused' }) }),
    async select() {},
  }
  const runtime = new ChimeraBrowserRuntime({
    profileDir: join(directory, 'browser/ceo'),
    decisionFile: join(directory, 'decisions.jsonl'),
    taskFile: join(directory, 'tasks.jsonl'),
    conversationFile: join(directory, 'conversations.jsonl'),
    modelCallFile: join(directory, 'models.jsonl'),
    agentFile: join(directory, 'agents.json'),
    workerRuntimeManager,
    agentDiscovery: { async discover() { return { schema: 'chimera.agent-discovery.v1', source: { id: 'fixture' }, candidates: [] } } },
    modelRegistry,
    browserExecutor: browserExecutor(),
  })
  try {
    await runtime.start()
    assert.equal((await runtime.state()).workers.schema, 'chimera.worker-runtime.v1')
    await runtime.tasks.submit({ taskId: 'runtime-artifact-task', objective: 'Record a materialized worker artifact.', model: null })
    const artifactResult = await runtime.workerToolExecutors.mcp__chimera_worker__code(
      { operation: 'export-files' },
      { taskScoped: true, taskId: 'runtime-artifact-task', agentId: 'researcher', workerSessionId: 'worker-1' },
    )
    assert.equal(artifactResult.status, 'completed')
    assert.equal(typeof artifactResult.artifact.artifactId, 'string')
    assert.equal(runtime.tasks.listEvidence('runtime-artifact-task').some(receipt => receipt.kind === 'artifact'), true)
    assert.equal(runtime.taskWorkspace('runtime-artifact-task').evidence.workProduced.state, 'observed')
    await runtime.startWorker({ agentId: 'researcher', kind: 'code', ttlSeconds: 900 })
    await runtime.stopWorker({ workerSessionId: 'worker-1' })
    await runtime.takeWorkerControl({ workerSessionId: 'worker-1' })
    await runtime.returnWorkerControl({ workerSessionId: 'worker-1' })
    assert.deepEqual(await runtime.workerLiveView({ workerSessionId: 'worker-1' }), { url: 'https://signed.example/live', expiresIn: 45 })
    await runtime.workerAction({ workerSessionId: 'worker-1', operation: 'screenshot' })
    assert.deepEqual(calls.map(([name]) => name), ['reconcile', 'start', 'stop', 'take', 'return', 'live', 'action'])
  } finally {
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
})
