import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { MemoryAuditLog } from '../src/audit-log.mjs'
import { DurableProjectRegistry } from '../src/projects/project-registry.mjs'

const execFile = promisify(execFileCallback)

async function git(cwd, ...args) {
  return execFile('git', args, { cwd })
}

async function fixtureRepo(root, name = 'source') {
  const path = join(root, name)
  await mkdir(path, { recursive: true })
  await git(path, 'init', '-b', 'main')
  await git(path, 'config', 'user.name', 'Chimera Test')
  await git(path, 'config', 'user.email', 'chimera@example.invalid')
  await writeFile(join(path, 'README.md'), '# Fixture\n')
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

test('local project intake persists one canonical Git source and rejects boundary escapes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chimera-project-registry-'))
  const outside = await mkdtemp(join(tmpdir(), 'chimera-project-outside-'))
  try {
    const repository = await fixtureRepo(root)
    const outsideRepository = await fixtureRepo(outside)
    const filePath = join(root, 'state/projects.json')
    const audit = new MemoryAuditLog()
    let registry = await DurableProjectRegistry.open({
      filePath,
      managedRoot: join(root, 'managed'),
      allowedRoots: [root],
      audit,
      now: () => Date.parse('2026-08-31T20:00:00.000Z'),
    })

    const project = await registry.registerLocal({ name: 'Fixture App', path: repository })
    assert.match(project.projectId, /^fixture-app-[a-f0-9]{8}$/)
    assert.equal(project.name, 'Fixture App')
    assert.equal(project.source.type, 'local')
    assert.equal(project.source.path, await realpath(repository))
    assert.equal(project.defaultBranch, 'main')
    assert.equal(project.status, 'ready')
    assert.equal(project.createdAt, '2026-08-31T20:00:00.000Z')

    await assert.rejects(
      registry.registerLocal({ name: 'Duplicate', path: repository }),
      { code: 'PROJECT_SOURCE_ALREADY_REGISTERED' },
    )
    await assert.rejects(
      registry.registerLocal({ name: 'Outside', path: outsideRepository }),
      { code: 'PROJECT_PATH_OUTSIDE_ALLOWED_ROOTS' },
    )
    await assert.rejects(
      registry.registerLocal({ name: 'Not Git', path: join(root, 'state') }),
      { code: 'PROJECT_GIT_REPOSITORY_REQUIRED' },
    )
    assert.equal((await stat(filePath)).mode & 0o777, 0o600)
    assert.equal(audit.entries().filter((entry) => entry.fact.kind === 'project.registered').length, 1)

    await registry.close()
    registry = await DurableProjectRegistry.open({
      filePath,
      managedRoot: join(root, 'managed'),
      allowedRoots: [root],
      audit,
    })
    assert.deepEqual(registry.list().map(({ projectId, name }) => [projectId, name]), [[project.projectId, 'Fixture App']])
    await registry.close()
  } finally {
    await removeTree(root)
    await removeTree(outside)
  }
})

test('managed project intake creates a private main-branch repository ready for ADE work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chimera-managed-project-'))
  try {
    const audit = new MemoryAuditLog()
    const registry = await DurableProjectRegistry.open({
      filePath: join(root, 'state/projects.json'),
      managedRoot: join(root, 'managed'),
      allowedRoots: [root],
      audit,
    })
    const project = await registry.createManaged({ name: 'New Product' })
    assert.equal(project.source.type, 'managed')
    assert.match(project.source.path, /\/managed\/new-product-[a-f0-9]{8}$/)
    assert.equal((await git(project.source.path, 'branch', '--show-current')).stdout.trim(), 'main')
    assert.equal(await readFile(join(project.source.path, 'README.md'), 'utf8'), '# New Product\n')
    assert.match((await git(project.source.path, 'log', '-1', '--pretty=%s')).stdout.trim(), /Initialize New Product/)
    await registry.close()
  } finally {
    await removeTree(root)
  }
})
