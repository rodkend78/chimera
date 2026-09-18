import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb'
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import { finalizeEvent, getPublicKey } from 'nostr-tools'
import { sha256 } from '../canonical.mjs'
import { verifyPayload } from '../identity.mjs'
import { assertNostrEventCandidate } from '../nostr-signing.mjs'

const RECEIPT_ID = /^[A-Za-z0-9._:-]{8,128}$/
const HEX_KEY = /^[a-f0-9]{64}$/
const MAX_AUTHORIZATION_WINDOW_MS = 5 * 60_000
const CLOCK_SKEW_MS = 30_000

function bounded(value, maximum = 4096) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function fail(code) {
  return Object.assign(new Error(code), { code })
}

function publicCode(error) {
  const code = typeof error?.code === 'string' ? error.code : error instanceof Error ? error.message : ''
  return /^[A-Z][A-Z0-9_]{2,127}$/.test(code) ? code : 'SIGNING_BROKER_FAILED'
}

function validateAuthorization({ authorization, candidate, authorizerKeyId, authorizerPublicKey, now }) {
  const payload = authorization?.payload
  if (!authorization || typeof authorization !== 'object'
    || authorization.humanKeyId !== authorizerKeyId
    || !bounded(authorization.signature)
    || !payload || typeof payload !== 'object'
    || payload.operation !== 'nostr.sign'
    || !RECEIPT_ID.test(payload.receiptId ?? '')
    || payload.candidateHash !== sha256(candidate)
    || !bounded(payload.issuedAt, 64)
    || !bounded(payload.expiresAt, 64)
    || !verifyPayload(payload, authorization.signature, authorizerPublicKey)) {
    throw fail('SIGNING_AUTHORIZATION_INVALID')
  }
  const issuedAt = Date.parse(payload.issuedAt)
  const expiresAt = Date.parse(payload.expiresAt)
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)
    || issuedAt > now + CLOCK_SKEW_MS
    || issuedAt < now - MAX_AUTHORIZATION_WINDOW_MS
    || expiresAt <= now
    || expiresAt <= issuedAt
    || expiresAt - issuedAt > MAX_AUTHORIZATION_WINDOW_MS) {
    throw fail('SIGNING_AUTHORIZATION_EXPIRED')
  }
  return {
    authorizerKeyId,
    candidateHash: payload.candidateHash,
    expiresAtEpoch: Math.floor(expiresAt / 1000),
    receiptId: payload.receiptId,
  }
}

function decodeCustody(response, expectedNostrPublicKey) {
  let custody
  try {
    custody = JSON.parse(response?.SecretString)
  } catch {
    throw fail('SIGNING_CUSTODY_INVALID')
  }
  if (custody?.schema !== 'chimera.nostr-custody.v1'
    || custody.publicKey !== expectedNostrPublicKey
    || !HEX_KEY.test(custody.secretKeyHex ?? '')) {
    throw fail('SIGNING_CUSTODY_INVALID')
  }
  const secretKey = Uint8Array.from(Buffer.from(custody.secretKeyHex, 'hex'))
  if (getPublicKey(secretKey) !== expectedNostrPublicKey) throw fail('SIGNING_CUSTODY_INVALID')
  return secretKey
}

export function createSigningBroker({
  authorizerKeyId,
  authorizerPublicKey,
  expectedNostrPublicKey,
  getSecretValue,
  claimReceipt,
  now = () => new Date(),
} = {}) {
  if (!bounded(authorizerKeyId, 256)
    || !bounded(authorizerPublicKey)
    || !HEX_KEY.test(expectedNostrPublicKey ?? '')
    || typeof getSecretValue !== 'function'
    || typeof claimReceipt !== 'function'
    || typeof now !== 'function') {
    throw new TypeError('SIGNING_BROKER_CONFIG_INVALID')
  }
  return async ({ candidate: inputCandidate, authorization } = {}) => {
    let candidate
    try {
      candidate = assertNostrEventCandidate(inputCandidate)
    } catch {
      throw fail('SIGNING_CANDIDATE_INVALID')
    }
    const instant = now()
    const nowMs = instant instanceof Date ? instant.getTime() : new Date(instant).getTime()
    if (!Number.isFinite(nowMs)) throw fail('SIGNING_BROKER_TIME_INVALID')
    const claim = validateAuthorization({
      authorization,
      candidate,
      authorizerKeyId,
      authorizerPublicKey,
      now: nowMs,
    })
    await claimReceipt(claim)
    const secretKey = decodeCustody(await getSecretValue(), expectedNostrPublicKey)
    try {
      const event = finalizeEvent(candidate, secretKey)
      return {
        event,
        keyId: `nostr:${expectedNostrPublicKey.slice(0, 16)}`,
        receiptId: claim.receiptId,
      }
    } finally {
      secretKey.fill(0)
    }
  }
}

let productionBroker

export async function handler(event) {
  try {
    if (!productionBroker) {
      const authorizerKeyId = process.env.CHIMERA_SIGNING_AUTHORIZER_KEY_ID
      const encodedPublicKey = process.env.CHIMERA_SIGNING_AUTHORIZER_PUBLIC_KEY_BASE64
      const expectedNostrPublicKey = process.env.CHIMERA_NOSTR_PUBLIC_KEY
      const receiptTable = process.env.CHIMERA_SIGNING_RECEIPT_TABLE
      const secretId = process.env.CHIMERA_NOSTR_SECRET_ID
      if (![authorizerKeyId, encodedPublicKey, expectedNostrPublicKey, receiptTable, secretId]
        .every((value) => bounded(value))) {
        throw new TypeError('SIGNING_BROKER_CONFIG_INVALID')
      }
      const authorizerPublicKey = Buffer.from(encodedPublicKey, 'base64').toString('utf8')
      if (!authorizerPublicKey.includes('BEGIN PUBLIC KEY')) throw new TypeError('SIGNING_BROKER_CONFIG_INVALID')
      const region = process.env.AWS_REGION ?? 'us-west-2'
      const dynamo = new DynamoDBClient({ region })
      const secrets = new SecretsManagerClient({ region })
      productionBroker = createSigningBroker({
        authorizerKeyId,
        authorizerPublicKey,
        expectedNostrPublicKey,
        getSecretValue: () => secrets.send(new GetSecretValueCommand({ SecretId: secretId })),
        claimReceipt: async (claim) => {
          try {
            await dynamo.send(new PutItemCommand({
              TableName: receiptTable,
              Item: {
                receiptId: { S: claim.receiptId },
                authorizerKeyId: { S: claim.authorizerKeyId },
                candidateHash: { S: claim.candidateHash },
                expiresAtEpoch: { N: String(claim.expiresAtEpoch) },
              },
              ConditionExpression: 'attribute_not_exists(receiptId)',
            }))
          } catch (error) {
            if (error?.name === 'ConditionalCheckFailedException') throw fail('SIGNING_RECEIPT_REPLAYED')
            throw error
          }
        },
      })
    }
    return await productionBroker(event)
  } catch (error) {
    const code = publicCode(error)
    console.error(JSON.stringify({
      event: 'chimera.signing-broker.failure',
      code,
      errorName: bounded(error?.name, 128) ? error.name : 'Error',
    }))
    return { error: { code } }
  }
}
