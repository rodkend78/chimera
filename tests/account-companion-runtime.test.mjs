import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod, lstat, readdir, realpath, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChimeraBrowserRuntime } from '../src/browser/runtime.mjs'
import { createDeterministicModelRouter } from '../src/ceo/model-router.mjs'
import { agentManifestFromHermesCandidate } from '../src/agents/registry.mjs'
import { prepareCompanion } from '../src/account-browser/installer.mjs'
import { EXPECTED_ORIGIN } from '../src/account-browser/identity.mjs'
import { AccountCompanionRuntime } from '../src/account-browser/runtime-integration.mjs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createCoordinator } from '../extensions/account-browser/background.js'
import { CodexAppServerAuth } from '../src/ceo/codex-app-server-auth.mjs'

const READ = 'mcp__chimera_account__read', WAIT = 'mcp__chimera_account__await_share'
const MARKER = 'UNIQUE_RAW_ACCOUNT_OBSERVATION_73628'
const request = (name, args = {}) => ({ status: 'tool_request', toolCall: { name, arguments: args } })
async function until(read) { for (let i = 0; i < 400; i++) { const value = await read(); if (value) return value; await new Promise(r => setTimeout(r, 10)) } throw Error('fixture deadline') }
async function fixture(t, responder, mode = 'prepared') {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'ar-')))
  const companionRoot = join(directory, 'account-browser'); await mkdir(companionRoot, { mode: 0o700 })
  const socketPath = join(companionRoot, 'b.sock')
  if (mode !== 'absent') await prepareCompanion({ destination: join(companionRoot, 'install'), hostManifestDir: join(directory, 'hosts'), nodePath: process.execPath, socketPath })
  if (mode === 'stale') await writeFile(socketPath, 'foreign fixture', { mode: 0o600 })
  if (mode === 'invalid') await writeFile(join(companionRoot, 'install/runtime.json'), '{}')
  const calls = []
  const provider = createDeterministicModelRouter({ routerId: 'openai-compatible:fixture:account', responder: async (prompt, context) => { calls.push(structuredClone(context)); return responder(prompt, context) } })
  const runtime = new ChimeraBrowserRuntime({ profileDir: join(directory, 'profiles/ceo'),
    projectAllowedRoots: [directory],
    modelRegistry: { state: () => ({ selected: { providerId: 'fixture', model: 'account' }, providers: [] }), router: () => provider },
    browserExecutor: { start: async () => ({ running: true, tabs: [] }), state: async () => ({ running: true, tabs: [] }), suspend: async () => ({ running: false, tabs: [] }), close: async () => {} },
    agentReferenceProvider: { materialize: async () => [{ path: 'MEMORY.md', content: 'Fixture.' }] } })
  t.after(async () => {
    await runtime.close()
    async function writable(path) { if ((await lstat(path)).isDirectory()) { await chmod(path, 0o700); for (const entry of await readdir(path)) await writable(join(path, entry)) } }
    await writable(directory); await rm(directory, { recursive: true, force: true })
  })
  await runtime.start()
  await runtime.agentRegistry.registerMany(['ace', 'iris'].map(id => agentManifestFromHermesCandidate({ schema: 'chimera.hermes-agent-candidate.v1', candidateId: `fixture:${id}`, profileId: id, displayName: id, sourceRef: `hermes://fixture/profiles/${id}` })))
  await runtime.agentAccessPolicy.set('ace', 'connected', { changedBy: 'fixture' })
  return { runtime, directory, calls, socketPath }
}
async function pair(runtime) {
  const sent = []
  const peer = runtime.accountCompanion.broker.connect({ origin: EXPECTED_ORIGIN, send: message => sent.push(message) })
  const hello = await peer.receive({ id: 'hello', type: 'hello', profileId: 'fixture-profile' })
  await runtime.accountCompanion.broker.approvePair({ pairingId: hello.pairingId })
  await peer.receive({ id: 'auth', type: 'authenticate', pairingId: hello.pairingId, challenge: hello.challenge })
  return { peer, sent }
}
const share = async (peer, taskId, agentId = 'ace', id = 'share') => {
  const result = await peer.receive({ id, type: 'share', tabId: 1, documentId: 'fixture-document', origin: 'https://example.com', urlDigest: 'a'.repeat(64), taskId, agentId })
  const lease = result.lease
  await peer.receive({ id: `${id}-ready`, type: 'ready', leaseId: lease.leaseId, revision: lease.revision, documentId: lease.documentId, origin: lease.origin, urlDigest: lease.urlDigest })
  return result
}

