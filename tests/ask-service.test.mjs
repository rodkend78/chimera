import assert from 'node:assert/strict'
import test from 'node:test'
import { sha256 } from '../src/canonical.mjs'
import {
  AskService,
  ASK_RESULT_SCHEMA,
  createAskModelProvider,
  validateAskRequest,
} from '../src/ceo/ask-service.mjs'

const input = {
  requestId: 'ask-1',
  conversationId: 'agent:ace',
  recipientAgentId: 'ace',
  content: 'Explain this design.',
}

test('Ask accepts only the pure request shape and bounds content by UTF-8 bytes', () => {
  assert.deepEqual(validateAskRequest(input), input)
  assert.throws(() => validateAskRequest({ ...input, toolCall: { name: 'bash' } }), /ASK_REQUEST_INVALID/)
  assert.throws(() => validateAskRequest({ ...input, taskId: 'execute-this' }), /ASK_REQUEST_INVALID/)
  assert.throws(() => validateAskRequest({ ...input, tasks: [] }), /ASK_REQUEST_INVALID/)
  assert.throws(() => validateAskRequest({ ...input, content: '🙂'.repeat(16 * 1024) }), /ASK_REQUEST_INVALID/)
})

test('Ask returns a bounded answer and persists the canonical request before invoking the router', async () => {
  const events = []
  const history = {
    async getAsk() { return null },
    async beginAsk(record) {
      events.push({ kind: 'begin', record })
      return { requestId: record.requestId, requestHash: record.requestHash, message: record.message, status: 'pending', answer: null, failureCode: null }
    },
    async finishAsk(record) {
      events.push({ kind: 'finish', record })
      return {
        requestId: record.requestId,
        requestHash: events[0].record.requestHash,
        message: events[0].record.message,
        status: record.outcome,
        answer: record.message,
        failureCode: record.failureCode ?? null,
      }
    },
  }
  const router = {
    routerId: 'openai-compatible:fixture:ask',
    async route(prompt, context) {
      events.push({ kind: 'route', prompt, context })
      return { answer: 'A bounded answer.' }
    },
  }
  const service = new AskService({
    history,
    resolveInvocation: async ({ recipientAgentId, requestId }) => ({
      router,
      agentId: recipientAgentId,
      context: { agentContinuity: { agentId: recipientAgentId }, askRequestId: requestId },
      descriptor: { providerId: 'fixture', model: 'ask', protocol: 'fixture', execution: 'inference-only' },
    }),
    now: () => Date.parse('2026-09-19T00:00:00.000Z'),
  })

  const result = await service.ask(input)
  assert.equal(result.schema, ASK_RESULT_SCHEMA)
  assert.deepEqual(result, {
    schema: 'chimera.ask-result.v1',
    requestId: 'ask-1',
    conversationId: 'agent:ace',
    recipientAgentId: 'ace',
    status: 'completed',
    messageId: result.messageId,
    answer: 'A bounded answer.',
    failureCode: null,
  })
  assert.deepEqual(events.map(({ kind }) => kind), ['begin', 'route', 'finish'])
  assert.equal(events[0].record.message.kind, 'question')
  assert.equal(events[0].record.message.mode, 'ask')
  assert.equal(events[0].record.message.requestId, 'ask-1')
  assert.equal(events[2].record.message.kind, 'answer')
  assert.equal(events[2].record.message.replyTo, events[0].record.message.messageId)
})

