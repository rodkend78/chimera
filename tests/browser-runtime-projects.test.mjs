import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { ChimeraBrowserRuntime } from '../src/browser/runtime.mjs'
import { createDeterministicModelRouter } from '../src/ceo/model-router.mjs'

const execFile = promisify(execFileCallback)

async function git(cwd, ...args) {
  return execFile('git', args, { cwd, maxBuffer: 2 * 1024 * 1024 })
}

async function fixtureRepo(root) {
  const path = join(root, 'source')
  await mkdir(path, { recursive: true })
  await git(path, 'init', '-b', 'main')
  await git(path, 'config', 'user.name', 'Chimera Test')
  await git(path, 'config', 'user.email', 'chimera@example.invalid')
  await writeFile(join(path, 'README.md'), '# Runtime Project\n')
  await git(path, 'add', 'README.md')
  await git(path, 'commit', '-m', 'fixture')
  return path
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

function memoryBrowserExecutor() {
  const state = { running: true, tabs: [{ tabId: 'tab-1', title: 'New tab', url: 'about:blank', active: true }] }
  return {
    async start() { return structuredClone(state) },
    async state() { return structuredClone(state) },
    async suspend() { state.running = false; return structuredClone(state) },
    async close() { state.running = false },
    allowTemporaryNavigation() {},
  }
}

function discovery() {
  return {
    async discover() {
      return {
        schema: 'chimera.agent-discovery.v1',
        source: { id: 'fixture', type: 'fixture', host: 'local' },
        candidates: [
          { schema: 'chimera.hermes-agent-candidate.v1', candidateId: 'fixture:rj', profileId: 'rj', displayName: 'RJ', sourceRef: 'hermes://fixture/profiles/rj' },
          { schema: 'chimera.hermes-agent-candidate.v1', candidateId: 'fixture:ace', profileId: 'ace', displayName: 'Ace', sourceRef: 'hermes://fixture/profiles/ace' },
        ],
      }
    },
  }
}

function referenceProvider() {
  return {
    async materialize(_reference, { kind }) {
      if (kind === 'persona') return [{ path: 'SOUL.md', content: 'Implement bounded work and show evidence.' }]
      if (kind === 'memory') return [{ path: 'MEMORY.md', content: 'Project work stays isolated until Rod commits.' }]
      return [{ path: 'coding/SKILL.md', content: 'Read, edit, test, and review.' }]
    },
  }
}

function modelRegistry(calls) {
  const router = createDeterministicModelRouter({
    routerId: 'model-fabric:ade-acceptance',
    responder: async (_prompt, context) => {
      calls.push(structuredClone(context))
      if (context.stage === 'decompose') {
        return { tasks: [{ specialistAgentId: 'ace', objective: 'Create the requested project artifact.', acceptanceCriteria: ['agent.txt exists', 'The change is reviewable'] }] }
      }
      if (context.stage === 'specialist-loop') {
        if (context.loop.turn === 1) return { status: 'tool_request', summary: 'Inspect the project.', toolCall: { name: 'read', arguments: { path: 'scratch/repo/README.md' } } }
        if (context.loop.turn === 2 || context.loop.turn === 4) return { status: 'tool_request', summary: 'Identify the current project snapshot.', toolCall: { name: 'read', arguments: { path: context.project.identityReceiptPath ?? 'mounts/project/identity.json' } } }
        if (context.loop.turn === 3) return { status: 'tool_request', summary: 'Create the implementation.', toolCall: { name: 'write', arguments: { path: 'scratch/repo/agent.txt', content: 'implemented by Ace\n' } } }
        return { status: 'completed', summary: 'Ace implemented the isolated project change.' }
      }
      return { summary: 'RJ reviewed Ace’s attributed project result.' }
    },
  })
  return {
    state: () => ({
      schema: 'chimera.model-provider-registry.v2',
      selected: { providerId: 'fixture', providerName: 'Fixture', model: 'ade', modelName: 'ADE' },
      providers: [{ id: 'fixture', name: 'Fixture', configured: true, models: [{ id: 'ade', name: 'ADE', availability: 'verified-route', capabilities: ['conversation'] }] }],
    }),
    router: () => router,
    async routerFor() { return router },
    async select() {},
  }
}

async function waitFor(read, predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (predicate(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('PROJECT_RUNTIME_TIMEOUT')
}

test('RJ staffs an imported agent into an isolated project task, revokes its lease, and exposes a reviewed commit', { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'chimera-runtime-project-'))
  try {
    const source = await fixtureRepo(root)
    const calls = []
    const runtime = new ChimeraBrowserRuntime({
      profileDir: join(root, 'browser/ceo'),
      browserExecutor: memoryBrowserExecutor(),
      modelRegistry: modelRegistry(calls),
      agentDiscovery: discovery(),
      agentReferenceProvider: referenceProvider(),
      projectAllowedRoots: [root],
      projectFile: join(root, 'projects/registry.json'),
      projectManagedRoot: join(root, 'projects/repositories'),
      projectSessionFile: join(root, 'projects/sessions.json'),
      projectSessionRoot: join(root, 'projects/workspaces'),
      projectLeaseFile: join(root, 'projects/leases.json'),
    })
    try {
      await runtime.start()
      const preview = await runtime.discoverAgents()
      await runtime.importMainAgent({ discoveryId: preview.discoveryId, candidateId: 'fixture:rj' })
      await runtime.importAgents({ discoveryId: preview.discoveryId, agents: [{ candidateId: 'fixture:ace' }] })

      const project = await runtime.registerProject({ mode: 'local', name: 'Runtime Project', path: source, networkHosts: [] })
      await assert.rejects(
        runtime.submitProjectTask({
          projectId: project.projectId,
          objective: 'Try an unapproved host.',
          access: { profileId: 'connected', networkHosts: ['docs.example.com'], ttlSeconds: 900 },
        }),
        { code: 'PROJECT_ACCESS_HOST_NOT_APPROVED' },
      )
      const submitted = await runtime.submitProjectTask({
        projectId: project.projectId,
        objective: 'Have Ace implement and verify agent.txt.',
        access: { profileId: 'sandbox', networkHosts: [], ttlSeconds: 900 },
      })
      const decision = await waitFor(
        async () => (await runtime.state()).decisions.find((entry) => entry.resource === 'dsh-tool:write'),
        Boolean,
      )
      const cancelledQueued = await runtime.submitProjectTask({ projectId: project.projectId, objective: 'Cancel this queued job only.' })
      await runtime.cancelTask({ taskId: cancelledQueued.taskId })
      assert.equal(runtime.decisions.get(decision.actionId).status, 'pending')
      assert.equal((await runtime.decide(decision.actionId, 'approve')).status, 'allowed')
      const completed = await runtime.waitForTask(submitted.taskId)
      assert.equal(completed.status, 'completed', JSON.stringify(completed.failure))

      const state = await runtime.state()
      assert.equal(state.projects.projects[0].projectId, project.projectId)
      assert.equal(state.projects.sessions[0].plan.tasks[0].specialistAgentId, 'ace')
      assert.equal(state.projects.sessions[0].status, 'completed')
      assert.equal(state.projects.leases[0].status, 'revoked')
      assert.equal(calls.find((call) => call.stage === 'decompose').project.relativeRoot, 'scratch/repo')
      assert.equal(calls.find((call) => call.stage === 'specialist-loop').project.projectId, project.projectId)
      assert.equal(calls.find((call) => call.stage === 'specialist-loop').project.identityReceiptPath, 'mounts/project/identity.json')
      // The recorded tool observations must include both the clean and
      // modified checkout, rather than trusting the model's summary.
      const taskEvents = (await readFile(runtime.taskFile, 'utf8')).trim().split('\n').map(JSON.parse)
      const identities = taskEvents.filter(event => event.taskId === submitted.taskId
        && event.checkpoint?.stage === 'tool-completed'
        && event.checkpoint.observation?.result?.path === 'mounts/project/identity.json')
        .map(event => JSON.parse(event.checkpoint.observation.result.content))
      assert.equal(identities.length, 2)
      assert.equal(identities[0].baseCommit, (await git(source, 'rev-parse', 'HEAD')).stdout.trim())
      assert.equal(identities[0].hasWorkingTreeChanges, false)
      assert.equal(identities[1].hasWorkingTreeChanges, true)

      const review = await runtime.projectReview(submitted.taskId)
      assert.deepEqual(review.changedFiles.map(({ path }) => path), ['agent.txt'])
      assert.match(review.patch, /implemented by Ace/)
      await assert.rejects(readFile(join(source, 'agent.txt')), { code: 'ENOENT' })

      const delivery = await runtime.commitProjectSession({ taskId: submitted.taskId, message: 'feat: accept Ace project work', expectedReviewDigest: review.reviewDigest })
      assert.equal(delivery.status, 'committed')
      assert.equal(await readFile(join(source, 'agent.txt'), 'utf8'), 'implemented by Ace\n')
    } finally {
      await runtime.close()
    }
  } finally {
    await removeTree(root)
  }
})

test('project queue advances FIFO without preparing queued workspaces or running cancelled jobs', { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'chimera-project-queue-runtime-'))
  const { promise: gate, resolve: release } = Promise.withResolvers()
  let runtime
  const planned = []
  try {
    const source = await fixtureRepo(root)
    const router = createDeterministicModelRouter({ routerId: 'model-fabric:queue-fixture', responder: async (prompt, context) => {
      if (context.stage === 'decompose') {
        planned.push(prompt)
        if (planned.length === 1) await gate
        return { tasks: [{ specialistAgentId: 'ace', objective: 'Inspect only.', acceptanceCriteria: ['Return summary'] }] }
      }
      if (context.stage === 'specialist-loop') return { status: 'completed', summary: 'Read-only specialist result.' }
      return { summary: 'Read-only project result.' }
    } })
    runtime = new ChimeraBrowserRuntime({ profileDir: join(root, 'browser/ceo'), browserExecutor: memoryBrowserExecutor(),
      agentDiscovery: discovery(), agentReferenceProvider: referenceProvider(),
      modelRegistry: { ...modelRegistry([]), router: () => router, routerFor: async () => router }, projectAllowedRoots: [root] })
    await runtime.start()
    const preview = await runtime.discoverAgents()
    await runtime.importAgents({ discoveryId: preview.discoveryId, agents: [{ candidateId: 'fixture:ace' }] })
    const project = await runtime.registerProject({ mode: 'local', name: 'Queue project', path: source })
    const otherSource = await fixtureRepo(join(root, 'other'))
    const otherProject = await runtime.registerProject({ mode: 'local', name: 'Separate project', path: otherSource })
    const first = await runtime.submitProjectTask({ projectId: project.projectId, objective: 'First project task' })
    await waitFor(() => planned.length, count => count === 1)
    const second = await runtime.submitProjectTask({ projectId: project.projectId, objective: 'Cancelled project task' })
    const third = await runtime.submitProjectTask({ projectId: otherProject.projectId, objective: 'Third project task' })
    assert.equal(runtime.projectSessions.get(third.taskId), null)
    assert.equal(runtime.tasks.get(third.taskId).status, 'queued')
    await runtime.cancelTask({ taskId: second.taskId })
    assert.equal(runtime.tasks.get(first.taskId).status, 'running')
    release()
    const firstResult = await runtime.waitForTask(first.taskId)
    assert.equal(firstResult.status, 'completed', JSON.stringify(firstResult.failure))
    const thirdResult = await runtime.waitForTask(third.taskId)
    assert.equal(thirdResult.status, 'completed', JSON.stringify(thirdResult.failure))
    assert.deepEqual(planned, ['First project task', 'Third project task'])
    assert.equal(runtime.projectSessions.get(second.taskId), null)
    assert.equal(runtime.projectSessions.get(third.taskId).status, 'completed')
    assert.equal(runtime.projectSessions.get(third.taskId).projectId, otherProject.projectId)
    assert.notEqual(runtime.projectSessions.get(first.taskId).workspace.path, runtime.projectSessions.get(third.taskId).workspace.path)
    const continued = await runtime.continueTask({ taskId: second.taskId, objective: 'Explicitly continue the cancelled unstarted job' })
    const continuedResult = await runtime.waitForTask(continued.taskId)
    assert.equal(continuedResult.status, 'completed', JSON.stringify(continuedResult.failure))
    assert.equal(runtime.projectSessions.get(continued.taskId).projectId, project.projectId)
  } finally { release(); await runtime?.close(); await removeTree(root) }
})

