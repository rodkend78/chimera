import assert from 'node:assert/strict'
import test from 'node:test'
import { combineTaskRequirements, normalizeTaskPlan } from '../src/ceo/task-plan.mjs'

const eligibleAgentIds = ['researcher', 'writer']

function task(overrides = {}) {
  return {
    specialistAgentId: 'researcher',
    objective: 'Inspect the bounded fixture.',
    acceptanceCriteria: ['Return the observed fixture facts.'],
    ...overrides,
  }
}

test('normalizes legacy tasks to deterministic IDs and sequential dependencies', () => {
  const plan = normalizeTaskPlan({
    tasks: [
      task({ objective: 'First.' }),
      task({ specialistAgentId: 'writer', objective: 'Second.' }),
    ],
  }, { eligibleAgentIds })

  assert.equal(plan.schema, 'chimera.task-plan.v2')
  assert.deepEqual(plan.tasks.map(({ nodeId, dependsOn }) => ({ nodeId, dependsOn })), [
    { nodeId: 'step-1', dependsOn: [] },
    { nodeId: 'step-2', dependsOn: ['step-1'] },
  ])
})

test('legacy dependency fields cannot break sequential compatibility', () => {
  const plan = normalizeTaskPlan({
    tasks: [
      task({ dependsOn: [] }),
      task({ specialistAgentId: 'writer', dependsOn: [] }),
    ],
  }, { eligibleAgentIds })
  assert.deepEqual(plan.tasks.map(({ nodeId, dependsOn }) => ({ nodeId, dependsOn })), [
    { nodeId: 'step-1', dependsOn: [] },
    { nodeId: 'step-2', dependsOn: ['step-1'] },
  ])
  assert.throws(
    () => normalizeTaskPlan({ tasks: [task({ dependsOn: ['step-1'] })] }, { eligibleAgentIds }),
    { code: 'TASK_PLAN_LEGACY_DEPENDENCIES_INVALID' },
  )
})

test('preserves graph identity while returning normalized topological order', () => {
  const plan = normalizeTaskPlan({
    tasks: [
      task({ nodeId: 'publish', specialistAgentId: 'writer', dependsOn: ['research'] }),
      task({ nodeId: 'research', dependsOn: [] }),
    ],
  }, { eligibleAgentIds })

  assert.deepEqual(plan.tasks.map(({ nodeId }) => nodeId), ['research', 'publish'])
  assert.deepEqual(plan.tasks[1].dependsOn, ['research'])
})

test('rejects mixed legacy and identified node declarations', () => {
  assert.throws(
    () => normalizeTaskPlan({
      tasks: [task({ nodeId: 'identified', dependsOn: [] }), task({ specialistAgentId: 'writer' })],
    }, { eligibleAgentIds }),
    (error) => error?.code === 'TASK_PLAN_MIXED_NODE_IDENTITY',
  )
})

test('rejects malformed, duplicate, missing, self-referential, and cyclic graphs before dispatch', () => {
  const cases = [
    [{ tasks: [] }, 'TASK_PLAN_EMPTY'],
    [{ tasks: Array.from({ length: 9 }, () => task()) }, 'TASK_PLAN_TOO_MANY_NODES'],
    [{ tasks: [task({ nodeId: 'same' }), task({ nodeId: 'same' })] }, 'TASK_PLAN_DUPLICATE_NODE'],
    [{ tasks: [task({ nodeId: 'one', dependsOn: ['missing'] })] }, 'TASK_PLAN_MISSING_DEPENDENCY'],
    [{ tasks: [task({ nodeId: 'one', dependsOn: ['one'] })] }, 'TASK_PLAN_SELF_DEPENDENCY'],
    [{ tasks: [task({ nodeId: 'one', dependsOn: ['two'] }), task({ nodeId: 'two', dependsOn: ['one'] })] }, 'TASK_PLAN_CYCLE'],
  ]

  for (const [input, code] of cases) {
    assert.throws(() => normalizeTaskPlan(input, { eligibleAgentIds }), (error) => error?.code === code)
  }
})

test('rejects ineligible agents and preserves bounded optional proposals', () => {
  assert.throws(
    () => normalizeTaskPlan({ tasks: [task({ specialistAgentId: 'intruder' })] }, { eligibleAgentIds }),
    (error) => error?.code === 'TASK_PLAN_AGENT_INELIGIBLE',
  )
  const plan = normalizeTaskPlan({
    tasks: [task({
      nodeId: 'bounded',
      requirements: { requiredTools: ['read'], minContextTokens: 2_000 },
      resources: { cpu: 'small', networkHosts: ['example.test'] },
    })],
  }, { eligibleAgentIds })
  assert.deepEqual(plan.tasks[0].requirements, {
    schema: 'chimera.task-requirements.v1',
    requiredTools: ['read'],
    minContextTokens: 2_000,
  })
  assert.deepEqual(plan.tasks[0].resources, { cpu: 'small', networkHosts: ['example.test'] })
  assert.throws(
    () => normalizeTaskPlan({ tasks: [task()] }, { eligibleAgentIds: [] }),
    (error) => error?.code === 'TASK_PLAN_AGENT_INELIGIBLE',
  )
})

test('combines root admission requirements conservatively with node requirements', () => {
  const combined = combineTaskRequirements({
    requiredTools: ['read'],
    minContextTokens: 4_096,
    modelPreference: { mode: 'preferred', providerId: 'openai', model: 'gpt-5.6-luna' },
  }, {
    requiredTools: [],
    minContextTokens: 18_000,
  })
  assert.deepEqual(combined.requiredTools, ['read'])
  assert.equal(combined.minContextTokens, 18_000)
  assert.deepEqual(combined.modelPreference, { mode: 'preferred', providerId: 'openai', model: 'gpt-5.6-luna' })

  assert.throws(
    () => combineTaskRequirements(
      { modelPreference: { mode: 'pinned', providerId: 'openai', model: 'root-model' } },
      { modelPreference: { mode: 'pinned', providerId: 'openai', model: 'other-model' } },
    ),
    (error) => error?.code === 'TASK_PLAN_REQUIREMENTS_CONFLICT',
  )
})
