import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryAuditLog } from '../src/audit-log.mjs'
import { createClaudeCodeConnection } from '../src/ceo/claude-code-provider.mjs'
import { OpenRouterSettings } from '../src/ceo/openrouter-settings.mjs'
import { LocalModelFabricRegistry } from '../src/ceo/local-model-fabric.mjs'
import { validateModelRouter } from '../src/ceo/model-router.mjs'
import { ChimeraBrowserRuntime } from '../src/browser/runtime.mjs'

function fakeClaudeProcess(calls) {
  return (binary, args, options) => {
    const child = new EventEmitter()
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => {}
    let input = ''
    child.stdin.on('data', chunk => { input += chunk.toString('utf8') })
    child.stdin.on('finish', () => {
      calls.push({ binary, args, options, input })
      setImmediate(() => {
        child.stdout.write(JSON.stringify({ is_error: false, structured_output: { summary: 'Claude completed the task.' } }))
        child.emit('close', 0)
      })
    })
    return child
  }
}

test('Claude Code checks local sign-in and sends bounded task text only on stdin', async () => {
  const calls = []
  const commands = []
  const connection = createClaudeCodeConnection({
    env: { HOME: '/tmp/test-home', PATH: '/usr/bin', ANTHROPIC_API_KEY: 'secret-never-forward', ANTHROPIC_BASE_URL: 'https://example.invalid' },
    execFileImpl: async (_binary, args, options) => {
      commands.push({ args, options })
      return { stdout: args[0] === '--version' ? '2.1.281 (Claude Code)' : JSON.stringify({ loggedIn: true }) }
    },
    spawnImpl: fakeClaudeProcess(calls),
  })
  assert.equal((await connection.refresh()).configured, true)
  assert.deepEqual(commands.map(command => command.args), [['--version'], ['auth', 'status']])
  assert.equal(commands[1].options.env.ANTHROPIC_API_KEY, undefined)
  const result = await connection.router('sonnet').route('Sensitive task data', { stage: 'specialist' })
  assert.deepEqual(result, { summary: 'Claude completed the task.' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].args.join(' ').includes('Sensitive task data'), false)
  assert.match(calls[0].input, /Sensitive task data/)
  for (const flag of ['--restricted', '--safe-mode', '--strict-mcp-config', '--tools', '--no-session-persistence', '--json-schema']) {
    assert.ok(calls[0].args.includes(flag), flag)
  }
  assert.equal(calls[0].args[calls[0].args.indexOf('--tools') + 1], '')
  assert.equal(calls[0].options.env.ANTHROPIC_API_KEY, undefined)
  assert.equal(calls[0].options.cwd.startsWith(tmpdir()), true)
})

test('Claude Code refuses a signed-out or old CLI before a model call', async () => {
  const connection = createClaudeCodeConnection({ execFileImpl: async (_binary, args) => ({
    stdout: args[0] === '--version' ? '2.1.281 (Claude Code)' : JSON.stringify({ loggedIn: false }),
  }) })
  assert.equal((await connection.refresh()).status, 'sign-in-required')
  assert.throws(() => connection.router('sonnet'), error => error.code === 'CLAUDE_CODE_MODEL_UNAVAILABLE')
  const old = createClaudeCodeConnection({ execFileImpl: async () => ({ stdout: '2.1.247 (Claude Code)' }) })
  assert.equal((await old.refresh()).status, 'cli-update-required')
})

test('OpenRouter settings keep the key private, persist models, and revoke the key on disconnect', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-openrouter-test-'))
  try {
    const filePath = join(directory, 'private', 'settings.json')
    const settings = await OpenRouterSettings.open({ filePath })
    assert.equal(settings.status().configured, false)
    assert.deepEqual(settings.models(), ['openrouter/free'])
    const key = 'synthetic_openrouter_key_123456789'
    assert.deepEqual(await settings.save({ apiKey: key, models: ['openrouter/free', 'anthropic/claude-sonnet-4'] }),
      { configured: true, provider: 'openrouter', models: ['openrouter/free', 'anthropic/claude-sonnet-4'] })
    assert.equal(JSON.stringify(settings.status()).includes(key), false)
    assert.equal((await stat(filePath)).mode & 0o077, 0)
    assert.equal((await stat(join(directory, 'private'))).mode & 0o077, 0)
    assert.equal((await readFile(filePath, 'utf8')).includes(key), true)
    assert.equal((await OpenRouterSettings.open({ filePath })).apiKey(), key)
    assert.equal((await settings.disconnect()).configured, false)
    assert.equal(settings.apiKey(), null)
    await assert.rejects(readFile(filePath, 'utf8'), { code: 'ENOENT' })
    await assert.rejects(settings.save({ apiKey: key, models: ['invalid'] }), error => error.code === 'OPENROUTER_MODELS_INVALID')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('OpenRouter becomes an Auto and pinned route when saved, then disconnect removes future access', async () => {
  let key = null
  const calls = []
  const registry = await LocalModelFabricRegistry.open({
    config: { schema: 'chimera.model-routing.v1', region: 'us-west-2',
      codex: { model: 'gpt-5.6-sol', reasoningEffort: 'high' }, bedrockRoutes: [],
      openAiCompatibleProviders: [{ id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1',
        apiKeyEnv: 'CHIMERA_OPENROUTER_SETTINGS_KEY', models: [{ id: 'openrouter/free', name: 'openrouter/free',
          capabilities: ['conversation', 'orchestration'], inputModalities: ['TEXT'], outputModalities: ['TEXT'] }] }] },
    audit: new MemoryAuditLog(), workingDirectory: '/tmp', codexStatus: { configured: false },
    bedrockModels: [], bedrockProfiles: [], mantleSigner: null, env: {},
    openAiCompatibleKeyResolvers: { openrouter: () => key },
    openAiCompatibleFetch: async (_url, options) => {
      calls.push(options.headers.authorization)
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '{"summary":"OpenRouter completed the task."}' } }] }) }
    },
  })
  assert.equal(registry.state().selected, null)
  key = 'synthetic_openrouter_key_123456789'
  registry.setOpenAiCompatibleModels('openrouter', ['openrouter/free'])
  assert.equal(registry.state().selected.providerId, 'chimera-auto')
  assert.equal(registry.describeSelection({ mode: 'pinned', providerId: 'openrouter', model: 'openrouter/free' }).eligible, true)
  const router = await registry.routerFor({ mode: 'pinned', providerId: 'openrouter', model: 'openrouter/free' })
  assert.deepEqual(await router.route('Summarize.', { stage: 'specialist' }), { summary: 'OpenRouter completed the task.' })
  assert.deepEqual(calls, [`Bearer ${key}`])
  key = null
  registry.setOpenAiCompatibleModels('openrouter', ['openrouter/free'])
  assert.equal(registry.state().selected, null)
  await assert.rejects(router.route('Summarize.', { stage: 'specialist' }), error => error.code === 'MODEL_PROVIDER_AUTH_REQUIRED')
  assert.equal(calls.length, 1)
})

