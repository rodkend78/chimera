import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { signDecision } from '../identity.mjs'

export const DECISION_QUEUE_SCHEMA = 'chimera.decision-queue.v1'

function isRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
}

function isBoundedString(value, maximum = 4096) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function validateDecisionRequest(decision) {
  if (!isRecord(decision)
    || !isBoundedString(decision.actionId, 256)
    || !isBoundedString(decision.challengeHash, 128)
    || !isRecord(decision.actionDiff)
    || !isBoundedString(decision.resource, 2048)
    || !isBoundedString(decision.expiresAt, 64)
    || !Number.isFinite(Date.parse(decision.expiresAt))
    || !isRecord(decision.agent)
    || !isBoundedString(decision.agent.agentId, 256)
    || !isBoundedString(decision.agent.grantId, 256)
    || !isRecord(decision.policyRationale)
    || !isBoundedString(decision.policyRationale.ruleId, 256)
    || decision.policyRationale.tier !== 'confirm'
    || !isBoundedString(decision.policyRationale.reason, 2048)
    || (decision.taskId !== undefined && decision.taskId !== null && !isBoundedString(decision.taskId, 256))
    || (decision.nodeId !== undefined && decision.nodeId !== null && !isBoundedString(decision.nodeId, 128))
    || (decision.assignmentId !== undefined && decision.assignmentId !== null && !isBoundedString(decision.assignmentId, 256))
    || (decision.canonicalAssignmentId !== undefined && decision.canonicalAssignmentId !== null && !isBoundedString(decision.canonicalAssignmentId, 256))
    || (decision.nodeId !== undefined && decision.nodeId !== null && (decision.taskId === undefined || decision.taskId === null))
    || (decision.assignmentId !== undefined && decision.assignmentId !== null && (decision.taskId === undefined || decision.taskId === null))
    || (decision.canonicalAssignmentId !== undefined && decision.canonicalAssignmentId !== null && (decision.taskId === undefined || decision.taskId === null))) {
    throw new TypeError('invalid decision request')
  }
  return {
    ...decision,
    taskId: decision.taskId ?? null,
    nodeId: decision.nodeId ?? null,
    assignmentId: decision.assignmentId ?? null,
    canonicalAssignmentId: decision.canonicalAssignmentId ?? null,
  }
}

export class DurableDecisionQueue {
  #records = new Map()

  constructor({ filePath, audit, now = () => Date.now() }) {
    if (!isBoundedString(filePath, 4096)) throw new TypeError('decision queue file path is required')
    this.filePath = filePath
    this.audit = audit
    this.now = now
  }

  static async open(options) {
    const queue = new DurableDecisionQueue(options)
    await mkdir(dirname(queue.filePath), { recursive: true, mode: 0o700 })
    try {
      const content = await readFile(queue.filePath, 'utf8')
      for (const line of content.split('\n')) {
        if (!line.trim()) continue
        const event = JSON.parse(line)
        queue.#restore(event)
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    return queue
  }

  async post(input) {
    const decision = structuredClone(validateDecisionRequest(input))
    if (this.#records.has(decision.actionId)) throw new Error('DECISION_ALREADY_EXISTS')
    const record = {
      ...decision,
      schema: DECISION_QUEUE_SCHEMA,
      status: 'pending',
      postedAt: new Date(this.now()).toISOString(),
    }
    const event = { schema: DECISION_QUEUE_SCHEMA, event: 'posted', at: record.postedAt, decision: record }
    await this.#append(event)
    this.#records.set(record.actionId, record)
    this.audit?.append({
      kind: 'decision.queued',
      actionId: record.actionId,
      agentId: record.agent.agentId,
      grantId: record.agent.grantId,
      resource: record.resource,
      ...(record.taskId ? { taskId: record.taskId } : {}),
      ...(record.nodeId ? { nodeId: record.nodeId } : {}),
      ...(record.assignmentId ? { assignmentId: record.assignmentId } : {}),
      ...(record.canonicalAssignmentId ? { canonicalAssignmentId: record.canonicalAssignmentId } : {}),
      expiresAt: record.expiresAt,
      policyRuleId: record.policyRationale.ruleId,
      tier: record.policyRationale.tier,
      at: record.postedAt,
    })
    return structuredClone(record)
  }

  async resolve(actionId, { outcome, gatewayResult }) {
    const current = this.#records.get(actionId)
    if (!current) throw new Error('DECISION_NOT_FOUND')
    if (current.status !== 'pending') throw new Error('DECISION_ALREADY_RESOLVED')
    const resolvedAt = new Date(this.now()).toISOString()
    const status = outcome === 'approve' && gatewayResult.status === 'allowed' ? 'approved' : 'denied'
    const event = {
      schema: DECISION_QUEUE_SCHEMA,
      event: 'resolved',
      at: resolvedAt,
      actionId,
      status,
      outcome,
      gatewayResult: structuredClone(gatewayResult),
    }
    await this.#append(event)
    const next = { ...current, status, outcome, resolvedAt, gatewayResult: event.gatewayResult }
    this.#records.set(actionId, next)
    this.audit?.append({
      kind: 'decision.resolved',
      actionId,
      agentId: current.agent.agentId,
      outcome,
      status,
      gatewayStatus: gatewayResult.status,
      ...(gatewayResult.reason ? { reason: gatewayResult.reason } : {}),
      at: resolvedAt,
    })
    return structuredClone(next)
  }

  async expire(actionId, reason = 'DECISION_EXPIRED_OR_NOT_ACTIVE') {
    return this.#terminate(actionId, 'expired', reason)
  }

  async cancel(actionId, reason = 'DECISION_CANCELLED') {
    return this.#terminate(actionId, 'cancelled', reason)
  }

  async orphanPending(reason = 'PROCESS_RESTARTED') {
    const orphaned = []
    for (const decision of this.pending()) {
      await this.#terminate(decision.actionId, 'orphaned', reason)
      orphaned.push(decision.actionId)
    }
    return orphaned
  }

  async recordAttempt(actionId, gatewayResult) {
    const at = new Date(this.now()).toISOString()
    await this.#append({
      schema: DECISION_QUEUE_SCHEMA,
      event: 'attempt-rejected',
      at,
      actionId,
      gatewayResult: structuredClone(gatewayResult),
    })
    this.audit?.append({
      kind: 'decision.replay-rejected',
      actionId,
      reason: gatewayResult.reason,
      at,
    })
  }

  get(actionId) {
    const record = this.#records.get(actionId)
    return record ? structuredClone(record) : null
  }

  pending() {
    return [...this.#records.values()]
      .filter((record) => record.status === 'pending')
      .map((record) => structuredClone(record))
  }

  all() {
    return [...this.#records.values()].map((record) => structuredClone(record))
  }

  async #append(event) {
    await appendFile(this.filePath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 })
  }

  async #terminate(actionId, status, reason) {
    const current = this.#records.get(actionId)
    if (!current) throw new Error('DECISION_NOT_FOUND')
    if (current.status !== 'pending') return structuredClone(current)
    if (!['expired', 'cancelled', 'orphaned'].includes(status) || !isBoundedString(reason, 128)) {
      throw new TypeError('DECISION_TERMINAL_STATE_INVALID')
    }
    const at = new Date(this.now()).toISOString()
    const event = { schema: DECISION_QUEUE_SCHEMA, event: 'terminated', at, actionId, status, reason }
    await this.#append(event)
    const next = { ...current, status, reason, resolvedAt: at }
    this.#records.set(actionId, next)
    this.audit?.append({ kind: 'decision.terminated', actionId, agentId: current.agent.agentId, status, reason, at })
    return structuredClone(next)
  }

