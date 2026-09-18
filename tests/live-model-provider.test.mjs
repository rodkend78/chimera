import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoryAuditLog } from '../src/audit-log.mjs'
import {
  ModelProviderRegistry,
  createOpenAiCompatibleModelRouter,
} from '../src/ceo/live-model-provider.mjs'

function response(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

test('OpenAI-compatible provider keeps credentials server-side and returns structured CEO output', async () => {
  const requests = []
  const router = createOpenAiCompatibleModelRouter({
    providerId: 'openrouter',
    model: 'openrouter/free',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'server-secret',
    fetchImpl: async (url, options) => {
      requests.push({ url, options })
      return response({
        id: 'completion-1',
        model: 'openrouter/free',
        choices: [{ message: { role: 'assistant', content: '{"tasks":[{"specialistAgentId":"researcher","objective":"Inspect evidence","acceptanceCriteria":["Cite the source"]}]}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 12, total_tokens: 22 },
      })
    },
  })

  const result = await router.route('Plan the task.', { stage: 'decompose', taskId: 'task-live-1' })

  assert.equal(result.tasks[0].specialistAgentId, 'researcher')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://openrouter.ai/api/v1/chat/completions')
  assert.equal(requests[0].options.headers.authorization, 'Bearer server-secret')
  const body = JSON.parse(requests[0].options.body)
  assert.equal(body.model, 'openrouter/free')
  assert.equal(body.response_format.type, 'json_object')
  assert.equal(body.messages[0].role, 'system')
  assert.equal(JSON.stringify(router.descriptor).includes('server-secret'), false)
})

test('provider rejects unsafe endpoints and malformed model responses', async () => {
  assert.throws(() => createOpenAiCompatibleModelRouter({
    providerId: 'unsafe',
    model: 'model',
    baseUrl: 'http://169.254.169.254/latest',
    apiKey: 'secret',
  }), /MODEL_PROVIDER_BASE_URL_UNSAFE/)

  const router = createOpenAiCompatibleModelRouter({
    providerId: 'fixture',
    model: 'model',
    baseUrl: 'https://models.example.com/v1',
    apiKey: 'secret',
    fetchImpl: async () => response({ choices: [{ message: { content: 'not json' } }] }),
  })
  await assert.rejects(
    router.route('Return a plan.', { stage: 'decompose' }),
    /MODEL_RESPONSE_INVALID_JSON/,
  )
})

test('provider registry exposes availability without secrets and persists a human selection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-model-provider-'))
  const selectionFile = join(directory, 'selection.json')
  const providers = [
    {
      id: 'openrouter',
      name: 'OpenRouter',
      protocol: 'openai-chat-completions',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKeyEnv: 'OPENROUTER_API_KEY',
      models: [
        { id: 'openrouter/free', name: 'OpenRouter Free' },
        { id: '~openai/gpt-latest', name: 'OpenAI Latest' },
      ],
    },
    {
      id: 'deepseek',
      name: 'DeepSeek',
      protocol: 'openai-chat-completions',
      baseUrl: 'https://api.deepseek.com',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }],
    },
  ]
  const audit = new MemoryAuditLog()
  try {
    const registry = await ModelProviderRegistry.open({
      providers,
      selectionFile,
      env: { OPENROUTER_API_KEY: 'server-only-key' },
      audit,
      now: () => Date.parse('2026-08-27T20:00:00.000Z'),
      fetchImpl: async () => response({ choices: [{ message: { content: '{}' } }] }),
    })

    const initial = registry.state()
    assert.equal(initial.selected.providerId, 'openrouter')
    assert.equal(initial.selected.model, 'openrouter/free')
    assert.equal(initial.providers.find((provider) => provider.id === 'openrouter').configured, true)
    assert.equal(initial.providers.find((provider) => provider.id === 'deepseek').configured, false)
    assert.equal(JSON.stringify(initial).includes('server-only-key'), false)

    const selected = await registry.select({ providerId: 'openrouter', model: '~openai/gpt-latest' })
    assert.equal(selected.selected.model, '~openai/gpt-latest')
    assert.equal(registry.router().routerId, 'openai-compatible:openrouter:~openai/gpt-latest')
    assert.deepEqual(JSON.parse(await readFile(selectionFile, 'utf8')), {
      schema: 'chimera.model-selection.v1',
      providerId: 'openrouter',
      model: '~openai/gpt-latest',
      updatedAt: '2026-08-27T20:00:00.000Z',
    })
    assert.equal(audit.entries().map((entry) => entry.fact).some((fact) => (
      fact.kind === 'model.selection.changed' && fact.model === '~openai/gpt-latest'
    )), true)

    const restarted = await ModelProviderRegistry.open({
      providers,
      selectionFile,
      env: { OPENROUTER_API_KEY: 'server-only-key' },
      audit: new MemoryAuditLog(),
      fetchImpl: async () => response({ choices: [{ message: { content: '{}' } }] }),
    })
    assert.equal(restarted.state().selected.model, '~openai/gpt-latest')
    await assert.rejects(
      restarted.select({ providerId: 'deepseek', model: 'deepseek-v4-flash' }),
      /MODEL_PROVIDER_NOT_CONFIGURED/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
