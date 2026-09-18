import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { agentMessageKeyFingerprint, verifyAgentMessage } from '../agent-message.mjs'

const SCHEMA = 'chimera.agent-mailbox-event.v1'
const TERMINAL = new Set(['acknowledged', 'completed', 'failed', 'expired', 'interrupted'])
const JOURNALS = new Map()

function bounded(value, maximum = 256) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function failure(code) {
  return Object.assign(new Error(code), { code })
}

function validLease(leaseMs) {
  return Number.isSafeInteger(leaseMs) && leaseMs > 0 && leaseMs <= 86_400_000
}

// One active writer per journal. Reopening transfers ownership to the new
// runtime; surviving processing claims are interrupted, never replayed.
// Ownership is enforced within this OS process, not across separate processes.
export class DurableAgentMailbox {
  #messages = new Map()
  #journal
  #writeFailure = null

  constructor({ filePath, audit, now, maxAttempts }) {
    this.filePath = resolve(filePath)
    this.audit = audit
    this.now = now
    this.maxAttempts = maxAttempts
    this.auditDeliveryFailures = 0
  }

  static async open({ filePath, audit, now = () => Date.now(), maxAttempts = 3 }) {
    if (!bounded(filePath, 4096) || !audit?.append || typeof now !== 'function'
      || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
      throw new TypeError('AGENT_MAILBOX_CONFIG_INVALID')
    }
    await mkdir(dirname(resolve(filePath)), { recursive: true, mode: 0o700 })
    let canonicalPath
    try {
      canonicalPath = await realpath(resolve(filePath))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      canonicalPath = join(await realpath(dirname(resolve(filePath))), basename(filePath))
    }
    const mailbox = new DurableAgentMailbox({ filePath: canonicalPath, audit, now, maxAttempts })
    const journal = JOURNALS.get(canonicalPath) ?? { writes: Promise.resolve(), owner: null }
    JOURNALS.set(canonicalPath, journal)
    mailbox.#journal = journal
    const operation = journal.writes.then(async () => {
      // Fence the old instance before awaiting replay. All commits and opens
      // for this canonical path share the same in-process serialization queue.
      journal.owner = new WeakRef(mailbox)
      try {
        const contents = await readFile(mailbox.filePath, 'utf8')
        const boundary = contents.lastIndexOf('\n') + 1
        const lines = contents.slice(0, boundary).split('\n').filter(Boolean)
        for (const line of lines) mailbox.#messages = mailbox.#reduce(JSON.parse(line))
        const tail = contents.slice(boundary)
        if (tail) {
          let event
          try { event = JSON.parse(tail) } catch { /* Torn final write. */ }
          if (event !== undefined) mailbox.#messages = mailbox.#reduce(event)
          const file = await open(mailbox.filePath, 'r+')
          try {
            if (event === undefined) await file.truncate(Buffer.byteLength(contents.slice(0, boundary)))
            else await file.write('\n', Buffer.byteLength(contents))
            await file.sync()
          } finally { await file.close() }
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    })
    journal.writes = operation.catch(() => {})
    await operation
    await mailbox.sweep({ interrupted: true })
    return mailbox
  }

  async deliver(input) {
    const request = structuredClone(input)
    return this.#commit(() => {
      const verification = verifyAgentMessage({ ...request, now: this.now })
      if (verification.status !== 'accepted') return { result: verification }
      const { envelope, recipient } = request
      const messageId = envelope.payload.messageId
      if (this.#messages.has(messageId)) throw failure('AGENT_MAILBOX_DUPLICATE')
      return {
        event: { ...this.#event('delivered', envelope.payload.recipientAgentId, messageId), envelope,
          recipientKeyFingerprint: agentMessageKeyFingerprint(recipient.publicIdentity), maxAttempts: this.maxAttempts },
        result: { status: 'delivered', messageId, attribution: verification.attribution },
      }
    })
  }

  // Compatibility view: every unacknowledged envelope, including interrupted
  // or failed work. Dispatchers must use list().status to select pending work.
  pending(agentId) {
    if (!bounded(agentId)) return []
    return structuredClone([...this.#messages.values()]
      .filter((entry) => entry.agentId === agentId && entry.acknowledgedAt === null)
      .map((entry) => entry.envelope))
  }

  list({ agentId, taskId } = {}) {
    return structuredClone([...this.#messages.entries()]
      .filter(([, entry]) => (agentId === undefined || entry.agentId === agentId)
        && (taskId === undefined || entry.envelope.payload.taskId === taskId))
      .map(([messageId, entry]) => ({
        messageId, agentId: entry.agentId, senderAgentId: entry.envelope.sender.agentId,
        taskId: entry.envelope.payload.taskId, parentMessageId: entry.envelope.payload.parentMessageId,
        type: entry.envelope.payload.type, status: entry.status,
        deliveredAt: entry.deliveredAt, acknowledgedAt: entry.acknowledgedAt,
        expiresAt: entry.envelope.payload.expiresAt, updatedAt: entry.updatedAt,
        attempt: entry.attempt, maxAttempts: entry.maxAttempts,
        ownerId: entry.claim?.ownerId ?? null, leaseExpiresAt: entry.claim?.leaseExpiresAt ?? null,
        reason: entry.reason ?? null, replyMessageId: entry.replyMessageId ?? null,
      })))
  }

  // Trusted runtime recovery of an already-committed result, including after
  // its acknowledgement. Never infer success from an executor's late promise.
  completedReply({ agentId, messageId }) {
    this.#assertOwner()
    if (this.#writeFailure) throw failure('AGENT_MAILBOX_REOPEN_REQUIRED')
    const current = this.#current(agentId, messageId)
    if (current.status !== 'completed') return null
    return structuredClone({ completedAt: current.acknowledgedAt,
      envelope: this.#messages.get(current.replyMessageId).envelope })
  }

  async acknowledge({ agentId, messageId, claimToken }) {
    return this.#commit(() => {
      const current = this.#current(agentId, messageId)
      const result = { status: 'acknowledged', messageId }
      if (current.acknowledgedAt !== null) return { result }
      this.#assertCompletable(current, claimToken)
      return { event: this.#event('acknowledged', agentId, messageId), result }
    })
  }

  async claim({ agentId, messageId, ownerId, leaseMs = 60_000 }) {
    return this.#commit(() => {
      const current = this.#current(agentId, messageId)
      this.#assertUnexpired(current)
      if (!bounded(ownerId) || !validLease(leaseMs)) throw failure('AGENT_MAILBOX_CLAIM_INVALID')
      if (current.status !== 'pending') throw failure('AGENT_MAILBOX_MESSAGE_NOT_PENDING')
      if (current.attempt >= current.maxAttempts) throw failure('AGENT_MAILBOX_ATTEMPTS_EXHAUSTED')
      const claimToken = randomUUID()
      const leaseExpiresAt = this.#leaseEnd(current, leaseMs)
      return { event: { ...this.#event('claimed', agentId, messageId), claimToken, ownerId, leaseExpiresAt },
        result: { status: 'processing', messageId, claimToken, attempt: current.attempt + 1, leaseExpiresAt } }
    })
  }

  assertClaim({ agentId, messageId, claimToken, envelope }) {
    this.#assertOwner()
    if (this.#writeFailure) throw failure('AGENT_MAILBOX_REOPEN_REQUIRED')
    const current = this.#current(agentId, messageId)
    this.#assertUnexpired(current)
    if (current.status !== 'processing' || !bounded(claimToken) || current.claim?.claimToken !== claimToken) {
      throw failure('AGENT_MAILBOX_CLAIM_INVALID')
    }
    if (Date.parse(current.claim.leaseExpiresAt) <= this.now()) throw failure('AGENT_MAILBOX_CLAIM_EXPIRED')
    if (envelope !== undefined && !isDeepStrictEqual(envelope, current.envelope)) {
      throw failure('AGENT_MAILBOX_ENVELOPE_MISMATCH')
    }
    return true
  }

  async renewClaim({ agentId, messageId, claimToken, leaseMs = 60_000 }) {
    return this.#commit(() => {
      this.assertClaim({ agentId, messageId, claimToken })
      if (!validLease(leaseMs)) throw failure('AGENT_MAILBOX_CLAIM_INVALID')
      const leaseExpiresAt = this.#leaseEnd(this.#current(agentId, messageId), leaseMs)
      return { event: { ...this.#event('renewed', agentId, messageId), claimToken, leaseExpiresAt },
        result: { status: 'processing', messageId, claimToken, leaseExpiresAt } }
    })
  }

  async completeWithReply({ agentId, messageId, claimToken, reply }) {
    const request = structuredClone(reply)
    return this.#commit(() => {
      const current = this.#current(agentId, messageId)
      this.#assertCompletable(current, claimToken)
      const verification = verifyAgentMessage({ ...request, now: this.now })
      if (verification.status !== 'accepted') return { result: verification }
      const { envelope, recipient } = request
      if (envelope.sender.agentId !== agentId
        || envelope.payload.recipientAgentId !== current.envelope.sender.agentId
        || envelope.payload.taskId !== current.envelope.payload.taskId
        || envelope.payload.parentMessageId !== messageId
        || envelope.payload.type !== 'structured_result'
        || agentMessageKeyFingerprint(recipient.publicIdentity) !== current.envelope.sender.keyFingerprint
        || (current.recipientKeyFingerprint && envelope.sender.keyFingerprint !== current.recipientKeyFingerprint)) {
        return { result: { status: 'rejected', messageId, reason: 'AGENT_MAILBOX_REPLY_MISMATCH' } }
      }
      const replyMessageId = envelope.payload.messageId
      if (this.#messages.has(replyMessageId)) throw failure('AGENT_MAILBOX_DUPLICATE')
      return { event: { ...this.#event('completed', agentId, messageId), reply: envelope,
        replyRecipientKeyFingerprint: agentMessageKeyFingerprint(recipient.publicIdentity), maxAttempts: this.maxAttempts },
        result: { status: 'completed', messageId, replyMessageId } }
    })
  }

  async fail({ agentId, messageId, claimToken, reason = 'execution-failed', retryable = false }) {
    return this.#commit(() => {
      this.assertClaim({ agentId, messageId, claimToken })
      if (!bounded(reason, 128) || typeof retryable !== 'boolean') throw failure('AGENT_MAILBOX_FAILURE_INVALID')
      const current = this.#current(agentId, messageId)
      const status = retryable && current.attempt < current.maxAttempts ? 'pending' : 'failed'
      return { event: { ...this.#event('failed', agentId, messageId), reason, status }, result: { status, messageId } }
    })
  }

  // Explicit caller decision: retry only after determining that repeating any
  // external effects is safe. Expiry and restart never call this operation.
  async requeue({ agentId, messageId }) {
    return this.#commit(() => {
      const current = this.#current(agentId, messageId)
      this.#assertUnexpired(current)
      if (current.attempt >= current.maxAttempts) throw failure('AGENT_MAILBOX_ATTEMPTS_EXHAUSTED')
      if (!['failed', 'interrupted'].includes(current.status)) throw failure('AGENT_MAILBOX_REQUEUE_INVALID')
      return { event: this.#event('requeued', agentId, messageId), result: { status: 'pending', messageId } }
    })
  }

  async sweep({ interrupted = false } = {}) {
    const changed = []
    for (const [messageId, entry] of this.#messages) {
      const result = await this.#commit(() => {
        const current = this.#current(entry.agentId, messageId)
        if (TERMINAL.has(current.status)) return {}
        const expired = Date.parse(current.envelope.payload.expiresAt) <= this.now()
        const abandoned = current.status === 'processing'
          && (interrupted || Date.parse(current.claim.leaseExpiresAt) <= this.now())
        if (!expired && !abandoned) return {}
        const status = expired ? 'expired' : 'interrupted'
        return { event: { ...this.#event(status, entry.agentId, messageId),
          reason: expired ? 'message-expired' : interrupted ? 'process-restarted' : 'claim-expired' },
          result: { messageId, status } }
      })
      if (result) changed.push(result)
    }
    return changed
  }

