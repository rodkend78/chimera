import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AGENT_MESSAGE_SCHEMA,
  createAgentMessageEnvelope,
  verifyAgentMessage,
} from '../src/agent-message.mjs'
import {
  exportPublicKey,
  generateIdentity,
  signGrant,
} from '../src/identity.mjs'
import { createInMemoryNostrSigningProvider } from '../src/nostr-signing.mjs'
import { createEd25519SigningProvider } from '../src/signing-provider.mjs'

const now = Date.parse('2026-08-22T07:00:00.000Z')
const grantWindow = {
  issuedAt: '2026-08-22T06:50:00.000Z',
  expiresAt: '2026-08-22T07:20:00.000Z',
}
const messageWindow = {
  issuedAt: '2026-08-22T06:55:00.000Z',
  expiresAt: '2026-08-22T07:15:00.000Z',
}

function signAgentGrant({ human, agentId, keyFingerprint, scopes, window = grantWindow }) {
  return signGrant({
    grantId: `grant-${agentId}-${crypto.randomUUID()}`,
    humanId: human.id,
    agentId,
    agentKeyFingerprint: keyFingerprint,
    maxTier: 'confirm',
    scopes,
    ...window,
  }, human)
}

function fixture({ human = generateIdentity('rod'), type = 'task_handoff', request } = {}) {
  const senderIdentity = generateIdentity('ceo')
  const recipientIdentity = generateIdentity('researcher')
  const senderProvider = createEd25519SigningProvider(senderIdentity)
  const recipientProvider = createEd25519SigningProvider(recipientIdentity)
  const envelope = createAgentMessageEnvelope({
    signingProvider: senderProvider,
    senderAgentId: 'ceo',
    recipientAgentId: 'researcher',
    messageId: `message-${crypto.randomUUID()}`,
    type,
    taskId: 'task-42',
    ...messageWindow,
    request: request ?? {
      capability: 'filesystem.read',
      resource: 'workspace/research.md',
      operation: 'read',
    },
    content: type === 'task_handoff'
      ? {
          objective: 'Read the source and return evidence.',
          acceptanceCriteria: ['Cite the source path.'],
        }
      : { text: 'Please review task 42.' },
  })
  const senderGrant = signAgentGrant({
    human,
    agentId: 'ceo',
    keyFingerprint: envelope.sender.keyFingerprint,
    scopes: [{ capability: `agent.message.${type}`, resource: 'agent:researcher' }],
  })
  const recipientGrant = signAgentGrant({
    human,
    agentId: 'researcher',
    keyFingerprint: recipientProvider.publicIdentity().fingerprint,
    scopes: [{ capability: 'filesystem.read', resourcePrefix: 'workspace/' }],
  })
  const humanKeys = [[human.keyId, exportPublicKey(human.publicKey)]]
  const recipient = {
    agentId: 'researcher',
    publicIdentity: recipientProvider.publicIdentity(),
  }
  return {
    human,
    humanKeys,
    envelope,
    recipient,
    recipientGrant,
    recipientProvider,
    senderGrant,
    senderProvider,
  }
}

function verify(f, overrides = {}) {
  return verifyAgentMessage({
    envelope: f.envelope,
    senderGrant: f.senderGrant,
    recipientGrant: f.recipientGrant,
    recipient: f.recipient,
    humanKeys: f.humanKeys,
    now: () => now,
    ...overrides,
  })
}

test('all four agent message forms use the signed envelope schema', () => {
  const sender = createEd25519SigningProvider(generateIdentity('ceo'))
  const cases = [
    ['direct_message', { text: 'Can you check this?' }],
    ['task_handoff', {
      objective: 'Check the source.',
      acceptanceCriteria: ['Return one citation.'],
    }],
    ['progress_event', { status: 'in_progress', summary: 'Source review started.' }],
    ['structured_result', {
      status: 'succeeded',
      summary: 'Source review finished.',
      result: { citations: ['workspace/source.md'] },
    }],
  ]

  for (const [type, content] of cases) {
    const envelope = createAgentMessageEnvelope({
      signingProvider: sender,
      senderAgentId: 'ceo',
      recipientAgentId: 'researcher',
      messageId: `message-${type}`,
      type,
      taskId: 'task-42',
      ...messageWindow,
      content,
    })
    assert.equal(envelope.schema, AGENT_MESSAGE_SCHEMA)
    assert.equal(envelope.payload.type, type)
    assert.equal(envelope.proof.type, 'detached')
  }
})

test('Nostr provider signs the same message envelope as a verified NIP-01 event', () => {
  const human = generateIdentity('rod')
  const senderProvider = createInMemoryNostrSigningProvider({ id: 'ceo' })
  const recipientProvider = createEd25519SigningProvider(generateIdentity('researcher'))
  const envelope = createAgentMessageEnvelope({
    signingProvider: senderProvider,
    senderAgentId: 'ceo',
    recipientAgentId: 'researcher',
    messageId: 'nostr-message-1',
    type: 'direct_message',
    taskId: 'task-42',
    ...messageWindow,
    content: { text: 'Signed over the Nostr provider boundary.' },
  })
  const senderGrant = signAgentGrant({
    human,
    agentId: 'ceo',
    keyFingerprint: envelope.sender.keyFingerprint,
    scopes: [{ capability: 'agent.message.direct_message', resource: 'agent:researcher' }],
  })
  const recipientGrant = signAgentGrant({
    human,
    agentId: 'researcher',
    keyFingerprint: recipientProvider.publicIdentity().fingerprint,
    scopes: [{ capability: 'filesystem.read', resourcePrefix: 'workspace/' }],
  })

  const result = verifyAgentMessage({
    envelope,
    senderGrant,
    recipientGrant,
    recipient: {
      agentId: 'researcher',
      publicIdentity: recipientProvider.publicIdentity(),
    },
    humanKeys: [[human.keyId, exportPublicKey(human.publicKey)]],
    now: () => now,
  })
  assert.equal(envelope.proof.type, 'nostr-event')
  assert.equal(result.status, 'accepted')
})

