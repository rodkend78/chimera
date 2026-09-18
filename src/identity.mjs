import {
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto'
import { canonicalJson, sha256 } from './canonical.mjs'

export function generateIdentity(id) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    id,
    publicKey,
    privateKey,
    keyId: `${id}:${fingerprint(publicKey).slice(0, 16)}`,
  }
}

function asPublicKey(key) {
  return key?.type === 'public' ? key : createPublicKey(key)
}

export function exportPublicKey(publicKey) {
  return asPublicKey(publicKey).export({ type: 'spki', format: 'pem' }).toString()
}

export function fingerprint(publicKey) {
  const der = asPublicKey(publicKey).export({ type: 'spki', format: 'der' })
  return sha256({ publicKey: der.toString('base64') })
}

export function signPayload(payload, privateKey) {
  return cryptoSign(null, Buffer.from(canonicalJson(payload)), privateKey).toString('base64')
}

export function verifyPayload(payload, signature, publicKey) {
  try {
    return cryptoVerify(
      null,
      Buffer.from(canonicalJson(payload)),
      asPublicKey(publicKey),
      Buffer.from(signature, 'base64'),
    )
  } catch {
    return false
  }
}

export function signGrant(payload, humanIdentity) {
  return {
    humanKeyId: humanIdentity.keyId,
    payload,
    signature: signPayload(payload, humanIdentity.privateKey),
  }
}

export function signAction(payload, agentIdentity) {
  return {
    agentPublicKey: exportPublicKey(agentIdentity.publicKey),
    payload,
    signature: signPayload(payload, agentIdentity.privateKey),
  }
}

export function signDecision(payload, humanIdentity) {
  return {
    humanKeyId: humanIdentity.keyId,
    payload,
    signature: signPayload(payload, humanIdentity.privateKey),
  }
}

export function signHumanAction(payload, humanIdentity) {
  return {
    humanKeyId: humanIdentity.keyId,
    payload,
    signature: signPayload(payload, humanIdentity.privateKey),
  }
}
