function bounded(value, maximum = 2048) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function displayAgent(agentId) {
  return agentId.split('-').map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(' ')
}

function semanticReview(value) {
  if (value === undefined) throw new TypeError('WORKER_APPROVAL_REVIEW_INVALID')
  const valuePrototype = value && typeof value === 'object' ? Object.getPrototypeOf(value) : null
  const fieldsPrototype = value?.fields && typeof value.fields === 'object' ? Object.getPrototypeOf(value.fields) : null
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (valuePrototype !== Object.prototype && valuePrototype !== null)
    || value.schema !== 'chimera.approval-review.v1'
    || !bounded(value.summary, 1024)
    || !value.fields || typeof value.fields !== 'object' || Array.isArray(value.fields)
    || (fieldsPrototype !== Object.prototype && fieldsPrototype !== null)) {
    throw new TypeError('WORKER_APPROVAL_REVIEW_INVALID')
  }
  const entries = Object.entries(value.fields)
  if (entries.length < 1 || entries.length > 16) throw new TypeError('WORKER_APPROVAL_REVIEW_INVALID')
  for (const [label, member] of entries) {
    if (!bounded(label, 64)
      || !['string', 'number', 'boolean'].includes(typeof member)
      || (typeof member === 'string' && (!bounded(member, 4096)))
      || (typeof member === 'number' && !Number.isFinite(member))) {
      throw new TypeError('WORKER_APPROVAL_REVIEW_INVALID')
    }
  }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 8 * 1024) {
    throw new TypeError('WORKER_APPROVAL_REVIEW_INVALID')
  }
  return structuredClone(value)
}

export class WorkerToolApprovalBroker {
  #pending = new Map()

  constructor({ queue, audit, onPending = () => {}, now = () => Date.now() }) {
    if (!queue?.post || !audit?.append || typeof onPending !== 'function') {
      throw new TypeError('WORKER_APPROVAL_BROKER_CONFIG_INVALID')
    }
    this.queue = queue
    this.audit = audit
    this.onPending = onPending
    this.now = now
  }

  async request(request) {
    if (!bounded(request?.actionId, 256)
      || !bounded(request?.challengeHash, 128)
      || !bounded(request?.agentId, 64)
      || !bounded(request?.grantId, 256)
      || !bounded(request?.toolName, 256)
      || !bounded(request?.capability, 128)
      || !bounded(request?.resource, 2048)
      || !bounded(request?.callId, 256)
      || !bounded(request?.requestHash, 128)
      || this.#pending.has(request.actionId)) {
      throw new TypeError('WORKER_APPROVAL_REQUEST_INVALID')
    }
    const review = semanticReview(request.review)
    let settle
    const waiting = new Promise((resolve) => { settle = resolve })
    let complete
    const completion = new Promise((resolve) => { complete = resolve })
    const abort = () => {
      if (!this.#pending.has(request.actionId)) return
      this.#pending.delete(request.actionId)
      settle(null)
      complete({ status: 'denied', actionId: request.actionId, reason: 'APPROVAL_CANCELLED' })
    }
    request.signal?.addEventListener?.('abort', abort, { once: true })
    this.#pending.set(request.actionId, {
      challengeHash: request.challengeHash,
      settle: (decision) => {
        request.signal?.removeEventListener?.('abort', abort)
        settle(decision)
      },
      complete,
      completion,
      decisionIssued: false,
    })
    try {
      await this.queue.post({
        actionId: request.actionId,
        challengeHash: request.challengeHash,
        actionDiff: {
          tool: request.toolName,
          callId: request.callId,
          requestHash: request.requestHash,
          ...(review ? { review } : {}),
        },
        resource: request.resource,
        expiresAt: new Date(this.now() + 5 * 60_000).toISOString(),
        agent: { agentId: request.agentId, grantId: request.grantId },
        policyRationale: {
          ruleId: 'dsh-confirm-tool',
          tier: 'confirm',
          reason: 'HUMAN_CONFIRMATION_REQUIRED',
        },
        title: `${displayAgent(request.agentId)} wants to use ${request.toolName}`,
        detail: review?.summary
          ?? `Review the ${request.capability} request for ${request.resource}. Arguments stay hashed in the decision record.`,
      })
      this.onPending(request.actionId)
      // Storage may yield while the operator changes the proposal's recipient
      // snapshot. Recheck trusted runtime authority before waiting for a human.
      if (typeof request.assertActive === 'function') {
        try { if (await request.assertActive() === false) throw new Error('TASK_PROPOSAL_INACTIVE') }
        catch {
          await this.queue.cancel(request.actionId, 'TASK_PROPOSAL_SUPERSEDED')
          await this.expire(request.actionId, 'TASK_PROPOSAL_SUPERSEDED')
        }
      }
    } catch (error) {
      this.#pending.delete(request.actionId)
      request.signal?.removeEventListener?.('abort', abort)
      throw error
    }
    return waiting
  }

  async resolve(actionId, signedDecision) {
    const pending = this.#pending.get(actionId)
    if (!pending) return { status: 'denied', actionId, reason: 'NO_PENDING_ACTION' }
    if (signedDecision?.payload?.actionId !== actionId
      || signedDecision?.payload?.challengeHash !== pending.challengeHash
      || !['approve', 'deny'].includes(signedDecision?.payload?.outcome)) {
      return { status: 'denied', actionId, reason: 'MALFORMED_DECISION' }
    }
    if (pending.decisionIssued) return { status: 'denied', actionId, reason: 'DECISION_ALREADY_ISSUED' }
    pending.decisionIssued = true
    pending.settle(signedDecision)
    return pending.completion
  }

  async complete(actionId, gatewayResult) {
    const pending = this.#pending.get(actionId)
    if (!pending) return { status: 'denied', actionId, reason: 'NO_PENDING_ACTION' }
    this.#pending.delete(actionId)
    pending.complete(structuredClone(gatewayResult))
    return structuredClone(gatewayResult)
  }

  async expire(actionId, reason = 'DECISION_EXPIRED_OR_NOT_ACTIVE') {
    const pending = this.#pending.get(actionId)
    const result = { status: 'denied', actionId, reason }
    if (!pending) return result
    this.#pending.delete(actionId)
    pending.settle(null)
    pending.complete(result)
    return result
  }

  async cancelAll(reason = 'PROCESS_STOPPED') {
    const actionIds = [...this.#pending.keys()]
    for (const actionId of actionIds) {
      const pending = this.#pending.get(actionId)
      if (!pending) continue
      await this.queue.cancel(actionId, reason)
      this.#pending.delete(actionId)
      pending.settle(null)
      pending.complete({ status: 'denied', actionId, reason })
    }
    return actionIds
  }
}