test('forged peer message content fails sender signature verification', () => {
  const f = fixture()
  const forged = structuredClone(f.envelope)
  forged.payload.request = {
    capability: 'credential.read',
    resource: 'aws:production',
    operation: 'read',
  }
  forged.payload.content.authority = { grantId: f.recipientGrant.payload.grantId }

  const result = verify(f, { envelope: forged })
  assert.equal(result.status, 'rejected')
  assert.equal(result.reason, 'SENDER_SIGNATURE_INVALID')
  assert.equal('authority' in result, false)
})

test('poisoned signed message cannot confer authority outside the recipient grant', () => {
  const f = fixture({
    request: {
      capability: 'credential.read',
      resource: 'aws:production',
      operation: 'read',
    },
  })
  f.envelope.payload.content.authority = {
    source: 'peer-message',
    scopes: [{ capability: 'credential.read', resourcePrefix: '' }],
  }
  f.envelope = createAgentMessageEnvelope({
    signingProvider: f.senderProvider,
    senderAgentId: 'ceo',
    recipientAgentId: 'researcher',
    messageId: f.envelope.payload.messageId,
    type: 'task_handoff',
    taskId: 'task-42',
    ...messageWindow,
    request: f.envelope.payload.request,
    content: f.envelope.payload.content,
  })

  const result = verify(f)
  assert.equal(result.status, 'rejected')
  assert.equal(result.reason, 'RECIPIENT_SCOPE_DENIED')
  assert.equal('authority' in result, false)
})

test('message from an agent outside the recipient human grant chain is rejected', () => {
  const f = fixture()
  const otherHuman = generateIdentity('mallory')
  const outsideGrant = signAgentGrant({
    human: otherHuman,
    agentId: 'ceo',
    keyFingerprint: f.envelope.sender.keyFingerprint,
    scopes: [{ capability: 'agent.message.task_handoff', resource: 'agent:researcher' }],
  })

  const result = verify(f, {
    senderGrant: outsideGrant,
    humanKeys: [
      ...f.humanKeys,
      [otherHuman.keyId, exportPublicKey(otherHuman.publicKey)],
    ],
  })
  assert.equal(result.status, 'rejected')
  assert.equal(result.reason, 'SENDER_OUTSIDE_RECIPIENT_GRANT_CHAIN')
})

test('expired sender and recipient grants are rejected', async (t) => {
  const expiredWindow = {
    issuedAt: '2026-08-22T05:00:00.000Z',
    expiresAt: '2026-08-22T06:00:00.000Z',
  }

  await t.test('sender grant', () => {
    const f = fixture()
    const expired = signAgentGrant({
      human: f.human,
      agentId: 'ceo',
      keyFingerprint: f.envelope.sender.keyFingerprint,
      scopes: [{ capability: 'agent.message.task_handoff', resource: 'agent:researcher' }],
      window: expiredWindow,
    })
    const result = verify(f, { senderGrant: expired })
    assert.equal(result.reason, 'SENDER_GRANT_EXPIRED_OR_NOT_ACTIVE')
  })

  await t.test('recipient grant', () => {
    const f = fixture()
    const expired = signAgentGrant({
      human: f.human,
      agentId: 'researcher',
      keyFingerprint: f.recipientProvider.publicIdentity().fingerprint,
      scopes: [{ capability: 'filesystem.read', resourcePrefix: 'workspace/' }],
      window: expiredWindow,
    })
    const result = verify(f, { recipientGrant: expired })
    assert.equal(result.reason, 'RECIPIENT_GRANT_EXPIRED_OR_NOT_ACTIVE')
  })
})

test('sender must be granted the envelope type and destination', () => {
  const f = fixture()
  const wrongScope = signAgentGrant({
    human: f.human,
    agentId: 'ceo',
    keyFingerprint: f.envelope.sender.keyFingerprint,
    scopes: [{ capability: 'agent.message.direct_message', resource: 'agent:other' }],
  })

  const result = verify(f, { senderGrant: wrongScope })
  assert.equal(result.status, 'rejected')
  assert.equal(result.reason, 'SENDER_MESSAGE_OUTSIDE_GRANT_SCOPE')
})

test('valid in-scope handoff is accepted, attributed, and uses recipient authority', () => {
  const f = fixture()
  const result = verify(f)

  assert.equal(result.status, 'accepted')
  assert.equal(result.type, 'task_handoff')
  assert.equal(result.attribution.senderAgentId, 'ceo')
  assert.equal(result.attribution.senderKeyId, f.senderProvider.keyId)
  assert.equal(result.attribution.senderGrantId, f.senderGrant.payload.grantId)
  assert.deepEqual(result.authority, {
    source: 'recipient-delegation-grant',
    recipientAgentId: 'researcher',
    grantId: f.recipientGrant.payload.grantId,
    humanKeyId: f.recipientGrant.humanKeyId,
  })
  assert.deepEqual(result.requestedAction, f.envelope.payload.request)
})
