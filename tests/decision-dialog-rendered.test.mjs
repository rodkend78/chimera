import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { approvalReviewForTool } from '../src/dsh/enforcement-adapter.mjs'

async function fixture(t, { long = false, handle, extra = false, reviewFields = {} } = {}) {
  const server = await createServer({ configFile: new URL('../app/vite.config.js', import.meta.url).pathname,
    server: { host: '127.0.0.1', port: 0, hmr: false, proxy: {} } })
  await server.listen()
  const browser = await chromium.launch({ headless: true })
  t.after(async () => { await browser.close(); await server.close() })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  page.setDefaultTimeout(2500)
  const writes = [], errors = []
  const fields = { Repository: 'Fixture repository', 'Expected head SHA': 'a'.repeat(40),
    Description: long ? 'Review the exact bounded fixture action. '.repeat(80) : 'Read-only UI review fixture', ...reviewFields }
  const decision = { actionId: 'fixture-action', title: 'Review fixture action', detail: 'No real action will execute in this test.',
    agent: { agentId: 'ace' }, actionDiff: { review: { fields } } }
  const state = { agent: { id: 'ceo', name: 'RJ', status: 'Idle' }, controller: { type: 'agent', id: 'ceo' }, suspended: false,
    browser: { running: true, tabs: [] }, activity: [], recentEvents: [], decisions: [decision], audit: { valid: true },
    models: { selected: { providerId: 'fixture', model: 'fixture', providerName: 'Fixture', modelName: 'Fixture' }, providers: [] },
    auth: { codex: { connected: true } }, agents: { specialists: [] }, tasks: [], conversations: { channels: [], messages: [] } }
  if (extra) state.decisions.push({ ...decision, actionId: 'second-action', title: 'Second fixture action' })
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', m => { if (['error', 'warning'].includes(m.type()) && !m.text().includes('503 (Service Unavailable)')) errors.push(m.text()) })
  await page.routeWebSocket('**/api/browser/stream', socket => socket.onMessage(() => {}))
  await page.route('**/*', async route => {
    const url = new URL(route.request().url()), path = url.pathname
    if (url.hostname !== '127.0.0.1') throw new Error(`Unexpected external request: ${url.origin}`)
    if (!path.startsWith('/api/')) return route.continue()
    const body = route.request().method() !== 'GET' ? route.request().postDataJSON() : null
    if (body) writes.push({ path, body })
    if (await handle?.({ path, body, route, state })) return
    if (body) throw new Error(`Unexpected action: ${path}`)
    if (path === '/api/operator/session') return route.fulfill({ json: { csrfToken: 'fixture', expiresAt: '2099-01-01T00:00:00Z' } })
    if (path !== '/api/state') throw new Error(`Unexpected API read: ${path}`)
    await route.fulfill({ json: state })
  })
  const url = `http://127.0.0.1:${server.httpServer.address().port}/`
  await page.goto(url)
  assert.equal(page.url(), url)
  assert.equal(await page.title(), 'Chimera Browser Workspace')
  if (await page.getByRole('button', { name: 'More tools', exact: true }).getAttribute('aria-expanded') === 'false') await page.getByRole('button', { name: 'More tools', exact: true }).click()
  await page.getByRole('button', { name: 'Decisions', exact: true }).click()
  const trigger = page.getByRole('main').getByRole('button', { name: 'Review', exact: true }).first()
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: decision.title, exact: true })
  await dialog.waitFor()
  return { page, dialog, trigger, fields, writes, errors }
}

test('approval previews preserve command newlines and show file content as inert text', { timeout: 15000 }, async t => {
  const command = '# comment\nprintf proposed-action'
  const content = '<script>notExecutable()</script>\nsecond line'
  const reviewFields = { ...approvalReviewForTool('bash', { command }).fields,
    Content: approvalReviewForTool('write', { path: 'scratch/file', content }).fields.Content }
  const { dialog, writes, errors } = await fixture(t, { reviewFields })
  const field = label => dialog.locator(`.decision-review > div:has(> dt:text-is("${label}")) > dd`)
  assert.equal(await field('Command').textContent(), command)
  assert.equal(await field('Command').evaluate(node => getComputedStyle(node).whiteSpace), 'pre-wrap')
  assert.equal(await field('Content').textContent(), content)
  assert.equal(await dialog.locator('script').count(), 0)
  assert.deepEqual(writes, [])
  assert.deepEqual(errors, [])
})

