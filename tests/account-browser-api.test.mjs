import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryAuditLog } from '../src/audit-log.mjs'
import { OperatorSessionManager } from '../src/browser/operator-session.mjs'
import { createAccountBrowserLauncher } from '../src/browser/account-browser-launcher.mjs'
import { handleAccountBrowserRequest } from '../src/browser/account-browser-api.mjs'

async function fixture(t, launcherOverrides = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'chimera-account-browser-api-')))
  const operatorSessions = await OperatorSessionManager.open({ filePath: join(directory, 'session.json') })
  const session = operatorSessions.exchangeBootstrap(operatorSessions.issueBootstrap())
  const effects = { access: 0, launch: 0 }
  const audit = new MemoryAuditLog()
  const launcher = createAccountBrowserLauncher({
    platform: 'darwin',
    userDataDir: join(directory, 'chrome'),
    accessImpl: async () => { effects.access += 1 },
    execFileImpl: async () => { effects.launch += 1 },
    appendAudit: fact => audit.append(fact),
    ...launcherOverrides,
  })
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname
    const result = await handleAccountBrowserRequest({ pathname, request, operatorSessions, launcher })
    response.writeHead(result?.status ?? 404, { 'content-type': 'application/json' })
    response.end(JSON.stringify(result?.body ?? { error: 'NOT_FOUND' }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await new Promise(resolve => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  })
  const root = `http://127.0.0.1:${server.address().port}`
  const cookie = `${session.cookieName}=${session.cookieToken}`
  const headers = { cookie, 'x-chimera-csrf': session.csrfToken }
  return { root, cookie, headers, effects, audit, launcher, operatorSessions }
}

test('handler returns null for unrelated routes without authorization or launcher use', async t => {
  const f = await fixture(t)
  assert.equal(await handleAccountBrowserRequest({ pathname: '/api/other', request: { method: 'GET', headers: {} }, operatorSessions: f.operatorSessions, launcher: f.launcher }), null)
  assert.deepEqual(f.effects, { access: 0, launch: 0 })
})

test('state and open require an operator session before launcher side effects', async t => {
  const f = await fixture(t)
  for (const [path, method] of [['/api/account-browser/state', 'GET'], ['/api/account-browser/open', 'POST']]) {
    const response = await fetch(`${f.root}${path}`, { method, body: method === 'POST' ? '{}' : undefined })
    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: 'OPERATOR_AUTH_REQUIRED' })
  }
  assert.deepEqual(f.effects, { access: 0, launch: 0 })
})

test('open requires valid CSRF and both routes reject a foreign Origin before side effects', async t => {
  const f = await fixture(t)
  for (const csrf of [undefined, 'wrong']) {
    const headers = { cookie: f.cookie, ...(csrf ? { 'x-chimera-csrf': csrf } : {}) }
    const response = await fetch(`${f.root}/api/account-browser/open`, { method: 'POST', headers, body: '{}' })
    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: 'OPERATOR_CSRF_INVALID' })
  }
  for (const [path, method] of [['/api/account-browser/state', 'GET'], ['/api/account-browser/open', 'POST']]) {
    const response = await fetch(`${f.root}${path}`, { method, headers: { ...f.headers, origin: 'https://foreign.example' }, body: method === 'POST' ? '{}' : undefined })
    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: 'ORIGIN_BLOCKED' })
  }
  assert.deepEqual(f.effects, { access: 0, launch: 0 })
})

test('routes reject wrong methods without consuming a body or using the launcher', async t => {
  const f = await fixture(t)
  const state = await fetch(`${f.root}/api/account-browser/state`, { method: 'POST', headers: f.headers, body: '{}' })
  const open = await fetch(`${f.root}/api/account-browser/open`, { method: 'GET', headers: { cookie: f.cookie } })
  assert.equal(state.status, 405)
  assert.equal(open.status, 405)
  assert.deepEqual(await state.json(), { error: 'METHOD_NOT_ALLOWED' })
  assert.deepEqual(await open.json(), { error: 'METHOD_NOT_ALLOWED' })
  assert.deepEqual(f.effects, { access: 0, launch: 0 })
})

