import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { MemoryAuditLog } from '../src/audit-log.mjs'
import { ProjectSessionManager } from '../src/projects/project-session-manager.mjs'

const execFile = promisify(execFileCallback)

test('project identity distinguishes the recorded base from a dirty or advanced checkout across reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chimera-project-identity-'))
  let manager
  try {
    const source = await fixtureRepo(root)
    const base = (await git(source, 'rev-parse', 'HEAD')).stdout.trim()
    const options = { filePath: join(root, 'state/sessions.json'), sessionRoot: join(root, 'sessions'), audit: new MemoryAuditLog() }
    manager = await ProjectSessionManager.open(options)
    const session = await manager.prepare({ taskId: 'task-identity', project: {
      projectId: 'identity-fixture', name: 'Identity Fixture', source: { type: 'local', path: source }, defaultBranch: 'main',
    } })
    assert.equal(typeof manager.identityReceipt, 'function', 'project agents need a runtime-derived identity observation')
    const receipt = await manager.identityReceipt(session.taskId)
    assert.equal(receipt.schema, 'chimera.project-identity.v1')
    assert.equal(receipt.taskId, session.taskId)
    assert.equal(receipt.projectId, 'identity-fixture')
    assert.equal(receipt.baseCommit, base)
    assert.equal(receipt.checkoutCommit, base)
    assert.equal(receipt.matchesBaseCommit, true)
    assert.equal(receipt.hasWorkingTreeChanges, false)
    assert.equal(receipt.hasIgnoredFiles, false)
    assert.equal(receipt.provenance, 'chimera-runtime-git-observation')
    assert.equal(JSON.stringify(receipt).includes(source), false, 'no source host paths in agent receipt')
    assert.equal(JSON.stringify(receipt).includes(session.workspace.path), false)
    assert.equal((await git(session.workspace.repositoryPath, 'status', '--porcelain')).stdout, '')

    await writeFile(join(session.workspace.repositoryPath, 'README.md'), 'changed\n')
    assert.equal((await manager.identityReceipt(session.taskId)).hasWorkingTreeChanges, true)
    await git(session.workspace.repositoryPath, 'add', 'README.md')
    await git(session.workspace.repositoryPath, 'commit', '-m', 'operator advanced isolated checkout')
    const advanced = (await git(session.workspace.repositoryPath, 'rev-parse', 'HEAD')).stdout.trim()
    await manager.close()
    manager = await ProjectSessionManager.open(options)
    const reopened = await manager.identityReceipt(session.taskId)
    assert.equal(reopened.baseCommit, base)
    assert.equal(reopened.checkoutCommit, advanced)
    assert.equal(reopened.matchesBaseCommit, false)
    assert.equal(reopened.hasWorkingTreeChanges, false)
    const priorGitDir = process.env.GIT_DIR
    try {
      process.env.GIT_DIR = join(source, '.git')
      assert.equal((await manager.identityReceipt(session.taskId)).checkoutCommit, advanced, 'ambient Git selection cannot redirect the receipt')
    } finally {
      if (priorGitDir === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = priorGitDir
    }
    await writeFile(join(session.workspace.repositoryPath, 'untracked.txt'), 'new\n')
    assert.equal((await manager.identityReceipt(session.taskId)).hasWorkingTreeChanges, true)
    await rm(join(session.workspace.repositoryPath, 'untracked.txt'))
    await writeFile(join(session.workspace.repositoryPath, '.git/info/exclude'), 'ignored.txt\n')
    await writeFile(join(session.workspace.repositoryPath, 'ignored.txt'), 'not part of the commit\n')
    assert.equal((await manager.identityReceipt(session.taskId)).hasIgnoredFiles, true)
    assert.equal((await git(source, 'rev-parse', 'HEAD')).stdout.trim(), base)
    await assert.rejects(manager.identityReceipt('task-not-found'), { code: 'PROJECT_SESSION_NOT_FOUND' })
    await rename(join(session.workspace.repositoryPath, '.git'), join(root, 'isolated-git'))
    await symlink(join(source, '.git'), join(session.workspace.repositoryPath, '.git'))
    await assert.rejects(manager.identityReceipt(session.taskId), { code: 'PROJECT_IDENTITY_WORKSPACE_INVALID' })
  } finally { await manager?.close(); await removeTree(root) }
})

async function git(cwd, ...args) {
  return execFile('git', args, { cwd, maxBuffer: 2 * 1024 * 1024 })
}

