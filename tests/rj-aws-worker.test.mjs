import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, readdir, symlink, chmod, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Readable } from 'node:stream'
import { generateIdentity, exportPublicKey, signAction, signGrant, verifyPayload } from '../src/identity.mjs'

const moduleUrl = new URL('../src/rj-aws/worker.mjs', import.meta.url)
const human = generateIdentity('operator')
const agent = generateIdentity('rj')
const identity = generateIdentity('rj-aws-worker')
const now = Date.parse('2026-09-08T12:00:00Z')
const humanKeys = [[human.keyId, exportPublicKey(human.publicKey)]]
const identityResult = { account: '000000000000', arn: 'arn:aws:sts::000000000000:assumed-role/example-rj-aws-worker/chimera', userId: 'AROAEXAMPLE:chimera' }

test('future retained acceptance is never signed or rewritten during recovery', async t => {
  const f = await fixture(t)
  await f.worker.handle(await request())
  await f.worker.close()
  const path = join(f.stateDir, (await readdir(f.stateDir)).find(name => name.endsWith('.json')))
  const record = JSON.parse(await readFile(path, 'utf8'))
  delete record.receipt
  record.acceptedAt = new Date(now + 1000).toISOString()
  await writeFile(path, JSON.stringify(record), { mode: 0o600 })
  const before = await readFile(path, 'utf8')
  const recovered = await f.RjAwsWorker.open(f.options)
  t.after(() => recovered.close())
  await assert.rejects(recovered.handle(await request()), /RJ_STATE_UNAVAILABLE/)
  assert.equal(await readFile(path, 'utf8'), before)
  assert.equal(recovered.records.get('req-1').receipt, undefined)
})

test('clock rollback during execution retains the accepted record without an inconsistent signed receipt', async t => {
  let clock = now
  const f = await fixture(t, async () => { clock -= 1000; return identityResult })
  f.worker.options.now = () => clock
  await assert.rejects(f.worker.handle(await request()), /RJ_STATE_UNAVAILABLE/)
  const path = join(f.stateDir, (await readdir(f.stateDir)).find(name => name.endsWith('.json')))
  assert.equal(JSON.parse(await readFile(path, 'utf8')).receipt, undefined)
  assert.equal(f.worker.records.get('req-1').receipt, undefined)
  await f.worker.close()
  clock = now
  const recovered = await f.RjAwsWorker.open(f.options)
  t.after(() => recovered.close())
  assert.equal((await recovered.handle(await request())).payload.outcome, 'uncertain')
})

test('CLI rejects caller paths and missing configuration without exposing local details', async () => {
  const result = await promisify(execFile)(process.execPath, ['scripts/rj-aws/worker.mjs', '--config', '/SECRET_SENTINEL'], { cwd: new URL('..', import.meta.url), timeout: 5000 }).catch(e => e)
  assert.equal(result.stdout?.trim(), '{"error":"RJ_WORKER_UNAVAILABLE"}')
  assert.equal(result.stderr, '')
})

test('CLI parser accepts one bounded line and rejects multiline, oversized, and incomplete input', async () => {
  const { readRequestLine } = await import('../scripts/rj-aws/worker.mjs')
  assert.deepEqual(await readRequestLine(Readable.from(['{"a":', '1}\n'])), { a: 1 })
  for (const line of ['{}\n{}\n', '{}', 'x\n', ' '.repeat(32 * 1024) + '\n']) await assert.rejects(() => readRequestLine(Readable.from([line])), /RJ_REQUEST_INVALID/)
})

test('acceptance exists before dispatch and failed receipt persistence reconciles uncertain', async t => {
  let stateDir, executed = 0
  const f = await fixture(t, async () => {
    executed++
    const file = (await readdir(stateDir)).find(f => f.endsWith('.json'))
    const accepted = JSON.parse(await readFile(join(stateDir, file), 'utf8'))
    assert.equal(accepted.facts.requestId, 'req-1')
    assert.equal(accepted.receipt, undefined)
    await chmod(stateDir, 0o500)
    return identityResult
  })
  stateDir = f.stateDir
  await assert.rejects(async () => f.worker.handle(await request()), /RJ_STATE_UNAVAILABLE/)
  await chmod(stateDir, 0o700)
  await f.worker.close()
  const restarted = await f.RjAwsWorker.open(f.options)
  t.after(() => restarted.close())
  assert.equal((await restarted.handle(await request())).payload.outcome, 'uncertain')
  assert.equal(executed, 1)
})

