import { isAllowedRequestOrigin } from './http-safety.mjs'
import { authorizeOperatorRequest } from './operator-http-auth.mjs'
import { exactAgentBody } from './agent-api-validation.mjs'

const CREATE_PATH = '/api/agents/create'
const METADATA_PATH = '/api/agents/metadata'
const REPAIR_PATH = '/api/agents/continuity/repair'
const READINESS_PATH = '/api/agents/readiness'
const TEST_PATH = '/api/agents/test'
const CREATE_FIELDS = ['requestId', 'agentId', 'displayName', 'role', 'capabilities', 'persona']
const METADATA_FIELDS = ['agentId', 'displayName', 'role', 'capabilities']
const REPAIR_FIELDS = ['agentId']
const READINESS_FIELDS = ['agentId', 'requestId']
const TEST_FIELDS = ['agentId', 'requestId', 'expectedFingerprint', 'allowQuotaUse']
const MAX_BODY_BYTES = 256_000

function codeOf(error) {
  const code = typeof error?.code === 'string' ? error.code : error instanceof Error ? error.message : ''
  return /^[A-Z][A-Z0-9_]{2,127}$/.test(code) ? code : 'INTERNAL_ERROR'
}

function statusFor(code) {
  if (['REQUEST_TOO_LARGE', 'NATIVE_PERSONA_TOO_LARGE'].includes(code)) return 413
  if (['AGENT_NOT_REGISTERED'].includes(code)) return 404
  if ([
    'AGENT_CREATE_REQUEST_CONFLICT', 'AGENT_ALREADY_REGISTERED', 'AGENT_NATIVE_ID_RESERVED',
    'AGENT_METADATA_CHANGE_DURING_TASK', 'AGENT_CONTINUITY_REPAIR_DURING_TASK', 'AGENT_MUTATION_IN_PROGRESS',
    'AGENT_READINESS_FINGERPRINT_STALE', 'AGENT_READINESS_BINDING_CHANGED', 'AGENT_READINESS_REQUEST_CONFLICT', 'AGENT_READINESS_BLOCKED', 'AGENT_EXECUTOR_NOT_PURE', 'AGENT_EXECUTOR_UNBOUND', 'AGENT_READINESS_STORE_FULL',
  ].includes(code)) return 409
  if (code === 'INTERNAL_ERROR') return 500
  if ([
    'AGENT_REQUEST_BODY_INVALID', 'AGENT_CREATE_REQUEST_INVALID', 'AGENT_CREATE_RECEIPT_INVALID',
    'AGENT_METADATA_INPUT_INVALID', 'AGENT_CONTINUITY_REPAIR_INPUT_INVALID',
    'AGENT_METADATA_ACTOR_INVALID', 'AGENT_PERSONA_ACTOR_INVALID', 'NATIVE_PERSONA_CONTENT_INVALID',
    'NATIVE_AGENT_ID_INVALID', 'AGENT_CONTINUITY_RECORD_INVALID', 'AGENT_CONTINUITY_RECORD_TOO_LARGE',
    'AGENT_MANIFEST_INVALID', 'AGENT_CAPABILITIES_INVALID', 'AGENT_ID_INVALID', 'NATIVE_AGENT_INPUT_INVALID',
    'AGENT_READINESS_TEST_INPUT_INVALID', 'AGENT_READINESS_RECORD_INVALID', 'AGENT_READINESS_STORE_INVALID', 'AGENT_READINESS_QUOTA_CONFIRMATION_REQUIRED', 'AGENT_READINESS_QUERY_INVALID',
  ].includes(code)) return 400
  if (code === 'AGENT_READINESS_RECEIPT_NOT_FOUND') return 404
  return 500
}

async function bodyOf(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk)
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('REQUEST_TOO_LARGE'), { code: 'REQUEST_TOO_LARGE' })
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    throw Object.assign(new TypeError('AGENT_REQUEST_BODY_INVALID'), { code: 'AGENT_REQUEST_BODY_INVALID' })
  }
}

