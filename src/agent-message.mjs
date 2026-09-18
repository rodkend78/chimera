import { canonicalJson, sha256 } from './canonical.mjs'
import { fingerprint, verifyPayload } from './identity.mjs'
import { verifyNostrEvent } from './nostr-signing.mjs'
import { grantCovers } from './policy.mjs'
import { validateSigningProvider } from './signing-provider.mjs'

export const AGENT_MESSAGE_SCHEMA = 'chimera.agent-message.v1'

export const AGENT_MESSAGE_TYPES = Object.freeze([
  'direct_message',
  'task_handoff',
  'progress_event',
  'structured_result',
])

const MESSAGE_TYPES = new Set(AGENT_MESSAGE_TYPES)
const NOSTR_MESSAGE_KIND = 28_001
const MAX_CONTENT_BYTES = 64 * 1024

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isBoundedString(value, maximum = 2048) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function assertWindow(payload) {
  if (!isBoundedString(payload.issuedAt, 64) || !isBoundedString(payload.expiresAt, 64)) {
    throw new TypeError('invalid message time window')
  }
  const issuedAt = Date.parse(payload.issuedAt)
  const expiresAt = Date.parse(payload.expiresAt)
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || issuedAt >= expiresAt) {
    throw new TypeError('invalid message time window')
  }
}

function isActiveWindow(payload, now) {
  const issuedAt = Date.parse(payload.issuedAt)
  const expiresAt = Date.parse(payload.expiresAt)
  return Number.isFinite(issuedAt)
    && Number.isFinite(expiresAt)
    && issuedAt <= now
    && now < expiresAt
}

function validateScopeSelector(selector) {
  if (!isRecord(selector) || !isBoundedString(selector.capability, 128)) {
    throw new TypeError('invalid grant scope')
  }
  const exact = typeof selector.resource === 'string'
  const prefix = typeof selector.resourcePrefix === 'string'
  if (exact === prefix) throw new TypeError('invalid grant scope')
  if ((exact ? selector.resource : selector.resourcePrefix).length > 2048) {
    throw new TypeError('invalid grant scope')
  }
}

function validateGrant(grant) {
  if (!isRecord(grant)
    || !isBoundedString(grant.humanKeyId, 256)
    || !isBoundedString(grant.signature, 512)
    || !isRecord(grant.payload)) {
    throw new TypeError('invalid grant envelope')
  }

  const payload = grant.payload
  for (const value of [payload.grantId, payload.humanId, payload.agentId, payload.agentKeyFingerprint]) {
    if (!isBoundedString(value, 256)) throw new TypeError('invalid grant identity')
  }
  if (!['auto', 'confirm'].includes(payload.maxTier)) throw new TypeError('invalid grant tier')
  if (!Array.isArray(payload.scopes) || payload.scopes.length === 0 || payload.scopes.length > 64) {
    throw new TypeError('invalid grant scopes')
  }
  payload.scopes.forEach(validateScopeSelector)
  assertWindow(payload)
  return grant
}

function assertRequest(request) {
  if (request === null) return null
  if (!isRecord(request)
    || !isBoundedString(request.capability, 128)
    || !isBoundedString(request.resource, 2048)
    || !isBoundedString(request.operation, 128)) {
    throw new TypeError('invalid requested action')
  }
  return {
    capability: request.capability,
    resource: request.resource,
    operation: request.operation,
  }
}

