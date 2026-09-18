import { randomUUID } from 'node:crypto'
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda'
import { sha256 } from '../../src/canonical.mjs'
import { signPayload } from '../../src/identity.mjs'
import { DurableIdentityStore } from '../../src/identity-store.mjs'
import { verifyNostrEvent } from '../../src/nostr-signing.mjs'

const [functionName, identityFile, humanId = 'rod', region = 'us-west-2'] = process.argv.slice(2)
if (![functionName, identityFile, humanId, region].every((value) => typeof value === 'string' && value.length > 0)) {
  throw new TypeError('usage: verify-signing-broker.mjs <function> <identity-file> [human-id] [region]')
}

const identities = await DurableIdentityStore.open({ filePath: identityFile })
const human = identities.getOrCreate(humanId)
const now = Date.now()
const candidate = {
  kind: 1,
  created_at: Math.floor(now / 1000),
  tags: [['t', 'chimera'], ['gate', '2']],
  content: 'Gate 2 isolated signing broker acceptance',
}
const payload = {
  operation: 'nostr.sign',
  candidateHash: sha256(candidate),
  receiptId: `live-sign-${randomUUID()}`,
  issuedAt: new Date(now - 1_000).toISOString(),
  expiresAt: new Date(now + 60_000).toISOString(),
}
const request = {
  candidate,
  authorization: {
    humanKeyId: human.keyId,
    payload,
    signature: signPayload(payload, human.privateKey),
  },
}
const client = new LambdaClient({ region })
const invoke = async (body) => {
  const response = await client.send(new InvokeCommand({
    FunctionName: functionName,
    InvocationType: 'RequestResponse',
    Payload: Buffer.from(JSON.stringify(body)),
  }))
  if (response.FunctionError) throw new Error('SIGNING_BROKER_FUNCTION_ERROR')
  return JSON.parse(Buffer.from(response.Payload ?? []).toString('utf8'))
}

try {
  const tampered = await invoke({ ...request, candidate: { ...candidate, content: 'tampered' } })
  if (tampered?.error?.code !== 'SIGNING_AUTHORIZATION_INVALID') throw new Error('SIGNING_TAMPER_CHECK_FAILED')
  const accepted = await invoke(request)
  if (!verifyNostrEvent(accepted?.event)
    || accepted.receiptId !== payload.receiptId
    || accepted.event.content !== candidate.content
    || JSON.stringify(accepted).includes('secretKey')) {
    throw new Error('SIGNING_ACCEPTANCE_INVALID')
  }
  const replayed = await invoke(request)
  if (replayed?.error?.code !== 'SIGNING_RECEIPT_REPLAYED') throw new Error('SIGNING_REPLAY_CHECK_FAILED')
  process.stdout.write(`${JSON.stringify({
    accepted: true,
    eventId: accepted.event.id,
    keyId: accepted.keyId,
    publicKey: accepted.event.pubkey,
    receiptId: payload.receiptId,
    tamperResult: tampered.error.code,
    replayResult: replayed.error.code,
  })}\n`)
} finally {
  client.destroy()
}
