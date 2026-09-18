import crypto from 'node:crypto'
import { access, mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ChimeraBrowserRuntime } from '../../src/browser/runtime.mjs'
import { createDeterministicModelRouter } from '../../src/ceo/model-router.mjs'

const ARTIFACT_CONTENT = 'Chimera foundation acceptance artifact\n'

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

function fixtureModelRegistry() {
  const router = createDeterministicModelRouter({
    routerId: 'model-fabric:acceptance:deterministic',
    responder: async (_prompt, context) => {
      if (context.stage === 'decompose') {
        return {
          tasks: [{
            specialistAgentId: 'ace',
            objective: context.objective ?? 'Verify the bounded worker path.',
            acceptanceCriteria: ['Read continuity.', 'Write only after signed approval.'],
          }],
        }
      }
      if (context.stage === 'specialist-loop') {
        if (context.loop.turn === 1) {
          return {
            status: 'tool_request',
            summary: 'Read the bounded continuity mount.',
            toolCall: { name: 'read', arguments: { path: 'mounts/memory/MEMORY.md' } },
          }
        }
        if (context.loop.turn === 2) {
          return {
            status: 'tool_request',
            summary: 'Create the acceptance artifact after operator approval.',
            toolCall: { name: 'write', arguments: { path: 'scratch/foundation-result.txt', content: ARTIFACT_CONTENT } },
          }
        }
        const write = context.loop.observations.find((observation) => observation.tool === 'write')
        if (write?.status !== 'completed') {
          throw Object.assign(new Error('FOUNDATION_RESTART_INTERRUPTED_TOOL'), { code: 'FOUNDATION_RESTART_INTERRUPTED_TOOL' })
        }
        return { status: 'completed', summary: 'Ace produced the approved bounded artifact.' }
      }
      return { summary: 'RJ verified the specialist result and retained the audit evidence.' }
    },
  })
  return {
    state: () => ({
      schema: 'chimera.model-provider-registry.v2',
      selected: { providerId: 'acceptance', providerName: 'Acceptance', model: 'deterministic', modelName: 'Deterministic' },
      providers: [{
        id: 'acceptance',
        name: 'Acceptance',
        configured: true,
        models: [{ id: 'deterministic', name: 'Deterministic', availability: 'verified-route', capabilities: ['conversation'] }],
      }],
    }),
    router: () => router,
    async routerFor() { return router },
    async select() {},
  }
}

function fixtureDiscovery() {
  return {
    async discover() {
      return {
        schema: 'chimera.agent-discovery.v1',
        source: { id: 'foundation-hermes', type: 'hermes-fixture', host: 'acceptance' },
        candidates: [{
          schema: 'chimera.hermes-agent-candidate.v1',
          candidateId: 'foundation-hermes:rj',
          profileId: 'rj',
          displayName: 'RJ',
          sourceRef: 'hermes://acceptance/profiles/rj',
          defaultRole: 'Team CEO',
          defaultCapabilities: ['orchestration'],
        }, {
          schema: 'chimera.hermes-agent-candidate.v1',
          candidateId: 'foundation-hermes:ace',
          profileId: 'ace',
          displayName: 'Ace',
          sourceRef: 'hermes://acceptance/profiles/ace',
          defaultRole: 'Foundation specialist',
          defaultCapabilities: ['coding', 'review'],
        }],
      }
    },
  }
}

const referenceProvider = {
  async materialize(_reference, { kind }) {
    if (kind === 'persona') return [{ path: 'SOUL.md', content: 'Act with evidence and stay within Rod\'s grant.' }]
    if (kind === 'memory') return [{ path: 'MEMORY.md', content: 'Chimera acceptance continuity is bounded and read only.' }]
    return [{ path: 'foundation/SKILL.md', content: 'Read first. Write only after signed approval.' }]
  },
}

function runtimeOptions(rootDir, now) {
  return {
    profileDir: resolve(rootDir, 'browser/ceo'),
    modelRegistry: fixtureModelRegistry(),
    agentDiscovery: fixtureDiscovery(),
    agentReferenceProvider: referenceProvider,
    browserExecutor: memoryBrowserExecutor(),
    now,
  }
}

async function waitFor(label, read, predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = read()
    if (predicate(value)) return value
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
  }
  throw Object.assign(new Error(`FOUNDATION_ACCEPTANCE_TIMEOUT_${label}`), { code: `FOUNDATION_ACCEPTANCE_TIMEOUT_${label}` })
}

async function exists(path) {
  try { await access(path); return true } catch { return false }
}

