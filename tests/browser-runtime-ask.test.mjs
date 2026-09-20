import assert from 'node:assert/strict'
import { chmod, lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ChimeraBrowserRuntime } from '../src/browser/runtime.mjs'
import { sha256 } from '../src/canonical.mjs'

function memoryBrowserExecutor() {
  const state = { running: true, tabs: [{ tabId: 'tab-1', title: 'New tab', url: 'about:blank', active: true }] }
  return {
    async start() { return structuredClone(state) },
    async state() { return structuredClone(state) },
    async suspend() { state.running = false; return structuredClone(state) },
    allowTemporaryNavigation() {},
  }
}

async function removeTree(path) {
  try {
    const info = await lstat(path)
    if (info.isDirectory()) {
      await chmod(path, 0o700)
      for (const entry of await readdir(path)) await removeTree(join(path, entry))
    } else await chmod(path, 0o600)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  await rm(path, { recursive: true, force: true })
}

function pureAskRouter({ calls, responder }) {
  return {
    routerId: 'fixture:pure-ask',
    descriptor: {
      providerId: 'fixture',
      model: 'pure-ask',
      protocol: 'fixture',
      execution: 'inference-only',
    },
    async route(prompt, context) {
      calls.push({ prompt, context: structuredClone(context) })
      return responder(prompt, context)
    },
  }
}

function options(directory, modelRegistry) {
  return {
    profileDir: join(directory, 'browser/ceo'),
    decisionFile: join(directory, 'decisions.jsonl'),
    taskFile: join(directory, 'tasks.jsonl'),
    conversationFile: join(directory, 'conversations/messages.jsonl'),
    modelCallFile: join(directory, 'model-calls/events.jsonl'),
    modelSessionFile: join(directory, 'model-calls/codex-sessions.jsonl'),
    agentFile: join(directory, 'agents/registry.json'),
    agentModelFile: join(directory, 'agents/models.json'),
    agentAccessFile: join(directory, 'agents/access.json'),
    workerRoot: join(directory, 'agents/workspaces'),
    workerStateDir: join(directory, 'agents/workers'),
    mailboxFile: join(directory, 'agents/mailbox.jsonl'),
    agentContinuityFile: join(directory, 'agents/continuity.json'),
    modelRegistry,
    browserExecutor: memoryBrowserExecutor(),
  }
}

function modelRegistryFor(calls, responder) {
  const provider = pureAskRouter({ calls, responder })
  return {
    state: () => ({
      schema: 'chimera.model-provider-registry.v2',
      selected: { providerId: 'fixture', providerName: 'Fixture', model: 'pure-ask', modelName: 'Pure Ask' },
      providers: [{
        id: 'fixture', name: 'Fixture', configured: true,
        models: [{ id: 'pure-ask', name: 'Pure Ask', availability: 'authenticated', capabilities: ['conversation'] }],
      }],
    }),
    router() { throw new Error('normal task router must not be used by Ask') },
    async routerForAsk() { return provider },
    async select() {},
  }
}

test('runtime Ask uses only the signed pure model path and no task admission', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-ask-'))
  const calls = []
  const runtime = new ChimeraBrowserRuntime(options(directory, modelRegistryFor(calls, async () => ({ answer: 'A pure answer.' }))))
  let taskSubmissions = 0
  try {
    await runtime.start()
    const submit = runtime.tasks.submit.bind(runtime.tasks)
    runtime.tasks.submit = async (...args) => { taskSubmissions += 1; return submit(...args) }
    const result = await runtime.ask({
      requestId: 'ask-runtime-1', conversationId: 'main', recipientAgentId: 'ceo', content: 'What is the safe answer?',
    })
    assert.equal(result.status, 'completed')
    assert.equal(result.answer, 'A pure answer.')
    assert.equal(calls.length, 1)
    assert.equal(taskSubmissions, 0)
    assert.equal(calls[0].context.stage, 'ask')
    assert.equal(calls[0].context.askRequestId, 'ask-runtime-1')
    assert.equal('taskId' in calls[0].context, false)
    const repeated = await runtime.ask({
      requestId: 'ask-runtime-1', conversationId: 'main', recipientAgentId: 'ceo', content: 'What is the safe answer?',
    })
    assert.equal(repeated.answer, 'A pure answer.')
    assert.equal(calls.length, 1)
    assert.deepEqual(runtime.conversationHistory({ conversationId: 'main' }).messages.map(message => message.kind), ['question', 'answer'])
  } finally {
    await runtime.close()
    await removeTree(directory)
  }
})

test('runtime readiness test uses a durable inference-only receipt without conversation history or task admission', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-readiness-'))
  const calls = []
  const runtime = new ChimeraBrowserRuntime(options(directory, modelRegistryFor(calls, async () => ({ answer: 'OK' }))))
  try {
    await runtime.start()
    const configured = await runtime.agentReadiness({ agentId: 'ceo' })
    assert.equal(configured.status, 'configured')
    assert.equal(configured.lastTest, null)
    const result = await runtime.testAgent({
      agentId: 'ceo', requestId: 'agent-test-1', expectedFingerprint: configured.fingerprint, allowQuotaUse: true,
    })
    assert.equal(result.status, 'passed')
    assert.equal(result.scope, 'inference-only')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].prompt, 'Reply with exactly OK.')
    assert.equal(calls[0].context.stage, 'ask')
    assert.equal(calls[0].context.verificationScope, 'agent-readiness')
    assert.equal('history' in calls[0].context, false)
    assert.equal(runtime.tasks.active().length, 0)
    assert.equal(runtime.conversationHistory({ conversationId: 'main' }).messages.length, 0)
    const verified = await runtime.agentReadiness({ agentId: 'ceo' })
    assert.equal(verified.status, 'verified')
    const repeated = await runtime.testAgent({
      agentId: 'ceo', requestId: 'agent-test-1', expectedFingerprint: configured.fingerprint, allowQuotaUse: true,
    })
    assert.deepEqual(repeated, result)
    assert.equal(calls.length, 1)
  } finally {
    await runtime.close()
    await removeTree(directory)
  }
})

