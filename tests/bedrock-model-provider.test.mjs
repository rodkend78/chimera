import assert from 'node:assert/strict'
import test from 'node:test'
import {
  checkBedrockModelAvailability,
  createBedrockModelRouter,
  discoverBedrockModels,
  discoverBedrockInferenceProfiles,
  discoverBedrockTextModels,
  probeBedrockConverseAccess,
} from '../src/ceo/bedrock-model-provider.mjs'

test('Bedrock discovery returns only active text-output models without credentials', async () => {
  const client = {
    async send() {
      return {
        modelSummaries: [
          {
            modelId: 'amazon.nova-micro-v1:0',
            modelName: 'Nova Micro',
            providerName: 'Amazon',
            inputModalities: ['TEXT'],
            outputModalities: ['TEXT'],
            responseStreamingSupported: true,
            modelLifecycle: { status: 'ACTIVE' },
          },
          {
            modelId: 'amazon.titan-embed-text-v2:0',
            modelName: 'Titan Embed',
            providerName: 'Amazon',
            inputModalities: ['TEXT'],
            outputModalities: ['EMBEDDING'],
            responseStreamingSupported: false,
            inferenceTypesSupported: ['ON_DEMAND'],
            modelLifecycle: { status: 'ACTIVE' },
          },
          {
            modelId: 'legacy.model',
            modelName: 'Legacy',
            providerName: 'Fixture',
            inputModalities: ['TEXT'],
            outputModalities: ['TEXT'],
            responseStreamingSupported: false,
            modelLifecycle: { status: 'LEGACY' },
          },
        ],
      }
    },
  }

  assert.deepEqual(await discoverBedrockTextModels({
    client,
    commandFactory: async (input) => ({ input }),
  }), [{
    id: 'amazon.nova-micro-v1:0',
    name: 'Nova Micro',
    provider: 'Amazon',
    inputModalities: ['TEXT'],
    outputModalities: ['TEXT'],
    inferenceTypes: [],
    streaming: true,
  }])
})

test('Bedrock catalog discovery retains active image, video, and embedding models', async () => {
  const client = {
    async send() {
      return {
        modelSummaries: [
          {
            modelId: 'stability.image',
            modelName: 'Image Model',
            providerName: 'Stability AI',
            inputModalities: ['TEXT'],
            outputModalities: ['IMAGE'],
            inferenceTypesSupported: ['ON_DEMAND'],
            modelLifecycle: { status: 'ACTIVE' },
          },
          {
            modelId: 'luma.video',
            modelName: 'Video Model',
            providerName: 'Luma AI',
            inputModalities: ['TEXT'],
            outputModalities: ['VIDEO'],
            inferenceTypesSupported: ['ON_DEMAND'],
            modelLifecycle: { status: 'ACTIVE' },
          },
          {
            modelId: 'amazon.embed',
            modelName: 'Embedding Model',
            providerName: 'Amazon',
            inputModalities: ['TEXT'],
            outputModalities: ['EMBEDDING'],
            inferenceTypesSupported: ['ON_DEMAND'],
            modelLifecycle: { status: 'ACTIVE' },
          },
        ],
      }
    },
  }

  const models = await discoverBedrockModels({ client, commandFactory: async (input) => ({ input }) })
  assert.deepEqual(models.map((model) => model.outputModalities[0]), ['IMAGE', 'VIDEO', 'EMBEDDING'])
  assert.deepEqual(models[0].inferenceTypes, ['ON_DEMAND'])
})

test('Bedrock access checks require every control-plane gate and can prove Converse execution', async () => {
  const requests = []
  const client = {
    async send(command) {
      requests.push(structuredClone(command.input))
      if (command.input.messages) return { output: { message: { content: [{ text: 'OK.' }] } } }
      return {
        agreementAvailability: { status: 'AVAILABLE' },
        authorizationStatus: 'AUTHORIZED',
        entitlementAvailability: 'AVAILABLE',
        regionAvailability: 'AVAILABLE',
      }
    },
  }

  const availability = await checkBedrockModelAvailability({
    client,
    modelId: 'anthropic.claude-opus',
    commandFactory: async (input) => ({ input }),
  })
  assert.equal(availability.ready, true)
  assert.equal((await probeBedrockConverseAccess({
    client,
    modelId: 'us.anthropic.claude-opus',
    commandFactory: async (input) => ({ input }),
  })).ready, true)
  assert.equal(requests[1].inferenceConfig.maxTokens, 4)
})

test('Bedrock discovery returns active system inference profiles for routable model IDs', async () => {
  const client = {
    async send() {
      return {
        inferenceProfileSummaries: [
          {
            inferenceProfileId: 'us.amazon.nova-micro-v1:0',
            inferenceProfileName: 'US Nova Micro',
            type: 'SYSTEM_DEFINED',
            status: 'ACTIVE',
            models: [{ modelArn: 'arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-micro-v1:0' }],
          },
          {
            inferenceProfileId: 'application-profile',
            inferenceProfileName: 'Application profile',
            type: 'APPLICATION',
            status: 'ACTIVE',
            models: [],
          },
        ],
      }
    },
  }

  assert.deepEqual(await discoverBedrockInferenceProfiles({
    client,
    commandFactory: async (input) => ({ input }),
  }), [{
    id: 'us.amazon.nova-micro-v1:0',
    name: 'US Nova Micro',
    models: ['arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-micro-v1:0'],
  }])
})

test('Bedrock provider uses Converse and parses a structured model response', async () => {
  const requests = []
  const client = {
    async send(command) {
      requests.push(structuredClone(command.input))
      return {
        output: {
          message: {
            role: 'assistant',
            content: [{ text: '{"summary":"Bounded Bedrock finding."}' }],
          },
        },
        stopReason: 'end_turn',
        usage: { inputTokens: 21, outputTokens: 8, totalTokens: 29 },
      }
    },
  }
  const router = createBedrockModelRouter({
    client,
    commandFactory: async (input) => ({ input }),
    modelId: 'amazon.nova-micro-v1:0',
    region: 'us-west-2',
    maxTokens: 600,
  })

  assert.deepEqual(await router.route('Summarize this evidence.', {
    stage: 'specialist',
    taskId: 'task-bedrock-1',
  }), { summary: 'Bounded Bedrock finding.' })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].modelId, 'amazon.nova-micro-v1:0')
  assert.equal(requests[0].inferenceConfig.maxTokens, 600)
  assert.match(requests[0].messages[0].content[0].text, /task-bedrock-1/)
  assert.equal(JSON.stringify(router.descriptor).includes('credential'), false)
})

test('Bedrock specialist loop keeps the native object argument contract', async () => {
  const requests = []
  const client = {
    async send(command) {
      requests.push(structuredClone(command.input))
      return {
        output: {
          message: {
            role: 'assistant',
            content: [{
              text: JSON.stringify({
                status: 'tool_request',
                summary: 'Read the bounded file.',
                toolCall: { name: 'read', arguments: { path: 'mounts/memory/MEMORY.md' } },
              }),
            }],
          },
        },
      }
    },
  }
  const router = createBedrockModelRouter({
    client,
    commandFactory: async (input) => ({ input }),
    modelId: 'amazon.nova-micro-v1:0',
  })

  const result = await router.route('Read the file.', { stage: 'specialist-loop' })

  assert.deepEqual(result.toolCall.arguments, { path: 'mounts/memory/MEMORY.md' })
  assert.doesNotMatch(requests[0].system[0].text, /JSON-encoded string/)
  assert.doesNotMatch(requests[0].messages[0].content[0].text, /JSON-encoded string/)
})
