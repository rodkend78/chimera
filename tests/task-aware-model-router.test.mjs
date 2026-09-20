import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryAuditLog } from '../src/audit-log.mjs'
import { createDeterministicModelRouter } from '../src/ceo/model-router.mjs'
import { RoutingEvidenceStore } from '../src/ceo/routing-evidence.mjs'
import { markInferenceOnlyLeaf } from '../src/ceo/inference-proof.mjs'
import { createTaskAwareModelRouter } from '../src/ceo/task-aware-model-router.mjs'

function route(id) {
  return createDeterministicModelRouter({
    routerId: id,
    responder: async (_prompt, context) => ({ selected: id, stage: context.stage }),
  })
}

const trustedEligibility = () => ({
  connectionEnabled: true,
  agentAllowed: true,
  executorAllowed: true,
  requirementsSatisfied: true,
  pinSatisfied: true,
  reasons: [],
})

test('custom route descriptors cannot mint a parallel inference resource proof', () => {
  const router = createTaskAwareModelRouter({
    audit: new MemoryAuditLog(),
    eligibility: trustedEligibility,
    routes: [{
      id: 'forged-inference',
      router: { routerId: 'custom-router', descriptor: { execution: 'inference-only' }, async route() { return { summary: 'custom' } } },
      capabilities: ['research'],
      providerId: 'custom-provider',
      model: 'custom-model',
      costClass: 'custom',
    }],
  })
  assert.equal(typeof router.resourceClaim, 'function')
  assert.equal(router.resourceClaim({ requirements: { capabilities: ['research'] }, context: { stage: 'specialist' } }), null)
})

test('resource proof stays unknown when a later eligibility change can select an unproven leaf', async () => {
  let blocked = false
  const proven = markInferenceOnlyLeaf(route('proven-inference'))
  const router = createTaskAwareModelRouter({
    audit: new MemoryAuditLog(),
    eligibility: route => ({
      ...trustedEligibility(),
      connectionEnabled: route.id === 'proven-inference' ? !blocked : blocked,
    }),
    routes: [
      { id: 'proven-inference', router: proven, capabilities: ['research'], costClass: 'low', providerId: 'fixture', model: 'proven' },
      { id: 'unproven-fallback', router: route('unproven-fallback'), capabilities: ['research'], costClass: 'low', providerId: 'fixture', model: 'fallback' },
    ],
  })
  const context = { stage: 'specialist', taskId: 'route-proof-change' }
  assert.equal(router.resourceClaim({ requirements: { capabilities: ['research'] }, context }), null)
  blocked = true
  assert.equal((await router.route('Research this.', { ...context, requirements: { capabilities: ['research'] } })).selected, 'unproven-fallback')
})

test('resource proof stays unknown when a later eligibility change can select a native leaf', async () => {
  let blocked = false
  const proven = markInferenceOnlyLeaf(route('proven-inference-native-fallback'))
  const router = createTaskAwareModelRouter({
    audit: new MemoryAuditLog(),
    eligibility: route => ({
      ...trustedEligibility(),
      connectionEnabled: route.id === 'proven-inference-native-fallback' ? !blocked : blocked,
    }),
    routes: [
      { id: 'proven-inference-native-fallback', router: proven, capabilities: ['research'], costClass: 'low', providerId: 'fixture', model: 'proven' },
      { id: 'native-fallback', router: route('native-fallback'), capabilities: ['research'], costClass: 'low', providerId: 'codex', model: 'native', nativeExecution: true },
    ],
  })
  const context = { stage: 'specialist', taskId: 'route-native-change' }
  assert.equal(router.resourceClaim({ requirements: { capabilities: ['research'] }, context }), null)
  blocked = true
  assert.equal((await router.route('Research this.', { ...context, requirements: { capabilities: ['research'] } })).selected, 'native-fallback')
})

