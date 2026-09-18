import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const APP_STATE = {
  agent: { id: 'ceo', name: 'RJ', status: 'Working', model: 'Fixture' },
  browser: { running: true, tabs: [{ tabId: 'one', title: 'Fixture', url: 'about:blank', active: true }] },
  controller: { type: 'agent', id: 'ceo' }, suspended: false, hourlyCost: null,
  activity: [], recentEvents: [], decisions: [], audit: { valid: true }, tasks: [],
  models: { selected: { providerId: 'fixture', model: 'fixture', modelName: 'Fixture' }, providers: [{ id: 'fixture', name: 'Fixture', configured: true, models: [{ id: 'fixture', name: 'Fixture', availability: 'verified-route', capabilities: ['conversation'] }] }] },
  auth: { codex: { connected: true, status: 'connected' } },
  conversations: { messages: [], channels: [{ conversationId: 'main', kind: 'hq', recipientAgentId: 'ceo', label: 'RJ', detail: 'Your main conversation' }] },
  agents: {
    main: { agentId: 'ceo', displayName: 'RJ', modelPreference: { mode: 'auto' }, access: { profileId: 'safe', description: 'Fixture-safe access', network: 'restricted' }, source: { type: 'chimera' } },
    specialists: [], accessProfiles: [{ profileId: 'safe', label: 'Safe', warning: '' }],
  }, teamMessaging: { tasks: [] },
}

async function fixture(t, { accountStates = [{ browser: 'chrome', surface: 'native-window', status: 'available', companion: 'not-installed', agentAccess: 'unavailable' }], openReplies = [{ status: 202, body: { status: 'launch-requested', browser: 'chrome', surface: 'native-window', agentAccess: 'unavailable' } }] } = {}) {
  const server = await createServer({ configFile: new URL('../app/vite.config.js', import.meta.url).pathname,
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, proxy: {} } })
  await server.listen()
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const calls = []
  const errors = []
  let stateIndex = 0
  let openIndex = 0
  page.setDefaultTimeout(7000)
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  await page.routeWebSocket('**/api/browser/stream', socket => socket.onMessage(() => {}))
  await page.route('**/api/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const body = request.method() === 'POST' && request.postData() ? request.postDataJSON() : null
    calls.push({ path, method: request.method(), body })
    if (path === '/api/operator/session') return route.fulfill({ json: { csrfToken: 'fixture-token', expiresAt: new Date(Date.now() + 60000).toISOString() } })
    if (path === '/api/state') return route.fulfill({ json: APP_STATE })
    if (path === '/api/account-companion/state') return route.fulfill({ json: { status: 'not-installed', pendingPairs: [], profiles: [], leases: [] } })
    if (path === '/api/account-browser/state') {
      const reply = accountStates[Math.min(stateIndex++, accountStates.length - 1)]
      return reply.drop ? route.abort('failed') : route.fulfill({ status: reply.httpStatus ?? 200, json: reply.body ?? reply })
    }
    if (path === '/api/account-browser/open') {
      const reply = openReplies[Math.min(openIndex++, openReplies.length - 1)]
      if (reply.delay) await new Promise(resolve => setTimeout(resolve, reply.delay))
      return reply.drop ? route.abort('failed') : route.fulfill({ status: reply.status, json: reply.body })
    }
    if (path === '/api/browser/files') return route.fulfill({ json: { status: 'allowed', result: { upload: { pending: false }, downloads: [] } } })
    return route.fulfill({ json: { status: 'allowed' } })
  })
  const address = server.httpServer.address()
  await page.goto(`http://127.0.0.1:${address.port}/`)
  await page.getByRole('navigation', { name: 'Primary navigation' }).waitFor()
  await page.getByRole('button', { name: 'Browser', exact: true }).click()
  t.after(async () => { await browser.close(); await server.close() })
  return { page, calls, errors }
}

