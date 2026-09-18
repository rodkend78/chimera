import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAdeAcceptance } from '../scripts/pilot/ade-acceptance.mjs'
import { ChimeraBrowserRuntime } from '../src/browser/runtime.mjs'

async function fixtureParent(t) {
  const parent = await mkdtemp(join(tmpdir(), 'chimera-cleanup-test-'))
  await writeFile(join(parent, 'keep.txt'), 'caller-owned data')
  t.after(() => rm(parent, { recursive: true, force: true }))
  return parent
}

async function assertOnlyCallerDataRemains(parent) {
  assert.deepEqual(await readdir(parent), ['keep.txt'])
  assert.equal(await readFile(join(parent, 'keep.txt'), 'utf8'), 'caller-owned data')
}

test('ADE fixture removes its owned directory when initial repository setup fails', async (t) => {
  const parent = await fixtureParent(t)
  const previous = process.env.GIT_CONFIG_COUNT
  // Git rejects this before initializing a repository; no network is involved.
  process.env.GIT_CONFIG_COUNT = 'not-a-number'
  try {
    await assert.rejects(runAdeAcceptance({ rootDir: parent }), /GIT_CONFIG_COUNT/)
  } finally {
    if (previous === undefined) delete process.env.GIT_CONFIG_COUNT
    else process.env.GIT_CONFIG_COUNT = previous
  }
  await assertOnlyCallerDataRemains(parent)
})

test('ADE fixture retains startup and cleanup errors while still removing its directory', async (t) => {
  const parent = await fixtureParent(t)
  const startupError = new Error('fixture startup unavailable')
  const cleanupError = new Error('fixture close unavailable')
  // Inject failures at the runtime lifecycle boundary. Fixture ownership and
  // error propagation remain real; no live runtime is started by this test.
  t.mock.method(ChimeraBrowserRuntime.prototype, 'start', async () => { throw startupError })
  const close = ChimeraBrowserRuntime.prototype.close
  t.mock.method(ChimeraBrowserRuntime.prototype, 'close', async function () {
    try { await close.call(this) } catch { /* partial startup can also fail cleanup */ }
    throw cleanupError
  })
  const failure = await runAdeAcceptance({ rootDir: parent }).catch(error => error)
  await assertOnlyCallerDataRemains(parent)
  assert.ok(failure instanceof AggregateError)
  assert.equal(failure.cause, startupError)
  assert.deepEqual(failure.errors, [startupError, cleanupError])
})

test('ADE fixture does not report success when final shutdown fails, and removes its directory', async (t) => {
  const parent = await fixtureParent(t)
  const shutdownError = new Error('fixture final shutdown failed')
  const close = ChimeraBrowserRuntime.prototype.close
  let closes = 0
  t.mock.method(ChimeraBrowserRuntime.prototype, 'close', async function () {
    await close.call(this)
    closes += 1
    if (closes === 2) throw shutdownError
  })
  await assert.rejects(runAdeAcceptance({ rootDir: parent }), error => error === shutdownError)
  await assertOnlyCallerDataRemains(parent)
})

test('ADE fixture preserves the original workflow error when cleanup succeeds', async (t) => {
  const parent = await fixtureParent(t)
  const discoveryError = new Error('fixture discovery unavailable')
  t.mock.method(ChimeraBrowserRuntime.prototype, 'discoverAgents', async () => { throw discoveryError })
  await assert.rejects(runAdeAcceptance({ rootDir: parent }), error => error === discoveryError)
  await assertOnlyCallerDataRemains(parent)
})

test('ADE fixture cleans up a partially started replacement runtime after restart failure', async (t) => {
  const parent = await fixtureParent(t)
  const restartError = new Error('fixture restart unavailable')
  const start = ChimeraBrowserRuntime.prototype.start
  let starts = 0
  t.mock.method(ChimeraBrowserRuntime.prototype, 'start', async function () {
    starts += 1
    if (starts === 2) throw restartError
    return start.call(this)
  })
  const failure = await runAdeAcceptance({ rootDir: parent }).catch(error => error)
  await assertOnlyCallerDataRemains(parent)
  assert.ok(failure instanceof AggregateError)
  assert.equal(failure.cause, restartError)
  assert.equal(failure.errors[0], restartError)
  assert.ok(failure.errors[1] instanceof AggregateError)
  assert.match(failure.errors[1].message, /Runtime cleanup failed/)
})
