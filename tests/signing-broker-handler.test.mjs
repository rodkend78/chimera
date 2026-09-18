import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSecretKey, getPublicKey } from 'nostr-tools'
import { createSigningBroker } from '../src/aws/signing-broker-handler.mjs'
import { canonicalJson, sha256 } from '../src/canonical.mjs'
import { exportPublicKey, generateIdentity, signPayload } from '../src/identity.mjs'
import { verifyNostrEvent } from '../src/nostr-signing.mjs'

function hex(bytes) {
  return Buffer.from(bytes).toString('hex')
}

function requestFor({ candidate, human, receiptId = 'receipt-sign-001' }) {
  const payload = {
    operation: 'nostr.sign',
    candidateHash: sha256(candidate),
    receiptId,
    issuedAt: '2026-09-02T04:19:59.000Z',
    expiresAt: '2026-09-02T04:21:00.000Z',
  }
  return {
    candidate,
    authorization: {
      humanKeyId: human.keyId,
      payload,
      signature: signPayload(payload, human.privateKey),
    },
  }
}

test('signing broker requires an exact human receipt and returns only a valid public Nostr event', async () => {
  const human = generateIdentity('rod')
  const secretKey = generateSecretKey()
  const publicKey = getPublicKey(secretKey)
  const claims = []
  const broker = createSigningBroker({
    authorizerKeyId: human.keyId,
    authorizerPublicKey: exportPublicKey(human.publicKey),
    expectedNostrPublicKey: publicKey,
    now: () => new Date('2026-09-02T04:20:00.000Z'),
    getSecretValue: async () => ({
      SecretString: canonicalJson({
        schema: 'chimera.nostr-custody.v1',
        publicKey,
        secretKeyHex: hex(secretKey),
      }),
    }),
    claimReceipt: async (claim) => { claims.push(claim) },
  })
  const candidate = {
    kind: 1,
    created_at: 1_788_321_600,
    tags: [['t', 'chimera']],
    content: 'Signed by the isolated broker',
  }

  const result = await broker(requestFor({ candidate, human }))

  assert.equal(result.keyId, `nostr:${publicKey.slice(0, 16)}`)
  assert.equal(result.receiptId, 'receipt-sign-001')
  assert.equal(result.event.pubkey, publicKey)
  assert.equal(verifyNostrEvent(result.event), true)
  assert.deepEqual(claims, [{
    authorizerKeyId: human.keyId,
    candidateHash: sha256(candidate),
    expiresAtEpoch: 1_788_322_860,
    receiptId: 'receipt-sign-001',
  }])
  assert.equal(JSON.stringify(result).includes(hex(secretKey)), false)
  assert.equal('secretKey' in result, false)
})

test('signing broker rejects tampered, expired, and replayed authorization before key retrieval', async () => {
  const human = generateIdentity('rod')
  const secretKey = generateSecretKey()
  const publicKey = getPublicKey(secretKey)
  let secretReads = 0
  const broker = createSigningBroker({
    authorizerKeyId: human.keyId,
    authorizerPublicKey: exportPublicKey(human.publicKey),
    expectedNostrPublicKey: publicKey,
    now: () => new Date('2026-09-02T04:20:00.000Z'),
    getSecretValue: async () => { secretReads += 1 },
    claimReceipt: async () => {
      throw Object.assign(new Error('SIGNING_RECEIPT_REPLAYED'), { code: 'SIGNING_RECEIPT_REPLAYED' })
    },
  })
  const candidate = { kind: 1, created_at: 1_788_321_600, tags: [], content: 'original' }

  await assert.rejects(
    () => broker({ ...requestFor({ candidate, human }), candidate: { ...candidate, content: 'tampered' } }),
    /SIGNING_AUTHORIZATION_INVALID/,
  )
  await assert.rejects(() => broker(requestFor({ candidate, human })), /SIGNING_RECEIPT_REPLAYED/)
  assert.equal(secretReads, 0)
})