test('expiry after durable acceptance cannot initiate AWS execution', async t => {
  let executions = 0, reads = 0
  const { worker } = await fixture(t, async () => { executions++; return identityResult })
  worker.options.now = () => ++reads <= 2 ? now : now + 300000
  assert.equal((await worker.handle(await request())).payload.outcome, 'failed')
  assert.equal(executions, 0)
})

test('a second enrolled human cannot take over an existing request id', async t => {
  const otherHuman = generateIdentity('another-operator')
  const { worker } = await fixture(t)
  worker.options.humanKeys = [...humanKeys, [otherHuman.keyId, exportPublicKey(otherHuman.publicKey)]]
  await worker.handle(await request())
  await assert.rejects(async () => worker.handle(await request({ humanIdentity: otherHuman })), /RJ_REQUEST_CONFLICT/)
})

test('Linux OS lock rejects another process and releases on process death', { skip: process.platform !== 'linux' }, async t => {
  const { stateDir, worker, options, RjAwsWorker } = await fixture(t)
  const script = `import {RjAwsWorker} from ${JSON.stringify(moduleUrl.href)}; import {generateIdentity} from ${JSON.stringify(new URL('../src/identity.mjs', import.meta.url).href)}; try { const w = await RjAwsWorker.open({stateDir:process.argv[1],humanKeys:[],identity:generateIdentity('worker')}); console.log('OWNED'); process.stdin.resume() } catch(e) { console.log(e.message); process.exitCode=1 }`
  const failed = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, stateDir]).catch(e => e)
  assert.equal(failed.stdout.trim(), 'RJ_WORKER_BUSY')
  await worker.close()
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, stateDir], { stdio: ['pipe', 'pipe', 'pipe'] })
  t.after(() => child.kill('SIGKILL'))
  await new Promise((res, rej) => { child.stdout.once('data', d => d.toString().trim() === 'OWNED' ? res() : rej(new Error('No owner'))); child.once('error', rej) })
  await assert.rejects(() => RjAwsWorker.open(options), /RJ_WORKER_BUSY/)
  child.kill('SIGKILL')
  await new Promise(res => child.once('exit', res))
  // The flock holder observes closed parent stdin and exits; bounded retry covers pipe scheduling only.
  let recovered
  for (let i = 0; i < 30; i++) {
    try { recovered = await RjAwsWorker.open(options); break } catch (e) { if (e.message !== 'RJ_WORKER_BUSY') throw e; await new Promise(r => setTimeout(r, 10)) }
  }
  assert.ok(recovered)
  await recovered.close()
})

test('Linux close completes after the lock holder already exited by signal', { skip: process.platform !== 'linux' }, async t => {
  // Without the signalCode guard close waits for an exit event that already fired.
  const stateDir = await mkdtemp(join(await realpath(tmpdir()), 'rj-worker-signal-'))
  t.after(() => rm(stateDir, { recursive: true, force: true }))
  const script = `
    import {RjAwsWorker} from ${JSON.stringify(moduleUrl.href)};
    import {generateIdentity} from ${JSON.stringify(new URL('../src/identity.mjs', import.meta.url).href)};
    import {readFile} from 'node:fs/promises';
    const worker = await RjAwsWorker.open({stateDir:process.argv[1],humanKeys:[],identity:generateIdentity('worker')});
    const children = (await readFile('/proc/self/task/' + process.pid + '/children','utf8')).trim().split(/\\s+/).filter(Boolean);
    if(children.length !== 1) throw new Error('unexpected child inventory');
    process.kill(Number(children[0]), 'SIGKILL');
    while(worker.lock.alive()) await new Promise(r=>setTimeout(r,10));
    await worker.close();
    console.log('CLOSED');`
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, stateDir], { timeout: 5000 })
  assert.equal(result.stdout.trim(), 'CLOSED')
})

test('renewed current authority retrieves original receipt after original expiry', async t => {
  let clock = now, executions = 0
  const { worker } = await fixture(t, async () => { executions++; return identityResult })
  worker.options.now = () => clock
  const original = await worker.handle(await request())
  clock += 300001
  await assert.rejects(async () => worker.handle(await request()), /RJ_REQUEST_INVALID/)
  assert.deepEqual(await worker.handle(await request({ now: clock })), original)
  assert.equal(executions, 1)
})

