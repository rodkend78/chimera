import { randomUUID } from 'node:crypto'
import { canonicalJson, sha256 } from '../canonical.mjs'
import { fingerprint, signAction, signGrant, verifyPayload } from '../identity.mjs'

// The bridge is optional. These deliberately synthetic defaults keep an
// unconfigured checkout unable to address an owner's AWS account or host.
export const RJ_TARGET = Object.freeze({ account: '000000000000', region: 'example-region-1', instanceId: 'i-example00000000000' })
export const RJ_OPERATIONS = Object.freeze(['rj.aws.identity', 'rj.aws.instance_status'])
export const RJ_REQUEST_LIMIT = 32 * 1024
export const RJ_RECEIPT_LIMIT = 64 * 1024
export const RJ_ROLE_ARN = 'arn:aws:iam::000000000000:role/example-rj-aws-worker'
export const RJ_ASSUMED_ROLE_PREFIX = 'arn:aws:sts::000000000000:assumed-role/example-rj-aws-worker/'
const TTL = 300000
const invalid = () => new Error('RJ_REQUEST_INVALID')
export function exactFields(value, fields) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...fields].sort().join(',')
}
function id(value) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) }
function timestamp(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value }
function semanticHash(request, action, agentFingerprint) {
  return sha256({ operation: request.operation, target: request.target, arguments: request.arguments,
    requestId: action.requestId, taskId: action.taskId, agentId: action.agentId, agentKeyFingerprint: agentFingerprint })
}

export function normalizeRjAwsSecurity({ target = RJ_TARGET, roleArn, assumedRolePrefix } = {}) {
  if (!exactFields(target, ['account', 'region', 'instanceId'])
    || typeof target.account !== 'string' || !/^\d{12}$/.test(target.account)
    || typeof target.region !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(target.region)
    || typeof target.instanceId !== 'string' || !/^i-[a-z0-9][a-z0-9-]{7,31}$/.test(target.instanceId)) throw invalid()
  if (roleArn === undefined) {
    const prefixRole = typeof assumedRolePrefix === 'string'
      ? new RegExp(`^arn:aws:sts::${target.account}:assumed-role/([A-Za-z0-9+=,.@_-]{1,64})/$`).exec(assumedRolePrefix)?.[1]
      : null
    roleArn = prefixRole
      ? `arn:aws:iam::${target.account}:role/${prefixRole}`
      : `arn:aws:iam::${target.account}:role/example-rj-aws-worker`
  }
  if (typeof roleArn !== 'string' || !/^arn:aws:iam::\d{12}:role\/[A-Za-z0-9+=,.@_-]{1,64}$/.test(roleArn)) throw invalid()
  const roleName = roleArn.slice(roleArn.indexOf(':role/') + ':role/'.length)
  const prefix = `arn:aws:sts::${target.account}:assumed-role/${roleName}/`
  if (assumedRolePrefix !== undefined && assumedRolePrefix !== prefix) throw invalid()
  const roleAccount = /^arn:aws:iam::(\d{12}):role\//.exec(roleArn)?.[1]
  if (roleAccount !== target.account) throw invalid()
  return { target: { ...target }, roleArn, assumedRolePrefix: prefix }
}

// Journal authority can outlive its delivery window, but its signed semantic identity cannot change.
export function verifyRjAwsFacts(facts, { target = RJ_TARGET } = {}) {
  try {
    const security = normalizeRjAwsSecurity({ target })
    if (!exactFields(facts, ['requestId', 'taskId', 'agentId', 'humanKeyId', 'agentKeyFingerprint', 'requestHash', 'operation', 'target', 'expiresAt']) ||
      ![facts.requestId, facts.taskId, facts.agentId].every(id) ||
      typeof facts.humanKeyId !== 'string' || !facts.humanKeyId.length || facts.humanKeyId.length > 512 ||
      !/^[a-f0-9]{64}$/.test(facts.agentKeyFingerprint) || !/^[a-f0-9]{64}$/.test(facts.requestHash) ||
      !RJ_OPERATIONS.includes(facts.operation) || canonicalJson(facts.target) !== canonicalJson(security.target) ||
      !timestamp(facts.expiresAt) || facts.requestHash !== semanticHash({ ...facts, arguments: {} }, facts, facts.agentKeyFingerprint)) throw invalid()
    return facts
  } catch { throw invalid() }
}

