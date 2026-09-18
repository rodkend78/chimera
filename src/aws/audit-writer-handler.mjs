import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { verifyAuditEntries } from '../audit-log.mjs'
import { canonicalJson } from '../canonical.mjs'
import { DurableAuditLog } from '../audit/durable-log.mjs'
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
  return /^[A-Z][A-Z0-9_]{2,127}$/.test(code) ? code : 'AUDIT_WRITER_FAILED'
}

export function createAuditWriterHandler({ store } = {}) {
  if (!store
    || typeof store.head !== 'function'
    || typeof store.entries !== 'function'
    || typeof store.receipt !== 'function'
    || typeof store.appendIfHead !== 'function') {
    throw new TypeError('AUDIT_WRITER_STORE_INVALID')
  }
  return async (event = {}) => {
    try {
      if (!bounded(event.streamId) || !/^[A-Za-z0-9._:/-]+$/.test(event.streamId)) {
        throw new TypeError('AUDIT_STREAM_INVALID')
      }
      if (event.operation === 'snapshot') {
        const [head, entries] = await Promise.all([
          store.head(event.streamId),
          store.entries(event.streamId),
        ])
        const verification = verifyAuditEntries(entries)
        const verifiedHash = entries.at(-1)?.entryHash ?? GENESIS_HASH
        if (!validHead(head)
          || !verification.valid
          || head.nextSeq !== entries.length
          || head.headHash !== verifiedHash) {
          throw Object.assign(new Error('AUDIT_REMOTE_SNAPSHOT_INVALID'), { code: 'AUDIT_REMOTE_SNAPSHOT_INVALID' })
        }
        return { head, entries }
      }
      if (event.operation !== 'append') {
        throw Object.assign(new Error('AUDIT_WRITER_OPERATION_INVALID'), { code: 'AUDIT_WRITER_OPERATION_INVALID' })
      }
      const receipt = await store.receipt(event.streamId, event.requestId)
      if (receipt) {
        if (canonicalJson(receipt.fact) !== canonicalJson(event.fact)) {
          throw Object.assign(new Error('AUDIT_REQUEST_ID_REUSE'), { code: 'AUDIT_REQUEST_ID_REUSE' })
        }
        return receipt
      }
      const actual = await store.head(event.streamId)
      if (!validHead(event.expected)
        || actual.nextSeq !== event.expected.nextSeq
        || actual.headHash !== event.expected.headHash) {
        throw Object.assign(new Error('AUDIT_APPEND_CONFLICT'), { code: 'AUDIT_APPEND_CONFLICT' })
      }
      const audit = await DurableAuditLog.open({ store, streamId: event.streamId })
      return await audit.append(event.fact, { requestId: event.requestId })
    } catch (error) {
      const code = publicCode(error)
      console.error(JSON.stringify({
        event: 'chimera.audit-writer.failure',
        operation: bounded(event.operation, 32) ? event.operation : 'invalid',
        code,
        errorName: bounded(error?.name, 128) ? error.name : 'Error',
      }))
      return { error: { code } }
    }
  }
}

let productionHandler

export async function handler(event) {
  if (!productionHandler) {
    const tableName = process.env.CHIMERA_AUDIT_TABLE
    if (!bounded(tableName)) return { error: { code: 'AUDIT_WRITER_CONFIG_INVALID' } }
    const client = new DynamoDBClient({ region: process.env.AWS_REGION ?? 'us-west-2' })
    productionHandler = createAuditWriterHandler({
      store: new DynamoAuditStore({ client, tableName }),
    })
  }
  return productionHandler(event)
}
