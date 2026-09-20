import assert from 'node:assert/strict'
import { chmod, lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoryAuditLog } from '../src/audit-log.mjs'
import { ChimeraBrowserRuntime } from '../src/browser/runtime.mjs'
import { NativeAgentReferenceProvider } from '../src/agents/native-reference-provider.mjs'
import { createDeterministicModelRouter } from '../src/ceo/model-router.mjs'
import { signAction } from '../src/identity.mjs'

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

test('the long-lived CEO browser grant cannot hand work to an arbitrary agent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-agent-scope-'))
  const modelRegistry = {
    state: () => ({ schema: 'chimera.model-provider-registry.v2', selected: null, providers: [] }),
    router: () => createDeterministicModelRouter({ responder: async () => ({ summary: 'unused' }) }),
    async select() {},
  }
  const runtime = new ChimeraBrowserRuntime({
    profileDir: join(directory, 'browser/ceo'),
    decisionFile: join(directory, 'decisions.jsonl'),
    taskFile: join(directory, 'tasks.jsonl'),
    modelCallFile: join(directory, 'model-calls.jsonl'),
    agentFile: join(directory, 'agents/registry.json'),
    agentDiscovery: { async discover() { return { schema: 'chimera.agent-discovery.v1', source: { id: 'hermes-aws', type: 'hermes-ssm', host: 'fixture-hermes' }, candidates: [] } } },
    modelRegistry,
    browserExecutor: memoryBrowserExecutor(),
  })
  try {
    await runtime.start()
    const action = signAction({
      actionId: 'unregistered-handoff',
      agentId: 'ceo',
      capability: 'agent.message.task_handoff',
      resource: 'agent:not-registered',
      operation: 'send',
      issuedAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }, runtime.agent)
    assert.equal(runtime.gateway.submit({ grant: runtime.grant, action }).reason, 'OUTSIDE_GRANT_SCOPE')
  } finally {
    await runtime.close()
    await removeTree(directory)
  }
})

