import test from 'node:test'
import assert from 'node:assert/strict'
import { runAdeAcceptance } from '../scripts/pilot/ade-acceptance.mjs'
import { LambdaAuditClient } from '../src/audit/lambda-client.mjs'

for (const completeConfiguration of [false, true]) {
  test(`ADE fixture stays local with ${completeConfiguration ? 'complete' : 'partial'} ambient AWS audit configuration`, async (t) => {
    const keys = ['CHIMERA_AUDIT_WRITER_FUNCTION', 'CHIMERA_AUDIT_STREAM_ID']
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
    let remoteOpens = 0
    // A regression must fail before creating a worker or contacting AWS.
    t.mock.method(LambdaAuditClient, 'open', async () => {
      remoteOpens += 1
      throw new Error('ACCEPTANCE_ATTEMPTED_REMOTE_AUDIT')
    })
    process.env.CHIMERA_AUDIT_WRITER_FUNCTION = 'fixture-must-not-call'
    if (completeConfiguration) process.env.CHIMERA_AUDIT_STREAM_ID = 'fixture-must-not-write'
    else delete process.env.CHIMERA_AUDIT_STREAM_ID
    try {
      const result = await runAdeAcceptance()
      assert.equal(result.passed, true)
      assert.equal(result.safety.auditValid, true)
      assert.equal(result.safety.sourceUntouchedBeforeCommit, true)
      assert.equal(result.primaryTask.afterRestart, 'failed')
      assert.equal(result.recoveryTask.status, 'completed')
      assert.equal(result.recoveryTask.leaseStatus, 'revoked')
      assert.equal(remoteOpens, 0)
      assert.equal(process.env.CHIMERA_AUDIT_WRITER_FUNCTION, 'fixture-must-not-call')
      assert.equal(process.env.CHIMERA_AUDIT_STREAM_ID, completeConfiguration ? 'fixture-must-not-write' : undefined)
    } finally {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key]
        else process.env[key] = previous[key]
      }
    }
  })
}