test('instance read restricts policy and validates exact owner and instance before returning state', async () => {
  const { createAwsReader } = await import('../src/rj-aws/aws-reader.mjs')
  for (const instanceId of ['i-example00000000000', 'i-foreign']) {
    const calls = []
    const reader = createAwsReader({ execFileImpl: async (file, args, opts) => {
      calls.push({ file, args, opts: structuredClone(opts) })
      if (args.includes('assume-role')) return { stdout: JSON.stringify({ Credentials: { AccessKeyId: 'restricted-id', SecretAccessKey: 'restricted-secret', SessionToken: 'restricted-token', Expiration: '2026-09-08T12:15:00Z' }, AssumedRoleUser: { Arn: identityResult.arn } }) }
      if (args.includes('get-caller-identity')) return { stdout: JSON.stringify({ Account: identityResult.account, Arn: identityResult.arn, UserId: identityResult.userId }) }
      return { stdout: JSON.stringify({ Reservations: [{ OwnerId: '000000000000', Instances: [{ InstanceId: instanceId, State: { Name: 'running', Code: 16 }, Tags: [{ Key: 'secret', Value: 'SECRET_SENTINEL' }] }] }] }) }
    } })
    if (instanceId === 'i-foreign') await assert.rejects(() => reader('rj.aws.instance_status', { requestId: 'req-1' }), /RJ_AWS_UNAVAILABLE/)
    else assert.deepEqual(await reader('rj.aws.instance_status', { requestId: 'req-1' }), { account: '000000000000', region: 'example-region-1', instanceId: 'i-example00000000000', state: 'running' })
    const policy = JSON.parse(calls[0].args[calls[0].args.indexOf('--policy') + 1])
    assert.deepEqual(policy.Statement[1], { Effect: 'Deny', NotAction: ['sts:GetCallerIdentity', 'ec2:DescribeInstances'], Resource: '*' })
    assert.deepEqual(calls[2].args.slice(0, 4), ['ec2', 'describe-instances', '--instance-ids', 'i-example00000000000'])
  }
})

async function protocol() { return import('../src/rj-aws/protocol.mjs') }
async function request(overrides = {}) {
  const { createRjAwsRequest } = await protocol()
  return createRjAwsRequest({ operation: 'rj.aws.identity', taskId: 'task-1', agentIdentity: agent, humanIdentity: human, now, requestId: 'req-1', ...overrides })
}
async function fixture(t, execute = async () => identityResult) {
  const stateDir = await mkdtemp(join(await realpath(tmpdir()), 'rj-worker-'))
  t.after(() => rm(stateDir, { recursive: true, force: true }))
  const { RjAwsWorker } = await import(moduleUrl)
  const options = { stateDir, humanKeys, identity, now: () => now, execute }
  const worker = await RjAwsWorker.open(options)
  t.after(() => worker.close())
  return { stateDir, worker, options, RjAwsWorker }
}

test('authorization rejects altered authority and exact-field violations before dispatch', async t => {
  // Every mutation bypasses a distinct authorization boundary if accepted.
  let executions = 0
  const { worker } = await fixture(t, async () => { executions++; return identityResult })
  const mutations = [
    r => { r.extra = true }, r => { r.arguments.flag = '--endpoint-url' },
    r => { r.operation = 'ec2.terminate' }, r => { r.target.account = '999999999999' },
    r => { r.target.region = 'us-east-1' }, r => { r.target.instanceId = 'i-other' },
    r => { r.action.payload.recipient = 'other'; r.action = signAction(r.action.payload, agent) },
    r => { r.action.payload.agentId = 'other'; r.action = signAction(r.action.payload, agent) },
    r => { r.action.payload.taskId = 'other'; r.action = signAction(r.action.payload, agent) },
    r => { r.action.payload.requestHash = 'a'.repeat(64); r.action = signAction(r.action.payload, agent) },
    r => { r.grant.payload.scopes[0].resource = 'other'; r.grant = signGrant(r.grant.payload, human) },
    r => { r.grant.payload.taskId = 'other'; r.grant = signGrant(r.grant.payload, human) },
    r => { r.grant.payload.agentKeyFingerprint = 'a'.repeat(64); r.grant = signGrant(r.grant.payload, human) },
    r => { r.action.signature = 'bad' }, r => { r.grant.signature = 'bad' },
    r => { r.action = signAction(r.action.payload, generateIdentity('imposter')) },
    r => { r.grant = signGrant(r.grant.payload, generateIdentity('unknown-human')) },
    r => { r.action.payload.extra = true; r.action = signAction(r.action.payload, agent) },
    r => { r.grant.payload.extra = true; r.grant = signGrant(r.grant.payload, human) },
    r => { r.padding = 'x'.repeat(33 * 1024) },
  ]
  for (const mutate of mutations) { const r = await request(); mutate(r); await assert.rejects(() => worker.handle(r), /RJ_REQUEST_INVALID/) }
  for (const time of [now - 300001, now + 1]) await assert.rejects(async () => worker.handle(await request({ now: time })), /RJ_REQUEST_INVALID/)
  assert.equal(executions, 0)
})

