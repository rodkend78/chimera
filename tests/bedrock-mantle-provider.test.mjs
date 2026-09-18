import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createMantleModelRouter,
  discoverMantleModels,
  probeMantleModelAccess,
} from '../src/ceo/bedrock-mantle-provider.mjs'

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return structuredClone(body) },
  }
}

test('Mantle discovers project models without exposing its API key', async () => {
  const requests = []
  const models = await discoverMantleModels({
    baseUrl: 'https://bedrock-mantle.us-west-2.api.aws/v1',
    region: 'us-west-2',
    apiKey: 'bedrock-secret',
    project: 'default',
    fetchImpl: async (url, init) => {
      requests.push({ url, init })
      return response({ data: [{ id: 'xai.grok-4.6' }, { id: 'google.gemma-4-31b' }] })
    },
  })

  assert.deepEqual(models, [{ id: 'xai.grok-4.6' }, { id: 'google.gemma-4-31b' }])
  assert.equal(requests[0].url, 'https://bedrock-mantle.us-west-2.api.aws/v1/models')
  assert.equal(requests[0].init.headers['OpenAI-Project'], 'default')
  assert.equal(JSON.stringify(models).includes('secret'), false)
})

test('Mantle probes and routes exact model IDs through OpenAI chat completions', async () => {
  const requests = []
  const fetchImpl = async (url, init) => {
    requests.push({ url, init: { ...init, body: init.body ? JSON.parse(init.body) : null } })
    return response({
      choices: [{ message: { content: requests.length === 1 ? 'OK.' : '{"summary":"Mantle completed it."}' } }],
    })
  }
  const options = {
    fetchImpl,
    baseUrl: 'https://bedrock-mantle.us-west-2.api.aws/v1',
    region: 'us-west-2',
    apiKey: 'bedrock-secret',
    project: 'default',
    modelId: 'google.gemma-4-31b',
  }

  assert.equal((await probeMantleModelAccess(options)).ready, true)
  const router = createMantleModelRouter(options)
  assert.deepEqual(await router.route('Analyze the video notes.', {
    stage: 'specialist',
    taskId: 'mantle-1',
  }), { summary: 'Mantle completed it.' })
  assert.equal(requests[0].init.body.model, 'google.gemma-4-31b')
  assert.equal(requests[0].init.body.max_tokens, 4)
  assert.equal(requests[0].url, 'https://bedrock-mantle.us-west-2.api.aws/openai/v1/chat/completions')
  assert.match(requests[1].init.body.messages[1].content, /mantle-1/)
  assert.equal(router.descriptor.providerId, 'aws-bedrock-mantle')
  assert.equal(JSON.stringify(router.descriptor).includes('secret'), false)
})

test('Mantle can use SigV4 without an API key', async () => {
  const signed = []
  const models = await discoverMantleModels({
    baseUrl: 'https://bedrock-mantle.us-west-2.api.aws/v1',
    region: 'us-west-2',
    project: 'default',
    signer: {
      async sign(request) {
        signed.push(structuredClone(request))
        return { ...request, headers: { ...request.headers, Authorization: 'AWS4-HMAC-SHA256 redacted' } }
      },
    },
    fetchImpl: async (_url, init) => {
      assert.match(init.headers.Authorization, /^AWS4-HMAC-SHA256/)
      return response({ data: [{ id: 'xai.grok-4.6' }] })
    },
  })

  assert.deepEqual(models, [{ id: 'xai.grok-4.6' }])
  assert.equal(signed[0].hostname, 'bedrock-mantle.us-west-2.api.aws')
  assert.equal(signed[0].path, '/v1/models')
})

test('Mantle rejects credential exfiltration through an untrusted base URL', () => {
  assert.throws(() => createMantleModelRouter({
    baseUrl: 'https://attacker.example/v1',
    region: 'us-west-2',
    apiKey: 'bedrock-secret',
    project: 'default',
    modelId: 'xai.grok-4.6',
  }), /invalid Bedrock Mantle base URL/)
})
