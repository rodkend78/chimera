import assert from 'node:assert/strict'
import test from 'node:test'
import { MemoryAuditLog } from '../src/audit-log.mjs'
import {
  LocalModelFabricRegistry,
  detectCodexSubscription,
} from '../src/ceo/local-model-fabric.mjs'

test('Codex subscription detection exposes only safe authentication status', async () => {
  assert.deepEqual(await detectCodexSubscription({
    execFileImpl: async () => ({ stdout: 'Logged in using ChatGPT\n', stderr: '' }),
  }), { available: true, configured: true, authentication: 'chatgpt-subscription' })
  assert.deepEqual(await detectCodexSubscription({
    execFileImpl: async () => ({ stdout: 'Logged in using an API key\n', stderr: '' }),
  }), { available: true, configured: false, authentication: null })
})

test('Codex subscription detection accepts status written to stderr by the CLI', async () => {
  const state = await detectCodexSubscription({
    execFileImpl: async () => ({ stdout: '', stderr: 'Logged in using ChatGPT\n' }),
  })

  assert.deepEqual(state, {
    available: true,
    configured: true,
    authentication: 'chatgpt-subscription',
  })
})

test('Codex subscription detection distinguishes an installed signed-out CLI from a missing CLI', async () => {
  const signedOut = new Error('Not logged in')
  signedOut.code = 1
  assert.deepEqual(await detectCodexSubscription({
    execFileImpl: async () => { throw signedOut },
  }), { available: true, configured: false, authentication: null })

  const missing = new Error('spawn codex ENOENT')
  missing.code = 'ENOENT'
  assert.deepEqual(await detectCodexSubscription({
    execFileImpl: async () => { throw missing },
  }), { available: false, configured: false, authentication: null })
})

test('local model fabric remains available for provider connection when no route is configured', async () => {
  const registry = await LocalModelFabricRegistry.open({
    config: {
      schema: 'chimera.model-routing.v1',
      region: 'us-west-2',
      codex: { model: 'gpt-5.6-sol', reasoningEffort: 'high' },
      bedrockRoutes: [],
    },
    audit: new MemoryAuditLog(),
    workingDirectory: '/workspace/chimera',
    codexStatus: { configured: false, authentication: null },
    bedrockModels: [],
    bedrockProfiles: [],
  })

  assert.equal(registry.state().selected, null)
  assert.throws(() => registry.router(), (error) => error.code === 'NO_MODEL_PROVIDER_CONFIGURED')
})

