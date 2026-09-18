import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const mod = await import('../src/ceo/antigravity-provider.mjs').catch(() => ({}))
const fixture = new URL('./fixtures/antigravity-cli.mjs', import.meta.url).pathname

test('Flash High returns validated JSON without entering the CLI forced-schema repair path', async t => {
  const { service } = await setup(t, 'flash-high-schema')
  await service.refresh()
  assert.deepEqual(await service.router('gemini-test-high').route('Connection check', { stage: 'specialist' }), { summary: 'Fixture answer' })
})

async function setup(t, mode = 'success', overrides = {}) {
  assert.equal(typeof mod.createAntigravityConnection, 'function', 'Antigravity connection is implemented')
  const directory = await mkdtemp(join(tmpdir(), 'chimera-agy-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const settingsPath = join(directory, 'settings.json')
  await writeFile(settingsPath, '{}')
  const launches = [], audit = []
  const service = mod.createAntigravityConnection({
    binary: '/trusted/agy', settingsPath, scratchRoot: directory, platform: 'darwin',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, GEMINI_API_KEY: 'SECRET', AWS_SECRET_ACCESS_KEY: 'SECRET', NODE_OPTIONS: 'SECRET' },
    accessImpl: async () => {},
    execFileImpl: async (file, args, options) => {
      launches.push({ file, args, options })
      if (args[0] === 'models') return { stdout: 'gemini-test-high\tGemini Test (High)\n', stderr: '' }
      return { stdout: '--input-format --output-format --agent --sandbox --model --disable-slash-commands', stderr: '' }
    },
    spawnImpl: (_file, args, options) => spawn(process.execPath, [fixture, mode, ...args], options),
    appendAudit: fact => audit.push(fact), timeoutMs: 1500,
    ...overrides,
  })
  return { service, settingsPath, launches, audit, directory }
}

test('Antigravity discovery is explicit, does not invoke a model, and never claims authentication', async t => {
  const { service, launches } = await setup(t)
  assert.equal(service.state().configured, false)
  assert.equal(launches.length, 0)
  const status = await service.refresh()
  assert.equal(status.status, 'ready-to-test')
  assert.equal(status.handshakeVerified, true)
  assert.equal(status.authenticated, false)
  assert.equal(status.models[0].id, 'gemini-test-high')
  assert.equal(launches.length, 2)
  for (const call of launches) {
    assert.ok(!call.args.includes('--print'))
    assert.equal(call.options.env.GEMINI_API_KEY, undefined)
    assert.equal(call.options.env.AWS_SECRET_ACCESS_KEY, undefined)
    assert.equal(call.options.env.NODE_OPTIONS, undefined)
  }
})

test('Antigravity rejects API-key configuration before discovery or dispatch', async t => {
  const { service, settingsPath, launches } = await setup(t)
  await writeFile(settingsPath, '{"modelProvider":"gemini"}')
  assert.equal((await service.refresh()).error, 'ANTIGRAVITY_ACCOUNT_MODE_REQUIRED')
  assert.equal(launches.length, 0)
})

test('Boundary verification sends no model prompt and does not mark account authenticated', async t => {
  const { service } = await setup(t, 'probe')
  await service.refresh()
  assert.equal(typeof service.verifyHandshake, 'function')
  assert.deepEqual(await service.verifyHandshake('gemini-test-high'), { verified: true, modelCallSent: false })
  assert.equal(service.state().authenticated, false)
})

test('Antigravity returns validated structured work with safe progress and isolated native tools', async t => {
  const { service, directory } = await setup(t)
  await service.refresh()
  const progress = []
  const router = service.router('gemini-test-high')
  assert.deepEqual(await router.route('Explain the supplied evidence', { stage: 'specialist' }, { onProgress: x => progress.push(x) }), { summary: 'Fixture answer' })
  assert.deepEqual(progress.map(x => x.phase), ['started', 'responding', 'completed'])
  assert.doesNotMatch(JSON.stringify(progress), /SECRET|thought|conversation/)
  assert.equal(service.state().authenticated, true)
  const { readdir } = await import('node:fs/promises')
  const retained = (await readdir(directory)).filter(name => name.startsWith('chimera-antigravity-'))
  assert.equal(retained.length, 1, 'Native work survives completion for review')
  assert.match(await readFile(join(directory, retained[0], '.agents/agents/chimera-router/agent.md'), 'utf8'), /Chimera assignment/)
})

for (const [mode, code] of [['wrong-model', 'ANTIGRAVITY_MODEL_MISMATCH'], ['error', 'ANTIGRAVITY_TURN_FAILED'], ['incomplete', 'ANTIGRAVITY_TURN_INCOMPLETE'], ['duplicate', 'ANTIGRAVITY_PROTOCOL_INVALID'], ['malformed', 'ANTIGRAVITY_PROTOCOL_INVALID'], ['hang', 'ANTIGRAVITY_TIMEOUT']]) {
  test(`Antigravity fails closed on ${mode}`, async t => {
    const { service } = await setup(t, mode)
    const state = await service.refresh()
    if (mode === 'wrong-model') {
      assert.equal(state.error, code)
      assert.equal(state.configured, false)
      assert.equal(state.models.length, 1, 'Keep the discovered catalog visible when delegation is blocked')
      return
    }
    await assert.rejects(service.router('gemini-test-high').route('Review', { stage: 'specialist' }), { code })
    assert.equal(service.state().authenticated, false)
  })
}

test('Cancellation stops the child and pre-cancelled work is never dispatched', async t => {
  const { service } = await setup(t, 'hang')
  await service.refresh()
  const controller = new AbortController()
  const running = service.router('gemini-test-high').route('Review', { stage: 'specialist' }, { signal: controller.signal })
  setTimeout(() => controller.abort(), 100)
  await assert.rejects(running, { name: 'AbortError' })
  await assert.rejects(service.router('gemini-test-high').route('Review', {}, { signal: controller.signal }), { name: 'AbortError' })
})

test('Operator-managed native tools run under Antigravity permissions and record metadata only', async t => {
  const { service, audit } = await setup(t, 'native-tools')
  const state = await service.refresh()
  assert.equal(state.configured, true)
  assert.equal(state.execution, 'antigravity-managed')
  const router = service.router('gemini-test-high')
  assert.equal(router.nativeExecution, true)
  assert.deepEqual(await router.route('Complete bounded work', { stage: 'specialist' }), { summary: 'Fixture answer' })
  assert.ok(audit.some(row => row.kind === 'antigravity.native.started'))
  assert.ok(audit.some(row => row.kind === 'antigravity.native.tool' && row.toolName === 'read_file'))
  assert.doesNotMatch(JSON.stringify(audit), /SECRET/)
})

test('Discovery does not expose selectable routes before the tool-boundary check finishes', async t => {
  const { service } = await setup(t, 'probe')
  const pending = service.refresh()
  assert.equal(service.state().configured, false)
  await pending
  assert.equal(service.state().handshakeVerified, true)
})

test('Routing rechecks account configuration after discovery and rejects unknown models', async t => {
  const { service, settingsPath } = await setup(t)
  await service.refresh()
  assert.throws(() => service.router('--unsafe'), { code: 'ANTIGRAVITY_MODEL_UNAVAILABLE' })
  await writeFile(settingsPath, '{"modelProvider":"gemini"}')
  await assert.rejects(service.router('gemini-test-high').route('Review', { stage: 'specialist' }), { code: 'ANTIGRAVITY_ACCOUNT_MODE_REQUIRED' })
})

test('Desktop launch is a fixed app command with an audit, not a task or arbitrary URL', async t => {
  const { service, launches, audit } = await setup(t)
  assert.equal((await service.openDesktop()).status, 'launch-requested')
  assert.deepEqual(launches[0].args, ['-a', '/Applications/Antigravity.app'])
  assert.equal(launches[0].file, '/usr/bin/open')
  assert.deepEqual(audit.map(row => row.kind), ['antigravity.desktop.requested', 'antigravity.desktop.launched'])
})

test('Linux desktop handoff launches only the installed Antigravity app in the desktop session', async t => {
  const desktop = []
  const { service, launches, audit } = await setup(t, 'success', {
    platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-1', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus', AWS_SECRET_ACCESS_KEY: 'SECRET' },
    launchProcessImpl: async (...args) => desktop.push(args),
  })
  assert.deepEqual(await service.openDesktop(), { status: 'launch-requested', taskStarted: false })
  assert.equal(desktop[0][0], '/usr/bin/antigravity')
  assert.deepEqual(desktop[0][1], [])
  assert.equal(desktop[0][2].env.WAYLAND_DISPLAY, 'wayland-1')
  assert.equal(desktop[0][2].env.AWS_SECRET_ACCESS_KEY, undefined)
  assert.equal(launches.length, 0)
  assert.deepEqual(audit.map(x => x.kind), ['antigravity.desktop.requested', 'antigravity.desktop.launched'])
})