  // Task authority has ended. Fence even a pending delivery without claiming
  // that its executor ran or that an in-flight external effect was undone.
  async interrupt({ agentId, messageId, reason = 'task-interrupted' }) {
    return this.#commit(() => {
      const current = this.#current(agentId, messageId)
      if (!bounded(reason, 128)) throw failure('AGENT_MAILBOX_FAILURE_INVALID')
      if (TERMINAL.has(current.status)) return { result: { messageId, status: current.status } }
      return { event: { ...this.#event('interrupted', agentId, messageId), reason }, result: { messageId, status: 'interrupted' } }
    })
  }

  #event(kind, agentId, messageId) {
    return { schema: SCHEMA, kind, agentId, messageId, at: new Date(this.now()).toISOString() }
  }

  #assertOwner() {
    if (this.#journal?.owner?.deref() !== this) throw failure('AGENT_MAILBOX_OWNER_REPLACED')
  }

  #current(agentId, messageId) {
    const current = this.#messages.get(messageId)
    if (!current || current.agentId !== agentId) throw failure('AGENT_MAILBOX_MESSAGE_NOT_PENDING')
    return current
  }

  #assertUnexpired(current) {
    if (Date.parse(current.envelope.payload.expiresAt) <= this.now()) throw failure('AGENT_MAILBOX_MESSAGE_EXPIRED')
  }

  #assertCompletable(current, claimToken) {
    this.#assertUnexpired(current)
    if (current.status === 'processing' || claimToken !== undefined || current.attempt > 0) {
      this.assertClaim({ agentId: current.agentId, messageId: current.envelope.payload.messageId, claimToken })
    } else if (current.status !== 'pending') throw failure('AGENT_MAILBOX_MESSAGE_NOT_PENDING')
  }

  #leaseEnd(current, leaseMs) {
    return new Date(Math.min(this.now() + leaseMs, Date.parse(current.envelope.payload.expiresAt))).toISOString()
  }

  // Validate a candidate state before appending. Replay accepts old v1 events,
  // including duplicate acknowledgements, but never duplicate delivery.
  #reduce(event) {
    const invalid = () => { throw new TypeError('AGENT_MAILBOX_EVENT_INVALID') }
    if (event?.schema !== SCHEMA || !bounded(event.kind, 32) || !bounded(event.messageId)
      || !bounded(event.agentId) || !Number.isFinite(Date.parse(event.at))) invalid()
    const next = new Map(this.#messages)
    const add = (messageId, agentId, envelope, recipientKeyFingerprint, maxAttempts = this.maxAttempts) => {
      if (!bounded(agentId) || !envelope?.sender || envelope?.payload?.messageId !== messageId
        || envelope.payload.recipientAgentId !== agentId || !bounded(envelope.payload.taskId)
        || !Number.isFinite(Date.parse(envelope.payload.expiresAt)) || next.has(messageId)
        || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) invalid()
      next.set(messageId, { agentId, envelope: structuredClone(envelope), recipientKeyFingerprint,
        deliveredAt: event.at, updatedAt: event.at, acknowledgedAt: null,
        status: 'pending', attempt: 0, maxAttempts, claim: null })
    }
    if (event.kind === 'delivered') {
      add(event.messageId, event.agentId, event.envelope, event.recipientKeyFingerprint, event.maxAttempts)
      return next
    }
    const old = next.get(event.messageId)
    if (!old || old.agentId !== event.agentId) invalid()
    const current = structuredClone(old)
    next.set(event.messageId, current)
    const active = () => { if (!['pending', 'processing'].includes(current.status)) invalid() }
    switch (event.kind) {
      case 'acknowledged':
        if (current.acknowledgedAt !== null) return next
        active()
        current.status = 'acknowledged'
        current.acknowledgedAt = event.at
        current.claim = null
        break
      case 'completed':
        active()
        if (event.reply?.sender?.agentId !== event.agentId
          || event.reply?.payload?.recipientAgentId !== current.envelope.sender.agentId
          || event.reply.payload.taskId !== current.envelope.payload.taskId
          || event.reply.payload.parentMessageId !== event.messageId
          || event.reply.payload.type !== 'structured_result') invalid()
        add(event.reply.payload.messageId, event.reply.payload.recipientAgentId, event.reply,
          event.replyRecipientKeyFingerprint, event.maxAttempts)
        current.status = 'completed'
        current.acknowledgedAt = event.at
        current.replyMessageId = event.reply.payload.messageId
        current.claim = null
        break
      case 'claimed':
        if (current.status !== 'pending' || current.attempt >= current.maxAttempts || !bounded(event.claimToken)
          || !bounded(event.ownerId) || !(Date.parse(event.leaseExpiresAt) > Date.parse(event.at))
          || Date.parse(event.leaseExpiresAt) > Date.parse(current.envelope.payload.expiresAt)) invalid()
        current.status = 'processing'
        current.attempt += 1
        current.claim = { claimToken: event.claimToken, ownerId: event.ownerId, leaseExpiresAt: event.leaseExpiresAt }
        break
      case 'renewed':
        if (current.status !== 'processing' || current.claim.claimToken !== event.claimToken
          || !(Date.parse(event.leaseExpiresAt) > Date.parse(event.at))
          || Date.parse(event.leaseExpiresAt) > Date.parse(current.envelope.payload.expiresAt)) invalid()
        current.claim.leaseExpiresAt = event.leaseExpiresAt
        break
      case 'failed':
        if (current.status !== 'processing' || !bounded(event.reason, 128)
          || !['pending', 'failed'].includes(event.status)
          || (event.status === 'pending' && current.attempt >= current.maxAttempts)) invalid()
        current.status = event.status
        current.reason = event.reason
        current.claim = null
        break
      case 'requeued':
        if (!['failed', 'interrupted'].includes(current.status) || current.attempt >= current.maxAttempts) invalid()
        current.status = 'pending'
        current.reason = null
        current.claim = null
        break
      case 'expired':
      case 'interrupted':
        active()
        current.status = event.kind
        current.reason = event.reason
        current.claim = null
        break
      default: invalid()
    }
    current.updatedAt = event.at
    return next
  }

  async #commit(build) {
    const operation = this.#journal.writes.then(async () => {
      this.#assertOwner()
      if (this.#writeFailure) throw failure('AGENT_MAILBOX_REOPEN_REQUIRED')
      const { event, result } = build()
      if (!event) {
        if (result?.status === 'rejected') await this.#recordAudit({ kind: 'agent.mailbox.rejected',
          messageId: result.messageId, reason: result.reason, at: new Date(this.now()).toISOString() })
        return result
      }
      const next = this.#reduce(event)
      try {
        const journal = await open(this.filePath, 'a', 0o600)
        try {
          await journal.writeFile(`${JSON.stringify(event)}\n`)
          await journal.sync()
        } finally { await journal.close() }
        const directory = await open(dirname(this.filePath), 'r')
        try { await directory.sync() } finally { await directory.close() }
      } catch (error) {
        // An ambiguous write failure requires recovery before any more appends.
        this.#writeFailure = error
        throw error
      }
      this.#messages = next
      await this.#recordAudit({ kind: `agent.mailbox.${event.kind}`, agentId: event.agentId,
        messageId: event.messageId, at: event.at,
        ...(event.envelope ? { senderAgentId: event.envelope.sender.agentId, recipientAgentId: event.agentId } : {}),
        ...(event.reply ? { replyMessageId: event.reply.payload.messageId } : {}) })
      return result
    })
    this.#journal.writes = operation.catch(() => {})
    return operation
  }

  async #recordAudit(event) {
    try { await this.audit.append(event) } catch {
      // Separate audit transport is best effort; the fsynced journal remains
      // authoritative. Expose failures without leaking backend error details.
      this.auditDeliveryFailures += 1
    }
  }
}
