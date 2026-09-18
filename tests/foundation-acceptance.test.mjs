import assert from 'node:assert/strict'
import { chmod, lstat, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runFoundationAcceptance } from '../scripts/pilot/foundation-acceptance.mjs'

async function removeTree(path) {
  try {
    const info = await lstat(path)
    if (info.isDirectory()) {
      await chmod(path, 0o700)
      for (const entry of await readdir(path)) await removeTree(join(path, entry))
    } else await chmod(path, 0o600)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  await rm(path, { recursive: true, force: true })
}

test('foundation acceptance proves restart-safe RJ delegation, bounded tools, approval, result, and audit', { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-foundation-acceptance-'))
  try {
    const result = await runFoundationAcceptance({ rootDir: directory })
    assert.equal(result.schema, 'chimera.foundation-acceptance.v1')
    assert.equal(result.passed, true)
    assert.equal(result.primaryTask.status, 'failed')
    assert.equal(result.restartDecision.status, 'cancelled')
    assert.equal(result.recoveryTask.status, 'completed')
    assert.equal(result.recoveryDecision.status, 'approved')
    assert.equal(result.boundedTools.readAuthorized, true)
    assert.equal(result.boundedTools.writeBeforeApproval, false)
    assert.equal(result.boundedTools.writeAfterApproval, true)
    assert.equal(result.artifact.sha256.length, 64)
    assert.equal(result.audit.valid, true)
    assert.ok(result.audit.entries > 0)
    assert.deepEqual(result.actors, ['rod', 'ceo', 'ace'])
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE KEY|Bearer |api[_-]?key|cookieToken|csrfToken/i)
  } finally {
    await removeTree(directory)
  }
})