export async function runFoundationAcceptance({ rootDir, now = () => Date.now() } = {}) {
  if (typeof rootDir !== 'string' || rootDir.length === 0) throw new TypeError('FOUNDATION_ACCEPTANCE_ROOT_REQUIRED')
  const root = resolve(rootDir)
  await mkdir(root, { recursive: true, mode: 0o700 })
  const artifactPath = resolve(root, 'agents/workspaces/ace/scratch/foundation-result.txt')
  let first
  let restarted
  try {
    first = new ChimeraBrowserRuntime(runtimeOptions(root, now))
    await first.start()
    const preview = await first.discoverAgents()
    await first.importMainAgent({ discoveryId: preview.discoveryId, candidateId: 'foundation-hermes:rj' })
    await first.importAgents({
      discoveryId: preview.discoveryId,
      agents: [{ candidateId: 'foundation-hermes:ace' }],
    })

    const submitted = await first.sendMessage({
      content: 'Run the foundation task and interrupt at the consequential write approval.',
      recipientAgentId: 'ceo',
    })
    const primaryTaskId = submitted.task.taskId
    const restartPending = await waitFor(
      'PRIMARY_APPROVAL',
      () => first.decisions.pending().find((decision) => decision.actionDiff?.tool === 'write'),
      Boolean,
    )
    const writeBeforeApproval = await exists(artifactPath)
    const readAuthorized = first.audit.entries().some((entry) => (
      entry.fact.kind === 'dsh.tool.authorized' && entry.fact.agentId === 'ace' && entry.fact.toolName === 'read'
    ))
    await first.close()
    const primaryTask = first.tasks.get(primaryTaskId)
    first = null

    restarted = new ChimeraBrowserRuntime(runtimeOptions(root, now))
    await restarted.start()
    const restartDecision = restarted.decisions.get(restartPending.actionId)
    const recovery = await restarted.sendMessage({
      content: 'Recover explicitly and finish the same bounded foundation proof.',
      recipientAgentId: 'ceo',
    })
    const recoveryTaskId = recovery.task.taskId
    const recoveryPending = await waitFor(
      'RECOVERY_APPROVAL',
      () => restarted.decisions.pending().find((decision) => decision.actionDiff?.tool === 'write'),
      Boolean,
    )
    await restarted.decide(recoveryPending.actionId, 'approve')
    const recoveryDecision = restarted.decisions.get(recoveryPending.actionId)
    const recoveryTask = await restarted.waitForTask(recoveryTaskId)
    const artifactContent = await readFile(artifactPath, 'utf8')
    const audit = restarted.audit.verify()
    const writeAfterApproval = restarted.audit.entries().some((entry) => (
      entry.fact.kind === 'dsh.tool.result' && entry.fact.agentId === 'ace'
        && entry.fact.toolName === 'write' && entry.fact.outcome === 'success'
    ))
    const result = {
      schema: 'chimera.foundation-acceptance.v1',
      passed: primaryTask.status === 'failed'
        && restartDecision?.status === 'cancelled'
        && recoveryTask.status === 'completed'
        && recoveryDecision.status === 'approved'
        && readAuthorized
        && !writeBeforeApproval
        && writeAfterApproval
        && audit.valid,
      actors: ['rod', 'ceo', 'ace'],
      primaryTask: { taskId: primaryTask.taskId, status: primaryTask.status, failureCode: primaryTask.failure?.code ?? null },
      restartDecision: { actionId: restartDecision.actionId, status: restartDecision.status, reason: restartDecision.reason },
      recoveryTask: { taskId: recoveryTask.taskId, status: recoveryTask.status, summary: recoveryTask.summary },
      recoveryDecision: { actionId: recoveryDecision.actionId, status: recoveryDecision.status },
      boundedTools: { readAuthorized, writeBeforeApproval, writeAfterApproval },
      artifact: {
        bytes: Buffer.byteLength(artifactContent),
        sha256: crypto.createHash('sha256').update(artifactContent).digest('hex'),
      },
      audit: { valid: audit.valid, entries: audit.entries, head: audit.head },
    }
    if (!result.passed) throw Object.assign(new Error('FOUNDATION_ACCEPTANCE_FAILED'), { code: 'FOUNDATION_ACCEPTANCE_FAILED', result })
    return result
  } finally {
    await first?.close()
    await restarted?.close()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rootDir = process.env.CHIMERA_ACCEPTANCE_ROOT
    ?? resolve('.chimera/acceptance', `foundation-${new Date().toISOString().replaceAll(/[:.]/g, '-')}`)
  console.log(JSON.stringify(await runFoundationAcceptance({ rootDir }), null, 2))
}