export function createRjAwsRequest({ operation, taskId, agentIdentity, humanIdentity, now = Date.now(), requestId = randomUUID(), expiresAt, target = RJ_TARGET }) {
  try {
    const security = normalizeRjAwsSecurity({ target })
    const expiry = Math.min(now + TTL, expiresAt === undefined ? now + TTL : typeof expiresAt === 'number' ? expiresAt : Date.parse(expiresAt))
    const window = { issuedAt: new Date(now).toISOString(), expiresAt: new Date(expiry).toISOString() }
    const agentKeyFingerprint = fingerprint(agentIdentity.publicKey)
    const request = { schema: 'chimera.rj-aws.request.v1', operation, target: { ...security.target }, arguments: {} }
    const action = { requestId, taskId, agentId: agentIdentity.id, recipient: 'rj-aws-worker', capability: 'aws.read', resource: operation, ...window }
    action.requestHash = semanticHash(request, action, agentKeyFingerprint)
    request.grant = signGrant({ grantId: randomUUID(), humanId: humanIdentity.id, agentId: agentIdentity.id, agentKeyFingerprint,
      taskId, scopes: [{ capability: 'aws.read', resource: operation }], ...window }, humanIdentity)
    request.action = signAction(action, agentIdentity)
    verifyRjAwsRequest(request, { humanKeys: [[humanIdentity.keyId, humanIdentity.publicKey]], now, target: security.target })
    return request
  } catch { throw invalid() }
}

export function verifyRjAwsRequest(request, { humanKeys, now = Date.now(), target = RJ_TARGET } = {}) {
  try {
    const security = normalizeRjAwsSecurity({ target })
    if (Buffer.byteLength(canonicalJson(request)) > RJ_REQUEST_LIMIT || !Number.isFinite(now) ||
      !exactFields(request, ['schema', 'operation', 'target', 'arguments', 'grant', 'action']) ||
      request.schema !== 'chimera.rj-aws.request.v1' || !RJ_OPERATIONS.includes(request.operation) ||
      canonicalJson(request.target) !== canonicalJson(security.target) || !exactFields(request.arguments, []) ||
      !exactFields(request.grant, ['humanKeyId', 'payload', 'signature']) ||
      !exactFields(request.action, ['agentPublicKey', 'payload', 'signature'])) throw invalid()
    const g = request.grant.payload, a = request.action.payload
    if (!exactFields(g, ['grantId', 'humanId', 'agentId', 'agentKeyFingerprint', 'taskId', 'scopes', 'issuedAt', 'expiresAt']) ||
      !exactFields(a, ['requestId', 'taskId', 'agentId', 'recipient', 'capability', 'resource', 'issuedAt', 'expiresAt', 'requestHash']) ||
      ![g.grantId, g.humanId, g.agentId, g.taskId, a.requestId, a.taskId, a.agentId].every(id)) throw invalid()
    for (const p of [g, a]) {
      if (!timestamp(p.issuedAt) || !timestamp(p.expiresAt) || Date.parse(p.issuedAt) > now || Date.parse(p.expiresAt) <= now ||
        Date.parse(p.expiresAt) - Date.parse(p.issuedAt) > TTL || Date.parse(p.expiresAt) <= Date.parse(p.issuedAt)) throw invalid()
    }
    const keys = humanKeys instanceof Map ? humanKeys : new Map(humanKeys)
    const humanKey = keys.get(request.grant.humanKeyId)
    const agentFingerprint = fingerprint(request.action.agentPublicKey)
    if (!humanKey || !verifyPayload(g, request.grant.signature, humanKey) ||
      !verifyPayload(a, request.action.signature, request.action.agentPublicKey) ||
      g.agentKeyFingerprint !== agentFingerprint || g.agentId !== a.agentId || g.taskId !== a.taskId ||
      a.recipient !== 'rj-aws-worker' || a.capability !== 'aws.read' || a.resource !== request.operation ||
      Date.parse(a.issuedAt) < Date.parse(g.issuedAt) || Date.parse(a.expiresAt) > Date.parse(g.expiresAt) ||
      canonicalJson(g.scopes) !== canonicalJson([{ capability: 'aws.read', resource: request.operation }]) ||
      a.requestHash !== semanticHash(request, a, agentFingerprint)) throw invalid()
    return { requestId: a.requestId, taskId: a.taskId, agentId: a.agentId, humanKeyId: request.grant.humanKeyId,
      agentKeyFingerprint: agentFingerprint, requestHash: a.requestHash, operation: request.operation,
      target: { ...security.target }, expiresAt: a.expiresAt }
  } catch { throw invalid() }
}