function assertContent(type, content) {
  if (!isRecord(content)) throw new TypeError('message content must be a record')

  if (type === 'direct_message' && !isBoundedString(content.text, 16_384)) {
    throw new TypeError('direct message text is required')
  }
  if (type === 'direct_message'
    && content.requestedSpecialistAgentId !== undefined
    && (!isBoundedString(content.requestedSpecialistAgentId, 64)
      || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(content.requestedSpecialistAgentId))) {
    throw new TypeError('direct message specialist target is invalid')
  }
  if (type === 'task_handoff') {
    if (!isBoundedString(content.objective, 16_384)
      || !Array.isArray(content.acceptanceCriteria)
      || content.acceptanceCriteria.length === 0
      || content.acceptanceCriteria.length > 64
      || content.acceptanceCriteria.some((item) => !isBoundedString(item, 4096))) {
      throw new TypeError('task handoff content is invalid')
    }
  }
  if (type === 'progress_event') {
    if (!['queued', 'in_progress', 'blocked', 'completed'].includes(content.status)
      || !isBoundedString(content.summary, 16_384)) {
      throw new TypeError('progress event content is invalid')
    }
  }
  if (type === 'structured_result') {
    if (!['succeeded', 'partial', 'failed'].includes(content.status)
      || !isBoundedString(content.summary, 16_384)
      || !Object.hasOwn(content, 'result')) {
      throw new TypeError('structured result content is invalid')
    }
  }

  const encoded = canonicalJson(content)
  if (Buffer.byteLength(encoded) > MAX_CONTENT_BYTES) {
    throw new TypeError('message content is too large')
  }
  return content
}

export function agentMessageKeyFingerprint(identity) {
  if (!isRecord(identity)
    || !isBoundedString(identity.algorithm, 64)
    || !isBoundedString(identity.keyId, 256)
    || !isBoundedString(identity.publicKey, 2048)) {
    throw new TypeError('invalid public identity')
  }

  if (identity.algorithm === 'ed25519') return fingerprint(identity.publicKey)
  if (identity.algorithm === 'nostr-bip340' && /^[0-9a-f]{64}$/.test(identity.publicKey)) {
    return sha256({ algorithm: identity.algorithm, publicKey: identity.publicKey })
  }
  throw new TypeError('unsupported message signing algorithm')
}

function publicSender(senderAgentId, publicIdentity) {
  const keyFingerprint = agentMessageKeyFingerprint(publicIdentity)
  return {
    agentId: senderAgentId,
    algorithm: publicIdentity.algorithm,
    keyId: publicIdentity.keyId,
    publicKey: publicIdentity.publicKey,
    keyFingerprint,
  }
}

function signableEnvelope(envelope) {
  return {
    schema: envelope.schema,
    sender: envelope.sender,
    payload: envelope.payload,
  }
}

function assertEnvelope(envelope) {
  if (!isRecord(envelope)
    || envelope.schema !== AGENT_MESSAGE_SCHEMA
    || !isRecord(envelope.sender)
    || !isRecord(envelope.payload)
    || !isRecord(envelope.proof)) {
    throw new TypeError('invalid message envelope')
  }

  const sender = envelope.sender
  if (!isBoundedString(sender.agentId, 256)
    || !isBoundedString(sender.algorithm, 64)
    || !isBoundedString(sender.keyId, 256)
    || !isBoundedString(sender.publicKey, 2048)
    || !isBoundedString(sender.keyFingerprint, 128)
    || agentMessageKeyFingerprint(sender) !== sender.keyFingerprint) {
    throw new TypeError('invalid message sender')
  }

  const payload = envelope.payload
  if (!isBoundedString(payload.messageId, 256)
    || !MESSAGE_TYPES.has(payload.type)
    || !isBoundedString(payload.recipientAgentId, 256)
    || !isBoundedString(payload.taskId, 256)
    || (payload.parentMessageId !== null && !isBoundedString(payload.parentMessageId, 256))) {
    throw new TypeError('invalid message payload')
  }
  assertWindow(payload)
  assertRequest(payload.request)
  assertContent(payload.type, payload.content)
  return envelope
}

function verifyEnvelopeProof(envelope) {
  const signable = signableEnvelope(envelope)
  if (envelope.sender.algorithm === 'ed25519') {
    return envelope.proof.type === 'detached'
      && isBoundedString(envelope.proof.signature, 512)
      && verifyPayload(signable, envelope.proof.signature, envelope.sender.publicKey)
  }

  if (envelope.sender.algorithm === 'nostr-bip340') {
    const event = envelope.proof.event
    return envelope.proof.type === 'nostr-event'
      && isRecord(event)
      && event.kind === NOSTR_MESSAGE_KIND
      && event.created_at === Math.floor(Date.parse(envelope.payload.issuedAt) / 1000)
      && event.pubkey === envelope.sender.publicKey
      && event.content === canonicalJson(signable)
      && event.tags.some((tag) => tag.length === 2 && tag[0] === 'message' && tag[1] === envelope.payload.messageId)
      && event.tags.some((tag) => tag.length === 2 && tag[0] === 'recipient' && tag[1] === envelope.payload.recipientAgentId)
      && verifyNostrEvent(event)
  }

  return false
}