test('request lifetime narrows to task deadline and never exceeds five minutes', async () => {
  const { verifyRjAwsRequest } = await protocol()
  const r = await request({ expiresAt: now + 1000 })
  assert.equal(r.action.payload.expiresAt, new Date(now + 1000).toISOString())
  assert.throws(() => verifyRjAwsRequest(r, { humanKeys, now: now + 1000 }), /RJ_REQUEST_INVALID/)
  const broad = await request({ expiresAt: now + 900000 })
  assert.equal(broad.action.payload.expiresAt, new Date(now + 300000).toISOString())
  await assert.rejects(() => request({ expiresAt: now - 1 }), /RJ_REQUEST_INVALID/)
})

test('same request id with a new signed task is a conflict', async t => {
  const { worker } = await fixture(t)
  await worker.handle(await request())
  await assert.rejects(async () => worker.handle(await request({ taskId: 'task-2' })), /RJ_REQUEST_CONFLICT/)
})

test('unfinished durable acceptance reconciles uncertain on restart without replay', async t => {
  // Simulate process death after acceptance by retaining the acceptance record without receipt.
  const { worker, stateDir, RjAwsWorker, options } = await fixture(t)
  await worker.handle(await request())
  await worker.close()
  const files = (await readdir(stateDir)).filter(f => f.endsWith('.json'))
  const path = join(stateDir, files[0])
  const journal = JSON.parse(await readFile(path, 'utf8'))
  delete journal.receipt
  await writeFile(path, JSON.stringify(journal), { mode: 0o600 })
  let executions = 0
  const restarted = await RjAwsWorker.open({ ...options, execute: async () => { executions++; return identityResult } })
  t.after(() => restarted.close())
  const result = await restarted.handle(await request())
  assert.equal(result.payload.outcome, 'uncertain')
  assert.equal(executions, 0)
  assert.deepEqual(await restarted.handle(await request()), result)
})

test('recovery rejects valid JSON acceptance facts that no longer match their semantic hash', async t => {
  // Missing semantic validation would turn these retained hashes into newly signed corrupt receipts.
  const { worker, stateDir, RjAwsWorker, options } = await fixture(t)
  await worker.handle(await request())
  await worker.close()
  const file = join(stateDir, (await readdir(stateDir)).find(f => f.endsWith('.json')))
  const accepted = JSON.parse(await readFile(file, 'utf8'))
  delete accepted.receipt
  const mutations = {
    task: r => { r.facts.taskId = 'other-task' },
    operation: r => { r.facts.operation = 'rj.aws.instance_status' },
    target: r => { r.facts.target.instanceId = 'i-other' },
    account: r => { r.facts.target.account = '999999999999' },
    actor: r => { r.facts.agentId = 'other-agent' },
    fingerprint: r => { r.facts.agentKeyFingerprint = '0'.repeat(64) },
    hash: r => { r.facts.requestHash = '0'.repeat(64) },
  }
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, async () => {
    const record = structuredClone(accepted)
    mutate(record)
    const corrupted = JSON.stringify(record)
    await writeFile(file, corrupted)
    let reopened, executions = 0
    try {
      await assert.rejects(async () => { reopened = await RjAwsWorker.open({ ...options, execute: async () => { executions++; return identityResult } }) }, /RJ_STATE_UNAVAILABLE/)
      assert.equal(executions, 0)
      assert.equal(await readFile(file, 'utf8'), corrupted)
    } finally { await reopened?.close() }
  })
})