test('real coordinator and waiting DSH worker share only after final inspection and cache-ready acknowledgement', { timeout: 15000 }, async t => {
  const f = await fixture(t, (_prompt, context) => {
    if (context.stage === 'decompose') return { tasks: [{ specialistAgentId: 'ace', objective: 'Read my shared page.', acceptanceCriteria: ['Summarize.'] }] }
    if (context.stage === 'synthesize') return { summary: 'Derived summary.' }
    if (context.loop.turn === 1) return request(WAIT)
    if (context.loop.turn === 2) return request(READ, { leaseId: context.accountBrowserLeases[0].leaseId })
    assert.match(JSON.stringify(context.loop.observations), new RegExp(MARKER))
    return { status: 'completed', summary: 'Derived summary.' }
  })
  const event = () => ({ handlers: [], addListener(fn) { this.handlers.push(fn) }, emit(v) { this.handlers.forEach(fn => fn(v)) } })
  let releaseReply, releaseInspect; const replyGate = new Promise(r => { releaseReply = r }), inspectGate = new Promise(r => { releaseInspect = r })
  t.after(() => { releaseReply(); releaseInspect() })
  let reserved = false, inspecting = false, injections = 0
  const sent = [], errors = [], port = { onMessage: event(), onDisconnect: event(), disconnect() {} }
  const peer = f.runtime.accountCompanion.broker.connect({ origin: EXPECTED_ORIGIN, send: message => { sent.push(message); port.onMessage.emit(message) } })
  port.postMessage = message => { void (async () => {
    try { const result = await peer.receive(message); if (message.type === 'share') { reserved = true; await replyGate } if (result) port.onMessage.emit(result) }
    catch (error) { errors.push(error.message); port.onMessage.emit({ id: message.id, type: 'error' }) }
  })() }
  const chrome = { runtime: { id: 'extension', getURL: path => `chrome-extension://extension/${path}`, connectNative: () => port },
    tabs: { query: async () => [{ id: 7, url: 'https://example.com/report' }], onUpdated: event(), onRemoved: event(), onReplaced: event() },
    scripting: { executeScript: async spec => {
      injections++; if (injections === 2) { inspecting = true; await inspectGate }
      return [{ frameId: 0, documentId: 'doc', result: { url: 'https://example.com/report', origin: 'https://example.com', ...(spec.args[0] === 'read' ? { text: MARKER } : {}) } }]
    } } }
  const coordinator = createCoordinator({ chrome, profileId: async () => 'fixture-profile' })
  const popup = message => coordinator.handlePopup(message, { id: 'extension', url: 'chrome-extension://extension/popup.html' })
  await popup({ type: 'pair' }); await f.runtime.accountCompanion.broker.approvePair({ pairingId: coordinator.state().pairing.pairingId }); await popup({ type: 'finish-pairing' })
  const { task } = await f.runtime.sendMessage({ content: 'Read my shared page.', recipientAgentId: 'ace' })
  await until(() => f.runtime.accountCompanion.pendingWaits === 1)
  const sharing = popup({ type: 'share', acknowledged: true, taskId: task.taskId, agentId: 'ace' }); sharing.catch(() => {})
  try {
    await until(() => reserved)
    assert.deepEqual(f.runtime.accountCompanion.broker.readyLeases(), [])
    assert.equal(f.runtime.accountCompanion.pendingWaits, 1)
    releaseReply(); await until(() => inspecting)
    assert.deepEqual(f.runtime.accountCompanion.broker.readyLeases(), [])
    assert.equal(sent.some(m => m.type === 'read'), false)
    releaseInspect(); await sharing
    assert.equal(f.runtime.accountCompanion.broker.readyLeases().length, 1)
    assert.equal((await f.runtime.waitForTask(task.taskId)).status, 'completed')
    assert.equal(sent.filter(m => m.type === 'read').length, 1)
    assert.deepEqual(errors, [])
  } finally { releaseReply(); releaseInspect(); await sharing.catch(() => {}); await f.runtime.cancelTask({ taskId: task.taskId }).catch(() => {}) }
})