function messageCapability(type) {
  return `agent.message.${type}`
}

function verifyGrant({ grant, humanKeys, agentId, keyFingerprint, now, role }) {
  const humanPublicKey = humanKeys.get(grant.humanKeyId)
  if (!humanPublicKey || !verifyPayload(grant.payload, grant.signature, humanPublicKey)) {
    return `${role}_GRANT_SIGNATURE_INVALID`
  }
  if (!isActiveWindow(grant.payload, now)) return `${role}_GRANT_EXPIRED_OR_NOT_ACTIVE`
  if (grant.payload.agentId !== agentId || grant.payload.agentKeyFingerprint !== keyFingerprint) {
    return `${role}_GRANT_AGENT_MISMATCH`
  }
  return null
}

function rejected(envelope, reason) {
  return {
    status: 'rejected',
    messageId: isBoundedString(envelope?.payload?.messageId, 256)
      ? envelope.payload.messageId
      : 'unknown',
    reason,
  }
}

export function createAgentMessageEnvelope({
  signingProvider,
  senderAgentId,
  recipientAgentId,
  messageId,
  type,
  taskId,
  parentMessageId = null,
  issuedAt,
  expiresAt,
  request = null,
  content,
}) {
  if (!isBoundedString(senderAgentId, 256)) throw new TypeError('sender agent id is required')

  const sender = publicSender(senderAgentId, signingProvider?.publicIdentity?.())
  const envelope = assertEnvelope({
    schema: AGENT_MESSAGE_SCHEMA,
    sender,
    payload: {
      messageId,
      type,
      recipientAgentId,
      taskId,
      parentMessageId,
      issuedAt,
      expiresAt,
      request: assertRequest(request),
      content,
    },
    proof: {},
  })
  const signable = signableEnvelope(envelope)

  if (sender.algorithm === 'ed25519') {
    const provider = validateSigningProvider(signingProvider)
    envelope.proof = {
      type: 'detached',
      signature: provider.sign(signable),
    }
    return envelope
  }

  if (sender.algorithm === 'nostr-bip340' && typeof signingProvider.signEvent === 'function') {
    envelope.proof = {
      type: 'nostr-event',
      event: signingProvider.signEvent({
        kind: NOSTR_MESSAGE_KIND,
        created_at: Math.floor(Date.parse(issuedAt) / 1000),
        tags: [
          ['t', 'chimera-agent-message'],
          ['message', messageId],
          ['recipient', recipientAgentId],
        ],
        content: canonicalJson(signable),
      }),
    }
    return envelope
  }

  throw new TypeError('unsupported message signing provider')
}

