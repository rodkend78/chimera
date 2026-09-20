import crypto from 'node:crypto'
import { sha256 } from '../canonical.mjs'
import { redactSensitiveText } from '../security/redaction.mjs'
import { isTrustedModelCallNotSentError } from './model-call-errors.mjs'
import { validateModelRouter } from './model-router.mjs'
import { validateAskModelResponse } from './structured-model-output.mjs'

export const ASK_RESULT_SCHEMA = 'chimera.ask-result.v1'
const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const FAILURE_CODE = /^[A-Z][A-Z0-9_]{2,127}$/
const MAX_CONTEXT_BYTES = 256 * 1024
const FORBIDDEN_CONTEXT_KEYS = new Set([
  'taskId', 'tasks', 'toolCall', 'tools', 'project', 'projectId', 'browser', 'lease',
  'grant', 'approval', 'callback', 'dispatcher', 'worker', 'nativeExecutor', 'executor',
  'signal', 'steering', 'history', 'peers', 'eligiblePeers',
])

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function boundedString(value, maximum = 256) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function withinUtf8Bytes(value, maximum) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= maximum
}

function fail(code, message = code) {
  return Object.assign(new Error(message), { code })
}

function safeFailureCode(error, fallback = 'ASK_PROVIDER_FAILURE') {
  return FAILURE_CODE.test(error?.code ?? '') ? error.code : fallback
}

function canonicalRoom(recipientAgentId) {
  return recipientAgentId === 'ceo' ? 'main' : `agent:${recipientAgentId}`
}

function assertPlainRecord(value, code) {
  if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) throw fail(code)
}

function assertContextSafe(context, requestId) {
  assertPlainRecord(context, 'ASK_CONTEXT_INVALID')
  const walk = (value) => {
    if (typeof value === 'function' || typeof value === 'symbol') throw fail('ASK_CONTEXT_INVALID')
    if (Array.isArray(value)) return value.forEach(walk)
    if (!value || typeof value !== 'object') return
    if (Object.getPrototypeOf(value) !== Object.prototype) throw fail('ASK_CONTEXT_INVALID')
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_CONTEXT_KEYS.has(key)) throw fail('ASK_CONTEXT_INVALID')
      walk(child)
    }
  }
  walk(context)
  if (context.askRequestId !== undefined && context.askRequestId !== requestId) throw fail('ASK_CONTEXT_INVALID')
  let encoded
  try { encoded = JSON.stringify(context) } catch { throw fail('ASK_CONTEXT_INVALID') }
  if (!withinUtf8Bytes(encoded, MAX_CONTEXT_BYTES)) throw fail('ASK_CONTEXT_INVALID')
}

function answerMessage({ requestId, conversationId, agentId, question, answer, now }) {
  return {
    messageId: `ask-answer-${crypto.randomUUID()}`,
    conversationId,
    senderAgentId: agentId,
    recipientAgentIds: ['rod'],
    kind: 'answer',
    mode: 'ask',
    requestId,
    replyTo: question.messageId,
    content: redactSensitiveText(answer),
    status: 'completed',
    provenance: { verification: 'derived', source: 'ask-inference' },
    createdAt: new Date(now()).toISOString(),
  }
}

function failureMessage({ requestId, conversationId, agentId, question, now, failureCode }) {
  return {
    messageId: `ask-failure-${crypto.randomUUID()}`,
    conversationId,
    senderAgentId: agentId,
    recipientAgentIds: ['rod'],
    kind: 'answer',
    mode: 'ask',
    requestId,
    replyTo: question.messageId,
    content: 'Ask was not dispatched.',
    status: 'failed',
    failureCode,
    provenance: { verification: 'derived', source: 'ask-inference' },
    createdAt: new Date(now()).toISOString(),
  }
}

function resultFromRecord(record) {
  const question = record?.message
  const answer = record?.answer
  const status = record?.status === 'pending' ? 'unknown' : record?.status
  return {
    schema: ASK_RESULT_SCHEMA,
    requestId: record.requestId,
    conversationId: question?.conversationId ?? null,
    recipientAgentId: question?.recipientAgentIds?.[0] ?? null,
    status: ['completed', 'failed-not-sent', 'unknown'].includes(status) ? status : 'unknown',
    messageId: answer?.messageId ?? question?.messageId ?? null,
    answer: status === 'completed' ? answer?.content ?? null : null,
    failureCode: status === 'completed' ? null : record?.failureCode ?? (status === 'unknown' ? 'ASK_OUTCOME_UNKNOWN' : 'ASK_FAILED'),
  }
}

export function validateAskRequest(input) {
  assertPlainRecord(input, 'ASK_REQUEST_INVALID')
  const fields = ['requestId', 'conversationId', 'recipientAgentId', 'content']
  if (Object.keys(input).length !== fields.length || Object.keys(input).some((key) => !fields.includes(key))) {
    throw fail('ASK_REQUEST_INVALID')
  }
  if (!boundedString(input.requestId)
    || !boundedString(input.conversationId)
    || !AGENT_ID.test(input.recipientAgentId ?? '')
    || !withinUtf8Bytes(input.content, 16 * 1024)) {
    throw fail('ASK_REQUEST_INVALID')
  }
  return structuredClone(input)
}

