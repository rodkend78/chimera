import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import {
  checkBedrockModelAvailability,
  createBedrockModelRouter,
  discoverBedrockModels,
  discoverBedrockInferenceProfiles,
  probeBedrockConverseAccess,
} from './bedrock-model-provider.mjs'
import {
  createDefaultMantleSigner,
  createMantleModelRouter,
  discoverMantleModels,
  probeMantleModelAccess,
} from './bedrock-mantle-provider.mjs'
import { createCodexSubscriptionModelRouter } from './codex-subscription-provider.mjs'
import { createOpenAiCompatibleModelRouter } from './live-model-provider.mjs'
import {
  createLumaVideoGenerator,
  createStabilityImageGenerator,
} from './bedrock-media-provider.mjs'
import { createTaskAwareModelRouter } from './task-aware-model-router.mjs'
import { createS3MediaArtifactResolver } from './s3-media-artifact.mjs'

const execFile = promisify(execFileCallback)

const DEFAULT_MANTLE_MODELS = Object.freeze([
  Object.freeze({
    id: 'xai.grok-4.6',
    name: 'Grok 4.6',
    provider: 'xAI',
    inputModalities: Object.freeze(['TEXT', 'IMAGE']),
    outputModalities: Object.freeze(['TEXT']),
    capabilities: Object.freeze(['conversation', 'coding', 'reasoning', 'research']),
    strengths: Object.freeze(['research', 'reasoning', 'coding']),
  }),
  Object.freeze({
    id: 'google.gemma-4-31b',
    name: 'Gemma 4 31B',
    provider: 'Google',
    inputModalities: Object.freeze(['TEXT', 'IMAGE', 'VIDEO']),
    outputModalities: Object.freeze(['TEXT']),
    capabilities: Object.freeze(['conversation', 'bulk', 'reasoning', 'research', 'multimodal-understanding']),
  }),
])

function boundedString(value, maximum = 2048) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function safeErrorCode(error) {
  if (['AccessDeniedException', 'AccessDenied'].includes(error?.name)
    || ['AccessDeniedException', 'AccessDenied'].includes(error?.code)) {
    return 'BEDROCK_MODEL_NOT_AVAILABLE'
  }
  return boundedString(error?.code, 128)
    ? error.code
    : boundedString(error?.name, 128)
      ? error.name
      : 'PROVIDER_DISCOVERY_FAILED'
}

function safeMantleErrorCode(error) {
  return boundedString(error?.code, 128) && error.code.startsWith('MANTLE_')
    ? error.code
    : 'MANTLE_DISCOVERY_FAILED'
}

function safeCompatibleErrorCode(error) {
  return boundedString(error?.code, 128) && error.code.startsWith('MODEL_')
    ? error.code
    : 'MODEL_PROVIDER_FAILURE'
}

function openAiCompatibleSettings(config, env) {
  const providers = config.openAiCompatibleProviders ?? []
  if (!Array.isArray(providers)) throw new TypeError('invalid local model fabric configuration')
  const normalized = providers.map((provider) => {
    if (!provider || !boundedString(provider.id, 64)
      || !/^[a-z0-9][a-z0-9_-]*$/.test(provider.id)
      || !boundedString(provider.name, 128)
      || !boundedString(provider.baseUrl, 2048)
      || !boundedString(provider.apiKeyEnv, 128)
      || !/^[A-Z][A-Z0-9_]*$/.test(provider.apiKeyEnv)
      || !Array.isArray(provider.models) || provider.models.length === 0) {
      throw new TypeError('invalid local model fabric configuration')
    }
    const models = provider.models.map((model) => {
      if (!model || !boundedString(model.id, 256) || !boundedString(model.name, 256)
        || !Array.isArray(model.capabilities) || !model.capabilities.includes('conversation')
        || model.capabilities.some((capability) => !boundedString(capability, 64))) {
        throw new TypeError('invalid local model fabric configuration')
      }
      return {
        id: model.id,
        name: model.name,
        capabilities: [...new Set(model.capabilities)],
      }
    })
    if (new Set(models.map((model) => model.id)).size !== models.length) {
      throw new TypeError('invalid local model fabric configuration')
    }
    return {
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiKey: boundedString(env?.[provider.apiKeyEnv], 16_384) ? env[provider.apiKeyEnv] : null,
      models,
    }
  })
  if (new Set(normalized.map((provider) => provider.id)).size !== normalized.length) {
    throw new TypeError('invalid local model fabric configuration')
  }
  return normalized
}

function hasMantleAuthentication(apiKey, signer) {
  return boundedString(apiKey, 4096) || typeof signer?.sign === 'function'
}

function mantleSettings(config) {
  const region = config.region
  const value = config.mantle ?? {}
  return {
    project: boundedString(value.project, 256) ? value.project : 'default',
    baseUrl: boundedString(value.baseUrl, 2048)
      ? value.baseUrl
      : `https://bedrock-mantle.${region}.api.aws/v1`,
    priorityModels: Array.isArray(value.priorityModels) && value.priorityModels.length > 0
      ? value.priorityModels
      : DEFAULT_MANTLE_MODELS,
    routes: Array.isArray(value.routes) ? value.routes : [],
  }
}