test('decision review opens with non-action focus and contains keyboard navigation', { timeout: 15000 }, async t => {
  const { page, dialog, writes, errors } = await fixture(t)
  assert.equal(await dialog.getByRole('button', { name: 'Close', exact: true }).evaluate(node => node === document.activeElement), true)
  for (const key of ['Tab', 'Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
    await page.keyboard.press(key)
    assert.equal(await dialog.evaluate(node => node.contains(document.activeElement)), true, `focus escaped on ${key} to ${await page.evaluate(() => document.activeElement?.tagName)}`)
  }
  await page.locator('[aria-label="RJ queue objective"]').evaluate(node => node.focus())
  assert.equal(await dialog.evaluate(node => node.contains(document.activeElement)), true, 'background controls must be inert during review')
  assert.deepEqual(writes, [])
  assert.deepEqual(errors, [])
})

test('Escape dismisses decision review without denying or approving and restores the review trigger', { timeout: 15000 }, async t => {
  const { page, dialog, trigger, writes, errors } = await fixture(t)
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'detached' })
  assert.equal(await trigger.evaluate(node => node === document.activeElement), true)
  await page.keyboard.press('Enter')
  await dialog.waitFor()
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
  assert.equal(await trigger.evaluate(node => node === document.activeElement), true)
  assert.deepEqual(writes, [])
  assert.deepEqual(errors, [])
})

test('decision review preserves exact details and scrollable controls on desktop and mobile', { timeout: 15000 }, async t => {
  const { page, dialog, fields, writes, errors } = await fixture(t, { long: true })
  for (const [name, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]]) {
    await page.setViewportSize({ width, height })
    for (const value of Object.values(fields)) assert.equal(await dialog.getByText(value, { exact: true }).count(), 1)
    const approve = dialog.getByRole('button', { name: 'Approve', exact: true })
    await approve.scrollIntoViewIfNeeded()
    const bounds = await approve.boundingBox()
    assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= height)
    await page.screenshot({ path: `/tmp/chimera-decision-dialog-${name}-controls.png` })
    await dialog.evaluate(node => { node.scrollTop = 0 })
    await page.screenshot({ path: `/tmp/chimera-decision-dialog-${name}.png` })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    assert.equal(await page.locator('vite-error-overlay').count(), 0)
  }
  await dialog.getByRole('heading', { name: 'Review fixture action', exact: true }).click()
  assert.equal(await dialog.count(), 1, 'clicking review content must not dismiss it')
  await page.mouse.click(3, 3)
  await dialog.waitFor({ state: 'detached' })
  assert.deepEqual(writes, [])
  assert.deepEqual(errors, [])
})