// Fresh operator authority permits only retrieval/recovery of the exact old facts.
// It is deliberately a different wire schema from an executable request.
export function createRjAwsReconciliation({ request, humanIdentity, now = Date.now(), target = RJ_TARGET }) {
  const facts = verifyRjAwsRequest(request, { humanKeys: [[humanIdentity.keyId, humanIdentity.publicKey]], now: Date.parse(request?.action?.payload?.issuedAt), target })
  return { schema: 'chimera.rj-aws.reconcile.v1', authorization: signGrant({
    recipient: 'rj-aws-worker', intent: 'lookup-only', facts,
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + TTL).toISOString(),
  }, humanIdentity) }
}

export function verifyRjAwsReconciliation(request, { humanKeys, now = Date.now(), target = RJ_TARGET } = {}) {
  try {
    const security = normalizeRjAwsSecurity({ target })
    if (!Number.isFinite(now) || Buffer.byteLength(canonicalJson(request)) > RJ_REQUEST_LIMIT
      || !exactFields(request, ['schema', 'authorization']) || request.schema !== 'chimera.rj-aws.reconcile.v1'
      || !exactFields(request.authorization, ['humanKeyId', 'payload', 'signature'])) throw invalid()
    const { humanKeyId, payload, signature } = request.authorization
    const keys = new Map(humanKeys)
    if (!exactFields(payload, ['recipient', 'intent', 'facts', 'issuedAt', 'expiresAt'])
      || payload.recipient !== 'rj-aws-worker' || payload.intent !== 'lookup-only'
      || payload.facts.humanKeyId !== humanKeyId || !keys.has(humanKeyId)
      || !verifyPayload(payload, signature, keys.get(humanKeyId))
      || !timestamp(payload.issuedAt) || !timestamp(payload.expiresAt)
      || Date.parse(payload.issuedAt) > now || Date.parse(payload.expiresAt) <= now
      || Date.parse(payload.expiresAt) <= Date.parse(payload.issuedAt)
      || Date.parse(payload.expiresAt) - Date.parse(payload.issuedAt) > TTL) throw invalid()
    return verifyRjAwsFacts(payload.facts, { target: security.target })
  } catch { throw invalid() }
}

export function sanitizeRjAwsResult(operation, result, { target = RJ_TARGET, assumedRolePrefix } = {}) {
  let security
  try { security = normalizeRjAwsSecurity({ target, assumedRolePrefix }) } catch { throw new Error('RJ_AWS_UNAVAILABLE') }
  const expectedTarget = security.target
  if (operation === 'rj.aws.identity') {
    if (result?.account !== expectedTarget.account || typeof result.arn !== 'string' ||
      !result.arn.startsWith(security.assumedRolePrefix) || !/^[A-Za-z0-9+=,.@_-]{1,64}$/.test(result.arn.slice(security.assumedRolePrefix.length)) ||
      typeof result.userId !== 'string' || !/^[A-Za-z0-9+=,.@_:-]{1,192}$/.test(result.userId)) throw new Error('RJ_AWS_UNAVAILABLE')
    return { account: result.account, arn: result.arn, userId: result.userId }
  }
  if (operation !== 'rj.aws.instance_status' || result?.account !== expectedTarget.account || result?.region !== expectedTarget.region ||
    result?.instanceId !== expectedTarget.instanceId || !['pending', 'running', 'shutting-down', 'terminated', 'stopping', 'stopped'].includes(result.state)) throw new Error('RJ_AWS_UNAVAILABLE')
  return { account: expectedTarget.account, region: expectedTarget.region, instanceId: expectedTarget.instanceId, state: result.state }
}
