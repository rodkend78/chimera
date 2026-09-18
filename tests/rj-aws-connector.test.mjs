import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { spawn } from 'node:child_process'
import test, { after } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { RjAwsEvidence } from '../src/rj-aws/evidence.mjs'
import { canonicalJson } from '../src/canonical.mjs'
import { exportPublicKey, generateIdentity, signAction } from '../src/identity.mjs'
import { createRjAwsRequest, RJ_RECEIPT_LIMIT, RJ_TARGET } from '../src/rj-aws/protocol.mjs'

const now = Date.parse('2026-09-08T12:00:00.000Z')
const human = generateIdentity('rod')
const ace = generateIdentity('ace')
const worker = generateIdentity('rj-aws-worker')
const evidenceDirs = []
after(async () => { for (const dir of evidenceDirs) await rm(dir, { recursive: true, force: true }) })
async function newEvidence() {
  const stateDir = await mkdtemp(join(tmpdir(), 'rj-connector-evidence-'))
  evidenceDirs.push(stateDir)
  return RjAwsEvidence.open({ stateDir })
}
const identityResult = Object.freeze({
  account: '000000000000',
  arn: 'arn:aws:sts::000000000000:assumed-role/example-rj-aws-worker/chimera',
  userId: 'AROATEST:chimera',
})

function authority(overrides = {}) {
  return {
    agentId: 'ace',
    taskId: 'task-1',
    profileId: 'connected',
    expiresAt: new Date(now + 120_000).toISOString(),
    ...overrides,
  }
}

function receiptFor(request, { signingIdentity = worker, payload = {} } = {}) {
  const action = request.action.payload
  const operation = request.operation
  const result = operation === 'rj.aws.identity'
    ? identityResult
    : { account: RJ_TARGET.account, region: RJ_TARGET.region, instanceId: RJ_TARGET.instanceId, state: 'running' }
  return signAction({
    schema: 'chimera.rj-aws.receipt.v1',
    requestId: action.requestId,
    taskId: action.taskId,
    agentId: action.agentId,
    requestHash: action.requestHash,
    operation,
    target: { ...RJ_TARGET },
    workerId: 'rj-aws-worker',
    outcome: 'succeeded',
    acceptedAt: new Date(now + 1_000).toISOString(),
    completedAt: new Date(now + 2_000).toISOString(),
    result,
    ...payload,
  }, signingIdentity)
}

function connectorFixture(overrides = {}) {
  const sentRequests = []
  const audit = []
  const transport = overrides.transport ?? (async request => {
    sentRequests.push(structuredClone(request))
    return JSON.stringify(receiptFor(request, overrides.receipt ?? {}))
  })
  return import('../src/rj-aws/connector.mjs').then(async ({ createRjAwsConnector }) => ({
    sentRequests,
    audit,
    connector: createRjAwsConnector({
      config: { workerPublicKey: exportPublicKey(worker.publicKey) },
      identityFor: agentId => agentId === 'ace' ? ace : null,
      humanIdentity: human,
      evidence: await newEvidence(),
      audit: { append: fact => audit.push(structuredClone(fact)) },
      now: () => now,
      transport,
    }),
  }))
}

test('unconfigured RJ AWS connector registers no tools or transport work', async () => {
  const module = await import('../src/rj-aws/connector.mjs').catch(() => ({}))
  assert.equal(typeof module.createRjAwsConnector, 'function', 'RJ AWS connector implementation exists')

  let transported = false
  const connector = module.createRjAwsConnector({
    config: null,
    identityFor: () => null,
    humanIdentity: null,
    audit: { append() {} },
    transport: async () => { transported = true },
  })
  assert.equal(connector.state().status, 'not-configured')
  assert.deepEqual(connector.executors(), {})
  await assert.rejects(() => connector.execute('rj.aws.identity', {
    agentId: 'ace',
    taskId: 'task-1',
    assertActive: async () => false,
  }), { code: 'RJ_AWS_NOT_CONFIGURED' })
  assert.equal(transported, false)
})

