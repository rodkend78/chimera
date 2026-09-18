import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { MemoryAuditLog } from '../src/audit-log.mjs'
import { ChimeraBrowserRuntime } from '../src/browser/runtime.mjs'
import { DurableTaskLedger } from '../src/ceo/task-ledger.mjs'
import { DurableProjectRegistry } from '../src/projects/project-registry.mjs'
import { ProjectSessionManager } from '../src/projects/project-session-manager.mjs'
import { DurableTaskAccessLeases } from '../src/projects/task-access-lease.mjs'

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
  await writeFile(join(path, 'README.md'), '# Restart Fixture\n')
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

function modelRegistry() {
  return {
    state: () => ({ schema: 'chimera.model-provider-registry.v2', selected: null, providers: [] }),
    router() { throw new Error('MODEL_NOT_EXPECTED') },
    async select() {},
  }
}

test('restart interrupts project work, revokes its lease, and preserves the source repository', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chimera-project-restart-'))
  try {
    const source = await fixtureRepo(root)
    const audit = new MemoryAuditLog()
    const projectFile = join(root, 'projects/registry.json')
    const projectSessionFile = join(root, 'projects/sessions.json')
    const projectSessionRoot = join(root, 'projects/workspaces')
    const projectLeaseFile = join(root, 'projects/leases.json')
    const taskFile = join(root, 'tasks/events.jsonl')
    const taskId = 'task-restart-acceptance'

    const registry = await DurableProjectRegistry.open({
      filePath: projectFile,
      managedRoot: join(root, 'projects/repositories'),
      allowedRoots: [root],
      audit,
    })
    const project = await registry.registerLocal({ name: 'Restart Fixture', path: source })
    await registry.close()

    const tasks = await DurableTaskLedger.open({ filePath: taskFile, audit })
    await tasks.submit({ taskId, objective: 'Implement a restart-safe change.', model: null })
    await tasks.start(taskId)
    await tasks.close()

    const sessions = await ProjectSessionManager.open({ filePath: projectSessionFile, sessionRoot: projectSessionRoot, audit })
    const session = await sessions.prepare({
      taskId,
      project,
      accessRequest: { profileId: 'connected', networkHosts: [], ttlSeconds: 900 },
    })
    await sessions.recordPlan(taskId, { tasks: [{ specialistAgentId: 'ace', objective: 'Make the change.', acceptanceCriteria: ['Review it.'] }] })
    await writeFile(join(session.workspace.repositoryPath, 'uncommitted.txt'), 'must stay isolated\n')
    await sessions.close()

    const leases = await DurableTaskAccessLeases.open({ filePath: projectLeaseFile, audit })
    await leases.issue({
      taskId,
      agentId: 'ace',
      ceilingProfileId: 'connected',
      requestedProfileId: 'connected',
      ttlSeconds: 900,
      issuedBy: 'rj',
    })
    await leases.close()

    const runtime = new ChimeraBrowserRuntime({
      profileDir: join(root, 'browser/ceo'),
      decisionFile: join(root, 'decisions/queue.jsonl'),
      taskFile,
      conversationFile: join(root, 'conversations/messages.jsonl'),
      modelCallFile: join(root, 'models/events.jsonl'),
      audit,
      auditFile: join(root, 'audit/events.jsonl'),
      identityFile: join(root, 'identity/actors.json'),
      replayFile: join(root, 'gateway/replay.jsonl'),
      modelRegistry: modelRegistry(),
      browserExecutor: memoryBrowserExecutor(),
      projectAllowedRoots: [root],
      projectFile,
      projectManagedRoot: join(root, 'projects/repositories'),
      projectSessionFile,
      projectSessionRoot,
      projectLeaseFile,
    })
    try {
      const state = await runtime.start()
      assert.equal(state.tasks.find((task) => task.taskId === taskId).status, 'interrupted')
      assert.equal(state.projects.sessions.find((entry) => entry.taskId === taskId).status, 'failed')
      assert.equal(state.projects.leases.find((entry) => entry.taskId === taskId).status, 'revoked')
      await assert.rejects(readFile(join(source, 'uncommitted.txt')), { code: 'ENOENT' })
      assert.equal((await git(source, 'status', '--porcelain=v1')).stdout, '')
    } finally {
      await runtime.close()
    }
  } finally {
    await removeTree(root)
  }
})