test('idle imported Hermes agents can run inference-only readiness checks without a task-bound worker', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-readiness-imported-idle-'))
  const calls = []
  const agentDiscovery = {
    async discover() {
      return {
        schema: 'chimera.agent-discovery.v1',
        source: { id: 'hermes-aws', type: 'hermes-ssm', host: 'fixture' },
        candidates: [
          { schema: 'chimera.hermes-agent-candidate.v1', candidateId: 'hermes-aws:rj', profileId: 'rj', displayName: 'RJ', sourceRef: 'hermes://fixture/profiles/rj', defaultRole: 'Team CEO', defaultCapabilities: ['orchestration'] },
          { schema: 'chimera.hermes-agent-candidate.v1', candidateId: 'hermes-aws:ace', profileId: 'ace', displayName: 'Ace', sourceRef: 'hermes://fixture/profiles/ace', defaultRole: 'Specialist', defaultCapabilities: ['research'] },
        ],
      }
    },
  }
  const runtime = new ChimeraBrowserRuntime({
    ...options(directory, modelRegistryFor(calls, async () => ({ answer: 'OK' }))),
    agentDiscovery,
    agentReferenceProvider: {
      async materialize(_reference, { kind }) {
        if (kind === 'persona') return [{ path: 'SOUL.md', content: 'Imported persona.' }]
        if (kind === 'memory') return [{ path: 'MEMORY.md', content: 'Imported memory.' }]
        return [{ path: 'skills/review.md', content: 'Imported skill.' }]
      },
    },
  })
  try {
    await runtime.start()
    const preview = await runtime.discoverAgents()
    await runtime.importMainAgent({ discoveryId: preview.discoveryId, candidateId: 'hermes-aws:rj' })
    await runtime.importAgents({ discoveryId: preview.discoveryId, agents: [{ candidateId: 'hermes-aws:ace' }] })
    const mainReadiness = await runtime.agentReadiness({ agentId: 'ceo' })
    const specialistReadiness = await runtime.agentReadiness({ agentId: 'ace' })
    assert.equal(mainReadiness.checks.find(row => row.name === 'executor').status, 'unknown')
    assert.equal(specialistReadiness.checks.find(row => row.name === 'executor').status, 'unknown')
    const mainTest = await runtime.testAgent({ agentId: 'ceo', requestId: 'idle-main-test', expectedFingerprint: mainReadiness.fingerprint, allowQuotaUse: true })
    const specialistTest = await runtime.testAgent({ agentId: 'ace', requestId: 'idle-specialist-test', expectedFingerprint: specialistReadiness.fingerprint, allowQuotaUse: true })
    assert.equal(mainTest.status, 'passed')
    assert.equal(specialistTest.status, 'passed')
    assert.equal(calls.length, 2)
    assert.equal(runtime.tasks.active().length, 0)
    assert.equal(runtime.decisions.pending().length, 0)
    assert.equal(runtime.workerOwners.size, 0)
  } finally {
    await runtime.close()
    await removeTree(directory)
  }
})

test('runtime readiness fingerprints the actual Ask Auto leaf rather than the global selected model', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-readiness-auto-binding-'))
  const calls = []
  const registry = modelRegistryFor(calls, async () => ({ answer: 'OK' }))
  registry.describeSelection = () => ({
    schema: 'chimera.model-selection-description.v1', mode: 'auto', providerId: 'chimera-auto', model: 'auto',
    eligible: true, availability: 'available', inferenceCalled: false, verification: 'not-run',
  })
  registry.describeAskSelection = () => ({
    schema: 'chimera.model-ask-selection.v1', mode: 'auto', providerId: 'fixture', model: 'pure-ask',
    eligible: true, availability: 'available', execution: 'inference-only',
  })
  registry.state = () => ({
    schema: 'chimera.model-provider-registry.v2',
    selected: { providerId: 'disabled-and-wrong', model: 'wrong' },
    providers: [{ id: 'fixture', name: 'Fixture', configured: true, models: [{ id: 'pure-ask', availability: 'authenticated', capabilities: ['conversation'] }] }],
  })
  const runtime = new ChimeraBrowserRuntime(options(directory, registry))
  try {
    await runtime.start()
    const readiness = await runtime.agentReadiness({ agentId: 'ceo' })
    const model = readiness.checks.find(row => row.name === 'model')
    assert.equal(model.status, 'pass')
    assert.equal(model.details.providerId, 'fixture')
    assert.equal(model.details.model, 'pure-ask')
  } finally {
    await runtime.close()
    await removeTree(directory)
  }
})

test('readiness invalidates a passed inference receipt when the connection session changes in place', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-readiness-session-binding-'))
  const calls = []
  const registry = modelRegistryFor(calls, async () => ({ answer: 'OK' }))
  registry.describeSelection = () => ({
    schema: 'chimera.model-selection-description.v1', mode: 'auto', providerId: 'chimera-auto', model: 'auto',
    eligible: true, availability: 'available', inferenceCalled: false, verification: 'not-run',
  })
  registry.describeAskSelection = () => ({
    schema: 'chimera.model-ask-selection.v1', mode: 'auto', providerId: 'fixture', model: 'pure-ask',
    eligible: true, availability: 'available', execution: 'inference-only',
  })
  const runtime = new ChimeraBrowserRuntime(options(directory, registry))
  let sessionStatus = 'ready'
  try {
    await runtime.start()
    runtime.connectionState = () => [{
      providerId: 'fixture', enabled: true, revision: 3, status: 'available',
      provenance: { machineRef: 'machine-fixture', accountRef: 'fixture-account', signedIn: true, sessionStatus },
    }]
    const before = await runtime.agentReadiness({ agentId: 'ceo' })
    const passed = await runtime.testAgent({ agentId: 'ceo', requestId: 'session-binding-test', expectedFingerprint: before.fingerprint, allowQuotaUse: true })
    assert.equal(passed.status, 'passed')
    sessionStatus = 'expired'
    const changed = await runtime.agentReadiness({ agentId: 'ceo' })
    assert.equal(changed.status, 'configured')
    assert.equal(changed.checks.find(row => row.name === 'execution').status, 'unknown')
    assert.equal(changed.lastTest.historical, true)
  } finally {
    await runtime.close()
    await removeTree(directory)
  }
})

