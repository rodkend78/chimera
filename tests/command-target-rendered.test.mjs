import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'

async function fixture(t, configure = () => {}) {
  // Browser plugin unavailable. Real React/client with isolated HTTP/WS
  // boundaries: no operator credentials, provider calls or cloud writes.
  const server = await createServer({ configFile: new URL('../app/vite.config.js', import.meta.url).pathname,
    server: { host: '127.0.0.1', port: 0, hmr: false, proxy: {} } })
  await server.listen()
  const browser = await chromium.launch({ headless: true })
  t.after(async () => { await browser.close(); await server.close() })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  page.setDefaultTimeout(5000)
  const state = {
    agent: { id: 'ceo', name: 'RJ', status: 'Working' }, controller: { type: 'agent', id: 'ceo' }, suspended: false,
    browser: { running: true, tabs: [] }, activity: [], recentEvents: [], decisions: [], audit: { valid: true },
    models: { selected: { providerId: 'fixture', model: 'fixture' }, providers: [] }, auth: { codex: { connected: true, status: 'connected' } },
    agents: { specialists: [{ agentId: 'ace', displayName: 'Ace' }] },
    tasks: [{ taskId: 'alpha', objective: 'Alpha website review', status: 'running' }, { taskId: 'beta', objective: 'Beta export review', status: 'queued' }],
    teamMessaging: { tasks: [{ taskId: 'beta', participants: ['ceo', 'ace'], eligibleRecipients: ['ace'], deliveries: [] }] },
    conversations: { channels: [
      { conversationId: 'task:alpha', taskId: 'alpha', kind: 'task-room', label: 'Alpha website review', detail: 'Task room' },
      { conversationId: 'task:beta', taskId: 'beta', kind: 'task-room', label: 'Beta export review', detail: 'Task room' },
    ], messages: [] },
  }
  configure(state)
  const calls = [], errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()) })
  await page.routeWebSocket('**/api/browser/stream', socket => socket.onMessage(() => {}))
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/operator/session') return route.fulfill({ json: { csrfToken: 'fixture', expiresAt: new Date(Date.now() + 60000).toISOString() } })
    if (path === '/api/state') return route.fulfill({ json: state })
    if (route.request().method() === 'POST') calls.push({ path, body: route.request().postDataJSON() })
    return route.fulfill({ json: {} })
  })
  const url = `http://127.0.0.1:${server.httpServer.address().port}/`
  await page.goto(url)
  assert.equal(page.url(), url)
  assert.equal(await page.title(), 'Chimera Browser Workspace')
  await page.getByRole('button', { name: 'Work', exact: true }).click()
  return { page, state, calls, errors, target: page.locator('.dock-target'), dock: page.locator('.command-dock') }
}

test('dock target stays global when viewing another room and matches the outgoing guidance', { timeout: 15000 }, async t => {
  // Catches a label derived from the viewed room rather than the actual target.
  const { page, target, calls, errors } = await fixture(t)
  await page.getByLabel('Work history', { exact: true }).getByRole('button', { name: 'Beta export review Task room', exact: true }).click()
  assert.equal(await page.getByRole('combobox', { name: 'Task to control' }).inputValue(), 'beta')
  assert.match(await target.innerText(), /Guide current task.*Alpha website review/)
  await target.locator('summary').click()
  assert.match(await target.innerText(), /alpha/)
  assert.match(await target.innerText(), /independent of the room/)
  await target.locator('summary').click()
  await page.locator('.queue-region').evaluate(element => { element.scrollTop = 0 })
  await page.screenshot({ path: '/tmp/chimera-command-target-context.png' })
  await page.getByRole('textbox', { name: 'RJ queue objective' }).fill('Guide alpha, not the viewed beta room')
  await page.getByRole('button', { name: 'Guide current task', exact: true }).click()
  await page.getByText('Guidance saved for the next safe task boundary', { exact: true }).waitFor()
  assert.deepEqual(calls, [{ path: '/api/tasks/steer', body: { taskId: 'alpha', content: 'Guide alpha, not the viewed beta room' } }])
  await page.getByRole('button', { name: 'Expand decisions rail', exact: true }).click()
  assert.match(await page.getByRole('region', { name: 'Task plan', exact: true }).innerText(), /Global workspace/)
  assert.deepEqual(errors, [])
})

test('queued task behind a completed record is labelled and sent as guidance, not a new objective', { timeout: 15000 }, async t => {
  const { page, target, calls, errors } = await fixture(t, state => { state.tasks[0].status = 'completed' })
  assert.equal(await page.getByRole('textbox', { name: 'RJ queue objective' }).getAttribute('maxlength'), '4096')
  assert.match(await target.innerText(), /Guide queued task.*Beta export review/)
  await page.getByRole('button', { name: 'Expand decisions rail', exact: true }).click()
  assert.match(await page.getByRole('region', { name: 'Task plan', exact: true }).innerText(), /Beta export review/)
  await page.getByRole('textbox', { name: 'RJ queue objective' }).fill('Bound the queued beta review')
  await page.getByRole('button', { name: 'Guide current task', exact: true }).click()
  await page.getByText('Guidance saved for the next safe task boundary', { exact: true }).waitFor()
  assert.deepEqual(calls, [{ path: '/api/tasks/steer', body: { taskId: 'beta', content: 'Bound the queued beta review' } }])
  assert.deepEqual(errors, [])
})

