import crypto from 'node:crypto'

const ASPECT_RATIOS = new Set(['1:1', '16:9', '9:16', '4:3', '3:4', '21:9', '9:21', '2:3', '3:2', '4:5', '5:4'])
const VIDEO_DURATIONS = new Set(['5s', '9s'])
const VIDEO_RESOLUTIONS = new Set(['540p', '720p'])
const OUTPUT_FORMATS = new Set(['png', 'jpeg'])

function boundedString(value, maximum) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum
}

function mediaError(code, message = code) {
  const error = new Error(message)
  error.code = code
  return error
}

async function invokeModelCommand(input) {
  const { InvokeModelCommand } = await import('@aws-sdk/client-bedrock-runtime')
  return new InvokeModelCommand(input)
}

async function startAsyncInvokeCommand(input) {
  const { StartAsyncInvokeCommand } = await import('@aws-sdk/client-bedrock-runtime')
  return new StartAsyncInvokeCommand(input)
}

async function getAsyncInvokeCommand(input) {
  const { GetAsyncInvokeCommand } = await import('@aws-sdk/client-bedrock-runtime')
  return new GetAsyncInvokeCommand(input)
}

function parseJsonBody(body) {
  if (body instanceof Uint8Array) return JSON.parse(new TextDecoder().decode(body))
  if (typeof body === 'string') return JSON.parse(body)
  if (body && typeof body.transformToString === 'function') {
    return body.transformToString().then((value) => JSON.parse(value))
  }
  throw mediaError('MEDIA_RESPONSE_INVALID')
}

function normalizeS3Prefix(value) {
  if (!boundedString(value, 2048) || !value.startsWith('s3://')) return null
  const parsed = value.slice(5)
  const separator = parsed.indexOf('/')
  if (separator <= 0 || separator === parsed.length - 1) return null
  const bucket = parsed.slice(0, separator)
  const key = parsed.slice(separator + 1).replace(/^\/+|\/+$/g, '')
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)
    || !boundedString(key, 1024)
    || key.split('/').some((part) => part === '.' || part === '..')) return null
  return `s3://${bucket}/${key}`
}

function normalizedAsyncStatus(status) {
  if (status === 'Completed') return 'completed'
  if (status === 'Failed') return 'failed'
  return 'in-progress'
}

export function createStabilityImageGenerator({
  client,
  modelId = 'stability.stable-image-ultra-v1:1',
  commandFactory = invokeModelCommand,
} = {}) {
  if (!client || typeof client.send !== 'function'
    || !boundedString(modelId, 512)
    || !modelId.startsWith('stability.')
    || typeof commandFactory !== 'function') {
    throw new TypeError('invalid Stability image provider')
  }
  return Object.freeze({
    modelId,
    kind: 'image',
    async generate({
      prompt,
      aspectRatio = '1:1',
      outputFormat = 'png',
      seed = 0,
      negativePrompt,
    } = {}) {
      if (!boundedString(prompt, 10_000)
        || !ASPECT_RATIOS.has(aspectRatio)
        || !OUTPUT_FORMATS.has(outputFormat)
        || !Number.isSafeInteger(seed)
        || seed < 0
        || seed > 4_294_967_295
        || (negativePrompt !== undefined && !boundedString(negativePrompt, 10_000))) {
        throw mediaError('MEDIA_REQUEST_INVALID')
      }
      const payload = {
        prompt: prompt.trim(),
        mode: 'text-to-image',
        aspect_ratio: aspectRatio,
        output_format: outputFormat,
        seed,
        ...(negativePrompt ? { negative_prompt: negativePrompt.trim() } : {}),
      }
      const response = await client.send(await commandFactory({
        modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(payload),
      }))
      const body = await parseJsonBody(response?.body)
      const finishReason = body?.finish_reasons?.[0]
      if (finishReason) throw mediaError('MEDIA_GENERATION_FILTERED')
      if (!boundedString(body?.images?.[0], 50_000_000)) throw mediaError('MEDIA_RESPONSE_INVALID')
      return Object.freeze({
        kind: 'image',
        status: 'completed',
        modelId,
        mimeType: `image/${outputFormat}`,
        base64: body.images[0],
        seed: Number.isSafeInteger(body?.seeds?.[0]) ? body.seeds[0] : seed,
      })
    },
  })
}

export function createLumaVideoGenerator({
  client,
  modelId = 'luma.ray-v2:0',
  outputS3Uri,
  idFactory = () => crypto.randomUUID(),
  startCommandFactory = startAsyncInvokeCommand,
  getCommandFactory = getAsyncInvokeCommand,
} = {}) {
  const outputPrefix = normalizeS3Prefix(outputS3Uri)
  if (!client || typeof client.send !== 'function'
    || modelId !== 'luma.ray-v2:0'
    || !outputPrefix
    || typeof idFactory !== 'function'
    || typeof startCommandFactory !== 'function'
    || typeof getCommandFactory !== 'function') {
    throw new TypeError('invalid Luma video provider')
  }
  return Object.freeze({
    modelId,
    kind: 'video',
    async generate({
      prompt,
      aspectRatio = '16:9',
      duration = '5s',
      resolution = '540p',
      loop = false,
    } = {}) {
      if (!boundedString(prompt, 5_000)
        || !ASPECT_RATIOS.has(aspectRatio)
        || !VIDEO_DURATIONS.has(duration)
        || !VIDEO_RESOLUTIONS.has(resolution)
        || typeof loop !== 'boolean') {
        throw mediaError('MEDIA_REQUEST_INVALID')
      }
      const jobId = idFactory()
      if (!boundedString(jobId, 128) || !/^[A-Za-z0-9_-]+$/.test(jobId)) throw mediaError('MEDIA_JOB_ID_INVALID')
      const outputUri = `${outputPrefix}/${jobId}/`
      const response = await client.send(await startCommandFactory({
        modelId,
        modelInput: {
          prompt: prompt.trim(),
          aspect_ratio: aspectRatio,
          duration,
          resolution,
          loop,
        },
        outputDataConfig: { s3OutputDataConfig: { s3Uri: outputUri } },
      }))
      if (!boundedString(response?.invocationArn, 2048)) throw mediaError('MEDIA_RESPONSE_INVALID')
      return Object.freeze({
        kind: 'video',
        status: 'in-progress',
        modelId,
        jobId,
        invocationArn: response.invocationArn,
        outputS3Uri: outputUri,
      })
    },
    async status({ invocationArn, jobId } = {}) {
      if (!boundedString(invocationArn, 2048)
        || !boundedString(jobId, 128)
        || !/^[A-Za-z0-9_-]+$/.test(jobId)) throw mediaError('MEDIA_JOB_INVALID')
      const response = await client.send(await getCommandFactory({ invocationArn }))
      const outputUri = response?.outputDataConfig?.s3OutputDataConfig?.s3Uri
      if (!boundedString(outputUri, 2048) || !outputUri.startsWith(`${outputPrefix}/${jobId}/`)) {
        throw mediaError('MEDIA_RESPONSE_INVALID')
      }
      const status = normalizedAsyncStatus(response?.status)
      return Object.freeze({
        kind: 'video',
        status,
        modelId,
        jobId,
        invocationArn,
        outputS3Uri: outputUri,
        ...(response?.submitTime instanceof Date ? { submittedAt: response.submitTime.toISOString() } : {}),
        ...(response?.endTime instanceof Date ? { completedAt: response.endTime.toISOString() } : {}),
        ...(status === 'failed' && boundedString(response?.failureMessage, 2048)
          ? { error: 'MEDIA_GENERATION_FAILED' }
          : {}),
      })
    },
  })
}