test('signed-in Claude Code is available for RJ task routing and inference-only Ask', async () => {
  const claudeCode = {
    state: () => ({ configured: true, status: 'connected', models: [{ id: 'sonnet', name: 'Claude Sonnet' }] }),
    router: model => validateModelRouter({ routerId: `claude-code:${model}`,
      descriptor: { providerId: 'claude-code', model, execution: 'inference-only' },
      async route(_prompt, context) { return context.stage === 'ask' ? { answer: 'Claude answer.' } : { summary: 'Claude summary.' } } }),
  }
  const registry = await LocalModelFabricRegistry.open({
    config: { schema: 'chimera.model-routing.v1', region: 'us-west-2',
      codex: { model: 'gpt-5.6-sol', reasoningEffort: 'high' }, bedrockRoutes: [] },
    audit: new MemoryAuditLog(), workingDirectory: '/tmp', codexStatus: { configured: false },
    claudeCode, bedrockModels: [], bedrockProfiles: [], mantleSigner: null, env: {},
  })
  const state = registry.state()
  assert.equal(state.providers.find(provider => provider.id === 'claude-code').configured, true)
  const catalogModels = state.providers.filter(provider => !['codex', 'antigravity'].includes(provider.id))
    .flatMap(provider => provider.models)
  assert.equal(state.catalog.total, catalogModels.length)
  assert.equal(state.catalog.capabilityCounts.orchestration,
    catalogModels.filter(model => model.capabilities.includes('orchestration')).length)
  assert.equal(state.selected.providerId, 'chimera-auto')
  assert.equal(registry.describeSelection({ mode: 'pinned', providerId: 'claude-code', model: 'sonnet' }).eligible, true)
  assert.deepEqual(await (await registry.routerFor({ mode: 'pinned', providerId: 'claude-code', model: 'sonnet' }))
    .route('Summarize.', { stage: 'specialist' }), { summary: 'Claude summary.' })
  const ask = await registry.routerForAsk({ mode: 'pinned', providerId: 'claude-code', model: 'sonnet' })
  assert.deepEqual(await ask.route('Ask.', { stage: 'ask' }), { answer: 'Claude answer.' })
})

test('runtime Settings updates the live OpenRouter catalog without returning the key', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-openrouter-'))
  try {
    const settings = await OpenRouterSettings.open({ filePath: join(directory, 'openrouter/settings.json') })
    const updates = []
    const runtime = new ChimeraBrowserRuntime({ profileDir: join(directory, 'profiles/ceo'),
      openRouterSettings: settings, audit: new MemoryAuditLog() })
    runtime.modelConfig = { openAiCompatibleProviders: [{ id: 'openrouter', models: [] }] }
    runtime.models = { setOpenAiCompatibleModels: (providerId, models) => updates.push({ providerId, models }) }
    const status = await runtime.saveOpenRouterSettings({ apiKey: 'synthetic_openrouter_key_123456789', models: ['openrouter/free'] })
    assert.equal(status.configured, true)
    assert.equal(JSON.stringify(status).includes('synthetic_openrouter_key_123456789'), false)
    assert.deepEqual(updates, [{ providerId: 'openrouter', models: ['openrouter/free'] }])
    assert.deepEqual(runtime.modelConfig.openAiCompatibleProviders[0].models[0].capabilities,
      ['conversation', 'orchestration', 'coding', 'reasoning', 'research', 'bulk'])
    assert.equal((await runtime.disconnectOpenRouter()).configured, false)
    assert.equal(settings.apiKey(), null)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
