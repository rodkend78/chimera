import assert from 'node:assert/strict'
import test from 'node:test'
import { chmod, mkdtemp, open, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexSessionBindings } from '../src/ceo/codex-session-bindings.mjs'
import { createCodexSubscriptionModelRouter } from '../src/ceo/codex-subscription-provider.mjs'

const key = 'a'.repeat(64)
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-codex-bindings-'))
  const stores = []
  const filePath = join(directory, 'sessions.jsonl')
  t.after(async () => { for (const store of stores) await store.close(); await rm(directory, { recursive: true, force: true }) })
  return { filePath, directory, async open() { const store = await CodexSessionBindings.open({ filePath }); stores.push(store); return store } }
}

test('durable bindings recover completed turns, fence unknown outcomes, and reject stale physical leases', async t => {
  const f = await fixture(t), store = await f.open()
  const first = await store.begin(key)
  assert.equal(first.threadId, null)
  await assert.rejects(store.begin(key), { code: 'CODEX_SESSION_BUSY' })
  await store.complete(first, 'thread-1')
  await assert.rejects(store.complete(first, 'thread-stale'), { code: 'CODEX_SESSION_LEASE_INVALID' })
  await store.close()
  await assert.rejects(store.begin(key), { code: 'CODEX_SESSION_STORE_CLOSED' })
  const recovered = await f.open()
  const resumed = await recovered.begin(key)
  assert.equal(resumed.threadId, 'thread-1')
  await recovered.close() // process ends with an uncommitted native turn
  const interrupted = await f.open()
  await assert.rejects(interrupted.begin(key), { code: 'CODEX_SESSION_OUTCOME_UNKNOWN' })
  assert.equal((await stat(f.filePath)).mode & 0o777, 0o600)
})

test('durable binding path has one in-process writer, including parent path aliases', async t => {
  const f = await fixture(t)
  await f.open()
  await assert.rejects(f.open(), { code: 'CODEX_SESSION_STORE_ALREADY_OPEN' })
  const alias = `${f.directory}-alias`
  await symlink(f.directory, alias)
  t.after(() => rm(alias))
  await assert.rejects(CodexSessionBindings.open({ filePath: join(alias, 'sessions.jsonl') }), { code: 'CODEX_SESSION_STORE_ALREADY_OPEN' })
})

test('corrupt, truncated, or public session evidence is rejected instead of silently resetting continuity', async t => {
  const f = await fixture(t), store = await f.open()
  await store.complete(await store.begin(key), 'thread-1')
  await store.close()
  const valid = await readFile(f.filePath, 'utf8')
  for (const bad of [valid.replace('thread-1', 'thread-2'), valid.slice(0, -3), valid.split('\n')[1] + '\n']) {
    await writeFile(f.filePath, bad)
    await assert.rejects(f.open(), { code: 'CODEX_SESSION_JOURNAL_INVALID' })
  }
  await writeFile(f.filePath, valid)
  await chmod(f.filePath, 0o644)
  await assert.rejects(f.open(), { code: 'CODEX_SESSION_FILE_UNSAFE' })
})

test('a rebuilt router resumes only the same model and configuration from retained bindings', async t => {
  const f = await fixture(t), starts = [], resumes = []
  const thread = id => ({ id, run: async () => ({ finalResponse: '{"summary":"Done"}' }) })
  const codex = {
    startThread(options) { starts.push(options); return thread(`thread-${starts.length}`) },
    resumeThread(id, options) { resumes.push({ id, options }); return thread(id) },
  }
  const scope = { rootTaskId: 'task-1', agentId: 'ace', assignmentId: 'job-1', projectId: 'project-1' }
  const run = (store, settings = {}) => createCodexSubscriptionModelRouter({ codex, ...settings })
    .route('Finish', { stage: 'specialist' }, { sessionScope: scope, sessionBindings: store })
  const first = await f.open(); await run(first); await first.close()
  const recovered = await f.open()
  await run(recovered)
  assert.equal(resumes[0].id, 'thread-1')
  await run(recovered, { model: 'gpt-5.6-terra' })
  await run(recovered, { workingDirectory: '/different-workspace' })
  await run(recovered, { reasoningEffort: 'low' })
  assert.equal(starts.length, 4)
  assert.equal(resumes.length, 1)
  assert.doesNotMatch(await readFile(f.filePath, 'utf8'), /Finish|Done|project-1|gpt-5/)
})

test('a failed durable reservation prevents native dispatch and poisons further writes', async t => {
  const f = await fixture(t), store = await f.open()
  const inspection = await open(f.filePath, 'r')
  const prototype = Object.getPrototypeOf(inspection)
  await inspection.close()
  const sync = t.mock.method(prototype, 'sync', async () => { throw Object.assign(new Error('disk failure'), { code: 'EIO' }) })
  let starts = 0
  const router = createCodexSubscriptionModelRouter({ codex: { startThread() { starts++; throw new Error('must not dispatch') } } })
  await assert.rejects(router.route('Finish', { stage: 'specialist' }, {
    sessionScope: { rootTaskId: 'task-1', agentId: 'ace', assignmentId: 'job-1', projectId: 'project-1' }, sessionBindings: store,
  }), { code: 'EIO' })
  assert.equal(starts, 0)
  await assert.rejects(store.begin(key), { code: 'CODEX_SESSION_STORE_FAULTED' })
  sync.mock.restore()
})

test('session journal refuses a final-component symlink without changing its target', async t => {
  const f = await fixture(t)
  const target = join(f.directory, 'protected.txt')
  await writeFile(target, 'Preserve me', { mode: 0o600 })
  await symlink(target, f.filePath)
  await assert.rejects(f.open(), { code: 'CODEX_SESSION_FILE_UNSAFE' })
  assert.equal(await readFile(target, 'utf8'), 'Preserve me')
})
