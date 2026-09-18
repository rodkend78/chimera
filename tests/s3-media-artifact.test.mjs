import assert from 'node:assert/strict'
import test from 'node:test'
import { createS3MediaArtifactResolver } from '../src/ceo/s3-media-artifact.mjs'

test('S3 media resolver signs only the expected output.mp4 object below the configured job prefix', async () => {
  const commands = []
  const resolver = createS3MediaArtifactResolver({
    client: { config: {} },
    commandFactory: async (input) => {
      commands.push(input)
      return { input }
    },
    presign: async (_client, command, options) => {
      assert.equal(command.input.Key, 'jobs/video-1/invocation-1/output.mp4')
      assert.deepEqual(options, { expiresIn: 900 })
      return 'https://chimera-media.s3.us-west-2.amazonaws.com/jobs/video-1/invocation-1/output.mp4?signature=redacted'
    },
  })

  assert.equal(await resolver.url({ outputS3Uri: 's3://chimera-media/jobs/video-1/invocation-1' }),
    'https://chimera-media.s3.us-west-2.amazonaws.com/jobs/video-1/invocation-1/output.mp4?signature=redacted')
  assert.deepEqual(commands, [{ Bucket: 'chimera-media', Key: 'jobs/video-1/invocation-1/output.mp4' }])
})

test('S3 media resolver rejects ambiguous or traversal-shaped destinations', async () => {
  const resolver = createS3MediaArtifactResolver({
    client: { config: {} },
    commandFactory: async (input) => ({ input }),
    presign: async () => 'https://example.com/',
  })
  for (const outputS3Uri of ['https://example.com/a', 's3://bucket', 's3://bucket/jobs/../secret']) {
    await assert.rejects(resolver.url({ outputS3Uri }), /MEDIA_S3_URI_INVALID/)
  }
})