test('disabled Ask binding blocks readiness even when the pure model catalog is otherwise eligible', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-readiness-disabled-binding-'))
  const calls = []
  const registry = modelRegistryFor(calls, async () => ({ answer: 'must not run' }))
  registry.describeSelection = () => ({
    schema: 'chimera.model-selection-description.v1', mode: 'auto', providerId: 'chimera-auto', model: 'auto',
    eligible: true, availability: 'available', inferenceCalled: false, verification: 'not-run',
  })
  registry.describeAskSelection = () => ({
    schema: 'chimera.model-ask-selection.v1', mode: 'auto', providerId: 'fixture', model: 'pure-ask',
    eligible: true, availability: 'available', execution: 'inference-only',
  })
  const runtime = new ChimeraBrowserRuntime(options(directory, registry))
  try {
    await runtime.start()
    runtime.connectionState = () => [{
      providerId: 'fixture', enabled: false, revision: 9, status: 'not-connected',
      provenance: { machineRef: 'machine-fixture', accountRef: null, signedIn: false },
    }]
    const readiness = await runtime.agentReadiness({ agentId: 'ceo' })
    assert.equal(readiness.status, 'blocked')
    assert.equal(readiness.checks.find(row => row.name === 'model').reason, 'AGENT_CONNECTION_DISABLED')
    await assert.rejects(runtime.testAgent({ agentId: 'ceo', requestId: 'disabled-binding-test', expectedFingerprint: readiness.fingerprint, allowQuotaUse: true }), { code: 'AGENT_READINESS_BLOCKED' })
    assert.equal(calls.length, 0)
  } finally {
    await runtime.close()
    await removeTree(directory)
  }
})

test('concurrent exact agent readiness tests join one live pure inference and a stranded pending request becomes unknown', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-readiness-singleflight-'))
  const calls = []
  let release
  const held = new Promise(resolve => { release = resolve })
  let entered
  const routeEntered = new Promise(resolve => { entered = resolve })
  const registry = modelRegistryFor(calls, async () => {
    entered()
    await held
    return { answer: 'OK' }
  })
  const runtime = new ChimeraBrowserRuntime(options(directory, registry))
  try {
    await runtime.start()
    const configured = await runtime.agentReadiness({ agentId: 'ceo' })
    const first = runtime.testAgent({ agentId: 'ceo', requestId: 'same-agent-test', expectedFingerprint: configured.fingerprint, allowQuotaUse: true })
    await routeEntered
    const second = runtime.testAgent({ agentId: 'ceo', requestId: 'same-agent-test', expectedFingerprint: configured.fingerprint, allowQuotaUse: true })
    assert.equal(calls.length, 1)
    release()
    const [firstResult, secondResult] = await Promise.all([first, second])
    assert.equal(firstResult.status, 'passed')
    assert.deepEqual(secondResult, firstResult)
    assert.equal(calls.length, 1)

    const stranded = 'stranded-agent-test'
    await runtime.agentReadinessStore.record({
      agentId: 'ceo', requestId: stranded, requestScope: 'agent-readiness',
      intentFingerprint: sha256({ agentId: 'ceo', expectedFingerprint: configured.fingerprint, allowQuotaUse: true }),
      fingerprint: configured.fingerprint, scope: 'inference-only', status: 'pending',
      observedAt: new Date(runtime.now()).toISOString(),
    })
    const unknown = await runtime.testAgent({ agentId: 'ceo', requestId: stranded, expectedFingerprint: configured.fingerprint, allowQuotaUse: true })
    assert.equal(unknown.status, 'unknown')
    assert.equal(runtime.agentReadinessStore.getRequest({ agentId: 'ceo', requestScope: 'agent-readiness', requestId: stranded }).status, 'unknown')
    assert.equal(calls.length, 1)
  } finally {
    release?.()
    await runtime.close()
    await removeTree(directory)
  }
})

test('agent readiness fences a fresh request id for the same unresolved binding after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-readiness-fresh-id-fence-'))
  const calls = []
  const registry = modelRegistryFor(calls, async () => {
    const error = new Error('provider response was lost')
    error.code = 'MODEL_CALL_OUTCOME_UNKNOWN'
    throw error
  })
  const make = () => new ChimeraBrowserRuntime(options(directory, registry))
  let runtime
  let restarted
  try {
    runtime = make()
    await runtime.start()
    const configured = await runtime.agentReadiness({ agentId: 'ceo' })
    const first = await runtime.testAgent({ agentId: 'ceo', requestId: 'agent-test-fence-a', expectedFingerprint: configured.fingerprint, allowQuotaUse: true })
    assert.equal(first.status, 'unknown')
    await runtime.close()
    runtime = null

    restarted = make()
    await restarted.start()
    const current = await restarted.agentReadiness({ agentId: 'ceo' })
    const fresh = await restarted.testAgent({ agentId: 'ceo', requestId: 'agent-test-fence-b', expectedFingerprint: current.fingerprint, allowQuotaUse: true })
    assert.equal(fresh.status, 'unknown')
    assert.equal(fresh.unresolvedRequestId, 'agent-test-fence-a')
    assert.equal(calls.length, 1)
  } finally {
    await runtime?.close()
    await restarted?.close()
    await removeTree(directory)
  }
})

test('concurrent fresh agent readiness ids do not dispatch a second pure inference', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-readiness-fresh-id-flight-'))
  const calls = []
  let release
  const held = new Promise(resolve => { release = resolve })
  let entered
  const routeEntered = new Promise(resolve => { entered = resolve })
  const registry = modelRegistryFor(calls, async () => {
    entered()
    await held
    return { answer: 'OK' }
  })
  const runtime = new ChimeraBrowserRuntime(options(directory, registry))
  try {
    await runtime.start()
    const configured = await runtime.agentReadiness({ agentId: 'ceo' })
    const first = runtime.testAgent({ agentId: 'ceo', requestId: 'agent-test-flight-a', expectedFingerprint: configured.fingerprint, allowQuotaUse: true })
    await routeEntered
    const second = await runtime.testAgent({ agentId: 'ceo', requestId: 'agent-test-flight-b', expectedFingerprint: configured.fingerprint, allowQuotaUse: true })
    assert.equal(second.status, 'unknown')
    assert.equal(second.errorCode, 'AGENT_TEST_BINDING_IN_FLIGHT')
    assert.equal(second.unresolvedRequestId, 'agent-test-flight-a')
    release()
    assert.equal((await first).status, 'passed')
    assert.equal(calls.length, 1)
  } finally {
    release?.()
    await runtime.close()
    await removeTree(directory)
  }
})