export function createAskModelProvider(provider) {
  const routed = validateModelRouter(provider)
  if (!isRecord(routed.descriptor) || routed.descriptor.execution !== 'inference-only') {
    throw fail('ASK_EXECUTOR_NOT_PURE')
  }
  return validateModelRouter(Object.freeze({
    routerId: routed.routerId,
    descriptor: routed.descriptor,
    async route(prompt, context = {}) {
      try {
        const output = validateAskModelResponse(await routed.route(prompt, context))
        // This is the Ask-specific leaf boundary.  ReliableModelRouter
        // persists provider results before AskService sees them, so sanitize
        // the answer here rather than relying on the conversation projection.
        return { answer: redactSensitiveText(output.answer) }
      } catch (error) {
        // Preserve the identity of a runtime-owned trusted pre-dispatch fence;
        // the gateway relies on its WeakSet marker for failed-not-sent status.
        if (isTrustedModelCallNotSentError(error)) throw error
        const safe = new Error(redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 1024) || 'Ask provider failed')
        safe.name = error?.name === 'ModelCallOutcomeUnknownError' ? error.name : 'AskProviderError'
        safe.code = safeFailureCode(error)
        // Provider-supplied dispatch flags are intentionally not copied. Once
        // this route has been authorized, an ordinary failure is conservative.
        throw safe
      }
    },
  }))
}

export class AskService {
  #inFlight = new Map()

  constructor({ resolveInvocation, history, now = () => Date.now() } = {}) {
    if (typeof resolveInvocation !== 'function' || !history
      || typeof history.getAsk !== 'function'
      || typeof history.beginAsk !== 'function'
      || typeof history.finishAsk !== 'function') {
      throw new TypeError('Ask service requires invocation resolver and durable history')
    }
    this.resolveInvocation = resolveInvocation
    this.history = history
    this.now = now
  }

  async status(requestId) {
    if (!boundedString(requestId, 256)) throw fail('ASK_REQUEST_INVALID')
    const record = await this.history.getAsk(requestId)
    return record ? resultFromRecord(record) : null
  }

  async ask(input) {
    const request = validateAskRequest(input)
    const expectedRoom = canonicalRoom(request.recipientAgentId)
    if (request.conversationId !== expectedRoom) throw fail('ASK_CONVERSATION_MISMATCH')
    const requestHash = sha256({
      conversationId: expectedRoom,
      recipientAgentId: request.recipientAgentId,
      content: request.content,
    })
    const active = this.#inFlight.get(request.requestId)
    if (active) {
      if (active.requestHash !== requestHash) throw fail('ASK_REQUEST_CONFLICT')
      return active.promise
    }
    const promise = this.#start(request, expectedRoom, requestHash)
    this.#inFlight.set(request.requestId, { requestHash, promise })
    try {
      return await promise
    } finally {
      if (this.#inFlight.get(request.requestId)?.promise === promise) this.#inFlight.delete(request.requestId)
    }
  }

  async #start(request, conversationId, requestHash) {
    const existing = await this.history.getAsk(request.requestId)
    if (existing) {
      if (existing.requestHash !== requestHash) throw fail('ASK_REQUEST_CONFLICT')
      if (existing.status !== 'pending') return resultFromRecord(existing)
      // A pending row without a live in-process operation is the conservative
      // projection of a lost/unknown dispatch. Never replay it automatically.
      return resultFromRecord({ ...existing, status: 'unknown', failureCode: 'ASK_OUTCOME_UNKNOWN' })
    }
    return this.#run(request, conversationId, requestHash)
  }

  async #run(request, conversationId, requestHash) {
    const question = {
      messageId: `ask-question-${crypto.randomUUID()}`,
      conversationId,
      senderAgentId: 'rod',
      recipientAgentIds: [request.recipientAgentId],
      kind: 'question',
      mode: 'ask',
      requestId: request.requestId,
      requestHash,
      content: redactSensitiveText(request.content),
      status: 'sent',
      provenance: { verification: 'human', source: 'ask-composer' },
      createdAt: new Date(this.now()).toISOString(),
    }
    const reservation = await this.history.beginAsk({ requestId: request.requestId, requestHash, message: question })
    if (reservation.requestHash !== requestHash) throw fail('ASK_REQUEST_CONFLICT')
    if (reservation.status !== 'pending') return resultFromRecord(reservation)
    let invocation
    let dispatched = false
    try {
      invocation = await this.resolveInvocation({ recipientAgentId: request.recipientAgentId, requestId: request.requestId })
      if (!isRecord(invocation)
        || invocation.agentId !== request.recipientAgentId
        || !invocation.router
        || typeof invocation.router.route !== 'function'
        || !isRecord(invocation.descriptor)
        || invocation.descriptor.execution !== 'inference-only') {
        throw fail('ASK_EXECUTOR_NOT_PURE')
      }
      assertContextSafe(invocation.context ?? {}, request.requestId)
      const context = { ...structuredClone(invocation.context ?? {}), stage: 'ask', askRequestId: request.requestId }
      dispatched = true
      const output = validateAskModelResponse(await invocation.router.route(request.content, context))
      const answer = answerMessage({
        requestId: request.requestId,
        conversationId,
        agentId: invocation.agentId,
        question: reservation.message,
        answer: output.answer,
        now: this.now,
      })
      const completed = await this.history.finishAsk({ requestId: request.requestId, message: answer, outcome: 'completed' })
      return resultFromRecord(completed)
    } catch (error) {
      const failureCode = safeFailureCode(error, 'ASK_EXECUTOR_NOT_PURE')
      if (!dispatched || isTrustedModelCallNotSentError(error)) {
        const failure = failureMessage({
          requestId: request.requestId,
          conversationId,
          agentId: invocation?.agentId ?? request.recipientAgentId,
          question: reservation.message,
          now: this.now,
          failureCode,
        })
        const completed = await this.history.finishAsk({
          requestId: request.requestId,
          message: failure,
          outcome: 'failed-not-sent',
          failureCode,
        })
        return resultFromRecord(completed)
      }
      return resultFromRecord({
        ...reservation,
        status: 'unknown',
        failureCode: 'ASK_OUTCOME_UNKNOWN',
      })
    }
  }
}
