import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OperatorSessionManager } from '../src/browser/operator-session.mjs'
import { MemoryAuditLog } from '../src/audit-log.mjs'
import { AccountCompanionBroker } from '../src/account-browser/broker.mjs'
import { EXPECTED_ORIGIN } from '../src/account-browser/identity.mjs'
import { handleAccountCompanionRequest } from '../src/browser/account-companion-api.mjs'

test('operator companion routes authenticate independently, reject malformed requests without effects, and expose metadata only', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ac-api-'))
  const operatorSessions = await OperatorSessionManager.open({ filePath: join(directory, 'session.json') })
  const session = operatorSessions.exchangeBootstrap(operatorSessions.issueBootstrap())
  const headers = { cookie: `${session.cookieName}=${session.cookieToken}`, 'x-chimera-csrf': session.csrfToken }
  const audit = new MemoryAuditLog()
  const broker = await AccountCompanionBroker.open({ stateFile: join(directory, 'state.json'), audit, allowedOrigin: EXPECTED_ORIGIN })
  const peer = broker.connect({ origin: EXPECTED_ORIGIN, send() {} })
  const pair = await peer.receive({ type: 'hello', id: 'hello', profileId: 'fixture-profile' })
  const companion = { broker, state: () => ({ status: 'available', ...broker.state() }) }
  const server = createServer(async (request, response) => {
    const result = await handleAccountCompanionRequest({ pathname: new URL(request.url, 'http://localhost').pathname, request, operatorSessions, companion })
    response.writeHead(result?.status ?? 404, { 'content-type': 'application/json' }); response.end(JSON.stringify(result?.body ?? {}))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await broker.close(); await rm(directory, { recursive: true, force: true }) })
  const call = (path, method = 'POST', body = '{}', supplied = headers) => fetch(`http://127.0.0.1:${server.address().port}/api/account-companion/${path}`, { method, headers: supplied, ...(method === 'GET' ? {} : { body }) })
  for (const path of ['state', 'pair/approve', 'pair/revoke', 'lease/revoke']) {
    assert.equal((await call(path, path === 'state' ? 'GET' : 'POST', '{}', {})).status, 401)
    assert.equal((await call(path, path === 'state' ? 'GET' : 'POST', '{}', { ...headers, origin: 'https://evil.example' })).status, 403)
    assert.equal((await call(path, 'OPTIONS')).status, 405)
    if (path !== 'state') assert.equal((await call(path, 'POST', '{}', { cookie: headers.cookie })).status, 403)
  }
  for (const body of ['', '{', 'null', '[]', '{}', '{"pairingId":3}', JSON.stringify({ pairingId: pair.pairingId, extra: true })]) assert.equal((await call('pair/approve', 'POST', body)).status, 400)
  assert.equal((await call('pair/approve', 'POST', 'x'.repeat(4097))).status, 413)
  assert.equal(audit.entries().length, 0)
  const state = await (await call('state', 'GET')).json()
  assert.equal(JSON.stringify(state).includes(pair.challenge), false)
  assert.equal((await call('pair/approve', 'POST', JSON.stringify({ pairingId: pair.pairingId }))).status, 200)
  await peer.receive({ id: 'auth', type: 'authenticate', pairingId: pair.pairingId, challenge: pair.challenge })
  assert.equal(broker.state().profiles[0].status, 'paired')
  assert.equal((await call('pair/revoke', 'POST', '{"profileId":"fixture-profile"}')).status, 200)
  assert.equal(broker.state().profiles[0].status, 'disconnected')
  assert.equal((await call('read', 'POST', '{}')).status, 404)
  assert.equal((await call('pair/approve', 'POST', '{"pairingId":"absent"}')).status, 409)
})