test('Desktop launch stops before dispatch when the requested audit cannot be recorded', async t => {
  const { service, launches } = await setup(t, 'success', { appendAudit: () => { throw new Error('private audit failure') } })
  await assert.rejects(service.openDesktop(), { code: 'ANTIGRAVITY_AUDIT_UNAVAILABLE' })
  assert.equal(launches.length, 0)
})

test('A launched app with a failed completion audit is reported as uncertain, without retry', async t => {
  let auditCalls = 0
  const { service, launches } = await setup(t, 'success', { appendAudit: () => { if (++auditCalls === 2) throw new Error('private audit failure') } })
  await assert.rejects(service.openDesktop(), { code: 'ANTIGRAVITY_DESKTOP_RESULT_UNRECORDED' })
  assert.equal(launches.length, 1)
})

test('An existing router cannot dispatch while a new connection check has withdrawn eligibility', async t => {
  const { service, settingsPath } = await setup(t)
  await service.refresh()
  const router = service.router('gemini-test-high')
  await writeFile(settingsPath, '{"modelProvider":"gemini"}')
  await service.refresh()
  await writeFile(settingsPath, '{}')
  await assert.rejects(router.route('Review', { stage: 'specialist' }), { code: 'ANTIGRAVITY_MODEL_UNAVAILABLE' })
})

