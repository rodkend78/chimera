import { randomUUID } from 'node:crypto'
import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager'
import { generateSecretKey, getPublicKey } from 'nostr-tools'
import { canonicalJson } from '../../src/canonical.mjs'

const [secretId, region = 'us-west-2'] = process.argv.slice(2)
if (typeof secretId !== 'string' || secretId.length === 0 || secretId.length > 2048
  || typeof region !== 'string' || region.length === 0 || region.length > 64) {
  throw new TypeError('usage: initialize-nostr-custody.mjs <secret-id> [region]')
}

const client = new SecretsManagerClient({ region })
let existing
try {
  existing = await client.send(new GetSecretValueCommand({ SecretId: secretId }))
} catch (error) {
  if (error?.name !== 'ResourceNotFoundException') throw error
}

if (existing?.SecretString) {
  const custody = JSON.parse(existing.SecretString)
  if (custody?.schema !== 'chimera.nostr-custody.v1'
    || !/^[a-f0-9]{64}$/.test(custody.publicKey ?? '')
    || !/^[a-f0-9]{64}$/.test(custody.secretKeyHex ?? '')
    || getPublicKey(Uint8Array.from(Buffer.from(custody.secretKeyHex, 'hex'))) !== custody.publicKey) {
    throw new Error('SIGNING_CUSTODY_INVALID')
  }
  process.stdout.write(`${JSON.stringify({ initialized: false, publicKey: custody.publicKey, versionId: existing.VersionId })}\n`)
  client.destroy()
  process.exit(0)
}

const secretKey = generateSecretKey()
try {
  const publicKey = getPublicKey(secretKey)
  const response = await client.send(new PutSecretValueCommand({
    ClientRequestToken: randomUUID(),
    SecretId: secretId,
    SecretString: canonicalJson({
      schema: 'chimera.nostr-custody.v1',
      publicKey,
      secretKeyHex: Buffer.from(secretKey).toString('hex'),
    }),
    VersionStages: ['AWSCURRENT'],
  }))
  process.stdout.write(`${JSON.stringify({ initialized: true, publicKey, versionId: response.VersionId })}\n`)
} finally {
  secretKey.fill(0)
  client.destroy()
}