test('connector binds a signed request to current task authority and verifies the pinned receipt before delivery', async () => {
  const { connector, sentRequests, audit } = await connectorFixture()
  let checks = 0
  const result = await connector.execute('rj.aws.identity', {
    agentId: 'ace',
    taskId: 'task-1',
    assertActive: async () => { checks++; return authority() },
  })

  assert.equal(checks, 3, 'authority is checked before audit, immediately before dispatch and after the response')
  assert.equal(sentRequests.length, 1)
  assert.equal(sentRequests[0].action.payload.agentId, 'ace')
  assert.equal(sentRequests[0].grant.payload.humanId, 'rod')
  assert.equal(sentRequests[0].action.payload.expiresAt, new Date(now + 120_000).toISOString())
  assert.deepEqual(result.result, identityResult)
  assert.equal(result.outcome, 'succeeded')
  assert.equal(result.receipt.payload.requestHash, sentRequests[0].action.payload.requestHash)
  assert.deepEqual(audit.map(entry => entry.kind), ['rj.aws.dispatch.authorized', 'rj.aws.receipt.verified'])
  const state = connector.state()
  assert.equal(state.transport.status, 'ready')
  assert.equal(state.execution.status, 'verified')
  assert.equal(state.lastReceipt.requestId, sentRequests[0].action.payload.requestId)
  assert.equal(JSON.stringify(state).includes('PRIVATE KEY'), false)
  assert.equal(Object.hasOwn(state.lastReceipt, 'signature'), false)
  assert.equal(Object.hasOwn(state.lastReceipt, 'agentPublicKey'), false)
})

test('connector rejects inactive, mismatched, expired and sandbox authority before signing or dispatch', async () => {
  for (const active of [
    false,
    authority({ agentId: 'iris' }),
    authority({ taskId: 'task-2' }),
    authority({ profileId: 'sandbox' }),
    authority({ expiresAt: new Date(now).toISOString() }),
  ]) {
    const { connector, sentRequests } = await connectorFixture()
    await assert.rejects(() => connector.execute('rj.aws.identity', {
      agentId: 'ace', taskId: 'task-1', assertActive: async () => active,
    }), error => ['RJ_TASK_AUTHORITY_INACTIVE', 'RJ_AWS_ACCESS_DENIED'].includes(error?.code))
    assert.equal(sentRequests.length, 0)
  }

  const { connector, sentRequests } = await connectorFixture()
  await assert.rejects(() => connector.execute('rj.aws.identity', {
    agentId: 'ace', taskId: 'task-1', assertActive: async () => false,
  }), { code: 'RJ_TASK_AUTHORITY_INACTIVE' })
  assert.equal(sentRequests.length, 0)
})

test('connector exposes exactly two empty-argument executors and no arbitrary operation surface', async () => {
  const { connector, sentRequests } = await connectorFixture()
  const executors = connector.executors()
  assert.deepEqual(Object.keys(executors).sort(), [
    'mcp__chimera_rj_aws__identity',
    'mcp__chimera_rj_aws__instance_status',
  ])
  const context = { agentId: 'ace', taskId: 'task-1', assertActive: async () => authority() }
  assert.equal((await executors.mcp__chimera_rj_aws__identity({}, context)).operation, 'rj.aws.identity')
  assert.equal((await executors.mcp__chimera_rj_aws__instance_status({}, context)).operation, 'rj.aws.instance_status')
  await assert.rejects(() => executors.mcp__chimera_rj_aws__identity({ region: 'us-east-1' }, context), { code: 'RJ_AWS_ARGUMENTS_INVALID' })
  await assert.rejects(() => connector.execute('aws ec2 terminate-instances', context), { code: 'RJ_AWS_OPERATION_INVALID' })
  assert.equal(sentRequests.length, 2)
})