function displayNameForMantleId(id) {
  return id.split('.').slice(1).join(' ')
    .split('-')
    .map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : part)
    .join(' ')
}

function buildMantleCatalog({ models, settings, configured, accessState }) {
  const known = new Map(settings.priorityModels.map((model) => [model.id, model]))
  const ids = new Set([...settings.priorityModels.map((model) => model.id), ...models.map((model) => model.id)])
  return [...ids].map((id) => {
    const metadata = known.get(id)
    const providerId = id.split('.')[0]
    return {
      id,
      name: metadata?.name ?? displayNameForMantleId(id),
      provider: metadata?.provider ?? providerId.toUpperCase(),
      inputModalities: [...(metadata?.inputModalities ?? ['TEXT'])],
      outputModalities: [...(metadata?.outputModalities ?? ['TEXT'])],
      capabilities: [...(metadata?.capabilities ?? ['conversation'])],
      ...(Array.isArray(metadata?.strengths) ? { strengths: [...metadata.strengths] } : {}),
      inferenceType: 'MANTLE_PROJECT',
      endpoint: 'bedrock-mantle',
      availability: accessState.get(id)?.availability ?? (configured ? 'catalog-only' : 'access-required'),
      ...(accessState.has(id) ? accessState.get(id) : {}),
    }
  }).toSorted((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
}

function foundationModelId(modelArn) {
  if (!boundedString(modelArn, 2048)) return null
  const marker = 'foundation-model/'
  const index = modelArn.indexOf(marker)
  return index >= 0 ? modelArn.slice(index + marker.length) : null
}

function modelCapabilities(model) {
  const inputs = new Set(model?.inputModalities ?? [])
  const outputs = new Set(model?.outputModalities ?? [])
  const capabilities = []
  if (outputs.has('TEXT')) capabilities.push('conversation')
  if (outputs.has('IMAGE')) {
    if (inputs.has('TEXT')) capabilities.push('image-generation')
    if (inputs.has('IMAGE')) capabilities.push('image-editing')
  }
  if (outputs.has('VIDEO')) capabilities.push('video-generation')
  if (outputs.has('EMBEDDING')) capabilities.push('embedding')
  if (outputs.has('SPEECH')) capabilities.push('speech')
  return capabilities.length > 0 ? capabilities : ['unknown']
}

function buildBedrockCatalog({ models, profiles, configuredRoutes, mediaAdapters = new Set() }) {
  const byFoundationId = new Map(models.map((model) => [model.id, model]))
  const routed = new Map(configuredRoutes.map((route) => [route.model, route]))
  const entries = []
  for (const profile of profiles) {
    const foundationId = profile.models.map(foundationModelId).find((id) => byFoundationId.has(id))
      ?? profile.models.map(foundationModelId).find(Boolean)
      ?? null
    const foundation = foundationId ? byFoundationId.get(foundationId) : null
    entries.push({
      id: profile.id,
      name: profile.name,
      provider: foundation?.provider ?? 'AWS Bedrock',
      foundationModelId: foundationId,
      inputModalities: [...(foundation?.inputModalities ?? [])],
      outputModalities: [...(foundation?.outputModalities ?? [])],
      capabilities: modelCapabilities(foundation),
      inferenceType: 'INFERENCE_PROFILE',
      streaming: foundation?.streaming === true,
      availability: routed.has(profile.id) ? 'verified-route' : 'catalog-only',
      ...(mediaAdapters.has(profile.id) ? { adapter: 'ready' } : {}),
      ...(routed.has(profile.id) ? { routeId: routed.get(profile.id).id } : {}),
    })
  }
  for (const model of models) {
    if (!model.inferenceTypes?.includes('ON_DEMAND')) continue
    entries.push({
      id: model.id,
      name: model.name,
      provider: model.provider,
      foundationModelId: model.id,
      inputModalities: [...model.inputModalities],
      outputModalities: [...model.outputModalities],
      capabilities: modelCapabilities(model),
      inferenceType: 'ON_DEMAND',
      streaming: model.streaming === true,
      availability: routed.has(model.id) ? 'verified-route' : 'catalog-only',
      ...(mediaAdapters.has(model.id) ? { adapter: 'ready' } : {}),
      ...(routed.has(model.id) ? { routeId: routed.get(model.id).id } : {}),
    })
  }
  return entries.toSorted((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
}

function availabilityFailure(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function publicMediaArtifact(artifact, { includeArtifactUrl = true } = {}) {
  return {
    kind: artifact.kind,
    status: artifact.status,
    modelId: artifact.modelId,
    ...(artifact.jobId ? { jobId: artifact.jobId } : {}),
    ...(artifact.mimeType ? { mimeType: artifact.mimeType } : {}),
    ...(artifact.base64 ? { base64: artifact.base64 } : {}),
    ...(Number.isSafeInteger(artifact.seed) ? { seed: artifact.seed } : {}),
    ...(artifact.submittedAt ? { submittedAt: artifact.submittedAt } : {}),
    ...(artifact.completedAt ? { completedAt: artifact.completedAt } : {}),
    ...(artifact.error ? { error: artifact.error } : {}),
    ...(includeArtifactUrl && artifact.artifactUrl ? { artifactUrl: artifact.artifactUrl } : {}),
  }
}

function validateConfig(config) {
  if (!config || config.schema !== 'chimera.model-routing.v1'
    || !boundedString(config.region, 64)
    || !boundedString(config.codex?.model, 256)
    || !boundedString(config.codex?.reasoningEffort, 32)
    || !Array.isArray(config.bedrockRoutes)) {
    throw new TypeError('invalid local model fabric configuration')
  }
  return config
}

export async function detectCodexSubscription({ execFileImpl = execFile } = {}) {
  if (typeof execFileImpl !== 'function') throw new TypeError('Codex status executor is required')
  try {
    const result = await execFileImpl('codex', ['login', 'status'], {
      timeout: 10_000,
      maxBuffer: 16_384,
      encoding: 'utf8',
    })
    const statusText = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`
    const configured = /logged in using chatgpt/i.test(statusText)
    return {
      available: true,
      configured,
      authentication: configured ? 'chatgpt-subscription' : null,
    }
  } catch (error) {
    return {
      available: Number.isInteger(error?.code),
      configured: false,
      authentication: null,
    }
  }
}

export class LocalModelFabricRegistry {
  static async open({
    config,
    audit,
    workingDirectory = process.cwd(),
    codexStatus,
    codexClient = null,
    antigravity = null,
    bedrockControlClient,
    bedrockRuntimeClient,
    bedrockModels,
    bedrockProfiles,
    bedrockCommandFactory,
    bedrockAvailabilityCommandFactory,
    bedrockImageCommandFactory,
    bedrockVideoStartCommandFactory,
    bedrockVideoGetCommandFactory,
    mediaIdFactory,
    mediaArtifactResolver,
    mantleApiKey,
    mantleSigner,
    mantleFetch = globalThis.fetch,
    openAiCompatibleFetch = globalThis.fetch,
    env = process.env,
    now = () => Date.now(),
  } = {}) {
    const normalizedConfig = validateConfig(config)
    if (!audit || typeof audit.append !== 'function' || !boundedString(workingDirectory, 4096)) {
      throw new TypeError('local model fabric requires audit and working directory')
    }
    const resolvedCodexStatus = codexStatus ?? await detectCodexSubscription()
    let resolvedControl = bedrockControlClient
    let resolvedRuntime = bedrockRuntimeClient
    let resolvedModels = bedrockModels
    let resolvedProfiles = bedrockProfiles
    let bedrockError = null
    const resolvedMantleSettings = mantleSettings(normalizedConfig)
    const resolvedOpenAiCompatibleProviders = openAiCompatibleSettings(normalizedConfig, env)
    const resolvedMantleApiKey = mantleApiKey
      ?? env?.CHIMERA_BEDROCK_MANTLE_API_KEY
      ?? env?.BEDROCK_API_KEY
      ?? env?.AWS_BEARER_TOKEN_BEDROCK
      ?? null
    let resolvedMantleSigner = mantleSigner ?? null
    const useDefaultMantleSigner = mantleSigner === undefined
      && bedrockModels === undefined
      && bedrockProfiles === undefined
    let mantleModels = []
    let mantleError = null
    const mantleAccessState = new Map()
    let resolvedMediaArtifactResolver = mediaArtifactResolver ?? null
    if (!resolvedModels || !resolvedProfiles) {
      try {
        if (!resolvedControl) {
          const { BedrockClient } = await import('@aws-sdk/client-bedrock')
          resolvedControl = new BedrockClient({ region: normalizedConfig.region })
        }
        const discovered = await Promise.all([
          resolvedModels ?? discoverBedrockModels({ client: resolvedControl }),
          resolvedProfiles ?? discoverBedrockInferenceProfiles({ client: resolvedControl }),
        ])
        resolvedModels = discovered[0]
        resolvedProfiles = discovered[1]
      } catch (error) {
        resolvedModels = []
        resolvedProfiles = []
        bedrockError = safeErrorCode(error)
      }
    }
    if (!resolvedRuntime && (resolvedProfiles.length > 0 || resolvedModels.length > 0)) {
      const { BedrockRuntimeClient } = await import('@aws-sdk/client-bedrock-runtime')
      resolvedRuntime = new BedrockRuntimeClient({ region: normalizedConfig.region })
    }
    const videoOutputS3Uri = env?.CHIMERA_MEDIA_S3_URI ?? normalizedConfig.media?.videoOutputS3Uri
    if (!resolvedMediaArtifactResolver && boundedString(videoOutputS3Uri, 2048)) {
      const { S3Client } = await import('@aws-sdk/client-s3')
      resolvedMediaArtifactResolver = createS3MediaArtifactResolver({
        client: new S3Client({ region: normalizedConfig.region }),
      })
    }
    if (!boundedString(resolvedMantleApiKey, 4096) && useDefaultMantleSigner) {
      try {
        resolvedMantleSigner = await createDefaultMantleSigner({ region: normalizedConfig.region })
      } catch (error) {
        mantleError = safeMantleErrorCode(error)
      }
    }
    if (boundedString(resolvedMantleApiKey, 4096) || typeof resolvedMantleSigner?.sign === 'function') {
      try {
        mantleModels = await discoverMantleModels({
          fetchImpl: mantleFetch,
          baseUrl: resolvedMantleSettings.baseUrl,
          region: normalizedConfig.region,
          apiKey: resolvedMantleApiKey,
          signer: resolvedMantleSigner,
          project: resolvedMantleSettings.project,
        })
        // Discovery must not generate billable completions. Catalog presence
        // permits configured routing, but does not prove inference access.
      } catch (error) {
        mantleError = safeMantleErrorCode(error)
      }
    }
    return new LocalModelFabricRegistry({
      config: normalizedConfig,
      audit,
      workingDirectory,
      codexStatus: resolvedCodexStatus,
      codexClient,
      antigravity,
      bedrockControlClient: resolvedControl,
      bedrockRuntimeClient: resolvedRuntime,
      bedrockModels: resolvedModels,
      bedrockProfiles: resolvedProfiles,
      bedrockCommandFactory,
      bedrockAvailabilityCommandFactory,
      bedrockImageCommandFactory,
      bedrockVideoStartCommandFactory,
      bedrockVideoGetCommandFactory,
      mediaIdFactory,
      mediaArtifactResolver: resolvedMediaArtifactResolver,
      bedrockError,
      mantleApiKey: resolvedMantleApiKey,
      mantleSigner: resolvedMantleSigner,
      mantleFetch,
      mantleSettings: resolvedMantleSettings,
      mantleModels,
      mantleError,
      mantleAccessState,
      openAiCompatibleProviders: resolvedOpenAiCompatibleProviders,
      openAiCompatibleFetch,
      env,
      now,
    })
  }

  constructor({
    config,
    audit,
    workingDirectory,
    codexStatus,
    codexClient,
    antigravity,
    bedrockControlClient,
    bedrockRuntimeClient,
    bedrockModels,
    bedrockProfiles,
    bedrockCommandFactory,
    bedrockAvailabilityCommandFactory,
    bedrockImageCommandFactory,
    bedrockVideoStartCommandFactory,
    bedrockVideoGetCommandFactory,
    mediaIdFactory,
    mediaArtifactResolver,
    bedrockError,
    mantleApiKey,
    mantleSigner,
    mantleFetch,
    mantleSettings,
    mantleModels,
    mantleError,
    mantleAccessState,
    openAiCompatibleProviders,
    openAiCompatibleFetch,
    env,
    now,
  }) {
    this.config = config
    this.audit = audit
    this.codexStatus = codexStatus
    this.antigravity = antigravity
    this.bedrockModels = bedrockModels
    this.bedrockProfiles = bedrockProfiles
    this.bedrockError = bedrockError
    this.bedrockControlClient = bedrockControlClient
    this.bedrockRuntimeClient = bedrockRuntimeClient
    this.bedrockCommandFactory = bedrockCommandFactory
    this.bedrockAvailabilityCommandFactory = bedrockAvailabilityCommandFactory
    this.mantleApiKey = mantleApiKey
    this.mantleSigner = mantleSigner
    this.mantleFetch = mantleFetch
    this.mantleSettings = mantleSettings
    this.mantleModels = mantleModels
    this.mantleError = mantleError
    this.mantleAccessState = mantleAccessState
    this.openAiCompatibleProviders = new Map(openAiCompatibleProviders.map((provider) => [provider.id, provider]))
    this.openAiCompatibleFetch = openAiCompatibleFetch
    this.openAiCompatibleAccessState = new Map()
    this.now = now
    this.accessState = new Map()
    this.mediaJobs = new Map()
    this.mediaArtifactResolver = mediaArtifactResolver
    this.mediaGenerators = new Map()
    const media = config.media ?? {}
    const videoOutputS3Uri = env?.CHIMERA_MEDIA_S3_URI ?? media.videoOutputS3Uri
    if (bedrockRuntimeClient && boundedString(media.imageModel, 512)
      && bedrockModels.some((model) => model.id === media.imageModel && model.outputModalities?.includes('IMAGE'))) {
      this.mediaGenerators.set(media.imageModel, createStabilityImageGenerator({
        client: bedrockRuntimeClient,
        modelId: media.imageModel,
        ...(bedrockImageCommandFactory ? { commandFactory: bedrockImageCommandFactory } : {}),
      }))
    }
    if (bedrockRuntimeClient && boundedString(media.videoModel, 512)
      && boundedString(videoOutputS3Uri, 2048)
      && bedrockModels.some((model) => model.id === media.videoModel && model.outputModalities?.includes('VIDEO'))) {
      this.mediaGenerators.set(media.videoModel, createLumaVideoGenerator({
        client: bedrockRuntimeClient,
        modelId: media.videoModel,
        outputS3Uri: videoOutputS3Uri,
        ...(mediaIdFactory ? { idFactory: mediaIdFactory } : {}),
        ...(bedrockVideoStartCommandFactory ? { startCommandFactory: bedrockVideoStartCommandFactory } : {}),
        ...(bedrockVideoGetCommandFactory ? { getCommandFactory: bedrockVideoGetCommandFactory } : {}),
      }))
    }
    const routes = []
    let codexRouter = null
    if (codexStatus?.configured === true) {
      codexRouter = createCodexSubscriptionModelRouter({
        codex: codexClient,
        model: config.codex.model,
        workingDirectory,
        reasoningEffort: config.codex.reasoningEffort,
      })
      routes.push({
        id: 'codex-primary',
        router: codexRouter,
        capabilities: ['orchestration', 'coding', 'reasoning'],
        costClass: 'subscription',
      })
    }
    if (hasMantleAuthentication(mantleApiKey, mantleSigner) && !mantleError) {
      const catalogIds = new Set(mantleModels.map(model => model.id))
      for (const route of mantleSettings.routes) {
        if (!catalogIds.has(route.model)) continue
        routes.push({
          id: route.id,
          router: createMantleModelRouter({
            fetchImpl: mantleFetch,
            baseUrl: mantleSettings.baseUrl,
            region: config.region,
            apiKey: mantleApiKey,
            signer: mantleSigner,
            project: mantleSettings.project,
            modelId: route.model,
          }),
          capabilities: route.capabilities,
          costClass: route.costClass,
        })
      }
    }
    const profileIds = new Set(bedrockProfiles.map((profile) => profile.id))
    if (bedrockRuntimeClient) {
      for (const route of config.bedrockRoutes) {
        if (!profileIds.has(route.model)) continue
        routes.push({
          id: route.id,
          router: createBedrockModelRouter({
            client: bedrockRuntimeClient,
            modelId: route.model,
            region: config.region,
            ...(bedrockCommandFactory ? { commandFactory: bedrockCommandFactory } : {}),
          }),
          capabilities: route.capabilities,
          costClass: route.costClass,
        })
      }
    }
    if (codexRouter) {
      routes.push({ id: 'codex-bulk-fallback', router: codexRouter, capabilities: ['bulk'], costClass: 'subscription' })
      routes.push({ id: 'codex-research-fallback', router: codexRouter, capabilities: ['research'], costClass: 'subscription' })
    }
    this.fabric = routes.length > 0 ? createTaskAwareModelRouter({ routes, audit, now }) : null
    this.activeRouter = this.fabric
    this.selection = this.fabric ? {
      providerId: 'chimera-auto',
      providerName: 'Chimera Auto',
      model: 'auto',
      modelName: 'Best model for task',
    } : null
    this.codexRouter = codexRouter
    this.bedrockCatalog = buildBedrockCatalog({
      models: bedrockModels,
      profiles: bedrockProfiles,
      configuredRoutes: config.bedrockRoutes,
      mediaAdapters: new Set(this.mediaGenerators.keys()),
    })
    this.mantleCatalog = buildMantleCatalog({
      models: mantleModels,
      settings: mantleSettings,
      configured: hasMantleAuthentication(mantleApiKey, mantleSigner) && !mantleError,
      accessState: mantleAccessState,
    })
    this.routeState = routes.map((route) => ({
      id: route.id,
      providerRouterId: route.router.routerId,
      capabilities: [...route.capabilities],
      costClass: route.costClass,
    }))
  }

  state() {
    const antigravity = this.antigravity?.state()
    const bedrockModels = this.bedrockCatalog.map((model) => ({
      ...model,
      ...(this.accessState.has(model.id) ? this.accessState.get(model.id) : {}),
    }))
    const mantleModels = this.mantleCatalog.map((model) => ({
      ...model,
      ...(this.mantleAccessState.has(model.id) ? this.mantleAccessState.get(model.id) : {}),
    }))
    const compatibleProviders = [...this.openAiCompatibleProviders.values()].map((provider) => ({
      id: provider.id,
      name: provider.name,
      configured: boundedString(provider.apiKey, 16_384),
      authentication: boundedString(provider.apiKey, 16_384) ? 'API key' : null,
      connectionStatus: boundedString(provider.apiKey, 16_384) ? 'connected' : 'authentication-required',
      models: provider.models.map((model) => ({
        ...model,
        provider: provider.name,
        inputModalities: ['TEXT'],
        outputModalities: ['TEXT'],
        availability: boundedString(provider.apiKey, 16_384) ? 'authenticated' : 'access-required',
        ...(this.openAiCompatibleAccessState.has(`${provider.id}:${model.id}`)
          ? this.openAiCompatibleAccessState.get(`${provider.id}:${model.id}`)
          : {}),
      })),
    }))
    const capabilityCounts = {}
    for (const model of [...bedrockModels, ...mantleModels, ...compatibleProviders.flatMap((provider) => provider.models)]) {
      for (const capability of model.capabilities) {
        capabilityCounts[capability] = (capabilityCounts[capability] ?? 0) + 1
      }
    }
    return {
      schema: 'chimera.model-provider-registry.v2',
      mode: this.selection?.providerId === 'chimera-auto' ? 'auto' : 'manual',
      selected: this.selection ? structuredClone(this.selection) : null,
      catalog: {
        total: bedrockModels.length + mantleModels.length + compatibleProviders.reduce((total, provider) => total + provider.models.length, 0),
        capabilityCounts,
      },
      providers: [
        ...(antigravity ? [{
          id: 'antigravity', name: 'Antigravity', configured: antigravity.configured,
          authentication: 'Antigravity account', connectionStatus: antigravity.status,
          authenticated: antigravity.authenticated, execution: 'antigravity-managed',
          ...(antigravity.error ? { error: antigravity.error } : {}),
          models: antigravity.models.map(model => ({ ...model,
            availability: antigravity.configured ? (antigravity.authenticated ? 'authenticated' : 'local-ready') : 'unavailable',
            capabilities: ['conversation'], inputModalities: ['TEXT'], outputModalities: ['TEXT'],
          })),
        }] : []),
        {
          id: 'codex',
          name: 'Codex',
          configured: this.codexStatus?.configured === true,
          authentication: this.codexStatus?.configured ? 'ChatGPT subscription' : null,
          models: [{
            id: this.config.codex.model,
            name: this.config.codex.model,
            availability: this.codexStatus?.configured ? 'authenticated' : 'unavailable',
            capabilities: ['conversation'],
            inputModalities: ['TEXT'],
            outputModalities: ['TEXT'],
          }],
        },
        {
          id: 'aws-bedrock',
          name: 'AWS Bedrock Runtime',
          configured: this.bedrockProfiles.length > 0,
          region: this.config.region,
          ...(this.bedrockError ? { error: this.bedrockError } : {}),
          models: bedrockModels,
        },
        {
          id: 'aws-bedrock-mantle',
          name: 'AWS Bedrock Mantle',
          configured: hasMantleAuthentication(this.mantleApiKey, this.mantleSigner) && !this.mantleError,
          authentication: boundedString(this.mantleApiKey, 4096)
            ? 'Bedrock API key'
            : typeof this.mantleSigner?.sign === 'function' ? 'AWS SigV4' : null,
          connectionStatus: hasMantleAuthentication(this.mantleApiKey, this.mantleSigner) && !this.mantleError
            ? 'connected'
            : 'authentication-required',
          region: this.config.region,
          project: this.mantleSettings.project,
          endpoint: 'bedrock-mantle',
          ...(this.mantleError ? { error: this.mantleError } : {}),
          models: mantleModels,
        },
        ...compatibleProviders,
      ],
      routing: structuredClone(this.routeState),
      media: {
        jobs: [...this.mediaJobs.values()].map((job) => publicMediaArtifact(job, { includeArtifactUrl: false })),
      },
    }
  }

  router() {
    if (!this.activeRouter) {
      const error = new Error('NO_MODEL_PROVIDER_CONFIGURED')
      error.code = 'NO_MODEL_PROVIDER_CONFIGURED'
      throw error
    }
    return this.activeRouter
  }

  async routerFor({ mode = 'auto', providerId, model } = {}) {
    if (mode === 'auto') {
      if (!this.fabric) throw availabilityFailure('NO_MODEL_PROVIDER_CONFIGURED')
      return this.fabric
    }
    if (!['preferred', 'pinned'].includes(mode)) throw availabilityFailure('MODEL_SELECTION_INVALID')
    return (await this.#resolveExplicitRouter({ providerId, model })).router
  }

  async select({ providerId, model } = {}) {
    if (providerId === 'chimera-auto' && model === 'auto') {
      if (!this.fabric) throw availabilityFailure('NO_MODEL_PROVIDER_CONFIGURED')
      this.activeRouter = this.fabric
      this.selection = {
        providerId: 'chimera-auto',
        providerName: 'Chimera Auto',
        model: 'auto',
        modelName: 'Best model for task',
      }
      return this.state()
    }
    const resolved = await this.#resolveExplicitRouter({ providerId, model })
    this.activeRouter = resolved.router
    this.selection = resolved.selection
    return this.state()
  }

  async #resolveExplicitRouter({ providerId, model }) {
    if (providerId === 'antigravity') {
      const state = this.antigravity?.state()
      const selected = state?.models.find(entry => entry.id === model)
      if (!state?.configured || !selected) throw availabilityFailure('ANTIGRAVITY_MODEL_UNAVAILABLE')
      return {
        router: createTaskAwareModelRouter({
          routes: [{ id: 'antigravity-manual', router: this.antigravity.router(model),
            capabilities: ['orchestration', 'coding', 'reasoning', 'bulk', 'research'], costClass: 'subscription' }],
          audit: this.audit, now: this.now, routerId: 'model-fabric:manual:antigravity', model,
        }),
        selection: { providerId, providerName: 'Antigravity', model, modelName: selected.name },
      }
    }
    if (providerId === 'codex' && model === this.config.codex.model && this.codexRouter) {
      const router = createTaskAwareModelRouter({
        routes: [{
          id: 'codex-manual',
          router: this.codexRouter,
          capabilities: ['orchestration', 'coding', 'reasoning', 'bulk', 'research'],
          costClass: 'subscription',
        }],
        audit: this.audit,
        now: this.now,
        routerId: 'model-fabric:manual:codex',
        model,
      })
      return {
        router,
        selection: { providerId: 'codex', providerName: 'Codex', model, modelName: model },
      }
    }
    const compatibleProvider = this.openAiCompatibleProviders.get(providerId)
    if (compatibleProvider) {
      const selected = compatibleProvider.models.find((entry) => entry.id === model)
      if (!selected) throw availabilityFailure('MODEL_NOT_IN_PROVIDER_CATALOG')
      if (!boundedString(compatibleProvider.apiKey, 16_384)) throw availabilityFailure('MODEL_PROVIDER_AUTH_REQUIRED')
      const checked = await this.check({ providerId, model })
      if (checked.availability !== 'verified-manual') {
        throw availabilityFailure(checked.error ?? 'MODEL_PROVIDER_NOT_AVAILABLE')
      }
      const compatibleRouter = createOpenAiCompatibleModelRouter({
        providerId,
        model,
        baseUrl: compatibleProvider.baseUrl,
        apiKey: compatibleProvider.apiKey,
        fetchImpl: this.openAiCompatibleFetch,
      })
      return {
        router: createTaskAwareModelRouter({
          routes: [{
            id: `manual-${providerId}-${model}`,
            router: compatibleRouter,
            capabilities: ['orchestration', 'coding', 'reasoning', 'bulk', 'research'],
            costClass: 'manual',
          }],
          audit: this.audit,
          now: this.now,
          routerId: `model-fabric:manual:${providerId}`,
          model,
        }),
        selection: { providerId, providerName: compatibleProvider.name, model, modelName: selected.name },
      }
    }
    if (providerId === 'aws-bedrock-mantle') {
      const selected = this.mantleCatalog.find((entry) => entry.id === model)
      if (!selected) throw availabilityFailure('MODEL_NOT_IN_MANTLE_CATALOG')
      if (!hasMantleAuthentication(this.mantleApiKey, this.mantleSigner)) throw availabilityFailure('MANTLE_AUTH_REQUIRED')
      const checked = await this.check({ providerId, model })
      if (checked.availability !== 'verified-manual') {
        throw availabilityFailure(checked.error ?? 'MANTLE_MODEL_NOT_AVAILABLE')
      }
      const mantleRouter = createMantleModelRouter({
        fetchImpl: this.mantleFetch,
        baseUrl: this.mantleSettings.baseUrl,
        region: this.config.region,
        apiKey: this.mantleApiKey,
        signer: this.mantleSigner,
        project: this.mantleSettings.project,
        modelId: selected.id,
      })
      const router = createTaskAwareModelRouter({
        routes: [{
          id: `manual-mantle-${selected.id}`,
          router: mantleRouter,
          capabilities: ['orchestration', 'coding', 'reasoning', 'bulk', 'research'],
          costClass: 'manual',
        }],
        audit: this.audit,
        now: this.now,
        routerId: 'model-fabric:manual:bedrock-mantle',
        model: selected.id,
      })
      return {
        router,
        selection: {
          providerId: 'aws-bedrock-mantle',
          providerName: 'AWS Bedrock Mantle',
          model: selected.id,
          modelName: selected.name,
        },
      }
    }
    if (providerId !== 'aws-bedrock') throw availabilityFailure('MODEL_SELECTION_INVALID')
    const selected = this.bedrockCatalog.find((entry) => entry.id === model)
    if (!selected) throw availabilityFailure('MODEL_NOT_IN_BEDROCK_CATALOG')
    if (!selected.capabilities.includes('conversation')) {
      throw availabilityFailure('MODEL_REQUIRES_SPECIALIST_ADAPTER')
    }
    const checked = await this.check({ providerId, model })
    if (checked.availability !== 'verified-manual') {
      throw availabilityFailure(checked.error ?? 'BEDROCK_MODEL_NOT_AVAILABLE')
    }
    const bedrockRouter = createBedrockModelRouter({
      client: this.bedrockRuntimeClient,
      modelId: selected.id,
      region: this.config.region,
      ...(this.bedrockCommandFactory ? { commandFactory: this.bedrockCommandFactory } : {}),
    })
    const router = createTaskAwareModelRouter({
      routes: [{
        id: `manual-${selected.id}`,
        router: bedrockRouter,
        capabilities: ['orchestration', 'coding', 'reasoning', 'bulk', 'research'],
        costClass: 'manual',
      }],
      audit: this.audit,
      now: this.now,
      routerId: 'model-fabric:manual:bedrock',
      model: selected.id,
    })
    return {
      router,
      selection: {
        providerId: 'aws-bedrock',
        providerName: 'AWS Bedrock',
        model: selected.id,
        modelName: selected.name,
      },
    }
  }

  async check({ providerId, model } = {}) {
    const compatibleProvider = this.openAiCompatibleProviders.get(providerId)
    if (compatibleProvider) {
      const selected = compatibleProvider.models.find((entry) => entry.id === model)
      if (!selected) throw availabilityFailure('MODEL_NOT_IN_PROVIDER_CATALOG')
      const key = `${providerId}:${model}`
      if (!boundedString(compatibleProvider.apiKey, 16_384)) {
        const status = { availability: 'access-required', error: 'MODEL_PROVIDER_AUTH_REQUIRED' }
        this.openAiCompatibleAccessState.set(key, status)
        return { ...selected, ...status }
      }
      try {
        const router = createOpenAiCompatibleModelRouter({
          providerId,
          model,
          baseUrl: compatibleProvider.baseUrl,
          apiKey: compatibleProvider.apiKey,
          fetchImpl: this.openAiCompatibleFetch,
        })
        await router.route('Return a concise readiness summary.', { stage: 'specialist', taskId: 'model-access-check' })
        const status = { availability: 'verified-manual' }
        this.openAiCompatibleAccessState.set(key, status)
        return { ...selected, ...status }
      } catch (error) {
        const status = { availability: 'unavailable', error: safeCompatibleErrorCode(error) }
        this.openAiCompatibleAccessState.set(key, status)
        return { ...selected, ...status }
      }
    }
    if (providerId === 'aws-bedrock-mantle') {
      const selected = this.mantleCatalog.find((entry) => entry.id === model)
      if (!selected) throw availabilityFailure('MODEL_NOT_IN_MANTLE_CATALOG')
      if (!hasMantleAuthentication(this.mantleApiKey, this.mantleSigner)) {
        const status = { availability: 'access-required', error: 'MANTLE_AUTH_REQUIRED' }
        this.mantleAccessState.set(selected.id, status)
        return { ...selected, ...status }
      }
      try {
        await probeMantleModelAccess({
          fetchImpl: this.mantleFetch,
          baseUrl: this.mantleSettings.baseUrl,
          region: this.config.region,
          apiKey: this.mantleApiKey,
          signer: this.mantleSigner,
          project: this.mantleSettings.project,
          modelId: selected.id,
        })
        const status = { availability: 'verified-manual' }
        this.mantleAccessState.set(selected.id, status)
        return { ...selected, ...status }
      } catch (error) {
        const status = { availability: 'unavailable', error: safeMantleErrorCode(error) }
        this.mantleAccessState.set(selected.id, status)
        return { ...selected, ...status }
      }
    }
    if (providerId !== 'aws-bedrock') throw availabilityFailure('MODEL_ACCESS_CHECK_INVALID')
    const selected = this.bedrockCatalog.find((entry) => entry.id === model)
    if (!selected?.foundationModelId) throw availabilityFailure('MODEL_FOUNDATION_ID_UNAVAILABLE')
    if (!this.bedrockControlClient) throw availabilityFailure('BEDROCK_CONTROL_CLIENT_UNAVAILABLE')
    try {
      const availability = await checkBedrockModelAvailability({
        client: this.bedrockControlClient,
        modelId: selected.foundationModelId,
        ...(this.bedrockAvailabilityCommandFactory
          ? { commandFactory: this.bedrockAvailabilityCommandFactory }
          : {}),
      })
      if (!availability.ready) {
        const status = {
          availability: 'access-required',
          access: availability,
          error: 'BEDROCK_MODEL_ACCESS_REQUIRED',
        }
        this.accessState.set(selected.id, status)
        return { ...selected, ...status }
      }
      if (selected.capabilities.includes('conversation')) {
        if (!this.bedrockRuntimeClient) throw availabilityFailure('BEDROCK_RUNTIME_CLIENT_UNAVAILABLE')
        await probeBedrockConverseAccess({
          client: this.bedrockRuntimeClient,
          modelId: selected.id,
          ...(this.bedrockCommandFactory ? { commandFactory: this.bedrockCommandFactory } : {}),
        })
        const status = { availability: 'verified-manual', access: availability }
        this.accessState.set(selected.id, status)
        return { ...selected, ...status }
      }
      const status = {
        availability: this.mediaGenerators.has(selected.id) ? 'adapter-ready' : 'access-eligible',
        access: availability,
        adapter: this.mediaGenerators.has(selected.id) ? 'ready' : 'required',
      }
      this.accessState.set(selected.id, status)
      return { ...selected, ...status }
    } catch (error) {
      const code = safeErrorCode(error)
      const status = { availability: 'unavailable', error: code }
      this.accessState.set(selected.id, status)
      return { ...selected, ...status }
    }
  }

  async generateMedia({ model, ...input } = {}) {
    const generator = this.mediaGenerators.get(model)
    if (!generator) throw availabilityFailure('MEDIA_MODEL_NOT_CONFIGURED')
    const artifact = await generator.generate(input)
    if (artifact.kind === 'video') this.mediaJobs.set(artifact.jobId, artifact)
    this.audit.append({
      kind: 'media.generation.started',
      modelId: model,
      mediaKind: artifact.kind,
      status: artifact.status,
      ...(artifact.jobId ? { jobId: artifact.jobId } : {}),
      at: new Date(this.now()).toISOString(),
    })
    return structuredClone(publicMediaArtifact(artifact))
  }

  async mediaStatus({ jobId } = {}) {
    const current = this.mediaJobs.get(jobId)
    if (!current || current.kind !== 'video') throw availabilityFailure('MEDIA_JOB_NOT_FOUND')
    const generator = this.mediaGenerators.get(current.modelId)
    const updated = await generator.status({ invocationArn: current.invocationArn, jobId })
    const projected = updated.status === 'completed' && this.mediaArtifactResolver
      ? { ...updated, artifactUrl: await this.mediaArtifactResolver.url({ outputS3Uri: updated.outputS3Uri }) }
      : updated
    this.mediaJobs.set(jobId, projected)
    if (projected.status !== current.status) {
      this.audit.append({
        kind: 'media.generation.updated',
        modelId: projected.modelId,
        mediaKind: projected.kind,
        status: projected.status,
        jobId,
        at: new Date(this.now()).toISOString(),
      })
    }
    return structuredClone(publicMediaArtifact(projected))
  }
}
