import assert from 'node:assert/strict'
import test from 'node:test'

import { browserCommandFailureMessage } from '../app/src/api.js'

test('browser command failure explains when the local Chimera service is offline', () => {
  assert.equal(
    browserCommandFailureMessage(new TypeError('Failed to fetch')),
    'Chimera service is offline. Restart it with npm run pilot:up.',
  )
})

test('browser command failure preserves a bounded server error in readable form', () => {
  assert.equal(
    browserCommandFailureMessage(new Error('AGENT_CONTROL_ACTIVE')),
    'agent control active',
  )
})

let clientId = 0
async function clientFixture(t, replies, hash = '') {
  const location = { hash, pathname: '/', search: '' }
  for (const [name, value] of Object.entries({ location, history: {
    replaceState() { location.hash = '' },
  } })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name)
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
    t.after(() => original ? Object.defineProperty(globalThis, name, original) : delete globalThis[name])
  }
  const calls = []
  t.mock.method(globalThis, 'fetch', async (path, options) => {
    calls.push({ path, options })
    assert.ok(replies.length, `Unexpected request: ${path}`)
    const reply = replies.shift()
    if (reply instanceof Error) throw reply
    if (typeof reply === 'function') return reply()
    return { ok: reply.status < 400, status: reply.status, json: async () => reply.body }
  })
  const client = await import(`../app/src/api.js?client=${++clientId}`)
  return { ...client, calls, location }
}

function sessionReply(token, expiresAt = new Date(Date.now() + 60_000).toISOString()) {
  return { status: 200, body: { csrfToken: token, expiresAt } }
}

test('concurrent initialization shares a request and expiry renews CSRF before the next command', async (t) => {
  let now = Date.parse('2026-09-04T12:00:00Z')
  t.mock.method(Date, 'now', () => now)
  const client = await clientFixture(t, [sessionReply('tab-a', new Date(now + 1000).toISOString()),
    sessionReply('tab-a-renewed', new Date(now + 10_000).toISOString()),
    { status: 200, body: { taken: true } }])
  await Promise.all([client.initializeOperatorSession(), client.initializeOperatorSession()])
  assert.equal(client.calls.length, 1)
  now += 1000
  assert.deepEqual(await client.post('/api/control/take'), { taken: true })
  assert.deepEqual(client.calls.map(({ path }) => path), ['/api/operator/session', '/api/operator/session', '/api/control/take'])
  assert.equal(client.calls[2].options.headers['x-chimera-csrf'], 'tab-a-renewed')
})

test('an authenticated read recovers after another tab replaces the shared cookie session', async (t) => {
  const client = await clientFixture(t, [sessionReply('old'),
    { status: 401, body: { error: 'OPERATOR_AUTH_REQUIRED' } }, sessionReply('new'),
    { status: 200, body: { connected: true } }])
  assert.deepEqual(await client.api('/api/state'), { connected: true })
  assert.deepEqual(client.calls.map(({ path }) => path), ['/api/operator/session', '/api/state', '/api/operator/session', '/api/state'])
  assert.equal(client.calls[3].options.headers['x-chimera-csrf'], 'new')
})

test('a rejected command is not replayed; the next explicit command renews authorization', async (t) => {
  const client = await clientFixture(t, [sessionReply('old'),
    { status: 403, body: { error: 'OPERATOR_CSRF_INVALID' } }, sessionReply('new'),
    { status: 200, body: { taken: true } }])
  await assert.rejects(client.post('/api/control/take'), /OPERATOR_CSRF_INVALID/)
  assert.equal(client.calls.length, 2)
  await client.post('/api/control/take')
  assert.deepEqual(client.calls.map(({ path }) => path), ['/api/operator/session', '/api/control/take', '/api/operator/session', '/api/control/take'])
})

test('lost command responses are not retried and a subsequent read can reconnect', async (t) => {
  const client = await clientFixture(t, [sessionReply('old'), new TypeError('Failed to fetch'),
    sessionReply('new'), { status: 200, body: { taskCount: 1 } }])
  await assert.rejects(client.post('/api/tasks', { prompt: 'run once' }), /Failed to fetch/)
  assert.equal(client.calls.filter(({ path }) => path === '/api/tasks').length, 1)
  assert.deepEqual(await client.api('/api/state'), { taskCount: 1 })
  assert.equal(client.calls.filter(({ path }) => path === '/api/tasks').length, 1)
})

test('malformed reads fail visibly and allow a fresh initialization on the next poll', async (t) => {
  const client = await clientFixture(t, [sessionReply('old'), () => ({ ok: true, status: 200,
    json: async () => { throw new SyntaxError('Unexpected end of JSON input') },
  }), sessionReply('new'), { status: 200, body: { recovered: true } }])
  await assert.rejects(client.api('/api/state'), /Unexpected end/)
  assert.deepEqual(await client.api('/api/state'), { recovered: true })
  assert.equal(client.calls.filter(({ path }) => path === '/api/operator/session').length, 2)
})

test('failed initialization is retryable and a newly supplied bootstrap replaces cached authorization', async (t) => {
  const client = await clientFixture(t, [new TypeError('Failed to fetch'), sessionReply('first'), sessionReply('replacement')])
  await assert.rejects(client.initializeOperatorSession(), /Failed to fetch/)
  await client.initializeOperatorSession()
  client.location.hash = '#operator=fresh-bootstrap'
  await client.initializeOperatorSession()
  assert.deepEqual(client.calls.map(({ path }) => path), ['/api/operator/session', '/api/operator/session', '/api/operator/bootstrap'])
  assert.equal(client.location.hash, '')
  await client.initializeOperatorSession()
  assert.equal(client.calls.length, 3)
})

test('a lost bootstrap response recovers by reading the cookie without replaying the one-time exchange', async (t) => {
  const client = await clientFixture(t, [new TypeError('Failed to fetch'), sessionReply('recovered')], '#operator=one-time')
  await client.initializeOperatorSession()
  assert.deepEqual(client.calls.map(({ path }) => path), ['/api/operator/bootstrap', '/api/operator/session'])
  assert.equal(client.location.hash, '')
})

test('read authorization recovery is bounded when the session remains rejected', async (t) => {
  const unauthorized = { status: 401, body: { error: 'OPERATOR_AUTH_REQUIRED' } }
  const client = await clientFixture(t, [sessionReply('first'), unauthorized, sessionReply('second'), unauthorized])
  await assert.rejects(client.api('/api/state'), /OPERATOR_AUTH_REQUIRED/)
  assert.equal(client.calls.length, 4)
})

test('failed bootstrap is never replayed by later polling, but a fresh launch can still authorize', async (t) => {
  // Removing the attempted-bootstrap guard must turn the second read into a POST.
  const unauthorized = { status: 401, body: { error: 'OPERATOR_AUTH_REQUIRED' } }
  const client = await clientFixture(t, [
    { status: 401, body: { error: 'OPERATOR_BOOTSTRAP_INVALID' } }, unauthorized,
    unauthorized, sessionReply('fresh'),
  ], '#operator=expired-launch')
  await assert.rejects(client.initializeOperatorSession(), /OPERATOR_BOOTSTRAP_INVALID/)
  await assert.rejects(client.initializeOperatorSession(), /OPERATOR_AUTH_REQUIRED/)
  assert.deepEqual(client.calls.map(({ path }) => path), [
    '/api/operator/bootstrap', '/api/operator/session', '/api/operator/session',
  ])
  client.location.hash = '#operator=new-launch'
  await client.initializeOperatorSession()
  assert.equal(client.calls[3].path, '/api/operator/bootstrap')
  assert.equal(client.location.hash, '')
})