test('recovery validates completed receipt shape and every correlated fact in addition to its signature', async t => {
  const { worker, stateDir, RjAwsWorker, options } = await fixture(t)
  await worker.handle(await request())
  await worker.close()
  const file = join(stateDir, (await readdir(stateDir)).find(f => f.endsWith('.json')))
  const complete = JSON.parse(await readFile(file, 'utf8'))
  const mutations = {
    envelope: r => { r.receipt.extra = true },
    payload: r => { r.receipt.payload.extra = true },
    task: r => { r.receipt.payload.taskId = 'other-task' },
    actor: r => { r.receipt.payload.agentId = 'other-agent' },
    operation: r => { r.receipt.payload.operation = 'rj.aws.instance_status' },
    target: r => { r.receipt.payload.target.instanceId = 'i-other' },
    worker: r => { r.receipt.payload.workerId = 'other-worker' },
    schema: r => { r.receipt.payload.schema = 'unknown' },
    accepted: r => { r.receipt.payload.acceptedAt = new Date(now + 1).toISOString() },
    completed: r => { r.receipt.payload.completedAt = 'not-a-timestamp' },
    outcome: r => { r.receipt.payload.outcome = 'unknown' },
    result: r => { r.receipt.payload.result.extra = 'SECRET_SENTINEL' },
    identity: r => { r.receipt.payload.result.account = '999999999999' },
  }
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, async () => {
    const record = structuredClone(complete)
    mutate(record)
    // Retain valid cryptography so acceptance cannot be explained by signature failure alone.
    record.receipt.signature = signAction(record.receipt.payload, identity).signature
    const corrupted = JSON.stringify(record)
    await writeFile(file, corrupted)
    let reopened
    try {
      await assert.rejects(async () => { reopened = await RjAwsWorker.open(options) }, /RJ_STATE_UNAVAILABLE/)
      assert.equal(await readFile(file, 'utf8'), corrupted)
    } finally { await reopened?.close() }
  })
})

test('provider secrets and extra fields never survive signed receipts or journal', async t => {
  const { worker, stateDir } = await fixture(t, async () => ({ ...identityResult, Credentials: { SecretAccessKey: 'SECRET_SENTINEL' }, stderr: 'SECRET_SENTINEL' }))
  const receipt = await worker.handle(await request())
  assert.deepEqual(receipt.payload.result, identityResult)
  for (const f of (await readdir(stateDir)).filter(f => f.endsWith('.json'))) assert.doesNotMatch(await readFile(join(stateDir, f), 'utf8'), /SECRET_SENTINEL/)
})

test('provider errors and identity mismatch become sanitized failure receipts', async t => {
  for (const execute of [async () => { throw new Error('SECRET_SENTINEL') }, async () => ({ ...identityResult, account: '999999999999' })]) {
    const { worker } = await fixture(t, execute)
    const receipt = await worker.handle(await request())
    assert.equal(receipt.payload.outcome, 'failed')
    assert.doesNotMatch(JSON.stringify(receipt), /SECRET_SENTINEL|999999999999/)
  }
})

test('corrupt, symlinked and unwritable journals fail closed', async t => {
  const { worker, stateDir, RjAwsWorker, options } = await fixture(t)
  await worker.handle(await request())
  await worker.close()
  const file = join(stateDir, (await readdir(stateDir)).find(f => f.endsWith('.json')))
  await writeFile(file, '{corrupt')
  await assert.rejects(() => RjAwsWorker.open(options), /RJ_STATE_UNAVAILABLE/)
  await rm(file)
  await symlink('/dev/null', file)
  await assert.rejects(() => RjAwsWorker.open(options), /RJ_STATE_UNAVAILABLE/)
  await rm(file)
  await chmod(stateDir, 0o500)
  await assert.rejects(() => RjAwsWorker.open(options), /RJ_STATE_UNAVAILABLE/)
  await chmod(stateDir, 0o700)
  const link = stateDir + '-link'
  await symlink(stateDir, link)
  t.after(() => rm(link))
  await assert.rejects(() => RjAwsWorker.open({ ...options, stateDir: link }), /RJ_STATE_UNAVAILABLE/)
})

test('concurrent handle calls serialize request acceptance and execution', async t => {
  let executions = 0
  const { worker } = await fixture(t, async () => { executions++; return identityResult })
  const r = await request()
  const receipts = await Promise.all([worker.handle(r), worker.handle(r)])
  assert.deepEqual(receipts[0], receipts[1])
  assert.equal(executions, 1)
})

