import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoryAuditLog } from '../src/audit-log.mjs'
import { createGatewayModelRouter } from '../src/ceo/gateway-model-router.mjs'
import { createJevDecisionService, createJevModelRouter } from '../src/ceo/jev-decision.mjs'
import { createDeterministicModelRouter } from '../src/ceo/model-router.mjs'
import { createReliableModelRouter, DurableModelCallLedger } from '../src/ceo/reliable-model-router.mjs'
import { createTaskAwareModelRouter } from '../src/ceo/task-aware-model-router.mjs'
import { runBoundedAgentLoop } from '../src/agents/bounded-work-loop.mjs'
import { ChimeraGateway } from '../src/gateway.mjs'
import { exportPublicKey, fingerprint, generateIdentity, signGrant } from '../src/identity.mjs'

test('Jev uses TypeSafe System One typed questions and returns bounded decisions', async () => {
  const calls = []
  const provider = createJevModelRouter({ apiKey: 'test-key', fetchImpl: async (url, request) => {
    calls.push({ url, request })
    return { ok: true, async json() { return { answers: {
      selected: { type: 'choice', choice: 'research', confidence: 0.91,
        probabilities: { research: 0.92, coding: 0.08 } },
      urgency: { type: 'score', score: 1, confidence: 0.83, probabilities: { 0: 0.1, 1: 0.9 } },
      needs_review: { type: 'noul', noul: 0.22 },
    } } } }
  } })
  const audit = new MemoryAuditLog()
  const service = createJevDecisionService({ router: provider, audit })
  const result = await service.decide({ state: 'Review this request', taskId: 'task-1', questions: {
    selected: { type: 'choice', instructions: 'Best handler', criteria: { research: 'Research', coding: 'Code' } },
    urgency: { type: 'score', instructions: 'Urgency', criteria: ['Low', 'High'] },
    needs_review: { type: 'noul', instructions: 'Needs review?' },
  } })
  assert.equal(calls[0].url, 'https://api.typesafe.ai/v1/systemone')
  assert.equal(calls[0].request.headers.Authorization, 'Bearer test-key')
  const sent = JSON.parse(calls[0].request.body)
  assert.equal(sent.model, 'jev-latest')
  assert.equal(sent.state, 'Review this request')
  assert.equal(sent.questions.selected.type, 'choice')
  assert.equal(result.answers.selected.choice, 'research')
  assert.equal(result.answers.selected.usable, true)
  assert.equal(result.answers.urgency.probabilities[1], 0.9)
  assert.equal(result.answers.needs_review.usable, true)
  assert.equal(result.answers.needs_review.certainty, 0.78)
  assert.equal(Object.hasOwn(result.answers.needs_review, 'confidence'), false)
  assert.equal(audit.entries().some((entry) => JSON.stringify(entry.fact).includes('test-key')), false)
})

test('Jev rejects an answer outside the offered choices and marks uncertainty', async () => {
  const invalid = createJevModelRouter({ apiKey: 'test-key', fetchImpl: async () => ({ ok: true,
    async json() { return { answers: { selected: { type: 'choice', choice: 'unoffered', confidence: 1,
      probabilities: { unoffered: 1 } } } } } }) })
  await assert.rejects(invalid.route(JSON.stringify({ state: 'route', questions: {
    selected: { type: 'choice', instructions: 'Choose', criteria: { one: 'One', two: 'Two' } },
  } })), { code: 'JEV_RESPONSE_INVALID' })

  const service = createJevDecisionService({ router: createDeterministicModelRouter({ responder: async () => ({
    selected: { type: 'choice', choice: 'one', confidence: 0.52, probabilities: { one: 0.52, two: 0.48 } },
  }) }), audit: new MemoryAuditLog() })
  assert.equal(await service.choose({ state: 'uncertain', criteria: { one: 'One', two: 'Two' },
    taskId: 'task-2', use: 'model-route' }), null)
})

test('Jev rejects an oversized provider response before parsing it', async () => {
  const provider = createJevModelRouter({ apiKey: 'test-key', fetchImpl: async () => new Response('x'.repeat(65_537)) })
  await assert.rejects(provider.route(JSON.stringify({ state: 'bounded', questions: {
    ready: { type: 'noul', instructions: 'Ready?' },
  } })), { code: 'JEV_RESPONSE_INVALID' })
})

