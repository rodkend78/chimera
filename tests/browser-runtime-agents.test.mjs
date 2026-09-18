import assert from 'node:assert/strict'
import { chmod, lstat, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ChimeraBrowserRuntime } from '../src/browser/runtime.mjs'
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
    agentDiscovery: { async discover() { return { schema: 'chimera.agent-discovery.v1', source: { id: 'hermes-aws' }, candidates: [] } } },
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
    agentDiscovery: { async discover() { return { schema: 'chimera.agent-discovery.v1', source: { id: 'hermes-aws' }, candidates: [] } } },
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
        return { schema: 'chimera.agent-discovery.v1', source: { id: 'hermes-aws' }, candidates: [] }
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