test('agent readiness pins the captured Ask leaf and never stamps a stale Auto fingerprint onto a changed route', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-readiness-binding-race-'))
  const calls = []
  let release
  const held = new Promise(resolve => { release = resolve })
  let entered
  const routeEntered = new Promise(resolve => { entered = resolve })
  const registry = modelRegistryFor(calls, async () => ({ answer: 'must not dispatch' }))
  registry.describeSelection = () => ({
    schema: 'chimera.model-selection-description.v1', mode: 'auto', providerId: 'chimera-auto', model: 'auto',
    eligible: true, availability: 'available', inferenceCalled: false, verification: 'not-run',
  })
  registry.describeAskSelection = () => ({
    schema: 'chimera.model-ask-selection.v1', mode: 'auto', providerId: 'fixture-a', model: 'model-a',
    eligible: true, availability: 'available', execution: 'inference-only',
  })
  registry.routerForAsk = async preference => {
    assert.equal(preference.mode, 'pinned')
    assert.equal(preference.providerId, 'fixture-a')
    assert.equal(preference.model, 'model-a')
    entered()
    await held
    return {
      routerId: 'fixture:model-b',
      descriptor: { providerId: 'fixture-b', model: 'model-b', protocol: 'fixture', execution: 'inference-only' },
      async route() { calls.push({ changedRouteDispatch: true }); return { answer: 'must not dispatch' } },
    }
  }
  const runtime = new ChimeraBrowserRuntime(options(directory, registry))
  try {
    await runtime.start()
    const readiness = await runtime.agentReadiness({ agentId: 'ceo' })
    const request = runtime.testAgent({ agentId: 'ceo', requestId: 'binding-race-test', expectedFingerprint: readiness.fingerprint, allowQuotaUse: true })
    await routeEntered
    release()
    await assert.rejects(request, { code: 'AGENT_READINESS_BINDING_CHANGED' })
    assert.equal(calls.length, 0)
    const receipt = runtime.agentReadinessStore.getRequest({ agentId: 'ceo', requestScope: 'agent-readiness', requestId: 'binding-race-test' })
    assert.equal(receipt.status, 'failed')
    assert.equal(receipt.fingerprint, readiness.fingerprint)
  } finally {
    release?.()
    await runtime.close()
    await removeTree(directory)
  }
})

test('runtime Ask resolves a direct built-in specialist with only its own continuity and identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-ask-specialist-'))
  const calls = []
  const runtime = new ChimeraBrowserRuntime(options(directory, modelRegistryFor(calls, async () => ({ answer: 'Researcher answer.' }))))
  try {
    await runtime.start()
    const result = await runtime.ask({
      requestId: 'ask-specialist-1', conversationId: 'agent:researcher', recipientAgentId: 'researcher', content: 'Give a bounded research answer.',
    })
    assert.equal(result.status, 'completed')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].context.agentContinuity.agentId, 'researcher')
    assert.equal(calls[0].context.agentContinuity.status, 'built-in')
    assert.equal('history' in calls[0].context, false)
    assert.equal('taskId' in calls[0].context, false)
    assert.equal('tools' in calls[0].context, false)
    assert.equal(runtime.tasks.active().length, 0)
    assert.equal(runtime.audit.entries().some(entry => entry.fact.kind === 'model.call.authorized' && entry.fact.agentId === 'researcher'), true)
  } finally {
    await runtime.close()
    await removeTree(directory)
  }
})

test('runtime Ask rejects a native/pinned executor before provider dispatch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-ask-pinned-'))
  const calls = []
  const base = modelRegistryFor(calls, async () => ({ answer: 'must not run' }))
  base.routerForAsk = async preference => {
    if (preference.mode === 'pinned') {
      const error = new Error('ASK_EXECUTOR_NOT_PURE')
      error.code = 'ASK_EXECUTOR_NOT_PURE'
      throw error
    }
    return pureAskRouter({ calls, responder: async () => ({ answer: 'must not run' }) })
  }
  const runtime = new ChimeraBrowserRuntime(options(directory, base))
  try {
    await runtime.start()
    await runtime.agentModelPolicy.set('ceo', { mode: 'pinned', providerId: 'codex', model: 'subscription' }, { changedBy: 'rod' })
    const result = await runtime.ask({
      requestId: 'ask-pinned-1', conversationId: 'main', recipientAgentId: 'ceo', content: 'This cannot use native tools.',
    })
    assert.equal(result.status, 'failed-not-sent')
    assert.equal(calls.length, 0)
    assert.equal(runtime.tasks.active().length, 0)
    assert.equal(runtime.decisions.pending().length, 0)
  } finally {
    await runtime.close()
    await removeTree(directory)
  }
})

test('runtime Ask status survives restart without re-invoking a durably completed model call', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-ask-restart-'))
  const calls = []
  const registry = modelRegistryFor(calls, async () => ({ answer: 'Durable pure answer.' }))
  const make = () => new ChimeraBrowserRuntime(options(directory, registry))
  let runtime
  let restarted
  try {
    runtime = make()
    await runtime.start()
    const first = await runtime.ask({
      requestId: 'ask-restart-1', conversationId: 'main', recipientAgentId: 'ceo', content: 'Persist this answer.',
    })
    assert.equal(first.status, 'completed')
    await runtime.close()
    runtime = null

    restarted = make()
    await restarted.start()
    const status = await restarted.askStatus('ask-restart-1')
    assert.equal(status.status, 'completed')
    assert.equal(status.answer, 'Durable pure answer.')
    const repeated = await restarted.ask({
      requestId: 'ask-restart-1', conversationId: 'main', recipientAgentId: 'ceo', content: 'Persist this answer.',
    })
    assert.deepEqual(repeated, status)
    assert.equal(calls.length, 1)
  } finally {
    await runtime?.close()
    await restarted?.close()
    await removeTree(directory)
  }
})