test('Jev invocation is signed, authorized and journaled before TypeSafe receives data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-jev-gateway-'))
  try {
    const now = Date.parse('2026-09-23T12:00:00.000Z')
    const audit = new MemoryAuditLog()
    const human = generateIdentity('rod')
    const agent = generateIdentity('ceo')
    const gateway = new ChimeraGateway({ policy: { version: 1, defaultTier: 'blocked', rules: [{
      id: 'model', capability: 'model.invoke', resourcePrefix: 'model:', tier: 'auto',
    }] }, humanKeys: [[human.keyId, exportPublicKey(human.publicKey)]], audit, now: () => now })
    const grant = signGrant({ grantId: 'jev-grant', humanId: 'rod', agentId: 'ceo',
      agentKeyFingerprint: fingerprint(agent.publicKey), maxTier: 'auto',
      scopes: [{ capability: 'model.invoke', resource: 'model:model-fabric:jev-decision' }],
      issuedAt: '2026-09-23T11:55:00.000Z', expiresAt: '2026-09-23T12:30:00.000Z',
    }, human)
    let requests = 0
    const provider = createJevModelRouter({ apiKey: 'test-key', fetchImpl: async () => {
      requests++
      return { ok: true, async json() { return { answers: {
        selected: { type: 'choice', choice: 'one', confidence: 0.95,
          probabilities: { one: 0.95, two: 0.05 } },
      } } } }
    } })
    const ledger = await DurableModelCallLedger.open({ filePath: join(directory, 'calls.jsonl'), audit, now: () => now })
    const router = createReliableModelRouter({ provider: createGatewayModelRouter({ provider,
      gateway, grant, identity: agent, audit, agentId: 'ceo', now: () => now }), ledger, audit, now: () => now })
    const service = createJevDecisionService({ router, audit, now: () => now })
    const input = { state: 'Route this narrow request', criteria: { one: 'One', two: 'Two' },
      taskId: 'task-gateway', use: 'model-route' }
    assert.equal((await service.choose(input)).choice, 'one')
    assert.equal((await service.choose(input)).choice, 'one')
    assert.equal(requests, 1)
    assert.equal(audit.entries().some((entry) => entry.fact.kind === 'model.call.authorized'
      && entry.fact.resource === 'model:model-fabric:jev-decision'), true)
    assert.equal(audit.entries().some((entry) => entry.fact.kind === 'model.call.replayed'), true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('Jev can select only an eligible model and uncertainty preserves deterministic routing', async () => {
  const audit = new MemoryAuditLog()
  const routes = ['first', 'second', 'wrong-capability'].map((id) => ({ id,
    capabilities: [id === 'wrong-capability' ? 'research' : 'coding'], costClass: 'low',
    router: createDeterministicModelRouter({ routerId: id, responder: async () => ({ selected: id }) }),
  }))
  const chosen = createTaskAwareModelRouter({ routes, audit, decisionService: {
    async choose({ criteria }) {
      assert.deepEqual(Object.keys(criteria), ['route0', 'route1'])
      return { choice: 'route1', confidence: 0.9 }
    },
  }, eligibility: () => ({ connectionEnabled: true, agentAllowed: true, executorAllowed: true,
    requirementsSatisfied: true, pinSatisfied: true }) })
  assert.equal((await chosen.route('Implement this.', { taskId: 'task-3' })).selected, 'second')
  const fallback = createTaskAwareModelRouter({ routes, audit, decisionService: {
    async choose() { throw Object.assign(new Error('down'), { code: 'JEV_TRANSPORT_FAILED' }) },
  }, eligibility: () => ({ connectionEnabled: true, agentAllowed: true, executorAllowed: true,
    requirementsSatisfied: true, pinSatisfied: true }) })
  assert.equal((await fallback.route('Implement this.', { taskId: 'task-4' })).selected, 'first')
  assert.equal(audit.entries().some((entry) => entry.fact.kind === 'jev.decision.fallback'), true)
})

test('Jev sees only trusted eligible routes and cannot override a pinned model', async () => {
  const calls = []
  const routes = ['allowed-a', 'allowed-b', 'denied'].map(id => ({ id, providerId: 'fixture', model: id,
    capabilities: ['coding'], costClass: 'low', router: createDeterministicModelRouter({
      routerId: id, responder: async () => ({ selected: id }),
    }) }))
  const router = createTaskAwareModelRouter({ routes, audit: new MemoryAuditLog(),
    eligibility: route => ({ connectionEnabled: route.id !== 'denied', agentAllowed: true,
      executorAllowed: true, requirementsSatisfied: true, pinSatisfied: true }),
    decisionService: { async choose({ criteria }) {
      calls.push(criteria)
      return { choice: 'route1', confidence: 0.99 }
    } },
  })
  const pending = router.explain({ prompt: 'Implement this.', context: { taskId: 'task-route' } })
  assert.equal(pending.selected, null)
  assert.match(pending.reasons[0], /Jev selection pending/)
  assert.equal((await router.route('Implement this.', { taskId: 'task-route' })).selected, 'allowed-b')
  assert.equal(Object.values(calls[0]).some(value => value.includes('denied')), false)
  const pinned = { capabilities: ['coding'], modelPreference: { mode: 'pinned', providerId: 'fixture', model: 'allowed-a' } }
  assert.equal((await router.route('Implement this.', { taskId: 'task-pinned', requirements: pinned })).selected, 'allowed-a')
  assert.equal(calls.length, 1)
})

test('bounded worker uses Jev as a typed decision tool without invoking a worker effect', async () => {
  const observed = []
  const result = await runBoundedAgentLoop({
    router: createDeterministicModelRouter({ responder: async (_prompt, context) => {
      observed.push(context)
      return context.loop.turn === 1
        ? { status: 'tool_request', toolCall: { name: 'jev_decide', arguments: {
          state: 'A narrow task', questions: { ready: { type: 'noul', instructions: 'Ready?' } },
        } } }
        : { status: 'completed', summary: 'Used the bounded decision.' }
    } }),
    worker: { async executeTool() { throw new Error('unexpected worker effect') } },
    objective: 'Check readiness.',
    context: { taskId: 'task-5', specialistAgent: { agentId: 'researcher' } },
    availableTools: ['jev_decide'],
    executeDecisionTool: async (args) => {
      assert.equal(args.questions.ready.type, 'noul')
      return { status: 'completed', result: { answers: { ready: { type: 'noul', noul: 0.97,
        certainty: 0.97, usable: true } } } }
    },
  })
  assert.equal(result.summary, 'Used the bounded decision.')
  assert.equal(observed[1].loop.observations[0].result.answers.ready.noul, 0.97)
})