test('runtime previews a Hermes profile, imports it durably, and delegates signed work to it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-agents-'))
  const calls = []
  const agentModelRoutes = []
  const provider = createDeterministicModelRouter({
    routerId: 'openai-compatible:fixture:agents',
    responder: async (_prompt, context) => {
      calls.push(structuredClone(context))
      if (context.stage === 'decompose') {
        return { tasks: [{ specialistAgentId: 'ace', objective: 'Review the code.', acceptanceCriteria: ['Return findings.'] }] }
      }
      if (context.stage === 'specialist-loop') return { status: 'completed', summary: 'Ace completed the review.' }
      return { summary: 'CEO accepted the review.' }
    },
  })
  const modelRegistry = {
    state: () => ({
      schema: 'chimera.model-provider-registry.v2',
      selected: { providerId: 'fixture', providerName: 'Fixture', model: 'agents', modelName: 'Agent Model' },
      providers: [{
        id: 'fixture',
        name: 'Fixture',
        configured: true,
        models: [{ id: 'agents', name: 'Agent Model', availability: 'authenticated', capabilities: ['conversation'] }],
      }],
    }),
    router: () => provider,
    async routerFor(preference) {
      agentModelRoutes.push(structuredClone(preference))
      return provider
    },
    async select() {},
  }
  const agentDiscovery = {
    async discover() {
      return {
        schema: 'chimera.agent-discovery.v1',
        source: { id: 'hermes-aws', type: 'hermes-ssm', host: 'configured-hermes' },
        candidates: [{
          schema: 'chimera.hermes-agent-candidate.v1',
          candidateId: 'hermes-aws:ace',
          profileId: 'ace',
          displayName: 'Ace',
          sourceRef: 'hermes://configured-hermes/profiles/ace',
          defaultRole: 'General specialist',
          defaultCapabilities: ['general'],
        }, {
          schema: 'chimera.hermes-agent-candidate.v1',
          candidateId: 'hermes-aws:rj',
          profileId: 'rj',
          displayName: 'RJ',
          sourceRef: 'hermes://configured-hermes/profiles/rj',
          defaultRole: 'Team CEO',
          defaultCapabilities: ['orchestration'],
        }],
      }
    },
  }
  const runtime = new ChimeraBrowserRuntime({
    profileDir: join(directory, 'browser/ceo'),
    decisionFile: join(directory, 'decisions.jsonl'),
    taskFile: join(directory, 'tasks.jsonl'),
    modelCallFile: join(directory, 'model-calls.jsonl'),
    agentFile: join(directory, 'agents/registry.json'),
    agentModelFile: join(directory, 'agents/models.json'),
    workerRoot: join(directory, 'agents/workspaces'),
    workerStateDir: join(directory, 'agents/workers'),
    mailboxFile: join(directory, 'agents/mailbox.jsonl'),
    agentReferenceProvider: {
      async materialize(_reference, { kind }) {
        if (kind === 'persona') return [
          { path: 'SOUL.md', content: 'Keep faith with Rod and lead the team with evidence.' },
          { path: 'IDENTITY.md', content: 'This profile is RJ.' },
        ]
        return kind === 'memory'
          ? [{ path: 'MEMORY.md', content: 'Remember the Team RSI operating model.' }]
          : [{ path: 'review/SKILL.md', content: 'Review safely.' }]
      },
    },
    agentDiscovery,
    modelRegistry,
    browserExecutor: memoryBrowserExecutor(),
  })
  try {
    await runtime.start()
    const preview = await runtime.discoverAgents()
    assert.equal(preview.candidates[0].profileId, 'ace')
    assert.ok(preview.candidates[0].exclusions.includes('credentials'))
    assert.equal(preview.candidates[0].dependencyStatus, 'unverified / not inspected')
    assert.equal(preview.candidates.find((candidate) => candidate.profileId === 'rj').reservedForMain, true)
    await assert.rejects(runtime.importAgents({
      discoveryId: preview.discoveryId,
      agents: [{ candidateId: 'hermes-aws:rj' }],
    }), /AGENT_RESERVED_FOR_MAIN_PERSONA/)
    const mainImport = await runtime.importMainAgent({
      discoveryId: preview.discoveryId,
      candidateId: 'hermes-aws:rj',
    })
    assert.equal(mainImport.agentId, 'ceo')
    assert.equal(mainImport.personaProfileId, 'rj')
    assert.equal(mainImport.continuity.report.persona.files, 2)

    const imported = await runtime.importAgents({
      discoveryId: preview.discoveryId,
      agents: [{
        candidateId: 'hermes-aws:ace',
        role: 'Engineering and security specialist',
        capabilities: ['coding', 'security-review'],
      }],
    })
    assert.equal(imported.imported[0].agentId, 'ace')

    const state = await runtime.state()
    assert.equal(state.agents.main.agentId, 'ceo')
    assert.equal(state.agents.main.displayName, 'RJ')
    assert.equal(state.agents.main.personaProfileId, 'rj')
    assert.equal(state.agents.main.role, 'CEO and main orchestrator')
    assert.equal(state.agents.main.status, 'Idle')
    assert.match(state.agents.main.continuity.digest, /^[a-f0-9]{64}$/)
    assert.equal(state.agents.main.continuity.report.skills.files, 1)
    assert.deepEqual(state.agents.accessProfiles.map(({ profileId, label }) => [profileId, label]), [
      ['sandbox', 'Sandbox'], ['connected', 'Connected sandbox'], ['live', 'Live workflow'],
    ])
    assert.equal(state.agents.specialists.some((agent) => agent.agentId === 'ace'), true)
    assert.equal(state.agents.specialists.find((agent) => agent.agentId === 'ace').source.ref, 'hermes://configured-hermes/profiles/ace')
    assert.equal(state.agents.specialists.find((agent) => agent.agentId === 'ace').harnessState, 'Registered')
    assert.equal(state.agents.specialists.find((agent) => agent.agentId === 'ace').ownedByTaskId, null)
    assert.equal(state.decisions.some((decision) => /telegram/i.test(`${decision.title ?? ''} ${decision.detail ?? ''}`)), false)
    assert.equal(state.agents.specialists.find((agent) => agent.agentId === 'ace').access.profileId, 'sandbox')
    assert.equal(state.agents.specialists.find((agent) => agent.agentId === 'researcher').access.profileId, 'sandbox')

    const pinnedModel = await runtime.setAgentModel('ace', {
      mode: 'pinned', providerId: 'fixture', model: 'agents',
    })
    assert.equal(pinnedModel.mode, 'pinned')
    assert.equal((await runtime.state()).agents.specialists.find((agent) => agent.agentId === 'ace').modelPreference.model, 'agents')

    const builtInConnected = await runtime.setAgentAccess('researcher', 'connected')
    assert.equal(builtInConnected.profileId, 'connected')
    assert.equal((await runtime.state()).agents.specialists.find((agent) => agent.agentId === 'researcher').access.profileId, 'connected')

    const connected = await runtime.setAgentAccess('ace', 'connected')
    assert.equal(connected.profileId, 'connected')
    assert.equal((await runtime.state()).agents.specialists.find((agent) => agent.agentId === 'ace').access.profileId, 'connected')

    const worker = runtime.workers.get('ace')
    await worker.start()
    const toolRun = worker.executeTool({ name: 'write', arguments: { path: 'scratch/approved.txt', content: 'approved result' } })
    let toolDecision
    for (let attempt = 0; attempt < 30 && !toolDecision; attempt += 1) {
      toolDecision = (await runtime.state()).decisions.find((decision) => decision.resource === 'dsh-tool:write')
      if (!toolDecision) await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(toolDecision.title, 'Ace wants to use write')
    assert.equal((await runtime.decide(toolDecision.actionId, 'approve')).status, 'allowed')
    assert.equal((await toolRun).status, 'completed')

    const task = await runtime.submitTask({ objective: 'Have Ace review this implementation.' })
    let ownedByTaskId = null
    for (let attempt = 0; attempt < 50 && !ownedByTaskId; attempt += 1) {
      ownedByTaskId = (await runtime.state()).agents.specialists.find((agent) => agent.agentId === 'ace')?.ownedByTaskId
      if (!ownedByTaskId) await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(ownedByTaskId, task.taskId)
    const completedTask = await runtime.waitForTask(task.taskId)
    assert.equal(completedTask.status, 'completed', JSON.stringify({ failure: completedTask.failure, audit: runtime.audit.entries().slice(-8).map((entry) => entry.fact) }))
    assert.equal(completedTask.summary, 'CEO accepted the review.')
    assert.equal(calls.find((call) => call.stage === 'decompose').availableSpecialists.includes('ace'), true)
    assert.equal(calls.find((call) => call.stage === 'decompose').specialistCatalog.some((agent) => agent.agentId === 'ace'), true)
    assert.equal(calls.find((call) => call.stage === 'decompose').agentContinuity.persona.find((entry) => entry.path === 'SOUL.md').content, 'Keep faith with Rod and lead the team with evidence.')
    assert.equal(calls.find((call) => call.stage === 'synthesize').agentContinuity.digest, state.agents.main.continuity.digest)
    assert.equal(calls.find((call) => call.stage === 'specialist-loop').specialistAgent.agentId, 'ace')
    assert.deepEqual(agentModelRoutes, [{
      agentId: 'ace',
      mode: 'pinned',
      providerId: 'fixture',
      model: 'agents',
      changedBy: 'rod',
      changedAt: pinnedModel.changedAt,
    }])
    assert.equal(calls.find((call) => call.stage === 'specialist-loop').agentContinuity.memory[0].content, 'Remember the Team RSI operating model.')
    const running = (await runtime.state()).agents.specialists.find((agent) => agent.agentId === 'ace')
    assert.equal(running.harnessState, 'Running')
    assert.equal(running.ownedByTaskId, null)
    assert.equal(running.workspace.isolation, 'per-agent-workspace')
    assert.deepEqual(running.workspace.mounts.map((mount) => [mount.kind, mount.mode]), [
      ['persona', 'read-only'], ['memory', 'read-only'], ['skills', 'read-only'],
    ])
    assert.equal((await runtime.stopAgent('ace')).state, 'stopped')
    assert.equal((await runtime.startAgent('ace')).state, 'running')

    const removed = await runtime.removeAgent('ace')
    assert.deepEqual({ agentId: removed.agentId, displayName: removed.displayName, workerSessionsStopped: removed.workerSessionsStopped }, {
      agentId: 'ace', displayName: 'Ace', workerSessionsStopped: 0,
    })
    assert.equal((await runtime.state()).agents.specialists.some((agent) => agent.agentId === 'ace'), false)
    assert.equal(runtime.agentRegistry.get('ace'), null)
    assert.equal(runtime.agentAccessPolicy.get('ace').profileId, 'sandbox')
    assert.equal(runtime.agentModelPolicy.get('ace').mode, 'auto')
    await assert.rejects(lstat(join(directory, 'agents/workers/ace.json')), { code: 'ENOENT' })
    await assert.rejects(lstat(join(directory, 'agents/workspaces/ace')), { code: 'ENOENT' })
    assert.equal(runtime.audit.entries().some((entry) => entry.fact.kind === 'agent.removed' && entry.fact.agentId === 'ace'), true)
    await assert.rejects(runtime.removeAgent('rj'), /AGENT_MAIN_CANNOT_REMOVE/)
  } finally {
    await runtime.close()
    await removeTree(directory)
  }
})

test('the imported RJ continuity capsule is restored after a runtime restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-rj-restart-'))
  const modelRegistry = {
    state: () => ({ schema: 'chimera.model-provider-registry.v2', selected: null, providers: [] }),
    router: () => createDeterministicModelRouter({ responder: async () => ({ summary: 'unused' }) }),
    async select() {},
  }
  const agentDiscovery = {
    async discover() {
      return {
        schema: 'chimera.agent-discovery.v1',
        source: { id: 'hermes-aws', type: 'hermes-ssm', host: 'configured-hermes' },
        candidates: [{
          schema: 'chimera.hermes-agent-candidate.v1',
          candidateId: 'hermes-aws:rj',
          profileId: 'rj',
          displayName: 'RJ',
          sourceRef: 'hermes://configured-hermes/profiles/rj',
          defaultRole: 'Team CEO',
          defaultCapabilities: ['orchestration'],
        }],
      }
    },
  }
  const referenceProvider = {
    async materialize(_reference, { kind }) {
      if (kind === 'persona') return [{ path: 'SOUL.md', content: 'RJ remains RJ after restart.' }]
      if (kind === 'memory') return [{ path: 'MEMORY.md', content: 'Durable continuity.' }]
      return [{ path: 'continuity/SKILL.md', content: 'Resume safely.' }]
    },
  }
  const options = () => ({
    profileDir: join(directory, 'browser/ceo'),
    decisionFile: join(directory, 'decisions.jsonl'),
    taskFile: join(directory, 'tasks.jsonl'),
    modelCallFile: join(directory, 'model-calls.jsonl'),
    agentFile: join(directory, 'agents/registry.json'),
    mainAgentFile: join(directory, 'agents/main.json'),
    workerRoot: join(directory, 'agents/workspaces'),
    agentDiscovery,
    agentReferenceProvider: referenceProvider,
    modelRegistry,
    browserExecutor: memoryBrowserExecutor(),
  })
  let first
  let restarted
  try {
    first = new ChimeraBrowserRuntime(options())
    await first.start()
    const preview = await first.discoverAgents()
    const imported = await first.importMainAgent({ discoveryId: preview.discoveryId, candidateId: 'hermes-aws:rj' })
    await first.close()
    first = null

    restarted = new ChimeraBrowserRuntime(options())
    await restarted.start()
    const state = await restarted.state()
    assert.equal(state.agents.main.continuity.digest, imported.continuity.digest)
    assert.equal(state.agents.main.source.ref, 'hermes://configured-hermes/profiles/rj')
  } finally {
    await first?.close()
    await restarted?.close()
    await removeTree(directory)
  }
})

