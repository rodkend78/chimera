import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ChimeraBrowserRuntime } from '../src/browser/runtime.mjs'
import { GitHubCliProvider } from '../src/github/cli-provider.mjs'

function browserExecutor() {
  const state = { running: true, tabs: [] }
  return {
    async start() { return state },
    async state() { return state },
    async suspend() {},
    async close() {},
    allowTemporaryNavigation() {},
  }
}

function modelRegistry(calls) {
  return {
    state: () => ({ schema: 'chimera.model-provider-registry.v2', selected: null, providers: [
      { id: 'aws-bedrock', configured: true, models: [{ id: 'fixture-model', capabilities: ['conversation'] }] },
    ] }),
    router() { throw new Error('MODEL_ROUTER_MUST_NOT_RUN') },
    async select() {},
    async check(input) { calls.push(['check', input]); return { availability: 'verified-manual' } },
    async generateMedia(input) { calls.push(['generate', input]); return { kind: 'image', status: 'completed', modelId: input.model } },
    async mediaStatus(input) { calls.push(['status', input]); return { kind: 'video', status: 'completed', jobId: input.jobId } },
  }
}

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

async function fixture(t, { connector, calls = [] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-connection-runtime-'))
  const runtime = new ChimeraBrowserRuntime({
    profileDir: join(directory, 'profiles/ceo'),
    modelRegistry: modelRegistry(calls),
    browserExecutor: browserExecutor(),
    ...(connector ? { rjAwsConnector: connector } : {}),
  })
  await runtime.start()
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await runtime.close()
  }
  t.after(async () => {
    await close()
    await rm(directory, { recursive: true, force: true })
  })
  return { directory, runtime, close }
}

test('runtime persists an opaque per-installation machine binding', async t => {
  const first = await fixture(t)
  const machineRef = first.runtime.connectionMachineRef
  assert.match(machineRef, /^machine-[0-9a-f-]{36}$/)
  const stored = JSON.parse(await readFile(join(first.directory, 'connections/machine-ref.json'), 'utf8'))
  assert.deepEqual(stored, { schema: 'chimera.machine-ref.v1', machineRef })

  await first.close()
  const second = new ChimeraBrowserRuntime({
    profileDir: join(first.directory, 'profiles/ceo'),
    modelRegistry: modelRegistry([]),
    browserExecutor: browserExecutor(),
  })
  await second.start()
  t.after(async () => { await second.close() })
  assert.equal(second.connectionMachineRef, machineRef)
})

test('direct Codex auth refresh invalidates an older connection binding revision', async t => {
  let connected = false
  let reads = 0
  const codexAuth = {
    state: () => ({ provider: 'codex', available: true, connected, status: connected ? 'connected' : 'disconnected' }),
    async read() { reads += 1; if (reads > 1) connected = true; return this.state() },
    async close() {},
  }
  const directory = await mkdtemp(join(tmpdir(), 'chimera-connection-auth-refresh-'))
  const runtime = new ChimeraBrowserRuntime({
    profileDir: join(directory, 'profiles/ceo'),
    modelRegistry: modelRegistry([]),
    codexAuth,
    browserExecutor: browserExecutor(),
  })
  await runtime.start()
  t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }) })
  assert.equal(runtime.connectionState().find(entry => entry.providerId === 'codex').revision, 0)
  await runtime.refreshCodexAuth()
  const state = runtime.connectionState().find(entry => entry.providerId === 'codex')
  assert.equal(state.revision, 1)
  assert.equal(state.provenance.signedIn, true)
})

test('a disconnected provider fences media, access checks, and direct RJ verification', async t => {
  const calls = []
  const connector = {
    state: () => ({ schema: 'chimera.rj-aws-connection.v1', configured: true, transport: { status: 'ready' }, requests: [] }),
    executors: () => ({}),
    async execute() { calls.push('rj-execute'); return { outcome: 'succeeded' } },
  }
  const { runtime } = await fixture(t, { connector, calls })
  await runtime.connectionAction({ providerId: 'aws-bedrock', operation: 'disconnect', requestId: 'media-disconnect' })
  await assert.rejects(() => runtime.generateMedia({ model: 'fixture-model', prompt: 'fixture' }), { code: 'CONNECTION_DISABLED' })
  await assert.rejects(() => runtime.mediaStatus({ jobId: 'fixture-job' }), { code: 'CONNECTION_DISABLED' })
  await assert.rejects(() => runtime.checkModelAccess({ providerId: 'aws-bedrock', model: 'fixture-model' }), { code: 'CONNECTION_DISABLED' })

  await runtime.connectionAction({ providerId: 'rj-aws', operation: 'disconnect', requestId: 'rj-disconnect' })
  await assert.rejects(() => runtime.verifyRjAwsConnection(), { code: 'CONNECTION_DISABLED' })
  await assert.rejects(() => runtime.reconcileRjAwsRequest({ requestId: 'unknown-request' }), { code: 'CONNECTION_DISABLED' })
  assert.deepEqual(calls, [])
})