test('Ask exact repeats return durable state before authorization or provider dispatch', async () => {
  let resolverCalls = 0
  const requestHash = sha256({ conversationId: 'agent:ace', recipientAgentId: 'ace', content: input.content })
  const durable = {
    requestId: 'ask-repeat',
    requestHash,
    message: {
      messageId: 'message-repeat-question',
      conversationId: 'agent:ace',
      senderAgentId: 'rod',
      recipientAgentIds: ['ace'],
      kind: 'question',
      mode: 'ask',
      requestId: 'ask-repeat',
      content: input.content,
      status: 'completed',
    },
    answer: {
      messageId: 'message-repeat-answer',
      conversationId: 'agent:ace',
      senderAgentId: 'ace',
      recipientAgentIds: ['rod'],
      kind: 'answer',
      mode: 'ask',
      requestId: 'ask-repeat',
      replyTo: 'message-repeat-question',
      content: 'Durable answer.',
      status: 'completed',
    },
    status: 'completed',
  }
  const service = new AskService({
    history: {
      async getAsk() { return structuredClone(durable) },
      async beginAsk() { throw new Error('must not begin exact repeat') },
      async finishAsk() { throw new Error('must not finish exact repeat') },
    },
    resolveInvocation: async () => { resolverCalls += 1; throw new Error('must not resolve exact repeat') },
  })

  const result = await service.ask({ ...input, requestId: 'ask-repeat' })
  assert.equal(result.status, 'completed')
  assert.equal(result.answer, 'Durable answer.')
  assert.equal(resolverCalls, 0)
})

test('Ask restored pending requests are unknown and cannot be retried', async () => {
  let resolverCalls = 0
  const requestHash = sha256({ conversationId: 'agent:ace', recipientAgentId: 'ace', content: input.content })
  const service = new AskService({
    history: {
      async getAsk() {
        return {
          requestId: 'ask-unknown',
          requestHash,
          message: { messageId: 'question-unknown', conversationId: 'agent:ace', senderAgentId: 'rod', recipientAgentIds: ['ace'], kind: 'question', mode: 'ask', requestId: 'ask-unknown', content: input.content, status: 'sent' },
          status: 'unknown',
        }
      },
      async beginAsk() { throw new Error('must not retry unknown') },
      async finishAsk() { throw new Error('must not finish unknown') },
    },
    resolveInvocation: async () => { resolverCalls += 1; throw new Error('must not resolve unknown') },
  })

  const result = await service.ask({ ...input, requestId: 'ask-unknown' })
  assert.equal(result.status, 'unknown')
  assert.equal(result.answer, null)
  assert.equal(result.failureCode, 'ASK_OUTCOME_UNKNOWN')
  assert.equal(resolverCalls, 0)
})