async function fixtureRepo(root) {
  const path = join(root, 'source')
  await mkdir(path, { recursive: true })
  await git(path, 'init', '-b', 'main')
  await git(path, 'config', 'user.name', 'Chimera Test')
  await git(path, 'config', 'user.email', 'chimera@example.invalid')
  await writeFile(join(path, 'README.md'), '# ADE Fixture\n')
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

test('explicit resume preserves uncommitted project artifacts and original review base', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chimera-project-resume-'))
  let manager
  try {
    const source = await fixtureRepo(root)
    const options = { filePath: join(root, 'state/sessions.json'), sessionRoot: join(root, 'sessions'), audit: new MemoryAuditLog() }
    manager = await ProjectSessionManager.open(options)
    const session = await manager.prepare({ taskId: 'task-resume-artifacts', project: {
      projectId: 'fixture-project', name: 'Fixture', source: { type: 'local', path: source }, defaultBranch: 'main',
    } })
    await writeFile(join(session.workspace.repositoryPath, 'partial.txt'), 'completed before cancellation\n')
    await manager.markOutcome(session.taskId, 'failed')
    await manager.close()
    manager = await ProjectSessionManager.open(options)
    const resumed = await manager.resume(session.taskId)
    assert.equal(resumed.workspace.repositoryPath, session.workspace.repositoryPath)
    assert.equal(resumed.baseCommit, session.baseCommit)
    assert.equal(resumed.status, 'working')
    assert.match((await manager.review(session.taskId)).patch, /completed before cancellation/)
    await assert.rejects(readFile(join(source, 'partial.txt')), { code: 'ENOENT' })
    await assert.rejects(manager.resume(session.taskId), { code: 'PROJECT_SESSION_NOT_RESUMABLE' })
  } finally { await manager?.close(); await removeTree(root) }
})

test('project session isolates edits, persists RJ staffing, and applies only an explicit reviewed commit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chimera-project-session-'))
  try {
    const source = await fixtureRepo(root)
    const baseCommit = (await git(source, 'rev-parse', 'HEAD')).stdout.trim()
    const audit = new MemoryAuditLog()
    const filePath = join(root, 'state/sessions.json')
    let manager = await ProjectSessionManager.open({
      filePath,
      sessionRoot: join(root, 'sessions'),
      audit,
      now: () => Date.parse('2026-08-31T21:00:00.000Z'),
    })
    const project = {
      projectId: 'fixture-app-12345678',
      name: 'Fixture App',
      source: { type: 'local', path: source },
      defaultBranch: 'main',
    }

    const session = await manager.prepare({ taskId: 'task-ade-1', project })
    assert.equal(session.status, 'working')
    assert.equal(session.baseCommit, baseCommit)
    assert.equal(session.workspace.relativeRoot, 'scratch/repo')
    assert.notEqual(session.workspace.repositoryPath, source)
    assert.equal(await readFile(join(session.workspace.repositoryPath, 'README.md'), 'utf8'), '# ADE Fixture\n')

    await writeFile(join(session.workspace.repositoryPath, 'src.txt'), 'implemented by Ace\n')
    await assert.rejects(readFile(join(source, 'src.txt')), { code: 'ENOENT' })
    const plan = {
      tasks: [{
        specialistAgentId: 'ace',
        objective: 'Implement the fixture.',
        acceptanceCriteria: ['The file exists.', 'The diff is clean.'],
      }],
    }
    const planned = await manager.recordPlan('task-ade-1', plan)
    assert.equal(planned.plan.tasks[0].specialistAgentId, 'ace')

    const review = await manager.review('task-ade-1')
    assert.deepEqual(review.changedFiles.map(({ path }) => path), ['src.txt'])
    assert.match(review.patch, /implemented by Ace/)
    assert.equal(review.baseCommit, baseCommit)
    assert.equal(review.readyToCommit, false)
    await manager.markOutcome('task-ade-1', 'completed')
    const completedReview = await manager.review('task-ade-1')
    assert.equal(completedReview.readyToCommit, true)
    await assert.rejects(readFile(join(source, 'src.txt')), { code: 'ENOENT' })

    await manager.close()
    manager = await ProjectSessionManager.open({ filePath, sessionRoot: join(root, 'sessions'), audit })
    assert.equal(manager.get('task-ade-1').plan.tasks[0].specialistAgentId, 'ace')

    const delivery = await manager.commit({
      taskId: 'task-ade-1',
      message: 'feat: complete ADE fixture',
      committedBy: 'rod',
      expectedReviewDigest: completedReview.reviewDigest,
    })
    assert.equal(delivery.status, 'committed')
    assert.match(delivery.commit, /^[a-f0-9]{40}$/)
    assert.equal(await readFile(join(source, 'src.txt'), 'utf8'), 'implemented by Ace\n')
    assert.equal((await git(source, 'log', '-1', '--pretty=%s')).stdout.trim(), 'feat: complete ADE fixture')
    assert.equal(audit.entries().some((entry) => entry.fact.kind === 'project.session.committed' && entry.fact.committedBy === 'rod'), true)
    await manager.close()
  } finally {
    await removeTree(root)
  }
})

