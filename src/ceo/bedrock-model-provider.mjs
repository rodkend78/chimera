import { validateModelRouter } from './model-router.mjs'
import {
  composeStructuredModelPrompt,
  modelResponseInstruction,
  parseStructuredModelResponse,
} from './structured-model-output.mjs'

function boundedString(value, maximum = 2048) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

async function foundationModelsCommand(input) {
  const { ListFoundationModelsCommand } = await import('@aws-sdk/client-bedrock')
  return new ListFoundationModelsCommand(input)
}

async function inferenceProfilesCommand(input) {
  const { ListInferenceProfilesCommand } = await import('@aws-sdk/client-bedrock')
  return new ListInferenceProfilesCommand(input)
}

async function modelAvailabilityCommand(input) {
  const { GetFoundationModelAvailabilityCommand } = await import('@aws-sdk/client-bedrock')
  return new GetFoundationModelAvailabilityCommand(input)
}

async function converseCommand(input) {
  const { ConverseCommand } = await import('@aws-sdk/client-bedrock-runtime')
  return new ConverseCommand(input)
}

export async function discoverBedrockModels({ client, commandFactory = foundationModelsCommand }) {
  if (!client || typeof client.send !== 'function') throw new TypeError('Bedrock discovery client is required')
  if (typeof commandFactory !== 'function') throw new TypeError('Bedrock discovery command factory is required')
  const result = await client.send(await commandFactory({}))
  return (result?.modelSummaries ?? [])
    .filter((model) => model?.modelLifecycle?.status === 'ACTIVE'
      && boundedString(model.modelId, 512)
      && boundedString(model.modelName, 512)
      && boundedString(model.providerName, 256)
      && Array.isArray(model.outputModalities)
      && model.outputModalities.length > 0)
    .map((model) => ({
      id: model.modelId,
      name: model.modelName,
      provider: model.providerName,
      inputModalities: [...(model.inputModalities ?? [])],
      outputModalities: [...model.outputModalities],
      inferenceTypes: [...(model.inferenceTypesSupported ?? [])],
      streaming: model.responseStreamingSupported === true,
    }))
}

export async function discoverBedrockTextModels(options) {
  return (await discoverBedrockModels(options))
    .filter((model) => model.outputModalities.includes('TEXT'))
}

export async function discoverBedrockInferenceProfiles({ client, commandFactory = inferenceProfilesCommand }) {
  if (!client || typeof client.send !== 'function') throw new TypeError('Bedrock discovery client is required')
  if (typeof commandFactory !== 'function') throw new TypeError('Bedrock discovery command factory is required')
  const result = await client.send(await commandFactory({ typeEquals: 'SYSTEM_DEFINED' }))
  return (result?.inferenceProfileSummaries ?? [])
    .filter((profile) => profile?.status === 'ACTIVE'
      && profile.type === 'SYSTEM_DEFINED'
      && boundedString(profile.inferenceProfileId, 1024)
      && boundedString(profile.inferenceProfileName, 1024))
    .map((profile) => ({
      id: profile.inferenceProfileId,
      name: profile.inferenceProfileName,
      models: (profile.models ?? [])
        .map((model) => model?.modelArn)
        .filter((arn) => boundedString(arn, 2048)),
    }))
}

export async function checkBedrockModelAvailability({
  client,
  modelId,
  commandFactory = modelAvailabilityCommand,
} = {}) {
  if (!client || typeof client.send !== 'function'
    || !boundedString(modelId, 512)
    || typeof commandFactory !== 'function') {
    throw new TypeError('Bedrock availability check requires a client and model id')
  }
  const result = await client.send(await commandFactory({ modelId }))
  const agreement = result?.agreementAvailability?.status ?? 'UNKNOWN'
  const authorization = result?.authorizationStatus ?? 'UNKNOWN'
  const entitlement = result?.entitlementAvailability ?? 'UNKNOWN'
  const region = result?.regionAvailability ?? 'UNKNOWN'
  return Object.freeze({
    modelId,
    agreement,
    authorization,
    entitlement,
    region,
    ready: agreement === 'AVAILABLE'
      && authorization === 'AUTHORIZED'
      && entitlement === 'AVAILABLE'
      && region === 'AVAILABLE',
  })
}

export async function probeBedrockConverseAccess({
  client,
  modelId,
  commandFactory = converseCommand,
} = {}) {
  if (!client || typeof client.send !== 'function'
    || !boundedString(modelId, 512)
    || typeof commandFactory !== 'function') {
    throw new TypeError('Bedrock access probe requires a client and model id')
  }
  await client.send(await commandFactory({
    modelId,
    messages: [{ role: 'user', content: [{ text: 'Reply with OK.' }] }],
    inferenceConfig: { maxTokens: 4, temperature: 0 },
  }))
  return Object.freeze({ modelId, ready: true, protocol: 'bedrock-converse' })
}

export function createBedrockModelRouter({
  client,
  modelId,
  region = 'us-west-2',
  maxTokens = 2_000,
  temperature = 0.1,
  commandFactory = converseCommand,
} = {}) {
  if (!client || typeof client.send !== 'function'
    || !boundedString(modelId, 512)
    || !boundedString(region, 64)
    || !Number.isSafeInteger(maxTokens)
    || maxTokens < 1
    || maxTokens > 100_000
    || !Number.isFinite(temperature)
    || temperature < 0
    || temperature > 1
    || typeof commandFactory !== 'function') {
    throw new TypeError('invalid Bedrock model provider')
  }
  const descriptor = Object.freeze({
    providerId: 'aws-bedrock',
    model: modelId,
    protocol: 'bedrock-converse',
    region,
  })
  return validateModelRouter(Object.freeze({
    routerId: `bedrock:${modelId}`,
    descriptor,
    async route(prompt, context = {}) {
      const result = await client.send(await commandFactory({
        modelId,
        system: [{ text: modelResponseInstruction(context?.stage) }],
        messages: [{
          role: 'user',
          content: [{ text: composeStructuredModelPrompt(prompt, context) }],
        }],
        inferenceConfig: { maxTokens, temperature },
      }))
      const text = result?.output?.message?.content
        ?.map((item) => item?.text)
        .filter((item) => typeof item === 'string')
        .join('')
      return parseStructuredModelResponse(text)
    },
  }))
}
