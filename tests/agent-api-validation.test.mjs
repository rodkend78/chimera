import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { exactAgentBody } from '../src/browser/agent-api-validation.mjs'
import { handleAgentRequest } from '../src/browser/agent-api-handler.mjs'

test('agent mutation API bodies are exact records with no path or authority extras', () => {
  const body = { agentId: 'native-agent', displayName: 'Native', role: 'Testing', capabilities: ['testing'] }
  assert.deepEqual(exactAgentBody(body, Object.keys(body), 'INVALID'), body)
  assert.throws(() => exactAgentBody({ ...body, path: '/tmp/escape' }, Object.keys(body), 'INVALID'), /INVALID/)
  assert.throws(() => exactAgentBody([body], Object.keys(body), 'INVALID'), /INVALID/)
  assert.throws(() => exactAgentBody({ agentId: 'native-agent', credentials: 'secret' }, ['agentId'], 'INVALID'), /INVALID/)
  assert.throws(() => exactAgentBody({ agentId: 'native-agent' }, ['agentId', 'displayName'], 'REQUIRED', ['agentId', 'displayName']), /REQUIRED/)
})

function request(body, headers = {}, method = 'POST') {
  const stream = Readable.from([typeof body === 'string' ? body : JSON.stringify(body)])
  stream.method = method
  stream.headers = headers
  stream.url = '/api/agents'
  return stream
}

const sessions = {
  authenticate: value => value === 'fixture-cookie',
  verifyCsrf: value => value === 'fixture-csrf',
}
const headers = { cookie: 'fixture-cookie', 'x-chimera-csrf': 'fixture-csrf', origin: 'http://127.0.0.1:4174' }

test('agent API handler maps body validation, not-found, conflict, and oversize responses', async () => {
  const calls = []
  const runtime = {
    async createAgent(input) { calls.push(['create', input]); return { ok: true } },
    async updateAgentMetadata(input) { calls.push(['metadata', input]); return { ok: true } },
    async repairAgentContinuity() { throw Object.assign(new Error('AGENT_NOT_REGISTERED'), { code: 'AGENT_NOT_REGISTERED' }) },
  }
  const createPath = '/api/agents/create'
  assert.equal((await handleAgentRequest({ pathname: createPath, request: request({}, headers), operatorSessions: sessions, runtime })).status, 400)
  assert.equal((await handleAgentRequest({ pathname: '/api/agents/metadata', request: request({ agentId: 'native-agent' }, headers), operatorSessions: sessions, runtime })).status, 400)
  assert.equal((await handleAgentRequest({ pathname: '/api/agents/continuity/repair', request: request({ agentId: 'missing' }, headers), operatorSessions: sessions, runtime })).status, 404)
  const conflictRuntime = {
    ...runtime,
    async createAgent() { throw Object.assign(new Error('AGENT_ALREADY_REGISTERED'), { code: 'AGENT_ALREADY_REGISTERED' }) },
  }
  const valid = { requestId: 'request-1', agentId: 'native-agent', displayName: 'Native', role: 'Testing', capabilities: ['testing'], persona: 'Persona.' }
  assert.equal((await handleAgentRequest({ pathname: createPath, request: request(valid, headers), operatorSessions: sessions, runtime: conflictRuntime })).status, 409)
  assert.equal((await handleAgentRequest({ pathname: createPath, request: request('x'.repeat(256_001), headers), operatorSessions: sessions, runtime })).status, 413)
  assert.deepEqual((await handleAgentRequest({ pathname: createPath, request: request(valid, headers), operatorSessions: sessions, runtime })).body, { ok: true })
  assert.equal(calls.length, 1)
})

test('agent API handler maps runtime-backed invalid manifest, capability, and id values to 400', async () => {
  const runtime = {
    async createAgent(input) {
      if (input.displayName === null) throw Object.assign(new Error('AGENT_MANIFEST_INVALID'), { code: 'AGENT_MANIFEST_INVALID' })
      if (typeof input.capabilities === 'string') throw Object.assign(new Error('AGENT_CAPABILITIES_INVALID'), { code: 'AGENT_CAPABILITIES_INVALID' })
      if (input.agentId === 'bad id') throw Object.assign(new Error('AGENT_ID_INVALID'), { code: 'AGENT_ID_INVALID' })
      return { ok: true }
    },
  }
  const base = { requestId: 'request-2', agentId: 'native-agent', displayName: 'Native', role: 'Testing', capabilities: ['testing'], persona: 'Persona.' }
  assert.equal((await handleAgentRequest({ pathname: '/api/agents/create', request: request({ ...base, displayName: null }, headers), operatorSessions: sessions, runtime })).status, 400)
  assert.equal((await handleAgentRequest({ pathname: '/api/agents/create', request: request({ ...base, capabilities: 'testing' }, headers), operatorSessions: sessions, runtime })).status, 400)
  assert.equal((await handleAgentRequest({ pathname: '/api/agents/create', request: request({ ...base, agentId: 'bad id' }, headers), operatorSessions: sessions, runtime })).status, 400)
})