test('tampered, wrong-worker and miscorrelated receipts never reach the caller', async t => {
  const mutations = {
    'tampered signature': envelope => { envelope.signature = 'invalid' },
    'wrong worker key': (_envelope, request) => receiptFor(request, { signingIdentity: generateIdentity('imposter') }),
    'wrong request': envelope => { envelope.payload.requestId = 'wrong-request'; return signAction(envelope.payload, worker) },
    'wrong task': envelope => { envelope.payload.taskId = 'task-2'; return signAction(envelope.payload, worker) },
    'wrong actor': envelope => { envelope.payload.agentId = 'iris'; return signAction(envelope.payload, worker) },
    'wrong hash': envelope => { envelope.payload.requestHash = 'a'.repeat(64); return signAction(envelope.payload, worker) },
    'wrong target': envelope => { envelope.payload.target.region = 'us-east-1'; return signAction(envelope.payload, worker) },
    'extra field': envelope => { envelope.payload.secret = 'not allowed'; return signAction(envelope.payload, worker) },
  }
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, async () => {
    const { connector } = await connectorFixture({ transport: async request => {
      const envelope = receiptFor(request)
      const replacement = mutate(envelope, request)
      return JSON.stringify(replacement ?? envelope)
    } })
    await assert.rejects(() => connector.execute('rj.aws.identity', {
      agentId: 'ace', taskId: 'task-1', assertActive: async () => authority(),
    }), { code: 'RJ_AWS_RECEIPT_INVALID' })
    assert.equal(connector.state().execution.status, 'unknown')
    assert.equal(connector.state().transport.status,
      ['tampered signature', 'wrong worker key'].includes(name) ? 'unknown' : 'ready')
  })
})

test('authority revoked or shortened while authorization audit is pending prevents transport dispatch', async t => {
  for (const mode of ['revoked', 'shortened']) await t.test(mode, async () => {
    let current = authority()
    let dispatches = 0
    const { createRjAwsConnector } = await import('../src/rj-aws/connector.mjs')
    const connector = createRjAwsConnector({
      config: { workerPublicKey: exportPublicKey(worker.publicKey) },
      identityFor: () => ace,
      humanIdentity: human,
      evidence: await newEvidence(),
      audit: { async append(fact) {
        if (fact.kind === 'rj.aws.dispatch.authorized') current = mode === 'revoked'
          ? false
          : authority({ expiresAt: new Date(now + 60_000).toISOString() })
      } },
      now: () => now,
      transport: async request => { dispatches += 1; return JSON.stringify(receiptFor(request)) },
    })
    await assert.rejects(connector.execute('rj.aws.identity', {
      agentId: 'ace', taskId: 'task-1', assertActive: async () => current,
    }), { code: 'RJ_TASK_AUTHORITY_INACTIVE' })
    assert.equal(dispatches, 0)
  })
})

test('authority revoked after a valid response blocks delivery while retaining only sanitized receipt evidence', async () => {
  const { connector, audit } = await connectorFixture()
  let checks = 0
  await assert.rejects(() => connector.execute('rj.aws.identity', {
    agentId: 'ace', taskId: 'task-1', assertActive: async () => {
      checks += 1
      return checks < 3 ? authority() : false
    },
  }), { code: 'RJ_TASK_AUTHORITY_INACTIVE' })
  assert.equal(connector.state().execution.status, 'unknown')
  assert.equal(connector.state().lastReceipt.outcome, 'succeeded')
  assert.deepEqual(audit.map(entry => entry.kind), ['rj.aws.dispatch.authorized', 'rj.aws.receipt.verified'])
  assert.equal(audit[1].receipt.signature.length > 0, true, 'the signed receipt remains durable audit evidence')
})

test('transport failures keep authentication, offline and unknown execution states distinct without leaking provider errors', async () => {
  for (const [code, transportStatus] of [
    ['RJ_SSH_AUTH_REQUIRED', 'auth-required'],
    ['RJ_WORKER_OFFLINE', 'offline'],
    ['RJ_AWS_OUTCOME_UNKNOWN', 'unknown'],
  ]) {
    const { connector } = await connectorFixture({ transport: async () => {
      throw Object.assign(new Error(`SECRET_SENTINEL ${code}`), { code })
    } })
    await assert.rejects(() => connector.execute('rj.aws.identity', {
      agentId: 'ace', taskId: 'task-1', assertActive: async () => authority(),
    }), error => error.code === code && error.message === code)
    const state = connector.state()
    assert.equal(state.transport.status, transportStatus)
    assert.equal(state.execution.status, 'unknown')
    assert.doesNotMatch(JSON.stringify(state), /SECRET_SENTINEL/)
  }
})