test('runtime Ask restores an interrupted dispatch as unknown and never retries it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-ask-unknown-'))
  const calls = []
  const registry = modelRegistryFor(calls, async () => {
    const error = new Error('provider response was lost')
    error.code = 'MODEL_CALL_OUTCOME_UNKNOWN'
    throw error
  })
  const make = () => new ChimeraBrowserRuntime(options(directory, registry))
  let runtime
  let restarted
  try {
    runtime = make()
    await runtime.start()
    const first = await runtime.ask({
      requestId: 'ask-unknown-1', conversationId: 'main', recipientAgentId: 'ceo', content: 'Do not retry this call.',
    })
    assert.equal(first.status, 'unknown')
    assert.equal(calls.length, 1)
    await runtime.close()
    runtime = null
    restarted = make()
    await restarted.start()
    const status = await restarted.askStatus('ask-unknown-1')
    assert.equal(status.status, 'unknown')
    const repeated = await restarted.ask({
      requestId: 'ask-unknown-1', conversationId: 'main', recipientAgentId: 'ceo', content: 'Do not retry this call.',
    })
    assert.equal(repeated.status, 'unknown')
    assert.equal(calls.length, 1)
  } finally {
    await runtime?.close()
    await restarted?.close()
    await removeTree(directory)
  }
})

test('runtime Ask redacts provider answers and errors before both durable journals', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-ask-redaction-'))
  // Build the fixture token at runtime so the repository scanner never treats
  // the test value as a credential-shaped literal.
  const secret = ['sk', 'live', '012345678901234567890123456789'].join('-')
  const calls = []
  let invocation = 0
  const registry = modelRegistryFor(calls, async () => {
    invocation += 1
    if (invocation === 1) return { answer: `Provider returned Bearer ${secret}.` }
    const error = new Error(`provider leaked token=${secret}`)
    error.code = 'PROVIDER_RESPONSE_INVALID'
    throw error
  })
  const runtime = new ChimeraBrowserRuntime(options(directory, registry))
  try {
    await runtime.start()
    const answer = await runtime.ask({
      requestId: 'ask-redact-answer', conversationId: 'main', recipientAgentId: 'ceo', content: 'Redact this answer.',
    })
    assert.equal(answer.status, 'completed')
    assert.equal(answer.answer.includes(secret), false)
    const failure = await runtime.ask({
      requestId: 'ask-redact-error', conversationId: 'main', recipientAgentId: 'ceo', content: 'Redact this error.',
    })
    assert.equal(failure.status, 'unknown')
    assert.equal(calls.length, 2)
    const conversation = JSON.stringify(runtime.conversationHistory({ conversationId: 'main' }))
    const modelCalls = await readFile(join(directory, 'model-calls/events.jsonl'), 'utf8')
    assert.equal(conversation.includes(secret), false)
    assert.equal(modelCalls.includes(secret), false)
    assert.equal(modelCalls.includes('provider leaked token'), false)
  } finally {
    await runtime.close()
    await removeTree(directory)
  }
})

test('runtime Ask reopens selected specialist continuity locally after restart without reference materialization', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-ask-continuity-'))
  const calls = []
  let materializeCalls = 0
  const agentDiscovery = {
    async discover() {
      return {
        schema: 'chimera.agent-discovery.v1',
        source: { id: 'hermes-aws', type: 'hermes-ssm', host: 'fixture' },
        candidates: [{
          schema: 'chimera.hermes-agent-candidate.v1', candidateId: 'hermes-aws:ace', profileId: 'ace',
          displayName: 'Ace', sourceRef: 'hermes://fixture/profiles/ace', defaultRole: 'Specialist', defaultCapabilities: ['research'],
        }],
      }
    },
  }
  const referenceProvider = {
    async materialize(_reference, { kind }) {
      materializeCalls += 1
      if (kind === 'persona') return [{ path: 'SOUL.md', content: 'Ace local persona.' }]
      if (kind === 'memory') return [{ path: 'MEMORY.md', content: 'Ace local memory.' }]
      return []
    },
  }
  const make = provider => new ChimeraBrowserRuntime({
    ...options(directory, modelRegistryFor(calls, async () => ({ answer: 'Continuity answer.' }))),
    agentDiscovery,
    agentReferenceProvider: provider,
  })
  let runtime
  let restarted
  try {
    runtime = make(referenceProvider)
    await runtime.start()
    const preview = await runtime.discoverAgents()
    await runtime.importAgents({ discoveryId: preview.discoveryId, agents: [{ candidateId: 'hermes-aws:ace' }] })
    const first = await runtime.ask({
      requestId: 'ask-continuity-1', conversationId: 'agent:ace', recipientAgentId: 'ace', content: 'Use only Ace continuity.',
    })
    assert.equal(first.status, 'completed')
    assert.equal(materializeCalls, 3)
    await runtime.close()
    runtime = null

    let restartMaterializeCalls = 0
    restarted = make({
      async materialize() {
        restartMaterializeCalls += 1
        throw new Error('reference provider must not run for Ask restart')
      },
    })
    await restarted.start()
    const second = await restarted.ask({
      requestId: 'ask-continuity-2', conversationId: 'agent:ace', recipientAgentId: 'ace', content: 'Use only Ace continuity.',
    })
    assert.equal(second.status, 'completed')
    assert.equal(restartMaterializeCalls, 0)
    assert.equal(calls.at(-1).context.agentContinuity.persona[0].content, 'Ace local persona.')
    assert.deepEqual(calls.at(-1).context.agentContinuity.skills, [])
  } finally {
    await runtime?.close()
    await restarted?.close()
    await removeTree(directory)
  }
})