  #restore(event) {
    if (!isRecord(event) || event.schema !== DECISION_QUEUE_SCHEMA) {
      throw new TypeError('invalid decision queue event')
    }
    if (event.event === 'posted') {
      const decision = structuredClone(validateDecisionRequest(event.decision))
      if (decision.schema !== DECISION_QUEUE_SCHEMA || decision.status !== 'pending' || !isBoundedString(decision.postedAt, 64)) {
        throw new TypeError('invalid decision post')
      }
      this.#records.set(decision.actionId, decision)
      return
    }
    if (event.event === 'resolved') {
      const current = this.#records.get(event.actionId)
      if (!current) throw new TypeError('decision resolution precedes request')
      if (!['approved', 'denied'].includes(event.status)
        || !['approve', 'deny'].includes(event.outcome)) throw new TypeError('invalid decision resolution')
      this.#records.set(event.actionId, {
        ...current,
        status: event.status,
        outcome: event.outcome,
        resolvedAt: event.at,
        gatewayResult: structuredClone(event.gatewayResult),
      })
      return
    }
    if (event.event === 'terminated') {
      const current = this.#records.get(event.actionId)
      if (!current || current.status !== 'pending'
        || !['expired', 'cancelled', 'orphaned'].includes(event.status)
        || !isBoundedString(event.reason, 128)) throw new TypeError('invalid decision termination')
      this.#records.set(event.actionId, {
        ...current,
        status: event.status,
        reason: event.reason,
        resolvedAt: event.at,
      })
      return
    }
    if (event.event !== 'attempt-rejected') throw new TypeError('unknown decision queue event')
  }
}

export class HumanDecisionHandler {
  constructor({ queue, gateway, humanIdentity, now = () => Date.now() }) {
    if (!queue || !gateway || !humanIdentity?.privateKey) {
      throw new TypeError('decision handler requires queue, gateway, and human identity')
    }
    this.queue = queue
    this.gateway = gateway
    this.humanIdentity = humanIdentity
    this.now = now
  }

  async decide(actionId, outcome, { decisionPath, expirePath } = {}) {
    const decision = this.queue.get(actionId)
    if (!decision) return { status: 'denied', actionId, reason: 'NO_PENDING_ACTION' }
    if (!['approve', 'deny'].includes(outcome)) {
      return { status: 'denied', actionId, reason: 'INVALID_DECISION_OUTCOME' }
    }

    const now = this.now()
    if (decision.status === 'pending' && Date.parse(decision.expiresAt) <= now) {
      const result = { status: 'denied', actionId, reason: 'DECISION_EXPIRED_OR_NOT_ACTIVE' }
      await (expirePath ? expirePath(result) : this.gateway.cancelPending?.(actionId, result.reason))
      await this.queue.expire(actionId, result.reason)
      return result
    }
    const expiresAt = Math.min(Date.parse(decision.expiresAt), now + 5 * 60_000)
    const signed = signDecision({
      actionId,
      challengeHash: decision.challengeHash,
      outcome,
      issuedAt: new Date(now - 1_000).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
    }, this.humanIdentity)
    const result = await (decisionPath ?? ((envelope) => this.gateway.decide(envelope)))(signed)

    if (decision.status !== 'pending') {
      await this.queue.recordAttempt(actionId, result)
      return result
    }
    if (result.status === 'allowed'
      || result.reason === 'HUMAN_DENIED'
      || result.reason === 'NO_PENDING_ACTION') {
      await this.queue.resolve(actionId, { outcome, gatewayResult: result })
    }
    return result
  }
}
