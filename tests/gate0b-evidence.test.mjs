import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sha256, summarizeMatrix, validateSoakConfig } from '../src/gate0b/evidence.mjs'

const valid = {
  schemaVersion: 1,
  durationHours: 48,
  iterationSeconds: 3600,
  source: { commit: 'a'.repeat(40), tree: 'b'.repeat(40), archiveSha256: 'c'.repeat(64) },
  profiles: ['web', 'headless'],
  presets: ['standard', 'code', 'minimal', 'cordis'],
}

test('Gate 0B config requires exact pins and the complete supported matrix', () => {
  assert.equal(validateSoakConfig(valid), valid)
  assert.throws(() => validateSoakConfig({ ...valid, source: { ...valid.source, commit: 'main' } }), /full SHA-1/)
  assert.throws(() => validateSoakConfig({ ...valid, presets: ['standard'] }), /missing preset code/)
})

test('compatibility matrix retains zero-run rows and counts failures', () => {
  assert.deepEqual(summarizeMatrix([
    { type: 'task', name: 'web', ok: true, at: 'one' },
    { type: 'task', name: 'web', ok: false, at: 'two' },
  ], ['web', 'headless']), [
    { name: 'web', runs: 2, passes: 1, failures: 1, last: 'two' },
    { name: 'headless', runs: 0, passes: 0, failures: 0, last: null },
  ])
})

test('evidence hashing is deterministic', () => {
  assert.equal(sha256('chimera'), 'ae391de9c5171466f31ef5ac920cfd3901bcc01aa28c2b02dc13b1ab3d6f2063')
})
