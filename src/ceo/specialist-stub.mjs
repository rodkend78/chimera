import crypto from 'node:crypto'
import { createAgentMessageEnvelope, verifyAgentMessage } from '../agent-message.mjs'
import { sha256 } from '../canonical.mjs'
import { signAction } from '../identity.mjs'
import { createEd25519SigningProvider } from '../signing-provider.mjs'
import { redactSensitiveData } from '../security/redaction.mjs'

function actionWindow(grants, now) {
  const list = Array.isArray(grants) ? grants : [grants]
  const issuedAt = Math.max(now - 1_000, ...list.map((grant) => Date.parse(grant.payload.issuedAt)))
  const expiresAt = Math.min(now + 15 * 60_000, ...list.map((grant) => Date.parse(grant.payload.expiresAt)))
  if (issuedAt >= expiresAt) throw new Error('NO_SHARED_ACTIVE_GRANT_WINDOW')
  return {
    issuedAt: new Date(issuedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
  }
}

export class SignedSpecialistStub {
  constructor({
    agentId,
    identity,
    grant,
    gateway,
    audit,
    humanKeys,
    execute = async (request) => ({ request }),
    now = () => Date.now(),
  }) {
    if (!agentId || !identity?.privateKey || !grant || !gateway || !audit || typeof execute !== 'function') {
      throw new TypeError('specialist stub requires identity, grant, gateway, audit, and executor')
    }
    this.agentId = agentId
    this.identity = identity
    this.signingProvider = createEd25519SigningProvider(identity)
    this.grant = grant
    this.gateway = gateway
    this.audit = audit
    this.humanKeys = new Map(humanKeys)
    this.execute = execute
    this.now = now
  }

  async handle({ envelope, senderGrant, sender }) {
    const verification = verifyAgentMessage({
      envelope,
      senderGrant,
      recipientGrant: this.grant,
      recipient: {
        agentId: this.agentId,
        publicIdentity: this.signingProvider.publicIdentity(),
      },
      humanKeys: this.humanKeys,
      now: this.now,
    })
    this.audit.append({
      kind: verification.status === 'accepted' ? 'agent.message.accepted' : 'agent.message.rejected',
      messageId: verification.messageId,
      taskId: envelope?.payload?.taskId ?? 'unknown',
      senderAgentId: envelope?.sender?.agentId ?? 'unknown',
      recipientAgentId: this.agentId,
      outcome: verification.status,
      ...(verification.reason ? { reason: verification.reason } : {}),
      at: new Date(this.now()).toISOString(),
    })
    if (verification.status !== 'accepted') return verification

    let actionDecision = { status: 'allowed', actionId: null, tier: 'none' }
    let result
    if (envelope.payload.request) {
      const action = signAction({
        actionId: `specialist-${crypto.randomUUID()}`,
        agentId: this.agentId,
        ...envelope.payload.request,
        taskId: envelope.payload.taskId,
        nodeId: envelope.payload.nodeId ?? null,
        sourceMessageId: envelope.payload.messageId,
        ...actionWindow(this.grant, this.now()),
      }, this.identity)
      actionDecision = this.gateway.submit({ grant: this.grant, action })
      if (actionDecision.status === 'allowed') {
        result = await this.execute(structuredClone(envelope.payload.request), structuredClone(envelope.payload.content), structuredClone(envelope.payload))
      }
    } else {
      result = await this.execute(null, structuredClone(envelope.payload.content), structuredClone(envelope.payload))
    }

    const succeeded = actionDecision.status === 'allowed' && result?.status !== 'blocked'
    const summary = result?.status === 'blocked' ? result.summary : succeeded
      ? `Specialist ${this.agentId} completed the bounded task.`
      : `Specialist ${this.agentId} could not execute the bounded task: ${actionDecision.reason ?? actionDecision.status}.`
    this.audit.append({
      kind: 'specialist.task.completed',
      taskId: envelope.payload.taskId,
      agentId: this.agentId,
      actionId: actionDecision.actionId,
      outcome: succeeded ? 'succeeded' : 'failed',
      grantId: this.grant.payload.grantId,
      at: new Date(this.now()).toISOString(),
    })

    const messageWindow = actionWindow([this.grant, senderGrant], this.now())
    const resultEnvelope = createAgentMessageEnvelope({
      signingProvider: this.signingProvider,
      senderAgentId: this.agentId,
      recipientAgentId: sender.agentId,
      messageId: `result-${crypto.randomUUID()}`,
      type: 'structured_result',
      taskId: envelope.payload.taskId,
      nodeId: envelope.payload.nodeId ?? null,
      parentMessageId: envelope.payload.messageId,
      ...messageWindow,
      content: redactSensitiveData({
        status: succeeded ? 'succeeded' : 'failed',
        summary,
        result: actionDecision.status === 'allowed' ? structuredClone(result) : { reason: actionDecision.reason },
      }),
    })
    const messageAction = signAction({
      actionId: `message-${crypto.randomUUID()}`,
      agentId: this.agentId,
      capability: 'agent.message.structured_result',
      resource: `agent:${sender.agentId}`,
      operation: 'send',
      messageId: resultEnvelope.payload.messageId,
      messageHash: sha256(resultEnvelope),
      taskId: envelope.payload.taskId,
      nodeId: envelope.payload.nodeId ?? null,
      ...messageWindow,
    }, this.identity)
    const messageDecision = this.gateway.submit({ grant: this.grant, action: messageAction })
    if (messageDecision.status !== 'allowed') {
      return {
        status: 'rejected',
        reason: messageDecision.reason ?? 'MESSAGE_GATEWAY_DENIED',
        messageDecision,
      }
    }
    this.audit.append({
      kind: 'agent.message.sent',
      messageId: resultEnvelope.payload.messageId,
      taskId: resultEnvelope.payload.taskId,
      senderAgentId: this.agentId,
      recipientAgentId: sender.agentId,
      messageType: 'structured_result',
      grantId: this.grant.payload.grantId,
      gatewayActionId: messageDecision.actionId,
      at: new Date(this.now()).toISOString(),
    })
    return { status: 'completed', envelope: resultEnvelope, actionDecision, nodeId: envelope.payload.nodeId ?? null }
  }
}