test('runtime refuses a candidate that was not returned by the current discovery preview', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-agent-forgery-'))
  const modelRegistry = {
    state: () => ({ schema: 'chimera.model-provider-registry.v2', selected: null, providers: [] }),
    router: () => createDeterministicModelRouter({ responder: async () => ({ summary: 'unused' }) }),
    async select() {},
  }
  const runtime = new ChimeraBrowserRuntime({
    profileDir: join(directory, 'browser/ceo'),
    decisionFile: join(directory, 'decisions.jsonl'),
    taskFile: join(directory, 'tasks.jsonl'),
    modelCallFile: join(directory, 'model-calls.jsonl'),
    agentFile: join(directory, 'agents/registry.json'),
    agentDiscovery: { async discover() { return { schema: 'chimera.agent-discovery.v1', source: { id: 'hermes-aws', type: 'hermes-ssm', host: 'fixture-hermes' }, candidates: [] } } },
    modelRegistry,
    browserExecutor: memoryBrowserExecutor(),
  })
  try {
    await runtime.start()
    const preview = await runtime.discoverAgents()
    await assert.rejects(runtime.importAgents({
      discoveryId: preview.discoveryId,
      agents: [{ candidateId: 'hermes-aws:forged' }],
    }), /AGENT_DISCOVERY_CANDIDATE_INVALID/)
  } finally {
    await runtime.close()
    await removeTree(directory)
  }
})

test('runtime reuses one unexpired discovery preview across concurrent and repeated requests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-agent-discovery-singleflight-'))
  let calls = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const modelRegistry = {
    state: () => ({ schema: 'chimera.model-provider-registry.v2', selected: null, providers: [] }),
    router: () => createDeterministicModelRouter({ responder: async () => ({ summary: 'unused' }) }),
    async select() {},
  }
  const runtime = new ChimeraBrowserRuntime({
    profileDir: join(directory, 'browser/ceo'),
    decisionFile: join(directory, 'decisions.jsonl'),
    taskFile: join(directory, 'tasks.jsonl'),
    modelCallFile: join(directory, 'model-calls.jsonl'),
    agentFile: join(directory, 'agents/registry.json'),
    agentDiscovery: {
      async discover() {
        calls += 1
        await gate
        return { schema: 'chimera.agent-discovery.v1', source: { id: 'hermes-aws', type: 'hermes-ssm', host: 'fixture-hermes' }, candidates: [] }
      },
    },
    modelRegistry,
    browserExecutor: memoryBrowserExecutor(),
  })
  try {
    await runtime.start()
    const first = runtime.discoverAgents()
    const second = runtime.discoverAgents()
    release()
    const [a, b] = await Promise.all([first, second])
    const repeated = await runtime.discoverAgents()
    assert.equal(calls, 1)
    assert.equal(a.discoveryId, b.discoveryId)
    assert.equal(a.discoveryId, repeated.discoveryId)
  } finally {
    release()
    await runtime.close()
    await removeTree(directory)
  }
})

test('runtime discovery fails closed when Hermes env is unset', async () => {
  const previous = {
    CHIMERA_HERMES_INSTANCE_ID: process.env.CHIMERA_HERMES_INSTANCE_ID,
    CHIMERA_HERMES_BACKUP_BUCKET: process.env.CHIMERA_HERMES_BACKUP_BUCKET,
    CHIMERA_HERMES_BACKUP_PREFIX: process.env.CHIMERA_HERMES_BACKUP_PREFIX,
    CHIMERA_HERMES_HOST: process.env.CHIMERA_HERMES_HOST,
  }
  delete process.env.CHIMERA_HERMES_INSTANCE_ID
  delete process.env.CHIMERA_HERMES_BACKUP_BUCKET
  delete process.env.CHIMERA_HERMES_BACKUP_PREFIX
  delete process.env.CHIMERA_HERMES_HOST
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-hermes-unconfigured-'))
  const modelRegistry = {
    state: () => ({ schema: 'chimera.model-provider-registry.v2', selected: null, providers: [] }),
    router: () => createDeterministicModelRouter({ responder: async () => ({ summary: 'unused' }) }),
    async select() {},
  }
  const runtime = new ChimeraBrowserRuntime({
    profileDir: join(directory, 'browser/ceo'),
    decisionFile: join(directory, 'decisions.jsonl'),
    taskFile: join(directory, 'tasks.jsonl'),
    modelCallFile: join(directory, 'model-calls.jsonl'),
    agentFile: join(directory, 'agents/registry.json'),
    modelRegistry,
    browserExecutor: memoryBrowserExecutor(),
  })
  try {
    await runtime.start()
    const state = await runtime.state()
    assert.equal(state.agents.source.configured, false)
    assert.equal(state.agents.source.mode, 'not-configured')
    await assert.rejects(runtime.discoverAgents(), (error) => {
      assert.equal(error.code, 'HERMES_DISCOVERY_NOT_CONFIGURED')
      assert.equal(error.message, 'HERMES_DISCOVERY_NOT_CONFIGURED')
      return true
    })
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await runtime.close()
    await removeTree(directory)
  }
})