test('signed worker errors are pinned transport evidence but never correlated execution success', async () => {
  const { connector } = await connectorFixture({ transport: async () => JSON.stringify(signAction({
    schema: 'chimera.rj-aws.error.v1', workerId: 'rj-aws-worker', code: 'RJ_WORKER_BUSY',
  }, worker)) })
  await assert.rejects(() => connector.execute('rj.aws.identity', {
    agentId: 'ace', taskId: 'task-1', assertActive: async () => authority(),
  }), { code: 'RJ_WORKER_UNAVAILABLE' })
  assert.equal(connector.state().transport.status, 'ready')
  assert.equal(connector.state().execution.status, 'not-verified')

  const unsigned = await connectorFixture({ transport: async () => '{"error":"RJ_WORKER_UNAVAILABLE"}' })
  await assert.rejects(() => unsigned.connector.execute('rj.aws.identity', {
    agentId: 'ace', taskId: 'task-1', assertActive: async () => authority(),
  }), { code: 'RJ_WORKER_UNAVAILABLE' })
  assert.notEqual(unsigned.connector.state().transport.status, 'ready')
})

test('audit failure prevents dispatch and connector never falls back to ambient credentials', async () => {
  let sent = false
  const { createRjAwsConnector } = await import('../src/rj-aws/connector.mjs')
  const connector = createRjAwsConnector({
    config: { workerPublicKey: exportPublicKey(worker.publicKey) },
    identityFor: () => ace,
    humanIdentity: human,
    evidence: await newEvidence(),
    audit: { append() { throw new Error('disk unavailable') } },
    now: () => now,
    transport: async () => { sent = true },
  })
  await assert.rejects(() => connector.execute('rj.aws.identity', {
    agentId: 'ace', taskId: 'task-1', assertActive: async () => authority(),
  }), { code: 'RJ_AUDIT_UNAVAILABLE' })
  assert.equal(sent, false)
})

test('transport child can resolve the actual user home without inheriting unrelated environment', async () => {
  const { createTailscaleSshTransport } = await import('../src/rj-aws/connector.mjs')
  const transport = createTailscaleSshTransport({ spawnImpl: (_file, _args, options) => spawn(process.execPath, [
    '--input-type=module', '-e', `
      import { userInfo } from 'node:os';
      if (!process.env.HOME || process.env.HOME !== userInfo().homedir) process.exit(1);
      // CoreFoundation adds this macOS-only value after spawn, not the connector.
      const keys = Object.keys(process.env).filter(key => !(process.platform === 'darwin' && key === '__CF_USER_TEXT_ENCODING')).sort();
      if (JSON.stringify(keys) !== JSON.stringify(['HOME', 'LANG', 'PATH'])) process.exit(2);
      const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
      const request = JSON.parse(Buffer.concat(chunks));
      process.stdout.write(JSON.stringify({ requestId: request.action.payload.requestId, homeResolved: true }));
    `,
  ], options) })
  const request = createRjAwsRequest({ operation: 'rj.aws.identity', taskId: 'task-1', agentIdentity: ace,
    humanIdentity: human, now, expiresAt: now + 5_000, requestId: 'request-home-regression' })
  assert.deepEqual(JSON.parse(await transport(request, { timeoutMs: 5_000 })), {
    requestId: 'request-home-regression', homeResolved: true,
  })
})

