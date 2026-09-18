import crypto from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { ChimeraBrowserRuntime } from '../../src/browser/runtime.mjs'
import { createDeterministicModelRouter } from '../../src/ceo/model-router.mjs'
import { DurableFileAuditLog } from '../../src/audit/durable-file-log.mjs'

const execFile = promisify(execFileCallback)
const ARTIFACT = 'implemented by Ace\n'

async function git(cwd, ...args) {
  return execFile('git', args, { cwd, maxBuffer: 2 * 1024 * 1024 })
}

async function fixtureRepo(root) {
  const path = join(root, 'source')
  await mkdir(path, { recursive: true, mode: 0o700 })
  await git(path, 'init', '-b', 'main')
  await git(path, 'config', 'user.name', 'Chimera Acceptance')
  await git(path, 'config', 'user.email', 'chimera-acceptance@localhost.invalid')
  await writeFile(join(path, 'README.md'), '# ADE acceptance fixture\n', { mode: 0o600 })
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
        source: { id: 'ade-acceptance', type: 'fixture', host: 'local' },
        candidates: [
          {
            schema: 'chimera.hermes-agent-candidate.v1',
            candidateId: 'ade-acceptance:rj',
            profileId: 'rj',
            displayName: 'RJ',
            sourceRef: 'hermes://ade-acceptance/profiles/rj',
            defaultRole: 'Team CEO',
            defaultCapabilities: ['orchestration', 'coding', 'research'],
          },
          {
            schema: 'chimera.hermes-agent-candidate.v1',
            candidateId: 'ade-acceptance:ace',
            profileId: 'ace',
            displayName: 'Ace',
            sourceRef: 'hermes://ade-acceptance/profiles/ace',
            defaultRole: 'Project implementation specialist',
            defaultCapabilities: ['coding', 'review'],
          },
        ],
      }
    },
  }
}

function referenceProvider() {
  return {
    async materialize(_reference, { kind }) {
      if (kind === 'persona') return [{ path: 'SOUL.md', content: 'Use evidence and stay within Rod\'s grant.\n' }]
      if (kind === 'memory') return [{ path: 'MEMORY.md', content: 'Project changes remain isolated until Rod commits.\n' }]
      return [{ path: 'coding/SKILL.md', content: 'Read, implement, test, and review.\n' }]
    },
  }
}

function modelRegistry() {
  const router = createDeterministicModelRouter({
    routerId: 'model-fabric:ade-acceptance',
    responder: async (_prompt, context) => {
      if (context.stage === 'decompose') {
        return {
          tasks: [{
            specialistAgentId: 'ace',
            objective: 'Create the requested project artifact.',
            acceptanceCriteria: ['agent.txt exists', 'The change is reviewable'],
          }],
        }
      }
      if (context.stage === 'specialist-loop') {
        if (context.loop.turn === 1) {
          return {
            status: 'tool_request',
            summary: 'Inspect the project fixture.',
            toolCall: { name: 'read', arguments: { path: 'scratch/repo/README.md' } },
          }
        }
        if (context.loop.turn === 2) {
          return {
            status: 'tool_request',
            summary: 'Create the implementation after operator approval.',
            toolCall: { name: 'write', arguments: { path: 'scratch/repo/agent.txt', content: ARTIFACT } },
          }
        }
        const write = context.loop.observations.find((observation) => observation.tool === 'write')
        if (write?.status !== 'completed') {
          const error = new Error('ADE_ACCEPTANCE_INTERRUPTED_BEFORE_WRITE')
          error.code = 'ADE_ACCEPTANCE_INTERRUPTED_BEFORE_WRITE'
          throw error
        }
        return { status: 'completed', summary: 'Ace implemented the isolated project change.' }
      }
      return { summary: 'RJ reviewed Ace\'s attributed project result.' }
    },
  })
  return {
    state: () => ({
      schema: 'chimera.model-provider-registry.v2',
      selected: { providerId: 'fixture', providerName: 'Fixture', model: 'ade', modelName: 'ADE' },
      providers: [{
        id: 'fixture',
        name: 'Fixture',
        configured: true,
        models: [{ id: 'ade', name: 'ADE', availability: 'verified-route', capabilities: ['conversation'] }],
      }],
    }),
    router: () => router,
    async routerFor() { return router },
    async select() {},
  }
}

async function runtimeOptions(root) {
  return {
    // This acceptance fixture must never inherit the operator's remote audit
    // writer. Reopen the same local chain to test real restart persistence.
    audit: await DurableFileAuditLog.open({ filePath: join(root, 'audit/events.jsonl') }),
    profileDir: join(root, 'browser/ceo'),
    browserExecutor: memoryBrowserExecutor(),
    modelRegistry: modelRegistry(),
    agentDiscovery: discovery(),
    agentReferenceProvider: referenceProvider(),
    projectAllowedRoots: [root],
    projectFile: join(root, 'projects/registry.json'),
    projectManagedRoot: join(root, 'projects/repositories'),
    projectSessionFile: join(root, 'projects/sessions.json'),
    projectSessionRoot: join(root, 'projects/workspaces'),
    projectLeaseFile: join(root, 'projects/leases.json'),
  }
}

async function waitFor(label, read, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (predicate(value)) return value
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
  }
  const error = new Error(`ADE_ACCEPTANCE_TIMEOUT_${label}`)
  error.code = `ADE_ACCEPTANCE_TIMEOUT_${label}`
  throw error
}

async function exists(path) {
  try { await access(path); return true } catch { return false }
}