test('runtime creates native agents with durable idempotency, bounded continuity, and preserved policies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-native-create-'))
  let modelCalls = 0
  const realProvider = await NativeAgentReferenceProvider.open({
    root: join(directory, 'native'),
    audit: { append() {} },
  })
  let saveCalls = 0
  let materializeCalls = 0
  const nativeReferenceProvider = {
    async savePersona(input) { saveCalls += 1; return realProvider.savePersona(input) },
    async materialize(...args) { materializeCalls += 1; return realProvider.materialize(...args) },
  }
  const modelRegistry = {
    state: () => ({
      schema: 'chimera.model-provider-registry.v2',
      selected: { providerId: 'fixture', providerName: 'Fixture', model: 'native', modelName: 'Native' },
      providers: [{
        id: 'fixture', name: 'Fixture', configured: true,
        models: [{ id: 'native', name: 'Native', availability: 'authenticated', capabilities: ['conversation'] }],
      }],
    }),
    router: () => {
      modelCalls += 1
      throw new Error('MODEL_MUST_NOT_RUN_DURING_NATIVE_CREATE')
    },
    async routerFor() {
      modelCalls += 1
      throw new Error('MODEL_MUST_NOT_RUN_DURING_NATIVE_CREATE')
    },
    async select() {},
  }
  const options = () => ({
    profileDir: join(directory, 'browser/ceo'),
    decisionFile: join(directory, 'decisions.jsonl'),
    taskFile: join(directory, 'tasks.jsonl'),
    modelCallFile: join(directory, 'model-calls.jsonl'),
    agentFile: join(directory, 'agents/registry.json'),
    agentModelFile: join(directory, 'agents/models.json'),
    agentAccessFile: join(directory, 'agents/access.json'),
    workerRoot: join(directory, 'agents/workspaces'),
    workerStateDir: join(directory, 'agents/workers'),
    agentCreationReceiptFile: join(directory, 'agents/create-receipts.json'),
    nativeAgentRoot: join(directory, 'native'),
    nativeReferenceProvider,
    modelRegistry,
    browserExecutor: memoryBrowserExecutor(),
  })
  let runtime
  let restarted
  try {
    runtime = new ChimeraBrowserRuntime(options())
    await runtime.start()
    const created = await runtime.createAgent({
      requestId: 'create-native-1',
      agentId: 'native-builder',
      displayName: 'Native Builder',
      role: 'Repository implementation',
      capabilities: ['coding'],
      persona: 'Be evidence-led and direct.',
    })
    assert.equal(created.schema, 'chimera.agent-create-result.v1')
    assert.equal(created.continuity[0].status, 'materialized')
    assert.equal(created.continuity[0].report.persona.files, 1)
    assert.equal(created.continuity[0].report.memory.files, 0)
    assert.equal(created.continuity[0].report.skills.files, 0)
    assert.equal(created.continuity[0].report.dependencyStatus, 'unverified')
    assert.equal(saveCalls, 1)
    assert.equal(materializeCalls, 3)
    await assert.rejects(runtime.createAgent({
      requestId: 'create-native-invalid', agentId: 'invalid-persona', displayName: 'Invalid',
      role: 'Testing', capabilities: ['testing'], persona: 'OPENAI_API_KEY=should-not-persist',
    }), /NATIVE_PERSONA_CONTENT_INVALID/)
    assert.equal(runtime.agentRegistry.get('invalid-persona'), null)
    assert.equal(runtime.agentCreationReceipts.get('create-native-invalid'), null)
    const same = await runtime.createAgent({
      requestId: 'create-native-1', agentId: 'native-builder', displayName: 'Native Builder',
      role: 'Repository implementation', capabilities: ['coding'], persona: 'Be evidence-led and direct.',
    })
    assert.deepEqual(same, created)
    assert.equal(saveCalls, 1)
    await assert.rejects(runtime.createAgent({
      requestId: 'create-native-1', agentId: 'native-builder', displayName: 'Changed',
      role: 'Repository implementation', capabilities: ['coding'], persona: 'Be evidence-led and direct.',
    }), /AGENT_CREATE_REQUEST_CONFLICT/)
    await runtime.setAgentAccess('native-builder', 'connected')
    await runtime.setAgentModel('native-builder', { mode: 'pinned', providerId: 'fixture', model: 'native' })
    const personaPath = join(directory, 'native', 'native-builder', 'persona', 'SOUL.md')
    const originalPersona = await readFile(personaPath, 'utf8')
    await assert.rejects(runtime.createAgent({
      requestId: 'create-native-2', agentId: 'native-builder', displayName: 'Replacement',
      role: 'Untrusted replacement', capabilities: ['testing'], persona: 'This must never replace the durable persona.',
    }), /AGENT_ALREADY_REGISTERED/)
    assert.equal(await readFile(personaPath, 'utf8'), originalPersona)
    assert.equal(runtime.agentCreationReceipts.get('create-native-2'), null)
    const updated = await runtime.updateAgentMetadata({
      agentId: 'native-builder', displayName: 'Native Builder v2', role: 'Implementation', capabilities: ['coding', 'testing'],
    })
    assert.equal(updated.displayName, 'Native Builder v2')
    const state = await runtime.state()
    const native = state.agents.specialists.find((agent) => agent.agentId === 'native-builder')
    assert.equal(native.access.profileId, 'connected')
    assert.equal(native.modelPreference.mode, 'pinned')
    assert.equal(native.continuity.status, 'materialized')
    assert.equal(JSON.stringify(native).includes('Be evidence-led'), false)
    assert.equal(modelCalls, 0)
    await runtime.close()
    runtime = null

    restarted = new ChimeraBrowserRuntime(options())
    await restarted.start()
    const afterRestart = await restarted.createAgent({
      requestId: 'create-native-1', agentId: 'native-builder', displayName: 'Native Builder',
      role: 'Repository implementation', capabilities: ['coding'], persona: 'Be evidence-led and direct.',
    })
    assert.deepEqual(afterRestart, created)
    assert.equal(saveCalls, 1)
    assert.equal(materializeCalls, 3)
    await assert.rejects(restarted.createAgent({
      requestId: 'create-native-2', agentId: 'native-builder', displayName: 'Replacement',
      role: 'Untrusted replacement', capabilities: ['testing'], persona: 'This must never replace the durable persona.',
    }), /AGENT_ALREADY_REGISTERED/)
    assert.equal(await readFile(personaPath, 'utf8'), originalPersona)
  } finally {
    await runtime?.close()
    await restarted?.close()
    await removeTree(directory)
  }
})

test('native continuity and metadata mutations fence ordinary admissions in both race directions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-agent-admission-fence-'))
  let continuityBlocked = false
  let continuityEntered = null
  let continuityRelease = null
  const nativeReferenceProvider = {
    async savePersona() {},
    async materialize(_reference, { kind }) {
      if (continuityBlocked && kind === 'persona') {
        continuityEntered?.resolve()
        await continuityRelease?.promise
      }
      return kind === 'persona' ? [{ path: 'SOUL.md', content: 'Fence test persona.' }] : []
    },
  }
  const modelRegistry = {
    state: () => ({ schema: 'chimera.model-provider-registry.v2', selected: null, providers: [] }),
    router: () => { throw new Error('MODEL_MUST_NOT_RUN_DURING_ADMISSION_FENCE') },
    async select() {},
  }
  const runtime = new ChimeraBrowserRuntime({
    profileDir: join(directory, 'browser/ceo'),
    decisionFile: join(directory, 'decisions.jsonl'),
    taskFile: join(directory, 'tasks.jsonl'),
    modelCallFile: join(directory, 'model-calls.jsonl'),
    agentFile: join(directory, 'agents/registry.json'),
    agentCreationReceiptFile: join(directory, 'agents/create-receipts.json'),
    nativeAgentRoot: join(directory, 'native'),
    workerRoot: join(directory, 'agents/workspaces'),
    workerStateDir: join(directory, 'agents/workers'),
    projectRegistry: {
      get(projectId) { return projectId === 'fenced-project' ? { projectId, networkHosts: [] } : null },
      list() { return [] },
      async close() {},
    },
    projectSessions: {
      list() { return [] },
      get() { return null },
      async close() {},
    },
    nativeReferenceProvider,
    modelRegistry,
    browserExecutor: memoryBrowserExecutor(),
  })
  try {
    await runtime.start()
    await runtime.createAgent({
      requestId: 'create-admission-fence', agentId: 'admission-fence', displayName: 'Admission Fence',
      role: 'Testing', capabilities: ['testing'], persona: 'Fence test persona.',
    })

    const originalAuditAppend = runtime.agentRegistry.audit.append.bind(runtime.agentRegistry.audit)
    const auditEntered = Promise.withResolvers()
    const auditRelease = Promise.withResolvers()
    runtime.agentRegistry.audit.append = async fact => {
      if (fact.kind === 'agent.registry.metadata-updated') {
        auditEntered.resolve()
        await auditRelease.promise
      }
      return originalAuditAppend(fact)
    }
    const metadata = runtime.updateAgentMetadata({
      agentId: 'admission-fence', displayName: 'Admission Fence', role: 'Testing', capabilities: ['testing'],
    })
    await auditEntered.promise
    await assert.rejects(runtime.submitTask({ objective: 'Must not cross a metadata mutation.' }), { code: 'AGENT_MUTATION_IN_PROGRESS' })
    await assert.rejects(runtime.submitProjectTask({ projectId: 'fenced-project', objective: 'Must not queue during metadata mutation.' }), { code: 'AGENT_MUTATION_IN_PROGRESS' })
    assert.equal(runtime.tasks.active().length, 0)
    auditRelease.resolve()
    await metadata
    runtime.agentRegistry.audit.append = originalAuditAppend

    continuityBlocked = true
    continuityEntered = Promise.withResolvers()
    continuityRelease = Promise.withResolvers()
    const repair = runtime.repairAgentContinuity({ agentId: 'admission-fence' })
    await continuityEntered.promise
    await assert.rejects(runtime.sendMessage({ content: 'Must not cross a continuity repair.' }), { code: 'AGENT_MUTATION_IN_PROGRESS' })
    assert.equal(runtime.tasks.active().length, 0)
    continuityRelease.resolve()
    await repair
    continuityBlocked = false

    const submitEntered = Promise.withResolvers()
    const submitRelease = Promise.withResolvers()
    const originalSubmit = runtime.tasks.submit.bind(runtime.tasks)
    runtime.tasks.submit = async (...args) => {
      submitEntered.resolve()
      await submitRelease.promise
      return originalSubmit(...args)
    }
    const admitted = runtime.submitTask({ objective: 'Reserve admission before mutation.' })
    await submitEntered.promise
    const racedMetadata = runtime.updateAgentMetadata({
      agentId: 'admission-fence', displayName: 'Admission Fence', role: 'Testing', capabilities: ['testing'],
    })
    submitRelease.resolve()
    await admitted
    await assert.rejects(racedMetadata, { code: 'AGENT_METADATA_CHANGE_DURING_TASK' })
    runtime.tasks.submit = originalSubmit
    await runtime.waitForTask((await admitted).taskId).catch(() => {})
  } finally {
    await runtime.close()
    await removeTree(directory)
  }
})

