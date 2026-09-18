import { createPublicKey } from 'node:crypto'
import { spawn } from 'node:child_process'
import { userInfo } from 'node:os'
import { canonicalJson, sha256 } from '../canonical.mjs'
import { fingerprint, verifyPayload } from '../identity.mjs'
import {
  createRjAwsRequest,
  createRjAwsReconciliation,
  verifyRjAwsRequest,
  exactFields,
  RJ_OPERATIONS,
  RJ_RECEIPT_LIMIT,
  RJ_REQUEST_LIMIT,
  RJ_TARGET,
  normalizeRjAwsSecurity,
  sanitizeRjAwsResult,
} from './protocol.mjs'

export const RJ_AWS_TOOLS = Object.freeze({
  mcp__chimera_rj_aws__identity: 'rj.aws.identity',
  mcp__chimera_rj_aws__instance_status: 'rj.aws.instance_status',
})

export const RJ_SSH_TARGET = 'example-user@example.invalid'
export const RJ_WORKER_ENTRYPOINT = '/usr/local/bin/chimera-rj-aws-worker'
export const RJ_AWS_CONFIG_PATH = '/etc/chimera/rj-aws/imds-config'
const MAX_LIFETIME_MS = 5 * 60_000
const AUTHORITY_FIELDS = ['agentId', 'taskId', 'profileId', 'expiresAt']
const RECEIPT_FIELDS = ['schema', 'requestId', 'taskId', 'agentId', 'requestHash', 'operation', 'target', 'workerId', 'outcome', 'acceptedAt', 'completedAt', 'result']

function coded(code) {
  return Object.assign(new Error(code), { code })
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function configError() {
  return coded('RJ_AWS_CONFIG_INVALID')
}

function text(value, maximum = 4096) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value)
}

function validSshTarget(value) {
  return text(value, 512) && !value.startsWith('-') && !/[\s/@]/.test(value.slice(value.indexOf('@') + 1))
    && /^[A-Za-z0-9._-]+(?:@[A-Za-z0-9.[\]:_-]+)?$/.test(value)
}

function validAbsolutePath(value, maximum = 4096) {
  return text(value, maximum) && value.startsWith('/') && !value.split('/').includes('..')
}

function validRemoteEntrypoint(value) {
  return validAbsolutePath(value) && /^\/[A-Za-z0-9._/-]+$/.test(value)
}

function envValue(env, names) {
  const name = names.find(key => Object.hasOwn(env ?? {}, key))
  if (!name || env[name] === undefined || env[name] === '') return ''
  if (typeof env[name] !== 'string') throw configError()
  return env[name].trim()
}

function normalizeConnectorConfig(config) {
  if (!record(config)) throw configError()
  // Existing embedders pass only the public key. Preserve that API while
  // making its fallback entirely synthetic; environment configuration below
  // requires every real destination to be explicit.
  const legacy = Object.keys(config).sort().join(',') === 'workerPublicKey'
  const value = legacy ? {
    ...config,
    target: { ...RJ_TARGET },
    roleArn: 'arn:aws:iam::000000000000:role/example-rj-aws-worker',
    assumedRolePrefix: 'arn:aws:sts::000000000000:assumed-role/example-rj-aws-worker/',
    sshTarget: RJ_SSH_TARGET,
    workerEntrypoint: RJ_WORKER_ENTRYPOINT,
    awsConfigPath: RJ_AWS_CONFIG_PATH,
  } : config
  if (!exactFields(value, ['assumedRolePrefix', 'awsConfigPath', 'roleArn', 'sshTarget', 'target', 'workerEntrypoint', 'workerPublicKey'])
    || typeof value.workerPublicKey !== 'string' || value.workerPublicKey.length > 8192
    || !validSshTarget(value.sshTarget) || !validRemoteEntrypoint(value.workerEntrypoint)
    || !validAbsolutePath(value.awsConfigPath)) throw configError()
  let security
  try { security = normalizeRjAwsSecurity({ target: value.target, roleArn: value.roleArn, assumedRolePrefix: value.assumedRolePrefix }) } catch { throw configError() }
  try {
    const key = createPublicKey(value.workerPublicKey)
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('wrong key type')
  } catch { throw configError() }
  return { ...value, ...security, sshTarget: value.sshTarget, workerEntrypoint: value.workerEntrypoint, awsConfigPath: value.awsConfigPath }
}

function timestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}

function safeTransportCode(error) {
  return ['RJ_SSH_AUTH_REQUIRED', 'RJ_WORKER_OFFLINE', 'RJ_AWS_OUTCOME_UNKNOWN'].includes(error?.code)
    ? error.code
    : 'RJ_WORKER_OFFLINE'
}

function publicTarget(config) {
  return {
    ...config.target,
    ssh: config.sshTarget,
  }
}

function validatePinnedKey(config) {
  try {
    const key = createPublicKey(config.workerPublicKey)
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('wrong key type')
    return key
  } catch {
    throw coded('RJ_AWS_CONFIG_INVALID')
  }
}

function publicReceipt(payload) {
  return {
    requestId: payload.requestId,
    taskId: payload.taskId,
    agentId: payload.agentId,
    operation: payload.operation,
    target: structuredClone(payload.target),
    outcome: payload.outcome,
    acceptedAt: payload.acceptedAt,
    completedAt: payload.completedAt,
    result: structuredClone(payload.result),
  }
}

function validateWorkerEnvelope(envelope, pinnedWorkerKey) {
  try {
    return exactFields(envelope, ['agentPublicKey', 'payload', 'signature'])
      && typeof envelope.agentPublicKey === 'string'
      && fingerprint(envelope.agentPublicKey) === fingerprint(pinnedWorkerKey)
      && verifyPayload(envelope.payload, envelope.signature, pinnedWorkerKey)
  } catch { return false }
}

function validateSignedWorkerError(envelope, pinnedWorkerKey) {
  return validateWorkerEnvelope(envelope, pinnedWorkerKey)
    && exactFields(envelope.payload, ['schema', 'workerId', 'code'])
    && envelope.payload.schema === 'chimera.rj-aws.error.v1'
    && envelope.payload.workerId === 'rj-aws-worker'
    && /^RJ_[A-Z0-9_]{2,120}$/.test(envelope.payload.code)
}

function validateReceipt(envelope, request, pinnedWorkerKey, config) {
  try {
    if (Buffer.byteLength(canonicalJson(envelope), 'utf8') > RJ_RECEIPT_LIMIT
      || !validateWorkerEnvelope(envelope, pinnedWorkerKey)
      || !exactFields(envelope.payload, RECEIPT_FIELDS)) throw coded('RJ_AWS_RECEIPT_INVALID')
    const payload = envelope.payload
    const action = request.action.payload
    if (payload.schema !== 'chimera.rj-aws.receipt.v1'
      || payload.workerId !== 'rj-aws-worker'
      || !['succeeded', 'failed', 'uncertain'].includes(payload.outcome)
      || !timestamp(payload.acceptedAt)
      || !timestamp(payload.completedAt)
      || Date.parse(payload.completedAt) < Date.parse(payload.acceptedAt)
      || payload.requestId !== action.requestId
      || payload.taskId !== action.taskId
      || payload.agentId !== action.agentId
      || payload.requestHash !== action.requestHash
      || payload.operation !== request.operation
      || canonicalJson(payload.target) !== canonicalJson(config.target)) throw coded('RJ_AWS_RECEIPT_INVALID')
    const result = payload.outcome === 'succeeded'
      ? sanitizeRjAwsResult(payload.operation, payload.result, config)
      : payload.outcome === 'failed'
        ? { code: 'RJ_AWS_UNAVAILABLE' }
        : {}
    if (canonicalJson(result) !== canonicalJson(payload.result)) throw coded('RJ_AWS_RECEIPT_INVALID')
    return { envelope: structuredClone(envelope), payload: structuredClone(payload), result }
  } catch {
    throw coded('RJ_AWS_RECEIPT_INVALID')
  }
}

