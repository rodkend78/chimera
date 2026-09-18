import test from 'node:test'
import assert from 'node:assert/strict'
import { MemoryAuditLog } from '../src/audit-log.mjs'
import { createActivityProjection } from '../src/ceo/activity-projection.mjs'

test('state projection reads only the bounded audit tail without rescanning the chain', () => {
  const audit = new MemoryAuditLog()
  const fact = { kind: 'test.event', nested: { status: 'original' } }
  const returned = audit.append(fact)
  fact.nested.status = 'mutated'
  returned.fact.nested.status = 'mutated again'
  assert.equal(audit.verify().valid, true)
  for (let index = 0; index < 10000; index++) audit.append({ kind: 'test.event', index })
  audit.entries = () => { throw new Error('full clone is forbidden during projection') }
  audit.verify = () => { throw new Error('full verification is forbidden during projection') }
  const state = createActivityProjection({ audit, limit: 12 })
  assert.equal(state.recentEvents.length, 12)
  assert.equal(state.recentEvents[0].sequence, 10000)
  assert.equal(state.audit.entries, 10001)
  assert.equal(state.audit.valid, true)
  assert.equal(state.hourlyCost, null)
})