test('import, create, and task admissions serialize through the agent mutation barrier', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-agent-import-barrier-'))
  const registerEntered = Promise.withResolvers()
  const registerRelease = Promise.withResolvers()
  const agentReferenceProvider = {
    async materialize(_reference, { kind }) {
      if (kind === 'persona') return [{ path: 'SOUL.md', content: 'Imported barrier persona.' }]
      if (kind === 'memory') return [{ path: 'MEMORY.md', content: '' }]
      return []
    },
  }
  const agentDiscovery = {
    async discover() {
      return {
        schema: 'chimera.agent-discovery.v1',
        source: { id: 'hermes-aws', type: 'hermes-ssm', host: 'fixture' },
        candidates: [{
          schema: 'chimera.hermes-agent-candidate.v1', candidateId: 'hermes-aws:racy', profileId: 'racy',
          displayName: 'Racy', sourceRef: 'hermes://fixture/profiles/racy', defaultRole: 'Imported', defaultCapabilities: ['testing'],
        }],
      }
    },
  }
  const modelRegistry = {
    state: () => ({ schema: 'chimera.model-provider-registry.v2', selected: null, providers: [] }),
    router: () => { throw new Error('MODEL_MUST_NOT_RUN_DURING_IMPORT_BARRIER') },
    async select() {},
  }
  const options = () => ({
    profileDir: join(directory, 'browser/ceo'),
    decisionFile: join(directory, 'decisions.jsonl'),
    taskFile: join(directory, 'tasks.jsonl'),
    modelCallFile: join(directory, 'model-calls.jsonl'),
    agentFile: join(directory, 'agents/registry.json'),
    agentCreationReceiptFile: join(directory, 'agents/create-receipts.json'),
    workerRoot: join(directory, 'agents/workspaces'),
    workerStateDir: join(directory, 'agents/workers'),
    agentDiscovery,
    agentReferenceProvider,
    modelRegistry,
    browserExecutor: memoryBrowserExecutor(),
  })
  let runtime
  try {
    runtime = new ChimeraBrowserRuntime(options())
    await runtime.start()
    const originalRegisterMany = runtime.agentRegistry.registerMany.bind(runtime.agentRegistry)
    runtime.agentRegistry.registerMany = async (...args) => {
      registerEntered.resolve()
      await registerRelease.promise
      return originalRegisterMany(...args)
    }
    const preview = await runtime.discoverAgents()
    const importing = runtime.importAgents({ discoveryId: preview.discoveryId, agents: [{ candidateId: 'hermes-aws:racy' }] })
    await registerEntered.promise
    await assert.rejects(runtime.submitTask({ objective: 'Must wait for import.' }), { code: 'AGENT_MUTATION_IN_PROGRESS' })
    const creating = runtime.createAgent({
      requestId: 'create-racy-native', agentId: 'racy', displayName: 'Native Racy',
      role: 'Native', capabilities: ['testing'], persona: 'Native racy persona.',
    })
    registerRelease.resolve()
    await importing
    await assert.rejects(creating, { code: 'AGENT_ALREADY_REGISTERED' })
    assert.equal(runtime.agentCreationReceipts.get('create-racy-native'), null)
    assert.equal(runtime.agentRegistry.get('racy').source.type, 'hermes')
  } finally {
    registerRelease.resolve()
    await runtime?.close()
    await removeTree(directory)
  }
})

test('import rejects while an existing task is active so no unready profile is published', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-agent-import-active-'))
  const agentDiscovery = {
    async discover() {
      return {
        schema: 'chimera.agent-discovery.v1',
        source: { id: 'hermes-aws', type: 'hermes-ssm', host: 'fixture' },
        candidates: [{
          schema: 'chimera.hermes-agent-candidate.v1', candidateId: 'hermes-aws:active-race', profileId: 'active-race',
          displayName: 'Active Race', sourceRef: 'hermes://fixture/profiles/active-race', defaultRole: 'Imported', defaultCapabilities: ['testing'],
        }],
      }
    },
  }
  const runtime = new ChimeraBrowserRuntime({
    profileDir: join(directory, 'browser/ceo'),
    decisionFile: join(directory, 'decisions.jsonl'),
    taskFile: join(directory, 'tasks.jsonl'),
    modelCallFile: join(directory, 'model-calls.jsonl'),
    agentFile: join(directory, 'agents/registry.json'),
    agentDiscovery,
    agentReferenceProvider: { async materialize() { return [{ path: 'SOUL.md', content: 'Should not publish.' }] } },
    modelRegistry: { state: () => ({ selected: null, providers: [] }), router: () => { throw new Error('MODEL_MUST_NOT_RUN_DURING_ACTIVE_IMPORT') }, async select() {} },
    browserExecutor: memoryBrowserExecutor(),
  })
  try {
    await runtime.start()
    const preview = await runtime.discoverAgents()
    await runtime.tasks.submit({ taskId: 'active-import-task', objective: 'Existing active task.', model: null })
    await runtime.tasks.start('active-import-task')
    await assert.rejects(runtime.importAgents({ discoveryId: preview.discoveryId, agents: [{ candidateId: 'hermes-aws:active-race' }] }), { code: 'AGENT_IMPORT_DURING_TASK' })
    assert.equal(runtime.agentRegistry.get('active-race'), null)
  } finally {
    await runtime.close()
    await removeTree(directory)
  }
})