export async function handleAgentRequest({ pathname, request, operatorSessions, runtime } = {}) {
  if (![CREATE_PATH, METADATA_PATH, REPAIR_PATH, READINESS_PATH, TEST_PATH].includes(pathname)) return null
  if (!request || !operatorSessions || !runtime) throw new TypeError('Agent API requires request, operator sessions, and runtime')
  if (!isAllowedRequestOrigin(request.headers?.origin)) return { status: 403, body: { error: 'ORIGIN_BLOCKED' } }
  const auth = authorizeOperatorRequest({ pathname, method: request.method, headers: request.headers }, operatorSessions)
  if (!auth.allowed) return { status: auth.status, body: { error: auth.error } }
  if (pathname === READINESS_PATH) {
    if (!['GET', 'POST'].includes(request.method)) return { status: 405, body: { error: 'METHOD_NOT_ALLOWED' } }
    try {
      let agentId
      if (request.method === 'POST') {
        const body = await bodyOf(request)
        exactAgentBody(body, READINESS_FIELDS, 'AGENT_READINESS_QUERY_INVALID', ['agentId'])
        agentId = body.agentId
        if (body.requestId !== undefined) {
          if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(body.requestId) || typeof runtime.agentReadinessReceipt !== 'function') {
            throw Object.assign(new Error('AGENT_READINESS_QUERY_INVALID'), { code: 'AGENT_READINESS_QUERY_INVALID' })
          }
          return { status: 200, body: await runtime.agentReadinessReceipt({ agentId, requestId: body.requestId }) }
        }
      } else {
        const url = new URL(request.url ?? READINESS_PATH, 'http://chimera.local')
        agentId = url.searchParams.get('agentId')
        const requestId = url.searchParams.get('requestId')
        if (!agentId || [...url.searchParams.keys()].some(key => !['agentId', 'requestId'].includes(key))) return { status: 400, body: { error: 'AGENT_READINESS_QUERY_INVALID' } }
        if (requestId !== null) {
          if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestId) || typeof runtime.agentReadinessReceipt !== 'function') return { status: 400, body: { error: 'AGENT_READINESS_QUERY_INVALID' } }
          return { status: 200, body: await runtime.agentReadinessReceipt({ agentId, requestId }) }
        }
      }
      if (!agentId || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(agentId)) return { status: 400, body: { error: 'AGENT_READINESS_QUERY_INVALID' } }
      return { status: 200, body: await runtime.agentReadiness({ agentId }) }
    } catch (error) {
      const code = codeOf(error)
      return { status: statusFor(code), body: { error: code } }
    }
  }
  if (request.method !== 'POST') return { status: 405, body: { error: 'METHOD_NOT_ALLOWED' } }
  try {
    const body = await bodyOf(request)
    if (pathname === CREATE_PATH) {
      exactAgentBody(body, CREATE_FIELDS, 'AGENT_CREATE_REQUEST_INVALID', CREATE_FIELDS)
      return { status: 201, body: await runtime.createAgent(body) }
    }
    if (pathname === METADATA_PATH) {
      exactAgentBody(body, METADATA_FIELDS, 'AGENT_METADATA_INPUT_INVALID', METADATA_FIELDS)
      return { status: 200, body: await runtime.updateAgentMetadata(body) }
    }
    if (pathname === TEST_PATH) {
      exactAgentBody(body, TEST_FIELDS, 'AGENT_READINESS_TEST_INPUT_INVALID', TEST_FIELDS)
      return { status: 200, body: await runtime.testAgent(body) }
    }
    exactAgentBody(body, REPAIR_FIELDS, 'AGENT_CONTINUITY_REPAIR_INPUT_INVALID', REPAIR_FIELDS)
    return { status: 200, body: await runtime.repairAgentContinuity(body) }
  } catch (error) {
    const code = codeOf(error)
    return { status: statusFor(code), body: { error: code } }
  }
}
