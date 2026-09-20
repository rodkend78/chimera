import assert from 'node:assert/strict'
import test from 'node:test'
import { planNodeReadiness, resourcesConflict } from '../src/agents/plan-resources.mjs'

const read = key => ({ key, access: 'read', verified: true })
const write = key => ({ key, access: 'write', verified: true })

test('resource conflicts are conservative for writes and unknown proof', () => {
  assert.equal(resourcesConflict([read('workspace:alpha/input'), read('workspace:alpha/output')], [read('workspace:alpha/input')]), false)
  assert.equal(resourcesConflict([write('workspace:alpha')], [read('workspace:alpha/input')]), true)
  assert.equal(resourcesConflict([write('workspace:alpha/input')], [write('workspace:alpha/input-copy')]), false)
  assert.equal(resourcesConflict(null, [read('workspace:alpha/input')]), true)
  assert.equal(resourcesConflict([{ key: 'workspace:alpha', access: 'write', verified: false }], []), true)
})

test('readiness waits for dependencies and held unknown or conflicting claims', () => {
  const node = { nodeId: 'child', dependsOn: ['root'] }
  const states = new Map([['root', 'queued']])
  assert.equal(planNodeReadiness({ node, states, heldResources: [], claims: [read('workspace:alpha')] }), 'waiting')
  states.set('root', 'failed')
  assert.equal(planNodeReadiness({ node, states, heldResources: [], claims: [read('workspace:alpha')] }), 'blocked')
  states.set('root', 'completed')
  assert.equal(planNodeReadiness({ node, states, heldResources: [null], claims: [read('workspace:alpha')] }), 'waiting')
  assert.equal(planNodeReadiness({ node, states, heldResources: [[write('workspace:beta')]], claims: [read('workspace:alpha')] }), 'ready')
})
