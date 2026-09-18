import assert from 'node:assert/strict'
import test from 'node:test'
import { chmod, lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryAuditLog } from '../src/audit-log.mjs'
import { ChimeraBrowserRuntime } from '../src/browser/runtime.mjs'
import { createTaskAwareModelRouter } from '../src/ceo/task-aware-model-router.mjs'
import { createCodexSubscriptionModelRouter } from '../src/ceo/codex-subscription-provider.mjs'
import { agentManifestFromHermesCandidate } from '../src/agents/registry.mjs'

async function removeFixture(directory) {
  if ((await lstat(directory)).isDirectory()) {
    await chmod(directory, 0o700)
    for (const name of await readdir(directory)) await removeFixture(join(directory, name))
  }
  await rm(directory, { recursive: true, force: true })
}

async function fixture(t, codex) {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-model-controls-'))
  const audit = new MemoryAuditLog()
  const provider = createCodexSubscriptionModelRouter({ codex })
  const fabric = createTaskAwareModelRouter({ audit, routes: [{ id: 'codex', router: provider, capabilities: ['orchestration', 'reasoning'], costClass: 'subscription' }] })
  const runtime = new ChimeraBrowserRuntime({
    profileDir: join(directory, 'profiles/ceo'), audit,
    agentReferenceProvider: { materialize: async () => [{ path: 'MEMORY.md', content: 'Fixture agent continuity.' }] },
    modelRegistry: {
      state: () => ({ selected: { providerId: 'codex', model: 'gpt-5.6-sol' }, providers: [] }),
      router: () => fabric, routerFor: () => fabric,
    },
    browserExecutor: { async start() { return this.state() }, async state() { return { running: true, tabs: [] } }, async suspend() {} },
  })
  t.after(async () => { await runtime.close(); await removeFixture(directory) })
  await runtime.start()
  return { runtime, audit, directory }
}

test('RJ and imported Ace use separate Codex sessions while Ace resumes its bounded tool loop', async t => {
  const starts = [], resumes = [], calls = []
  const thread = id => ({ id, async run(prompt) {
    const context = JSON.parse(prompt.split('Chimera context:\n')[1])
    calls.push({ id, context })
    let response
    if (context.stage === 'decompose') response = { tasks: [{ specialistAgentId: 'ace', objective: 'Read your task inbox and report.', acceptanceCriteria: ['Report the inbox.'] }] }
    else if (context.stage === 'specialist-loop') response = context.loop.turn === 1
      ? { status: 'tool_request', summary: 'Read task inbox.', toolCall: { name: 'agent_inbox', arguments: '{}' } }
      : { status: 'completed', summary: 'Read the task inbox.', toolCall: null }
    else response = { summary: 'RJ verified the bounded result.' }
    return { finalResponse: JSON.stringify(response) }
  } })
  const { runtime, directory } = await fixture(t, {
    startThread(options) { starts.push(options); return thread(`fixture-${starts.length}`) },
    resumeThread(id, options) { resumes.push({ id, options }); return thread(id) },
  })
  await runtime.agentRegistry.registerMany([agentManifestFromHermesCandidate({ schema: 'chimera.hermes-agent-candidate.v1',
    candidateId: 'fixture:ace', profileId: 'ace', displayName: 'Ace', sourceRef: 'hermes://fixture/profiles/ace' })])
  const submitted = await runtime.submitTask({ objective: 'Have Ace inspect its task inbox and report back.' })
  assert.equal((await runtime.waitForTask(submitted.taskId)).status, 'completed')
  assert.deepEqual(calls.map(row => row.context.stage), ['decompose', 'specialist-loop', 'specialist-loop', 'synthesize'])
  assert.deepEqual(calls.map(row => row.id), ['fixture-1', 'fixture-2', 'fixture-2', 'fixture-3'])
  assert.equal(resumes.length, 1)
  assert.ok(calls.every(row => !Object.hasOwn(row.context, 'sessionBindings') && !Object.hasOwn(row.context, 'sessionScope')))
  const records = (await readFile(join(directory, 'model-calls/codex-sessions.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.deepEqual(records.map(row => row.record.state), ['running', 'ready', 'running', 'ready', 'running', 'ready', 'running', 'ready'])
  assert.equal(new Set(records.map(row => row.record.key)).size, 3)
  assert.ok((await runtime.state()).activity.some(event => event.kind === 'model.execution.progress' && event.label === 'Codex model turn completed'))
})

for (const action of ['cancel', 'shutdown']) test(`runtime ${action} reaches the physical Codex stream through gateway and auto routing`, { timeout: 10_000 }, async t => {
  const entered = Promise.withResolvers(), aborted = Promise.withResolvers(), release = Promise.withResolvers()
  t.after(() => release.resolve())
  const { runtime, audit } = await fixture(t, { startThread() { return {
    async runStreamed(_prompt, { signal }) {
      signal?.addEventListener('abort', () => { aborted.resolve(); release.resolve() }, { once: true })
      entered.resolve(signal)
      return { events: (async function* () {
        yield { type: 'turn.started' }
        await release.promise
        signal?.throwIfAborted()
        yield { type: 'turn.completed' }
      })() }
    },
  } } })
  const task = await runtime.submitTask({ objective: 'Cancel this bounded planning call.' })
  const signal = await entered.promise
  // Release even on assertion failure so test cleanup cannot leave a held executor.
  if (!signal) release.resolve()
  assert.ok(signal instanceof AbortSignal)
  if (action === 'cancel') await runtime.cancelTask({ taskId: task.taskId })
  else await runtime.close()
  await aborted.promise
  const result = await runtime.waitForTask(task.taskId)
  assert.equal(result.status, action === 'cancel' ? 'cancelled' : 'failed')
  if (action === 'shutdown') assert.equal(result.failure.code, 'PROCESS_STOPPED')
  const progress = audit.entries().filter(row => row.fact.kind === 'model.execution.progress').map(row => row.fact)
  assert.equal(progress.length, 1)
  assert.equal(progress[0].phase, 'started')
  assert.equal(progress[0].taskId, task.taskId)
  assert.equal(progress[0].agentId, 'ceo')
})
