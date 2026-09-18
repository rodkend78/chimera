import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { OperatorSessionManager } from '../src/browser/operator-session.mjs'
import { authorizeOperatorRequest, authorizeOperatorWebSocket } from '../src/browser/operator-http-auth.mjs'

test('API and WebSocket control require an authenticated operator; mutations also require CSRF', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-operator-api-'))
  try {
    const manager = await OperatorSessionManager.open({ filePath: join(directory, 'session.json') })
    const session = manager.exchangeBootstrap(manager.issueBootstrap())
    const cookie = `${session.cookieName}=${session.cookieToken}`

    assert.deepEqual(authorizeOperatorRequest({ pathname: '/', method: 'GET', headers: {} }, manager), { allowed: true })
    assert.deepEqual(authorizeOperatorRequest({ pathname: '/api/operator/bootstrap', method: 'POST', headers: {} }, manager), { allowed: true })
    assert.equal(authorizeOperatorRequest({ pathname: '/api/state', method: 'GET', headers: {} }, manager).status, 401)
    assert.equal(authorizeOperatorRequest({ pathname: '/api/state', method: 'GET', headers: { cookie } }, manager).allowed, true)
    assert.equal(authorizeOperatorRequest({ pathname: '/api/tasks', method: 'POST', headers: { cookie } }, manager).status, 403)
    assert.equal(authorizeOperatorRequest({
      pathname: '/api/tasks', method: 'POST', headers: { cookie, 'x-chimera-csrf': 'wrong' },
    }, manager).status, 403)
    assert.equal(authorizeOperatorRequest({
      pathname: '/api/tasks', method: 'POST', headers: { cookie, 'x-chimera-csrf': session.csrfToken },
    }, manager).allowed, true)
    assert.equal(authorizeOperatorWebSocket({ headers: {} }, manager).status, 401)
    assert.equal(authorizeOperatorWebSocket({ headers: { cookie } }, manager).allowed, true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
