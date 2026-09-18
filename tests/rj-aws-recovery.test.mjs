import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, realpath, chmod, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { generateIdentity, exportPublicKey, signAction } from '../src/identity.mjs'
import { createRjAwsConnector, createTailscaleSshTransport } from '../src/rj-aws/connector.mjs'
import { RjAwsWorker } from '../src/rj-aws/worker.mjs'

const time = Date.parse('2026-09-08T12:00:00Z')
const human = generateIdentity('rod'), agent = generateIdentity('ceo'), workerIdentity = generateIdentity('rj-aws-worker')
const result = { account: '000000000000', arn: 'arn:aws:sts::000000000000:assumed-role/example-rj-aws-worker/chimera', userId: 'AROAEXAMPLE:chimera' }
const context = { agentId: 'ceo', taskId: 'original-task', assertActive: () => ({ agentId: 'ceo', taskId: 'original-task', profileId: 'connected', expiresAt: new Date(time + 300000).toISOString() }) }
async function setup(t) {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'rj-recovery-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const module = await import('../src/rj-aws/evidence.mjs').catch(() => ({}))
  assert.equal(typeof module.RjAwsEvidence?.open, 'function', 'durable local request and envelope evidence exists')
  const evidence = await module.RjAwsEvidence.open({ stateDir: join(dir, 'local') })
  let clock = time, executions = 0
  const options = { stateDir: join(dir, 'remote'), identity: workerIdentity, humanKeys: [[human.keyId, human.publicKey]], now: () => clock,
    execute: async () => { executions++; return result } }
  const worker = await RjAwsWorker.open(options)
  t.after(() => worker.close())
  const connector = overrides => createRjAwsConnector({ config: { workerPublicKey: exportPublicKey(workerIdentity.publicKey) }, humanIdentity: human,
    identityFor: () => agent, now: () => clock, evidence, audit: { append() {} }, transport: async request => JSON.stringify(await worker.handle(request)), ...overrides })
  return { dir, evidence, worker, options, connector, Evidence: module.RjAwsEvidence, advance: () => { clock += 600000 }, executions: () => executions }
}

test('real child status 1 signed CLI error stdout reaches pinned connector verification', async t => {
  // Only the remote process boundary is replaced; the actual transport collects real child stdout/exit.
  const envelope = signAction({ schema: 'chimera.rj-aws.error.v1', workerId: 'rj-aws-worker', code: 'RJ_WORKER_BUSY' }, workerIdentity)
  const transport = createTailscaleSshTransport({ spawnImpl: () => spawn(process.execPath, ['-e', `process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(${JSON.stringify(JSON.stringify(envelope))});process.exitCode=1})`]) })
  // Supply inert storage here so this transport regression also runs before evidence implementation.
  const connector = createRjAwsConnector({ config: { workerPublicKey: exportPublicKey(workerIdentity.publicKey) }, humanIdentity: human,
    identityFor: () => agent, now: () => time, audit: { append() {} }, evidence: { put() {}, list: () => [] }, transport })
  await assert.rejects(connector.execute('rj.aws.identity', context), { code: 'RJ_WORKER_UNAVAILABLE' })
  assert.equal(connector.state().transport.status, 'ready')
  assert.equal(connector.state().execution.status, 'not-verified')
})

test('expired original request reconciles after connector and worker restart without another execution', async t => {
  const f = await setup(t)
  let original
  const first = f.connector({ transport: async request => { original = request; await f.worker.handle(request); throw { code: 'RJ_AWS_OUTCOME_UNKNOWN' } } })
  await assert.rejects(first.execute('rj.aws.identity', context), { code: 'RJ_AWS_OUTCOME_UNKNOWN' })
  await f.worker.close()
  f.advance()
  const restartedWorker = await RjAwsWorker.open(f.options)
  t.after(() => restartedWorker.close())
  const evidence = await f.Evidence.open({ stateDir: join(f.dir, 'local') })
  const recovered = f.connector({ evidence, transport: async request => JSON.stringify(await restartedWorker.handle(request)) })
  const receipt = (await recovered.reconcile(original.action.payload.requestId)).receipt
  assert.equal(receipt.payload.requestId, original.action.payload.requestId)
  assert.equal(receipt.payload.requestHash, original.action.payload.requestHash)
  assert.equal(receipt.payload.taskId, 'original-task')
  assert.equal(f.executions(), 1)
  assert.deepEqual((await evidence.get(receipt.payload.requestId)).receipt, receipt)
})

test('authenticated lookup never executes an unaccepted request and rejects altered or expired lookup authority', async t => {
  const f = await setup(t)
  let original
  const first = f.connector({ transport: async request => { original = request; throw { code: 'RJ_AWS_OUTCOME_UNKNOWN' } } })
  await assert.rejects(first.execute('rj.aws.identity', context))
  f.advance()
  let lookup
  await assert.rejects(f.connector({ transport: async request => { lookup = request; return JSON.stringify(await f.worker.handle(request)) } }).reconcile(original.action.payload.requestId))
  assert.equal(f.executions(), 0)
  assert.equal(f.worker.records.size, 0)
  const changed = structuredClone(lookup)
  changed.authorization.payload.facts.taskId = 'foreign-task'
  await assert.rejects(f.worker.handle(changed), /RJ_REQUEST_INVALID/)
  f.advance()
  await assert.rejects(f.worker.handle(lookup), /RJ_REQUEST_INVALID/)
  assert.equal(f.executions(), 0)
})

