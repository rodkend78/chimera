import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { handleConnectionsRequest } from '../src/browser/connections-api.mjs'

function request(body, headers = {}, method = 'POST') {
  const stream = Readable.from([JSON.stringify(body)])
  stream.method = method
  stream.headers = headers
  return stream
}

test('connections API exposes read-only state and delegates one explicit action', async () => {
  const calls = []
  const service = {
    list() {
      calls.push({ operation: 'list' })
      return [{ schema: 'chimera.connection-state.v1', providerId: 'fixture', status: 'available' }]
    },
    async act(input) {
      calls.push(input)
      return { state: { providerId: input.providerId, status: 'verified' }, receipt: { requestId: input.requestId } }
    },
  }
  const sessions = {
    authenticate: value => value === 'fixture-cookie',
    verifyCsrf: value => value === 'fixture-csrf',
  }

  assert.deepEqual(await handleConnectionsRequest({
    pathname: '/api/connections',
    request: request({}, { cookie: 'fixture-cookie' }, 'GET'),
    operatorSessions: sessions,
    service,
  }), { status: 200, body: { schema: 'chimera.connections.v1', connections: [
    { schema: 'chimera.connection-state.v1', providerId: 'fixture', status: 'available' },
  ] } })
  assert.deepEqual(await handleConnectionsRequest({
    pathname: '/api/connections/action',
    request: request({ providerId: 'fixture', operation: 'test-safe', requestId: 'request-1' }, {
      cookie: 'fixture-cookie', 'x-chimera-csrf': 'fixture-csrf', origin: 'http://127.0.0.1:4174',
    }),
    operatorSessions: sessions,
    service,
  }), { status: 200, body: { state: { providerId: 'fixture', status: 'verified' }, receipt: { requestId: 'request-1' } } })
  assert.deepEqual(calls, [
    { operation: 'list' },
    { providerId: 'fixture', operation: 'test-safe', requestId: 'request-1' },
  ])
})

test('connections API rejects unauthenticated, cross-origin, missing-CSRF, and malformed requests', async () => {
  let actionCalls = 0
  const service = { list: () => [], act: async () => { actionCalls += 1; throw new Error('must not run') } }
  const sessions = {
    authenticate: value => value === 'fixture-cookie',
    verifyCsrf: value => value === 'fixture-csrf',
  }

  assert.equal((await handleConnectionsRequest({ pathname: '/api/connections', request: request({}, {}, 'GET'), operatorSessions: sessions, service })).status, 401)
  assert.equal((await handleConnectionsRequest({ pathname: '/api/connections/action', request: request({}, { cookie: 'fixture-cookie', 'x-chimera-csrf': 'fixture-csrf', origin: 'https://evil.test' }), operatorSessions: sessions, service })).status, 403)
  assert.equal((await handleConnectionsRequest({ pathname: '/api/connections/action', request: request({}, { cookie: 'fixture-cookie' }), operatorSessions: sessions, service })).status, 403)
  assert.equal((await handleConnectionsRequest({ pathname: '/api/connections/action', request: request({ providerId: 'fixture' }, { cookie: 'fixture-cookie', 'x-chimera-csrf': 'fixture-csrf', origin: 'http://127.0.0.1:4174' }), operatorSessions: sessions, service })).status, 400)
  assert.equal((await handleConnectionsRequest({ pathname: '/api/connections/action', request: request({ providerId: 'fixture', operation: 'refresh', requestId: 'large', note: 'x'.repeat(5000) }, { cookie: 'fixture-cookie', 'x-chimera-csrf': 'fixture-csrf', origin: 'http://127.0.0.1:4174' }), operatorSessions: sessions, service })).status, 413)
  assert.equal(actionCalls, 0)
  assert.equal((await handleConnectionsRequest({ pathname: '/api/connections/unknown', request: request({}, { cookie: 'fixture-cookie' }, 'GET'), operatorSessions: sessions, service })), null)
})

test('connections API keeps the bounded original receipt identity on an unknown service outcome', async () => {
  const service = {
    list: () => [],
    act: async () => {
      throw Object.assign(new Error('provider outcome unknown'), {
        code: 'CONNECTION_OPERATION_UNKNOWN',
        receipt: {
          requestId: 'original-request-7',
          providerId: 'fixture',
          operation: 'test-model',
          status: 'unknown',
          answer: 'must not cross the API boundary',
        },
      })
    },
  }
  const sessions = {
    authenticate: value => value === 'fixture-cookie',
    verifyCsrf: value => value === 'fixture-csrf',
  }

  const result = await handleConnectionsRequest({
    pathname: '/api/connections/action',
    request: request({ providerId: 'fixture', operation: 'test-model', model: 'fixture-model', requestId: 'transport-request-7', allowQuotaUse: true }, {
      cookie: 'fixture-cookie', 'x-chimera-csrf': 'fixture-csrf', origin: 'http://127.0.0.1:4174',
    }),
    operatorSessions: sessions,
    service,
  })

  assert.equal(result.status, 409)
  assert.deepEqual(result.body.receipt, {
    requestId: 'original-request-7',
    providerId: 'fixture',
    operation: 'test-model',
    status: 'unknown',
  })
  assert.equal(result.body.reconciliationRequired, true)
  assert.equal(result.body.retryAllowed, false)
})
