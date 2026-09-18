import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

const DEFAULT_HERMES_HOST = 'configured-hermes'
const SAFE_PATH = /^(?!\.)(?!.*(?:^|\/)\.)(?!.*\.\.)(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*$/
const SAFE_EXTENSION = /\.(?:md|txt|json|ya?ml|py|mjs|js|ts|tsx|jsx|sh|toml)$/i
const SENSITIVE_NAME = /(?:^|[-_.])(credential|credentials|secret|secrets|token|tokens|session|sessions|cookie|cookies|private[-_.]?key|auth)(?:[-_.]|$)/i
const PERSONA_FILES = new Set(['AGENTS.md', 'IDENTITY.md', 'SOUL.md', 'TOOLS.md', 'USER.md'])
const SKILL_DEFINITION = /(?:^|\/)SKILL\.md$/
const CREDENTIAL_ASSIGNMENT = /(?:^|\n)\s*(?:export\s+)?(?:AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)|OPENAI_API_KEY|ANTHROPIC_API_KEY|GOOGLE_API_KEY|GEMINI_API_KEY|(?:API_?)?(?:TOKEN|SECRET|PASSWORD)|PRIVATE_KEY)\s*[:=]\s*\S+/i
const PRIVATE_KEY_BLOCK = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/
const MAX_FILES = 512
const MAX_FILE_BYTES = 1024 * 1024
const MAX_TOTAL_BYTES = 16 * 1024 * 1024

function codedError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function validHost(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
    && /^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(value)
}

function referencePattern(host) {
  return new RegExp(`^hermes://${host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/profiles/([a-z][a-z0-9-]{0,63})/(persona|memory|skills)$`)
}

function normalizePrefix(prefix) {
  const value = prefix ?? 'server/agent-state/hermes-profiles/'
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || value.startsWith('/') || value.includes('..')) {
    throw new TypeError('HERMES_REFERENCE_CONFIG_INVALID')
  }
  return value.endsWith('/') ? value : `${value}/`
}

export function resolveHermesBackupTarget(env = process.env) {
  const bucket = typeof env.CHIMERA_HERMES_BACKUP_BUCKET === 'string'
    ? env.CHIMERA_HERMES_BACKUP_BUCKET.trim()
    : ''
  if (!bucket) return null
  const prefix = typeof env.CHIMERA_HERMES_BACKUP_PREFIX === 'string' && env.CHIMERA_HERMES_BACKUP_PREFIX.trim()
    ? env.CHIMERA_HERMES_BACKUP_PREFIX.trim()
    : undefined
  const region = typeof env.CHIMERA_AWS_REGION === 'string' && env.CHIMERA_AWS_REGION.trim()
    ? env.CHIMERA_AWS_REGION.trim()
    : 'us-west-2'
  const host = typeof env.CHIMERA_HERMES_HOST === 'string' && env.CHIMERA_HERMES_HOST.trim()
    ? env.CHIMERA_HERMES_HOST.trim()
    : DEFAULT_HERMES_HOST
  if (!validHost(host)) throw new TypeError('HERMES_REFERENCE_CONFIG_INVALID')
  return { bucket, ...(prefix ? { prefix } : {}), region, host }
}

export class UnconfiguredHermesReferenceProvider {
  async materialize() {
    throw codedError('HERMES_REFERENCE_NOT_CONFIGURED')
  }
}

export function createHermesReferenceProviderFromEnv(env = process.env) {
  const host = typeof env.CHIMERA_HERMES_HOST === 'string' && env.CHIMERA_HERMES_HOST.trim()
    ? env.CHIMERA_HERMES_HOST.trim()
    : DEFAULT_HERMES_HOST
  if (!validHost(host)) throw new TypeError('HERMES_REFERENCE_CONFIG_INVALID')
  if (env.CHIMERA_HERMES_SNAPSHOT_FILE) return new HermesSnapshotReferenceProvider(env.CHIMERA_HERMES_SNAPSHOT_FILE, { host })
  const target = resolveHermesBackupTarget(env)
  if (!target) return new UnconfiguredHermesReferenceProvider()
  return new HermesS3ReferenceProvider(target)
}

// A selected, immutable export is independent of cloud login lifetime. It uses
// the same content/path filters and materialization limits as the S3 provider.
export class HermesSnapshotReferenceProvider {
  constructor(filePath, { host = DEFAULT_HERMES_HOST } = {}) {
    if (typeof filePath !== 'string' || !isAbsolute(filePath) || filePath.length > 4096) {
      throw new TypeError('HERMES_SNAPSHOT_CONFIG_INVALID')
    }
    if (!validHost(host)) throw new TypeError('HERMES_SNAPSHOT_CONFIG_INVALID')
    this.filePath = filePath; this.host = host
  }

