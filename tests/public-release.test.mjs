import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { exportPublicKey, generateIdentity } from '../src/identity.mjs'
import {
  GOOGLE_ACCOUNT,
  GOOGLE_SCOPES,
  GoogleConnection,
  googleConfigFromEnv,
} from '../src/clients/google-connection.mjs'
import {
  FORM_ID,
  GoogleIntake,
} from '../src/clients/google-intake.mjs'
import {
  createRjAwsConnector,
  createTailscaleSshTransport,
  rjAwsConfigFromEnv,
  RJ_SSH_TARGET,
} from '../src/rj-aws/connector.mjs'
import {
  createRjAwsRequest,
  RJ_ASSUMED_ROLE_PREFIX,
  RJ_ROLE_ARN,
  RJ_TARGET,
  sanitizeRjAwsResult,
  verifyRjAwsRequest,
} from '../src/rj-aws/protocol.mjs'

const configuredTarget = Object.freeze({
  account: '123456789012',
  region: 'us-test-1',
  instanceId: 'i-0123456789abcdef0',
})
const configuredRoleArn = 'arn:aws:iam::123456789012:role/chimera-test-worker'
const configuredRolePrefix = 'arn:aws:sts::123456789012:assumed-role/chimera-test-worker/'

test('public defaults have no personal Google or AWS target', async () => {
  assert.equal(GOOGLE_ACCOUNT, null)
  assert.equal(FORM_ID, null)
  assert.equal(googleConfigFromEnv({}), null)
  assert.deepEqual(RJ_TARGET, {
    account: '000000000000',
    region: 'example-region-1',
    instanceId: 'i-example00000000000',
  })
  assert.equal(RJ_ROLE_ARN, 'arn:aws:iam::000000000000:role/example-rj-aws-worker')
  assert.equal(RJ_ASSUMED_ROLE_PREFIX, 'arn:aws:sts::000000000000:assumed-role/example-rj-aws-worker/')
  assert.match(RJ_SSH_TARGET, /\.invalid$/)
  const routing = JSON.parse(await readFile(new URL('../config/model-routing.json', import.meta.url), 'utf8'))
  assert.ok(!routing.media?.videoOutputS3Uri, 'media output must be explicitly configured by each operator')
})

test('absent optional connector settings make no transport calls', async () => {
  let googleFetches = 0
  let browserLaunches = 0
  let googleDeletes = 0
  const google = new GoogleConnection({
    account: null,
    keychain: { async available() { return true }, async delete() { googleDeletes += 1 } },
    fetch: async () => { googleFetches += 1; throw new Error('unexpected fetch') },
    openBrowser: async () => { browserLaunches += 1 },
  })
  assert.equal((await google.connect()).state, 'setup_required')
  assert.equal(googleFetches, 0)
  assert.equal(browserLaunches, 0)
  await google.disconnect()
  assert.equal(googleDeletes, 0)

  let intakeTokens = 0
  let intakeFetches = 0
  const intake = new GoogleIntake({
    formId: null,
    connection: { async accessToken() { intakeTokens += 1; return 'unexpected' } },
    fetch: async () => { intakeFetches += 1; throw new Error('unexpected fetch') },
  })
  await assert.rejects(() => intake.scan({ capture() {} }), { code: 'CLIENT_INTAKE_GOOGLE_SETUP_REQUIRED' })
  assert.equal(intakeTokens, 0)
  assert.equal(intakeFetches, 0)

  let awsTransported = 0
  const aws = createRjAwsConnector({
    config: null,
    transport: async () => { awsTransported += 1 },
  })
  await assert.rejects(() => aws.execute('rj.aws.identity', {}), { code: 'RJ_AWS_NOT_CONFIGURED' })
  assert.equal(awsTransported, 0)
})