test('native continuity repair reports unavailable registration then explicitly rematerializes it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-native-repair-'))
  let unavailable = true
  const nativeReferenceProvider = {
    async savePersona() {},
    async materialize(_reference, { kind }) {
      if (kind === 'persona' && unavailable) throw Object.assign(new Error('NATIVE_PERSONA_SOURCE_UNAVAILABLE'), { code: 'NATIVE_PERSONA_SOURCE_UNAVAILABLE' })
      return kind === 'persona' ? [{ path: 'SOUL.md', content: 'Repairable persona.' }] : []
    },
  }
  const modelRegistry = {
    state: () => ({ schema: 'chimera.model-provider-registry.v2', selected: null, providers: [] }),
    router: () => { throw new Error('MODEL_MUST_NOT_RUN_DURING_REPAIR') },
    async select() {},
  }
  const options = () => ({
    profileDir: join(directory, 'browser/ceo'),
    decisionFile: join(directory, 'decisions.jsonl'),
    taskFile: join(directory, 'tasks.jsonl'),
    modelCallFile: join(directory, 'model-calls.jsonl'),
    agentFile: join(directory, 'agents/registry.json'),
    agentCreationReceiptFile: join(directory, 'agents/create-receipts.json'),
    agentContinuityFile: join(directory, 'agents/continuity.json'),
    workerRoot: join(directory, 'agents/workspaces'),
    workerStateDir: join(directory, 'agents/workers'),
    nativeReferenceProvider,
    modelRegistry,
    browserExecutor: memoryBrowserExecutor(),
  })
  let runtime
  try {
    runtime = new ChimeraBrowserRuntime(options())
    await runtime.start()
    const created = await runtime.createAgent({
      requestId: 'create-repair-1', agentId: 'repairable', displayName: 'Repairable',
      role: 'Testing', capabilities: ['testing'], persona: 'Repairable persona.',
    })
    assert.equal(created.continuity[0].status, 'unavailable')
    assert.equal(runtime.agentRegistry.get('repairable').agentId, 'repairable')
    unavailable = false
    const repaired = await runtime.repairAgentContinuity({ agentId: 'repairable' })
    assert.equal(repaired[0].status, 'materialized')
    assert.match(repaired[0].digest, /^[a-f0-9]{64}$/)
    assert.equal((await runtime.state()).agents.specialists.find((agent) => agent.agentId === 'repairable').continuity.status, 'materialized')
    await runtime.close()
    runtime = new ChimeraBrowserRuntime(options())
    await runtime.start()
    assert.equal((await runtime.state()).agents.specialists.find((agent) => agent.agentId === 'repairable').continuity.status, 'materialized')
    unavailable = true
    const failed = await runtime.repairAgentContinuity({ agentId: 'repairable' })
    assert.equal(failed[0].status, 'unavailable')
    await runtime.close()
    runtime = new ChimeraBrowserRuntime(options())
    await runtime.start()
    assert.equal((await runtime.state()).agents.specialists.find((agent) => agent.agentId === 'repairable').continuity.status, 'unavailable')
  } finally {
    await runtime?.close()
    await removeTree(directory)
  }
})

test('native source-save failure keeps the original create receipt retryable across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-native-source-retry-'))
  let sourceAvailable = false
  const nativeReferenceProvider = {
    async savePersona() {
      if (!sourceAvailable) throw Object.assign(new Error('NATIVE_PERSONA_SOURCE_UNAVAILABLE'), { code: 'NATIVE_PERSONA_SOURCE_UNAVAILABLE' })
    },
    async materialize(_reference, { kind }) {
      return kind === 'persona' ? [{ path: 'SOUL.md', content: 'Retryable source persona.' }] : []
    },
  }
  const modelRegistry = {
    state: () => ({ schema: 'chimera.model-provider-registry.v2', selected: null, providers: [] }),
    router: () => { throw new Error('MODEL_MUST_NOT_RUN_DURING_SOURCE_RETRY') },
    async select() {},
  }
  const input = {
    requestId: 'create-source-retry-1', agentId: 'source-retry', displayName: 'Source Retry',
    role: 'Testing', capabilities: ['testing'], persona: 'Retryable source persona.',
  }
  const options = () => ({
    profileDir: join(directory, 'browser/ceo'),
    decisionFile: join(directory, 'decisions.jsonl'),
    taskFile: join(directory, 'tasks.jsonl'),
    modelCallFile: join(directory, 'model-calls.jsonl'),
    agentFile: join(directory, 'agents/registry.json'),
    agentCreationReceiptFile: join(directory, 'agents/create-receipts.json'),
    agentContinuityFile: join(directory, 'agents/continuity.json'),
    workerRoot: join(directory, 'agents/workspaces'),
    workerStateDir: join(directory, 'agents/workers'),
    nativeReferenceProvider,
    modelRegistry,
    browserExecutor: memoryBrowserExecutor(),
  })
  let runtime
  try {
    runtime = new ChimeraBrowserRuntime(options())
    await runtime.start()
    await assert.rejects(runtime.createAgent(input), /NATIVE_PERSONA_SOURCE_UNAVAILABLE/)
    assert.equal(runtime.agentRegistry.get('source-retry').agentId, 'source-retry')
    assert.equal(runtime.agentCreationReceipts.get(input.requestId).status, 'reserved')
    assert.equal((await runtime.state()).agents.specialists.find((agent) => agent.agentId === 'source-retry').continuity.status, 'unavailable')
    await runtime.close()
    sourceAvailable = true
    runtime = new ChimeraBrowserRuntime(options())
    await runtime.start()
    const recovered = await runtime.createAgent(input)
    assert.equal(recovered.continuity[0].status, 'materialized')
    assert.equal(runtime.agentCreationReceipts.get(input.requestId).status, 'completed')
  } finally {
    await runtime?.close()
    await removeTree(directory)
  }
})

test('continuity-store failure leaves a durable unavailable state instead of resurrecting materialized state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-continuity-store-failure-'))
  const nativeReferenceProvider = {
    async savePersona() {},
    async materialize(_reference, { kind }) {
      return kind === 'persona' ? [{ path: 'SOUL.md', content: 'Durable continuity state.' }] : []
    },
  }
  const modelRegistry = {
    state: () => ({ schema: 'chimera.model-provider-registry.v2', selected: null, providers: [] }),
    router: () => { throw new Error('MODEL_MUST_NOT_RUN_DURING_CONTINUITY_STORE_FAILURE') },
    async select() {},
  }
  const options = () => ({
    profileDir: join(directory, 'browser/ceo'),
    decisionFile: join(directory, 'decisions.jsonl'),
    taskFile: join(directory, 'tasks.jsonl'),
    modelCallFile: join(directory, 'model-calls.jsonl'),
    agentFile: join(directory, 'agents/registry.json'),
    agentCreationReceiptFile: join(directory, 'agents/create-receipts.json'),
    agentContinuityFile: join(directory, 'agents/continuity.json'),
    workerRoot: join(directory, 'agents/workspaces'),
    workerStateDir: join(directory, 'agents/workers'),
    nativeReferenceProvider,
    modelRegistry,
    browserExecutor: memoryBrowserExecutor(),
  })
  let runtime
  try {
    runtime = new ChimeraBrowserRuntime(options())
    await runtime.start()
    await runtime.createAgent({
      requestId: 'create-continuity-store-failure', agentId: 'continuity-store-failure', displayName: 'Continuity Store Failure',
      role: 'Testing', capabilities: ['testing'], persona: 'Durable continuity state.',
    })
    const originalPut = runtime.agentContinuityRecords.put.bind(runtime.agentContinuityRecords)
    let failMaterializedPut = true
    runtime.agentContinuityRecords.put = async (record) => {
      if (failMaterializedPut && record.status === 'materialized') {
        failMaterializedPut = false
        throw Object.assign(new Error('CONTINUITY_STORE_DOWN'), { code: 'CONTINUITY_STORE_DOWN' })
      }
      return originalPut(record)
    }
    const repaired = await runtime.repairAgentContinuity({ agentId: 'continuity-store-failure' })
    assert.equal(repaired[0].status, 'unavailable')
    await runtime.close()
    runtime = new ChimeraBrowserRuntime(options())
    await runtime.start()
    assert.equal((await runtime.state()).agents.specialists.find((agent) => agent.agentId === 'continuity-store-failure').continuity.status, 'unavailable')
  } finally {
    await runtime?.close()
    await removeTree(directory)
  }
})

