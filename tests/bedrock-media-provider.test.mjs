import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createStabilityImageGenerator,
  createLumaVideoGenerator,
} from '../src/ceo/bedrock-media-provider.mjs'

test('Stability image generator emits the native Bedrock request and returns a bounded image artifact', async () => {
  const requests = []
  const generator = createStabilityImageGenerator({
    client: {
      async send(command) {
        requests.push(command.input)
        return {
          body: new TextEncoder().encode(JSON.stringify({
            seeds: [42],
            finish_reasons: [null],
            images: [Buffer.from('png-bytes').toString('base64')],
          })),
        }
      },
    },
    modelId: 'stability.stable-image-ultra-v1:1',
    commandFactory: async (input) => ({ input }),
  })

  const artifact = await generator.generate({
    prompt: 'A precise turquoise mechanical chimera on a white background.',
    aspectRatio: '16:9',
    outputFormat: 'png',
    seed: 42,
  })

  assert.deepEqual(JSON.parse(requests[0].body), {
    prompt: 'A precise turquoise mechanical chimera on a white background.',
    mode: 'text-to-image',
    aspect_ratio: '16:9',
    output_format: 'png',
    seed: 42,
  })
  assert.equal(requests[0].modelId, 'stability.stable-image-ultra-v1:1')
  assert.equal(requests[0].contentType, 'application/json')
  assert.equal(requests[0].accept, 'application/json')
  assert.deepEqual(artifact, {
    kind: 'image',
    status: 'completed',
    modelId: 'stability.stable-image-ultra-v1:1',
    mimeType: 'image/png',
    base64: Buffer.from('png-bytes').toString('base64'),
    seed: 42,
  })
})

test('Stability image generator fails closed when the provider filters the result', async () => {
  const generator = createStabilityImageGenerator({
    client: {
      async send() {
        return {
          body: new TextEncoder().encode(JSON.stringify({
            finish_reasons: ['Filter reason: prompt'],
          })),
        }
      },
    },
    commandFactory: async (input) => ({ input }),
  })

  await assert.rejects(
    generator.generate({ prompt: 'A blocked prompt.' }),
    (error) => error.code === 'MEDIA_GENERATION_FILTERED',
  )
})

test('Luma video generator starts and polls an async Bedrock job with a scoped S3 destination', async () => {
  const requests = []
  const generator = createLumaVideoGenerator({
    client: {
      async send(command) {
        requests.push(command.input)
        if (command.input.invocationArn) {
          return {
            invocationArn: command.input.invocationArn,
            status: 'Completed',
            submitTime: new Date('2026-08-29T18:00:00.000Z'),
            endTime: new Date('2026-08-29T18:03:00.000Z'),
            outputDataConfig: { s3OutputDataConfig: { s3Uri: 's3://chimera-media/jobs/video-1/invocation-1' } },
          }
        }
        return { invocationArn: 'arn:aws:bedrock:us-west-2:123456789012:async-invoke/video-1' }
      },
    },
    modelId: 'luma.ray-v2:0',
    outputS3Uri: 's3://chimera-media/jobs',
    idFactory: () => 'video-1',
    startCommandFactory: async (input) => ({ input }),
    getCommandFactory: async (input) => ({ input }),
  })

  const started = await generator.generate({
    prompt: 'A slow orbital move around a polished mechanical chimera.',
    aspectRatio: '16:9',
    duration: '5s',
    resolution: '540p',
    loop: false,
  })
  assert.deepEqual(requests[0], {
    modelId: 'luma.ray-v2:0',
    modelInput: {
      prompt: 'A slow orbital move around a polished mechanical chimera.',
      aspect_ratio: '16:9',
      duration: '5s',
      resolution: '540p',
      loop: false,
    },
    outputDataConfig: {
      s3OutputDataConfig: { s3Uri: 's3://chimera-media/jobs/video-1/' },
    },
  })
  assert.deepEqual(started, {
    kind: 'video',
    status: 'in-progress',
    modelId: 'luma.ray-v2:0',
    jobId: 'video-1',
    invocationArn: 'arn:aws:bedrock:us-west-2:123456789012:async-invoke/video-1',
    outputS3Uri: 's3://chimera-media/jobs/video-1/',
  })

  const completed = await generator.status({ invocationArn: started.invocationArn, jobId: started.jobId })
  assert.equal(requests[1].invocationArn, started.invocationArn)
  assert.deepEqual(completed, {
    kind: 'video',
    status: 'completed',
    modelId: 'luma.ray-v2:0',
    jobId: 'video-1',
    invocationArn: started.invocationArn,
    outputS3Uri: 's3://chimera-media/jobs/video-1/invocation-1',
    submittedAt: '2026-08-29T18:00:00.000Z',
    completedAt: '2026-08-29T18:03:00.000Z',
  })
})

test('Luma video generator rejects non-S3 and unscoped output destinations before invocation', () => {
  for (const outputS3Uri of ['https://example.com/output', 's3://bucket', 's3://bucket/../escape']) {
    assert.throws(() => createLumaVideoGenerator({
      client: { async send() {} },
      outputS3Uri,
    }), /invalid Luma video provider/)
  }
})