test('AWS reader strips ambient AWS environment and assumes operation restricted credentials', async () => {
  const { createAwsReader } = await import('../src/rj-aws/aws-reader.mjs')
  const polluted = ['AWS_PROFILE', 'AWS_ENDPOINT_URL', 'AWS_ACCESS_KEY_ID', 'AWS_CONFIG_FILE', 'HTTP_PROXY']
  const saved = Object.fromEntries(polluted.map(k => [k, process.env[k]]))
  for (const key of polluted) process.env[key] = 'POLLUTION'
  try {
    const calls = []
    const reader = createAwsReader({ execFileImpl: async (file, args, opts) => {
      calls.push({ file, args, opts: structuredClone(opts) })
      if (args.includes('assume-role')) return { stdout: JSON.stringify({ Credentials: { AccessKeyId: 'restricted-id', SecretAccessKey: 'restricted-secret', SessionToken: 'restricted-token', Expiration: '2026-09-08T12:15:00Z' }, AssumedRoleUser: { Arn: identityResult.arn, AssumedRoleId: identityResult.userId } }) }
      return { stdout: JSON.stringify({ Account: identityResult.account, Arn: identityResult.arn, UserId: identityResult.userId }) }
    } })
    assert.deepEqual(await reader('rj.aws.identity', { requestId: 'req-1' }), identityResult)
    assert.equal(calls.length, 2)
    for (const call of calls) { assert.equal(call.file, '/usr/local/bin/aws'); assert.doesNotMatch(JSON.stringify(call.opts.env), /POLLUTION/); assert.doesNotMatch(JSON.stringify(call.args), /restricted-secret|restricted-token/) }
    assert.equal(calls[0].args[calls[0].args.indexOf('--duration-seconds') + 1], '900')
    assert.equal(calls[0].args[calls[0].args.indexOf('--role-arn') + 1], 'arn:aws:iam::000000000000:role/example-rj-aws-worker')
    const policy = JSON.parse(calls[0].args[calls[0].args.indexOf('--policy') + 1])
    assert.deepEqual(policy.Statement, [{ Effect: 'Allow', Action: ['sts:GetCallerIdentity'], Resource: '*' }, { Effect: 'Deny', NotAction: ['sts:GetCallerIdentity'], Resource: '*' }])
    assert.equal(calls[1].opts.env.AWS_ACCESS_KEY_ID, 'restricted-id')
    assert.equal(calls[1].opts.env.AWS_EC2_METADATA_DISABLED, 'true')
  } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
})

test('failed restriction, malformed credentials and foreign role never fall back', async () => {
  const { createAwsReader } = await import('../src/rj-aws/aws-reader.mjs')
  for (const response of [new Error('SECRET_SENTINEL'), { stdout: '{}' }, { stdout: JSON.stringify({ Credentials: { AccessKeyId: 'x', SecretAccessKey: 'SECRET_SENTINEL', SessionToken: 'x' }, AssumedRoleUser: { Arn: 'arn:aws:sts::999999999999:assumed-role/admin/x' } }) }]) {
    let calls = 0
    const reader = createAwsReader({ execFileImpl: async () => { calls++; if (response instanceof Error) throw response; return response } })
    await assert.rejects(() => reader('rj.aws.identity', { requestId: 'req-1' }), /^Error: RJ_AWS_UNAVAILABLE$/)
    assert.equal(calls, 1)
  }
})

test('durable duplicate returns original signed receipt and never dispatches twice', async t => {
  // Removing acceptance/result persistence must break this behavior.
  const available = await import(moduleUrl).catch(() => null)
  assert.ok(available?.RjAwsWorker, 'durable signed worker is implemented')
  const { createRjAwsRequest } = await import('../src/rj-aws/protocol.mjs')
  const stateDir = await mkdtemp(join(await realpath(tmpdir()), 'rj-worker-'))
  t.after(() => rm(stateDir, { recursive: true, force: true }))
  let executions = 0
  const options = { stateDir, humanKeys, identity, now: () => now, execute: async () => { executions++; return identityResult } }
  const request = createRjAwsRequest({ operation: 'rj.aws.identity', taskId: 'task-1', agentIdentity: agent, humanIdentity: human, now, requestId: 'req-1' })
  const worker = await available.RjAwsWorker.open(options)
  const first = await worker.handle(request)
  assert.equal(first.payload.outcome, 'succeeded')
  assert.equal(verifyPayload(first.payload, first.signature, identity.publicKey), true)
  assert.deepEqual(await worker.handle(request), first)
  await worker.close()
  const restarted = await available.RjAwsWorker.open(options)
  t.after(() => restarted.close())
  assert.deepEqual(await restarted.handle(request), first)
  assert.equal(executions, 1)
  request.operation = 'rj.aws.instance_status'
  await assert.rejects(() => restarted.handle(request), /RJ_REQUEST_INVALID/)
})
