import { appendFile, mkdir, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

export const CONVERSATION_MESSAGE_SCHEMA = 'chimera.conversation-message.v2'
const LEGACY_CONVERSATION_MESSAGE_SCHEMA = 'chimera.conversation-message.v1'
const OPEN_TOKEN = Symbol('chimera-conversation-ledger-open')
const OPEN_LEDGER_OWNERS = new Map()
const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const ROLES = new Set(['human', 'rj', 'agent'])
const STATUSES = new Set(['sent', 'completed', 'failed'])
const KINDS = new Set(['message', 'task_handoff', 'structured_result', 'tool_request', 'tool_result', 'status', 'question', 'answer'])
const VERIFICATIONS = new Set(['human', 'verified', 'derived', 'legacy'])
const FAILURE_CODE = /^[A-Z][A-Z0-9_]{2,127}$/

function boundedString(value, maximum = 16_384) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function withinUtf8Bytes(value, maximum) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= maximum
}

function agentId(value) {
  return typeof value === 'string' && AGENT_ID.test(value)
}

function roleFor(senderAgentId) {
  if (senderAgentId === 'rod' || senderAgentId === 'operator') return 'human'
  if (senderAgentId === 'ceo' || senderAgentId === 'rj') return 'rj'
  return 'agent'
}

function legacyParticipants(role) {
  return role === 'human'
    ? { senderAgentId: 'rod', recipientAgentIds: ['ceo'] }
    : { senderAgentId: 'ceo', recipientAgentIds: ['rod'] }
}

function normalizedProvenance(value, fallback = { verification: 'derived', source: 'conversation-runtime' }) {
  const input = value ?? fallback
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || !VERIFICATIONS.has(input.verification)
    || (input.source !== undefined && !boundedString(input.source, 256))
    || (input.envelopeHash !== undefined && !/^[0-9a-f]{64}$/.test(input.envelopeHash))
    || (input.signerAgentId !== undefined && !agentId(input.signerAgentId))
    || (input.grantId !== undefined && !boundedString(input.grantId, 256))
    || (input.gatewayActionId !== undefined && !boundedString(input.gatewayActionId, 256))) {
    throw Object.assign(new TypeError('CONVERSATION_MESSAGE_INVALID'), { code: 'CONVERSATION_MESSAGE_INVALID' })
  }
  if (input.verification === 'verified'
    && (!input.envelopeHash || !input.signerAgentId || !input.grantId)) {
    throw Object.assign(new TypeError('CONVERSATION_MESSAGE_INVALID'), { code: 'CONVERSATION_MESSAGE_INVALID' })
  }
  return structuredClone(input)
}

function normalizedMessage(input, now) {
  const participants = { senderAgentId: input?.senderAgentId, recipientAgentIds: input?.recipientAgentIds }
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || !boundedString(input.messageId, 256)
    || !boundedString(input.conversationId, 256)
    || !agentId(participants.senderAgentId)
    || !Array.isArray(participants.recipientAgentIds)
    || participants.recipientAgentIds.length === 0
    || participants.recipientAgentIds.length > 16
    || participants.recipientAgentIds.some((value) => !agentId(value))
    || new Set(participants.recipientAgentIds).size !== participants.recipientAgentIds.length
    || (input.role !== undefined && !ROLES.has(input.role))
    || (input.role !== undefined && input.senderAgentId !== undefined && input.role !== roleFor(participants.senderAgentId))
    || (input.kind !== undefined && !KINDS.has(input.kind))
    || !boundedString(input.content)
    || (input.taskId !== undefined && !boundedString(input.taskId, 256))
    || (input.replyTo !== undefined && !boundedString(input.replyTo, 256))
    || (input.status !== undefined && !STATUSES.has(input.status))
    || (input.mode !== undefined && input.mode !== 'ask')
    || (input.requestId !== undefined && !boundedString(input.requestId, 256))
    || (input.requestHash !== undefined && !/^[0-9a-f]{64}$/.test(input.requestHash))
    || (input.failureCode !== undefined && !FAILURE_CODE.test(input.failureCode))
    || (input.createdAt !== undefined && (!boundedString(input.createdAt, 64) || Number.isNaN(Date.parse(input.createdAt))))) {
    throw Object.assign(new TypeError('CONVERSATION_MESSAGE_INVALID'), { code: 'CONVERSATION_MESSAGE_INVALID' })
  }
  if (input.kind === 'question' || input.kind === 'answer') {
    if (input.mode !== 'ask' || !input.requestId || !withinUtf8Bytes(input.content, 16 * 1024)) {
      throw Object.assign(new TypeError('CONVERSATION_MESSAGE_INVALID'), { code: 'CONVERSATION_MESSAGE_INVALID' })
    }
    if (input.kind === 'question' && !input.requestHash) {
      throw Object.assign(new TypeError('CONVERSATION_MESSAGE_INVALID'), { code: 'CONVERSATION_MESSAGE_INVALID' })
    }
  }
  return {
    schema: CONVERSATION_MESSAGE_SCHEMA,
    messageId: input.messageId,
    conversationId: input.conversationId,
    role: roleFor(participants.senderAgentId),
    senderAgentId: participants.senderAgentId,
    recipientAgentIds: [...participants.recipientAgentIds],
    kind: input.kind ?? 'message',
    content: input.content,
    status: input.status ?? 'sent',
    provenance: normalizedProvenance(input.provenance),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    ...(input.mode ? { mode: input.mode } : {}),
    ...(input.requestId ? { requestId: input.requestId } : {}),
    ...(input.requestHash ? { requestHash: input.requestHash } : {}),
    ...(input.failureCode ? { failureCode: input.failureCode } : {}),
    createdAt: input.createdAt ?? new Date(now()).toISOString(),
  }
}