test('state reports launcher state and open returns 202 launch acceptance', async t => {
  const f = await fixture(t)
  const state = await fetch(`${f.root}/api/account-browser/state`, { headers: { cookie: f.cookie } })
  assert.equal(state.status, 200)
  assert.deepEqual(await state.json(), { browser: 'chrome', surface: 'native-window', status: 'available', companion: 'not-installed', agentAccess: 'unavailable' })
  const opened = await fetch(`${f.root}/api/account-browser/open`, { method: 'POST', headers: f.headers, body: JSON.stringify({ url: 'https://accounts.google.com/' }) })
  assert.equal(opened.status, 202)
  assert.deepEqual(await opened.json(), { status: 'launch-requested', browser: 'chrome', surface: 'native-window', agentAccess: 'unavailable' })
  assert.equal(f.effects.launch, 1)
})

test('open accepts only bounded JSON with an exact object schema', async t => {
  const f = await fixture(t)
  const invalidBodies = ['', '{invalid', 'null', '[]', '"text"', '{"unknown":true}', '{"url":"https://www.google.com/","extra":1}', '{"url":1}', '{"userDataDir":"/private/other"}', '{"args":["--remote-debugging-port=9222"]}']
  for (const body of invalidBodies) {
    const response = await fetch(`${f.root}/api/account-browser/open`, { method: 'POST', headers: f.headers, body })
    assert.equal(response.status, 400, body)
    assert.deepEqual(await response.json(), { error: 'ACCOUNT_BROWSER_REQUEST_INVALID' })
  }
  const oversized = await fetch(`${f.root}/api/account-browser/open`, { method: 'POST', headers: f.headers, body: JSON.stringify({ url: 'x'.repeat(5000) }) })
  assert.equal(oversized.status, 413)
  assert.deepEqual(await oversized.json(), { error: 'REQUEST_TOO_LARGE' })
  assert.equal(f.effects.launch, 0)
})

test('open maps every launcher failure to its public status without leaking causes', async t => {
  const cases = [
    [{}, { url: 'file:///private/secret' }, 400, 'ACCOUNT_BROWSER_URL_INVALID'],
    [{ platform: 'win32' }, {}, 409, 'ACCOUNT_BROWSER_UNSUPPORTED_PLATFORM'],
    [{ platform: 'linux', env: {} }, {}, 503, 'ACCOUNT_BROWSER_UNAVAILABLE'],
    [{ accessImpl: async () => { throw Object.assign(new Error('/private/profile'), { code: 'ENOENT' }) } }, {}, 409, 'ACCOUNT_BROWSER_NOT_INSTALLED'],
    [{ accessImpl: async () => { throw Object.assign(new Error('/private/profile'), { code: 'EACCES' }) } }, {}, 503, 'ACCOUNT_BROWSER_UNAVAILABLE'],
    [{ appendAudit: async () => { throw new Error('/private/audit') } }, {}, 503, 'ACCOUNT_BROWSER_AUDIT_UNAVAILABLE'],
    [{ userDataDir: 'relative-profile' }, {}, 503, 'ACCOUNT_BROWSER_PROFILE_UNAVAILABLE'],
    [{ execFileImpl: async () => { throw new Error('stderr secret') } }, {}, 502, 'ACCOUNT_BROWSER_LAUNCH_UNCONFIRMED'],
    [{ appendAudit: async fact => { if (fact.kind === 'account-browser.launch.accepted') throw new Error('audit secret') } }, {}, 503, 'ACCOUNT_BROWSER_RESULT_UNRECORDED'],
  ]
  for (const [overrides, body, status, code] of cases) {
    const current = await fixture(t, overrides)
    const response = await fetch(`${current.root}/api/account-browser/open`, { method: 'POST', headers: current.headers, body: JSON.stringify(body) })
    assert.equal(response.status, status, code)
    const payload = await response.json()
    assert.deepEqual(payload, { error: code })
    assert.equal(JSON.stringify(payload).includes('secret'), false)
    assert.equal(JSON.stringify(payload).includes('/private'), false)
  }
})

test('unexpected launcher errors are sanitized to INTERNAL_ERROR', async t => {
  const f = await fixture(t)
  const request = { method: 'GET', headers: { cookie: f.cookie } }
  const result = await handleAccountBrowserRequest({
    pathname: '/api/account-browser/state', request, operatorSessions: f.operatorSessions,
    launcher: { state: async () => { throw new Error('private unexpected text') } },
  })
  assert.deepEqual(result, { status: 500, body: { error: 'INTERNAL_ERROR' } })
})
