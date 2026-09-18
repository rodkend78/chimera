import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const state = {
  agent: { id: 'ceo', name: 'RJ', status: 'Idle' },
  controller: { type: 'agent', id: 'ceo' }, suspended: false,
  browser: { running: true, tabs: [] }, activity: [], recentEvents: [], decisions: [], audit: { valid: true },
  models: { selected: { providerId: 'fixture', model: 'fixture' }, providers: [] },
  auth: { codex: { connected: true } }, agents: { specialists: [] }, tasks: [],
  conversations: { channels: [], messages: [] },
}
function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
async function fixture(t, session) {
  // Browser plugin not available. Render the real app with installed Playwright;
  // only HTTP/WS boundaries are fixtures, so no live auth, AWS, or task effects.
  const server = await createServer({ configFile: new URL('../app/vite.config.js', import.meta.url).pathname,
    server: { host: '127.0.0.1', port: 0, hmr: false, proxy: {} } })
  await server.listen()
  t.after(() => server.close())
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  page.setDefaultTimeout(5000)
  const errors = [], writes = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error' && !/\b(401|503)\b/.test(message.text())) errors.push(message.text())
  })
  await page.routeWebSocket('**/api/browser/stream', (socket) => socket.onMessage(() => {}))
  await page.route('**/api/**', async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (!['GET', 'HEAD'].includes(request.method())) writes.push(path)
    if (path === '/api/operator/session') return session(route)
    if (path === '/api/operator/bootstrap') return route.fulfill({ status: 401, json: { error: 'OPERATOR_BOOTSTRAP_INVALID' } })
    if (path === '/api/state') return route.fulfill({ json: state })
    return route.fulfill({ json: {} })
  })
  const url = `http://127.0.0.1:${server.httpServer.address().port}/`
  return { page, url, errors, writes }
}

test('initial session handshake shows meaningful loading status', { timeout: 20000 }, async (t) => {
  // The former empty-string fallback leaves this status blank.
  const hold = deferred()
  t.after(() => hold.resolve())
  const { page, url } = await fixture(t, async (route) => {
    await hold.promise
    await route.fulfill({ status: 401, json: { error: 'OPERATOR_AUTH_REQUIRED' } })
  })
  await page.goto(url)
  await page.getByRole('status').filter({ hasText: 'Starting secure browser workspace' }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Check sign-in again' }).count(), 0)
  hold.resolve()
})

test('expired operator access recovers through a duplicate-guarded read without replaying the launch or tasks', { timeout: 25000 }, async (t) => {
  // Replaying initialize's bootstrap, removing the retry lock, or not refreshing
  // state breaks either the outgoing request contract or the restored workspace.
  let allow = false, hold = null, pendingReads = 0
  const { page, url, errors, writes } = await fixture(t, async (route) => {
    if (hold) { pendingReads++; await hold.promise }
    await route.fulfill(allow
      ? { json: { csrfToken: 'fixture', expiresAt: new Date(Date.now() + 60000).toISOString() } }
      : { status: 401, json: { error: 'OPERATOR_AUTH_REQUIRED' } })
  })
  await page.goto(`${url}#operator=expired-fixture`)
  await page.getByRole('heading', { name: 'Sign in to your workspace' }).waitFor()
  await page.getByText(/fresh secure launch link/).waitFor()
  await page.getByText(/does not restart Chimera or resubmit work/).waitFor()
  assert.equal(await page.title(), 'Chimera Browser Workspace')
  assert.equal(new URL(page.url()).origin, new URL(url).origin)
  assert.equal(await page.locator('vite-error-overlay').count(), 0)
  await page.screenshot({ path: '/tmp/chimera-operator-recovery-desktop.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByText(/Device recovery steps/).click()
  await page.getByText('npm run pilot:status', { exact: true }).waitFor()
  await page.screenshot({ path: '/tmp/chimera-operator-recovery-mobile.png' })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.mouse.move(195, 650)
  await page.mouse.wheel(0, 1200)
  await page.waitForFunction(() => document.querySelector('.operator-recovery').scrollTop > 0, null, { timeout: 2000 })
  const detailsBox = await page.getByText('Connection details', { exact: true }).boundingBox()
  assert.ok(detailsBox.y >= 0 && detailsBox.y + detailsBox.height <= 844, 'Expanded mobile help must be reachable by normal scrolling')
  await page.screenshot({ path: '/tmp/chimera-operator-recovery-mobile-scrolled.png' })
  hold = deferred()
  t.after(() => hold.resolve())
  const retry = page.getByRole('button', { name: 'Check sign-in again' })
  await retry.evaluate((button) => { button.click(); button.click() })
  await page.getByRole('button', { name: 'Checking sign-in…' }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Checking sign-in…' }).isDisabled(), true)
  await page.waitForFunction(() => document.querySelector('[aria-busy="true"]') !== null)
  allow = true
  hold.resolve()
  await page.getByRole('navigation', { name: 'Primary navigation' }).waitFor()
  assert.equal(pendingReads, 1)
  assert.deepEqual(writes, ['/api/operator/bootstrap'])
  assert.equal(new URL(page.url()).hash, '')
  assert.deepEqual(errors, [])
})

test('service failures show connection recovery, and retry failures stay visible without writes', { timeout: 20000 }, async (t) => {
  // Misclassifying all failures as sign-in errors would hide service diagnostics.
  let requests = 0
  const { page, url, errors, writes } = await fixture(t, (route) => {
    requests++
    return route.fulfill({ status: 503, json: { error: 'SERVICE_UNAVAILABLE' } })
  })
  await page.goto(url)
  await page.getByRole('heading', { name: 'Cannot reach your workspace' }).waitFor()
  const before = requests
  await page.getByRole('button', { name: 'Try connection again' }).click()
  await page.getByRole('button', { name: 'Try connection again' }).waitFor()
  assert.ok(requests > before)
  assert.equal(await page.getByRole('navigation', { name: 'Primary navigation' }).count(), 0)
  assert.deepEqual(writes, [])
  assert.deepEqual(errors, [])
})