export class DurableConversationLedger {
  #messages = []
  #messageIds = new Set()
  #asks = new Map()
  #writes = Promise.resolve()

  constructor({ filePath, audit, now = () => Date.now() }, token) {
    if (token !== OPEN_TOKEN) throw new TypeError('use DurableConversationLedger.open()')
    if (!boundedString(filePath, 4096) || !audit || typeof audit.append !== 'function') {
      throw new TypeError('conversation ledger requires file path and audit log')
    }
    this.filePath = resolve(filePath)
    this.audit = audit
    this.now = now
    this.closed = false
  }

  static async open(options) {
    const ledger = new DurableConversationLedger(options, OPEN_TOKEN)
    try {
      await mkdir(dirname(ledger.filePath), { recursive: true, mode: 0o700 })
      try {
        ledger.filePath = await realpath(ledger.filePath)
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
        ledger.filePath = join(await realpath(dirname(ledger.filePath)), basename(ledger.filePath))
      }
      if (OPEN_LEDGER_OWNERS.has(ledger.filePath)) {
        throw Object.assign(new Error('CONVERSATION_LEDGER_ALREADY_OPEN'), { code: 'CONVERSATION_LEDGER_ALREADY_OPEN' })
      }
      OPEN_LEDGER_OWNERS.set(ledger.filePath, ledger)
      try {
        const content = await readFile(ledger.filePath, 'utf8')
        for (const line of content.split('\n')) {
          if (!line.trim()) continue
          let parsed
          try { parsed = JSON.parse(line) } catch { throw new Error('CONVERSATION_HISTORY_INVALID') }
          ledger.#restore(parsed)
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      for (const record of ledger.#asks.values()) {
        if (record.status === 'pending') {
          record.status = 'unknown'
          record.failureCode = 'ASK_OUTCOME_UNKNOWN'
        }
      }
      return ledger
    } catch (error) {
      await ledger.close()
      throw error
    }
  }

  append(input) {
    return this.#mutate(async () => {
      const message = normalizedMessage(input, this.now)
      if (this.#messageIds.has(message.messageId)) {
        throw Object.assign(new Error('CONVERSATION_MESSAGE_EXISTS'), { code: 'CONVERSATION_MESSAGE_EXISTS' })
      }
      await appendFile(this.filePath, `${JSON.stringify(message)}\n`, { encoding: 'utf8', mode: 0o600, flush: true })
      this.#messages.push(message)
      this.#messageIds.add(message.messageId)
      await Promise.resolve(this.audit.append({
        kind: 'ceo.conversation.message',
        messageId: message.messageId,
        conversationId: message.conversationId,
        role: message.role,
        senderAgentId: message.senderAgentId,
        recipientAgentIds: [...message.recipientAgentIds],
        messageKind: message.kind,
        status: message.status,
        verification: message.provenance.verification,
        ...(message.taskId ? { taskId: message.taskId } : {}),
        at: message.createdAt,
      }))
      return structuredClone(message)
    })
  }