for (const mode of ['absent', 'invalid', 'stale']) test(`runtime isolates companion ${mode} setup failure from existing browser`, async t => {
  const f = await fixture(t, () => ({ summary: 'fixture' }), mode)
  assert.equal(f.runtime.accountCompanion.state().status, mode === 'absent' ? 'not-installed' : 'unavailable')
  assert.equal(f.runtime.accountCompanion.broker, null)
  assert.equal((await f.runtime.state()).browser.running, true)
  if (mode === 'stale') assert.equal(await readFile(f.socketPath, 'utf8'), 'foreign fixture')
  else await assert.rejects(lstat(f.socketPath), { code: 'ENOENT' })
})

test('ordinary worker waits for explicit share, reads through DSH, and keeps raw text out of dispatcher and later history', { timeout: 15000 }, async t => {
  const f = await fixture(t, (_prompt, context) => {
    if (context.stage === 'decompose') return { tasks: [{ specialistAgentId: context.requestedSpecialistAgentId ?? 'ace', objective: 'Read my explicitly shared account page.', acceptanceCriteria: ['Summarize it.'] }] }
    if (context.stage === 'synthesize') { assert.doesNotMatch(JSON.stringify(context), new RegExp(MARKER)); return { summary: 'Derived shared-page summary.' } }
    if (context.specialistAgent.agentId === 'iris') return { status: 'completed', summary: 'Explained the derived summary.' }
    if (context.loop.turn === 1) return request(WAIT)
    if (context.loop.turn === 2) { assert.equal(context.accountBrowserLeases.length, 1); return request(READ, { leaseId: context.accountBrowserLeases[0].leaseId }) }
    assert.match(JSON.stringify(context.loop.observations), new RegExp(MARKER))
    return { status: 'completed', summary: 'Derived shared-page summary.' }
  })
  assert.equal(f.runtime.accountCompanion.state().status, 'available')
  const { peer, sent } = await pair(f.runtime)
  const { task } = await f.runtime.sendMessage({ content: 'Read my explicitly shared page.', recipientAgentId: 'ace' })
  await until(() => f.runtime.audit.entries().some(row => row.fact.kind === 'dsh.tool.authorized' && row.fact.toolName === WAIT))
  await assert.rejects(share(peer, task.taskId, 'iris', 'wrong-agent'))
  const { lease } = await share(peer, task.taskId)
  const read = await until(() => sent.find(message => message.type === 'read'))
  await peer.receive({ id: read.id, type: 'read-result', leaseId: lease.leaseId, revision: read.revision, documentId: read.documentId, origin: read.origin, urlDigest: read.urlDigest, text: MARKER })
  const terminal = await f.runtime.waitForTask(task.taskId)
  assert.equal(terminal.status, 'completed', JSON.stringify(terminal.failure))
  assert.doesNotMatch(JSON.stringify(terminal), new RegExp(MARKER))
  assert.doesNotMatch(await readFile(f.runtime.taskFile, 'utf8'), new RegExp(MARKER))
  assert.doesNotMatch(await readFile(f.runtime.mailboxFile, 'utf8'), new RegExp(MARKER))
  assert.doesNotMatch(JSON.stringify(f.runtime.audit.entries()), new RegExp(MARKER))
  assert.ok(f.runtime.audit.entries().some(row => row.fact.kind === 'dsh.tool.authorized' && row.fact.toolName === READ))
  assert.equal(f.runtime.accountCompanion.leasesFor({ taskId: task.taskId, agentId: 'ace' }).length, 0)
  assert.equal(sent.filter(message => message.type === 'read').length, 1)
  const later = await f.runtime.sendMessage({ content: 'Explain the prior summary.', recipientAgentId: 'iris' })
  assert.equal((await f.runtime.waitForTask(later.task.taskId)).status, 'completed')
  assert.ok(f.calls.some(row => row.taskId === later.task.taskId && row.specialistAgent?.agentId === 'iris'))
  for (const context of f.calls.filter(row => row.taskId === later.task.taskId)) assert.doesNotMatch(JSON.stringify(context), new RegExp(MARKER))
})