  async materialize(reference, context) {
    const file = await open(this.filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
    let document
    try {
      const info = await file.stat()
      if (!info.isFile() || info.size > 32 * 1024 * 1024) throw new TypeError('HERMES_SNAPSHOT_INVALID')
      document = JSON.parse(await file.readFile('utf8'))
    } finally { await file.close() }
    if (document?.schema !== 'chimera.hermes-snapshot.v1' || !Array.isArray(document.entries)
      || document.entries.length > 8192) throw new TypeError('HERMES_SNAPSHOT_INVALID')
    const objects = new Map()
    for (const entry of document.entries) {
      if (typeof entry?.key !== 'string' || !SAFE_PATH.test(entry.key)
        || !/^[a-z][a-z0-9-]{0,63}\//.test(entry.key)
        || objects.has(entry.key) || typeof entry.content !== 'string'
        || entry.content.length > Math.ceil(MAX_FILE_BYTES / 3) * 4
        || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? '')) throw new TypeError('HERMES_SNAPSHOT_INVALID')
      const bytes = Buffer.from(entry.content, 'base64')
      if (bytes.toString('base64') !== entry.content
        || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new TypeError('HERMES_SNAPSHOT_INVALID')
      objects.set(entry.key, bytes)
    }
    const prefix = 'snapshot/'
    const provider = new HermesS3ReferenceProvider({
      bucket: 'local-snapshot', prefix, host: this.host,
      listObjects: async requested => [...objects].map(([key, bytes]) => ({ Key: prefix + key, Size: bytes.length }))
        .filter(entry => entry.Key.startsWith(requested)),
      getObject: async key => objects.get(key.slice(prefix.length)),
    })
    return provider.materialize(reference, context)
  }
}

async function bodyBytes(body) {
  if (body instanceof Uint8Array) return Buffer.from(body)
  if (typeof body?.transformToByteArray === 'function') return Buffer.from(await body.transformToByteArray())
  throw new TypeError('HERMES_REFERENCE_BODY_INVALID')
}

function containsCredentialMaterial(content) {
  if (content.includes(0)) return true
  const text = content.toString('utf8')
  return CREDENTIAL_ASSIGNMENT.test(text) || PRIVATE_KEY_BLOCK.test(text)
}

export class HermesS3ReferenceProvider {
  constructor({
    bucket,
    prefix,
    region = process.env.CHIMERA_AWS_REGION ?? 'us-west-2',
    host = DEFAULT_HERMES_HOST,
    listObjects,
    getObject,
    client,
  }) {
    if (typeof bucket !== 'string' || bucket.length === 0 || bucket.length > 255) {
      throw new TypeError('HERMES_REFERENCE_CONFIG_INVALID')
    }
    if (!validHost(host)) throw new TypeError('HERMES_REFERENCE_CONFIG_INVALID')
    this.bucket = bucket
    this.prefix = normalizePrefix(prefix)
    this.host = host
    this.referencePattern = referencePattern(host)
    this.client = client ?? (!listObjects || !getObject ? new S3Client({ region }) : null)
    this.listObjects = listObjects ?? ((objectPrefix) => this.#listFromS3(objectPrefix))
    this.getObject = getObject ?? (async (key) => {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
      return bodyBytes(result.Body)
    })
  }

  async materialize(reference, { agentId, kind } = {}) {
    const match = typeof reference === 'string' ? this.referencePattern.exec(reference) : null
    if (!match || match[1] !== agentId || match[2] !== kind) {
      throw new TypeError('HERMES_REFERENCE_MISMATCH')
    }
    const sourceDirectory = kind === 'memory' ? 'memories' : kind === 'skills' ? 'skills' : null
    const objectPrefix = sourceDirectory
      ? `${this.prefix}${agentId}/${sourceDirectory}/`
      : `${this.prefix}${agentId}/`
    const listed = await this.listObjects(objectPrefix)
    if (!Array.isArray(listed)) throw new TypeError('HERMES_REFERENCE_LIST_INVALID')
    const accepted = []
    let totalBytes = 0
    for (const object of listed) {
      if (typeof object?.Key !== 'string' || !object.Key.startsWith(objectPrefix) || object.Key.endsWith('/')) continue
      const relative = object.Key.slice(objectPrefix.length)
      if (!SAFE_PATH.test(relative) || !SAFE_EXTENSION.test(relative) || SENSITIVE_NAME.test(relative)) continue
      if (kind === 'persona' && !PERSONA_FILES.has(relative)) continue
      if (kind === 'skills' && !SKILL_DEFINITION.test(relative)) continue
      if (!Number.isSafeInteger(object.Size) || object.Size < 0) throw new TypeError('HERMES_REFERENCE_LIST_INVALID')
      if (object.Size > MAX_FILE_BYTES) throw new TypeError('HERMES_REFERENCE_FILE_TOO_LARGE')
      totalBytes += object.Size
      if (totalBytes > MAX_TOTAL_BYTES) throw new TypeError('HERMES_REFERENCE_SET_TOO_LARGE')
      accepted.push({ key: object.Key, path: relative, expectedBytes: object.Size })
      if (accepted.length > MAX_FILES) throw new TypeError('HERMES_REFERENCE_SET_TOO_LARGE')
    }
    accepted.sort((left, right) => left.path.localeCompare(right.path))
    const materialized = await Promise.all(accepted.map(async ({ key, path, expectedBytes }) => {
      const content = Buffer.from(await this.getObject(key))
      if (content.byteLength !== expectedBytes || content.byteLength > MAX_FILE_BYTES) {
        throw new TypeError('HERMES_REFERENCE_BODY_INVALID')
      }
      return containsCredentialMaterial(content) ? null : { path, content }
    }))
    return materialized.filter(Boolean)
  }

  async #listFromS3(objectPrefix) {
    const objects = []
    let continuationToken
    do {
      const page = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: objectPrefix,
        ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
      }))
      objects.push(...(page.Contents ?? []).map(({ Key, Size }) => ({ Key, Size })))
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined
      if (page.IsTruncated && !continuationToken) throw new TypeError('HERMES_REFERENCE_LIST_INVALID')
    } while (continuationToken)
    return objects
  }
}