test('explicit Google identity is exact-match enforced and validated', async () => {
  const config = googleConfigFromEnv({
    CHIMERA_GOOGLE_ACCOUNT: 'owner@example.test',
    CHIMERA_GOOGLE_FORM_ID: 'example-form-id',
  })
  assert.deepEqual(config, { account: 'owner@example.test', formId: 'example-form-id' })
  const connection = new GoogleConnection({ account: config.account, fetch: async () => new Response('{}') })
  const token = { access_token: 'synthetic-access', expires_in: 3600, scope: GOOGLE_SCOPES.join(' ') }
  connection.fetch = async url => url === 'https://openidconnect.googleapis.com/v1/userinfo'
    ? new Response(JSON.stringify({ sub: 'synthetic-subject', email: 'owner@example.test', email_verified: true }))
    : new Response('{}')
  assert.deepEqual(await connection.verify(token), {
    accessToken: 'synthetic-access',
    expiresAt: connection.now() + 3600 * 1000,
    email: 'owner@example.test',
  })
  connection.fetch = async () => new Response(JSON.stringify({ sub: 'synthetic-subject', email: 'other@example.test', email_verified: true }))
  await assert.rejects(() => connection.verify(token), { code: 'CLIENT_INTAKE_GOOGLE_ACCOUNT_MISMATCH' })
  assert.throws(() => googleConfigFromEnv({ CHIMERA_GOOGLE_ACCOUNT: 'not-an-email', CHIMERA_GOOGLE_FORM_ID: 'example-form-id' }), { code: 'CLIENT_INTAKE_GOOGLE_CONFIG_INVALID' })
  assert.deepEqual(googleConfigFromEnv({ CHIMERA_GOOGLE_ACCOUNT: 'owner@example.test' }), { account: 'owner@example.test', formId: null })
})

test('explicit AWS target and role remain exact-match enforced at every signed boundary', async () => {
  const worker = generateIdentity('worker')
  const human = generateIdentity('operator')
  const encoded = Buffer.from(exportPublicKey(worker.publicKey)).toString('base64')
  const config = rjAwsConfigFromEnv({
    CHIMERA_RJ_AWS_WORKER_PUBLIC_KEY_BASE64: encoded,
    CHIMERA_RJ_AWS_ACCOUNT_ID: configuredTarget.account,
    CHIMERA_RJ_AWS_REGION: configuredTarget.region,
    CHIMERA_RJ_AWS_INSTANCE_ID: configuredTarget.instanceId,
    CHIMERA_RJ_AWS_ROLE_ARN: configuredRoleArn,
    CHIMERA_RJ_AWS_SSH_TARGET: 'worker@example.invalid',
    CHIMERA_RJ_AWS_WORKER_ENTRYPOINT: '/usr/local/bin/chimera-rj-aws-worker',
  })
  assert.deepEqual(config.target, configuredTarget)
  assert.equal(config.roleArn, configuredRoleArn)
  assert.equal(config.assumedRolePrefix, configuredRolePrefix)
  const now = Date.parse('2026-09-17T12:00:00.000Z')
  const request = createRjAwsRequest({
    operation: 'rj.aws.identity',
    taskId: 'task-example',
    agentIdentity: worker,
    humanIdentity: human,
    target: config.target,
    now,
    requestId: 'request-example',
  })
  assert.deepEqual(request.target, configuredTarget)
  assert.doesNotThrow(() => verifyRjAwsRequest(request, {
    humanKeys: [[human.keyId, human.publicKey]],
    target: config.target,
    now,
  }))
  await assert.rejects(async () => verifyRjAwsRequest(request, {
    humanKeys: [[human.keyId, human.publicKey]],
    target: { ...configuredTarget, instanceId: 'i-foreign0000000000' },
    now,
  }), /RJ_REQUEST_INVALID/)
  assert.deepEqual(sanitizeRjAwsResult('rj.aws.identity', {
    account: configuredTarget.account,
    arn: `${configuredRolePrefix}session-example`,
    userId: 'AROAEXAMPLE:session',
  }, { target: config.target, assumedRolePrefix: config.assumedRolePrefix }), {
    account: configuredTarget.account,
    arn: `${configuredRolePrefix}session-example`,
    userId: 'AROAEXAMPLE:session',
  })
  assert.throws(() => sanitizeRjAwsResult('rj.aws.identity', {
    account: '210987654321',
    arn: `${configuredRolePrefix}session-example`,
    userId: 'AROAEXAMPLE:session',
  }, { target: config.target, assumedRolePrefix: config.assumedRolePrefix }), /RJ_AWS_UNAVAILABLE/)
})

test('RJ configuration ignores a general AWS region and rejects unsafe transport arguments', () => {
  assert.equal(rjAwsConfigFromEnv({ CHIMERA_AWS_REGION: 'us-east-1' }), null)
  for (const options of [
    { sshTarget: '-oProxyCommand=echo' },
    { workerEntrypoint: '/tmp/worker;echo unsafe' },
    { workerEntrypoint: '/tmp/worker name' },
  ]) {
    assert.throws(() => createTailscaleSshTransport({ spawnImpl: () => {}, ...options }), /RJ_AWS_TRANSPORT_CONFIG_INVALID/)
  }
})