test('An invalid structured answer is rejected without claiming a connected session', async t => {
  const { service } = await setup(t, 'empty-summary')
  await service.refresh()
  await assert.rejects(service.router('gemini-test-high').route('Review', { stage: 'specialist' }), { code: 'ANTIGRAVITY_RESPONSE_INVALID' })
  assert.equal(service.state().authenticated, false)
})

test('Harness tool requests are decoded but never executed by the native process', async t => {
  const { service } = await setup(t, 'loop')
  await service.refresh()
  const response = await service.router('gemini-test-high').route('Review', { stage: 'specialist-loop' })
  assert.deepEqual(response.toolCall, { name: 'read', arguments: { path: 'src/main.mjs' } })
})

for (const mode of ['structured', 'structured-null', 'structured-string']) test(`The schema result is decoded for native ${mode} envelopes`, async t => {
  const { service } = await setup(t, mode)
  await service.refresh()
  assert.deepEqual(await service.router('gemini-test-high').route('Review', { stage: 'specialist' }), { summary: 'Fixture answer' })
})

test('Oversized native output is stopped before it can consume unbounded memory', async t => {
  const { service } = await setup(t, 'oversized')
  await service.refresh()
  await assert.rejects(service.router('gemini-test-high').route('Review', { stage: 'specialist' }), { code: 'ANTIGRAVITY_OUTPUT_LIMIT' })
})

test('Native permission denials are actionable even when the CLI reports SUCCESS', async t => {
  const { service, audit } = await setup(t, 'permission')
  await service.refresh()
  await assert.rejects(service.router('gemini-test-high').route('Review', { stage: 'specialist' }), { code: 'ANTIGRAVITY_PERMISSION_REQUIRED' })
  assert.doesNotMatch(JSON.stringify(audit), /SECRET/)
})

test('The native planning prompt supplies its complete schema, including acceptance criteria arrays', async t => {
  const { service } = await setup(t, 'decompose')
  await service.refresh()
  const response = await service.router('gemini-test-high').route('Plan work', { stage: 'decompose' })
  assert.deepEqual(response.tasks[0].acceptanceCriteria, ['Return evidence'])
})

test('The final native JSON revision is selected without accepting intervening prose', async t => {
  const { service } = await setup(t, 'concat')
  await service.refresh()
  assert.deepEqual(await service.router('gemini-test-high').route('Review', { stage: 'specialist' }), { summary: 'Fixture answer' })
  const invalid = await setup(t, 'concat-garbage')
  await invalid.service.refresh()
  await assert.rejects(invalid.service.router('gemini-test-high').route('Review', { stage: 'specialist' }), { code: 'MODEL_RESPONSE_INVALID_JSON' })
})