export async function runAdeAcceptance({ rootDir } = {}) {
  const parent = rootDir ? resolve(rootDir) : tmpdir()
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const root = await mkdtemp(join(parent, 'chimera-ade-acceptance-'))
  let first
  let restarted
  let primaryTaskId
  const failures = []
  try {
    const source = await fixtureRepo(root)
    first = new ChimeraBrowserRuntime(await runtimeOptions(root))
    await first.start()
    const preview = await first.discoverAgents()
    await first.importMainAgent({ discoveryId: preview.discoveryId, candidateId: 'ade-acceptance:rj' })
    await first.importAgents({ discoveryId: preview.discoveryId, agents: [{ candidateId: 'ade-acceptance:ace' }] })
    const project = await first.registerProject({ mode: 'local', name: 'ADE acceptance fixture', path: source })

    const primary = await first.submitProjectTask({
      projectId: project.projectId,
      objective: 'Have Ace implement and verify agent.txt.',
      access: { profileId: 'sandbox', networkHosts: [], ttlSeconds: 900 },
    })
    primaryTaskId = primary.taskId
    const pending = await waitFor(
      'PRIMARY_APPROVAL',
      async () => (await first.state()).decisions.find((entry) => entry.actionDiff?.tool === 'write'),
      Boolean,
    )
    const sourceUntouchedBeforeRestart = !(await exists(join(source, 'agent.txt')))
    await first.close()
    const primaryBeforeRestart = first.tasks.get(primaryTaskId)
    first = null

    restarted = new ChimeraBrowserRuntime(await runtimeOptions(root))
    await restarted.start()
    const primaryAfterRestart = restarted.tasks.get(primaryTaskId)
    const failedSession = restarted.projectSessions.get(primaryTaskId)
    const recovery = await restarted.submitProjectTask({
      projectId: project.projectId,
      objective: 'Recover the bounded project proof and implement agent.txt.',
      access: { profileId: 'sandbox', networkHosts: [], ttlSeconds: 900 },
    })
    const recoveryPending = await waitFor(
      'RECOVERY_APPROVAL',
      async () => (await restarted.state()).decisions.find((entry) => entry.actionDiff?.tool === 'write'),
      Boolean,
    )
    const approval = await restarted.decide(recoveryPending.actionId, 'approve')
    const recoveryTask = await restarted.waitForTask(recovery.taskId)
    const recoverySession = restarted.projectSessions.get(recovery.taskId)
    const recoveryLease = restarted.taskAccessLeases.list().find((lease) => lease.taskId === recovery.taskId)
    const review = await restarted.projectReview(recovery.taskId)
    const sourceUntouchedBeforeCommit = !(await exists(join(source, 'agent.txt')))
    const delivery = await restarted.commitProjectSession({
      taskId: recovery.taskId,
      message: 'feat: accept bounded ADE project work',
      expectedReviewDigest: review.reviewDigest,
    })
    const sourceContent = await readFile(join(source, 'agent.txt'), 'utf8')
    const sourceHead = (await git(source, 'rev-parse', 'HEAD')).stdout.trim()
    const audit = restarted.audit.verify()
    const toolApproval = restarted.audit.entries().some((entry) => (
      entry.fact.kind === 'dsh.tool.authorized' && entry.fact.agentId === 'ace' && entry.fact.toolName === 'write'
    ))
    const result = {
      schema: 'chimera.ade-acceptance.v1',
      passed: primaryBeforeRestart?.status === 'failed'
        && primaryAfterRestart?.status === 'failed'
        && failedSession?.status === 'failed'
        && sourceUntouchedBeforeRestart
        && recoveryTask.status === 'completed'
        && recoverySession?.status === 'completed'
        && recoveryLease?.status === 'revoked'
        && approval.status === 'allowed'
        && review.readyToCommit
        && sourceUntouchedBeforeCommit
        && delivery.status === 'committed'
        && sourceContent === ARTIFACT
        && toolApproval
        && audit.valid,
      actors: ['rod', 'ceo', 'ace'],
      project: { projectId: project.projectId, sourceType: project.source.type },
      primaryTask: {
        taskId: primaryTaskId,
        beforeRestart: primaryBeforeRestart?.status ?? null,
        afterRestart: primaryAfterRestart?.status ?? null,
        sessionAfterRestart: failedSession?.status ?? null,
        approvalActionId: pending.actionId,
      },
      recoveryTask: {
        taskId: recovery.taskId,
        status: recoveryTask.status,
        sessionStatus: recoverySession?.status ?? null,
        leaseStatus: recoveryLease?.status ?? null,
        approved: approval.status === 'allowed',
      },
      review: {
        readyToCommit: review.readyToCommit,
        changedFiles: review.changedFiles.map(({ status, path }) => ({ status, path })),
        digest: review.reviewDigest,
      },
      delivery: { status: delivery.status, commit: delivery.commit, sourceHead },
      safety: { sourceUntouchedBeforeRestart, sourceUntouchedBeforeCommit, toolApproval, auditValid: audit.valid },
    }
    if (!result.passed) {
      const error = new Error('ADE_ACCEPTANCE_FAILED')
      error.code = 'ADE_ACCEPTANCE_FAILED'
      error.result = result
      throw error
    }
    return result
  } catch (error) {
    failures.push(error)
    throw error
  } finally {
    // Every owned resource gets a cleanup attempt, even after partial startup.
    // Keep the original failure first instead of hiding it with a close error.
    for (const cleanup of [() => first?.close(), () => restarted?.close(), () => removeTree(root)]) {
      try { await cleanup() } catch (error) { failures.push(error) }
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, 'ADE acceptance failed; additional cleanup errors retained', { cause: failures[0] })
    }
    if (failures.length === 1) throw failures[0]
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await runAdeAcceptance(), null, 2))
}
