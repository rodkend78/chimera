import test from 'node:test'
import assert from 'node:assert/strict'
import { readScopedEntries, writeScopedEntry } from '../app/src/recovery-store.js'

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null },
    setItem(key, value) { values.set(key, String(value)) },
    removeItem(key) { values.delete(key) },
    key(index) { return [...values.keys()][index] ?? null },
    get length() { return values.size },
  }
}

test('direct recovery reads preserve over-limit evidence and emit a bounded warning', () => {
  const prefix = 'chimera.task-control-receipt.v1:fixture:'
  const initial = Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`${prefix}${index}`, JSON.stringify({ requestId: `r-${index}` })]))
  const warnings = []
  const loaded = readScopedEntries({ storage: memoryStorage(initial), prefix, maxEntries: 50, onWarning: code => warnings.push(code), parse: raw => JSON.parse(raw) })
  assert.equal(Object.keys(loaded.rows).length, 51)
  assert.equal(loaded.warning, 'LOCAL_RECOVERY_LIMIT')
  assert.ok(warnings.includes('LOCAL_RECOVERY_LIMIT'))
})

test('direct recovery refuses a new entry at the bound but permits an exact existing update', () => {
  const prefix = 'chimera.project-receipt.v1:fixture:'
  const initial = Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`${prefix}${index}`, JSON.stringify({ requestId: `r-${index}` })]))
  const warnings = []
  const storage = memoryStorage(initial)
  const blocked = writeScopedEntry({ storage, prefix, key: `${prefix}new`, value: { requestId: 'new' }, onWarning: code => warnings.push(code) })
  assert.deepEqual(blocked, { ok: false, warning: 'LOCAL_RECOVERY_LIMIT' })
  const updated = writeScopedEntry({ storage, prefix, key: `${prefix}0`, value: { requestId: 'replacement' }, onWarning: code => warnings.push(code) })
  assert.deepEqual(updated, { ok: true })
  assert.equal(JSON.parse(storage.getItem(`${prefix}0`)).requestId, 'replacement')
  assert.ok(warnings.includes('LOCAL_RECOVERY_LIMIT'))
})

test('direct recovery reports storage write failures instead of swallowing them', () => {
  const prefix = 'chimera.task-control-receipt.v1:fixture:'
  const storage = { ...memoryStorage(), setItem() { throw new Error('quota') } }
  const result = writeScopedEntry({ storage, prefix, key: `${prefix}one`, value: { requestId: 'one' } })
  assert.deepEqual(result, { ok: false, warning: 'LOCAL_RECOVERY_WRITE_FAILED' })
})

test('direct recovery refuses a write when its storage inventory cannot be read', () => {
  const prefix = 'chimera.task-control-receipt.v1:fixture:'
  const storage = {
    getItem() { return null },
    setItem() { throw new Error('must not write') },
    removeItem() {},
    key() { throw new Error('inventory unavailable') },
    get length() { return 1 },
  }
  const result = writeScopedEntry({ storage, prefix, key: `${prefix}one`, value: { requestId: 'one' } })
  assert.deepEqual(result, { ok: false, warning: 'LOCAL_RECOVERY_UNAVAILABLE' })
})