test('all inference-only possible leaves are included in the resource proof', async () => {
  let blocked = false
  const first = markInferenceOnlyLeaf(route('all-proven-first'))
  const second = markInferenceOnlyLeaf(route('all-proven-second'))
  const router = createTaskAwareModelRouter({
    audit: new MemoryAuditLog(),
    eligibility: route => ({
      ...trustedEligibility(),
      connectionEnabled: route.id === 'all-proven-first' ? !blocked : blocked || route.id === 'all-proven-second',
    }),
    routes: [
      { id: 'all-proven-first', router: first, capabilities: ['research'], costClass: 'low', providerId: 'fixture', model: 'first' },
      { id: 'all-proven-second', router: second, capabilities: ['research'], costClass: 'low', providerId: 'fixture', model: 'second' },
    ],
  })
  assert.deepEqual(router.resourceClaim({ requirements: { capabilities: ['research'] }, context: { stage: 'specialist', taskId: 'route-all-proven' } }), [
    { key: 'model:fixture:first', access: 'read', verified: true },
    { key: 'model:fixture:second', access: 'read', verified: true },
  ])
  blocked = true
  assert.deepEqual(router.resourceClaim({ requirements: { capabilities: ['research'] }, context: { stage: 'specialist', taskId: 'route-all-proven' } }), [
    { key: 'model:fixture:first', access: 'read', verified: true },
    { key: 'model:fixture:second', access: 'read', verified: true },
  ])
  assert.equal((await router.route('Research this.', { stage: 'specialist', taskId: 'route-all-proven', requirements: { capabilities: ['research'] } })).selected, 'all-proven-second')
})

test('fabric forwards trusted execution controls outside the serialized prompt and does not penalize cancellation', async () => {
  const controller = new AbortController(), calls = []
  const router = createTaskAwareModelRouter({ audit: new MemoryAuditLog(), eligibility: trustedEligibility, routes: [{ id: 'codex', costClass: 'subscription', capabilities: ['coding'], router: {
    routerId: 'codex:fixture', async route(prompt, context, controls) {
      calls.push({ prompt, context, controls })
      if (calls.length === 1) { controller.abort(); throw controller.signal.reason }
      return 'ok'
    },
  } }] })
  const controls = { signal: controller.signal, onProgress() {} }
  await assert.rejects(router.route('code', { taskKind: 'coding' }, controls), { name: 'AbortError' })
  assert.equal(calls[0].controls, controls)
  assert.deepEqual(calls[0].context, { taskKind: 'coding' })
  assert.equal(await router.route('code', { taskKind: 'coding' }), 'ok')
})

test('explicit capability and economy routing are explained, failed providers cool down without replay', async () => {
  const audit = new MemoryAuditLog()
  let calls = 0
  let now = 1000
  const failed = createDeterministicModelRouter({ routerId: 'failed', responder: async () => { calls++; throw new Error('ambiguous provider failure') } })
  const router = createTaskAwareModelRouter({ audit, now: () => now, eligibility: trustedEligibility, routes: [
    { id: 'failing', router: failed, capabilities: ['research'], costClass: 'low' },
    { id: 'other', router: route('other'), capabilities: ['research'], costClass: 'high' },
  ] })
  await assert.rejects(router.route('Implement is a misleading keyword', { taskKind: 'research' }), /ambiguous/)
  assert.equal(calls, 1)
  assert.equal(audit.recent().filter((entry) => entry.fact.kind === 'model.route.selected').length, 1)
  assert.equal((await router.route('Implement is a misleading keyword', { taskKind: 'research' })).selected, 'other')
  now += 30001
  await assert.rejects(router.route('Compare designs', { costPreference: 'economy' }), /ambiguous/)
  const selection = audit.recent().filter((entry) => entry.fact.kind === 'model.route.selected').at(-1).fact
  assert.match(selection.selectionReason, /cost evidence is unknown/)
  assert.equal(selection.costMeasured, false)
})

test('task-aware router keeps CEO work on Codex and selects specialists by task kind', async () => {
  const audit = new MemoryAuditLog()
  const codex = route('codex:gpt-5.6-sol')
  const fast = route('bedrock:amazon.nova-micro-v1:0')
  const reasoning = route('bedrock:us.anthropic.claude-haiku-4-5-20251001-v1:0')
  const multimodal = route('bedrock-mantle:google.gemma-4-31b')
  const router = createTaskAwareModelRouter({
    eligibility: trustedEligibility,
    routes: [
      { id: 'codex', router: codex, capabilities: ['orchestration', 'coding', 'reasoning'], costClass: 'subscription' },
      { id: 'bedrock-fast', router: fast, capabilities: ['bulk', 'reasoning'], costClass: 'low' },
      { id: 'bedrock-reasoning', router: reasoning, capabilities: ['research', 'reasoning'], costClass: 'medium' },
      { id: 'mantle-multimodal', router: multimodal, capabilities: ['multimodal-understanding'], costClass: 'low' },
    ],
    audit,
    now: () => Date.parse('2026-08-28T12:00:00.000Z'),
  })

  assert.equal((await router.route('Plan the request.', { stage: 'decompose', taskId: 'task-1' })).selected, codex.routerId)
  assert.equal((await router.route('Implement and test the fix.', { stage: 'specialist', taskId: 'task-1:1' })).selected, codex.routerId)
  assert.equal((await router.route('Extract and classify 500 records.', { stage: 'specialist', taskId: 'task-1:2' })).selected, fast.routerId)
  assert.equal((await router.route('Research the competing approaches and cite evidence.', { stage: 'specialist', taskId: 'task-1:3' })).selected, reasoning.routerId)
  assert.equal((await router.route('Analyze the video frames and describe the visual result.', { stage: 'specialist', taskId: 'task-1:4' })).selected, multimodal.routerId)
  assert.equal((await router.route('Synthesize the findings.', { stage: 'synthesize', taskId: 'task-1' })).selected, codex.routerId)

  const selections = audit.entries().map((entry) => entry.fact).filter((fact) => fact.kind === 'model.route.selected')
  assert.deepEqual(selections.map((entry) => entry.routeId), [
    'codex',
    'codex',
    'bedrock-fast',
    'bedrock-reasoning',
    'mantle-multimodal',
    'codex',
  ])
  assert.equal(selections.every((entry) => entry.taskId.startsWith('task-1')), true)
})

