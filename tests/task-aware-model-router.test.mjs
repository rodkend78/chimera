import assert from 'node:assert/strict'
import test from 'node:test'
import { MemoryAuditLog } from '../src/audit-log.mjs'
import { createDeterministicModelRouter } from '../src/ceo/model-router.mjs'
import { createTaskAwareModelRouter } from '../src/ceo/task-aware-model-router.mjs'

function route(id) {
  return createDeterministicModelRouter({
    routerId: id,
    responder: async (_prompt, context) => ({ selected: id, stage: context.stage }),
  })
}

test('fabric forwards trusted execution controls outside the serialized prompt and does not penalize cancellation', async () => {
  const controller = new AbortController(), calls = []
  const router = createTaskAwareModelRouter({ audit: new MemoryAuditLog(), routes: [{ id: 'codex', costClass: 'subscription', capabilities: ['coding'], router: {
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
  const router = createTaskAwareModelRouter({ audit, now: () => now, routes: [
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
  assert.match(selection.selectionReason, /cost class/)
  assert.equal(selection.costMeasured, false)
})

test('task-aware router keeps CEO work on Codex and selects specialists by task kind', async () => {
  const audit = new MemoryAuditLog()
  const codex = route('codex:gpt-5.6-sol')
  const fast = route('bedrock:amazon.nova-micro-v1:0')
  const reasoning = route('bedrock:us.anthropic.claude-haiku-4-5-20251001-v1:0')
  const multimodal = route('bedrock-mantle:google.gemma-4-31b')
  const router = createTaskAwareModelRouter({
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