test('agent API handler enforces operator auth, CSRF, origin, method and unknown routes', async () => {
  const runtime = { async createAgent() { throw new Error('must not run') } }
  const path = '/api/agents/create'
  assert.equal((await handleAgentRequest({ pathname: path, request: request({}, {}, 'POST'), operatorSessions: sessions, runtime })).status, 401)
  assert.equal((await handleAgentRequest({ pathname: path, request: request({}, { ...headers, 'x-chimera-csrf': '' }), operatorSessions: sessions, runtime })).status, 403)
  assert.equal((await handleAgentRequest({ pathname: path, request: request({}, { ...headers, origin: 'https://evil.example' }), operatorSessions: sessions, runtime })).status, 403)
  assert.equal((await handleAgentRequest({ pathname: path, request: request({}, headers, 'GET'), operatorSessions: sessions, runtime })).status, 405)
  assert.equal(await handleAgentRequest({ pathname: '/api/agents/other', request: request({}, headers), operatorSessions: sessions, runtime }), null)
})

test('agent readiness and test handlers enforce exact bindings and map stale or unknown outcomes', async () => {
  const readiness = { schema: 'chimera.agent-readiness.v1', agentId: 'ceo', status: 'configured', fingerprint: 'a'.repeat(64), checks: [], lastTest: null }
  const calls = []
  const runtime = {
    async agentReadiness(input) { calls.push(['readiness', input]); return readiness },
    async agentReadinessReceipt(input) { calls.push(['receipt', input]); return { schema: 'chimera.agent-readiness-receipt.v1', ...input, status: 'unknown' } },
    async testAgent(input) {
      if (input.allowQuotaUse !== true) throw Object.assign(new Error('AGENT_READINESS_QUOTA_CONFIRMATION_REQUIRED'), { code: 'AGENT_READINESS_QUOTA_CONFIRMATION_REQUIRED' })
      calls.push(['test', input]); return { schema: 'chimera.agent-test-result.v1', ...input, status: 'passed' }
    },
  }
  const read = request('', headers, 'GET')
  read.url = '/api/agents/readiness?agentId=ceo'
  assert.deepEqual((await handleAgentRequest({ pathname: '/api/agents/readiness', request: read, operatorSessions: sessions, runtime })).body, readiness)
  assert.equal(calls.length, 1)
  const readPost = request({ agentId: 'ceo' }, headers, 'POST')
  assert.deepEqual((await handleAgentRequest({ pathname: '/api/agents/readiness', request: readPost, operatorSessions: sessions, runtime })).body, readiness)
  assert.equal(calls.length, 2)
  const receiptRead = request('', headers, 'GET')
  receiptRead.url = '/api/agents/readiness?agentId=ceo&requestId=test-api-1'
  assert.equal((await handleAgentRequest({ pathname: '/api/agents/readiness', request: receiptRead, operatorSessions: sessions, runtime })).body.status, 'unknown')
  assert.deepEqual(calls[2], ['receipt', { agentId: 'ceo', requestId: 'test-api-1' }])
  assert.equal((await handleAgentRequest({ pathname: '/api/agents/readiness', request: request({ agentId: 'ceo', extra: true }, headers, 'POST'), operatorSessions: sessions, runtime })).status, 400)
  const valid = { agentId: 'ceo', requestId: 'test-api-1', expectedFingerprint: 'a'.repeat(64), allowQuotaUse: true }
  assert.equal((await handleAgentRequest({ pathname: '/api/agents/test', request: request(valid, headers), operatorSessions: sessions, runtime })).status, 200)
  assert.equal(calls[3][0], 'test')
  assert.equal((await handleAgentRequest({ pathname: '/api/agents/test', request: request({ ...valid, extra: true }, headers), operatorSessions: sessions, runtime })).status, 400)
  assert.equal((await handleAgentRequest({ pathname: '/api/agents/test', request: request({ ...valid, allowQuotaUse: false }, headers), operatorSessions: sessions, runtime })).status, 400)
  const staleRuntime = { ...runtime, async testAgent() { throw Object.assign(new Error('AGENT_READINESS_FINGERPRINT_STALE'), { code: 'AGENT_READINESS_FINGERPRINT_STALE' }) } }
  assert.equal((await handleAgentRequest({ pathname: '/api/agents/test', request: request(valid, headers), operatorSessions: sessions, runtime: staleRuntime })).status, 409)
})