async function activeAuthority(context, now) {
  if (!record(context)
    || typeof context.agentId !== 'string'
    || typeof context.taskId !== 'string'
    || typeof context.assertActive !== 'function') throw coded('RJ_TASK_AUTHORITY_INACTIVE')
  let authority
  try { authority = await context.assertActive() } catch { throw coded('RJ_TASK_AUTHORITY_INACTIVE') }
  if (authority === false
    || !exactFields(authority, AUTHORITY_FIELDS)
    || authority.agentId !== context.agentId
    || authority.taskId !== context.taskId
    || !timestamp(authority.expiresAt)
    || Date.parse(authority.expiresAt) <= now) throw coded('RJ_TASK_AUTHORITY_INACTIVE')
  if (!['connected', 'live'].includes(authority.profileId)) throw coded('RJ_AWS_ACCESS_DENIED')
  return authority
}

export function rjAwsConfigFromEnv(env = process.env) {
  try {
    const encoded = envValue(env, ['CHIMERA_RJ_AWS_WORKER_PUBLIC_KEY_BASE64'])
    const account = envValue(env, ['CHIMERA_RJ_AWS_ACCOUNT_ID', 'CHIMERA_RJ_AWS_ACCOUNT'])
    const region = envValue(env, ['CHIMERA_RJ_AWS_REGION'])
    const instanceId = envValue(env, ['CHIMERA_RJ_AWS_INSTANCE_ID'])
    const roleArn = envValue(env, ['CHIMERA_RJ_AWS_ROLE_ARN'])
    const sshTarget = envValue(env, ['CHIMERA_RJ_AWS_SSH_TARGET'])
    const workerEntrypoint = envValue(env, ['CHIMERA_RJ_AWS_WORKER_ENTRYPOINT'])
    const assumedRolePrefix = envValue(env, ['CHIMERA_RJ_AWS_ASSUMED_ROLE_PREFIX'])
    const configuredAwsConfigPath = envValue(env, ['CHIMERA_RJ_AWS_CONFIG_PATH'])
    const required = [encoded, account, region, instanceId, roleArn, sshTarget, workerEntrypoint]
    if ([...required, assumedRolePrefix, configuredAwsConfigPath].every(value => value === '')) return null
    if (required.some(value => value === '') || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length > 12_000) throw configError()
    const bytes = Buffer.from(encoded, 'base64')
    if (bytes.toString('base64') !== encoded) throw configError()
    const parsed = normalizeConnectorConfig({
      workerPublicKey: bytes.toString('utf8'),
      target: { account, region, instanceId },
      roleArn,
      assumedRolePrefix: assumedRolePrefix || undefined,
      sshTarget,
      workerEntrypoint,
      awsConfigPath: configuredAwsConfigPath || RJ_AWS_CONFIG_PATH,
    })
    return parsed
  } catch (error) {
    if (error?.code === 'RJ_AWS_CONFIG_INVALID') throw error
    throw configError()
  }
}