test('lookup after accepted-only journal restart returns signed uncertainty without execution', async t => {
  const f = await setup(t)
  const execute = f.options.execute
  f.options.execute = async () => { const value = await execute(); await chmod(f.options.stateDir, 0o500); return value }
  let original
  await assert.rejects(f.connector({ transport: async request => { original = request; return JSON.stringify(await f.worker.handle(request)) } }).execute('rj.aws.identity', context))
  await chmod(f.options.stateDir, 0o700)
  await f.worker.close()
  f.advance()
  const restarted = await RjAwsWorker.open(f.options)
  t.after(() => restarted.close())
  const recovered = await f.connector({ transport: async request => JSON.stringify(await restarted.handle(request)) }).reconcile(original.action.payload.requestId)
  assert.equal(recovered.outcome, 'uncertain')
  assert.equal(recovered.receipt.payload.requestHash, original.action.payload.requestHash)
  assert.equal(f.executions(), 1)
})

for (const output of ['{"error":"RJ_WORKER_UNAVAILABLE"}', '{"payload":', '{"agentPublicKey":"not-a-key","payload":{},"signature":"invalid"}']) test(`status 1 unauthenticated or incomplete child output remains uncertain: ${output}`, async () => {
  const transport = createTailscaleSshTransport({ spawnImpl: () => spawn(process.execPath, ['-e', `process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(${JSON.stringify(output)});process.exitCode=1})`]) })
  const connector = createRjAwsConnector({ config: { workerPublicKey: exportPublicKey(workerIdentity.publicKey) }, humanIdentity: human,
    identityFor: () => agent, now: () => time, audit: { append() {} }, evidence: { put() {}, list: () => [] }, transport })
  await assert.rejects(connector.execute('rj.aws.identity', context), { code: 'RJ_AWS_RECEIPT_INVALID' })
  assert.equal(connector.state().execution.status, 'unknown')
  assert.equal(connector.state().transport.status, 'unknown')
})

for (const cancel of [false, true]) test(`audit failure after prior success retains full envelope locally and clears verified state${cancel ? ' during cancellation' : ''}`, async t => {
  const f = await setup(t)
  let fail = false, active = true
  const connector = f.connector({ audit: { async append(fact) {
    if (fail && fact.kind === 'rj.aws.receipt.verified') { if (cancel) active = false; throw new Error('audit offline') }
  } } })
  const authority = { ...context, assertActive: () => active ? context.assertActive() : false }
  await connector.execute('rj.aws.identity', authority)
  assert.equal(connector.state().execution.status, 'verified')
  fail = true
  await assert.rejects(connector.execute('rj.aws.identity', authority), { code: 'RJ_AUDIT_UNAVAILABLE' })
  const state = connector.state()
  assert.equal(state.execution.status, 'unknown')
  assert.equal(state.audit.status, 'unavailable')
  assert.equal(state.retention.status, 'retained')
  const restarted = await f.Evidence.open({ stateDir: join(f.dir, 'local') })
  const retained = await restarted.get(state.lastReceipt.requestId)
  assert.ok(retained.receipt.signature.length)
  assert.equal(retained.receipt.payload.outcome, 'succeeded')
  assert.equal(active, !cancel)
})

test('local receipt storage failure clears stale verification and does not deliver success', async t => {
  const f = await setup(t)
  const connector = f.connector({ transport: async request => {
    const receipt = await f.worker.handle(request)
    await chmod(join(f.dir, 'local'), 0o500)
    return JSON.stringify(receipt)
  } })
  try {
    await assert.rejects(connector.execute('rj.aws.identity', context), { code: 'RJ_EVIDENCE_UNAVAILABLE' })
    assert.equal(connector.state().execution.status, 'unknown')
    assert.equal(connector.state().retention.status, 'unavailable')
  } finally { await chmod(join(f.dir, 'local'), 0o700) }
})

test('restart rejects altered local signed evidence before projecting or reconciling it', async t => {
  const f = await setup(t)
  await f.connector().execute('rj.aws.identity', context)
  const directory = join(f.dir, 'local')
  const file = join(directory, (await readdir(directory)).find(name => name.endsWith('.json')))
  const entry = JSON.parse(await readFile(file, 'utf8'))
  entry.receipt.payload.completedAt = '2026-09-08T12:01:00.000Z'
  await writeFile(file, JSON.stringify(entry), { mode: 0o600 })
  const evidence = await f.Evidence.open({ stateDir: directory })
  assert.throws(() => f.connector({ evidence }), { code: 'RJ_EVIDENCE_UNAVAILABLE' })
})

test('concurrent connector calls cannot let an older audit success overwrite the newer audit failure', async t => {
  const f = await setup(t)
  let auditCount = 0, entered
  const auditEntered = new Promise(resolve => { entered = resolve })
  const connector = f.connector({ audit: { async append(fact) {
    if (fact.kind !== 'rj.aws.receipt.verified') return
    if (++auditCount === 1) {
      entered()
      await new Promise(resolve => setTimeout(resolve, 150))
    } else throw new Error('newer audit failed')
  } } })
  const first = connector.execute('rj.aws.identity', context)
  await auditEntered
  const second = connector.execute('rj.aws.identity', context)
  const outcomes = await Promise.allSettled([first, second])
  assert.equal(outcomes[0].status, 'fulfilled')
  assert.equal(outcomes[1].reason.code, 'RJ_AUDIT_UNAVAILABLE')
  assert.equal(connector.state().execution.status, 'unknown')
  assert.equal(connector.state().audit.status, 'unavailable')
  assert.notEqual(connector.state().lastReceipt.requestId, outcomes[0].value.receipt.payload.requestId)
})