  beginAsk({ requestId, requestHash, message } = {}) {
    return this.#mutate(async () => {
      if (!boundedString(requestId, 256) || !/^[0-9a-f]{64}$/.test(requestHash ?? '')) {
        throw Object.assign(new TypeError('ASK_REQUEST_INVALID'), { code: 'ASK_REQUEST_INVALID' })
      }
      const normalized = normalizedMessage({
        ...message,
        kind: 'question',
        mode: 'ask',
        requestId,
        requestHash,
      }, this.now)
      if (normalized.senderAgentId !== 'rod'
        || normalized.recipientAgentIds.length !== 1
        || normalized.content.length === 0) {
        throw Object.assign(new TypeError('ASK_REQUEST_INVALID'), { code: 'ASK_REQUEST_INVALID' })
      }
      const existing = this.#asks.get(requestId)
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw Object.assign(new Error('ASK_REQUEST_CONFLICT'), { code: 'ASK_REQUEST_CONFLICT' })
        }
        return structuredClone(existing)
      }
      if (this.#messageIds.has(normalized.messageId)) {
        throw Object.assign(new Error('CONVERSATION_MESSAGE_EXISTS'), { code: 'CONVERSATION_MESSAGE_EXISTS' })
      }
      await appendFile(this.filePath, `${JSON.stringify(normalized)}\n`, { encoding: 'utf8', mode: 0o600, flush: true })
      this.#messages.push(normalized)
      this.#messageIds.add(normalized.messageId)
      const record = {
        requestId,
        requestHash,
        message: normalized,
        status: 'pending',
        answer: null,
        failureCode: null,
      }
      this.#asks.set(requestId, record)
      await this.#auditAsk('question', normalized)
      return structuredClone(record)
    })
  }

  finishAsk({ requestId, message, outcome = 'completed', failureCode = null } = {}) {
    return this.#mutate(async () => {
      if (!boundedString(requestId, 256)
        || !['completed', 'failed-not-sent'].includes(outcome)
        || (failureCode !== null && !FAILURE_CODE.test(failureCode))) {
        throw Object.assign(new TypeError('ASK_RESULT_INVALID'), { code: 'ASK_RESULT_INVALID' })
      }
      const existing = this.#asks.get(requestId)
      if (!existing) throw Object.assign(new Error('ASK_REQUEST_NOT_FOUND'), { code: 'ASK_REQUEST_NOT_FOUND' })
      const normalized = normalizedMessage({
        ...message,
        kind: 'answer',
        mode: 'ask',
        requestId,
        status: outcome === 'completed' ? 'completed' : 'failed',
        ...(failureCode ? { failureCode } : {}),
      }, this.now)
      if (normalized.conversationId !== existing.message.conversationId
        || normalized.senderAgentId !== existing.message.recipientAgentIds[0]
        || normalized.recipientAgentIds.length !== 1
        || normalized.recipientAgentIds[0] !== existing.message.senderAgentId
        || normalized.replyTo !== existing.message.messageId) {
        throw Object.assign(new Error('ASK_REQUEST_CONFLICT'), { code: 'ASK_REQUEST_CONFLICT' })
      }
      if (existing.status === 'unknown') {
        throw Object.assign(new Error('ASK_OUTCOME_UNKNOWN'), { code: 'ASK_OUTCOME_UNKNOWN' })
      }
      if (existing.status !== 'pending') {
        if (existing.answer?.messageId !== normalized.messageId
          || existing.answer?.content !== normalized.content
          || existing.answer?.status !== normalized.status) {
          throw Object.assign(new Error('ASK_REQUEST_CONFLICT'), { code: 'ASK_REQUEST_CONFLICT' })
        }
        return structuredClone(existing)
      }
      if (this.#messageIds.has(normalized.messageId)) {
        throw Object.assign(new Error('CONVERSATION_MESSAGE_EXISTS'), { code: 'CONVERSATION_MESSAGE_EXISTS' })
      }
      await appendFile(this.filePath, `${JSON.stringify(normalized)}\n`, { encoding: 'utf8', mode: 0o600, flush: true })
      this.#messages.push(normalized)
      this.#messageIds.add(normalized.messageId)
      const completed = {
        ...existing,
        status: outcome,
        answer: normalized,
        failureCode: failureCode ?? null,
      }
      this.#asks.set(requestId, completed)
      await this.#auditAsk('answer', normalized)
      return structuredClone(completed)
    })
  }

  async getAsk(requestId) {
    await this.#writes
    if (!boundedString(requestId, 256)) {
      throw Object.assign(new TypeError('ASK_REQUEST_INVALID'), { code: 'ASK_REQUEST_INVALID' })
    }
    const existing = this.#asks.get(requestId)
    if (!existing) return null
    return structuredClone(existing)
  }

  list(conversationId = 'main', options = {}) {
    if (!boundedString(conversationId, 256)) throw Object.assign(new TypeError('CONVERSATION_ID_INVALID'), { code: 'CONVERSATION_ID_INVALID' })
    return this.#page(this.#messages.filter((message) => message.conversationId === conversationId), options)
  }

  listAll(options = {}) {
    return this.#page(this.#messages, options)
  }

  // Admission replay must resolve the exact durable message pointer.  Do not
  // approximate this with a bounded history page: a receipt may refer to an
  // older message that is no longer in the caller's latest page.
  getMessage(messageId) {
    if (!boundedString(messageId, 256)) return null
    const message = this.#messages.find((candidate) => candidate.messageId === messageId)
    return message ? structuredClone(message) : null
  }

  #page(messages, { limit = Infinity, before = null } = {}) {
    if (limit !== Infinity && (!Number.isSafeInteger(limit) || limit < 1)) throw Object.assign(new TypeError('CONVERSATION_LIST_LIMIT_INVALID'), { code: 'CONVERSATION_LIST_LIMIT_INVALID' })
    const end = before === null ? messages.length : messages.findIndex((message) => message.messageId === before)
    if (end < 0) throw Object.assign(new TypeError('CONVERSATION_LIST_CURSOR_INVALID'), { code: 'CONVERSATION_LIST_CURSOR_INVALID' })
    return messages.slice(limit === Infinity ? 0 : Math.max(0, end - limit), end).map((message) => structuredClone(message))
  }

  async close() {
    if (this.closed) return
    await this.#writes
    this.closed = true
    if (OPEN_LEDGER_OWNERS.get(this.filePath) === this) OPEN_LEDGER_OWNERS.delete(this.filePath)
  }

  #mutate(operation) {
    const guarded = () => {
      if (this.closed) throw new Error('CONVERSATION_LEDGER_CLOSED')
      return operation()
    }
    const result = this.#writes.then(guarded, guarded)
    this.#writes = result.catch(() => {})
    return result
  }

  async #auditAsk(messageKind, message) {
    await this.audit.append({
      kind: 'ceo.conversation.message',
      messageId: message.messageId,
      conversationId: message.conversationId,
      role: message.role,
      senderAgentId: message.senderAgentId,
      recipientAgentIds: [...message.recipientAgentIds],
      messageKind,
      status: message.status,
      mode: 'ask',
      requestId: message.requestId,
      verification: message.provenance.verification,
      at: message.createdAt,
    })
  }

  #restore(input) {
    let message
    try {
      if (![CONVERSATION_MESSAGE_SCHEMA, LEGACY_CONVERSATION_MESSAGE_SCHEMA].includes(input?.schema)
        || !boundedString(input.createdAt, 64) || Number.isNaN(Date.parse(input.createdAt))) throw new Error('invalid')
      message = normalizedMessage(input.schema === LEGACY_CONVERSATION_MESSAGE_SCHEMA
        ? {
            ...input,
            ...legacyParticipants(input.role),
            kind: 'message',
            provenance: { verification: 'legacy', source: 'conversation-v1-restore' },
          }
        : {
            ...input,
            provenance: input.provenance ?? { verification: 'legacy', source: 'conversation-v2-pre-provenance' },
          }, this.now)
    } catch {
      throw new Error('CONVERSATION_HISTORY_INVALID')
    }
    if (this.#messageIds.has(message.messageId)) throw new Error('CONVERSATION_HISTORY_INVALID')
    this.#messages.push(message)
    this.#messageIds.add(message.messageId)
    if (message.kind === 'question') {
      if (this.#asks.has(message.requestId)) throw new Error('CONVERSATION_HISTORY_INVALID')
      this.#asks.set(message.requestId, {
        requestId: message.requestId,
        requestHash: message.requestHash,
        message,
        status: 'pending',
        answer: null,
        failureCode: null,
      })
    } else if (message.kind === 'answer') {
      const existing = this.#asks.get(message.requestId)
      if (!existing || existing.answer || message.replyTo !== existing.message.messageId
        || message.conversationId !== existing.message.conversationId
        || message.senderAgentId !== existing.message.recipientAgentIds[0]
        || message.recipientAgentIds.length !== 1
        || message.recipientAgentIds[0] !== existing.message.senderAgentId) {
        throw new Error('CONVERSATION_HISTORY_INVALID')
      }
      this.#asks.set(message.requestId, {
        ...existing,
        status: message.status === 'completed' ? 'completed' : 'failed-not-sent',
        answer: message,
        failureCode: message.failureCode ?? null,
      })
    }
  }
}
