function mediaS3Error() {
  const error = new Error('MEDIA_S3_URI_INVALID')
  error.code = 'MEDIA_S3_URI_INVALID'
  return error
}

function parseS3Uri(value) {
  if (typeof value !== 'string' || !value.startsWith('s3://') || value.length > 2048) throw mediaS3Error()
  const raw = value.slice(5)
  const slash = raw.indexOf('/')
  if (slash <= 0 || slash === raw.length - 1) throw mediaS3Error()
  const Bucket = raw.slice(0, slash)
  const prefix = raw.slice(slash + 1).replace(/^\/+|\/+$/g, '')
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(Bucket)
    || !prefix
    || prefix.split('/').some((part) => !part || part === '.' || part === '..')) throw mediaS3Error()
  return { Bucket, Key: `${prefix}/output.mp4` }
}

async function getObjectCommand(input) {
  const { GetObjectCommand } = await import('@aws-sdk/client-s3')
  return new GetObjectCommand(input)
}

async function presign(client, command, options) {
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner')
  return getSignedUrl(client, command, options)
}

export function createS3MediaArtifactResolver({
  client,
  commandFactory = getObjectCommand,
  presign: presignImpl = presign,
  expiresIn = 900,
} = {}) {
  if (!client || typeof commandFactory !== 'function' || typeof presignImpl !== 'function'
    || !Number.isSafeInteger(expiresIn) || expiresIn < 60 || expiresIn > 3600) {
    throw new TypeError('invalid S3 media artifact resolver')
  }
  return Object.freeze({
    async url({ outputS3Uri } = {}) {
      const input = parseS3Uri(outputS3Uri)
      const value = await presignImpl(client, await commandFactory(input), { expiresIn })
      if (typeof value !== 'string' || !value.startsWith('https://') || value.length > 8192) {
        throw new Error('MEDIA_ARTIFACT_URL_INVALID')
      }
      return value
    },
  })
}