test('continuity audit rejection is awaited and leaves a durable unavailable result across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-continuity-audit-failure-'))
  const auditLog = new MemoryAuditLog()
  const audit = {
    append(fact) {
      if (fact.kind?.startsWith('agent.continuity')) return Promise.reject(new Error('AUDIT_UNAVAILABLE'))
      return auditLog.append(fact)
    },
    entries: () => auditLog.entries(),
    summary: () => auditLog.summary(),
    recent: (...args) => auditLog.recent(...args),
    verify: (...args) => auditLog.verify(...args),
  }
  const nativeReferenceProvider = {
    async savePersona() {},
    async materialize(_reference, { kind }) {
      return kind === 'persona' ? [{ path: 'SOUL.md', content: 'Audit failure persona.' }] : []
    },
  }
  const modelRegistry = {
    state: () => ({ schema: 'chimera.model-provider-registry.v2', selected: null, providers: [] }),
    router: () => { throw new Error('MODEL_MUST_NOT_RUN_DURING_CONTINUITY_AUDIT_FAILURE') },
    async select() {},
  }
  const options = () => ({
    profileDir: join(directory, 'browser/ceo'),
    decisionFile: join(directory, 'decisions.jsonl'),
    taskFile: join(directory, 'tasks.jsonl'),
    modelCallFile: join(directory, 'model-calls.jsonl'),
    agentFile: join(directory, 'agents/registry.json'),
    agentCreationReceiptFile: join(directory, 'agents/create-receipts.json'),
    agentContinuityFile: join(directory, 'agents/continuity.json'),
    workerRoot: join(directory, 'agents/workspaces'),
    workerStateDir: join(directory, 'agents/workers'),
    nativeReferenceProvider,
    modelRegistry,
    audit,
    browserExecutor: memoryBrowserExecutor(),
  })
  let runtime
  try {
    runtime = new ChimeraBrowserRuntime(options())
    await runtime.start()
    const created = await runtime.createAgent({
      requestId: 'create-continuity-audit-failure', agentId: 'continuity-audit-failure', displayName: 'Continuity Audit Failure',
      role: 'Testing', capabilities: ['testing'], persona: 'Audit failure persona.',
    })
    assert.equal(created.continuity[0].status, 'unavailable')
    assert.equal(created.continuity[0].failureCode, 'AGENT_CONTINUITY_AUDIT_UNAVAILABLE')
    await runtime.close()
    runtime = new ChimeraBrowserRuntime(options())
    await runtime.start()
    assert.equal(runtime.agentContinuity.get('continuity-audit-failure').status, 'unavailable')
  } finally {
    await runtime?.close()
    await removeTree(directory)
  }
})

test('continuity remains pending in memory and on disk while the materialized audit is held', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-continuity-held-audit-'))
  const auditLog = new MemoryAuditLog()
  let holdMaterialized = false
  let materializedEntered = Promise.withResolvers()
  let releaseMaterialized = Promise.withResolvers()
  const audit = {
    append(fact) {
      if (holdMaterialized && fact.kind === 'agent.continuity.repaired') {
        materializedEntered.resolve()
        return releaseMaterialized.promise
      }
      return auditLog.append(fact)
    },
    entries: () => auditLog.entries(),
    summary: () => auditLog.summary(),
    recent: (...args) => auditLog.recent(...args),
    verify: (...args) => auditLog.verify(...args),
  }
  const nativeReferenceProvider = {
    async savePersona() {},
    async materialize(_reference, { kind }) {
      return kind === 'persona' ? [{ path: 'SOUL.md', content: 'Held audit persona.' }] : []
    },
  }
  const modelRegistry = {
    state: () => ({ schema: 'chimera.model-provider-registry.v2', selected: null, providers: [] }),
    router: () => { throw new Error('MODEL_MUST_NOT_RUN_DURING_HELD_AUDIT') },
    async select() {},
  }
  const options = () => ({
    profileDir: join(directory, 'browser/ceo'),
    decisionFile: join(directory, 'decisions.jsonl'),
    taskFile: join(directory, 'tasks.jsonl'),
    modelCallFile: join(directory, 'model-calls.jsonl'),
    agentFile: join(directory, 'agents/registry.json'),
    agentCreationReceiptFile: join(directory, 'agents/create-receipts.json'),
    agentContinuityFile: join(directory, 'agents/continuity.json'),
    workerRoot: join(directory, 'agents/workspaces'),
    workerStateDir: join(directory, 'agents/workers'),
    nativeReferenceProvider,
    modelRegistry,
    audit,
    browserExecutor: memoryBrowserExecutor(),
  })
  let runtime
  try {
    runtime = new ChimeraBrowserRuntime(options())
    await runtime.start()
    await runtime.createAgent({
      requestId: 'create-held-audit', agentId: 'held-audit', displayName: 'Held Audit',
      role: 'Testing', capabilities: ['testing'], persona: 'Held audit persona.',
    })
    holdMaterialized = true
    const repair = runtime.repairAgentContinuity({ agentId: 'held-audit' })
    await materializedEntered.promise
    assert.equal(runtime.agentContinuity.get('held-audit').status, 'unavailable')
    assert.equal(runtime.agentContinuity.get('held-audit').failureCode, 'AGENT_CONTINUITY_PENDING')
    assert.equal(runtime.agentContinuityRecords.get('held-audit').status, 'unavailable')
    assert.equal(runtime.agentContinuityRecords.get('held-audit').failureCode, 'AGENT_CONTINUITY_PENDING')
    releaseMaterialized.resolve()
    const repaired = await repair
    assert.equal(repaired[0].status, 'materialized')
  } finally {
    releaseMaterialized.resolve()
    await runtime?.close()
    await removeTree(directory)
  }
})

