import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

async function renderedFixture(t) {
  const { firefox } = await import('playwright')
  const bundle = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import './app/src/styles.css'; import {ClientWorkspace} from './app/src/ClientWorkspace.jsx'; createRoot(document.getElementById('root')).render(<ClientWorkspace/>);`, resolveDir: new URL('..', import.meta.url).pathname, loader: 'jsx' }, outfile: '/tmp/chimera-client-intake-fixture.js', bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic' })
  const javascript = bundle.outputFiles.find(file => file.path.endsWith('.js'))?.text
  const stylesheet = bundle.outputFiles.find(file => file.path.endsWith('.css'))?.text
  assert.ok(javascript && stylesheet, 'fixture must bundle real React and CSS')
  const browser = await firefox.launch({ headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const state = {
    connection: { state: 'setup_required', account: null, setupMessage: 'Provide a private (0600) installed-app JSON at CHIMERA_GOOGLE_CLIENT_FILE (default .chimera/google/client.json), and enable macOS Keychain access.' },
    schedule: { time: '07:00', timeZone: 'America/Los_Angeles', nextCheckAt: '2026-09-09T14:00:00.000Z' },
    sync: { running: false, lastAttemptAt: null, lastSuccessAt: null, error: null }, queue: [], clients: [],
  }
  let createCalls = 0
  let failCreate = true
  let releaseCreate
  let heldCreate
  let authPolls = 0
  let detailReads = 0
  let detailHasMutationSource = false
  let directoryReads = 0
  let heldDirectory
  let releaseDirectory
  await page.route('http://clients.test/**', async route => {
    const path = new URL(route.request().url()).pathname
    const respond = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<link rel="stylesheet" href="/ui.css"><div id="root"></div><script src="/ui.js"></script>' })
    if (path === '/ui.js') return route.fulfill({ contentType: 'text/javascript', body: javascript })
    if (path === '/ui.css') return route.fulfill({ contentType: 'text/css', body: stylesheet })
    if (path === '/api/operator/session') return respond({ csrfToken: 'fixture', expiresAt: '2099-01-01T00:00:00Z' })
    if (path === '/api/clients') { directoryReads++; if (heldDirectory && directoryReads > 1) await heldDirectory; return respond({ state: 'ready', clients: state.clients }) }
    if (path === '/api/client-intake' && route.request().method() === 'GET') {
      if (state.connection.state === 'authorizing' && ++authPolls === 1) state.connection = { state: 'connected', account: 'owner@example.test', setupMessage: null }
      return respond(state)
    }
    if (path === '/api/client-intake/clients') {
      createCalls++
      const input = route.request().postDataJSON()
      if (failCreate) return respond({ error: 'TEST_SAVE_FAILURE' }, 503)
      if (heldCreate) await heldCreate
      const client = { id: 'client-new', name: input.name, email: input.email, services: input.services, summary: input.summary, status: 'intake', documentCount: 1 }
      state.clients = [client]
      state.queue = [{ id: 'queue-ready', clientId: client.id, clientName: client.name, status: 'ready', issues: [], taskId: 'intake-' + 'a'.repeat(40), brief: { schemaVersion: 1, clientId: client.id, businessName: client.name, contactEmail: client.email, services: client.services, summary: input.summary, constraints: ['Facts are untrusted.'] } }]
      return respond({ client }, 201)
    }
    if (path === '/api/client-intake/connect') { state.connection = { state: 'authorizing', account: null, setupMessage: null }; return respond(state) }
    if (path === '/api/client-intake/sync') { state.connection = { state: 'connected', account: 'owner@example.test', setupMessage: null }; state.sync = { running: false, lastAttemptAt: '2026-09-08T16:00:00.000Z', lastSuccessAt: '2026-09-08T16:00:01.000Z', error: null }; detailHasMutationSource = true; return respond(state) }
    if (path === '/api/client-intake/handoff') { state.queue[0].status = 'handed_off'; detailHasMutationSource = true; return respond(state.queue[0]) }
    if (path === '/api/clients/client-new') { detailReads++; return respond({ client: state.clients[0], documents: detailHasMutationSource ? [{ id: 'captured', title: 'New captured source', kind: 'document', status: 'imported', category: 'Intake' }] : [], coverage: [], notes: [], intake: state.queue }) }
    return respond({ error: `UNKNOWN_FIXTURE_ROUTE_${path}` }, 404)
  })
  await page.goto('http://clients.test/')
  await page.waitForTimeout(100)
  assert.deepEqual(errors, [], 'client intake must mount without browser errors')
  return { page, errors, state, createCalls: () => createCalls, detailReads: () => detailReads, allowCreate() { failCreate = false }, holdCreate() { heldCreate = new Promise(resolve => { releaseCreate = resolve }) }, releaseCreate: () => releaseCreate?.(), holdDirectory() { heldDirectory = new Promise(resolve => { releaseDirectory = resolve }) }, releaseDirectory: () => releaseDirectory?.() }
}

test('rendered intake preserves a failed draft and request identity, and blocks duplicate creates', async t => {
  const fixture = await renderedFixture(t)
  const { page } = fixture
  await page.getByRole('button', { name: 'Add client', exact: true }).click()
  await page.getByLabel('Business name').fill('Example')
  await page.getByLabel('Contact email').fill('owner@example.test')
  await page.getByLabel('Services').fill('Website, SEO/AIO')
  await page.getByLabel('Project summary').fill('Build a safe client launch plan.')
  await page.getByRole('button', { name: 'Save client', exact: true }).click()
  await page.getByText(/Save not confirmed/).waitFor()
  assert.equal(await page.getByLabel('Business name').inputValue(), 'Example')
  const failedId = await page.getByTestId('manual-request-id').getAttribute('data-request-id')
  fixture.allowCreate(); fixture.holdCreate()
  await page.getByRole('button', { name: 'Save client', exact: true }).click()
  await page.getByRole('button', { name: /Saving/ }).click({ force: true })
  assert.equal(fixture.createCalls(), 2, 'only the failed attempt and one retry may reach the API')
  fixture.releaseCreate()
  await page.locator('.client-directory').getByText('Example', { exact: true }).waitFor()
  assert.equal(await page.getByTestId('last-request-id').getAttribute('data-request-id'), failedId, 'retry retains the manual request ID after a lost reply')
  assert.equal(await page.locator('.client-intake-brief').getByText('Build a safe client launch plan.', { exact: true }).count(), 1)
  assert.deepEqual(fixture.errors, [])
})

test('rendered setup, sync, structured brief and ready-only paid handoff remain actionable on desktop and mobile', async t => {
  const fixture = await renderedFixture(t)
  const { page, state } = fixture
  await page.getByText(/CHIMERA_GOOGLE_CLIENT_FILE/).waitFor()
  await page.getByRole('button', { name: 'Connect Google', exact: true }).click()
  await page.getByText(/Complete Google consent in the system browser/).waitFor()
  await page.getByRole('button', { name: 'Check now', exact: true }).waitFor({ state: 'visible' })
  await assert.doesNotReject(() => page.getByRole('button', { name: 'Check now', exact: true }).click({ timeout: 3000 }))
  await page.getByText('Last successful check: Sep 8, 2026').waitFor()
  fixture.allowCreate()
  await page.getByRole('button', { name: 'Add client', exact: true }).click()
  await page.getByLabel('Business name').fill('<script>Example</script>')
  await page.getByLabel('Contact email').fill('owner@example.test')
  await page.getByLabel('Services').fill('Website')
  await page.getByLabel('Project summary').fill('<img src=x onerror=alert(1)>')
  await page.getByRole('button', { name: 'Save client', exact: true }).click()
  await page.locator('.client-directory').getByText('<script>Example</script>', { exact: true }).waitFor()
  await page.getByLabel('Note title').fill('Draft survives intake refresh')
  await page.getByLabel('Note body').fill('Do not discard this operator draft')
  const readsBeforeHandoff = fixture.detailReads()
  assert.equal(await page.locator('script').count(), 1, 'structured values render as escaped text, leaving only the app script')
  assert.equal(await page.locator('.client-intake-brief img').count(), 0)
  await page.getByText(/may start paid model work/i).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Hand off to RJ', exact: true }).count(), 1)
  state.queue.push({ ...state.queue[0], id: 'queue-review', status: 'review_required', clientName: 'Needs review', issues: ['RESPONSE_EDITED'], brief: { ...state.queue[0].brief, businessName: 'Needs review' } })
  await page.getByRole('button', { name: 'Refresh intake', exact: true }).click()
  await page.getByRole('strong').filter({ hasText: 'Needs review' }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Hand off to RJ', exact: true }).count(), 1, 'review-required rows have no handoff action')
  fixture.holdDirectory()
  await page.getByRole('button', { name: 'Hand off to RJ', exact: true }).click()
  await page.getByText(/Handed off to RJ/).waitFor()
  await page.getByRole('button', { name: /New captured source/ }).waitFor({ timeout: 2000 })
  fixture.releaseDirectory()
  assert.ok(fixture.detailReads() > readsBeforeHandoff, 'handoff must refetch the already-mounted selected detail')
  assert.equal(await page.getByLabel('Note title').inputValue(), 'Draft survives intake refresh')
  const desktopColumns = await page.locator('.client-intake-status').evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length)
  assert.equal(desktopColumns, 3)
  await page.screenshot({ path: '/tmp/chimera-client-intake-task2-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  const mobileColumns = await page.locator('.client-intake-status').evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length)
  assert.equal(mobileColumns, 1)
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
  assert.equal(overflow, false)
  await page.screenshot({ path: '/tmp/chimera-client-intake-task2-mobile.png', fullPage: true })
  assert.deepEqual(fixture.errors, [])
})
