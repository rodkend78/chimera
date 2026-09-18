import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { handleClientWorkspaceRequest } from '../src/browser/client-workspace-api.mjs'
import { ClientWorkspaceStore } from '../src/clients/workspace-store.mjs'
import { OperatorSessionManager } from '../src/browser/operator-session.mjs'

async function fixture(t) {
  const directory = await mkdtemp(join(resolve('.'), '.client-test-api-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const doc = { id: 'doc', title: 'Evidence', category: 'Plan', kind: 'document', status: 'imported', origin: { label: 'Git', ref: 'inert' }, sha256: null, bytes: 8, content: '<script>' }
  await writeFile(join(directory, 'catalog.json'), JSON.stringify({ schemaVersion: 1, importedAt: '2026-09-07T00:00:00Z', clients: [{ id: 'client', name: 'Client', summary: '', status: 'pilot', documents: [doc], coverage: [] }] }))
  const store = await ClientWorkspaceStore.open({ directory })
  // Isolated synthetic operator session only; never read the real operator store.
  const operatorSessions = new OperatorSessionManager({ filePath: join(directory, 'session.json') })
  const session = operatorSessions.exchangeBootstrap(operatorSessions.issueBootstrap())
  const headers = { cookie: `chimera_operator=${session.cookieToken}`, 'x-chimera-csrf': session.csrfToken, origin: 'http://127.0.0.1:4174', 'content-type': 'application/json' }
  const call = (pathname, method = 'GET', body = '', overrides = {}) => handleClientWorkspaceRequest({ pathname, store, operatorSessions, request: Object.assign(Readable.from([Buffer.from(body)]), { method, headers: { ...headers, ...overrides } }) })
  return { directory, store, operatorSessions, headers, call, doc }
}
test('API returns list, detail, exact document and persisted note', async t => {
  const { call, doc } = await fixture(t)
  assert.equal((await call('/api/clients')).body.clients[0].id, 'client')
  assert.equal((await call('/api/clients/client')).body.documents[0].content, undefined)
  assert.deepEqual(await call('/api/clients/client/documents/doc'), { status: 200, body: doc })
  const result = await call('/api/clients/client/notes', 'POST', JSON.stringify({ title: 'Follow up', body: 'Ask for review', sourceType: 'call' }))
  assert.equal(result.status, 201)
  assert.equal(result.body.status, 'unreviewed')
  assert.equal((await call('/api/clients/client')).body.notes[0].id, result.body.id)
  assert.equal(await call('/api/not-clients'), null)
})
test('auth and CSRF denial precede store access and body consumption', async t => {
  const { operatorSessions, headers } = await fixture(t)
  const store = new Proxy({}, { get() { assert.fail('store touched before authorization') } })
  for (const [method, overrides, status] of [['GET', { cookie: '' }, 401], ['POST', { cookie: '' }, 401], ['POST', { 'x-chimera-csrf': '' }, 403]]) {
    const request = { method, headers: { ...headers, ...overrides }, [Symbol.asyncIterator]() { assert.fail('unauthorized body consumed') } }
    assert.equal((await handleClientWorkspaceRequest({ pathname: '/api/clients/client/notes', request, store, operatorSessions })).status, status)
  }
})
test('rejects origin, traversal, unsupported methods, malformed/oversized JSON and unknown records', async t => {
  const { call, directory } = await fixture(t)
  assert.equal((await call('/api/clients', 'GET', '', { origin: 'https://evil.example' })).status, 403)
  for (const path of ['/api/clients/..', '/api/clients/%2e%2e', '/api/clients/client/documents/%2fetc', '/api/clients/%ZZ', '/api/clients/' + 'x'.repeat(129)]) assert.equal((await call(path)).status, 400, path)
  for (const path of ['/api/clients/nope', '/api/clients/client/documents/nope', '/api/clients/client/nope']) assert.equal((await call(path)).status, 404)
  assert.equal((await call('/api/clients', 'DELETE')).status, 405)
  assert.equal((await call('/api/clients/client/notes', 'GET')).status, 405)
  for (const body of ['{', 'null', '[]', '{}', 'x'.repeat(200000)]) assert.equal((await call('/api/clients/client/notes', 'POST', body)).status, 400)
  await assert.rejects(readFile(join(directory, 'notes.json')), { code: 'ENOENT' })
})
test('corrupt store maps to 409 with no filesystem error disclosure', async t => {
  const { call, directory } = await fixture(t)
  await writeFile(join(directory, 'catalog.json'), '{')
  assert.deepEqual(await call('/api/clients'), { status: 409, body: { error: 'CLIENT_WORKSPACE_CORRUPT' } })
})
test('server wiring follows authorization and uses private workspace and redacted audit', async () => {
  const source = await readFile(new URL('../src/browser/server.mjs', import.meta.url), 'utf8')
  assert.match(source, /import .*handleClientWorkspaceRequest.*client-workspace-api/)
  assert.match(source, /join\(ROOT, '\.chimera\/client-workspaces'\)/)
  assert.ok(source.indexOf('const clientWorkspaceResult =') > source.indexOf('if (!operatorAuth.allowed)'))
  assert.match(source, /if \(clientWorkspaceResult\) return replyJson\(clientWorkspaceResult.status, clientWorkspaceResult.body\)/)
})