test('addressed task target is explicit and becomes unavailable when that task ends', { timeout: 15000 }, async t => {
  const { page, target, state, calls, errors } = await fixture(t)
  await page.getByLabel('Work history', { exact: true }).getByRole('button', { name: 'Beta export review Task room', exact: true }).click()
  await page.getByRole('checkbox', { name: '@Ace' }).check()
  assert.match(await target.innerText(), /Addressed guidance.*Beta export review/)
  await target.locator('summary').click()
  assert.match(await target.innerText(), /beta/)
  await target.locator('summary').click()
  await page.getByRole('textbox', { name: 'RJ queue objective' }).fill('Ace: inspect the beta export')
  await page.getByRole('button', { name: 'Send task guidance', exact: true }).click()
  await page.getByRole('textbox', { name: 'RJ queue objective' }).waitFor({ state: 'visible' })
  await page.waitForFunction(() => document.querySelector('[aria-label="RJ queue objective"]').value === '')
  assert.deepEqual(calls, [{ path: '/api/tasks/message', body: { taskId: 'beta', recipientAgentIds: ['ace'], content: 'Ace: inspect the beta export' } }])
  await page.getByRole('button', { name: 'Dismiss result', exact: true }).click()
  state.tasks[1].status = 'completed'
  await target.getByText(/Guidance unavailable/).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Send task guidance', exact: true }).isDisabled(), true)
  state.tasks = [state.tasks[0]]
  await target.locator('summary').filter({ hasText: 'Task context unavailable' }).waitFor()
  await target.locator('summary').focus()
  await page.keyboard.press('Enter')
  assert.equal(await target.getAttribute('open'), '')
  assert.match(await target.innerText(), /Task ID: beta/)
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: 'General guidance', exact: true }).click()
  assert.match(await target.innerText(), /Guide current task.*Alpha website review/)
  assert.equal(calls.length, 1, 'changing context never submits work')
  assert.deepEqual(errors, [])
})

test('idle dock identifies a new objective, while the rail labels historical work honestly', { timeout: 15000 }, async t => {
  const { page, target, calls, errors } = await fixture(t, state => { state.tasks.forEach(task => { task.status = 'completed' }) })
  assert.match(await target.innerText(), /New objective.*RJ/)
  await page.getByRole('button', { name: 'Expand decisions rail', exact: true }).click()
  assert.match(await page.getByRole('region', { name: 'Task plan', exact: true }).innerText(), /Latest recorded task/i)
  await page.getByRole('textbox', { name: 'RJ queue objective' }).fill('Review the next project')
  await page.getByRole('button', { name: 'Queue objective', exact: true }).click()
  await page.getByText('Task queued for RJ', { exact: true }).waitFor()
  assert.deepEqual(calls, [{ path: '/api/conversations/messages', body: { recipientAgentId: 'ceo', content: 'Review the next project' } }])
  assert.deepEqual(errors, [])
})

test('target details remain readable and controls reachable with a long objective on desktop and mobile', { timeout: 20000 }, async t => {
  const objective = 'Inspect the export delivery boundary '.repeat(12) + '<script>not executable</script>'
  const { page, target, errors, calls } = await fixture(t, state => { state.tasks[0].objective = objective })
  for (const [name, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]]) {
    await page.setViewportSize({ width, height })
    await target.locator('summary').click()
    assert.equal(await target.locator('.dock-target-detail strong').innerText(), objective)
    assert.equal(await target.locator('script').count(), 0)
    const details = await target.locator('.dock-target-detail').boundingBox()
    assert.ok(details.x >= 0 && details.x + details.width <= width && details.y >= 0 && details.y + details.height <= height)
    await page.screenshot({ path: `/tmp/chimera-command-target-${name}.png` })
    await target.locator('.dock-target-detail p').scrollIntoViewIfNeeded()
    const explanation = await target.locator('.dock-target-detail p').boundingBox()
    assert.ok(explanation.y >= details.y && explanation.y + explanation.height <= details.y + details.height,
      'full guidance context must be reachable by scrolling the disclosure')
    await target.locator('summary').click()
    await page.getByRole('textbox', { name: 'RJ queue objective' }).fill('Readable target, no submission')
    assert.equal(await page.getByRole('button', { name: 'Guide current task', exact: true }).isEnabled(), true)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    assert.equal(await page.locator('vite-error-overlay').count(), 0)
  }
  assert.deepEqual(calls, [])
  assert.deepEqual(errors, [])
})

test('polling updates the labelled execution target without sending or clearing the draft', { timeout: 15000 }, async t => {
  const { page, target, state, calls, errors } = await fixture(t)
  await page.getByRole('textbox', { name: 'RJ queue objective' }).fill('An unsent draft to review')
  state.tasks[0].status = 'completed'
  await target.getByText(/Guide queued task.*Beta export review/).waitFor()
  assert.equal(await page.getByRole('textbox', { name: 'RJ queue objective' }).inputValue(), 'An unsent draft to review')
  assert.deepEqual(calls, [])
  assert.deepEqual(errors, [])
})
