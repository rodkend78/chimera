import assert from 'node:assert/strict'
import test from 'node:test'
import { DynamoAuditStore } from '../src/audit/dynamo-store.mjs'
import { sha256 } from '../src/canonical.mjs'

const GENESIS_HASH = '0'.repeat(64)

function makeEntry(fact, seq = 0, prevHash = GENESIS_HASH) {
  const unsigned = { seq, prevHash, fact }
  return { ...unsigned, entryHash: sha256(unsigned) }
}

class CapturingClient {
  constructor(responses = []) {
    this.responses = [...responses]
    this.commands = []
  }

  async send(command) {
    this.commands.push(command)
    const response = this.responses.shift()
    if (response instanceof Error) throw response
    return response ?? {}
  }
}

test('Dynamo audit store creates the first entry and head in one conditional transaction', async () => {
  const client = new CapturingClient([{}, {}])
  const store = new DynamoAuditStore({ client, tableName: 'chimera-audit', now: () => 1_788_000_000_000 })

  assert.deepEqual(await store.head('pilot'), { nextSeq: 0, headHash: GENESIS_HASH })
  const entry = makeEntry({ kind: 'pilot.started' })
  await store.appendIfHead('pilot', entry, { nextSeq: 0, headHash: GENESIS_HASH }, { requestId: 'req-first' })

  assert.equal(client.commands[0].constructor.name, 'GetItemCommand')
  const transaction = client.commands[1]
  assert.equal(transaction.constructor.name, 'TransactWriteItemsCommand')
  assert.equal(transaction.input.TransactItems.length, 3)
  assert.match(transaction.input.TransactItems[0].Put.ConditionExpression, /attribute_not_exists/)
  assert.match(transaction.input.TransactItems[1].Put.ConditionExpression, /attribute_not_exists/)
  assert.match(transaction.input.TransactItems[2].Put.ConditionExpression, /attribute_not_exists/)
  assert.equal(transaction.input.TransactItems[0].Put.Item.factJson.S, '{"kind":"pilot.started"}')
})

test('Dynamo audit store conditionally advances an existing head', async () => {
  const client = new CapturingClient([{}])
  const store = new DynamoAuditStore({ client, tableName: 'chimera-audit' })
  const entry = makeEntry({ kind: 'pilot.progress' }, 3, 'b'.repeat(64))
  await store.appendIfHead('pilot', entry, { nextSeq: 3, headHash: 'b'.repeat(64) }, { requestId: 'req-next' })

  const update = client.commands[0].input.TransactItems[1].Update
  assert.match(update.ConditionExpression, /nextSeq = :expectedSeq/)
  assert.match(update.ConditionExpression, /headHash = :expectedHash/)
  assert.equal(update.ExpressionAttributeValues[':expectedSeq'].N, '3')
  assert.equal(update.ExpressionAttributeValues[':expectedHash'].S, 'b'.repeat(64))
})

test('Dynamo audit store reads and decodes ordered entry pages', async () => {
  const client = new CapturingClient([
    {
      Items: [{
        streamId: { S: 'pilot' },
        recordId: { S: 'ENTRY#00000000000000000000' },
        seq: { N: '0' },
        prevHash: { S: GENESIS_HASH },
        factJson: { S: '{"kind":"pilot.started"}' },
        entryHash: { S: makeEntry({ kind: 'pilot.started' }).entryHash },
      }],
      LastEvaluatedKey: { streamId: { S: 'pilot' }, recordId: { S: 'ENTRY#00000000000000000000' } },
    },
    { Items: [] },
  ])
  const store = new DynamoAuditStore({ client, tableName: 'chimera-audit' })

  assert.deepEqual(await store.entries('pilot'), [{
    seq: 0,
    prevHash: GENESIS_HASH,
    fact: { kind: 'pilot.started' },
    entryHash: makeEntry({ kind: 'pilot.started' }).entryHash,
  }])
  assert.equal(client.commands.length, 2)
  assert.deepEqual(client.commands[1].input.ExclusiveStartKey, {
    streamId: { S: 'pilot' }, recordId: { S: 'ENTRY#00000000000000000000' },
  })
})

test('Dynamo audit store maps conditional transaction cancellation to an append conflict', async () => {
  const failure = new Error('cancelled')
  failure.name = 'TransactionCanceledException'
  const store = new DynamoAuditStore({ client: new CapturingClient([failure]), tableName: 'chimera-audit' })

  await assert.rejects(
    store.appendIfHead('pilot', makeEntry({ kind: 'pilot.started' }), { nextSeq: 0, headHash: GENESIS_HASH }, { requestId: 'req-conflict' }),
    (error) => error.code === 'AUDIT_APPEND_CONFLICT',
  )
})

test('Dynamo audit store rejects a fact that does not match its claimed entry hash', async () => {
  const client = new CapturingClient()
  const store = new DynamoAuditStore({ client, tableName: 'chimera-audit' })
  const entry = makeEntry({ kind: 'pilot.started' })
  entry.fact.kind = 'pilot.tampered'

  await assert.rejects(
    store.appendIfHead('pilot', entry, { nextSeq: 0, headHash: GENESIS_HASH }, { requestId: 'req-tamper' }),
    /hash/i,
  )
  assert.equal(client.commands.length, 0)
})

test('Dynamo audit store reads a durable request receipt for restart reconciliation', async () => {
  const entry = makeEntry({ kind: 'pilot.started' })
  const client = new CapturingClient([{
    Item: {
      streamId: { S: 'pilot' },
      recordId: { S: 'REQUEST#req-first' },
      requestId: { S: 'req-first' },
      seq: { N: '0' },
      prevHash: { S: entry.prevHash },
      factJson: { S: '{"kind":"pilot.started"}' },
      entryHash: { S: entry.entryHash },
    },
  }])
  const store = new DynamoAuditStore({ client, tableName: 'chimera-audit' })

  assert.deepEqual(await store.receipt('pilot', 'req-first'), entry)
  assert.equal(client.commands[0].input.Key.recordId.S, 'REQUEST#req-first')
})
