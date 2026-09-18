import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  validateEvent,
  verifyEvent,
} from 'nostr-tools'

export function assertNostrEventCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new TypeError('Nostr event candidate must be a record')
  }
  if (!Number.isSafeInteger(candidate.kind) || candidate.kind < 0) {
    throw new TypeError('Nostr event kind must be a non-negative integer')
  }
  if (!Number.isSafeInteger(candidate.created_at) || candidate.created_at < 0) {
    throw new TypeError('Nostr event created_at must be a non-negative integer')
  }
  if (typeof candidate.content !== 'string' || Buffer.byteLength(candidate.content, 'utf8') > 128 * 1024) {
    throw new TypeError('Nostr event content must be a string')
  }
  if (!Array.isArray(candidate.tags)
    || candidate.tags.length > 128
    || candidate.tags.some((tag) => !Array.isArray(tag)
      || tag.length === 0
      || tag.length > 32
      || tag.some((member) => typeof member !== 'string' || member.length > 2048))) {
    throw new TypeError('Nostr event tags are invalid')
  }

  return {
    kind: candidate.kind,
    created_at: candidate.created_at,
    tags: candidate.tags.map((tag) => [...tag]),
    content: candidate.content,
  }
}

export function verifyNostrEvent(event) {
  try {
    // nostr-tools marks verified objects with a cached symbol. Reconstructing
    // the record strips cached state from untrusted or shallow-cloned input and
    // forces the event hash and Schnorr signature to be checked again.
    const untrustedEvent = {
      kind: event.kind,
      created_at: event.created_at,
      tags: event.tags.map((tag) => [...tag]),
      content: event.content,
      pubkey: event.pubkey,
      id: event.id,
      sig: event.sig,
    }
    return validateEvent(untrustedEvent) && verifyEvent(untrustedEvent)
  } catch {
    return false
  }
}

// This in-memory provider is for local conformance tests and development only.
// Production uses the ADR-002 signing broker so agent processes never hold nsec.
export function createInMemoryNostrSigningProvider({ id, secretKey = generateSecretKey() }) {
  if (typeof id !== 'string' || id.length === 0 || id.length > 256) {
    throw new TypeError('Nostr signer id is required')
  }
  if (!(secretKey instanceof Uint8Array) || secretKey.length !== 32) {
    throw new TypeError('Nostr secret key must be 32 bytes')
  }

  const keyMaterial = Uint8Array.from(secretKey)
  const publicKey = getPublicKey(keyMaterial)
  const keyId = `nostr:${publicKey.slice(0, 16)}`

  return Object.freeze({
    algorithm: 'nostr-bip340',
    keyId,
    publicIdentity() {
      return Object.freeze({
        algorithm: 'nostr-bip340',
        id,
        keyId,
        publicKey,
      })
    },
    signEvent(candidate) {
      return Object.freeze(finalizeEvent(assertNostrEventCandidate(candidate), keyMaterial))
    },
    verifyEvent(event) {
      return verifyNostrEvent(event) && event.pubkey === publicKey
    },
  })
}