test('runtime Ask restores the imported RJ capsule locally with durable continuity and no rematerialization', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-ask-main-continuity-'))
  const calls = []
  const agentDiscovery = {
    async discover() {
      return {
        schema: 'chimera.agent-discovery.v1',
        source: { id: 'hermes-aws', type: 'hermes-ssm', host: 'fixture' },
        candidates: [{
          schema: 'chimera.hermes-agent-candidate.v1', candidateId: 'hermes-aws:rj', profileId: 'rj',
          displayName: 'RJ', sourceRef: 'hermes://fixture/profiles/rj', defaultRole: 'Team CEO', defaultCapabilities: ['orchestration'],
        }],
      }
    },
  }
  const referenceProvider = {
    async materialize(_reference, { kind }) {
      if (kind === 'persona') return [{ path: 'SOUL.md', content: 'RJ local persona.' }]
      if (kind === 'memory') return [{ path: 'MEMORY.md', content: '' }]
      return [{ path: 'continuity.md', content: 'RJ local skill.' }]
    },
  }
  const make = provider => new ChimeraBrowserRuntime({
    ...options(directory, modelRegistryFor(calls, async () => ({ answer: 'RJ answer.' }))),
    agentDiscovery,
    agentReferenceProvider: provider,
  })
  let runtime
  let restarted
  try {
    runtime = make(referenceProvider)
    await runtime.start()
    const preview = await runtime.discoverAgents()
    const imported = await runtime.importMainAgent({ discoveryId: preview.discoveryId, candidateId: 'hermes-aws:rj' })
    assert.equal(imported.continuity.report.persona.files, 1)
    assert.equal(imported.continuity.report.memory.files, 1)
    assert.equal(runtime.agentContinuity.get('rj').status, 'materialized')
    await runtime.close()
    runtime = null

    let restartMaterializeCalls = 0
    restarted = make({
      async materialize() {
        restartMaterializeCalls += 1
        throw new Error('reference provider must not run for main Ask restart')
      },
    })
    await restarted.start()
    const result = await restarted.ask({
      requestId: 'ask-main-continuity-1', conversationId: 'main', recipientAgentId: 'ceo', content: 'Use RJ local continuity.',
    })
    assert.equal(result.status, 'completed')
    assert.equal(restartMaterializeCalls, 0)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].context.agentContinuity.agentId, 'rj')
    assert.equal(calls[0].context.agentContinuity.report.memory.files, 1)
    assert.equal((await restarted.state()).agents.main.continuity.digest, imported.continuity.digest)
  } finally {
    await runtime?.close()
    await restarted?.close()
    await removeTree(directory)
  }
})

test('runtime Ask blocks a legacy main capsule with missing required persona before provider dispatch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-ask-legacy-main-missing-'))
  const calls = []
  const agentDiscovery = {
    async discover() {
      return {
        schema: 'chimera.agent-discovery.v1',
        source: { id: 'hermes-aws', type: 'hermes-ssm', host: 'fixture' },
        candidates: [{
          schema: 'chimera.hermes-agent-candidate.v1', candidateId: 'hermes-aws:rj', profileId: 'rj',
          displayName: 'RJ', sourceRef: 'hermes://fixture/profiles/rj', defaultRole: 'Team CEO', defaultCapabilities: ['orchestration'],
        }],
      }
    },
  }
  const referenceProvider = {
    async materialize(_reference, { kind }) {
      if (kind === 'persona') return [{ path: 'SOUL.md', content: 'RJ legacy persona.' }]
      if (kind === 'memory') return [{ path: 'MEMORY.md', content: '' }]
      return []
    },
  }
  const make = provider => new ChimeraBrowserRuntime({
    ...options(directory, modelRegistryFor(calls, async () => ({ answer: 'must not run' }))),
    agentDiscovery,
    agentReferenceProvider: provider,
  })
  let runtime
  let restarted
  try {
    runtime = make(referenceProvider)
    await runtime.start()
    const preview = await runtime.discoverAgents()
    await runtime.importMainAgent({ discoveryId: preview.discoveryId, candidateId: 'hermes-aws:rj' })
    await runtime.close()
    runtime = null
    await removeTree(join(directory, 'agents/continuity.json'))
    await removeTree(join(directory, 'agents/workspaces/rj/mounts/persona'))

    let restartMaterializeCalls = 0
    restarted = make({
      async materialize() {
        restartMaterializeCalls += 1
        throw new Error('legacy Ask must not rematerialize')
      },
    })
    await restarted.start()
    const result = await restarted.ask({
      requestId: 'ask-legacy-main-missing', conversationId: 'main', recipientAgentId: 'ceo', content: 'Reject missing legacy persona.',
    })
    assert.equal(result.status, 'failed-not-sent')
    assert.equal(result.failureCode, 'WORKER_CONTINUITY_INCOMPLETE')
    assert.equal(calls.length, 0)
    assert.equal(restartMaterializeCalls, 0)
  } finally {
    await runtime?.close()
    await restarted?.close()
    await removeTree(directory)
  }
})

test('runtime Ask rejects a manifest-only imported capsule before provider dispatch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-ask-missing-layers-'))
  const calls = []
  const agentDiscovery = {
    async discover() {
      return {
        schema: 'chimera.agent-discovery.v1',
        source: { id: 'hermes-aws', type: 'hermes-ssm', host: 'fixture' },
        candidates: [{
          schema: 'chimera.hermes-agent-candidate.v1', candidateId: 'hermes-aws:ace', profileId: 'ace',
          displayName: 'Ace', sourceRef: 'hermes://fixture/profiles/ace', defaultRole: 'Specialist', defaultCapabilities: ['research'],
        }],
      }
    },
  }
  const referenceProvider = {
    async materialize(_reference, { kind }) {
      if (kind === 'persona') return [{ path: 'SOUL.md', content: 'Ace local persona.' }]
      if (kind === 'memory') return [{ path: 'MEMORY.md', content: '' }]
      return [{ path: 'skill.md', content: 'Ace local skill.' }]
    },
  }
  const make = provider => new ChimeraBrowserRuntime({
    ...options(directory, modelRegistryFor(calls, async () => ({ answer: 'must not run' }))),
    agentDiscovery,
    agentReferenceProvider: provider,
  })
  let runtime
  let restarted
  try {
    runtime = make(referenceProvider)
    await runtime.start()
    const preview = await runtime.discoverAgents()
    await runtime.importAgents({ discoveryId: preview.discoveryId, agents: [{ candidateId: 'hermes-aws:ace' }] })
    await runtime.close()
    runtime = null
    await removeTree(join(directory, 'agents/workspaces/ace/mounts'))

    let restartMaterializeCalls = 0
    restarted = make({
      async materialize() {
        restartMaterializeCalls += 1
        throw new Error('reference provider must not run for missing-capsule Ask')
      },
    })
    await restarted.start()
    const result = await restarted.ask({
      requestId: 'ask-missing-layers-1', conversationId: 'agent:ace', recipientAgentId: 'ace', content: 'Reject missing continuity.',
    })
    assert.equal(result.status, 'failed-not-sent')
    assert.equal(result.failureCode, 'WORKER_CONTINUITY_INCOMPLETE')
    assert.equal(calls.length, 0)
    assert.equal(restartMaterializeCalls, 0)
  } finally {
    await runtime?.close()
    await restarted?.close()
    await removeTree(directory)
  }
})

