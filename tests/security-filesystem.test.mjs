import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHarnessExecutors } from '../src/agents/harness-executors.mjs'
import { removeAgentWorkerWorkspace } from '../src/agents/worker-workspace.mjs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

test('descriptor broker resists alternate parent swaps and exclusive-file collisions', async () => {
  await promisify(execFile)('/usr/bin/python3', ['-I', '-B', fileURLToPath(new URL('./workspace-filesystem-security.py', import.meta.url))])
})

async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'chimera-fs-security-'))
  await fs.mkdir(join(root, 'workers/ace/scratch/nested'), { recursive: true })
  await fs.mkdir(join(root, 'outside'), { mode: 0o700 })
  await fs.writeFile(join(root, 'outside/secret'), 'outside sentinel', { mode: 0o640 })
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = { path: join(root, 'workers/ace') }
  return { root, workspace, context: { workspace, agentId: 'ace' }, tools: createHarnessExecutors({ accessProfileFor: () => 'sandbox' }) }
}

test('workspace cleanup unlinks links without chmod or traversal of their outside targets', async t => {
  const { root, workspace } = await fixture(t)
  await fs.symlink(join(root, 'outside/secret'), join(workspace.path, 'scratch/file-link'))
  await fs.symlink(join(root, 'outside'), join(workspace.path, 'scratch/directory-link'))
  await removeAgentWorkerWorkspace({ rootDir: join(root, 'workers'), agentId: 'ace' })
  assert.equal((await fs.stat(join(root, 'outside/secret'))).mode & 0o777, 0o640)
  assert.equal((await fs.stat(join(root, 'outside'))).mode & 0o777, 0o700)
  assert.equal(await fs.readFile(join(root, 'outside/secret'), 'utf8'), 'outside sentinel')
})

test('cleanup can remove an owned directory whose mode was set to zero', async t => {
  const { workspace, root } = await fixture(t)
  await fs.chmod(join(workspace.path, 'scratch/nested'), 0)
  await removeAgentWorkerWorkspace({ rootDir: join(root, 'workers'), agentId: 'ace' })
  await assert.rejects(fs.stat(workspace.path), { code: 'ENOENT' })
})

test('write ignores an attacker-preplaced old predictable temporary symlink', async t => {
  const { root, workspace, tools, context } = await fixture(t)
  await fs.symlink(join(root, 'outside/secret'), join(workspace.path, `scratch/result.${process.pid}.tmp`))
  await tools.write({ path: 'scratch/result', content: 'legitimate result' }, context)
  assert.equal(await fs.readFile(join(root, 'outside/secret'), 'utf8'), 'outside sentinel')
  assert.equal(await fs.readFile(join(workspace.path, 'scratch/result'), 'utf8'), 'legitimate result')
})

test('safe edits retain executable permissions and reject overlapping ambiguous matches', async t => {
  const { workspace, tools, context } = await fixture(t)
  const path = join(workspace.path, 'scratch/program')
  await fs.writeFile(path, 'aaa', { mode: 0o700 })
  await assert.rejects(tools.edit({ path: 'scratch/program', oldText: 'aa', newText: 'b' }, context), /WORKER_EDIT_MATCH_NOT_UNIQUE/)
  await tools.edit({ path: 'scratch/program', oldText: 'aaa', newText: 'bbb' }, context)
  assert.equal((await fs.stat(path)).mode & 0o777, 0o700)
  assert.equal(await fs.readFile(path, 'utf8'), 'bbb')
})

test('read cannot reopen a path replaced after canonicalization', async t => {
  const { root, workspace, tools, context } = await fixture(t)
  const path = join(workspace.path, 'scratch/nested/secret')
  await fs.writeFile(path, 'inside sentinel')
  const original = fs.realpath
  // Force the old check/use gap; this is a filesystem-boundary double, not a production test hook.
  const mocked = t.mock.method(fs, 'realpath', async value => {
    const result = await original(value)
    if (value === path || value === await original(path).catch(() => null)) {
      mocked.mock.restore(); syncBuiltinESMExports()
      await fs.rename(join(workspace.path, 'scratch/nested'), join(workspace.path, 'scratch/old'))
      await fs.symlink(join(root, 'outside'), join(workspace.path, 'scratch/nested'))
    }
    return result
  })
  syncBuiltinESMExports()
  try {
    const result = await tools.read({ path: 'scratch/nested/secret' }, context).catch(error => ({ error }))
    assert.notEqual(result.content, 'outside sentinel')
    if (!result.error) assert.equal(result.content, 'inside sentinel')
  } finally { mocked.mock.restore(); syncBuiltinESMExports() }
})