test('Ask reserves same request id before its first durable lookup and shares one dispatch', async () => {
  let releaseLookup
  const lookupHeld = new Promise(resolve => { releaseLookup = resolve })
  let lookupCalls = 0
  let resolverCalls = 0
  let routeCalls = 0
  const history = {
    async getAsk() {
      lookupCalls += 1
      await lookupHeld
      return null
    },
    async beginAsk(record) {
      return { requestId: record.requestId, requestHash: record.requestHash, message: record.message, status: 'pending', answer: null, failureCode: null }
    },
    async finishAsk(record) {
      return {
        requestId: record.requestId,
        requestHash: record.message.requestHash,
        message: record.message,
        status: record.outcome,
        answer: record.message,
        failureCode: record.failureCode ?? null,
      }
    },
  }
  const service = new AskService({
    history,
    resolveInvocation: async ({ recipientAgentId }) => {
      resolverCalls += 1
      return {
        router: {
          routerId: 'fixture:single-flight',
          async route() {
            routeCalls += 1
            return { answer: 'one answer' }
          },
        },
        agentId: recipientAgentId,
        context: {},
        descriptor: { execution: 'inference-only' },
      }
    },
  })

  const first = service.ask({ ...input, requestId: 'ask-single-flight' })
  await new Promise(resolve => setImmediate(resolve))
  const second = service.ask({ ...input, requestId: 'ask-single-flight' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(lookupCalls, 1)
  releaseLookup()
  const results = await Promise.all([first, second])
  assert.deepEqual(results[0], results[1])
  assert.equal(resolverCalls, 1)
  assert.equal(routeCalls, 1)
})

test('Ask rejects a concurrent same-id different-content request before any second lookup', async () => {
  let releaseLookup
  const lookupHeld = new Promise(resolve => { releaseLookup = resolve })
  let lookupCalls = 0
  const history = {
    async getAsk() {
      lookupCalls += 1
      await lookupHeld
      return null
    },
    async beginAsk(record) {
      return { requestId: record.requestId, requestHash: record.requestHash, message: record.message, status: 'pending', answer: null, failureCode: null }
    },
    async finishAsk(record) {
      return { requestId: record.requestId, requestHash: record.message.requestHash, message: record.message, status: record.outcome, answer: record.message, failureCode: null }
    },
  }
  const service = new AskService({
    history,
    resolveInvocation: async ({ recipientAgentId }) => ({
      router: { routerId: 'fixture:conflict', async route() { return { answer: 'answer' } } },
      agentId: recipientAgentId,
      context: {},
      descriptor: { execution: 'inference-only' },
    }),
  })
  const first = service.ask({ ...input, requestId: 'ask-collision', content: 'first content' })
  await new Promise(resolve => setImmediate(resolve))
  await assert.rejects(
    service.ask({ ...input, requestId: 'ask-collision', content: 'second content' }),
    /ASK_REQUEST_CONFLICT/,
  )
  assert.equal(lookupCalls, 1)
  releaseLookup()
  await first
})

test('Ask provider redacts provider output before the reliable ledger can persist it', async () => {
  let calls = 0
  const provider = createAskModelProvider({
    routerId: 'fixture:redaction',
    descriptor: { execution: 'inference-only' },
    async route() {
      calls += 1
      return { answer: 'Bearer sk-live-012345678901234567890123456789' }
    },
  })
  const output = await provider.route('question', {})
  assert.equal(calls, 1)
  assert.equal(output.answer.includes('sk-live-'), false)
  assert.match(output.answer, /REDACTED/)
})

test('Ask status is a read-only durable projection and never resolves or dispatches', async () => {
  let resolverCalls = 0
  let lookupCalls = 0
  const service = new AskService({
    history: {
      async getAsk(requestId) {
        lookupCalls += 1
        return {
          requestId,
          requestHash: 'e'.repeat(64),
          message: {
            messageId: 'status-question', conversationId: 'main', senderAgentId: 'rod', recipientAgentIds: ['ceo'],
            kind: 'question', mode: 'ask', requestId, content: 'Status only.', status: 'sent',
          },
          status: 'unknown', answer: null, failureCode: 'ASK_OUTCOME_UNKNOWN',
        }
      },
      async beginAsk() { throw new Error('status must not reserve') },
      async finishAsk() { throw new Error('status must not finish') },
    },
    resolveInvocation: async () => { resolverCalls += 1; throw new Error('status must not resolve') },
  })
  assert.equal((await service.status('status-1')).status, 'unknown')
  assert.equal(lookupCalls, 1)
  assert.equal(resolverCalls, 0)
})

test('Ask treats malformed post-dispatch model output as unknown and never retries it', async () => {
  let record = null
  let routeCalls = 0
  const history = {
    async getAsk() { return record && structuredClone(record) },
    async beginAsk(next) {
      record = { requestId: next.requestId, requestHash: next.requestHash, message: next.message, status: 'pending', answer: null, failureCode: null }
      return structuredClone(record)
    },
    async finishAsk() { throw new Error('malformed output must not be terminally completed') },
  }
  const service = new AskService({
    history,
    resolveInvocation: async ({ recipientAgentId }) => ({
      router: {
        routerId: 'fixture:malformed',
        async route() { routeCalls += 1; return { answer: 'not enough', toolCall: { name: 'write' } } },
      },
      agentId: recipientAgentId,
      context: {},
      descriptor: { execution: 'inference-only' },
    }),
  })
  const request = { requestId: 'ask-malformed', conversationId: 'main', recipientAgentId: 'ceo', content: 'Reject tool-shaped output.' }
  const first = await service.ask(request)
  assert.equal(first.status, 'unknown')
  const second = await service.ask(request)
  assert.equal(second.status, 'unknown')
  assert.equal(routeCalls, 1)
})