test('runtime Ask keeps an imported Hermes zero-file required layer unavailable without provider dispatch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-ask-zero-hermes-'))
  const calls = []
  const agentDiscovery = {
    async discover() {
      return {
        schema: 'chimera.agent-discovery.v1',
        source: { id: 'hermes-aws', type: 'hermes-ssm', host: 'fixture' },
        candidates: [{
          schema: 'chimera.hermes-agent-candidate.v1', candidateId: 'hermes-aws:empty', profileId: 'empty',
          displayName: 'Empty', sourceRef: 'hermes://fixture/profiles/empty', defaultRole: 'Specialist', defaultCapabilities: ['research'],
        }],
      }
    },
  }
  const runtime = new ChimeraBrowserRuntime({
    ...options(directory, modelRegistryFor(calls, async () => ({ answer: 'must not run' }))),
    agentDiscovery,
    agentReferenceProvider: { async materialize() { return [] } },
  })
  try {
    await runtime.start()
    const preview = await runtime.discoverAgents()
    const imported = await runtime.importAgents({ discoveryId: preview.discoveryId, agents: [{ candidateId: 'hermes-aws:empty' }] })
    assert.equal(imported.continuity[0].status, 'unavailable')
    const result = await runtime.ask({
      requestId: 'ask-zero-hermes', conversationId: 'agent:empty', recipientAgentId: 'empty', content: 'Reject zero continuity.',
    })
    assert.equal(result.status, 'failed-not-sent')
    assert.equal(result.failureCode, 'ASK_CONTINUITY_UNAVAILABLE')
    assert.equal(calls.length, 0)
  } finally {
    await runtime.close()
    await removeTree(directory)
  }
})

test('native creation remains valid with optional empty memory while zero persona blocks Ask dispatch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-ask-zero-native-'))
  const calls = []
  let personaAvailable = true
  const runtime = new ChimeraBrowserRuntime({
    ...options(directory, modelRegistryFor(calls, async () => ({ answer: 'must not run' }))),
    nativeReferenceProvider: {
      async savePersona() {},
      async materialize(_reference, { kind }) {
        if (kind === 'persona') return personaAvailable ? [{ path: 'SOUL.md', content: 'Native persona.' }] : []
        return []
      },
    },
  })
  try {
    await runtime.start()
    const created = await runtime.createAgent({
      requestId: 'create-valid-native', agentId: 'valid-native', displayName: 'Valid Native',
      role: 'Testing', capabilities: ['testing'], persona: 'Native persona.',
    })
    assert.equal(created.continuity[0].status, 'materialized')
    assert.equal(created.continuity[0].report.memory.files, 0)
    personaAvailable = false
    const blocked = await runtime.createAgent({
      requestId: 'create-zero-native', agentId: 'zero-native', displayName: 'Zero Native',
      role: 'Testing', capabilities: ['testing'], persona: 'Native persona.',
    })
    assert.equal(blocked.continuity[0].status, 'unavailable')
    const result = await runtime.ask({
      requestId: 'ask-zero-native', conversationId: 'agent:zero-native', recipientAgentId: 'zero-native', content: 'Reject zero continuity.',
    })
    assert.equal(result.status, 'failed-not-sent')
    assert.equal(result.failureCode, 'ASK_CONTINUITY_UNAVAILABLE')
    assert.equal(calls.length, 0)
  } finally {
    await runtime.close()
    await removeTree(directory)
  }
})

test('runtime Ask rejects a cached zero-file required layer before provider dispatch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-ask-cached-zero-'))
  const calls = []
  const agentDiscovery = {
    async discover() {
      return {
        schema: 'chimera.agent-discovery.v1',
        source: { id: 'hermes-aws', type: 'hermes-ssm', host: 'fixture' },
        candidates: [{
          schema: 'chimera.hermes-agent-candidate.v1', candidateId: 'hermes-aws:ace', profileId: 'ace',
          displayName: 'Ace', sourceRef: 'hermes://fixture/profiles/ace', defaultRole: 'Specialist', defaultCapabilities: ['research'],
        }],
      }
    },
  }
  const runtime = new ChimeraBrowserRuntime({
    ...options(directory, modelRegistryFor(calls, async () => ({ answer: 'must not run' }))),
    agentDiscovery,
    agentReferenceProvider: {
      async materialize(_reference, { kind }) {
        if (kind === 'persona') return [{ path: 'SOUL.md', content: 'Ace persona.' }]
        if (kind === 'memory') return [{ path: 'MEMORY.md', content: '' }]
        return []
      },
    },
  })
  try {
    await runtime.start()
    const preview = await runtime.discoverAgents()
    await runtime.importAgents({ discoveryId: preview.discoveryId, agents: [{ candidateId: 'hermes-aws:ace' }] })
    const { AgentWorkerWorkspace } = await import('../src/agents/worker-workspace.mjs')
    const report = {
      persona: { files: 0, bytes: 0 },
      memory: { files: 0, bytes: 0 },
      skills: { files: 0, bytes: 0 },
      excluded: ['credentials', 'provider-sessions', 'private-keys', 'authority-grants', 'transient-runtime-state', 'skill-assets'],
      dependencyStatus: 'unverified',
    }
    const continuity = {
      schema: 'chimera.agent-continuity-context.v1', agentId: 'ace', digest: '0'.repeat(64), dependencyStatus: 'unverified',
      persona: [], memory: [], skills: [], report,
    }
    const cached = new AgentWorkerWorkspace({
      path: join(directory, 'agents/workspaces/ace'), agentId: 'ace', mounts: [], continuity, audit: runtime.audit, now: () => Date.now(),
    })
    runtime.workerWorkspaces.set('ace', cached)
    runtime.agentContinuity.set('ace', { agentId: 'ace', status: 'materialized', digest: continuity.digest, report, failureCode: null })
    const result = await runtime.ask({
      requestId: 'ask-cached-zero', conversationId: 'agent:ace', recipientAgentId: 'ace', content: 'Reject cached zero continuity.',
    })
    assert.equal(result.status, 'failed-not-sent')
    assert.equal(result.failureCode, 'WORKER_CONTINUITY_INCOMPLETE')
    assert.equal(calls.length, 0)
  } finally {
    await runtime.close()
    await removeTree(directory)
  }
})