test('default transport uses fixed Tailscale SSH argv, bounded stdin and a credential-free environment', async () => {
  const { createTailscaleSshTransport } = await import('../src/rj-aws/connector.mjs')
  const observed = {}
  const spawnImpl = (file, args, options) => {
    Object.assign(observed, { file, args: [...args], options: structuredClone(options) })
    const child = new EventEmitter()
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = signal => { observed.killed = signal; return true }
    const chunks = []
    child.stdin.on('data', chunk => chunks.push(Buffer.from(chunk)))
    child.stdin.on('end', () => {
      observed.stdin = Buffer.concat(chunks).toString('utf8')
      child.stdout.end('{"ok":true}')
      queueMicrotask(() => child.emit('close', 0, null))
    })
    return child
  }
  const request = createRjAwsRequest({ operation: 'rj.aws.identity', taskId: 'task-1', agentIdentity: ace,
    humanIdentity: human, now, expiresAt: now + 5_000, requestId: 'request-fixed-transport' })
  const response = await createTailscaleSshTransport({ spawnImpl })(request, { timeoutMs: 5_000 })
  assert.equal(response, '{"ok":true}')
  assert.equal(observed.file, '/usr/bin/tailscale')
  assert.deepEqual(observed.args, ['ssh', 'example-user@example.invalid', '/usr/local/bin/chimera-rj-aws-worker'])
  assert.deepEqual(observed.options.env, { HOME: userInfo().homedir, PATH: '/usr/bin:/bin', LANG: 'C' })
  assert.deepEqual(observed.options.stdio, ['pipe', 'pipe', 'pipe'])
  assert.equal(observed.stdin, `${canonicalJson(request)}\n`)
  assert.doesNotMatch(JSON.stringify(observed.args), /request-fixed-transport|AWS_|SECRET|TOKEN/i)
})

test('transport kills a timed-out request and treats timeout or post-spawn disconnect as uncertain without replay', async () => {
  const { createTailscaleSshTransport } = await import('../src/rj-aws/connector.mjs')
  let launches = 0, killed = null
  const child = () => {
    launches += 1
    const value = new EventEmitter()
    value.stdin = new PassThrough(); value.stdout = new PassThrough(); value.stderr = new PassThrough()
    value.kill = signal => { killed = signal; return true }
    return value
  }
  const request = createRjAwsRequest({ operation: 'rj.aws.identity', taskId: 'task-1', agentIdentity: ace,
    humanIdentity: human, now, expiresAt: now + 5_000, requestId: 'request-uncertain' })
  await assert.rejects(createTailscaleSshTransport({ spawnImpl: child })(request, { timeoutMs: 5 }), { code: 'RJ_AWS_OUTCOME_UNKNOWN' })
  assert.equal(killed, 'SIGKILL')
  assert.equal(launches, 1, 'uncertain requests are never replayed')

  const disconnected = createTailscaleSshTransport({ spawnImpl: () => {
    const value = child()
    value.stdin.on('finish', () => queueMicrotask(() => value.emit('close', 255, null)))
    return value
  } })
  await assert.rejects(disconnected(request, { timeoutMs: 5_000 }), { code: 'RJ_AWS_OUTCOME_UNKNOWN' })
  assert.equal(launches, 2)
})

test('transport enforces the 32 KiB request and 64 KiB response boundaries before unbounded buffering', async () => {
  const { createTailscaleSshTransport } = await import('../src/rj-aws/connector.mjs')
  let launches = 0, killed = null
  const spawnImpl = () => {
    launches += 1
    const child = new EventEmitter()
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
    child.kill = signal => { killed = signal; return true }
    child.stdin.on('finish', () => child.stdout.write(Buffer.alloc(RJ_RECEIPT_LIMIT + 1, 0x61)))
    return child
  }
  const transport = createTailscaleSshTransport({ spawnImpl })
  await assert.rejects(transport({ oversized: 'x'.repeat(33 * 1024) }, { timeoutMs: 1_000 }), { code: 'RJ_AWS_OUTCOME_UNKNOWN' })
  assert.equal(launches, 0)
  const request = createRjAwsRequest({ operation: 'rj.aws.identity', taskId: 'task-1', agentIdentity: ace,
    humanIdentity: human, now, expiresAt: now + 5_000, requestId: 'request-bounds' })
  await assert.rejects(transport(request, { timeoutMs: 1_000 }), { code: 'RJ_AWS_OUTCOME_UNKNOWN' })
  assert.equal(killed, 'SIGKILL')
})