test('RJ verification rechecks the connection before a queued second operation', async t => {
  const entered = deferred()
  const release = deferred()
  let executions = 0
  const connector = {
    state: () => ({ schema: 'chimera.rj-aws-connection.v1', configured: true, transport: { status: 'ready' }, requests: [] }),
    executors: () => ({}),
    async execute(_operation, context) {
      context.assertActive()
      executions += 1
      if (executions === 1) {
        entered.resolve()
        await release.promise
      }
      context.assertActive()
      return { outcome: 'succeeded', receipt: { signature: `fixture-${executions}` } }
    },
  }
  const { runtime } = await fixture(t, { connector })
  const verification = runtime.verifyRjAwsConnection()
  await entered.promise
  await runtime.connectionAction({ providerId: 'rj-aws', operation: 'disconnect', requestId: 'rj-queued-disconnect' })
  release.resolve()
  await assert.rejects(() => verification, { code: 'CONNECTION_DISABLED' })
  assert.equal(executions, 1)
  const task = runtime.tasks.list().find(row => row.context?.source === 'rj-aws-verification')
  assert.equal(task.checkpoint.receipts.length, 1)
  assert.equal(task.checkpoint.receipts[0].signature, 'fixture-1')
})

test('direct GitHub login invalidates the prior connection binding', async t => {
  let loggedIn = false
  const githubProvider = new GitHubCliProvider({
    repositories: ['fixture-org/fixture-repo'],
    runner: async args => {
      if (args[0] === 'auth') { loggedIn = true; return { stdout: '' } }
      return { stdout: JSON.stringify({ login: loggedIn ? 'fixture-user' : null }) }
    },
  })
  const directory = await mkdtemp(join(tmpdir(), 'chimera-connection-github-login-'))
  const runtime = new ChimeraBrowserRuntime({
    profileDir: join(directory, 'profiles/ceo'), modelRegistry: modelRegistry([]), githubProvider,
    browserExecutor: browserExecutor(),
  })
  await runtime.start()
  t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }) })
  assert.equal(runtime.connectionState().find(entry => entry.providerId === 'github').revision, 0)
  await runtime.startGitHubLogin()
  const state = runtime.connectionState().find(entry => entry.providerId === 'github')
  assert.equal(state.revision, 1)
  assert.equal(state.provenance.accountRef, 'fixture-user')
})

test('connection-service GitHub connect owns the binding revision exactly once', async t => {
  let loggedIn = false
  const githubProvider = new GitHubCliProvider({
    repositories: ['fixture-org/fixture-repo'],
    runner: async args => {
      if (args[0] === 'auth') { loggedIn = true; return { stdout: '' } }
      return { stdout: JSON.stringify({ login: loggedIn ? 'fixture-user' : null }) }
    },
  })
  const directory = await mkdtemp(join(tmpdir(), 'chimera-connection-github-connect-'))
  const runtime = new ChimeraBrowserRuntime({
    profileDir: join(directory, 'profiles/ceo'), modelRegistry: modelRegistry([]), githubProvider,
    browserExecutor: browserExecutor(),
  })
  await runtime.start()
  t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }) })
  const result = await runtime.connectionAction({ providerId: 'github', operation: 'connect', requestId: 'github-connect' })
  assert.equal(result.state.enabled, true)
  assert.equal(result.state.revision, 1)
  assert.equal(result.state.provenance.accountRef, 'fixture-user')
})

test('direct Codex login invalidates the prior session binding', async t => {
  let connected = false
  const codexAuth = {
    state: () => ({ provider: 'codex', available: true, connected, status: connected ? 'connected' : 'disconnected' }),
    async read() { return this.state() },
    async startLogin() {
      connected = true
      return { loginId: 'fixture-login', callbackUrl: 'http://127.0.0.1:53100/auth/callback', authUrl: 'http://127.0.0.1:53100/auth' }
    },
    async close() {},
  }
  const directory = await mkdtemp(join(tmpdir(), 'chimera-connection-codex-login-'))
  const runtime = new ChimeraBrowserRuntime({
    profileDir: join(directory, 'profiles/ceo'), modelRegistry: modelRegistry([]), codexAuth,
    browserExecutor: browserExecutor(),
  })
  await runtime.start()
  t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }) })
  assert.equal(runtime.connectionState().find(entry => entry.providerId === 'codex').revision, 0)
  await runtime.startCodexLogin()
  const state = runtime.connectionState().find(entry => entry.providerId === 'codex')
  assert.equal(state.revision, 1)
  assert.equal(state.provenance.signedIn, true)
})
