import { createHash, createHmac } from 'node:crypto'
import { validateModelRouter } from './model-router.mjs'
import {
  composeStructuredModelPrompt,
  modelResponseInstruction,
  parseStructuredModelResponse,
} from './structured-model-output.mjs'

function boundedString(value, maximum = 2048) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function normalizeBaseUrl(baseUrl, region) {
  if (!boundedString(baseUrl, 2048) || !boundedString(region, 64)) {
    throw new TypeError('Mantle base URL and region are required')
  }
  const url = new URL(baseUrl)
  const expectedHost = `bedrock-mantle.${region}.api.aws`
  if (url.protocol !== 'https:' || url.hostname !== expectedHost
    || !['/v1', '/openai/v1'].includes(url.pathname.replace(/\/$/, ''))
    || url.username || url.password || url.search || url.hash) {
    throw new TypeError('invalid Bedrock Mantle base URL')
  }
  return url.toString().replace(/\/$/, '')
}

class NodeSha256 {
  constructor(secret) {
    this.hash = secret ? createHmac('sha256', secret) : createHash('sha256')
  }

  update(data) {
    this.hash.update(data)
  }

  async digest() {
    return this.hash.digest()
  }
}

export async function createDefaultMantleSigner({ region = 'us-west-2' } = {}) {
  if (!boundedString(region, 64)) throw new TypeError('Mantle signer region is required')
  const [{ SignatureV4 }, { defaultProvider }] = await Promise.all([
    import('@smithy/signature-v4'),
    import('@aws-sdk/credential-provider-node'),
  ])
  return new SignatureV4({
    credentials: defaultProvider(),
    region,
    service: 'bedrock-mantle',
    sha256: NodeSha256,
  })
}

function requestError(status) {
  const code = status === 401
    ? 'MANTLE_AUTH_REQUIRED'
    : status === 403 || status === 404
      ? 'MANTLE_MODEL_NOT_AVAILABLE'
      : status === 429
        ? 'MANTLE_RATE_LIMITED'
        : 'MANTLE_REQUEST_FAILED'
  const error = new Error(code)
  error.code = code
  error.status = status
  return error
}

async function authorizedHeaders({ apiKey, signer, url, method, project, body, json = false }) {
  if ((!boundedString(apiKey, 4096) && typeof signer?.sign !== 'function')
    || !boundedString(project, 256)) {
    throw new TypeError('Mantle authentication and project are required')
  }
  const base = {
    'OpenAI-Project': project,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  }
  if (boundedString(apiKey, 4096)) return { Authorization: `Bearer ${apiKey}`, ...base }
  const endpoint = new URL(url)
  const signed = await signer.sign({
    protocol: endpoint.protocol,
    hostname: endpoint.hostname,
    method,
    path: `${endpoint.pathname}${endpoint.search}`,
    headers: { host: endpoint.hostname, ...base },
    ...(body ? { body } : {}),
  })
  return signed.headers
}

export async function discoverMantleModels({
  fetchImpl = globalThis.fetch,
  baseUrl,
  region = 'us-west-2',
  apiKey,
  signer,
  project = 'default',
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('Mantle fetch implementation is required')
  const endpoint = normalizeBaseUrl(baseUrl, region)
  const url = `${endpoint}/models`
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: await authorizedHeaders({ apiKey, signer, url, method: 'GET', project }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response?.ok) throw requestError(response?.status)
  const payload = await response.json()
  if (!Array.isArray(payload?.data)) throw requestError(502)
  return payload.data
    .filter((model) => boundedString(model?.id, 512))
    .map((model) => ({ id: model.id }))
}

async function chatCompletion({
  fetchImpl,
  baseUrl,
  region,
  apiKey,
  signer,
  project,
  modelId,
  messages,
  maxTokens,
  temperature,
  requireContent = true,
}) {
  const endpoint = normalizeBaseUrl(baseUrl, region)
  const url = new URL('/openai/v1/chat/completions', endpoint).toString()
  const body = JSON.stringify({
    model: modelId,
    messages,
    max_tokens: maxTokens,
    temperature,
    ...(modelId.startsWith('xai.grok-') ? { reasoning_effort: 'low' } : {}),
  })
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: await authorizedHeaders({ apiKey, signer, url, method: 'POST', project, body, json: true }),
    body,
    signal: AbortSignal.timeout(60_000),
  })
  if (!response?.ok) throw requestError(response?.status)
  const payload = await response.json()
  const content = payload?.choices?.[0]?.message?.content
  if (requireContent && !boundedString(content, 10_000_000)) throw requestError(502)
  return boundedString(content, 10_000_000) ? content : null
}

export async function probeMantleModelAccess({
  fetchImpl = globalThis.fetch,
  baseUrl,
  region = 'us-west-2',
  apiKey,
  signer,
  project = 'default',
  modelId,
} = {}) {
  if (!boundedString(modelId, 512)) throw new TypeError('Mantle model id is required')
  await chatCompletion({
    fetchImpl,
    baseUrl,
    region,
    apiKey,
    signer,
    project,
    modelId,
    messages: [{ role: 'user', content: 'Reply with OK.' }],
    maxTokens: 4,
    temperature: 0,
    requireContent: false,
  })
  return Object.freeze({ modelId, ready: true, protocol: 'openai-chat-completions' })
}

export function createMantleModelRouter({
  fetchImpl = globalThis.fetch,
  baseUrl,
  region = 'us-west-2',
  apiKey,
  signer,
  project = 'default',
  modelId,
  maxTokens = 2_000,
  temperature = 0.1,
} = {}) {
  if (typeof fetchImpl !== 'function'
    || (!boundedString(apiKey, 4096) && typeof signer?.sign !== 'function')
    || !boundedString(project, 256)
    || !boundedString(modelId, 512)
    || !Number.isSafeInteger(maxTokens)
    || maxTokens < 1
    || maxTokens > 100_000
    || !Number.isFinite(temperature)
    || temperature < 0
    || temperature > 1) {
    throw new TypeError('invalid Bedrock Mantle model provider')
  }
  const endpoint = normalizeBaseUrl(baseUrl, region)
  return validateModelRouter(Object.freeze({
    routerId: `bedrock-mantle:${modelId}`,
    descriptor: Object.freeze({
      providerId: 'aws-bedrock-mantle',
      model: modelId,
      protocol: 'openai-chat-completions',
      execution: 'inference-only',
      region,
      project,
    }),
    async route(prompt, context = {}) {
      const content = await chatCompletion({
        fetchImpl,
        baseUrl: endpoint,
        region,
        apiKey,
        signer,
        project,
        modelId,
        messages: [
          { role: 'system', content: modelResponseInstruction(context?.stage) },
          { role: 'user', content: composeStructuredModelPrompt(prompt, context) },
        ],
        maxTokens,
        temperature,
      })
      return parseStructuredModelResponse(content)
    },
  }))
}