test('local model fabric routes CEO to Codex and specialists to verified Bedrock models', async () => {
  const codexRuns = []
  const bedrockRuns = []
  const codex = {
    startThread() {
      return {
        async run(prompt) {
          codexRuns.push(prompt)
          const stage = prompt.includes('"stage":"decompose"') ? 'decompose' : 'synthesize'
          return {
            finalResponse: stage === 'decompose'
              ? '{"tasks":[{"specialistAgentId":"researcher","objective":"Research the evidence.","acceptanceCriteria":["Cite it."]}]}'
              : '{"summary":"CEO synthesis."}',
            items: [],
            usage: null,
          }
        },
      }
    },
  }
  const bedrockRuntime = {
    async send(command) {
      bedrockRuns.push(structuredClone(command.input))
      return {
        output: { message: { role: 'assistant', content: [{ text: '{"summary":"Bedrock research."}' }] } },
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
      }
    },
  }
  const audit = new MemoryAuditLog()
  const registry = await LocalModelFabricRegistry.open({
    config: {
      schema: 'chimera.model-routing.v1',
      region: 'us-west-2',
      codex: { model: 'gpt-5.6-sol', reasoningEffort: 'high' },
      bedrockRoutes: [
        { id: 'bedrock-fast', model: 'us.amazon.nova-micro-v1:0', capabilities: ['bulk'], costClass: 'low' },
        { id: 'bedrock-research', model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', capabilities: ['research'], costClass: 'medium' },
      ],
    },
    audit,
    workingDirectory: '/workspace/chimera',
    codexStatus: { configured: true, authentication: 'chatgpt-subscription' },
    codexClient: codex,
    bedrockRuntimeClient: bedrockRuntime,
    bedrockModels: [
      { id: 'amazon.nova-micro-v1:0', name: 'Nova Micro', provider: 'Amazon', inputModalities: ['TEXT'], outputModalities: ['TEXT'], streaming: true },
      { id: 'anthropic.claude-haiku-4-5-20251001-v1:0', name: 'Claude Haiku 4.5', provider: 'Anthropic', inputModalities: ['TEXT'], outputModalities: ['TEXT'], streaming: true },
    ],
    bedrockProfiles: [
      { id: 'us.amazon.nova-micro-v1:0', name: 'US Nova Micro', models: [] },
      { id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', name: 'US Claude Haiku 4.5', models: [] },
    ],
    bedrockCommandFactory: async (input) => ({ input }),
  })

  const state = registry.state()
  assert.equal(state.selected.providerId, 'chimera-auto')
  assert.equal(state.providers.find((provider) => provider.id === 'codex').configured, true)
  assert.equal(state.providers.find((provider) => provider.id === 'aws-bedrock').configured, true)
  assert.equal(JSON.stringify(state).includes('token'), false)

  const router = registry.router()
  assert.ok((await router.route('Plan it.', { stage: 'decompose', taskId: 'fabric-1' })).tasks)
  assert.equal((await router.route('Research the evidence.', { stage: 'specialist', taskId: 'fabric-1:1' })).summary, 'Bedrock research.')
  assert.equal((await router.route('Synthesize it.', { stage: 'synthesize', taskId: 'fabric-1' })).summary, 'CEO synthesis.')
  assert.equal(codexRuns.length, 2)
  assert.equal(bedrockRuns.length, 1)
  assert.equal(bedrockRuns[0].modelId, 'us.anthropic.claude-haiku-4-5-20251001-v1:0')
})

test('per-agent explicit routers do not mutate the global Chimera Auto selection', async () => {
  const registry = await LocalModelFabricRegistry.open({
    config: {
      schema: 'chimera.model-routing.v1',
      region: 'us-west-2',
      codex: { model: 'gpt-5.6-sol', reasoningEffort: 'high' },
      bedrockRoutes: [],
    },
    audit: new MemoryAuditLog(),
    workingDirectory: '/workspace/chimera',
    codexStatus: { configured: true, authentication: 'chatgpt-subscription' },
    codexClient: {
      startThread() {
        return { async run() { return { finalResponse: '{"summary":"Codex handled the agent turn."}', items: [], usage: null } } }
      },
    },
    bedrockModels: [],
    bedrockProfiles: [],
  })

  assert.equal(registry.state().selected.providerId, 'chimera-auto')
  const pinned = await registry.routerFor({ mode: 'pinned', providerId: 'codex', model: 'gpt-5.6-sol' })
  assert.equal((await pinned.route('Handle this.', { stage: 'specialist', taskId: 'agent-model-1' })).summary, 'Codex handled the agent turn.')
  assert.equal(registry.state().selected.providerId, 'chimera-auto')
})

test('local model fabric verifies and pins an authenticated OpenAI-compatible cloud model', async () => {
  const requests = []
  const registry = await LocalModelFabricRegistry.open({
    config: {
      schema: 'chimera.model-routing.v1',
      region: 'us-west-2',
      codex: { model: 'gpt-5.6-sol', reasoningEffort: 'high' },
      bedrockRoutes: [],
      openAiCompatibleProviders: [{
        id: 'lambda-qwen',
        name: 'Qwen Cloud H100',
        baseUrl: 'http://127.0.0.1:18000/v1',
        apiKeyEnv: 'CHIMERA_QWEN_CLOUD_API_KEY',
        models: [{
          id: 'Qwen/Qwen3.8-27B-FP8',
          name: 'Qwen 3.8 27B FP8',
          capabilities: ['conversation', 'coding', 'reasoning', 'research', 'bulk'],
        }],
      }],
    },
    audit: new MemoryAuditLog(),
    workingDirectory: '/workspace/chimera',
    codexStatus: { configured: false, authentication: null },
    bedrockModels: [],
    bedrockProfiles: [],
    env: { CHIMERA_QWEN_CLOUD_API_KEY: 'private-cloud-key' },
    openAiCompatibleFetch: async (url, init) => {
      requests.push({ url, headers: init.headers, body: JSON.parse(init.body) })
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            choices: [{ message: { content: requests.length === 1
              ? '{"summary":"Qwen route verified."}'
              : '{"summary":"Iris completed it on Qwen."}' } }],
          })
        },
      }
    },
  })

  const initial = registry.state()
  const provider = initial.providers.find((entry) => entry.id === 'lambda-qwen')
  assert.equal(provider.configured, true)
  assert.equal(provider.models[0].availability, 'authenticated')
  assert.equal(JSON.stringify(initial).includes('private-cloud-key'), false)
  assert.equal(JSON.stringify(initial).includes('127.0.0.1:18000'), false)

  const checked = await registry.check({ providerId: 'lambda-qwen', model: 'Qwen/Qwen3.8-27B-FP8' })
  assert.equal(checked.availability, 'verified-manual')
  const pinned = await registry.routerFor({
    mode: 'pinned',
    providerId: 'lambda-qwen',
    model: 'Qwen/Qwen3.8-27B-FP8',
  })
  assert.equal((await pinned.route('Handle this.', { stage: 'specialist', taskId: 'iris-qwen-1' })).summary,
    'Iris completed it on Qwen.')
  assert.equal(requests[0].url, 'http://127.0.0.1:18000/v1/chat/completions')
  assert.equal(requests[0].body.model, 'Qwen/Qwen3.8-27B-FP8')
  assert.equal(requests[0].headers.authorization, 'Bearer private-cloud-key')
})