export function createTailscaleSshTransport({ spawnImpl = spawn, sshTarget = RJ_SSH_TARGET, workerEntrypoint = RJ_WORKER_ENTRYPOINT } = {}) {
  if (typeof spawnImpl !== 'function') throw new TypeError('RJ_AWS_TRANSPORT_CONFIG_INVALID')
  if (!validSshTarget(sshTarget) || !validRemoteEntrypoint(workerEntrypoint)) throw new TypeError('RJ_AWS_TRANSPORT_CONFIG_INVALID')
  return async (request, { timeoutMs } = {}) => {
    let input
    try { input = `${canonicalJson(request)}\n` } catch { throw coded('RJ_AWS_OUTCOME_UNKNOWN') }
    if (Buffer.byteLength(input, 'utf8') > RJ_REQUEST_LIMIT
      || !Number.isFinite(timeoutMs)
      || timeoutMs < 1
      || timeoutMs > MAX_LIFETIME_MS) throw coded('RJ_AWS_OUTCOME_UNKNOWN')
    return new Promise((resolve, reject) => {
      let child
      let settled = false
      let stdoutSize = 0
      let stderrSize = 0
      const stdout = []
      const stderr = []
      let timer
      const finish = (error, result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) reject(coded(error))
        else resolve(result)
      }
      try {
        child = spawnImpl('/usr/bin/tailscale', ['ssh', sshTarget, workerEntrypoint], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { HOME: userInfo().homedir, PATH: '/usr/bin:/bin', LANG: 'C' },
        })
      } catch {
        return finish('RJ_WORKER_OFFLINE')
      }
      timer = setTimeout(() => {
        child.kill?.('SIGKILL')
        finish('RJ_AWS_OUTCOME_UNKNOWN')
      }, timeoutMs)
      child.stdout?.on('data', chunk => {
        const buffer = Buffer.from(chunk)
        stdoutSize += buffer.length
        if (stdoutSize > RJ_RECEIPT_LIMIT) {
          child.kill?.('SIGKILL')
          finish('RJ_AWS_OUTCOME_UNKNOWN')
        } else stdout.push(buffer)
      })
      child.stderr?.on('data', chunk => {
        if (stderrSize >= 8192) return
        const buffer = Buffer.from(chunk)
        const remaining = 8192 - stderrSize
        stderr.push(buffer.subarray(0, remaining))
        stderrSize += Math.min(buffer.length, remaining)
      })
      child.once?.('error', () => finish('RJ_WORKER_OFFLINE'))
      child.once?.('close', (code, signal) => {
        const output = Buffer.concat(stdout).toString('utf8')
        if (code === 0 && !signal) return finish(null, output)
        if (Number.isInteger(code) && !signal && output.length) return finish(null, { stdout: output, exitCode: code })
        const privateStderr = Buffer.concat(stderr).toString('utf8')
        return finish(/auth|login|logged out|access denied|permission denied/i.test(privateStderr)
          ? 'RJ_SSH_AUTH_REQUIRED'
          : 'RJ_AWS_OUTCOME_UNKNOWN')
      })
      child.stdin?.once?.('error', () => finish('RJ_AWS_OUTCOME_UNKNOWN'))
      child.stdin?.end(input)
    })
  }
}