export function verifyAgentMessage({
  envelope,
  senderGrant,
  recipientGrant,
  recipient,
  humanKeys,
  now = () => Date.now(),
}) {
  try {
    assertEnvelope(envelope)
    validateGrant(senderGrant)
    validateGrant(recipientGrant)
    if (!isRecord(recipient) || !isBoundedString(recipient.agentId, 256)) {
      throw new TypeError('invalid recipient')
    }
  } catch {
    return rejected(envelope, 'MALFORMED_MESSAGE')
  }

  try {
    if (!verifyEnvelopeProof(envelope)) return rejected(envelope, 'SENDER_SIGNATURE_INVALID')
  } catch {
    return rejected(envelope, 'SENDER_SIGNATURE_INVALID')
  }
  if (envelope.payload.recipientAgentId !== recipient.agentId) {
    return rejected(envelope, 'RECIPIENT_MISMATCH')
  }

  let recipientKeyFingerprint
  try {
    recipientKeyFingerprint = agentMessageKeyFingerprint(recipient.publicIdentity)
  } catch {
    return rejected(envelope, 'RECIPIENT_IDENTITY_INVALID')
  }

  let enrolledHumanKeys
  try {
    enrolledHumanKeys = new Map(humanKeys)
  } catch {
    return rejected(envelope, 'HUMAN_KEY_REGISTRY_INVALID')
  }
  const checkedAt = now()
  const senderGrantError = verifyGrant({
    grant: senderGrant,
    humanKeys: enrolledHumanKeys,
    agentId: envelope.sender.agentId,
    keyFingerprint: envelope.sender.keyFingerprint,
    now: checkedAt,
    role: 'SENDER',
  })
  if (senderGrantError) return rejected(envelope, senderGrantError)

  const recipientGrantError = verifyGrant({
    grant: recipientGrant,
    humanKeys: enrolledHumanKeys,
    agentId: recipient.agentId,
    keyFingerprint: recipientKeyFingerprint,
    now: checkedAt,
    role: 'RECIPIENT',
  })
  if (recipientGrantError) return rejected(envelope, recipientGrantError)
  if ([senderGrant, recipientGrant].some(grant => grant.payload.taskId !== undefined && grant.payload.taskId !== envelope.payload.taskId)) {
    return rejected(envelope, 'MESSAGE_TASK_OUTSIDE_GRANT_SCOPE')
  }

  if (senderGrant.humanKeyId !== recipientGrant.humanKeyId
    || senderGrant.payload.humanId !== recipientGrant.payload.humanId) {
    return rejected(envelope, 'SENDER_OUTSIDE_RECIPIENT_GRANT_CHAIN')
  }

  if (!isActiveWindow(envelope.payload, checkedAt)) {
    return rejected(envelope, 'MESSAGE_EXPIRED_OR_NOT_ACTIVE')
  }
  if (Date.parse(envelope.payload.issuedAt) < Date.parse(senderGrant.payload.issuedAt)
    || Date.parse(envelope.payload.expiresAt) > Date.parse(senderGrant.payload.expiresAt)) {
    return rejected(envelope, 'MESSAGE_OUTSIDE_SENDER_GRANT_WINDOW')
  }
  if (Date.parse(envelope.payload.issuedAt) < Date.parse(recipientGrant.payload.issuedAt)
    || Date.parse(envelope.payload.expiresAt) > Date.parse(recipientGrant.payload.expiresAt)) {
    return rejected(envelope, 'MESSAGE_OUTSIDE_RECIPIENT_GRANT_WINDOW')
  }

  const sendCoverage = grantCovers(senderGrant.payload, {
    agentId: envelope.sender.agentId,
    capability: messageCapability(envelope.payload.type),
    resource: `agent:${recipient.agentId}`,
    taskId: envelope.payload.taskId,
  }, 'auto')
  if (!sendCoverage.covered) return rejected(envelope, 'SENDER_MESSAGE_OUTSIDE_GRANT_SCOPE')

  if (envelope.payload.request !== null) {
    const requestCoverage = grantCovers(recipientGrant.payload, {
      agentId: recipient.agentId,
      ...envelope.payload.request,
    }, 'auto')
    if (!requestCoverage.covered) return rejected(envelope, 'RECIPIENT_SCOPE_DENIED')
  }

  return {
    status: 'accepted',
    messageId: envelope.payload.messageId,
    type: envelope.payload.type,
    taskId: envelope.payload.taskId,
    attribution: {
      senderAgentId: envelope.sender.agentId,
      senderKeyId: envelope.sender.keyId,
      senderKeyFingerprint: envelope.sender.keyFingerprint,
      senderGrantId: senderGrant.payload.grantId,
      humanKeyId: senderGrant.humanKeyId,
    },
    authority: {
      source: 'recipient-delegation-grant',
      recipientAgentId: recipient.agentId,
      grantId: recipientGrant.payload.grantId,
      humanKeyId: recipientGrant.humanKeyId,
    },
    requestedAction: envelope.payload.request,
  }
}