test('local model fabric verifies and manually selects a catalog-listed Bedrock text model', async () => {
  const controlRequests = []
  const runtimeRequests = []
  const registry = await LocalModelFabricRegistry.open({
    config: {
      schema: 'chimera.model-routing.v1',
      region: 'us-west-2',
      codex: { model: 'gpt-5.6-sol', reasoningEffort: 'high' },
      bedrockRoutes: [],
    },
    audit: new MemoryAuditLog(),
    workingDirectory: '/workspace/chimera',
    codexStatus: { configured: false, authentication: null },
    bedrockControlClient: {
      async send(command) {
        controlRequests.push(structuredClone(command.input))
        return {
          agreementAvailability: { status: 'AVAILABLE' },
          authorizationStatus: 'AUTHORIZED',
          entitlementAvailability: 'AVAILABLE',
          regionAvailability: 'AVAILABLE',
        }
      },
    },
    bedrockRuntimeClient: {
      async send(command) {
        runtimeRequests.push(structuredClone(command.input))
        if (command.input.inferenceConfig.maxTokens === 4) {
          return { output: { message: { content: [{ text: 'OK.' }] } } }
        }
        return { output: { message: { content: [{ text: '{"summary":"Opus completed it."}' }] } } }
      },
    },
    bedrockModels: [{
      id: 'anthropic.claude-opus-4-6-v1',
      name: 'Claude Opus 4.6',
      provider: 'Anthropic',
      inputModalities: ['TEXT', 'IMAGE'],
      outputModalities: ['TEXT'],
      inferenceTypes: ['INFERENCE_PROFILE'],
      streaming: true,
    }],
    bedrockProfiles: [{
      id: 'us.anthropic.claude-opus-4-6-v1',
      name: 'US Claude Opus 4.6',
      models: ['arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-opus-4-6-v1'],
    }],
    bedrockAvailabilityCommandFactory: async (input) => ({ input }),
    bedrockCommandFactory: async (input) => ({ input }),
  })

  assert.equal(registry.state().selected, null)
  await registry.select({ providerId: 'aws-bedrock', model: 'us.anthropic.claude-opus-4-6-v1' })
  assert.equal(registry.state().selected.modelName, 'US Claude Opus 4.6')
  assert.equal(registry.state().mode, 'manual')
  assert.equal(registry.state().providers[1].models[0].availability, 'verified-manual')
  assert.equal((await registry.router().route('Do it.', { stage: 'specialist' })).summary, 'Opus completed it.')
  assert.deepEqual(controlRequests, [{ modelId: 'anthropic.claude-opus-4-6-v1' }])
  assert.equal(runtimeRequests[0].inferenceConfig.maxTokens, 4)
})

