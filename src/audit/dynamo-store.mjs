import {
  GetItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb'
import { canonicalJson, sha256 } from '../canonical.mjs'

const GENESIS_HASH = '0'.repeat(64)
const MAX_FACT_BYTES = 300 * 1024

function boundedString(value, maximum = 256) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function hash(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function validateStreamId(value) {
  if (!boundedString(value) || !/^[A-Za-z0-9._:/-]+$/.test(value)) {
    throw new TypeError('audit stream id is invalid')
  }
}

function validateRequestId(value) {
  if (!boundedString(value, 128) || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new TypeError('audit request id is invalid')
  }
}

function entryRecordId(seq) {
  return `ENTRY#${String(seq).padStart(20, '0')}`
}

function validateAppend(entry, expected) {
  if (!entry
    || !Number.isSafeInteger(entry.seq)
    || entry.seq < 0
    || !hash(entry.prevHash)
    || !hash(entry.entryHash)
    || !expected
    || !Number.isSafeInteger(expected.nextSeq)
    || expected.nextSeq !== entry.seq
    || !hash(expected.headHash)
    || expected.headHash !== entry.prevHash) {
    throw new TypeError('audit append is invalid')
  }
  const expectedEntryHash = sha256({ seq: entry.seq, prevHash: entry.prevHash, fact: entry.fact })
  if (entry.entryHash !== expectedEntryHash) throw new TypeError('audit entry hash does not match its fact')
}

function entryItem(streamId, entry, factJson, createdAt) {
  return {
    schema: { S: 'chimera.audit-entry.v1' },
    streamId: { S: streamId },
    recordId: { S: entryRecordId(entry.seq) },
    seq: { N: String(entry.seq) },
    prevHash: { S: entry.prevHash },
    factJson: { S: factJson },
    entryHash: { S: entry.entryHash },
    createdAt: { S: createdAt },
  }
}

function decodeEntry(item) {
  const seq = Number(item?.seq?.N)
  const prevHash = item?.prevHash?.S
  const entryHash = item?.entryHash?.S
  const factJson = item?.factJson?.S
  if (!Number.isSafeInteger(seq) || seq < 0 || !hash(prevHash) || !hash(entryHash) || !boundedString(factJson, MAX_FACT_BYTES)) {
    throw new Error('AUDIT_ENTRY_INVALID')
  }
  let fact
  try {
    fact = JSON.parse(factJson)
  } catch {
    throw new Error('AUDIT_ENTRY_INVALID')
  }
  const entry = { seq, prevHash, fact, entryHash }
  if (sha256({ seq, prevHash, fact }) !== entryHash) throw new Error('AUDIT_ENTRY_INVALID')
  return entry
}

export class DynamoAuditStore {
  constructor({ client, tableName, now = () => Date.now() }) {
    if (!client || typeof client.send !== 'function' || !boundedString(tableName) || typeof now !== 'function') {
      throw new TypeError('Dynamo audit store configuration is invalid')
    }
    this.client = client
    this.tableName = tableName
    this.now = now
  }

  async head(streamId) {
    validateStreamId(streamId)
    const result = await this.client.send(new GetItemCommand({
      TableName: this.tableName,
      Key: { streamId: { S: streamId }, recordId: { S: 'HEAD' } },
      ConsistentRead: true,
    }))
    if (!result.Item) return { nextSeq: 0, headHash: GENESIS_HASH }

    const nextSeq = Number(result.Item.nextSeq?.N)
    const headHash = result.Item.headHash?.S
    if (!Number.isSafeInteger(nextSeq) || nextSeq < 1 || !hash(headHash) || headHash === GENESIS_HASH) {
      throw new Error('AUDIT_HEAD_INVALID')
    }
    return { nextSeq, headHash }
  }

  async receipt(streamId, requestId) {
    validateStreamId(streamId)
    validateRequestId(requestId)
    const result = await this.client.send(new GetItemCommand({
      TableName: this.tableName,
      Key: { streamId: { S: streamId }, recordId: { S: `REQUEST#${requestId}` } },
      ConsistentRead: true,
    }))
    return result.Item ? decodeEntry(result.Item) : null
  }

  async appendIfHead(streamId, entry, expected, { requestId } = {}) {
    validateStreamId(streamId)
    validateRequestId(requestId)
    validateAppend(entry, expected)
    const factJson = canonicalJson(entry.fact)
    if (Buffer.byteLength(factJson, 'utf8') > MAX_FACT_BYTES) throw new TypeError('audit fact is too large')

    const putEntry = {
      Put: {
        TableName: this.tableName,
        Item: entryItem(streamId, entry, factJson, new Date(this.now()).toISOString()),
        ConditionExpression: 'attribute_not_exists(streamId) AND attribute_not_exists(recordId)',
      },
    }
    const advanceHead = expected.nextSeq === 0
      ? {
          Put: {
            TableName: this.tableName,
            Item: {
              schema: { S: 'chimera.audit-head.v1' },
              streamId: { S: streamId },
              recordId: { S: 'HEAD' },
              nextSeq: { N: '1' },
              headHash: { S: entry.entryHash },
            },
            ConditionExpression: 'attribute_not_exists(streamId) AND attribute_not_exists(recordId)',
          },
        }
      : {
          Update: {
            TableName: this.tableName,
            Key: { streamId: { S: streamId }, recordId: { S: 'HEAD' } },
            UpdateExpression: 'SET nextSeq = :nextSeq, headHash = :nextHash',
            ConditionExpression: 'nextSeq = :expectedSeq AND headHash = :expectedHash',
            ExpressionAttributeValues: {
              ':nextSeq': { N: String(entry.seq + 1) },
              ':nextHash': { S: entry.entryHash },
              ':expectedSeq': { N: String(expected.nextSeq) },
              ':expectedHash': { S: expected.headHash },
            },
          },
        }

    const putReceipt = {
      Put: {
        TableName: this.tableName,
        Item: {
          schema: { S: 'chimera.audit-request-receipt.v1' },
          streamId: { S: streamId },
          recordId: { S: `REQUEST#${requestId}` },
          requestId: { S: requestId },
          seq: { N: String(entry.seq) },
          prevHash: { S: entry.prevHash },
          factJson: { S: factJson },
          entryHash: { S: entry.entryHash },
          createdAt: { S: new Date(this.now()).toISOString() },
        },
        ConditionExpression: 'attribute_not_exists(streamId) AND attribute_not_exists(recordId)',
      },
    }

    try {
      await this.client.send(new TransactWriteItemsCommand({
        ClientRequestToken: sha256(requestId).slice(0, 36),
        TransactItems: [putEntry, advanceHead, putReceipt],
      }))
    } catch (error) {
      if (['TransactionCanceledException', 'ConditionalCheckFailedException'].includes(error?.name)) {
        const conflict = new Error('AUDIT_APPEND_CONFLICT')
        conflict.code = 'AUDIT_APPEND_CONFLICT'
        conflict.cause = error
        throw conflict
      }
      throw error
    }
  }

  async entries(streamId) {
    validateStreamId(streamId)
    const entries = []
    let cursor
    do {
      const result = await this.client.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'streamId = :streamId AND begins_with(recordId, :entry)',
        ExpressionAttributeValues: {
          ':streamId': { S: streamId },
          ':entry': { S: 'ENTRY#' },
        },
        ConsistentRead: true,
        ScanIndexForward: true,
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }))
      entries.push(...(result.Items ?? []).map(decodeEntry))
      cursor = result.LastEvaluatedKey
    } while (cursor)
    return entries
  }
}
