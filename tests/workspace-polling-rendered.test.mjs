import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'

function deferred() { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
async function fixture(t, handler) {
  const server = await createServer({ configFile: new URL('../app/vite.config.js', import.meta.url).pathname,
    server: { host: '127.0.0.1', port: 0, hmr: false, proxy: {} } })
  await server.listen()
  const browser = await chromium.launch({ headless: true })
  t.after(async () => { await browser.close(); await server.close() })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  page.setDefaultTimeout(2500)
  await page.clock.install()
  await page.clock.pauseAt(new Date())
  const errors = [], writes = [], reads = []
  let pending = 0, maxPending = 0
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', m => { if (['error', 'warning'].includes(m.type()) && !m.text().includes('503 (Service Unavailable)')) errors.push(m.text()) })
  await page.routeWebSocket('**/api/browser/stream', socket => socket.onMessage(() => {}))
  await page.route('**/*', async route => {
    const url = new URL(route.request().url()), path = url.pathname
    if (url.hostname !== '127.0.0.1') throw new Error(`Unexpected external request: ${url.origin}`)
    if (!path.startsWith('/api/')) return route.continue()
    if (route.request().method() !== 'GET') {
      writes.push({ path, body: route.request().postDataJSON() })
      if (path === '/api/tasks/steer') return route.fulfill({ json: {} })
      throw new Error(`Unexpected fixture write: ${path}`)
    }
    if (path === '/api/operator/session') return route.fulfill({ json: { csrfToken: 'fixture', expiresAt: '2099-01-01T00:00:00Z' } })
    if (path !== '/api/state') throw new Error(`Unexpected fixture request: ${path}`)
    const sequence = reads.length + 1
    reads.push(sequence); pending++; maxPending = Math.max(maxPending, pending)
    try {
      if (await handler?.({ sequence, route })) return
      await route.fulfill({ json: {
        agent: { id: 'ceo', name: 'RJ', status: 'Working' }, controller: { type: 'agent', id: 'ceo' }, suspended: false,
        browser: { running: true, tabs: [] }, activity: [], recentEvents: [], decisions: [], audit: { valid: true },
        models: { selected: { providerId: 'fixture', model: 'fixture', providerName: 'Fixture', modelName: 'Fixture' }, providers: [] },
        auth: { codex: { connected: true } }, agents: { specialists: [] },
        tasks: [{ taskId: 'alpha', objective: `Snapshot ${sequence}`, status: 'running' }],
        conversations: { channels: [], messages: [] }, projects: { projects: [], sessions: [], leases: [] },
      } })
    } finally { pending-- }
  })
  const url = `http://127.0.0.1:${server.httpServer.address().port}/`
  await page.goto(url)
  assert.equal(page.url(), url)
  assert.equal(await page.title(), 'Chimera Browser Workspace')
  await page.getByRole('button', { name: 'Work', exact: true }).click()
  const snapshot = n => page.locator('.dock-target summary').filter({ hasText: `Snapshot ${n}` }).waitFor()
  await snapshot(1)
  return { page, reads, writes, errors, snapshot, maxPending: () => maxPending }
}
const visibility = (page, hidden, repeat = 1) => page.evaluate(({ hidden, repeat }) => {
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden })
  for (let i = 0; i < repeat; i++) document.dispatchEvent(new Event('visibilitychange'))
}, { hidden, repeat })

