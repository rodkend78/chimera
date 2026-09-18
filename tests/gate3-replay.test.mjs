import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { MemoryAuditLog } from '../src/audit-log.mjs'

const executeFile = promisify(execFile)
const runnerPath = fileURLToPath(new URL('../scripts/gate3-replay.mjs', import.meta.url))
const evidenceGroups = [
  'policyAndSource',
  'authority',
  'messages',
  'gatewayActions',
  'router',
  'specialistExecution',
  'decisionsAndAudit',
  'operatorState',
  'negativeReplay',
]

test('Gate 3 runner retains and independently verifies all nine replay evidence groups', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-gate3-replay-'))
  try {
    const { stdout, stderr } = await executeFile(process.execPath, [runnerPath], {
      cwd: directory,
      encoding: 'utf8',
    })
    assert.equal(stderr, '')
    assert.match(stdout, /Gate 3 replay complete and self-verified\./)

    const evidenceDirectory = join(directory, '.chimera/gate3-replay')
    const evidence = JSON.parse(await readFile(join(evidenceDirectory, 'evidence.json'), 'utf8'))
    const decisionJsonl = await readFile(join(evidenceDirectory, 'decisions.jsonl'), 'utf8')

    assert.equal(evidence.schema, 'chimera.gate3-replay.v1')
    assert.deepEqual(evidence.itemGroups, evidenceGroups)
    for (const group of evidenceGroups) assert.ok(evidence[group], `missing evidence group ${group}`)

    assert.equal(evidence.policyAndSource.policyVersion, 1)
    assert.equal(evidence.authority.humanPublicKeyRegistry.length, 1)
    assert.deepEqual(Object.keys(evidence.authority.signedGrants).sort(), ['ceo', 'sender', 'specialist'])
    assert.equal(evidence.messages.taskHandoffs.length, 1)
    assert.equal(evidence.messages.structuredResults.length, 1)
    assert.equal(evidence.gatewayActions.records.every((record) => (
      record.action?.signature
      && record.grantId
      && record.policyDecision?.tier
      && Object.hasOwn(record, 'challengeHash')
    )), true)
    assert.equal(evidence.router.identifier, 'chimera/gate3-deterministic-router@1')
    assert.equal(evidence.router.configuration.networkAccess, false)
    assert.equal(evidence.specialistExecution.output.grok46.enabled, true)
    assert.equal(evidence.specialistExecution.citations.length, 2)
    assert.equal(evidence.operatorState.browser.used, false)

    const auditVerification = new MemoryAuditLog().verify(evidence.decisionsAndAudit.auditChain.entries)
    assert.equal(auditVerification.valid, true)
    assert.equal(auditVerification.head, evidence.decisionsAndAudit.auditChain.finalHeadHash)
    assert.match(evidence.decisionsAndAudit.auditChain.finalHeadHash, /^[0-9a-f]{64}$/)
    assert.notEqual(evidence.decisionsAndAudit.auditChain.finalHeadHash, '0'.repeat(64))
    assert.equal(evidence.selfVerification.valid, true)
    assert.equal(evidence.selfVerification.itemGroups, 9)

    const negatives = {
      poisonedPeerRequest: ['rejected', 'RECIPIENT_SCOPE_DENIED'],
      ceoOverreach: ['denied', 'OUTSIDE_GRANT_SCOPE'],
      specialistOverreach: ['rejected', 'RECIPIENT_SCOPE_DENIED'],
      repeatedHumanDecision: ['denied', 'NO_PENDING_ACTION'],
    }
    for (const [name, [status, reason]] of Object.entries(negatives)) {
      assert.equal(evidence.negativeReplay[name].status, status)
      assert.equal(evidence.negativeReplay[name].reason, reason)
    }

    const decisionEvents = decisionJsonl.split('\n').filter(Boolean).map((line) => JSON.parse(line))
    assert.deepEqual(decisionEvents.map((event) => event.event), ['posted', 'resolved', 'attempt-rejected'])
    assert.deepEqual(decisionEvents, evidence.decisionsAndAudit.decisionJsonl.records)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
