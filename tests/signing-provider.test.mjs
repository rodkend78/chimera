import assert from 'node:assert/strict'
import test from 'node:test'
import { generateIdentity } from '../src/identity.mjs'
import {
  createInMemoryNostrSigningProvider,
  verifyNostrEvent,
} from '../src/nostr-signing.mjs'
import {
  createEd25519SigningProvider,
  validateSigningProvider,
} from '../src/signing-provider.mjs'

test('Ed25519 identities satisfy the signing-provider contract', () => {
  const provider = createEd25519SigningProvider(generateIdentity('ceo'))
  const payload = { actionId: 'action-1', capability: 'task.delegate' }
  const signature = provider.sign(payload)

  assert.equal(provider.algorithm, 'ed25519')
  assert.equal(provider.verify(payload, signature), true)
  assert.equal(provider.verify({ ...payload, capability: 'credential.read' }, signature), false)
  assert.equal(provider.publicIdentity().keyId, provider.keyId)
})

test('invalid signing providers fail before use', () => {
  assert.throws(
    () => validateSigningProvider({ algorithm: 'unknown', keyId: 'key-1' }),
    /publicIdentity/,
  )
})

test('Nostr provider produces a valid NIP-01 event without exposing key material', () => {
  const provider = createInMemoryNostrSigningProvider({ id: 'ceo' })
  const event = provider.signEvent({
    kind: 1,
    created_at: 1_787_400_000,
    tags: [['t', 'chimera'], ['agent', 'ceo']],
    content: 'CEO status update',
  })

  assert.equal(provider.algorithm, 'nostr-bip340')
  assert.equal(provider.publicIdentity().publicKey, event.pubkey)
  assert.equal(provider.verifyEvent(event), true)
  assert.equal(verifyNostrEvent(event), true)
  assert.equal('secretKey' in provider, false)
  assert.equal('secretKey' in provider.publicIdentity(), false)
})

test('Nostr event verification detects tampering', () => {
  const provider = createInMemoryNostrSigningProvider({ id: 'ceo' })
  const event = provider.signEvent({
    kind: 1,
    created_at: 1_787_400_000,
    tags: [],
    content: 'Approved plan',
  })

  assert.equal(verifyNostrEvent({ ...event, content: 'Transfer authority' }), false)
})

test('Nostr verification ignores cached verification state on shallow clones', () => {
  const provider = createInMemoryNostrSigningProvider({ id: 'ceo' })
  const event = provider.signEvent({
    kind: 1,
    created_at: 1_787_400_000,
    tags: [],
    content: 'Original',
  })

  // finalizeEvent caches a verified symbol. Object spread copies that symbol,
  // so Chimera must reconstruct the event before invoking library verification.
  const shallowTamper = { ...event, content: 'Tampered' }
  assert.equal(verifyNostrEvent(shallowTamper), false)
})

test('Nostr candidates are schema checked before signing', () => {
  const provider = createInMemoryNostrSigningProvider({ id: 'ceo' })
  assert.throws(
    () => provider.signEvent({ kind: 1, created_at: 1.5, tags: [], content: 'bad time' }),
    /created_at/,
  )
  assert.throws(
    () => provider.signEvent({ kind: 1, created_at: 1, tags: [['ok', 2]], content: 'bad tag' }),
    /tags/,
  )
})
