import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { verifyAuditEntries } from '../audit-log.mjs'
import { canonicalJson } from '../canonical.mjs'
import { DynamoAuditStore } from '../audit/dynamo-store.mjs'

const GENESIS_HASH = '0'.repeat(64)

function bounded(value, maximum = 256) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function validHead(head) {
  return head
    && Number.isSafeInteger(head.nextSeq)
    && head.nextSeq >= 0
    && typeof head.headHash === 'string'
    && /^[a-f0-9]{64}$/.test(head.headHash)
    && ((head.nextSeq === 0) === (head.headHash === GENESIS_HASH))
}

function publicCode(error) {
  const code = typeof error?.code === 'string' ? error.code : error instanceof Error ? error.message : ''
  return /^[A-Z][A-Z0-9_]{2,127}$/.test(code) ? code : 'AUDIT_ANCHOR_FAILED'
}

function sourceInvalid() {
  return Object.assign(new Error('AUDIT_ANCHOR_SOURCE_INVALID'), { code: 'AUDIT_ANCHOR_SOURCE_INVALID' })
}

export function createAuditAnchorWriter({ bucket, store, putObject, now = () => new Date() } = {}) {
  if (!bounded(bucket)
    || !store || typeof store.head !== 'function' || typeof store.entries !== 'function'
    || typeof putObject !== 'function' || typeof now !== 'function') {
    throw new TypeError('AUDIT_ANCHOR_CONFIG_INVALID')
  }
  return async ({ streamId } = {}) => {
    if (!bounded(streamId) || !/^[A-Za-z0-9._:/-]+$/.test(streamId)) {
      throw new TypeError('AUDIT_ANCHOR_STREAM_INVALID')
    }
    const [head, entries] = await Promise.all([store.head(streamId), store.entries(streamId)])
    const verification = verifyAuditEntries(entries)
    const verifiedHash = entries.at(-1)?.entryHash ?? GENESIS_HASH
    if (!validHead(head)
      || !verification.valid
      || head.nextSeq !== entries.length
      || head.headHash !== verifiedHash) {
      throw sourceInvalid()
    }
    const instant = now()
    const anchoredAt = instant instanceof Date ? instant.toISOString() : new Date(instant).toISOString()
    const key = `anchors/${encodeURIComponent(streamId)}/${String(head.nextSeq).padStart(20, '0')}-${head.headHash}.json`
    const document = {
      anchoredAt,
      headHash: head.headHash,
      nextSeq: head.nextSeq,
      schema: 'chimera.audit-anchor.v1',
      streamId,
    }
    let response
    try {
      response = await putObject({
        Body: canonicalJson(document),
        Bucket: bucket,
        ContentType: 'application/json',
        IfNoneMatch: '*',
        Key: key,
      })
    } catch (error) {
      if (error?.$metadata?.httpStatusCode !== 412 && error?.name !== 'PreconditionFailed') throw error
      return {
        bucket,
        key,
        nextSeq: head.nextSeq,
        headHash: head.headHash,
        etag: null,
        versionId: null,
        existing: true,
      }
    }
    return {
      bucket,
      key,
      nextSeq: head.nextSeq,
      headHash: head.headHash,
      etag: response?.ETag ?? null,
      versionId: response?.VersionId ?? null,
    }
  }
}

let productionWriter

export async function handler(event) {
  try {
    if (!productionWriter) {
      const tableName = process.env.CHIMERA_AUDIT_TABLE
      const bucket = process.env.CHIMERA_AUDIT_ANCHOR_BUCKET
      if (!bounded(tableName) || !bounded(bucket)) throw new TypeError('AUDIT_ANCHOR_CONFIG_INVALID')
      const region = process.env.AWS_REGION ?? 'us-west-2'
      const s3 = new S3Client({ region })
      productionWriter = createAuditAnchorWriter({
        bucket,
        store: new DynamoAuditStore({ client: new DynamoDBClient({ region }), tableName }),
        putObject: (request) => s3.send(new PutObjectCommand(request)),
      })
    }
    return await productionWriter(event)
  } catch (error) {
    const code = publicCode(error)
    console.error(JSON.stringify({
      event: 'chimera.audit-anchor.failure',
      code,
      errorName: bounded(error?.name, 128) ? error.name : 'Error',
    }))
    return { error: { code } }
  }
}