function deferred() { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const responses = page => page.getByRole('region', { name: 'Decision responses', exact: true })
async function roundTrip(page) {
  await page.getByRole('button', { name: 'Work', exact: true }).click()
  if (await page.getByRole('button', { name: 'More tools', exact: true }).getAttribute('aria-expanded') === 'false') await page.getByRole('button', { name: 'More tools', exact: true }).click()
  await page.getByRole('button', { name: 'Decisions', exact: true }).click()
}

test('one decision owns its pending response across same-turn outcomes, dismissal and navigation', { timeout: 15000 }, async t => {
  const started = deferred(), release = deferred()
  t.after(() => release.resolve())
  const { page, dialog, writes, errors } = await fixture(t, { handle: async ({ path, route, state }) => {
    if (path !== '/api/decisions/fixture-action') return false
    started.resolve(); await release.promise
    state.decisions = []
    await route.fulfill({ json: { status: 'allowed', actionId: 'fixture-action' } }); return true
  } })
  await dialog.evaluate(node => {
    node.querySelector('.approve').click(); node.querySelector('.approve').click()
    node.querySelector('.dialog-actions button:not(.approve)').click()
  })
  await started.promise
  await page.keyboard.press('Escape')
  await roundTrip(page)
  assert.equal(await page.getByRole('main').getByRole('button', { name: 'Deny', exact: true }).isDisabled(), true)
  assert.match(await responses(page).textContent(), /fixture-action.*pending/is)
  assert.deepEqual(writes, [{ path: '/api/decisions/fixture-action', body: { outcome: 'approve' } }])
  release.resolve()
  await responses(page).getByText(/Service result: allowed/).waitFor()
  await roundTrip(page)
  assert.match(await responses(page).textContent(), /Review fixture action/)
  assert.deepEqual(errors, [])
})

test('a late response for one decision cannot dismiss or unlock a different pending review', { timeout: 15000 }, async t => {
  const starts = [deferred(), deferred()], releases = [deferred(), deferred()]
  t.after(() => releases.forEach(d => d.resolve()))
  const { page, dialog, writes, errors } = await fixture(t, { extra: true, handle: async ({ path, route }) => {
    if (!path.startsWith('/api/decisions/')) return false
    const second = path.endsWith('second-action'), index = second ? 1 : 0
    starts[index].resolve(); await releases[index].promise
    await route.fulfill({ json: { status: second ? 'denied' : 'allowed', actionId: second ? 'second-action' : 'fixture-action', ...(second ? { reason: 'HUMAN_DENIED' } : {}) } }); return true
  } })
  await dialog.getByRole('button', { name: 'Approve', exact: true }).click(); await starts[0].promise
  await page.keyboard.press('Escape')
  await page.getByRole('main').locator('.decision-list-card').filter({ hasText: 'Second fixture action' }).getByRole('button', { name: 'Review' }).click()
  const second = page.getByRole('dialog', { name: 'Second fixture action', exact: true })
  await second.getByRole('button', { name: 'Deny', exact: true }).click(); await starts[1].promise
  releases[0].resolve()
  // Wait for the first response's attributed feedback before checking ownership.
  await page.locator('.decision-responses').getByText(/Service result: allowed/).waitFor({ state: 'attached' })
  assert.equal(await second.isVisible(), true)
  assert.equal(await second.getByRole('button', { name: 'Approve', exact: true }).isDisabled(), true)
  releases[1].resolve()
  await second.waitFor({ state: 'detached' })
  assert.deepEqual(writes.map(w => w.body.outcome), ['approve', 'deny'])
  assert.deepEqual(errors, [])
})

test('failed decision response stays attributed after closing and navigation without automatic retry', { timeout: 15000 }, async t => {
  const { page, dialog, writes, errors } = await fixture(t, { handle: async ({ path, route }) => {
    if (path !== '/api/decisions/fixture-action') return false
    await route.fulfill({ status: 503, json: { error: 'FIXTURE_RESPONSE_UNAVAILABLE' } }); return true
  } })
  await dialog.getByRole('button', { name: 'Approve', exact: true }).click()
  await dialog.getByRole('alert').waitFor()
  await page.keyboard.press('Escape'); await roundTrip(page)
  assert.match(await responses(page).textContent(), /fixture-action.*unconfirmed.*Inspect.*before.*retry/is)
  assert.equal(writes.length, 1)
  assert.deepEqual(errors, [])
  const dismiss = responses(page).getByRole('button', { name: 'Dismiss response for fixture-action', exact: true })
  await dismiss.waitFor()
  await responses(page).scrollIntoViewIfNeeded()
  await page.screenshot({ path: '/tmp/chimera-decision-feedback-desktop.png' })
  await page.screenshot({ path: '/tmp/chimera-decision-dismiss-desktop.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  await responses(page).scrollIntoViewIfNeeded()
  await dismiss.focus()
  await page.screenshot({ path: '/tmp/chimera-decision-feedback-mobile.png' })
  await page.screenshot({ path: '/tmp/chimera-decision-dismiss-mobile.png' })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  const bounds = await dismiss.boundingBox()
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390 && bounds.y >= 0 && bounds.y + bounds.height <= 844)
  await dismiss.click()
  await responses(page).waitFor({ state: 'detached' })
  assert.equal(writes.length, 1)
  assert.deepEqual(errors, [])
})

test('confirmed decision response survives failed snapshot refresh without allowing a repeated terminal response', { timeout: 15000 }, async t => {
  let replied = false
  const { page, dialog, writes, errors } = await fixture(t, { handle: async ({ path, route }) => {
    if (path === '/api/decisions/fixture-action') { replied = true; await route.fulfill({ json: { status: 'allowed', actionId: 'fixture-action' } }); return true }
    if (path === '/api/state' && replied) { await route.fulfill({ status: 503, json: { error: 'FIXTURE_SNAPSHOT_UNAVAILABLE' } }); return true }
    return false
  } })
  await dialog.getByRole('button', { name: 'Approve', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
  assert.match(await responses(page).textContent(), /Service result: allowed.*snapshot.*unconfirmed/is)
  assert.equal(await page.getByRole('main').getByRole('button', { name: 'Deny', exact: true }).isDisabled(), true)
  await roundTrip(page)
  assert.equal(await page.getByRole('main').getByRole('button', { name: 'Deny', exact: true }).isDisabled(), true)
  assert.equal(writes.length, 1)
  assert.deepEqual(errors, [])
})

for (const [label, result] of [['foreign action', { status: 'allowed', actionId: 'another-action' }], ['incomplete', { actionId: 'fixture-action' }]]) {
  test(`a ${label} reply is unconfirmed rather than confirmation of this decision`, { timeout: 15000 }, async t => {
    const { page, dialog, writes, errors } = await fixture(t, { handle: async ({ path, route }) => {
      if (path !== '/api/decisions/fixture-action') return false
      await route.fulfill({ json: result }); return true
    } })
    await dialog.getByRole('button', { name: 'Approve', exact: true }).click()
    await dialog.getByRole('alert').waitFor()
    assert.match(await dialog.getByRole('alert').textContent(), /unconfirmed.*requested action/is)
    assert.equal(await dialog.isVisible(), true)
    await page.keyboard.press('Escape'); await roundTrip(page)
    assert.equal(writes.length, 1)
    assert.deepEqual(errors, [])
  })
}

for (const [reason, terminal] of [['DECISION_EXPIRED_OR_NOT_ACTIVE', true], ['FIXTURE_TEMPORARILY_DENIED', false]]) {
  test(`service denial ${reason} stays distinct from requested approval`, { timeout: 15000 }, async t => {
    const { page, dialog, writes, errors } = await fixture(t, { handle: async ({ path, route }) => {
      if (path !== '/api/decisions/fixture-action') return false
      await route.fulfill({ json: { status: 'denied', actionId: 'fixture-action', reason } }); return true
    } })
    await dialog.getByRole('button', { name: 'Approve', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    assert.match(await responses(page).textContent(), /Approval requested.*Service result: denied/s)
    assert.ok((await responses(page).textContent()).includes(reason))
    assert.doesNotMatch(await responses(page).getByRole('status').textContent(), /work completed|action executed|approval accepted/i)
    assert.match(await responses(page).textContent(), /Service replies are not proof that the requested work completed/)
    assert.equal(await page.getByRole('main').getByRole('button', { name: 'Deny', exact: true }).isDisabled(), terminal)
    assert.deepEqual(writes, [{ path: '/api/decisions/fixture-action', body: { outcome: 'approve' } }])
    assert.deepEqual(errors, [])
  })
}

test('settled response dismissal is keyboard operable and does not unlock a terminal decision', { timeout: 15000 }, async t => {
  const refreshStarted = deferred(), releaseRefresh = deferred()
  t.after(() => releaseRefresh.resolve())
  let replied = false
  const { page, dialog, writes, errors } = await fixture(t, { handle: async ({ path, route, state }) => {
    if (path === '/api/decisions/fixture-action') {
      replied = true; await route.fulfill({ json: { status: 'allowed', actionId: 'fixture-action' } }); return true
    }
    if (path === '/api/state' && replied) {
      refreshStarted.resolve(); await releaseRefresh.promise
      await route.fulfill({ json: state }); return true
    }
    return false
  } })
  await dialog.getByRole('button', { name: 'Approve', exact: true }).click()
  await refreshStarted.promise
  await page.keyboard.press('Escape')
  await responses(page).getByText(/Service result: allowed/).waitFor()
  const dismiss = responses(page).getByRole('button', { name: 'Dismiss response for fixture-action', exact: true })
  assert.equal(await dismiss.count(), 0, 'response feedback must not be dismissible while its refresh is pending')
  releaseRefresh.resolve()
  await dismiss.waitFor()
  await dismiss.focus(); await page.keyboard.press('Enter')
  await responses(page).waitFor({ state: 'detached' })
  await roundTrip(page)
  assert.equal(await responses(page).count(), 0)
  assert.equal(await page.getByRole('main').getByRole('button', { name: 'Deny', exact: true }).isDisabled(), true)
  await page.getByRole('main').getByRole('button', { name: 'Review', exact: true }).click()
  assert.equal(await dialog.getByRole('button', { name: 'Approve', exact: true }).isDisabled(), true)
  assert.equal(writes.length, 1)
  assert.deepEqual(errors, [])
})

test('dismissing an unconfirmed response keeps other pending feedback and permits only an explicit retry', { timeout: 15000 }, async t => {
  const secondStarted = deferred(), releaseSecond = deferred()
  t.after(() => releaseSecond.resolve())
  const { page, dialog, writes, errors } = await fixture(t, { extra: true, handle: async ({ path, route }) => {
    if (path === '/api/decisions/fixture-action') {
      await route.fulfill({ status: 503, json: { error: 'FIXTURE_RESPONSE_UNAVAILABLE' } }); return true
    }
    if (path === '/api/decisions/second-action') {
      secondStarted.resolve(); await releaseSecond.promise
      await route.fulfill({ json: { status: 'denied', actionId: 'second-action', reason: 'HUMAN_DENIED' } }); return true
    }
    return false
  } })
  await dialog.getByRole('button', { name: 'Approve', exact: true }).click()
  await dialog.getByRole('alert').waitFor()
  await page.keyboard.press('Escape')
  await page.getByRole('main').locator('.decision-list-card').filter({ hasText: 'Second fixture action' }).getByRole('button', { name: 'Deny', exact: true }).click()
  await secondStarted.promise
  await responses(page).getByRole('button', { name: 'Dismiss response for fixture-action', exact: true }).click()
  assert.equal(await responses(page).getByRole('button', { name: 'Dismiss response for second-action', exact: true }).count(), 0)
  assert.doesNotMatch(await responses(page).textContent(), /fixture-action|unconfirmed/i)
  assert.match(await responses(page).textContent(), /second-action.*pending/is)
  await roundTrip(page)
  assert.equal(writes.length, 2, 'dismissal and navigation must never retry a response')
  await page.getByRole('main').locator('.decision-list-card').filter({ hasText: 'Review fixture action' }).getByRole('button', { name: 'Deny', exact: true }).click()
  await responses(page).getByRole('alert').waitFor()
  assert.deepEqual(writes.map(w => w.body.outcome), ['approve', 'deny', 'deny'])
  assert.match(await responses(page).getByRole('alert').textContent(), /Denial requested/)
  releaseSecond.resolve()
  await responses(page).getByRole('button', { name: 'Dismiss response for second-action', exact: true }).waitFor()
  assert.deepEqual(errors, [])
})