test('explicit My accounts launch preserves the sandbox and renders responsively', { timeout: 30000 }, async t => {
  const { page, calls, errors } = await fixture(t, { openReplies: [{ status: 202, body: { status: 'launch-requested', browser: 'chrome', surface: 'native-window', agentAccess: 'unavailable' }, delay: 200 }] })
  assert.equal(await page.title(), 'Chimera Browser Workspace')
  await page.getByRole('textbox', { name: 'Address' }).waitFor()
  await page.getByRole('button', { name: 'Open new tab' }).waitFor()
  const modes = page.getByRole('group', { name: 'Browser mode' })
  await modes.getByRole('button', { name: 'My accounts', exact: true }).click()
  const panel = page.getByRole('region', { name: 'My accounts' })
  await panel.waitFor()
  await panel.getByText('Human control', { exact: true }).waitFor()
  await panel.getByText('Agent access unavailable', { exact: true }).waitFor()
  assert.equal(calls.filter(call => call.path === '/api/account-browser/open').length, 0)
  const google = panel.getByRole('radio', { name: 'Google sign-in Sign in personally in the native Chrome window.' })
  await google.focus()
  await google.press('Space')
  assert.equal(await google.isChecked(), true)
  const home = panel.getByRole('radio', { name: 'Browser home Start with a neutral Chrome page.' })
  await home.focus()
  await home.press('Space')
  await panel.getByRole('button', { name: 'Open Chrome', exact: true }).dblclick({ delay: 20 })
  await panel.getByText('Launch requested', { exact: true }).waitFor()
  assert.doesNotMatch(await panel.locator('.account-browser__feedback').innerText(), /macOS/)
  const openCalls = calls.filter(call => call.path === '/api/account-browser/open')
  assert.equal(openCalls.length, 1)
  assert.deepEqual(openCalls[0].body, { url: 'https://www.google.com/' })
  await page.screenshot({ path: '/tmp/chimera-account-browser-desktop.png' })
  await modes.getByRole('button', { name: 'Agent sandbox', exact: true }).click()
  await page.getByRole('textbox', { name: 'Address' }).waitFor()
  await page.getByRole('button', { name: 'Work', exact: true }).click()
  await page.getByRole('button', { name: 'Team', exact: true }).click()
  await page.getByRole('button', { name: 'Browser', exact: true }).click()
  await modes.getByRole('button', { name: 'My accounts', exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await panel.getByRole('button', { name: 'Open Chrome', exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: '/tmp/chimera-account-browser-mobile.png' })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true)
  assert.ok((await panel.boundingBox()).height > 300)
  assert.equal(await page.locator('vite-error-overlay').count(), 0)
  assert.deepEqual(errors, [])
})

test('availability failures stay honest and retry only on explicit request', { timeout: 30000 }, async t => {
  const { page, calls } = await fixture(t, { accountStates: [
    { httpStatus: 503, body: { error: 'ACCOUNT_BROWSER_UNAVAILABLE' } },
    { browser: 'chrome', surface: 'native-window', status: 'missing-browser', companion: 'not-installed', agentAccess: 'unavailable' },
    { browser: 'chrome', surface: 'native-window', status: 'unsupported-platform', companion: 'not-installed', agentAccess: 'unavailable' },
    { browser: 'chrome', surface: 'native-window', status: 'unavailable', companion: 'not-installed', agentAccess: 'unavailable' },
  ] })
  await page.getByRole('button', { name: 'My accounts', exact: true }).click()
  const panel = page.getByRole('region', { name: 'My accounts' })
  await panel.getByText('Could not check Chrome', { exact: true }).waitFor()
  assert.equal(calls.filter(call => call.path === '/api/account-browser/state').length, 1)
  for (const text of ['Chrome is not installed', 'This account browser requires macOS or a Linux desktop', 'Chrome is unavailable']) {
    await panel.getByRole('button', { name: 'Check again', exact: true }).click()
    await panel.getByText(text, { exact: true }).waitFor()
    assert.equal(await panel.getByRole('button', { name: 'Open Chrome', exact: true }).isEnabled(), false)
  }
  assert.equal(calls.filter(call => call.path === '/api/account-browser/open').length, 0)
})

test('launch errors distinguish pre-dispatch retry from uncertain post-dispatch outcomes', { timeout: 30000 }, async t => {
  const replies = [
    { status: 400, body: { error: 'ACCOUNT_BROWSER_URL_INVALID' } },
    { status: 503, body: { error: 'ACCOUNT_BROWSER_AUDIT_UNAVAILABLE' } },
    { status: 503, body: { error: 'ACCOUNT_BROWSER_PROFILE_UNAVAILABLE' } },
    { status: 502, body: { error: 'ACCOUNT_BROWSER_LAUNCH_UNCONFIRMED' } },
    { status: 503, body: { error: 'ACCOUNT_BROWSER_RESULT_UNRECORDED' } },
    { drop: true },
  ]
  const { page, calls, errors } = await fixture(t, { openReplies: replies })
  await page.getByRole('button', { name: 'My accounts', exact: true }).click()
  const panel = page.getByRole('region', { name: 'My accounts' })
  const open = panel.getByRole('button', { name: 'Open Chrome', exact: true })
  const corruptible = panel.getByRole('radio', { name: 'Google sign-in Sign in personally in the native Chrome window.' })
  await panel.getByText('Chrome is ready', { exact: true }).waitFor()
  // Inject the invalid selection in one browser turn; a render between mutation
  // and click restores the controlled value and tests an approved URL instead.
  await corruptible.evaluate(element => { element.value = 'https://unapproved.example/'; element.click() })
  await open.click()
  assert.equal(calls.filter(call => call.path === '/api/account-browser/open').length, 0)
  await panel.getByRole('radio', { name: 'Browser home Start with a neutral Chrome page.' }).click()
  for (const expected of [
    'That destination is not approved. Choose one of the listed destinations.',
    'The launch was not dispatched because Chimera could not record the request. You can try again.',
    'Chimera Work storage is unavailable or unsafe. Chrome was not launched; check the dedicated browser directory before trying again.',
    'Chrome may have received the request. Check Chrome first; Chimera will not retry automatically.',
    'The desktop accepted the launch request, but Chimera could not record the result. Check Chrome first; do not retry automatically.',
    'The result is unconfirmed. Check Chrome first; Chimera will not retry automatically.',
  ]) {
    await open.click()
    await panel.getByText(expected, { exact: true }).waitFor()
  }
  const expectedFixtureError = /server responded with a status of (400|502|503)|net::ERR_FAILED/
  assert.equal(errors.every(message => expectedFixtureError.test(message)), true, `unknown console errors: ${errors.join('\n')}`)
})