test('combined continuity audit and fallback-store failure retains pending state across reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-continuity-combined-failure-'))
  const auditLog = new MemoryAuditLog()
  let failMaterializedAudit = false
  const audit = {
    append(fact) {
      if (failMaterializedAudit && fact.kind === 'agent.continuity.repaired') {
        return Promise.reject(Object.assign(new Error('AUDIT_UNAVAILABLE'), { code: 'AUDIT_UNAVAILABLE' }))
      }
      return auditLog.append(fact)
    },
    entries: () => auditLog.entries(),
    summary: () => auditLog.summary(),
    recent: (...args) => auditLog.recent(...args),
    verify: (...args) => auditLog.verify(...args),
  }
  const nativeReferenceProvider = {
    async savePersona() {},
    async materialize(_reference, { kind }) {
      return kind === 'persona' ? [{ path: 'SOUL.md', content: 'Combined failure persona.' }] : []
    },
  }
  const modelRegistry = {
    state: () => ({ schema: 'chimera.model-provider-registry.v2', selected: null, providers: [] }),
    router: () => { throw new Error('MODEL_MUST_NOT_RUN_DURING_COMBINED_FAILURE') },
    async select() {},
  }
  const options = () => ({
    profileDir: join(directory, 'browser/ceo'),
    decisionFile: join(directory, 'decisions.jsonl'),
    taskFile: join(directory, 'tasks.jsonl'),
    modelCallFile: join(directory, 'model-calls.jsonl'),
    agentFile: join(directory, 'agents/registry.json'),
    agentCreationReceiptFile: join(directory, 'agents/create-receipts.json'),
    agentContinuityFile: join(directory, 'agents/continuity.json'),
    workerRoot: join(directory, 'agents/workspaces'),
    workerStateDir: join(directory, 'agents/workers'),
    nativeReferenceProvider,
    modelRegistry,
    audit,
    browserExecutor: memoryBrowserExecutor(),
  })
  let runtime
  let reopened
  try {
    runtime = new ChimeraBrowserRuntime(options())
    await runtime.start()
    await runtime.createAgent({
      requestId: 'create-combined-failure', agentId: 'combined-failure', displayName: 'Combined Failure',
      role: 'Testing', capabilities: ['testing'], persona: 'Combined failure persona.',
    })
    const originalPut = runtime.agentContinuityRecords.put.bind(runtime.agentContinuityRecords)
    runtime.agentContinuityRecords.put = async (record) => {
      if (record.status === 'unavailable' && record.failureCode !== 'AGENT_CONTINUITY_PENDING') {
        throw Object.assign(new Error('CONTINUITY_FALLBACK_STORE_DOWN'), { code: 'CONTINUITY_FALLBACK_STORE_DOWN' })
      }
      return originalPut(record)
    }
    failMaterializedAudit = true
    await assert.rejects(runtime.repairAgentContinuity({ agentId: 'combined-failure' }), { code: 'AGENT_CONTINUITY_PERSIST_FAILED' })
    assert.equal(runtime.agentContinuity.get('combined-failure').status, 'unavailable')
    assert.equal(runtime.agentContinuityRecords.get('combined-failure').status, 'unavailable')
    assert.equal(runtime.agentContinuityRecords.get('combined-failure').failureCode, 'AGENT_CONTINUITY_PENDING')
    await runtime.close()
    runtime = null
    reopened = new ChimeraBrowserRuntime(options())
    await reopened.start()
    assert.notEqual(reopened.agentContinuityRecords.get('combined-failure').status, 'materialized')
  } finally {
    await runtime?.close()
    await reopened?.close()
    await removeTree(directory)
  }
})

test('native create reservation reconciles after registry persistence fails and runtime restarts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-native-reservation-'))
  const nativeReferenceProvider = {
    async savePersona() {},
    async materialize(_reference, { kind }) {
      return kind === 'persona' ? [{ path: 'SOUL.md', content: 'Reservation persona.' }] : []
    },
  }
  const modelRegistry = {
    state: () => ({ schema: 'chimera.model-provider-registry.v2', selected: null, providers: [] }),
    router: () => { throw new Error('MODEL_MUST_NOT_RUN_DURING_RESERVATION') },
    async select() {},
  }
  const options = () => ({
    profileDir: join(directory, 'browser/ceo'),
    decisionFile: join(directory, 'decisions.jsonl'),
    taskFile: join(directory, 'tasks.jsonl'),
    modelCallFile: join(directory, 'model-calls.jsonl'),
    agentFile: join(directory, 'agents/registry.json'),
    agentCreationReceiptFile: join(directory, 'agents/create-receipts.json'),
    workerRoot: join(directory, 'agents/workspaces'),
    workerStateDir: join(directory, 'agents/workers'),
    nativeReferenceProvider,
    modelRegistry,
    browserExecutor: memoryBrowserExecutor(),
  })
  let runtime
  let restarted
  const input = {
    requestId: 'create-reservation-1', agentId: 'reservation-agent', displayName: 'Reservation',
    role: 'Testing', capabilities: ['testing'], persona: 'Reservation persona.',
  }
  try {
    runtime = new ChimeraBrowserRuntime(options())
    await runtime.start()
    runtime.agentRegistry.filePath = join(directory, 'missing-registry', 'registry.json')
    await assert.rejects(runtime.createAgent(input), /ENOENT/)
    await runtime.close()
    runtime = null
    restarted = new ChimeraBrowserRuntime(options())
    await restarted.start()
    const recovered = await restarted.createAgent(input)
    assert.equal(recovered.agent.agentId, 'reservation-agent')
    assert.equal(recovered.continuity[0].status, 'materialized')
  } finally {
    await runtime?.close()
    await restarted?.close()
    await removeTree(directory)
  }
})

test('native registered agents use their continuity capsule and task-bound harness instead of the built-in stub', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-native-task-'))
  const calls = []
  const provider = createDeterministicModelRouter({
    routerId: 'openai-compatible:fixture:native-task',
    responder: async (_prompt, context) => {
      calls.push(structuredClone(context))
      if (context.stage === 'decompose') {
        return { tasks: [{ specialistAgentId: 'native-worker', objective: 'Inspect the native workspace.', acceptanceCriteria: ['Return evidence.'] }] }
      }
      if (context.stage === 'specialist-loop') return { status: 'completed', summary: 'Native worker completed.' }
      return { summary: 'Native task synthesized.' }
    },
  })
  const modelRegistry = {
    state: () => ({
      schema: 'chimera.model-provider-registry.v2',
      selected: { providerId: 'fixture', providerName: 'Fixture', model: 'native-task', modelName: 'Native Task' },
      providers: [{
        id: 'fixture', name: 'Fixture', configured: true,
        models: [{ id: 'native-task', name: 'Native Task', availability: 'authenticated', capabilities: ['conversation'] }],
      }],
    }),
    router: () => provider,
    async routerFor() { return provider },
    async select() {},
  }
  const nativeReferenceProvider = {
    async savePersona() {},
    async materialize(_reference, { kind }) {
      return kind === 'persona' ? [{ path: 'SOUL.md', content: 'Native worker continuity.' }] : []
    },
  }
  const runtime = new ChimeraBrowserRuntime({
    profileDir: join(directory, 'browser/ceo'),
    decisionFile: join(directory, 'decisions.jsonl'),
    taskFile: join(directory, 'tasks.jsonl'),
    modelCallFile: join(directory, 'model-calls.jsonl'),
    agentFile: join(directory, 'agents/registry.json'),
    agentCreationReceiptFile: join(directory, 'agents/create-receipts.json'),
    workerRoot: join(directory, 'agents/workspaces'),
    workerStateDir: join(directory, 'agents/workers'),
    nativeReferenceProvider,
    modelRegistry,
    browserExecutor: memoryBrowserExecutor(),
  })
  try {
    await runtime.start()
    const created = await runtime.createAgent({
      requestId: 'create-native-task', agentId: 'native-worker', displayName: 'Native Worker',
      role: 'Workspace specialist', capabilities: ['coding'], persona: 'Native worker continuity.',
    })
    assert.equal(created.continuity[0].status, 'materialized')
    const task = await runtime.submitTask({ objective: 'Ask the native worker for evidence.' })
    const completed = await runtime.waitForTask(task.taskId)
    assert.equal(completed.status, 'completed', JSON.stringify(completed.failure))
    assert.equal(completed.summary, 'Native task synthesized.')
    const specialist = calls.find((entry) => entry.stage === 'specialist-loop')
    assert.equal(specialist.specialistAgent.agentId, 'native-worker')
    assert.equal(specialist.agentContinuity.persona[0].content, 'Native worker continuity.')
    assert.equal(runtime.workers.get('native-worker').status().state, 'running')
  } finally {
    await runtime.close()
    await removeTree(directory)
  }
})