test('waiting worker cancels promptly without detached read work', { timeout: 10000 }, async t => {
  const f = await fixture(t, (_prompt, context) => context.stage === 'decompose' ? { tasks: [{ specialistAgentId: 'ace', objective: 'Wait for my shared page.', acceptanceCriteria: ['Read it.'] }] } : request(WAIT))
  const { task } = await f.runtime.sendMessage({ content: 'Wait for my shared page.', recipientAgentId: 'ace' })
  await until(() => f.runtime.audit.entries().some(row => row.fact.kind === 'dsh.tool.authorized' && row.fact.toolName === WAIT))
  await f.runtime.cancelTask({ taskId: task.taskId })
  assert.equal((await f.runtime.waitForTask(task.taskId)).status, 'cancelled')
  assert.equal(f.runtime.accountCompanion.pendingWaits, 0)
})

test('runtime authority rejects stale worker/task/grant/profile/assignment and fences navigation and restart', { timeout: 15000 }, async t => {
  let finish
  const held = new Promise(resolve => { finish = resolve })
  t.after(() => finish())
  const f = await fixture(t, async (_prompt, context) => {
    if (context.stage === 'decompose') return { tasks: [{ specialistAgentId: 'ace', objective: 'Read a shared page.', acceptanceCriteria: ['Return evidence.'] }] }
    if (context.stage === 'synthesize') return { summary: 'Fixture done.' }
    await held; return { status: 'completed', summary: 'Fixture done.' }
  })
  const { task } = await f.runtime.sendMessage({ content: 'Read a shared page.', recipientAgentId: 'ace' })
  await until(() => f.calls.find(context => context.stage === 'specialist-loop'))
  const r = f.runtime, adapter = r.accountCompanion, worker = r.workers.get('ace'), identity = { taskId: task.taskId, agentId: 'ace', workerSessionId: worker.sessionId }
  assert.equal(typeof adapter.eligibleFor(identity).expiresAt, 'number')
  assert.equal(adapter.eligibleFor({ ...identity, workerSessionId: 'wrong' }), null)
  assert.equal(adapter.eligibleFor({ ...identity, taskId: 'wrong' }), null)
  assert.equal(adapter.eligibleFor({ ...identity, agentId: 'iris' }), null)
  const controller = r.taskControllers.get(task.taskId)
  r.taskControllers.delete(task.taskId); assert.equal(adapter.eligibleFor(identity), null); r.taskControllers.set(task.taskId, controller)
  const grant = worker.grant
  worker.grant = structuredClone(grant); assert.equal(adapter.eligibleFor(identity), null); worker.grant = grant
  const signature = grant.signature; grant.signature = 'invalid'; assert.equal(adapter.eligibleFor(identity), null); grant.signature = signature
  await r.agentAccessPolicy.set('ace', 'sandbox', { changedBy: 'fixture' }); assert.equal(adapter.eligibleFor(identity), null)
  await r.agentAccessPolicy.set('ace', 'connected', { changedBy: 'fixture' })
  const { peer, sent } = await pair(r)
  const { lease } = await share(peer, task.taskId)
  const exec = (args, ctx = { ...identity, assertActive() {} }) => adapter.executors()[READ](args, ctx)
  for (const args of [42, 'text', [], { timeoutMs: 1 }, { taskId: task.taskId }]) await assert.rejects(adapter.executors()[WAIT](args, { ...identity, assertActive() {} }), { code: 'ACCOUNT_COMPANION_ARGUMENT_INVALID' })
  await assert.rejects(adapter.assertExecutor({ ...identity, assertActive: () => false }), { code: 'ACCOUNT_COMPANION_DENIED' })
  await assert.rejects(exec({ leaseId: lease.leaseId }, {}), { code: 'ACCOUNT_COMPANION_DENIED' })
  for (const args of [{}, { leaseId: lease.leaseId, taskId: task.taskId }, { leaseId: lease.leaseId, agentId: 'iris' }]) await assert.rejects(exec(args), { code: 'ACCOUNT_COMPANION_ARGUMENT_INVALID' })
  assert.notEqual((await worker.executeTool({ name: READ, arguments: { leaseId: 'unshared' } }, { assertActive() {} })).status, 'completed')
  await peer.receive({ id: 'navigate', type: 'invalidate', leaseId: lease.leaseId, reason: 'navigation' })
  assert.equal(adapter.leasesFor(identity).length, 0)
  await assert.rejects(exec({ leaseId: lease.leaseId }))
  const { lease: second } = await share(peer, task.taskId, 'ace', 'second')
  await adapter.close()
  assert.equal(adapter.leasesFor(identity).length, 0)
  const restarted = new AccountCompanionRuntime(r); await restarted.start()
  assert.equal(restarted.state().leases.find(row => row.leaseId === second.leaseId).status, 'restarted')
  await assert.rejects(restarted.executors()[READ]({ leaseId: second.leaseId }, { ...identity, assertActive() {} }))
  await restarted.close()
  assert.equal(sent.some(message => message.type === 'read'), false)
  finish(); await r.waitForTask(task.taskId)
})