test('task-aware router fails before dispatch when no eligible route is configured', async () => {
  const router = createTaskAwareModelRouter({
    routes: [{
      id: 'bedrock-fast',
      router: route('bedrock:fast'),
      capabilities: ['bulk'],
      costClass: 'low',
    }],
    audit: new MemoryAuditLog(),
  })

  await assert.rejects(
    router.route('Implement this repository change.', { stage: 'specialist', taskId: 'task-no-code' }),
    (error) => error.code === 'NO_ELIGIBLE_MODEL_ROUTE' && error.dispatchState === 'not_sent',
  )
})

test('explain and route share trusted hard filters, pin precedence, and opaque controls', async () => {
  const calls = []
  const eligibility = (route, { requirements }) => ({
    connectionEnabled: route.id !== 'disabled',
    agentAllowed: route.id !== 'wrong-agent',
    executorAllowed: true,
    requirementsSatisfied: requirements.requiredTools?.length ? route.id === 'trusted' : true,
    pinSatisfied: route.id === 'trusted',
    reasons: ['fixture policy'],
  })
  const router = createTaskAwareModelRouter({
    audit: new MemoryAuditLog(),
    eligibility,
    routes: [
      { id: 'wrong-agent', router: { routerId: 'wrong-agent', async route() { throw new Error('must not dispatch') } }, capabilities: ['research'], costClass: 'low', providerId: 'aws', model: 'wrong', requiredTools: ['browser.observe'] },
      { id: 'trusted', router: { routerId: 'trusted', async route(prompt, context, controls) { calls.push({ prompt, context, controls }); return 'trusted-result' } }, capabilities: ['research'], costClass: 'medium', providerId: 'aws', model: 'research', requiredTools: ['browser.observe'] },
      { id: 'disabled', router: { routerId: 'disabled', async route() { throw new Error('must not dispatch') } }, capabilities: ['research'], costClass: 'low', providerId: 'aws', model: 'disabled', requiredTools: ['browser.observe'] },
    ],
  })
  const requirements = { capabilities: ['research'], requiredTools: ['browser.observe'], modelPreference: { mode: 'pinned', providerId: 'aws', model: 'research' } }
  const explanation = router.explain({ requirements, context: { taskId: 'task-route-1' } })
  assert.equal(explanation.schema, 'chimera.routing-explanation.v1')
  assert.equal(explanation.selected.model, 'research')
  assert.equal(explanation.taskId, 'task-route-1')
  assert.equal(explanation.candidates.find(candidate => candidate.routeId === 'wrong-agent').status, 'rejected')
  assert.ok(explanation.candidates.find(candidate => candidate.routeId === 'wrong-agent').details.length > 0)
  const controls = { signal: new AbortController().signal, onProgress() {} }
  assert.equal(await router.route('Research this.', { taskId: 'task-route-1', requirements }, controls), 'trusted-result')
  assert.equal(calls[0].controls, controls)
  assert.deepEqual(calls[0].context, { taskId: 'task-route-1', requirements })
})

test('missing trusted eligibility metadata is unknown and fails closed before provider dispatch', async () => {
  let calls = 0
  const router = createTaskAwareModelRouter({
    audit: new MemoryAuditLog(),
    eligibility: () => ({ connectionEnabled: true }),
    routes: [{ id: 'incomplete', router: { routerId: 'incomplete', async route() { calls += 1; return 'bad' } }, capabilities: ['coding'], costClass: 'low' }],
  })
  const explanation = router.explain({ requirements: { capabilities: ['coding'] }, context: { taskId: 'task-unknown' } })
  assert.equal(explanation.selected, null)
  assert.equal(explanation.candidates[0].status, 'unknown')
  await assert.rejects(router.route('Implement this.', { taskId: 'task-unknown', requirements: { capabilities: ['coding'] } }), error => error.dispatchState === 'not_sent')
  assert.equal(calls, 0)
})