export function createRjAwsConnector({
  config,
  identityFor,
  humanIdentity,
  audit,
  evidence,
  now = () => Date.now(),
  transport,
} = {}) {
  const configured = config !== null && config !== undefined
  if (!configured) {
    const unavailableState = {
      schema: 'chimera.rj-aws-connection.v1',
      configured: false,
      status: 'not-configured',
      target: { account: null, region: null, instanceId: null, ssh: null },
      transport: { status: 'not-configured' },
      execution: { status: 'not-verified' },
      lastReceipt: null,
    }
    return {
      state: () => structuredClone(unavailableState),
      executors: () => ({}),
      execute: async () => { throw coded('RJ_AWS_NOT_CONFIGURED') },
      reconcile: async () => { throw coded('RJ_AWS_NOT_CONFIGURED') },
    }
  }
  const resolvedConfig = normalizeConnectorConfig(config)
  const resolvedTransport = transport ?? createTailscaleSshTransport({
    sshTarget: resolvedConfig.sshTarget,
    workerEntrypoint: resolvedConfig.workerEntrypoint,
  })
  if (typeof identityFor !== 'function' || !humanIdentity?.privateKey || !audit?.append || typeof now !== 'function' || typeof resolvedTransport !== 'function') {
    throw coded('RJ_AWS_CONFIG_INVALID')
  }
  const pinnedWorkerKey = validatePinnedKey(resolvedConfig)
  try {
    for (const entry of evidence?.list?.() ?? []) {
      verifyRjAwsRequest(entry.request, { humanKeys: [[humanIdentity.keyId, humanIdentity.publicKey]], now: Date.parse(entry.request?.action?.payload?.issuedAt), target: resolvedConfig.target })
      if (entry.receipt) validateReceipt(entry.receipt, entry.request, pinnedWorkerKey, resolvedConfig)
    }
  } catch { throw coded('RJ_EVIDENCE_UNAVAILABLE') }
  const connection = {
    schema: 'chimera.rj-aws-connection.v1',
    configured: true,
    status: 'not-checked',
    target: publicTarget(resolvedConfig),
    transport: { status: 'not-checked' },
    execution: { status: 'not-verified' },
    lastReceipt: null,
    retention: { status: 'not-checked' },
    audit: { status: 'not-checked' },
  }
  const setStatus = () => {
    connection.status = connection.execution.status === 'verified' ? 'execution-verified'
      : connection.transport.status === 'ready' ? 'transport-ready'
        : connection.transport.status === 'auth-required' ? 'auth-required'
          : connection.transport.status === 'offline' ? 'offline'
            : connection.transport.status === 'unknown' ? 'unknown'
              : 'not-checked'
  }
  const perform = async (request, { context, authority, startedAt, wireRequest = request, reconciliation = false }) => {
    const operation = request.operation
    connection.execution = { status: 'unknown' }
    setStatus()
    try {
      if (!evidence?.put) throw coded('RJ_EVIDENCE_UNAVAILABLE')
      await evidence.put(request)
      connection.retention = { status: 'retained' }
    } catch { connection.retention = { status: 'unavailable' }; throw coded('RJ_EVIDENCE_UNAVAILABLE') }
    try {
      await audit.append({
        kind: reconciliation ? 'rj.aws.reconciliation.authorized' : 'rj.aws.dispatch.authorized',
        requestId: request.action.payload.requestId,
        taskId: request.action.payload.taskId,
        agentId: request.action.payload.agentId,
        operation,
        target: publicTarget(resolvedConfig),
        requestHash: request.action.payload.requestHash,
        expiresAt: request.action.payload.expiresAt,
        at: new Date(startedAt).toISOString(),
      })
      connection.audit = { status: 'retained' }
    } catch { connection.audit = { status: 'unavailable' }; throw coded('RJ_AUDIT_UNAVAILABLE') }
    if (!reconciliation) {
      const auditedAuthority = await activeAuthority(context, now())
      if (canonicalJson(auditedAuthority) !== canonicalJson(authority)) throw coded('RJ_TASK_AUTHORITY_INACTIVE')
    }
    let raw
    try {
      raw = await resolvedTransport(structuredClone(wireRequest), {
        timeoutMs: Math.min(MAX_LIFETIME_MS, Date.parse(reconciliation ? wireRequest.authorization.payload.expiresAt : request.action.payload.expiresAt) - now()),
      })
    } catch (error) {
      const code = safeTransportCode(error)
      connection.transport = { status: code === 'RJ_SSH_AUTH_REQUIRED' ? 'auth-required' : code === 'RJ_WORKER_OFFLINE' ? 'offline' : 'unknown' }
      connection.execution = { status: 'unknown' }
      setStatus()
      throw coded(code)
    }
    let envelope
    const nonzero = record(raw) && Number.isInteger(raw.exitCode) && raw.exitCode !== 0
    if (nonzero) raw = raw.stdout
    try {
      if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > RJ_RECEIPT_LIMIT) throw new Error('invalid')
      envelope = JSON.parse(raw)
    } catch {
      connection.transport = { status: 'unknown' }
      connection.execution = { status: 'unknown' }
      setStatus()
      throw coded('RJ_AWS_RECEIPT_INVALID')
    }
    if (validateSignedWorkerError(envelope, pinnedWorkerKey)) {
      connection.transport = { status: 'ready' }
      connection.execution = { status: 'not-verified' }
      setStatus()
      throw coded('RJ_WORKER_UNAVAILABLE')
    }
    if (!nonzero && record(envelope) && envelope.error === 'RJ_WORKER_UNAVAILABLE') {
      connection.transport = { status: 'unknown' }
      connection.execution = { status: 'not-verified' }
      setStatus()
      throw coded('RJ_WORKER_UNAVAILABLE')
    }
    let verified
    try { verified = validateReceipt(envelope, request, pinnedWorkerKey, resolvedConfig) } catch {
      let pinnedWorkerAuthenticated = false
      try { pinnedWorkerAuthenticated = validateWorkerEnvelope(envelope, pinnedWorkerKey) } catch {}
      connection.transport = { status: pinnedWorkerAuthenticated ? 'ready' : 'unknown' }
      connection.execution = { status: 'unknown' }
      setStatus()
      throw coded('RJ_AWS_RECEIPT_INVALID')
    }
    connection.transport = { status: 'ready' }
    try {
      await evidence.put(request, verified.envelope)
      connection.retention = { status: 'retained' }
      connection.lastReceipt = publicReceipt(verified.payload)
    } catch {
      connection.retention = { status: 'unavailable' }
      connection.execution = { status: 'unknown' }
      setStatus()
      throw coded('RJ_EVIDENCE_UNAVAILABLE')
    }
    try {
      await audit.append({
        kind: 'rj.aws.receipt.verified',
        requestId: verified.payload.requestId,
        taskId: verified.payload.taskId,
        agentId: verified.payload.agentId,
        operation: verified.payload.operation,
        outcome: verified.payload.outcome,
        receiptHash: sha256(verified.envelope),
        receipt: structuredClone(verified.envelope),
        completedAt: verified.payload.completedAt,
        at: new Date(now()).toISOString(),
      })
      connection.audit = { status: 'retained' }
    } catch {
      connection.audit = { status: 'unavailable' }
      connection.execution = { status: 'unknown' }
      setStatus()
      throw coded('RJ_AUDIT_UNAVAILABLE')
    }
    try { if (!reconciliation) await activeAuthority(context, now()) } catch {
      connection.execution = { status: 'unknown' }
      setStatus()
      throw coded('RJ_TASK_AUTHORITY_INACTIVE')
    }
    connection.execution = { status: reconciliation ? 'reconciled' : verified.payload.outcome === 'succeeded' ? 'verified' : verified.payload.outcome }
    setStatus()
    return {
      schema: 'chimera.rj-aws-execution.v1',
      operation,
      target: structuredClone(verified.payload.target),
      outcome: verified.payload.outcome,
      result: structuredClone(verified.result),
      receipt: verified.envelope,
    }
  }
  const execute = async (operation, context) => {
    if (!RJ_OPERATIONS.includes(operation)) throw coded('RJ_AWS_OPERATION_INVALID')
    const startedAt = now()
    if (!Number.isFinite(startedAt)) throw coded('RJ_TASK_AUTHORITY_INACTIVE')
    const authority = await activeAuthority(context, startedAt)
    const identity = identityFor(context.agentId)
    if (!identity?.privateKey || identity.id !== context.agentId) throw coded('RJ_TASK_IDENTITY_UNAVAILABLE')
    const request = createRjAwsRequest({ operation, taskId: context.taskId, agentIdentity: identity, humanIdentity,
      now: startedAt, expiresAt: authority.expiresAt, target: resolvedConfig.target })
    return perform(request, { context, authority, startedAt })
  }
  const reconcile = async requestId => {
    const entry = await evidence?.get?.(requestId)
    if (!entry || entry.request.action.payload.requestId !== requestId) throw coded('RJ_REQUEST_NOT_FOUND')
    const startedAt = now()
    const wireRequest = createRjAwsReconciliation({ request: entry.request, humanIdentity, now: startedAt, target: resolvedConfig.target })
    return perform(entry.request, { startedAt, wireRequest, reconciliation: true })
  }
  // Keep one connection attempt through durable retention/audit settlement.
  // A queued call resolves fresh authority when it starts; this never retries it.
  let settlement = Promise.resolve()
  const serial = operation => {
    const pending = settlement.then(operation)
    settlement = pending.catch(() => {})
    return pending
  }
  const executors = Object.fromEntries(Object.entries(RJ_AWS_TOOLS).map(([tool, operation]) => [tool, async (args, context) => {
    if (!exactFields(args, [])) throw coded('RJ_AWS_ARGUMENTS_INVALID')
    return serial(() => execute(operation, context))
  }]))
  return {
    state: () => ({ ...structuredClone(connection), requests: (evidence?.list?.() ?? []).map(({ request, receipt }) => ({
      requestId: request.action.payload.requestId, taskId: request.action.payload.taskId, operation: request.operation,
      outcome: receipt?.payload?.outcome ?? 'unknown',
    })) }),
    execute: (operation, context) => serial(() => execute(operation, context)),
    reconcile: requestId => serial(() => reconcile(requestId)),
    executors: () => ({ ...executors }),
  }
}
