import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('companion renders explicit setup/pair/share/revoke and failure states at desktop and mobile sizes', { timeout: 45000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'account-companion-ui-'))
  const server = await createServer({ configFile: new URL('../app/vite.config.js', import.meta.url).pathname,
    cacheDir: join(directory, 'vite-cache'),
    server: { host: '127.0.0.1', port: 0, hmr: false, proxy: {} },
    plugins: [{ name: 'companion-fixture', configureServer(server) { server.middlewares.use('/companion-fixture', async (_request, response) => {
      response.setHeader('content-type', 'text/html')
      response.end(await server.transformIndexHtml('/companion-fixture', '<html><body><div id="root"></div><script type="module">import React from "react"; import {createRoot} from "react-dom/client"; import {AccountCompanion} from "/src/AccountCompanion.jsx"; import "/src/account-browser.css"; createRoot(document.getElementById("root")).render(React.createElement(AccountCompanion));</script></body></html>'))
    }) } }] })
  await server.listen()
  const browser = await chromium.launch({ headless: true })
  t.after(async () => { await browser.close(); await server.close() })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.setDefaultTimeout(7000)
  page.on('pageerror', error => console.log('Fixture page error:', error.message))
  const calls = []; let failure = false
  let state = { status: 'not-installed', pendingPairs: [], profiles: [], leases: [] }
  await page.route('**/api/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname
    if (path === '/api/operator/session') return route.fulfill({ json: { csrfToken: 'fixture-csrf' } })
    calls.push({ path, method: req.method(), body: req.postData() ? req.postDataJSON() : null, csrf: req.headers()['x-chimera-csrf'] })
    if (failure) return route.fulfill({ status: 409, json: { error: 'ACCOUNT_COMPANION_OPERATION_UNCONFIRMED' } })
    if (path.endsWith('/pair/approve')) state.pendingPairs = state.pendingPairs.map(pair => pair.pairingId === req.postDataJSON().pairingId ? { ...pair, approved: true } : pair)
    if (path.endsWith('/lease/revoke')) state.leases = [{ ...state.leases[0], status: 'human' }]
    if (path.endsWith('/pair/revoke')) state.profiles = [{ profileId: 'fixture-profile', status: 'disconnected' }]
    return route.fulfill({ json: state })
  })
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/companion-fixture`)
  await page.getByText('Companion not installed', { exact: true }).waitFor()
  await page.screenshot({ path: join(directory, 'not-installed.png'), fullPage: true })
  state = { status: 'available', pendingPairs: ['other-pair', 'fixture-pair'].map(pairingId => ({ pairingId, profileId: 'fixture-profile', approved: false, expiresAt: Date.now() + 120000 })), profiles: [], leases: [] }
  await page.getByRole('button', { name: 'Refresh sharing' }).click()
  await page.getByText('Pairing ID: fixture-pair', { exact: true }).waitFor()
  await page.getByText('Pairing ID: other-pair', { exact: true }).waitFor()
  const popup = await browser.newPage({ viewport: { width: 390, height: 844 } })
  await popup.route('https://fixture.example/**', async route => {
    const file = new URL(route.request().url()).pathname.slice(1)
    if (!['popup.html', 'popup.js', 'popup.css'].includes(file)) return route.abort()
    return route.fulfill({ body: await readFile(new URL(`../extensions/account-browser/${file}`, import.meta.url)), contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' })
  })
  await popup.addInitScript(() => { globalThis.chrome = { runtime: { sendMessage: async () => ({ status: 'Pairing', pairing: { pairingId: 'fixture-pair', challenge: 'local-only-challenge' }, leases: [] }) } } })
  await popup.goto('https://fixture.example/popup.html')
  await popup.locator('#pairing-id').getByText('fixture-pair', { exact: true }).waitFor()
  assert.match(await popup.locator('#challenge-panel').textContent(), /Pairing ID/)
  const pairingId = await popup.locator('#pairing-id').textContent()
  assert.equal(await page.getByText(`Pairing ID: ${pairingId}`, { exact: true }).count(), 1)
  assert.doesNotMatch(await page.locator('body').textContent(), /local-only-challenge/)
  await popup.screenshot({ path: join(directory, 'pair-popup-mobile.png'), fullPage: true })
  await popup.setViewportSize({ width: 600, height: 900 })
  await popup.screenshot({ path: join(directory, 'pair-popup-desktop.png'), fullPage: true })
  await popup.close()
  await page.locator('article').filter({ hasText: 'Pairing ID: fixture-pair' }).getByRole('button', { name: 'Approve pairing' }).click()
  assert.deepEqual(calls.find(call => call.path.endsWith('/pair/approve')).body, { pairingId: 'fixture-pair' })
  await page.getByText('Approval recorded. Complete pairing in Chrome.', { exact: true }).waitFor()
  await page.screenshot({ path: join(directory, 'pair.png'), fullPage: true })
  state = { status: 'available', pendingPairs: [], profiles: [{ profileId: 'fixture-profile', status: 'paired' }], leases: [] }
  await page.getByRole('button', { name: 'Refresh sharing' }).click()
  await page.getByText('Paired · No shared tabs', { exact: true }).waitFor()
  state.leases = [{ leaseId: 'fixture-lease', profileId: 'fixture-profile', taskId: 'fixture-task', agentId: 'ace', origin: 'https://example.com', expiresAt: Date.now() + 300000, status: 'active' }]
  await page.getByRole('button', { name: 'Refresh sharing' }).click()
  await page.getByText('Shared read-only', { exact: true }).waitFor()
  await page.screenshot({ path: join(directory, 'shared-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: join(directory, 'shared-mobile.png'), fullPage: true })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true)
  failure = true
  await page.getByRole('button', { name: 'Stop sharing' }).click()
  await page.getByRole('alert').waitFor()
  assert.equal(await page.getByText('Shared read-only', { exact: true }).count(), 1)
  await page.screenshot({ path: join(directory, 'error.png'), fullPage: true })
  failure = false
  await page.getByRole('button', { name: 'Stop sharing' }).click()
  await page.getByText('Stopped', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Revoke pairing' }).click()
  await page.getByText('Disconnected', { exact: true }).waitFor()
  for (const call of calls.filter(call => call.method === 'POST')) assert.equal(call.csrf, 'fixture-csrf')
  assert.deepEqual(calls.find(call => call.path.endsWith('/lease/revoke')).body, { leaseId: 'fixture-lease' })
  assert.deepEqual(calls.find(call => call.path.endsWith('/pair/revoke')).body, { profileId: 'fixture-profile' })
  assert.equal(await page.getByRole('button', { name: /Focus/ }).count(), 0)
  console.log(`Rendered screenshots: ${directory}`)
})