test('active project lease bounds sharing and expired project authority denies reads', { timeout: 15000 }, async t => {
  let finish; const held = new Promise(resolve => { finish = resolve })
  const f = await fixture(t, async (_prompt, context) => {
    if (context.stage === 'decompose') return { tasks: [{ specialistAgentId: 'ace', objective: 'Read my shared page.', acceptanceCriteria: ['Return evidence.'] }] }
    if (context.stage === 'synthesize') return { summary: 'Fixture done.' }
    await held; return { status: 'completed', summary: 'Fixture done.' }
  })
  const source = join(f.directory, 'source'); await mkdir(source)
  const git = (...args) => promisify(execFile)('git', args, { cwd: source })
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.invalid')
  await writeFile(join(source, 'README.md'), 'Fixture\n'); await git('add', 'README.md'); await git('commit', '-m', 'Fixture')
  const project = await f.runtime.registerProject({ mode: 'local', name: 'Account fixture', path: source })
  const task = await f.runtime.submitProjectTask({ projectId: project.projectId, objective: 'Read my shared page.', access: { profileId: 'connected', networkHosts: [], ttlSeconds: 300 } })
  try {
    await until(() => f.calls.find(context => context.stage === 'specialist-loop'))
    const parent = f.runtime.taskAccessLeases.activeFor('ace', task.taskId)
    const { peer, sent } = await pair(f.runtime)
    const { lease } = await share(peer, task.taskId)
    assert.equal(lease.expiresAt, Date.parse(parent.expiresAt))
    const original = f.runtime.now
    f.runtime.now = () => Date.parse(parent.expiresAt) + 1
    assert.equal(f.runtime.accountCompanion.eligibleFor({ taskId: task.taskId, agentId: 'ace' }), null)
    const outcome = await f.runtime.workers.get('ace').executeTool({ name: READ, arguments: { leaseId: lease.leaseId } }, { assertActive() {} })
    assert.notEqual(outcome.status, 'completed'); assert.equal(sent.some(row => row.type === 'read'), false)
    f.runtime.now = original
    await peer.disconnect()
    assert.equal(f.runtime.accountCompanion.leasesFor({ taskId: task.taskId, agentId: 'ace' }).length, 0)
  } finally { finish() }
  await f.runtime.waitForTask(task.taskId)
})

