import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoryAuditLog } from '../src/audit-log.mjs'
import { ChimeraBrowserRuntime } from '../src/browser/runtime.mjs'
import { createDeterministicModelRouter } from '../src/ceo/model-router.mjs'
import { createTaskAwareModelRouter } from '../src/ceo/task-aware-model-router.mjs'

function memoryBrowserExecutor({ allowedCallbacks = [] } = {}) {
  const state = {
    running: true,
    tabs: [{ tabId: 'tab-1', title: 'New tab', url: 'about:blank', active: true }],
  }
  return {
    async start() { return structuredClone(state) },
    async state() { return structuredClone(state) },
    async suspend() { state.running = false; return structuredClone(state) },
    allowTemporaryNavigation(url) { allowedCallbacks.push(url) },
  }
}

test('browser runtime executes one durable task through signed CEO and specialist model calls', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-task-'))
  const calls = []
  const provider = createDeterministicModelRouter({
    routerId: 'openai-compatible:fixture:bounded-model',
    responder: async (_prompt, context) => {
      calls.push(structuredClone(context))
      if (context.stage === 'decompose') {
        return {
          tasks: [{
            specialistAgentId: 'researcher',
            objective: 'Prepare the bounded finding.',
            acceptanceCriteria: ['Return a concise finding.'],
          }],
        }
      }
      if (context.stage === 'specialist') {
        return { summary: 'The researcher completed the bounded finding.', findings: ['Ready'] }
      }
      return { summary: 'The CEO verified and synthesized the bounded finding.' }
    },
  })
  const modelRegistry = {
    state() {
      return {
        schema: 'chimera.model-provider-registry.v1',
        selected: {
          providerId: 'fixture',
          providerName: 'Fixture',
          model: 'bounded-model',
          modelName: 'Bounded Model',
        },
        providers: [],
      }
    },
    router() {
      return provider
    },
    async select() {
      throw new Error('selection is not used in this test')
    },
  }
  const runtime = new ChimeraBrowserRuntime({
    profileDir: join(directory, 'profiles/ceo'),
    decisionFile: join(directory, 'decisions.jsonl'),
    taskFile: join(directory, 'tasks.jsonl'),
    modelCallFile: join(directory, 'model-calls.jsonl'),
    modelRegistry,
    browserExecutor: memoryBrowserExecutor(),
  })
  try {
    await runtime.start()
    const submitted = await runtime.submitTask({ objective: 'Give me a bounded readiness finding.' })
    assert.equal(submitted.status, 'queued')

    const completed = await runtime.waitForTask(submitted.taskId)
    assert.equal(completed.status, 'completed')
    assert.equal(completed.summary, 'The CEO verified and synthesized the bounded finding.')
    assert.deepEqual(calls.map((call) => call.stage), ['decompose', 'specialist', 'synthesize'])

    const state = await runtime.state()
    assert.equal(state.tasks[0].taskId, submitted.taskId)
    assert.equal(state.tasks[0].status, 'completed')
    assert.equal(state.audit.valid, true)
    assert.equal(state.activity.some((event) => event.kind === 'ceo.task.completed'), true)
  } finally {
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('long-running runtime refreshes specialist grants for later tasks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-grant-refresh-'))
  let clock = Date.parse('2026-09-01T12:00:00.000Z')
  const provider = createDeterministicModelRouter({
    routerId: 'openai-compatible:fixture:grant-refresh',
    responder: async (_prompt, context) => {
      if (context.stage === 'decompose') return {
        tasks: [{
          specialistAgentId: 'researcher',
          objective: 'Return a bounded result.',
          acceptanceCriteria: ['Return it.'],
        }],
      }
      if (context.stage === 'specialist') return { summary: 'Fresh specialist authority accepted.' }
      return { summary: 'Fresh task authority accepted.' }
    },
  })
  const modelRegistry = {
    state: () => ({
      schema: 'chimera.model-provider-registry.v2',
      selected: { providerId: 'fixture', providerName: 'Fixture', model: 'grant-refresh', modelName: 'Grant Refresh' },
      providers: [],
    }),
    router: () => provider,
    async select() {},
  }
  const runtime = new ChimeraBrowserRuntime({
    profileDir: join(directory, 'profiles/ceo'),
    modelRegistry,
    browserExecutor: memoryBrowserExecutor(),
    now: () => clock,
  })
  try {
    await runtime.start()
    const first = await runtime.submitTask({ objective: 'Run the first bounded task.' })
    assert.equal((await runtime.waitForTask(first.taskId)).status, 'completed')

    clock += 9 * 60 * 60_000
    const later = await runtime.submitTask({ objective: 'Run another task after the original grant lifetime.' })
    const completed = await runtime.waitForTask(later.taskId)

    assert.equal(completed.status, 'completed')
    assert.equal(completed.failure, undefined)
  } finally {
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('RJ conversation persists the human message before work and links the durable reply to its task', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-conversation-'))
  let releasePlan
  const planGate = new Promise((resolve) => { releasePlan = resolve })
  const provider = createDeterministicModelRouter({
    routerId: 'openai-compatible:fixture:rj-loop',
    responder: async (_prompt, context) => {
      if (context.stage === 'decompose') {
        await planGate
        return {
          tasks: [{
            specialistAgentId: 'researcher',
            objective: 'Prepare the linked result.',
            acceptanceCriteria: ['Return it.'],
          }],
        }
      }
      if (context.stage === 'specialist') return { summary: 'Linked specialist result.' }
      return { summary: 'RJ completed the linked conversation task.' }
    },
  })
  const modelRegistry = {
    state: () => ({
      schema: 'chimera.model-provider-registry.v2',
      selected: { providerId: 'fixture', providerName: 'Fixture', model: 'rj-loop', modelName: 'RJ Loop' },
      providers: [],
    }),
    router: () => provider,
    async select() {},
  }
  const runtime = new ChimeraBrowserRuntime({
    profileDir: join(directory, 'profiles/ceo'),
    decisionFile: join(directory, 'decisions.jsonl'),
    taskFile: join(directory, 'tasks.jsonl'),
    conversationFile: join(directory, 'conversations.jsonl'),
    modelCallFile: join(directory, 'model-calls.jsonl'),
    modelRegistry,
    browserExecutor: memoryBrowserExecutor(),
  })
  try {
    await runtime.start()
    const sent = await runtime.sendMessage({ content: 'RJ, run the linked task.' })
    assert.equal(sent.message.role, 'human')
    assert.equal(sent.task.status, 'queued')
    const workingState = await runtime.state()
    assert.equal(workingState.conversations.messages.length, 1)
    assert.equal(workingState.conversations.messages[0].taskId, sent.task.taskId)

    releasePlan()
    const completed = await runtime.waitForTask(sent.task.taskId)
    assert.equal(completed.status, 'completed')
    const messages = (await runtime.state()).conversations.messages.filter((message) => message.conversationId === 'main')
    assert.deepEqual(messages.map((message) => message.role), ['human', 'rj'])
    assert.equal(messages[1].replyTo, messages[0].messageId)
    assert.equal(messages[1].taskId, sent.task.taskId)
    assert.equal(messages[1].content, completed.summary)
    assert.equal(messages[1].status, 'completed')
  } finally {
    releasePlan()
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('specialist-addressed chat is constrained by RJ and publishes signed agent messages to its task room', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-team-chat-'))
  const contexts = []
  const provider = createDeterministicModelRouter({
    routerId: 'openai-compatible:fixture:team-chat',
    responder: async (_prompt, context) => {
      contexts.push(context)
      if (context.stage === 'decompose') return {
        tasks: [{
          specialistAgentId: 'researcher',
          objective: 'Answer Rod through RJ.',
          acceptanceCriteria: ['Return a concise answer.'],
        }],
      }
      if (context.stage === 'specialist') return { summary: 'Researcher answered Rod.' }
      return { summary: 'RJ verified the specialist answer.' }
    },
  })
  const modelRegistry = {
    state: () => ({
      schema: 'chimera.model-provider-registry.v2',
      selected: { providerId: 'fixture', providerName: 'Fixture', model: 'team-chat', modelName: 'Team Chat' },
      providers: [],
    }),
    router: () => provider,
    async select() {},
  }
  const runtime = new ChimeraBrowserRuntime({
    profileDir: join(directory, 'profiles/ceo'),
    decisionFile: join(directory, 'decisions.jsonl'),
    taskFile: join(directory, 'tasks.jsonl'),
    conversationFile: join(directory, 'conversations.jsonl'),
    modelCallFile: join(directory, 'model-calls.jsonl'),
    modelRegistry,
    browserExecutor: memoryBrowserExecutor(),
  })
  try {
    await runtime.start()
    const sent = await runtime.sendMessage({ content: 'Researcher, check this.', recipientAgentId: 'researcher' })
    assert.equal(sent.message.conversationId, 'agent:researcher')
    assert.deepEqual(sent.message.recipientAgentIds, ['researcher'])
    await runtime.waitForTask(sent.task.taskId)

    const state = await runtime.state()
    assert.equal(contexts.find((context) => context.stage === 'decompose').requestedSpecialistAgentId, 'researcher')
    const room = state.conversations.messages.filter((message) => message.conversationId === `task:${sent.task.taskId}`)
    assert.deepEqual(room.map((message) => message.kind), ['task_handoff', 'structured_result'])
    assert.deepEqual(room.map((message) => message.senderAgentId), ['ceo', 'researcher'])
    assert.deepEqual(room.map((message) => message.provenance.verification), ['verified', 'verified'])
    assert.equal(room.every((message) => /^[0-9a-f]{64}$/.test(message.provenance.envelopeHash)), true)
    assert.equal(state.conversations.channels.some((channel) => channel.conversationId === 'agent:researcher'), true)
    assert.equal(state.conversations.channels.some((channel) => channel.conversationId === `task:${sent.task.taskId}`), true)
  } finally {
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('browser runtime atomically rejects a concurrent second task and accepts a later task', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-admission-'))
  let releasePlan
  const planGate = new Promise((resolve) => { releasePlan = resolve })
  const calls = []
  const provider = createDeterministicModelRouter({
    routerId: 'openai-compatible:fixture:admission-model',
    responder: async (_prompt, context) => {
      calls.push(structuredClone(context))
      if (context.stage === 'decompose') {
        if (calls.filter((call) => call.stage === 'decompose').length === 1) await planGate
        return {
          tasks: [{
            specialistAgentId: 'researcher',
            objective: 'Complete one admitted task.',
            acceptanceCriteria: ['Return a result.'],
          }],
        }
      }
      if (context.stage === 'specialist') return { summary: 'Specialist complete.' }
      return { summary: 'CEO complete.' }
    },
  })
  const modelRegistry = {
    state: () => ({
      schema: 'chimera.model-provider-registry.v1',
      selected: {
        providerId: 'fixture',
        providerName: 'Fixture',
        model: 'admission-model',
        modelName: 'Admission Model',
      },
      providers: [],
    }),
    router: () => provider,
    async select() {},
  }
  const runtime = new ChimeraBrowserRuntime({
    profileDir: join(directory, 'profiles/ceo'),
    decisionFile: join(directory, 'decisions.jsonl'),
    taskFile: join(directory, 'tasks.jsonl'),
    modelCallFile: join(directory, 'model-calls.jsonl'),
    modelRegistry,
    browserExecutor: memoryBrowserExecutor(),
  })
  try {
    await runtime.start()
    const settlements = await Promise.allSettled([
      runtime.submitTask({ objective: 'First concurrent runtime task.' }),
      runtime.submitTask({ objective: 'Second concurrent runtime task.' }),
    ])
    const accepted = settlements.find((settlement) => settlement.status === 'fulfilled')
    const denied = settlements.find((settlement) => settlement.status === 'rejected')
    assert.ok(accepted)
    assert.equal(denied?.reason?.code, 'TASK_ALREADY_RUNNING')
    assert.equal((await runtime.state()).tasks.filter((task) => ['queued', 'running'].includes(task.status)).length, 1)

    releasePlan()
    assert.equal((await runtime.waitForTask(accepted.value.taskId)).status, 'completed')
    const later = await runtime.submitTask({ objective: 'A later task after completion.' })
    assert.equal((await runtime.waitForTask(later.taskId)).status, 'completed')
    assert.equal(calls.filter((call) => call.stage === 'decompose').length, 2)
  } finally {
    releasePlan()
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('browser runtime authorizes an auto fabric that uses different routes for CEO and specialist', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-model-fabric-'))
  const audit = new MemoryAuditLog()
  const ceo = createDeterministicModelRouter({
    routerId: 'codex:gpt-5.6-sol',
    responder: async (_prompt, context) => context.stage === 'decompose'
      ? { tasks: [{ specialistAgentId: 'researcher', objective: 'Research evidence.', acceptanceCriteria: ['Return it.'] }] }
      : { summary: 'CEO combined the result.' },
  })
  const specialist = createDeterministicModelRouter({
    routerId: 'bedrock:us.anthropic.claude-haiku-4-5-20251001-v1:0',
    responder: async () => ({ summary: 'Specialist researched the evidence.' }),
  })
  const provider = createTaskAwareModelRouter({
    routes: [
      { id: 'codex', router: ceo, capabilities: ['orchestration', 'coding', 'reasoning'], costClass: 'subscription' },
      { id: 'bedrock-research', router: specialist, capabilities: ['research'], costClass: 'medium' },
    ],
    audit,
  })
  const modelRegistry = {
    state: () => ({
      schema: 'chimera.model-provider-registry.v2',
      selected: { providerId: 'chimera-auto', providerName: 'Chimera Auto', model: 'auto', modelName: 'Best model for task' },
      providers: [],
    }),
    router: () => provider,
    async select() {},
  }
  const runtime = new ChimeraBrowserRuntime({
    profileDir: join(directory, 'profiles/ceo'),
    decisionFile: join(directory, 'decisions.jsonl'),
    taskFile: join(directory, 'tasks.jsonl'),
    modelCallFile: join(directory, 'model-calls.jsonl'),
    modelRegistry,
    browserExecutor: memoryBrowserExecutor(),
  })
  try {
    await runtime.start()
    const submitted = await runtime.submitTask({ objective: 'Research a model-fabric question.' })
    const completed = await runtime.waitForTask(submitted.taskId)
    assert.equal(completed.status, 'completed')
    assert.deepEqual(audit.entries().map((entry) => entry.fact.routeId), ['codex', 'bedrock-research', 'codex'])
  } finally {
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('Preferred falls back to Auto before dispatch while Pinned fails closed on the same unavailable route', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-agent-model-fallback-'))
  const routerCalls = []
  const global = createDeterministicModelRouter({
    routerId: 'openai-compatible:fixture:auto-route',
    responder: async (_prompt, context) => context.stage === 'decompose'
      ? { tasks: [{ specialistAgentId: 'researcher', objective: 'Use Auto safely.', acceptanceCriteria: ['Return it.'] }] }
      : { summary: context.stage === 'specialist' ? 'Auto specialist completed.' : 'Auto fallback completed.' },
  })
  const modelRegistry = {
    state: () => ({
      schema: 'chimera.model-provider-registry.v2',
      selected: { providerId: 'chimera-auto', providerName: 'Chimera Auto', model: 'auto', modelName: 'Best model for task' },
      providers: [{
        id: 'fixture',
        name: 'Fixture',
        configured: true,
        models: [{ id: 'sometimes-offline', name: 'Sometimes Offline', availability: 'verified-route', capabilities: ['conversation'] }],
      }],
    }),
    router: () => global,
    async routerFor(preference) {
      routerCalls.push(structuredClone(preference))
      throw Object.assign(new Error('MODEL_TEMPORARILY_UNAVAILABLE'), { code: 'MODEL_TEMPORARILY_UNAVAILABLE' })
    },
    async select() {},
  }
  const runtime = new ChimeraBrowserRuntime({
    profileDir: join(directory, 'profiles/ceo'),
    decisionFile: join(directory, 'decisions.jsonl'),
    taskFile: join(directory, 'tasks.jsonl'),
    modelCallFile: join(directory, 'model-calls.jsonl'),
    agentModelFile: join(directory, 'agent-models.json'),
    modelRegistry,
    browserExecutor: memoryBrowserExecutor(),
  })
  try {
    await runtime.start()
    await runtime.tasks.submit({ taskId: 'task-held-before-dispatch', objective: 'Hold admission open.', model: null })
    await assert.rejects(
      runtime.setAgentModel('ceo', { mode: 'preferred', providerId: 'fixture', model: 'sometimes-offline' }),
      (error) => error?.code === 'AGENT_MODEL_CHANGE_DURING_TASK',
    )
    await assert.rejects(
      runtime.setAgentAccess('researcher', 'live'),
      (error) => error?.code === 'AGENT_ACCESS_CHANGE_DURING_TASK',
    )
    await runtime.tasks.fail('task-held-before-dispatch', { code: 'TEST_RELEASE', message: 'Release the admission test.' })
    await runtime.setAgentModel('ceo', { mode: 'preferred', providerId: 'fixture', model: 'sometimes-offline' })
    const preferred = await runtime.submitTask({ objective: 'Use a safe fallback.' })
    assert.equal((await runtime.waitForTask(preferred.taskId)).status, 'completed')
    assert.equal(runtime.audit.entries().some((entry) => entry.fact.kind === 'agent.model.fallback'), true)

    await runtime.setAgentModel('ceo', { mode: 'pinned', providerId: 'fixture', model: 'sometimes-offline' })
    const pinned = await runtime.submitTask({ objective: 'Do not silently change this route.' })
    const failed = await runtime.waitForTask(pinned.taskId)
    assert.equal(failed.status, 'failed')
    assert.equal(failed.failure.code, 'MODEL_TEMPORARILY_UNAVAILABLE')
    assert.deepEqual(routerCalls.map((call) => call.mode), ['preferred', 'pinned'])
  } finally {
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('browser runtime starts ChatGPT login and reloads model routes after Codex connects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-codex-auth-'))
  let authState = {
    provider: 'codex',
    available: true,
    connected: false,
    status: 'disconnected',
  }
  let authClosed = false
  const codexAuth = {
    state: () => structuredClone(authState),
    async read() { return structuredClone(authState) },
    async startLogin() {
      authState = {
        ...authState,
        status: 'connecting',
        login: { loginId: 'login-1', status: 'pending' },
      }
      return {
        loginId: 'login-1',
        authUrl: 'https://chatgpt.com/auth/login',
        callbackUrl: 'http://localhost:1455/auth/callback',
      }
    },
    async close() { authClosed = true },
  }
  const opened = []
  const modelRegistryFactory = async ({ codexStatus }) => {
    opened.push(structuredClone(codexStatus))
    const configured = codexStatus?.configured === true
    return {
      state: () => ({
        schema: 'chimera.model-provider-registry.v2',
        selected: configured
          ? { providerId: 'chimera-auto', providerName: 'Chimera Auto', model: 'auto', modelName: 'Best model for task' }
          : null,
        providers: [{ id: 'codex', configured, models: [] }],
      }),
      router() {
        if (!configured) throw Object.assign(new Error('NO_MODEL_PROVIDER_CONFIGURED'), { code: 'NO_MODEL_PROVIDER_CONFIGURED' })
        return createDeterministicModelRouter({ routerId: 'codex:gpt-5.6-sol', responder: async () => ({ summary: 'ready' }) })
      },
      async select() {},
    }
  }
  const allowedCallbacks = []
  const runtime = new ChimeraBrowserRuntime({
    profileDir: join(directory, 'profiles/ceo'),
    decisionFile: join(directory, 'decisions.jsonl'),
    taskFile: join(directory, 'tasks.jsonl'),
    modelCallFile: join(directory, 'model-calls.jsonl'),
    modelRegistryFactory,
    codexAuth,
    browserExecutor: memoryBrowserExecutor({ allowedCallbacks }),
  })
  try {
    await runtime.start()
    assert.equal((await runtime.state()).auth.codex.status, 'disconnected')
    assert.deepEqual(await runtime.startCodexLogin(), {
      loginId: 'login-1',
      authUrl: 'https://chatgpt.com/auth/login',
    })
    assert.deepEqual(allowedCallbacks, ['http://localhost:1455/auth/callback'])
    assert.equal((await runtime.state()).auth.codex.status, 'connecting')

    authState = {
      provider: 'codex',
      available: true,
      connected: true,
      status: 'connected',
      authentication: 'chatgpt-subscription',
      planType: 'plus',
      login: { loginId: 'login-1', status: 'succeeded' },
    }
    await runtime.refreshCodexAuth()

    const state = await runtime.state()
    assert.equal(state.auth.codex.connected, true)
    assert.equal(state.models.providers[0].configured, true)
    assert.deepEqual(opened, [
      { configured: false, authentication: null },
      { configured: true, authentication: 'chatgpt-subscription' },
    ])
  } finally {
    await runtime.close()
    assert.equal(authClosed, true)
    await rm(directory, { recursive: true, force: true })
  }
})

test('browser runtime forwards media generation and status without exposing provider internals', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-media-'))
  const calls = []
  const modelRegistry = {
    state: () => ({ schema: 'chimera.model-provider-registry.v2', selected: null, providers: [] }),
    router() { throw new Error('task router is not used') },
    async select() {},
    async generateMedia(input) {
      calls.push(['generate', structuredClone(input)])
      return { kind: 'video', status: 'in-progress', modelId: input.model, jobId: 'video-1' }
    },
    async mediaStatus(input) {
      calls.push(['status', structuredClone(input)])
      return { kind: 'video', status: 'completed', modelId: 'luma.ray-v2:0', jobId: input.jobId, artifactUrl: 'https://signed.example/output.mp4' }
    },
  }
  const runtime = new ChimeraBrowserRuntime({
    profileDir: join(directory, 'profiles/ceo'),
    decisionFile: join(directory, 'decisions.jsonl'),
    taskFile: join(directory, 'tasks.jsonl'),
    modelCallFile: join(directory, 'model-calls.jsonl'),
    modelRegistry,
    browserExecutor: memoryBrowserExecutor(),
  })
  try {
    await runtime.start()
    assert.equal((await runtime.generateMedia({ model: 'luma.ray-v2:0', prompt: 'An orbital shot.' })).jobId, 'video-1')
    assert.equal((await runtime.mediaStatus({ jobId: 'video-1' })).status, 'completed')
    assert.deepEqual(calls.slice(0, 2), [
      ['generate', { model: 'luma.ray-v2:0', prompt: 'An orbital shot.' }],
      ['status', { jobId: 'video-1' }],
    ])
    const authorization = runtime.audit.entries().map((entry) => entry.fact)
      .find((fact) => fact.kind === 'media.call.authorized')
    assert.equal(authorization.resource, 'model:model-fabric:media:luma.ray-v2:0')
    assert.equal(JSON.stringify(authorization).includes('An orbital shot.'), false)

    for (let index = 0; index < 11; index += 1) {
      await runtime.generateMedia({ model: 'luma.ray-v2:0', prompt: `Bounded shot ${index}.` })
    }
    await assert.rejects(
      runtime.generateMedia({ model: 'luma.ray-v2:0', prompt: 'One request too many.' }),
      (error) => error.code === 'MEDIA_RATE_LIMITED',
    )
    assert.equal(calls.filter(([kind]) => kind === 'generate').length, 12)
  } finally {
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('browser runtime limits media generation to two concurrent provider calls', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-media-concurrency-'))
  const releases = []
  const modelRegistry = {
    state: () => ({ schema: 'chimera.model-provider-registry.v2', selected: null, providers: [] }),
    router() { throw new Error('task router is not used') },
    async select() {},
    async generateMedia(input) {
      await new Promise((resolve) => releases.push(resolve))
      return { kind: 'image', status: 'completed', modelId: input.model, mimeType: 'image/png', base64: 'aW1hZ2U=' }
    },
    async mediaStatus() { throw new Error('status is not used') },
  }
  const runtime = new ChimeraBrowserRuntime({
    profileDir: join(directory, 'profiles/ceo'),
    decisionFile: join(directory, 'decisions.jsonl'),
    taskFile: join(directory, 'tasks.jsonl'),
    modelCallFile: join(directory, 'model-calls.jsonl'),
    modelRegistry,
    browserExecutor: memoryBrowserExecutor(),
  })
  try {
    await runtime.start()
    const first = runtime.generateMedia({ model: 'stability.stable-image-ultra-v1:1', prompt: 'First image.' })
    const second = runtime.generateMedia({ model: 'stability.stable-image-ultra-v1:1', prompt: 'Second image.' })
    await assert.rejects(
      runtime.generateMedia({ model: 'stability.stable-image-ultra-v1:1', prompt: 'Third image.' }),
      (error) => error.code === 'MEDIA_CONCURRENCY_LIMITED',
    )
    releases.splice(0).forEach((release) => release())
    await Promise.all([first, second])
  } finally {
    releases.splice(0).forEach((release) => release())
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
})