test('runtime Ask rejects pending and stale continuity evidence even for a cached workspace', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-ask-continuity-evidence-'))
  const calls = []
  const agentDiscovery = {
    async discover() {
      return {
        schema: 'chimera.agent-discovery.v1',
        source: { id: 'hermes-aws', type: 'hermes-ssm', host: 'fixture' },
        candidates: [{
          schema: 'chimera.hermes-agent-candidate.v1', candidateId: 'hermes-aws:ace', profileId: 'ace',
          displayName: 'Ace', sourceRef: 'hermes://fixture/profiles/ace', defaultRole: 'Specialist', defaultCapabilities: ['research'],
        }],
      }
    },
  }
  const referenceProvider = {
    async materialize(_reference, { kind }) {
      if (kind === 'persona') return [{ path: 'SOUL.md', content: 'Ace local persona.' }]
      if (kind === 'memory') return [{ path: 'MEMORY.md', content: '' }]
      return []
    },
  }
  const runtime = new ChimeraBrowserRuntime({
    ...options(directory, modelRegistryFor(calls, async () => ({ answer: 'cached answer' }))),
    agentDiscovery,
    agentReferenceProvider: referenceProvider,
  })
  try {
    await runtime.start()
    const preview = await runtime.discoverAgents()
    await runtime.importAgents({ discoveryId: preview.discoveryId, agents: [{ candidateId: 'hermes-aws:ace' }] })
    const first = await runtime.ask({
      requestId: 'ask-evidence-1', conversationId: 'agent:ace', recipientAgentId: 'ace', content: 'Cache the local capsule.',
    })
    assert.equal(first.status, 'completed')
    const evidence = runtime.agentContinuity.get('ace')
    runtime.agentContinuity.set('ace', { ...evidence, status: 'unavailable', digest: null, failureCode: 'AGENT_CONTINUITY_PENDING' })
    const pending = await runtime.ask({
      requestId: 'ask-evidence-pending', conversationId: 'agent:ace', recipientAgentId: 'ace', content: 'Reject pending continuity.',
    })
    assert.equal(pending.status, 'failed-not-sent')
    assert.equal(pending.failureCode, 'ASK_CONTINUITY_UNAVAILABLE')
    assert.equal(calls.length, 1)

    runtime.agentContinuity.set('ace', { ...evidence, digest: 'f'.repeat(64), failureCode: null })
    const stale = await runtime.ask({
      requestId: 'ask-evidence-stale', conversationId: 'agent:ace', recipientAgentId: 'ace', content: 'Reject stale continuity.',
    })
    assert.equal(stale.status, 'failed-not-sent')
    assert.equal(stale.failureCode, 'ASK_CONTINUITY_STALE')
    assert.equal(calls.length, 1)
  } finally {
    await runtime.close()
    await removeTree(directory)
  }
})

test('runtime Ask bounds aggregate continuity and reports omitted optional skill metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-ask-context-bound-'))
  const calls = []
  const agentDiscovery = {
    async discover() {
      return {
        schema: 'chimera.agent-discovery.v1', source: { id: 'hermes-aws', type: 'hermes-ssm', host: 'fixture' },
        candidates: [{
          schema: 'chimera.hermes-agent-candidate.v1', candidateId: 'hermes-aws:bounded', profileId: 'bounded',
          displayName: 'Bounded', sourceRef: 'hermes://fixture/profiles/bounded', defaultRole: 'Specialist', defaultCapabilities: ['research'],
        }],
      }
    },
  }
  const referenceProvider = {
    async materialize(_reference, { kind }) {
      if (kind === 'persona') return [{ path: 'SOUL.md', content: 'Bounded persona.' }]
      if (kind === 'memory') return [{ path: 'MEMORY.md', content: 'Bounded memory.' }]
      return Array.from({ length: 512 }, (_, index) => ({
        path: `skills/${'x'.repeat(200)}/${'y'.repeat(200)}/${'z'.repeat(200)}/${String(index).padStart(3, '0')}.md`, content: 'x'.repeat(1024),
      }))
    },
  }
  const runtime = new ChimeraBrowserRuntime({
    ...options(directory, modelRegistryFor(calls, async () => ({ answer: 'Bounded answer.' }))),
    agentDiscovery,
    agentReferenceProvider: referenceProvider,
  })
  try {
    await runtime.start()
    const preview = await runtime.discoverAgents()
    const imported = await runtime.importAgents({ discoveryId: preview.discoveryId, agents: [{ candidateId: 'hermes-aws:bounded' }] })
    assert.equal(imported.continuity[0].status, 'materialized', JSON.stringify(imported))
    const result = await runtime.ask({
      requestId: 'ask-context-bound', conversationId: 'agent:bounded', recipientAgentId: 'bounded', content: 'Keep continuity bounded.',
    })
    assert.equal(result.status, 'completed', JSON.stringify(result))
    assert.ok(Buffer.byteLength(JSON.stringify(calls[0].context), 'utf8') <= 240 * 1024)
    assert.equal(calls[0].context.agentContinuity.report.skills.files, 512)
    assert.ok(calls[0].context.agentContinuity.askProjection.skillsOmitted > 0)
  } finally {
    await runtime.close()
    await removeTree(directory)
  }
})