test('returning between polls keeps future snapshots flowing without clearing a human draft', { timeout: 15000 }, async t => {
  const { page, reads, writes, errors, snapshot } = await fixture(t)
  await page.getByRole('textbox', { name: 'RJ queue objective' }).fill('Keep this unsent review')
  await visibility(page, true)
  await visibility(page, false)
  await snapshot(2)
  await page.clock.runFor(1100)
  await snapshot(3)
  assert.equal(reads.length, 3, 'returning must rearm the next poll, not stop after one refresh')
  await page.clock.runFor(1100)
  await snapshot(4)
  assert.equal(await page.getByRole('textbox', { name: 'RJ queue objective' }).inputValue(), 'Keep this unsent review')
  assert.deepEqual(writes, [])
  assert.deepEqual(errors, [])
  assert.equal(await page.locator('vite-error-overlay').count(), 0)
  await page.screenshot({ path: '/tmp/chimera-polling-recovered-desktop.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: '/tmp/chimera-polling-recovered-mobile.png' })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
})

test('rapid tab returns during a pending snapshot keep one poll in flight and one future loop', { timeout: 15000 }, async t => {
  const started = deferred(), release = deferred()
  t.after(() => release.resolve())
  const { page, reads, writes, errors, snapshot, maxPending } = await fixture(t, async ({ sequence }) => {
    if (sequence >= 2) { started.resolve(); await release.promise }
    return false
  })
  await visibility(page, false)
  await started.promise
  await visibility(page, true)
  await visibility(page, false, 5)
  await page.clock.runFor(200)
  assert.equal(reads.length, 2, 'return events must coalesce into the outstanding poll')
  assert.equal(maxPending(), 1)
  release.resolve()
  await snapshot(2)
  await page.clock.runFor(1100)
  await snapshot(3)
  assert.equal(reads.length, 3, 'one completion schedules exactly one next poll')
  assert.deepEqual(writes, [])
  assert.deepEqual(errors, [])
})

test('a failed foreground snapshot keeps the previous view and recovers on the next poll without writes', { timeout: 15000 }, async t => {
  const { page, snapshot, reads, writes, errors } = await fixture(t, async ({ sequence, route }) => {
    if (sequence !== 2) return false
    await route.fulfill({ status: 503, json: { error: 'FIXTURE_STATE_UNAVAILABLE' } }); return true
  })
  await page.getByRole('textbox', { name: 'RJ queue objective' }).fill('Do not lose the draft on read failure')
  await visibility(page, false)
  await page.getByRole('alert').filter({ hasText: 'fixture state unavailable' }).waitFor()
  await snapshot(1)
  await page.clock.runFor(1100)
  await snapshot(3)
  assert.equal(await page.getByRole('alert').filter({ hasText: 'fixture state unavailable' }).count(), 0)
  assert.equal(await page.getByRole('textbox', { name: 'RJ queue objective' }).inputValue(), 'Do not lose the draft on read failure')
  assert.equal(reads.length, 3)
  assert.deepEqual(writes, [])
  assert.deepEqual(errors, [])
})

test('background polling stays slower and returning to the foreground restores regular updates', { timeout: 15000 }, async t => {
  const { page, snapshot, reads, writes, errors } = await fixture(t)
  await visibility(page, true)
  await page.clock.runFor(1100)
  await snapshot(2)
  await page.clock.runFor(1100)
  assert.equal(reads.length, 2, 'hidden tabs should not keep the foreground cadence')
  await page.clock.runFor(2600)
  await snapshot(3)
  await visibility(page, false)
  await snapshot(4)
  await page.clock.runFor(1100)
  await snapshot(5)
  assert.equal(reads.length, 5)
  assert.deepEqual(writes, [])
  assert.deepEqual(errors, [])
})

async function sendGuidance(page) {
  await page.getByRole('textbox', { name: 'RJ queue objective' }).fill('Fixture guidance, exactly once')
  await page.getByRole('button', { name: 'Guide current task', exact: true }).click()
}
const expectedGuidance = [{ path: '/api/tasks/steer', body: { taskId: 'alpha', content: 'Fixture guidance, exactly once' } }]

for (const older of ['success', 'failure']) {
  test(`an older background ${older} cannot replace a newer post-action snapshot or connection state`, { timeout: 15000 }, async t => {
    const started = deferred(), release = deferred()
    t.after(() => release.resolve())
    const { page, snapshot, writes, errors } = await fixture(t, async ({ sequence, route }) => {
      if (sequence !== 2) return false
      started.resolve(); await release.promise
      if (older === 'failure') { await route.fulfill({ status: 503, json: { error: 'OLD_SNAPSHOT_FAILURE' } }); return true }
      return false
    })
    await page.clock.runFor(1100)
    await started.promise
    await sendGuidance(page)
    await snapshot(3)
    await page.locator('.dock-result').waitFor()
    await page.getByRole('textbox', { name: 'RJ queue objective' }).fill('A newer unsent draft')
    release.resolve()
    await page.clock.runFor(200)
    assert.match(await page.locator('.dock-target summary').textContent(), /Snapshot 3/)
    assert.equal(await page.locator('.connection-alert').count(), 0)
    assert.match(await page.locator('.dock-result').textContent(), /Sent/)
    assert.equal(await page.getByRole('textbox', { name: 'RJ queue objective' }).inputValue(), 'A newer unsent draft')
    assert.deepEqual(writes, expectedGuidance)
    assert.deepEqual(errors, [])
  })
}

test('an older success cannot clear a newer failed snapshot warning or invalidate its accepted action', { timeout: 15000 }, async t => {
  const started = deferred(), release = deferred()
  t.after(() => release.resolve())
  const { page, snapshot, writes, errors } = await fixture(t, async ({ sequence, route }) => {
    if (sequence === 2) { started.resolve(); await release.promise }
    if (sequence === 3) { await route.fulfill({ status: 503, json: { error: 'NEW_SNAPSHOT_FAILURE' } }); return true }
    return false
  })
  await page.clock.runFor(1100); await started.promise
  await sendGuidance(page)
  await page.locator('.connection-alert').filter({ hasText: 'new snapshot failure' }).waitFor()
  await page.locator('.dock-result').waitFor()
  release.resolve()
  await page.clock.runFor(200)
  assert.equal(await page.locator('.connection-alert').count(), 1)
  await snapshot(1)
  assert.match(await page.locator('.dock-result').textContent(), /Sent/)
  assert.match(await page.locator('.dock-result').textContent(), /Do not resend/)
  assert.deepEqual(writes, expectedGuidance)
  assert.deepEqual(errors, [])
})

test('a superseded post-action read uses the confirmed newer snapshot without reporting the accepted send as stale', { timeout: 15000 }, async t => {
  const started = deferred(), release = deferred()
  t.after(() => release.resolve())
  const { page, snapshot, writes, errors } = await fixture(t, async ({ sequence, route }) => {
    if (sequence !== 2) return false
    started.resolve(); await release.promise
    await route.fulfill({ status: 503, json: { error: 'SUPERSEDED_SNAPSHOT_FAILURE' } }); return true
  })
  await sendGuidance(page); await started.promise
  await page.clock.runFor(1100)
  await snapshot(3)
  release.resolve()
  await page.locator('.dock-result').waitFor()
  assert.match(await page.locator('.dock-result').textContent(), /Sent/)
  assert.doesNotMatch(await page.locator('.dock-result').textContent(), /failed|stale|could not/i)
  assert.equal(await page.locator('.connection-alert').count(), 0)
  assert.deepEqual(writes, expectedGuidance)
  assert.deepEqual(errors, [])
})

test('a superseded action refresh leaves freshness unconfirmed while a newer read is still pending', { timeout: 15000 }, async t => {
  const oldStarted = deferred(), oldRelease = deferred(), newStarted = deferred(), newRelease = deferred()
  t.after(() => { oldRelease.resolve(); newRelease.resolve() })
  const { page, snapshot, writes, errors } = await fixture(t, async ({ sequence }) => {
    if (sequence === 2) { oldStarted.resolve(); await oldRelease.promise }
    if (sequence === 3) { newStarted.resolve(); await newRelease.promise }
    return false
  })
  await sendGuidance(page); await oldStarted.promise
  await page.clock.runFor(1100); await newStarted.promise
  oldRelease.resolve()
  await page.locator('.dock-result').waitFor()
  await snapshot(1)
  assert.match(await page.locator('.dock-result').textContent(), /Sent/)
  assert.match(await page.locator('.dock-result').textContent(), /could not be confirmed/)
  assert.doesNotMatch(await page.locator('.dock-result').textContent(), /refresh failed/)
  assert.equal(await page.locator('.connection-alert').count(), 0, 'pending is not a connection error')
  newRelease.resolve()
  await snapshot(3)
  assert.deepEqual(writes, expectedGuidance)
  assert.deepEqual(errors, [])
  await page.screenshot({ path: '/tmp/chimera-refresh-order-desktop.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  const dismiss = page.getByRole('button', { name: 'Dismiss result', exact: true })
  await dismiss.scrollIntoViewIfNeeded()
  const bounds = await dismiss.boundingBox()
  assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 844, 'accepted-result dismissal must remain reachable on mobile')
  await page.screenshot({ path: '/tmp/chimera-refresh-order-mobile.png' })
  assert.equal(await page.locator('vite-error-overlay').count(), 0)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await dismiss.click()
  assert.equal(await page.locator('.dock-result').count(), 0)
  assert.deepEqual(writes, expectedGuidance)
})
