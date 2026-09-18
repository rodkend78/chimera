import {
  exportPublicKey,
  fingerprint,
  signPayload,
  verifyPayload,
} from './identity.mjs'

function requireMethod(provider, method) {
  if (typeof provider?.[method] !== 'function') {
    throw new TypeError(`signing provider requires ${method}()`)
  }
}

export function validateSigningProvider(provider) {
  if (!provider || typeof provider !== 'object') throw new TypeError('signing provider is required')
  if (typeof provider.algorithm !== 'string' || provider.algorithm.length === 0) {
    throw new TypeError('signing provider algorithm is required')
  }
  if (typeof provider.keyId !== 'string' || provider.keyId.length === 0) {
    throw new TypeError('signing provider keyId is required')
  }
  requireMethod(provider, 'publicIdentity')
  requireMethod(provider, 'sign')
  requireMethod(provider, 'verify')
  return provider
}

export function createEd25519SigningProvider(identity) {
  if (!identity?.privateKey || !identity?.publicKey || !identity?.keyId) {
    throw new TypeError('complete Ed25519 identity is required')
  }

  return validateSigningProvider(Object.freeze({
    algorithm: 'ed25519',
    keyId: identity.keyId,
    publicIdentity() {
      return Object.freeze({
        algorithm: 'ed25519',
        keyId: identity.keyId,
        publicKey: exportPublicKey(identity.publicKey),
        fingerprint: fingerprint(identity.publicKey),
      })
    },
    sign(payload) {
      return signPayload(payload, identity.privateKey)
    },
    verify(payload, signature) {
      return verifyPayload(payload, signature, identity.publicKey)
    },
  }))
}