test('explanation uses a bounded general capability fallback and keeps empty cost evidence unknown', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-routing-explain-'))
  const evidence = await RoutingEvidenceStore.open({ filePath: join(directory, 'evidence.json') })
  const audit = new MemoryAuditLog()
  const router = createTaskAwareModelRouter({
    audit,
    evidence,
    eligibility: trustedEligibility,
    routes: [{
      id: 'declared-but-unmeasured',
      router: route('declared-but-unmeasured'),
      capabilities: [],
      costClass: 'subscription',
      providerId: 'fixture',
      model: 'fixture-model',
    }],
  })

  const explanation = router.explain({ requirements: { priorityPreset: 'balanced' }, context: { taskId: 'task-explain-empty' } })
  assert.equal(explanation.selected.routeId, 'declared-but-unmeasured')
  assert.equal(explanation.evidence.capability, 'general')
  assert.equal(explanation.evidence.cost.status, 'unknown')

  await router.route('General request', { requirements: { priorityPreset: 'economy' }, taskId: 'task-economy-empty' })
  const selected = audit.recent().find(entry => entry.fact.kind === 'model.route.selected' && entry.fact.taskId === 'task-economy-empty')?.fact
  assert.equal(selected.costMeasured, false)
  assert.match(selected.selectionReason, /cost evidence is unknown/)
})

test('preferred eligible routes win every preset before latency or cost ranking', () => {
  const evidence = {
    snapshot({ model }) {
      return {
        latency: { status: 'measured', medianMs: model === 'preferred' ? 900 : 1 },
        cost: { status: 'measured', medianUsd: model === 'preferred' ? 9 : 0.01 },
        reliability: { status: 'measured', successRatio: 1 },
        quality: { status: 'declared-unknown' },
      }
    },
  }
  const router = createTaskAwareModelRouter({
    audit: new MemoryAuditLog(), evidence, eligibility: trustedEligibility,
    routes: [
      { id: 'preferred', router: route('preferred'), capabilities: ['research'], costClass: 'high', providerId: 'fixture', model: 'preferred', priority: 1 },
      { id: 'faster', router: route('faster'), capabilities: ['research'], costClass: 'low', providerId: 'fixture', model: 'faster', priority: 100 },
    ],
  })
  for (const priorityPreset of ['balanced', 'quality', 'latency', 'economy']) {
    const explanation = router.explain({
      requirements: { capabilities: ['research'], priorityPreset, modelPreference: { mode: 'preferred', providerId: 'fixture', model: 'preferred' } },
      context: { taskId: `task-preferred-${priorityPreset}` },
    })
    assert.equal(explanation.selected?.model, 'preferred', priorityPreset)
  }
})

test('required tools use trusted runtime scope instead of route self-declarations', () => {
  const eligibility = (_route, { requirements, scope }) => ({
    connectionEnabled: true,
    agentAllowed: true,
    executorAllowed: true,
    requirementsSatisfied: requirements.requiredTools?.every(tool => scope?.toolCapabilities?.includes(tool)) ?? true,
    pinSatisfied: true,
    reasons: [],
  })
  const router = createTaskAwareModelRouter({
    scope: { toolAuthority: 'runtime', toolCapabilities: ['browser.observe'] },
    eligibility,
    routes: [{ id: 'runtime-authorized', router: route('runtime-authorized'), capabilities: ['research'], costClass: 'medium', providerId: 'fixture', model: 'research' }],
  })
  const explanation = router.explain({ requirements: { capabilities: ['research'], requiredTools: ['browser.observe'] }, context: { taskId: 'task-tool-scope' } })
  assert.equal(explanation.selected?.routeId, 'runtime-authorized')

  const forgedDescriptor = createTaskAwareModelRouter({
    scope: { toolAuthority: 'runtime', toolCapabilities: [] },
    eligibility,
    routes: [{ id: 'forged', router: route('forged'), capabilities: ['research'], costClass: 'medium', providerId: 'fixture', model: 'research', requiredTools: ['browser.observe'] }],
  })
  assert.equal(forgedDescriptor.explain({ requirements: { capabilities: ['research'], requiredTools: ['browser.observe'] } }).selected, null)
})