test('local model fabric exposes installed media adapters and keeps them out of text model selection', async () => {
  const runtimeRequests = []
  const registry = await LocalModelFabricRegistry.open({
    config: {
      schema: 'chimera.model-routing.v1',
      region: 'us-west-2',
      codex: { model: 'gpt-5.6-sol', reasoningEffort: 'high' },
      bedrockRoutes: [],
      media: {
        imageModel: 'stability.stable-image-ultra-v1:1',
        videoModel: 'luma.ray-v2:0',
        videoOutputS3Uri: 's3://chimera-media/jobs',
      },
    },
    audit: new MemoryAuditLog(),
    workingDirectory: '/workspace/chimera',
    codexStatus: { configured: false, authentication: null },
    bedrockControlClient: {
      async send() {
        return {
          agreementAvailability: { status: 'AVAILABLE' },
          authorizationStatus: 'AUTHORIZED',
          entitlementAvailability: 'AVAILABLE',
          regionAvailability: 'AVAILABLE',
        }
      },
    },
    bedrockRuntimeClient: {
      async send(command) {
        runtimeRequests.push(structuredClone(command.input))
        if (command.input.modelInput) return { invocationArn: 'arn:aws:bedrock:us-west-2:123456789012:async-invoke/video-1' }
        return {
          body: new TextEncoder().encode(JSON.stringify({
            seeds: [9],
            finish_reasons: [null],
            images: [Buffer.from('image').toString('base64')],
          })),
        }
      },
    },
    bedrockModels: [
      {
        id: 'stability.stable-image-ultra-v1:1',
        name: 'Stable Image Ultra 1.0',
        provider: 'Stability AI',
        inputModalities: ['TEXT'],
        outputModalities: ['IMAGE'],
        inferenceTypes: ['ON_DEMAND'],
        streaming: false,
      },
      {
        id: 'luma.ray-v2:0',
        name: 'Ray v2',
        provider: 'Luma AI',
        inputModalities: ['TEXT'],
        outputModalities: ['VIDEO'],
        inferenceTypes: ['ON_DEMAND'],
        streaming: false,
      },
    ],
    bedrockProfiles: [],
    bedrockAvailabilityCommandFactory: async (input) => ({ input }),
    bedrockImageCommandFactory: async (input) => ({ input }),
    bedrockVideoStartCommandFactory: async (input) => ({ input }),
    mediaIdFactory: () => 'video-1',
  })

  const models = registry.state().providers[1].models
  assert.deepEqual(models.map((model) => model.adapter), ['ready', 'ready'])
  assert.equal((await registry.check({ providerId: 'aws-bedrock', model: models[0].id })).availability, 'adapter-ready')
  await assert.rejects(
    registry.select({ providerId: 'aws-bedrock', model: models[0].id }),
    (error) => error.code === 'MODEL_REQUIRES_SPECIALIST_ADAPTER',
  )

  const image = await registry.generateMedia({
    model: 'stability.stable-image-ultra-v1:1',
    prompt: 'A mechanical chimera.',
    aspectRatio: '1:1',
  })
  assert.equal(image.kind, 'image')
  assert.equal(image.status, 'completed')
  const video = await registry.generateMedia({
    model: 'luma.ray-v2:0',
    prompt: 'A slow orbital move around a mechanical chimera.',
  })
  assert.equal(video.kind, 'video')
  assert.equal(video.status, 'in-progress')
  assert.equal(Object.hasOwn(video, 'invocationArn'), false)
  assert.equal(Object.hasOwn(video, 'outputS3Uri'), false)
  assert.equal(Object.hasOwn(registry.state().media.jobs[0], 'invocationArn'), false)
  assert.equal(Object.hasOwn(registry.state().media.jobs[0], 'outputS3Uri'), false)
  assert.equal(runtimeRequests[0].modelId, 'stability.stable-image-ultra-v1:1')
  assert.equal(runtimeRequests[1].modelId, 'luma.ray-v2:0')
})