test('metadata-only wait times out once at 60 seconds and releases timers', { timeout: 15000 }, async t => {
  const f = await fixture(t, (_prompt, context) => {
    if (context.stage === 'decompose') return { tasks: [{ specialistAgentId: 'ace', objective: 'Wait for a shared page.', acceptanceCriteria: ['Report timeout.'] }] }
    if (context.stage === 'synthesize') return { summary: 'No share was provided.' }
    if (context.loop.turn === 1) return request(WAIT)
    assert.deepEqual(context.loop.observations[0].result, { status: 'no-share-timeout', leases: [] })
    return { status: 'completed', summary: 'No share was provided.' }
  })
  const { task } = await f.runtime.sendMessage({ content: 'Wait for my shared page.', recipientAgentId: 'ace' })
  await until(() => f.runtime.accountCompanion.pendingWaits === 1)
  const originalNow = f.runtime.now
  f.runtime.now = () => originalNow() + 60001
  const terminal = await f.runtime.waitForTask(task.taskId)
  f.runtime.now = originalNow
  assert.equal(terminal.status, 'completed', JSON.stringify(terminal.failure))
  assert.equal(f.runtime.accountCompanion.pendingWaits, 0)
  assert.equal(f.runtime.audit.entries().filter(row => row.fact.kind === 'dsh.tool.authorized' && row.fact.toolName === WAIT).length, 1)
})

for (const phase of ['shared', 'ready']) for (const ending of ['cancel', 'stop']) test(`delayed ${phase} audit is hidden from UI and waiting worker; ${ending} cannot revive it`, { timeout: 15000 }, async t => {
  const f = await fixture(t, (_prompt, context) => context.stage === 'decompose'
    ? { tasks: [{ specialistAgentId: 'ace', objective: 'Wait for my shared page.', acceptanceCriteria: ['Read it.'] }] } : request(WAIT))
  const { peer, sent } = await pair(f.runtime)
  const { task } = await f.runtime.sendMessage({ content: 'Wait for my shared page.', recipientAgentId: 'ace' })
  await until(() => f.runtime.accountCompanion.pendingWaits === 1)
  let release, entered = false
  const held = new Promise(resolve => { release = resolve })
  const original = f.runtime.audit.append.bind(f.runtime.audit)
  f.runtime.audit.append = async fact => { if (fact.kind === `account-browser.${phase}`) { entered = true; await held } return original(fact) }
  const sharing = share(peer, task.taskId).then(() => false, () => true)
  try {
    await until(() => entered)
    assert.equal(f.runtime.accountCompanion.broker.state().leases.length, 1)
    assert.deepEqual(f.runtime.accountCompanion.state().leases, [])
    assert.deepEqual(f.runtime.accountCompanion.leasesFor({ taskId: task.taskId, agentId: 'ace' }), [])
    assert.equal(f.runtime.accountCompanion.pendingWaits, 1)
    if (ending === 'stop') {
      const stopping = f.runtime.stopAgent('ace')
      assert.equal(f.runtime.accountCompanion.eligibleFor({ taskId: task.taskId, agentId: 'ace' }), null)
      await stopping
    }
    await f.runtime.cancelTask({ taskId: task.taskId })
    assert.equal((await f.runtime.waitForTask(task.taskId)).status, 'cancelled')
  } finally { release() }
  assert.equal(await sharing, true)
  assert.equal(sent.some(row => row.type === 'read'), false)
  assert.equal(f.runtime.accountCompanion.pendingWaits, 0)
})