test('shutdown retains queued jobs and restart requires an explicit project-queue resume', { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'chimera-project-queue-restart-'))
  const { promise: gate, resolve: release } = Promise.withResolvers()
  const planned = []
  let runtime
  try {
    const source = await fixtureRepo(root)
    const router = createDeterministicModelRouter({ routerId: 'model-fabric:queue-restart-fixture', responder: async (prompt, context) => {
      if (context.stage === 'decompose') {
        planned.push(prompt)
        if (planned.length === 1) await gate
        return { tasks: [{ specialistAgentId: 'ace', objective: 'Inspect only.', acceptanceCriteria: ['Return summary'] }] }
      }
      if (context.stage === 'specialist-loop') return { status: 'completed', summary: 'Read-only specialist result.' }
      return { summary: 'Read-only project result.' }
    } })
    const makeRuntime = () => new ChimeraBrowserRuntime({ profileDir: join(root, 'browser/ceo'), browserExecutor: memoryBrowserExecutor(),
      agentDiscovery: discovery(), agentReferenceProvider: referenceProvider(),
      modelRegistry: { ...modelRegistry([]), router: () => router, routerFor: async () => router }, projectAllowedRoots: [root] })
    runtime = makeRuntime()
    await runtime.start()
    const preview = await runtime.discoverAgents()
    await runtime.importAgents({ discoveryId: preview.discoveryId, agents: [{ candidateId: 'fixture:ace' }] })
    const project = await runtime.registerProject({ mode: 'local', name: 'Recovery project', path: source })
    await runtime.submitProjectTask({ projectId: project.projectId, objective: 'Stop this in-flight task' })
    await waitFor(() => planned.length, count => count === 1)
    const queued = await runtime.submitProjectTask({ projectId: project.projectId, objective: 'Resume this unstarted task' })
    const closing = runtime.close()
    release()
    await closing
    runtime = makeRuntime()
    await runtime.start()
    const state = await runtime.state()
    assert.equal(state.tasks.find(row => row.taskId === queued.taskId).recoveryRequired, true)
    assert.equal(planned.length, 1)
    assert.equal(runtime.projectSessions.get(queued.taskId), null)
    await runtime.resumeQueuedTask({ taskId: queued.taskId })
    const recovered = await runtime.waitForTask(queued.taskId)
    assert.equal(recovered.status, 'completed', JSON.stringify(recovered.failure))
    assert.deepEqual(planned, ['Stop this in-flight task', 'Resume this unstarted task'])
  } finally { release(); await runtime?.close(); await removeTree(root) }
})
