import assert from 'node:assert/strict'
import test from 'node:test'
import {
  TASK_REQUIREMENTS_SCHEMA,
  normalizeTaskRequirements,
  requirementsEqual,
} from '../src/ceo/task-requirements.mjs'

test('normalizes bounded structured requirements without inferring omitted constraints', () => {
  const result = normalizeTaskRequirements({
    capabilities: ['research', 'research'],
    inputModalities: ['TEXT'],
    outputModalities: ['TEXT'],
    requiredTools: ['browser.observe'],
    minContextTokens: 16_000,
    privacy: 'approved-providers',
    priorityPreset: 'quality',
    modelPreference: { mode: 'preferred', providerId: 'aws-bedrock', model: 'claude' },
    maxEstimatedUsd: 1.25,
  })

  assert.deepEqual(result, {
    schema: TASK_REQUIREMENTS_SCHEMA,
    capabilities: ['research'],
    inputModalities: ['TEXT'],
    outputModalities: ['TEXT'],
    requiredTools: ['browser.observe'],
    minContextTokens: 16_000,
    privacy: 'approved-providers',
    priorityPreset: 'quality',
    modelPreference: { mode: 'preferred', providerId: 'aws-bedrock', model: 'claude' },
    maxEstimatedUsd: 1.25,
  })
  assert.equal(Object.hasOwn(result, 'requiredTools'), true)
  const omitted = normalizeTaskRequirements({ capabilities: ['research'] })
  assert.equal(Object.hasOwn(omitted, 'minContextTokens'), false)
  assert.equal(Object.hasOwn(omitted, 'privacy'), false)
  assert.equal(Object.hasOwn(omitted, 'inputModalities'), false)
})

test('legacy task hints are narrow and structured requirements supersede them', () => {
  const legacy = normalizeTaskRequirements(undefined, { taskKind: 'bulk', costPreference: 'economy' })
  assert.deepEqual(legacy.capabilities, ['bulk'])
  assert.equal(legacy.priorityPreset, 'economy')

  const explicit = normalizeTaskRequirements({ capabilities: ['coding'], priorityPreset: 'latency' }, {
    taskKind: 'research',
    costPreference: 'economy',
  })
  assert.deepEqual(explicit.capabilities, ['coding'])
  assert.equal(explicit.priorityPreset, 'latency')
})

test('requirements reject unknown authority fields and unsafe bounds', () => {
  assert.throws(() => normalizeTaskRequirements({ grant: 'operator-grant' }), { code: 'TASK_REQUIREMENTS_FIELD_INVALID' })
  assert.throws(() => normalizeTaskRequirements({ requiredTools: ['x'.repeat(129)] }), { code: 'TASK_REQUIREMENTS_VALUE_INVALID' })
  assert.throws(() => normalizeTaskRequirements({ minContextTokens: 0 }), { code: 'TASK_REQUIREMENTS_VALUE_INVALID' })
  assert.throws(() => normalizeTaskRequirements({ maxEstimatedUsd: -1 }), { code: 'TASK_REQUIREMENTS_VALUE_INVALID' })
  assert.throws(() => normalizeTaskRequirements({ modelPreference: { mode: 'pinned', providerId: 'codex' } }), { code: 'TASK_REQUIREMENTS_VALUE_INVALID' })
})

test('requirements equality ignores caller object identity but preserves every execution constraint', () => {
  const first = normalizeTaskRequirements({ capabilities: ['research'], priorityPreset: 'balanced' })
  const same = normalizeTaskRequirements({ capabilities: ['research'], priorityPreset: 'balanced' })
  const changed = normalizeTaskRequirements({ capabilities: ['research'], priorityPreset: 'latency' })
  assert.equal(requirementsEqual(first, same), true)
  assert.equal(requirementsEqual(first, changed), false)
})
