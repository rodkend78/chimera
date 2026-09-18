import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'

test('sidebar color cues preserve navigation, focus visibility, and mobile access', { timeout: 30000 }, async () => {
  // Browser plugin absent: render the real app with Playwright and fixture APIs.
  const server = await createServer({ configFile: new URL('../app/vite.config.js', import.meta.url).pathname,
    server: { host: '127.0.0.1', port: 0, hmr: false, proxy: {} } })
  await server.listen()
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
  const errors = []
  const state = {
    agent: { id: 'ceo', name: 'RJ', status: 'Idle' }, controller: { type: 'agent', id: 'ceo' }, suspended: false,
    browser: { running: true, tabs: [] }, activity: [], recentEvents: [], decisions: [], audit: { valid: true },
    models: { selected: { providerId: 'fixture', model: 'fixture' }, providers: [] }, auth: { codex: { connected: true } },
    agents: { main: { agentId: 'ceo', displayName: 'RJ', access: { profileId: 'sandbox', description: 'Bounded sandbox', network: 'denied' } }, accessProfiles: [{ profileId: 'sandbox', label: 'Sandbox' }], specialists: [] }, conversations: { channels: [], messages: [] }, tasks: [],
    projects: { projects: [], sessions: [], leases: [] },
  }
  try {
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    await page.routeWebSocket('**/api/browser/stream', socket => socket.onMessage(() => {}))
    await page.route('**/api/**', route => route.fulfill({ json: new URL(route.request().url()).pathname === '/api/state'
      ? state : { csrfToken: 'fixture', expiresAt: new Date(Date.now() + 60000).toISOString() } }))
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`)
    assert.equal(await page.title(), 'Chimera Browser Workspace')
    const nav = page.getByRole('navigation', { name: 'Primary navigation' })
    await nav.getByRole('button', { name: 'Browser', exact: true }).waitFor()
    await nav.getByRole('button', { name: 'More tools', exact: true }).click()
    const sections = ['Work', 'Projects', 'Team', 'Browser', 'Settings', 'Clients', 'Media', 'Workers', 'Activity', 'Decisions']
    assert.deepEqual(await nav.locator('button[data-section]').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label'))), sections)
    const colors = await nav.locator('button[data-section] svg').evaluateAll(icons => icons.map(icon => getComputedStyle(icon).color))
    assert.ok(new Set(colors).size >= 9, 'Section icons retain recognizable color cues')
    assert.notEqual(await page.locator('.wordmark').evaluate(el => getComputedStyle(el).filter), 'none', 'Brand glow must be rendered, not just a class name')
    await nav.getByRole('button', { name: 'Projects', exact: true }).click()
    assert.equal(await nav.getByRole('button', { name: 'Projects', exact: true }).getAttribute('aria-current'), 'page')
    await page.getByRole('heading', { name: 'Projects', exact: true }).waitFor()
    await page.keyboard.press('Tab')
    await nav.getByRole('button', { name: 'Team', exact: true }).focus()
    assert.notEqual(await nav.getByRole('button', { name: 'Team', exact: true }).evaluate(el => getComputedStyle(el).outlineStyle), 'none')
    await page.keyboard.press('Enter')
    await page.getByRole('heading', { name: 'Your team', exact: true }).waitFor()
    await page.screenshot({ path: '/tmp/chimera-sidebar-desktop.png' })
    await page.locator('.sidebar').screenshot({ path: '/tmp/chimera-sidebar-detail.png' })
    for (const width of [320, 375, 390, 768, 1440]) {
      const height = width < 768 ? 844 : 1000
      await page.setViewportSize({ width, height })
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      for (const button of await nav.locator('button[data-section]').all()) {
        const box = await button.boundingBox()
        assert.ok(box && box.width >= 40 && box.height >= 44 && box.x >= 0 && box.y >= 0 && box.x + box.width <= width + 1 && box.y + box.height <= height + 1,
          JSON.stringify({ width, section: await button.getAttribute('aria-label'), box }))
        assert.ok(await button.evaluate(el => {
          const r = el.getBoundingClientRect()
          return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
        }), 'Navigation must not be covered by another region')
        await button.focus()
        assert.notEqual(await button.evaluate(el => getComputedStyle(el).outlineStyle), 'none')
        await page.keyboard.press('Enter')
        assert.equal(await button.getAttribute('aria-current'), 'page')
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    }
    await page.setViewportSize({ width: 390, height: 844 })
    await nav.getByRole('button', { name: 'Projects', exact: true }).click()
    await page.getByRole('heading', { name: 'Projects', exact: true }).waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await page.screenshot({ path: '/tmp/chimera-sidebar-mobile.png' })
    assert.equal(await page.locator('vite-error-overlay').count(), 0)
    assert.deepEqual(errors, [])
  } finally { await browser.close(); await server.close() }
})