test('explicit worker stop fences a read held at requested-audit before transport dispatch', { timeout: 15000 }, async t => {
  let finish; const heldModel = new Promise(resolve => { finish = resolve })
  const f = await fixture(t, async (_prompt, context) => {
    if (context.stage === 'decompose') return { tasks: [{ specialistAgentId: 'ace', objective: 'Read a shared page.', acceptanceCriteria: ['Return evidence.'] }] }
    if (context.stage === 'synthesize') return { summary: 'Stopped.' }
    await heldModel; return { status: 'completed', summary: 'Stopped.' }
  })
  const { task } = await f.runtime.sendMessage({ content: 'Read a shared page.', recipientAgentId: 'ace' })
  let release; const heldAudit = new Promise(resolve => { release = resolve }); let entered = false
  try {
    await until(() => f.calls.find(row => row.stage === 'specialist-loop'))
    const { peer, sent } = await pair(f.runtime), { lease } = await share(peer, task.taskId)
    const original = f.runtime.audit.append.bind(f.runtime.audit)
    f.runtime.audit.append = async fact => { if (fact.kind === 'account-browser.read.requested') { entered = true; await heldAudit } return original(fact) }
    const reading = f.runtime.workers.get('ace').executeTool({ name: READ, arguments: { leaseId: lease.leaseId } }, { assertActive() {} })
    await until(() => entered)
    const stopping = f.runtime.stopAgent('ace')
    release()
    await stopping
    const result = await reading
    assert.notEqual(result.status, 'completed')
    assert.equal(sent.some(row => row.type === 'read'), false)
  } finally { release(); finish() }
  await f.runtime.waitForTask(task.taskId)
})

test('runtime companion closes its owned socket even when terminal metadata persistence fails', async t => {
  const f = await fixture(t, () => ({ summary: 'Fixture.' }))
  const stateFile = join(f.directory, 'account-browser/state.json')
  await rename(stateFile, `${stateFile}.saved`); await mkdir(stateFile, { mode: 0o700 })
  try {
    await assert.rejects(f.runtime.accountCompanion.close())
    await assert.rejects(lstat(f.socketPath), { code: 'ENOENT' })
    assert.equal(f.runtime.accountCompanion.state().status, 'unavailable')
  } finally { await rm(stateFile, { recursive: true }); await rename(`${stateFile}.saved`, stateFile) }
})

test('whole runtime completes existing cleanup before reporting companion metadata failure', async t => {
  const f = await fixture(t, () => ({ summary: 'Fixture.' }))
  const r = f.runtime, completed = []
  // Construct only: no auth process, account read or network request is started.
  r.codexAuth = new CodexAppServerAuth({ spawnImpl() { throw Error('No auth process permitted') } })
  for (const kind of ['browser', 'gateway']) {
    const actionId = `close-${kind}`
    await r.decisions.post({ actionId, challengeHash: 'fixture-challenge', actionDiff: { operation: 'observe' }, resource: 'fixture:close', expiresAt: new Date(Date.now() + 60000).toISOString(), agent: { agentId: r.agentId, grantId: r.grant.payload.grantId }, policyRationale: { ruleId: 'fixture', tier: 'confirm', reason: 'FIXTURE' } })
    r.pendingExecutions.set(actionId, { kind })
  }
  for (const [name, method] of [['workerApprovalBroker', 'cancelAll'], ['browserAdapter', 'close'], ['tasks', 'close'], ['conversations', 'close'], ['projectRegistry', 'close'], ['projectSessions', 'close'], ['taskAccessLeases', 'close'], ['codexAuth', 'close'], ['audit', 'close']]) {
    const target = r[name]
    if (!target?.[method]) continue
    const original = target[method].bind(target)
    target[method] = async (...args) => { await original(...args); completed.push(name) }
  }
  const stateFile = join(f.directory, 'account-browser/state.json')
  await rename(stateFile, `${stateFile}.saved`); await mkdir(stateFile, { mode: 0o700 })
  try {
    await assert.rejects(r.close())
    assert.deepEqual(completed, ['workerApprovalBroker', 'browserAdapter', 'tasks', 'conversations', 'projectRegistry', 'projectSessions', 'taskAccessLeases', 'codexAuth'])
    assert.equal(r.codexAuth.closing, true)
    assert.equal(r.decisions.pending().length, 0)
    assert.equal(r.pendingExecutions.size, 0)
    for (const kind of ['browser', 'gateway']) assert.equal(r.decisions.get(`close-${kind}`).status, 'cancelled')
    await assert.rejects(lstat(f.socketPath), { code: 'ENOENT' })
  } finally { await rm(stateFile, { recursive: true }); await rename(`${stateFile}.saved`, stateFile) }
})
