import assert from 'node:assert/strict'
import { chmod, lstat, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoryAuditLog } from '../src/audit-log.mjs'
import { ChimeraBrowserRuntime } from '../src/browser/runtime.mjs'
import { LocalModelFabricRegistry } from '../src/ceo/local-model-fabric.mjs'
import { createDeterministicModelRouter } from '../src/ceo/model-router.mjs'
import { createTaskAwareModelRouter } from '../src/ceo/task-aware-model-router.mjs'
import { agentManifestFromHermesCandidate } from '../src/agents/registry.mjs'

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

async function makeWritable(path) {
  try {
    const info = await lstat(path)
    if (info.isDirectory()) {
      await chmod(path, 0o700)
      for (const entry of await readdir(path)) await makeWritable(join(path, entry))
    } else await chmod(path, 0o600)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
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

test('durable selected specialist binding survives immediate and root-queue starts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-selected-specialist-'))
  const contexts = []
  const provider = createDeterministicModelRouter({
    routerId: 'openai-compatible:fixture:selected-specialist',
    responder: async (_prompt, context) => {
      contexts.push(structuredClone(context))
      if (context.stage === 'decompose') return {
        tasks: [{ specialistAgentId: 'researcher', objective: 'Use only the selected specialist.', acceptanceCriteria: ['Return evidence.'] }],
      }
      if (context.stage === 'specialist') return { summary: 'Selected specialist completed.' }
      return { summary: 'RJ completed the selected specialist task.' }
    },
  })
  const modelRegistry = {
    state: () => ({ schema: 'chimera.model-provider-registry.v2', selected: { providerId: 'fixture', providerName: 'Fixture', model: 'selected-specialist', modelName: 'Selected Specialist' }, providers: [] }),
    router: () => provider,
    async select() {},
  }
  const runtime = new ChimeraBrowserRuntime({
    profileDir: join(directory, 'profiles/ceo'), decisionFile: join(directory, 'decisions.jsonl'), taskFile: join(directory, 'tasks.jsonl'),
    conversationFile: join(directory, 'conversations.jsonl'), modelCallFile: join(directory, 'model-calls.jsonl'), modelRegistry,
    browserExecutor: memoryBrowserExecutor(),
  })
  try {
    await runtime.start()
    const immediate = await runtime.submitTask({ objective: 'Immediate selected specialist.', requestedSpecialistAgentId: 'researcher' })
    assert.equal((await runtime.waitForTask(immediate.taskId)).status, 'completed')
    const queued = await runtime.submitTask({ objective: 'Queued selected specialist.', requestedSpecialistAgentId: 'researcher', queue: true })
    assert.equal((await runtime.waitForTask(queued.taskId)).status, 'completed')
    const decompositions = contexts.filter(context => context.stage === 'decompose')
    assert.equal(decompositions.length, 2)
    assert.deepEqual(decompositions.map(context => context.requestedSpecialistAgentId), ['researcher', 'researcher'])
    assert.equal(runtime.conversationHistory({ conversationId: `task:${immediate.taskId}` }).messages.some(message => message.senderAgentId === 'researcher'), true)
    assert.equal(runtime.conversationHistory({ conversationId: `task:${queued.taskId}` }).messages.some(message => message.senderAgentId === 'researcher'), true)
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

test('runtime replays exact concurrent admissions before active checks and drains an explicit root queue', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-exact-admission-'))
  let releaseFirst
  const firstGate = new Promise((resolve) => { releaseFirst = resolve })
  let decompositionCount = 0
  const provider = createDeterministicModelRouter({
    routerId: 'openai-compatible:fixture:exact-admission',
    responder: async (_prompt, context) => {
      if (context.stage === 'decompose') {
        decompositionCount += 1
        if (decompositionCount === 1) await firstGate
        return {
          tasks: [{
            specialistAgentId: 'researcher',
            objective: 'Complete the exact admission fixture.',
            acceptanceCriteria: ['Return a result.'],
          }],
        }
      }
      if (context.stage === 'specialist') return { summary: 'Exact-admission specialist complete.' }
      return { summary: 'Exact-admission CEO complete.' }
    },
  })
  const modelRegistry = {
    state: () => ({
      schema: 'chimera.model-provider-registry.v1',
      selected: { providerId: 'fixture', providerName: 'Fixture', model: 'exact-admission', modelName: 'Exact Admission' },
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
    const requestId = 'exact-concurrent-root'
    const [first, replay] = await Promise.all([
      runtime.submitTask({ objective: 'Run this exact request once.', requestId }),
      runtime.submitTask({ objective: 'Run this exact request once.', requestId }),
    ])
    assert.equal(first.taskId, replay.taskId)
    assert.equal(replay.replayed, true)
    assert.equal(replay.receipt.requestId, requestId)
    assert.equal(runtime.tasks.listAdmissions().filter(entry => entry.requestId === requestId).length, 1)

    const queued = await runtime.submitTask({
      objective: 'Queue this root task explicitly while the first task runs.',
      queue: true,
      requestId: 'explicit-root-queue',
    })
    assert.equal(queued.status, 'queued')
    assert.equal(queued.queuedForExecution, true)
    assert.equal(queued.context.queueScope, 'root')
    assert.equal(runtime.tasks.active().filter(task => task.taskId === queued.taskId).length, 1)

    await assert.rejects(
      runtime.submitTask({ objective: 'A conflicting reuse must not dispatch.', requestId }),
      { code: 'TASK_ADMISSION_CONFLICT' },
    )

    releaseFirst()
    assert.equal((await runtime.waitForTask(first.taskId)).status, 'completed')
    assert.equal((await runtime.waitForTask(queued.taskId)).status, 'completed')
    assert.equal(decompositionCount, 2)
  } finally {
    releaseFirst()
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('reopens and replays legacy omitted-requirements admissions for all task producers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-upgrade-replay-'))
  let providerCalls = 0
  const provider = createDeterministicModelRouter({
    routerId: 'openai-compatible:fixture:upgrade-replay',
    responder: async (_prompt, context) => {
      providerCalls += 1
      if (context.stage === 'decompose') return {
        tasks: [{ specialistAgentId: 'researcher', objective: 'Return the bounded compatibility result.', acceptanceCriteria: ['Return it.'] }],
      }
      if (context.stage === 'specialist') return { summary: 'Compatibility specialist completed.' }
      return { summary: 'Compatibility replay task completed.' }
    },
  })
  const modelRegistry = {
    state: () => ({ schema: 'chimera.model-provider-registry.v2', selected: { providerId: 'fixture', providerName: 'Fixture', model: 'upgrade-replay', modelName: 'Upgrade Replay' }, providers: [] }),
    router: () => provider,
    async select() {},
  }
  const runtimeOptions = {
    profileDir: join(directory, 'profiles/ceo'),
    decisionFile: join(directory, 'decisions.jsonl'),
    taskFile: join(directory, 'tasks.jsonl'),
    conversationFile: join(directory, 'conversations.jsonl'),
    modelCallFile: join(directory, 'model-calls.jsonl'),
    projectFile: join(directory, 'projects.json'),
    modelRegistry,
    browserExecutor: memoryBrowserExecutor(),
  }
  let firstTask
  let project
  let projectTask
  let continuationRevision
  try {
    const first = new ChimeraBrowserRuntime(runtimeOptions)
    await first.start()
    const newTask = await first.submitTask({ requestId: 'legacy-new-task', objective: 'Replay the legacy new task.' })
    await first.waitForTask(newTask.taskId)
    const sent = await first.sendMessage({ requestId: 'legacy-send-message', content: 'Replay the legacy team message.' })
    await first.waitForTask(sent.task.taskId)
    project = await first.registerProject({ mode: 'managed', name: 'Legacy replay project' })
    projectTask = await first.submitProjectTask({ requestId: 'legacy-project-task', projectId: project.projectId, objective: 'Replay the legacy project task.', access: { profileId: 'sandbox', networkHosts: [] } })
    await first.waitForTask(projectTask.taskId)
    firstTask = first.tasks.get(newTask.taskId)
    continuationRevision = firstTask.destinationRevision
    const continuation = await first.continueTask({ requestId: 'legacy-continuation', taskId: newTask.taskId, objective: 'Replay the legacy continuation.', expectedDestinationRevision: continuationRevision })
    await first.waitForTask(continuation.taskId)
    await first.close()

    const callsBeforeReplay = providerCalls
    const reopened = new ChimeraBrowserRuntime(runtimeOptions)
    await reopened.start()
    const replayedNewTask = await reopened.submitTask({ requestId: 'legacy-new-task', objective: 'Replay the legacy new task.' })
    const replayedMessage = await reopened.sendMessage({ requestId: 'legacy-send-message', content: 'Replay the legacy team message.' })
    const replayedProject = await reopened.submitProjectTask({ requestId: 'legacy-project-task', projectId: project.projectId, objective: 'Replay the legacy project task.', access: { profileId: 'sandbox', networkHosts: [] } })
    const replayedContinuation = await reopened.continueTask({ requestId: 'legacy-continuation', taskId: firstTask.taskId, objective: 'Replay the legacy continuation.', expectedDestinationRevision: continuationRevision })
    assert.equal(replayedNewTask.replayed, true)
    assert.equal(replayedMessage.replayed, true)
    assert.equal(replayedProject.replayed, true)
    assert.equal(replayedContinuation.replayed, true)
    assert.equal(providerCalls, callsBeforeReplay, 'exact legacy replays must not dispatch a provider call')
    await reopened.close()
  } finally {
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
      { id: 'codex', router: ceo, providerId: 'codex', model: 'gpt-5.6-sol', capabilities: ['orchestration', 'coding', 'reasoning'], costClass: 'subscription', authority: {
        connectionEnabled: true, agentAllowed: true, executorAllowed: true, requirementsSatisfied: true, pinSatisfied: true, reasons: [],
      } },
      { id: 'bedrock-research', router: specialist, providerId: 'aws-bedrock', model: 'research-1', capabilities: ['research'], costClass: 'medium', authority: {
        connectionEnabled: true, agentAllowed: true, executorAllowed: true, requirementsSatisfied: true, pinSatisfied: true, reasons: [],
      } },
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
    const projected = (await runtime.state()).tasks.find((task) => task.taskId === submitted.taskId)
    assert.equal(projected.routing.schema, 'chimera.routing-explanation.v1')
    assert.equal(projected.routing.selected.agentId, 'ceo')
    assert.equal(projected.routing.selected.model, 'gpt-5.6-sol')
    assert.equal(projected.routing.selected.executor, 'inference-only')
    assert.equal(projected.routing.candidates.some((candidate) => candidate.status === 'rejected'), true)
  } finally {
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('runtime forwards agent scope through the real local fabric so differing pins select the right task route', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-real-fabric-scope-'))
  const audit = new MemoryAuditLog()
  const eligibilityScopes = []
  const modelRegistryFactory = async ({ audit: registryAudit, workingDirectory, now, routeGuard, eligibility, evidence }) => LocalModelFabricRegistry.open({
    config: {
      schema: 'chimera.model-routing.v1',
      region: 'us-west-2',
      codex: { model: 'fixture-ceo', reasoningEffort: 'high' },
      bedrockRoutes: [],
      openAiCompatibleProviders: [{
        id: 'fixture-cloud',
        name: 'Fixture Cloud',
        baseUrl: 'http://127.0.0.1:18000/v1',
        apiKeyEnv: 'FIXTURE_CLOUD_KEY',
        models: [
          { id: 'fixture-ceo-model', name: 'Fixture CEO', capabilities: ['conversation', 'orchestration', 'coding', 'reasoning'] },
          { id: 'fixture-research-model', name: 'Fixture Research', capabilities: ['conversation', 'research'] },
          { id: 'fixture-global-model', name: 'Fixture Global', capabilities: ['conversation', 'orchestration', 'research'] },
        ],
      }],
    },
    audit: registryAudit,
    workingDirectory,
    now,
    routeGuard,
    evidence,
    eligibility: (route, input) => {
      eligibilityScopes.push({ routeId: route.id, scope: input.scope })
      return eligibility(route, input)
    },
    codexStatus: { configured: false, authentication: null },
    bedrockModels: [],
    bedrockProfiles: [],
    env: { FIXTURE_CLOUD_KEY: 'local-fixture-key' },
    openAiCompatibleFetch: async (_url, init) => {
      const body = JSON.parse(init.body)
      const userPrompt = body.messages?.find(message => message.role === 'user')?.content ?? ''
      const stage = userPrompt.includes('"stage":"decompose"') ? 'decompose'
        : userPrompt.includes('"stage":"specialist"') ? 'specialist' : 'synthesize'
      const response = stage === 'decompose'
        ? { tasks: [{ specialistAgentId: 'researcher', objective: 'Research with the specialist pin.', acceptanceCriteria: ['Return the fixture result.'] }] }
        : stage === 'specialist'
          ? { summary: 'Specialist used its pinned research route.' }
          : { summary: 'RJ synthesized the pinned research result.' }
      return { ok: true, status: 200, async text() { return JSON.stringify({ choices: [{ message: { content: JSON.stringify(response) } }] }) } }
    },
  })
  const runtime = new ChimeraBrowserRuntime({
    profileDir: join(directory, 'profiles/ceo'),
    decisionFile: join(directory, 'decisions.jsonl'),
    taskFile: join(directory, 'tasks.jsonl'),
    modelCallFile: join(directory, 'model-calls.jsonl'),
    agentModelFile: join(directory, 'agent-models.json'),
    modelRegistryFactory,
    audit,
    browserExecutor: memoryBrowserExecutor(),
  })
  try {
    await runtime.start()
    await runtime.selectModel({ providerId: 'fixture-cloud', model: 'fixture-global-model' })
    const globalSubmitted = await runtime.submitTask({ objective: 'Use the operator selected model.' })
    const globalCompleted = await runtime.waitForTask(globalSubmitted.taskId)
    assert.equal(globalCompleted.status, 'completed')
    const taskPinned = await runtime.submitTask({
      objective: 'Use the task-specific model preference.',
      requirements: { modelPreference: { mode: 'pinned', providerId: 'fixture-cloud', model: 'fixture-research-model' } },
    })
    assert.equal((await runtime.waitForTask(taskPinned.taskId)).status, 'completed')
    await runtime.setAgentModel('ceo', { mode: 'pinned', providerId: 'fixture-cloud', model: 'fixture-ceo-model' })
    await runtime.setAgentModel('researcher', { mode: 'pinned', providerId: 'fixture-cloud', model: 'fixture-research-model' })
    const submitted = await runtime.submitTask({ objective: 'Research a model-fabric question.' })
    const completed = await runtime.waitForTask(submitted.taskId)
    assert.equal(completed.status, 'completed')
    assert.equal(completed.summary, 'RJ synthesized the pinned research result.')
    const selected = audit.entries().map(entry => entry.fact).filter(fact => fact.kind === 'model.route.selected')
    assert.deepEqual(selected.map(fact => fact.routeId), [
      'manual-fixture-cloud-fixture-global-model',
      'manual-fixture-cloud-fixture-global-model',
      'manual-fixture-cloud-fixture-global-model',
      'manual-fixture-cloud-fixture-research-model',
      'manual-fixture-cloud-fixture-research-model',
      'manual-fixture-cloud-fixture-research-model',
      'manual-fixture-cloud-fixture-ceo-model',
      'manual-fixture-cloud-fixture-research-model',
      'manual-fixture-cloud-fixture-ceo-model',
    ])
    assert.equal(eligibilityScopes.some(entry => entry.routeId === 'manual-fixture-cloud-fixture-ceo-model' && entry.scope?.agentId === 'ceo'), true)
    assert.equal(eligibilityScopes.some(entry => entry.routeId === 'manual-fixture-cloud-fixture-research-model' && entry.scope?.agentId === 'researcher'), true)

    const blocked = await runtime.submitTask({
      objective: 'Retain the explanation when strict pins conflict.',
      requirements: { modelPreference: { mode: 'pinned', providerId: 'fixture-cloud', model: 'fixture-research-model' } },
    })
    const blockedCompleted = await runtime.waitForTask(blocked.taskId)
    assert.equal(blockedCompleted.status, 'failed')
    assert.equal(blockedCompleted.failure.code, 'NO_ELIGIBLE_MODEL_ROUTE')
    const blockedProjection = (await runtime.state()).tasks.find((task) => task.taskId === blocked.taskId)
    assert.equal(blockedProjection.routing.selected, null)
    assert.equal(blockedProjection.routing.reasons.includes('NO_ELIGIBLE_MODEL_ROUTE'), true)
    assert.equal(blockedProjection.routing.candidates.some((candidate) => candidate.status === 'rejected'), true)
  } finally {
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('runtime proves required tools from the registered worker scope, not route metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-required-tools-'))
  const stages = []
  const scopes = []
  const modelRegistryFactory = async ({ audit: registryAudit, workingDirectory, now, routeGuard, eligibility, evidence }) => LocalModelFabricRegistry.open({
    config: {
      schema: 'chimera.model-routing.v1',
      region: 'us-west-2',
      codex: { model: 'fixture-ceo', reasoningEffort: 'high' },
      bedrockRoutes: [],
      openAiCompatibleProviders: [{
        id: 'fixture-cloud', name: 'Fixture Cloud', baseUrl: 'http://127.0.0.1:18000/v1', apiKeyEnv: 'FIXTURE_CLOUD_KEY',
        models: [{ id: 'fixture-tools', name: 'Fixture Tools', capabilities: ['conversation'] }],
      }],
    },
    audit: registryAudit,
    workingDirectory,
    now,
    routeGuard,
    evidence,
    eligibility: (route, input) => {
      if (input.scope?.agentId === 'ace') scopes.push(structuredClone(input.scope))
      return eligibility(route, input)
    },
    codexStatus: { configured: false, authentication: null },
    bedrockModels: [],
    bedrockProfiles: [],
    env: { FIXTURE_CLOUD_KEY: 'local-fixture-key' },
    openAiCompatibleFetch: async (_url, init) => {
      const body = JSON.parse(init.body)
      const prompt = body.messages?.find(message => message.role === 'user')?.content ?? ''
      const stage = prompt.includes('"stage":"decompose"') ? 'decompose'
        : prompt.includes('"stage":"specialist-loop"') ? 'specialist-loop' : 'synthesize'
      stages.push(stage)
      const response = stage === 'decompose'
        ? { tasks: [{ specialistAgentId: 'ace', objective: 'Read the bounded fixture.', acceptanceCriteria: ['Return the fixture result.'] }] }
        : stage === 'specialist-loop'
          ? { status: 'completed', summary: 'Ace completed with a runtime-authorized read scope.' }
          : { summary: 'RJ synthesized the scoped result.' }
      return { ok: true, status: 200, async text() { return JSON.stringify({ choices: [{ message: { content: JSON.stringify(response) } }] }) } }
    },
  })
  const runtime = new ChimeraBrowserRuntime({
    profileDir: join(directory, 'profiles/ceo'),
    decisionFile: join(directory, 'decisions.jsonl'),
    taskFile: join(directory, 'tasks.jsonl'),
    modelCallFile: join(directory, 'model-calls.jsonl'),
    agentModelFile: join(directory, 'agent-models.json'),
    modelRegistryFactory,
    agentReferenceProvider: {
      async materialize(_reference, { kind }) {
        if (kind === 'persona') return [{ path: 'SOUL.md', content: 'Fixture specialist.' }, { path: 'IDENTITY.md', content: 'Ace.' }]
        if (kind === 'memory') return [{ path: 'MEMORY.md', content: 'Fixture memory.' }]
        return [{ path: 'SKILL.md', content: 'Fixture skill.' }]
      },
    },
    workerToolExecutors: { read: async () => ({ content: 'fixture' }) },
    browserExecutor: memoryBrowserExecutor(),
  })
  try {
    await runtime.start()
    await runtime.agentRegistry.registerMany([agentManifestFromHermesCandidate({
      schema: 'chimera.hermes-agent-candidate.v1', candidateId: 'fixture:ace', profileId: 'ace', displayName: 'Ace', sourceRef: 'hermes://fixture/profiles/ace',
    })])
    await runtime.selectModel({ providerId: 'fixture-cloud', model: 'fixture-tools' })

    const allowed = await runtime.submitTask({ objective: 'Read the fixture with the installed tool.', requestedSpecialistAgentId: 'ace', requirements: { requiredTools: ['filesystem.read'] } })
    assert.equal((await runtime.waitForTask(allowed.taskId)).status, 'completed')
    assert.deepEqual(stages, ['decompose', 'specialist-loop', 'synthesize'])

    const denied = await runtime.submitTask({ objective: 'Use an unavailable tool.', requestedSpecialistAgentId: 'ace', requirements: { requiredTools: ['browser.account.read'] } })
    const deniedResult = await runtime.waitForTask(denied.taskId)
    assert.equal(deniedResult.status, 'completed', JSON.stringify({ scopes, denied: deniedResult }))
    assert.equal(deniedResult.result.results[0].reason, 'NO_ELIGIBLE_MODEL_ROUTE')
    assert.deepEqual(stages, ['decompose', 'specialist-loop', 'synthesize', 'decompose', 'synthesize'])
    assert.equal(scopes.some(scope => scope.agentId === 'ace' && scope.toolAuthority === 'runtime' && !scope.toolCapabilities.includes('browser.account.read')), true)
  } finally {
    await runtime.close()
    await makeWritable(directory)
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
    assert.deepEqual(routerCalls.map((call) => call.mode), ['preferred', 'auto', 'auto', 'pinned'])
  } finally {
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('Preferred preflights implicit stage requirements and trusted metadata uncertainty before dispatch', async () => {
  async function runCase({ name, requirements, preferredCapabilities, preferredContextCapacity }) {
    const directory = await mkdtemp(join(tmpdir(), `chimera-runtime-preferred-preflight-${name}-`))
    const preferredDispatches = []
    const fallbackDispatches = []
    const routerCalls = []
    const makeResponder = (dispatches, label) => async (_prompt, context) => {
      dispatches.push(context.stage)
      if (label === 'fallback' && context.stage === 'decompose') {
        return { tasks: [{ specialistAgentId: 'researcher', objective: 'Use the captured fallback.', acceptanceCriteria: ['Return it.'] }] }
      }
      return { summary: `${label} ${context.stage} completed.` }
    }
    const preferredProvider = createDeterministicModelRouter({
      routerId: 'openai-compatible:fixture:preferred-preflight',
      responder: makeResponder(preferredDispatches, 'preferred'),
    })
    const fallbackProvider = createDeterministicModelRouter({
      routerId: 'openai-compatible:fixture:captured-default',
      responder: makeResponder(fallbackDispatches, 'fallback'),
    })
    const trustedEligibility = () => ({
      connectionEnabled: true,
      agentAllowed: true,
      executorAllowed: true,
      requirementsSatisfied: true,
      pinSatisfied: true,
      reasons: [],
    })
    const preferredRouter = createTaskAwareModelRouter({
      routes: [{
        id: 'preferred-preflight', router: preferredProvider, providerId: 'fixture', model: 'preferred-preflight',
        capabilities: preferredCapabilities, costClass: 'medium',
        ...(preferredContextCapacity === undefined ? {} : { contextCapacityTokens: preferredContextCapacity }),
      }],
      eligibility: trustedEligibility,
    })
    const fallbackRouter = createTaskAwareModelRouter({
      routes: [{
        id: 'captured-default', router: fallbackProvider, providerId: 'fixture', model: 'captured-default',
        capabilities: ['orchestration', 'research'], costClass: 'medium', contextCapacityTokens: 100_000,
      }],
      eligibility: trustedEligibility,
    })
    const modelRegistry = {
      supportsTaskRoutingScope: true,
      state: () => ({
        schema: 'chimera.model-provider-registry.v2',
        selected: { providerId: 'fixture', providerName: 'Fixture', model: 'captured-default', modelName: 'Captured Default' },
        providers: [{
          id: 'fixture', name: 'Fixture', configured: true,
          models: [
            { id: 'preferred-preflight', name: 'Preferred Preflight', availability: 'verified-route', capabilities: ['conversation'] },
            { id: 'captured-default', name: 'Captured Default', availability: 'verified-route', capabilities: ['conversation'] },
          ],
        }],
      }),
      router: () => fallbackRouter,
      async routerFor(preference) {
        routerCalls.push(structuredClone(preference))
        return preference.mode === 'preferred' ? preferredRouter : fallbackRouter
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
      await runtime.setAgentModel('ceo', { mode: 'preferred', providerId: 'fixture', model: 'preferred-preflight' })
      const submitted = await runtime.submitTask({ objective: `Preflight ${name}.`, ...(requirements ? { requirements } : {}) })
      const completed = await runtime.waitForTask(submitted.taskId)
      assert.equal(completed.status, 'completed', JSON.stringify(completed))
      assert.deepEqual(preferredDispatches, [], `${name}: Preferred must not dispatch while preflighting`)
      assert.deepEqual(fallbackDispatches, ['decompose', 'specialist', 'synthesize'], `${name}: captured Auto route must execute all stages`)
      assert.deepEqual(routerCalls.slice(0, 2).map(call => call.mode), ['preferred', 'auto'], `${name}: fallback must be selected before dispatch`)
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  }

  await runCase({
    name: 'implicit-orchestration',
    preferredCapabilities: ['coding'],
  })
  await runCase({
    name: 'unknown-context-capacity',
    requirements: { minContextTokens: 8_192 },
    preferredCapabilities: ['orchestration'],
  })
})

test('Preferred specialist selection uses the actual objective and never retries an ambiguous dispatch', async () => {
  async function runCase({ ambiguous }) {
    const directory = await mkdtemp(join(tmpdir(), `chimera-runtime-preferred-specialist-${ambiguous ? 'ambiguous' : 'fallback'}-`))
    const audit = new MemoryAuditLog()
    const preferredDispatches = []
    const fallbackDispatches = []
    const routerCalls = []
    const preferredProvider = createDeterministicModelRouter({
      routerId: 'openai-compatible:fixture:preferred-specialist',
      responder: async (_prompt, context) => {
        preferredDispatches.push(context.stage)
        if (ambiguous) throw new Error('ambiguous provider failure')
        return { summary: `Preferred ${context.stage} completed.` }
      },
    })
    const fallbackProvider = createDeterministicModelRouter({
      routerId: 'openai-compatible:fixture:captured-specialist-fallback',
      responder: async (_prompt, context) => {
        fallbackDispatches.push(context.stage)
        if (context.stage === 'decompose') {
          return { tasks: [{ specialistAgentId: 'researcher', objective: 'Research the captured specialist fallback.', acceptanceCriteria: ['Return it.'] }] }
        }
        return { summary: `Captured fallback ${context.stage} completed.` }
      },
    })
    const trustedEligibility = () => ({
      connectionEnabled: true,
      agentAllowed: true,
      executorAllowed: true,
      requirementsSatisfied: true,
      pinSatisfied: true,
      reasons: [],
    })
    const preferredRouter = createTaskAwareModelRouter({
      audit,
      routes: [{
        id: 'preferred-specialist', router: preferredProvider, providerId: 'fixture', model: 'preferred-specialist',
        capabilities: ambiguous ? ['research'] : ['orchestration'], costClass: 'medium',
      }],
      eligibility: trustedEligibility,
    })
    const fallbackRouter = createTaskAwareModelRouter({
      audit,
      routes: [{
        id: 'captured-specialist-fallback', router: fallbackProvider, providerId: 'fixture', model: 'captured-specialist-fallback',
        capabilities: ['orchestration', 'research'], costClass: 'medium', contextCapacityTokens: 100_000,
      }],
      eligibility: trustedEligibility,
    })
    const modelRegistry = {
      supportsTaskRoutingScope: true,
      state: () => ({
        schema: 'chimera.model-provider-registry.v2',
        selected: { providerId: 'fixture', providerName: 'Fixture', model: 'captured-specialist-fallback', modelName: 'Captured Specialist Fallback' },
        providers: [{
          id: 'fixture', name: 'Fixture', configured: true,
          models: [
            { id: 'preferred-specialist', name: 'Preferred Specialist', availability: 'verified-route', capabilities: ['conversation'] },
            { id: 'captured-specialist-fallback', name: 'Captured Specialist Fallback', availability: 'verified-route', capabilities: ['conversation'] },
          ],
        }],
      }),
      router: () => fallbackRouter,
      async routerFor(preference) {
        routerCalls.push(structuredClone(preference))
        return preference.mode === 'preferred' ? preferredRouter : fallbackRouter
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
      audit,
      browserExecutor: memoryBrowserExecutor(),
    })
    try {
      await runtime.start()
      await runtime.setAgentModel('researcher', { mode: 'preferred', providerId: 'fixture', model: 'preferred-specialist' })
      const submitted = await runtime.submitTask({ objective: 'Research the specialist fallback behavior.' })
      const completed = await runtime.waitForTask(submitted.taskId)
      if (ambiguous) {
        assert.equal(completed.status, 'completed', JSON.stringify({ completed, preferredDispatches, fallbackDispatches, routerCalls }))
        assert.equal(preferredDispatches.length, 1)
        assert.deepEqual(fallbackDispatches, ['decompose', 'synthesize'])
        assert.equal(completed.result.results[0].reason, 'MODEL_CALL_OUTCOME_UNKNOWN')
      } else {
        assert.equal(completed.status, 'completed', JSON.stringify(completed))
        assert.deepEqual(preferredDispatches, [])
        assert.deepEqual(fallbackDispatches, ['decompose', 'specialist', 'synthesize'], JSON.stringify({ preferredDispatches, fallbackDispatches, routerCalls, task: completed }))
        const selected = audit.entries().map(entry => entry.fact).filter(fact => fact.kind === 'model.route.selected')
        assert.deepEqual(selected.map(fact => fact.routeId), [
          'captured-specialist-fallback', 'captured-specialist-fallback', 'captured-specialist-fallback',
        ])
        const projection = (await runtime.state()).tasks.find(task => task.taskId === submitted.taskId)
        assert.equal(projection.routing.selected.model, 'captured-specialist-fallback')
      }
      assert.deepEqual(routerCalls.map(call => call.mode), ['pinned', 'preferred', 'auto'])
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  }

  await runCase({ ambiguous: false })
  await runCase({ ambiguous: true })
})

test('Preferred unavailable captured fallback remains trusted not-sent before specialist dispatch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-preferred-fallback-unavailable-'))
  const audit = new MemoryAuditLog()
  const preferredDispatches = []
  const fallbackDispatches = []
  const routerCalls = []
  const preferredProvider = createDeterministicModelRouter({
    routerId: 'openai-compatible:fixture:preferred-unavailable-fallback',
    responder: async (_prompt, context) => {
      preferredDispatches.push(context.stage)
      return { summary: `Preferred ${context.stage} completed.` }
    },
  })
  const fallbackProvider = createDeterministicModelRouter({
    routerId: 'openai-compatible:fixture:fallback-unavailable-captured',
    responder: async (_prompt, context) => {
      fallbackDispatches.push(context.stage)
      if (context.stage === 'decompose') {
        return { tasks: [{ specialistAgentId: 'researcher', objective: 'Research with no available captured fallback.', acceptanceCriteria: ['Return it.'] }] }
      }
      return { summary: `Captured fallback ${context.stage} completed.` }
    },
  })
  const trustedEligibility = () => ({
    connectionEnabled: true,
    agentAllowed: true,
    executorAllowed: true,
    requirementsSatisfied: true,
    pinSatisfied: true,
    reasons: [],
  })
  const preferredRouter = createTaskAwareModelRouter({
    audit,
    routes: [{
      id: 'preferred-unavailable-fallback', router: preferredProvider, providerId: 'fixture', model: 'preferred-unavailable-fallback',
      capabilities: ['orchestration'], costClass: 'medium',
    }],
    eligibility: trustedEligibility,
  })
  const fallbackRouter = createTaskAwareModelRouter({
    audit,
    routes: [{
      id: 'fallback-unavailable-captured', router: fallbackProvider, providerId: 'fixture', model: 'fallback-unavailable-captured',
      capabilities: ['orchestration', 'research'], costClass: 'medium', contextCapacityTokens: 100_000,
    }],
    eligibility: trustedEligibility,
  })
  const modelRegistry = {
    supportsTaskRoutingScope: true,
    state: () => ({
      schema: 'chimera.model-provider-registry.v2',
      selected: { providerId: 'fixture', providerName: 'Fixture', model: 'fallback-unavailable-captured', modelName: 'Captured Fallback' },
      providers: [{
        id: 'fixture', name: 'Fixture', configured: true,
        models: [
          { id: 'preferred-unavailable-fallback', name: 'Preferred Unavailable Fallback', availability: 'verified-route', capabilities: ['conversation'] },
          { id: 'fallback-unavailable-captured', name: 'Captured Fallback', availability: 'verified-route', capabilities: ['conversation'] },
        ],
      }],
    }),
    router: () => fallbackRouter,
    async routerFor(preference, scope) {
      routerCalls.push({ preference: structuredClone(preference), scope: structuredClone(scope) })
      if (preference.mode === 'preferred') return preferredRouter
      if (scope?.agentId === 'researcher') {
        const failure = Object.assign(new Error('NO_AUTO_FALLBACK'), { code: 'NO_AUTO_FALLBACK' })
        failure.dispatchState = 'not_sent'
        throw failure
      }
      return fallbackRouter
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
    audit,
    browserExecutor: memoryBrowserExecutor(),
  })
  try {
    await runtime.start()
    await runtime.setAgentModel('researcher', { mode: 'preferred', providerId: 'fixture', model: 'preferred-unavailable-fallback' })
    const submitted = await runtime.submitTask({ objective: 'Research the unavailable captured fallback behavior.' })
    const completed = await runtime.waitForTask(submitted.taskId)
    assert.equal(completed.status, 'completed', JSON.stringify(completed))
    assert.deepEqual(preferredDispatches, [])
    assert.deepEqual(fallbackDispatches, ['decompose', 'synthesize'])
    assert.deepEqual(routerCalls.map(call => call.preference.mode), ['pinned', 'preferred', 'auto'])
    assert.equal(completed.result.results[0].reason, 'NO_AUTO_FALLBACK')
    const facts = audit.entries().map(entry => entry.fact)
    assert.equal(facts.some(fact => fact.kind === 'model.call.ambiguous'), false)
    assert.equal(facts.some(fact => fact.kind === 'model.call.not-sent' && fact.failure?.code === 'NO_AUTO_FALLBACK'), true)
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