test('project delivery refuses to overwrite a source repository that changed after session preparation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chimera-project-session-race-'))
  try {
    const source = await fixtureRepo(root)
    const manager = await ProjectSessionManager.open({
      filePath: join(root, 'state/sessions.json'),
      sessionRoot: join(root, 'sessions'),
      audit: new MemoryAuditLog(),
    })
    const project = { projectId: 'race-app-12345678', name: 'Race App', source: { type: 'local', path: source }, defaultBranch: 'main' }
    const session = await manager.prepare({ taskId: 'task-race-1', project })
    await writeFile(join(session.workspace.repositoryPath, 'agent.txt'), 'agent result\n')
    await manager.markOutcome('task-race-1', 'completed')

    await writeFile(join(source, 'human.txt'), 'new human work\n')
    await git(source, 'add', 'human.txt')
    await git(source, 'commit', '-m', 'human change')

    await assert.rejects(
      manager.commit({ taskId: 'task-race-1', message: 'agent change', committedBy: 'rod', expectedReviewDigest: (await manager.review('task-race-1')).reviewDigest }),
      { code: 'PROJECT_SOURCE_CHANGED' },
    )
    await assert.rejects(readFile(join(source, 'agent.txt')), { code: 'ENOENT' })
    await manager.close()
  } finally {
    await removeTree(root)
  }
})

test('project delivery rejects a workspace mutation after review and requires a completed session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chimera-project-review-race-'))
  try {
    const source = await fixtureRepo(root)
    const manager = await ProjectSessionManager.open({
      filePath: join(root, 'state/sessions.json'),
      sessionRoot: join(root, 'sessions'),
      audit: new MemoryAuditLog(),
    })
    const project = { projectId: 'review-race-12345678', name: 'Review Race', source: { type: 'local', path: source }, defaultBranch: 'main' }
    const session = await manager.prepare({ taskId: 'task-review-race', project })
    await writeFile(join(session.workspace.repositoryPath, 'agent.txt'), 'reviewed\n')
    const workingReview = await manager.review('task-review-race')
    assert.equal(workingReview.readyToCommit, false)
    await assert.rejects(
      manager.commit({ taskId: 'task-review-race', message: 'should not commit', committedBy: 'rod', expectedReviewDigest: workingReview.reviewDigest }),
      /PROJECT_SESSION_NOT_COMPLETED/,
    )
    await manager.markOutcome('task-review-race', 'completed')
    const review = await manager.review('task-review-race')
    await writeFile(join(session.workspace.repositoryPath, 'agent.txt'), 'unreviewed\n')
    await assert.rejects(
      manager.commit({ taskId: 'task-review-race', message: 'reject mutation', committedBy: 'rod', expectedReviewDigest: review.reviewDigest }),
      /PROJECT_REVIEW_CHANGED/,
    )
    await assert.rejects(readFile(join(source, 'agent.txt')), { code: 'ENOENT' })
    await manager.close()
  } finally {
    await removeTree(root)
  }
})

test('project review preserves rename status without corrupting the changed-file projection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chimera-project-session-rename-'))
  try {
    const source = await fixtureRepo(root)
    const manager = await ProjectSessionManager.open({
      filePath: join(root, 'state/sessions.json'),
      sessionRoot: join(root, 'sessions'),
      audit: new MemoryAuditLog(),
    })
    const project = { projectId: 'rename-app-12345678', name: 'Rename App', source: { type: 'local', path: source }, defaultBranch: 'main' }
    const session = await manager.prepare({ taskId: 'task-rename-1', project })
    await rename(join(session.workspace.repositoryPath, 'README.md'), join(session.workspace.repositoryPath, 'GUIDE.md'))
    await git(session.workspace.repositoryPath, 'add', '-A')
    const review = await manager.review('task-rename-1')
    assert.deepEqual(review.changedFiles, [{ status: 'R ', path: 'GUIDE.md', previousPath: 'README.md' }])
    assert.match(review.patch, /README\.md/)
    await manager.close()
  } finally {
    await removeTree(root)
  }
})