test('local model fabric keeps Mantle distinct and selects Grok and Gemma by exact project model id', async () => {
  const requests = []
  const registry = await LocalModelFabricRegistry.open({
    config: {
      schema: 'chimera.model-routing.v1',
      region: 'us-west-2',
      codex: { model: 'gpt-5.6-sol', reasoningEffort: 'high' },
      bedrockRoutes: [],
      mantle: {
        project: 'default',
        baseUrl: 'https://bedrock-mantle.us-west-2.api.aws/v1',
        priorityModels: [
          { id: 'xai.grok-4.6', name: 'Grok 4.6', provider: 'xAI', inputModalities: ['TEXT', 'IMAGE'], outputModalities: ['TEXT'], capabilities: ['conversation', 'research'], strengths: ['research', 'reasoning', 'coding'] },
          { id: 'google.gemma-4-31b', name: 'Gemma 4 31B', provider: 'Google', inputModalities: ['TEXT', 'IMAGE', 'VIDEO'], outputModalities: ['TEXT'], capabilities: ['conversation', 'multimodal-understanding'] },
        ],
        routes: [],
      },
    },
    audit: new MemoryAuditLog(),
    workingDirectory: '/workspace/chimera',
    codexStatus: { configured: false, authentication: null },
    bedrockModels: [],
    bedrockProfiles: [],
    mantleApiKey: 'bedrock-secret',
    mantleFetch: async (url, init) => {
      requests.push({ url, body: init.body ? JSON.parse(init.body) : null })
      if (url.endsWith('/models')) {
        return { ok: true, status: 200, async json() { return { data: [{ id: 'xai.grok-4.6' }, { id: 'google.gemma-4-31b' }] } } }
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return { choices: [{ message: { content: requests.length === 2 ? 'OK.' : '{"summary":"Grok completed it."}' } }] }
        },
      }
    },
  })

  const state = registry.state()
  const mantle = state.providers.find((provider) => provider.id === 'aws-bedrock-mantle')
  assert.equal(mantle.configured, true)
  assert.deepEqual(mantle.models.map((model) => model.id), ['google.gemma-4-31b', 'xai.grok-4.6'])
  assert.deepEqual(mantle.models.find((model) => model.id === 'xai.grok-4.6').strengths,
    ['research', 'reasoning', 'coding'])
  assert.equal(JSON.stringify(state).includes('bedrock-secret'), false)

  await registry.select({ providerId: 'aws-bedrock-mantle', model: 'xai.grok-4.6' })
  assert.equal(registry.state().selected.providerId, 'aws-bedrock-mantle')
  assert.equal((await registry.router().route('Research it.', { stage: 'specialist' })).summary, 'Grok completed it.')
  assert.equal(requests[1].body.model, 'xai.grok-4.6')
})

test('startup discovers Mantle routes without paid probes or claiming inference is verified', async () => {
  const requests = []
  const registry = await LocalModelFabricRegistry.open({
    config: {
      schema: 'chimera.model-routing.v1', region: 'us-west-2',
      codex: { model: 'gpt-5.6-sol', reasoningEffort: 'high' }, bedrockRoutes: [],
      mantle: { routes: [
        { id: 'grok-research', model: 'xai.grok-4.6', capabilities: ['research'], costClass: 'premium' },
        { id: 'missing', model: 'missing.model', capabilities: ['bulk'], costClass: 'low' },
      ] },
    },
    audit: new MemoryAuditLog(), workingDirectory: '/workspace/chimera',
    codexStatus: { configured: false }, bedrockModels: [], bedrockProfiles: [],
    mantleApiKey: 'test-only',
    mantleFetch: async (url, init) => {
      requests.push({ url, method: init.method, body: init.body })
      if (url.endsWith('/models')) return {
        ok: true, status: 200, async json() { return { data: [{ id: 'xai.grok-4.6' }] } },
      }
      return { ok: true, status: 200, async json() {
        return { choices: [{ message: { content: '{"summary":"Task completed."}' } }] }
      } }
    },
  })
  assert.equal(requests.length, 1, 'startup must only discover the catalog')
  assert.equal(requests[0].method, 'GET')
  const state = registry.state()
  assert.equal(state.providers.find(p => p.id === 'aws-bedrock-mantle').models
    .find(m => m.id === 'xai.grok-4.6').availability, 'catalog-only')
  assert.deepEqual(state.routing.map(route => route.id), ['grok-research'])
  assert.equal((await registry.router().route('Research this.', { stage: 'specialist' })).summary, 'Task completed.')
  assert.equal(requests.length, 2, 'only the requested task may generate')
  assert.equal(JSON.parse(requests[1].body).model, 'xai.grok-4.6')
})

test('local model fabric advertises priority Mantle routes but never marks them connected without a key', async () => {
  const registry = await LocalModelFabricRegistry.open({
    config: {
      schema: 'chimera.model-routing.v1',
      region: 'us-west-2',
      codex: { model: 'gpt-5.6-sol', reasoningEffort: 'high' },
      bedrockRoutes: [],
    },
    audit: new MemoryAuditLog(),
    workingDirectory: '/workspace/chimera',
    codexStatus: { configured: false, authentication: null },
    bedrockModels: [],
    bedrockProfiles: [],
    env: {},
  })

  const mantle = registry.state().providers.find((provider) => provider.id === 'aws-bedrock-mantle')
  assert.equal(mantle.configured, false)
  assert.equal(mantle.connectionStatus, 'authentication-required')
  assert.deepEqual(mantle.models.map((model) => model.id), ['google.gemma-4-31b', 'xai.grok-4.6'])
  assert.ok(mantle.models.every((model) => model.availability === 'access-required'))
})
