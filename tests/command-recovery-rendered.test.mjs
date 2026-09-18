import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'

async function fixture(t, handler) {
  // Browser plugin unavailable: real React/client, disposable loopback server
  // and HTTP/WS fixtures. Never contact live agents or metered services.
  const server = await createServer({ configFile: new URL('../app/vite.config.js', import.meta.url).pathname,
    server: { host: '127.0.0.1', port: 0, hmr: false, proxy: {} } })
  await server.listen()
  const browser = await chromium.launch({ headless: true })
  t.after(async () => { await browser.close(); await server.close() })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  page.setDefaultTimeout(4000)
  const state = {
    agent: { id: 'ceo', name: 'RJ', status: 'Working' }, controller: { type: 'agent', id: 'ceo' }, suspended: false,
    browser: { running: true, tabs: [] }, activity: [], recentEvents: [], decisions: [], audit: { valid: true },
    models: { selected: { providerId: 'fixture', model: 'fixture' }, providers: [] }, auth: { codex: { connected: true, status: 'connected' } },
    agents: { specialists: [{ agentId: 'ace', displayName: 'Ace' }, { agentId: 'iris', displayName: 'Iris' }] },
    tasks: [{ taskId: 'alpha', objective: 'Alpha website review', status: 'running' }, { taskId: 'beta', objective: 'Beta export review', status: 'queued' }],
    teamMessaging: { tasks: [{ taskId: 'alpha', participants: ['ceo', 'ace', 'iris'], eligibleRecipients: ['ace', 'iris'], deliveries: [] }] },
    conversations: { channels: [{ conversationId: 'task:alpha', taskId: 'alpha', kind: 'task-room', label: 'Alpha website review', detail: 'Task room' }], messages:
      ['ace', 'iris'].map(id => ({ messageId: `${id}-reply`, conversationId: 'task:alpha', taskId: 'alpha', senderAgentId: id, recipientAgentIds: ['ceo'], role: 'agent', content: `${id} report`, kind: 'structured_result', status: 'completed', createdAt: new Date().toISOString(), provenance: { verification: 'verified' } })) },
  }
  const calls = [], errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (['error', 'warning'].includes(message.type()) && !message.text().includes('503 (Service Unavailable)')) errors.push(message.text()) })
  await page.routeWebSocket('**/api/browser/stream', socket => socket.onMessage(() => {}))
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    const body = route.request().method() === 'POST' ? route.request().postDataJSON() : null
    if (body) calls.push({ path, body })
    if (await handler?.({ route, path, body, state })) return
    if (path === '/api/operator/session') return route.fulfill({ json: { csrfToken: 'fixture', expiresAt: new Date(Date.now() + 60000).toISOString() } })
    if (path === '/api/state') return route.fulfill({ json: state })
    return route.fulfill({ json: {} })
  })
  const url = `http://127.0.0.1:${server.httpServer.address().port}/`
  await page.goto(url)
  assert.equal(page.url(), url); assert.equal(await page.title(), 'Chimera Browser Workspace')
  await page.getByRole('button', { name: 'Work', exact: true }).click()
  return { page, state, calls, errors, input: page.getByRole('textbox', { name: 'RJ queue objective' }), dock: page.locator('.command-dock') }
}

function gate(t) {
  let release, arrive
  const wait = new Promise(resolve => { release = resolve })
  const arrived = new Promise(resolve => { arrive = resolve })
  t.after(() => release())
  return { release, arrive, wait, arrived }
}

test('polling cannot silently send an existing draft to another task; review rebinds without submitting', { timeout: 20000 }, async t => {
  const { page, input, dock, state, calls, errors } = await fixture(t)
  await input.fill('Keep the original draft intact')
  state.tasks[0].status = 'completed'
  await page.locator('.dock-target summary').filter({ hasText: 'Beta export review' }).waitFor()
  await dock.evaluate(form => form.requestSubmit())
  assert.deepEqual(calls, [], 'a changed target must not dispatch the old draft')
  const dialog = page.getByRole('dialog', { name: 'Review draft destination', exact: true })
  await dialog.waitFor()
  assert.match(await dialog.innerText(), /Alpha website review/)
  assert.match(await dialog.innerText(), /Beta export review/)
  await page.screenshot({ path: '/tmp/chimera-draft-destination-desktop.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: '/tmp/chimera-draft-destination-mobile.png' })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await dialog.getByRole('button', { name: 'Keep draft', exact: true }).click()
  assert.equal(await input.inputValue(), 'Keep the original draft intact')
  await page.getByRole('button', { name: 'Review destination', exact: true }).click()
  await dialog.getByRole('button', { name: 'Use this destination', exact: true }).click()
  assert.deepEqual(calls, [], 'confirming the destination is not permission to submit')
  await page.getByRole('button', { name: 'Guide current task', exact: true }).click()
  await page.getByText('Guidance saved for the next safe task boundary', { exact: true }).waitFor()
  assert.deepEqual(calls, [{ path: '/api/tasks/steer', body: { taskId: 'beta', content: 'Keep the original draft intact' } }])
  assert.equal(await page.locator('vite-error-overlay').count(), 0); assert.deepEqual(errors, [])
})

test('destination review cannot approve a different destination that arrives while the dialog is open', { timeout: 15000 }, async t => {
  const { page, input, state, calls, errors } = await fixture(t)
  await input.fill('Review before retargeting')
  state.tasks[0].status = 'completed'
  await page.getByRole('button', { name: 'Review destination', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Review draft destination', exact: true })
  state.tasks[1].status = 'completed'
  await dialog.getByText('The destination changed again. Review the latest destination before continuing.', { exact: true }).waitFor()
  assert.equal(await dialog.getByRole('button', { name: 'Use this destination', exact: true }).isDisabled(), true)
  await dialog.getByRole('button', { name: 'Review latest destination', exact: true }).click()
  assert.match(await dialog.innerText(), /New objective/)
  await dialog.getByRole('button', { name: 'Use this destination', exact: true }).click()
  assert.deepEqual(calls, [])
  assert.equal(await input.inputValue(), 'Review before retargeting')
  assert.deepEqual(errors, [])
})

test('same-turn dock submissions are deduplicated and acceptance preserves a newer draft', { timeout: 15000 }, async t => {
  const pending = gate(t)
  const { page, input, dock, calls, errors } = await fixture(t, async ({ route, path }) => {
    if (path !== '/api/tasks/steer') return false
    pending.arrive(); await pending.wait; await route.fulfill({ json: {} }); return true
  })
  await input.fill('Original guidance')
  await dock.evaluate(form => { form.requestSubmit(); form.requestSubmit() })
  await pending.arrived
  assert.equal(calls.length, 1)
  await input.fill('Newer unsent guidance')
  pending.release()
  await page.getByText('Guidance saved for the next safe task boundary', { exact: true }).waitFor()
  assert.equal(await input.inputValue(), 'Newer unsent guidance')
  assert.deepEqual(calls, [{ path: '/api/tasks/steer', body: { taskId: 'alpha', content: 'Original guidance' } }])
  assert.deepEqual(errors, [])
})

test('late addressed acknowledgement does not clear a newer reply selection', { timeout: 15000 }, async t => {
  const pending = gate(t)
  const { page, input, calls, errors } = await fixture(t, async ({ route, path }) => {
    if (path !== '/api/tasks/message') return false
    pending.arrive(); await pending.wait; await route.fulfill({ json: { acknowledgement: 'Message accepted for the selected participants.' } }); return true
  })
  await page.getByRole('button', { name: 'Reply to Ace', exact: true }).click()
  await input.fill('Reply to Ace only')
  await page.getByRole('button', { name: 'Send task guidance', exact: true }).click()
  await pending.arrived
  await page.getByRole('button', { name: 'Reply to Iris', exact: true }).click()
  pending.release()
  await page.getByText('Message accepted for the selected participants.', { exact: true }).waitFor()
  assert.match(await page.locator('.dock-address').innerText(), /Reply to Iris/)
  assert.equal(await page.getByRole('button', { name: 'Clear reply', exact: true }).count(), 1)
  assert.deepEqual(calls[0].body, { taskId: 'alpha', recipientAgentIds: ['ace'], replyTo: 'ace-reply', content: 'Reply to Ace only' })
  assert.deepEqual(errors, [])
})

test('changed recipients require draft review even on the same task', { timeout: 15000 }, async t => {
  const { page, input, dock, calls, errors } = await fixture(t)
  await page.getByRole('checkbox', { name: '@Ace', exact: true }).check()
  await input.fill('Guidance drafted for Ace')
  await page.getByRole('checkbox', { name: '@Iris', exact: true }).check()
  await dock.evaluate(form => form.requestSubmit())
  assert.deepEqual(calls, [])
  const dialog = page.getByRole('dialog', { name: 'Review draft destination', exact: true })
  await dialog.waitFor()
  assert.match(await dialog.innerText(), /@Ace/); assert.match(await dialog.innerText(), /@Iris/)
  await dialog.getByRole('button', { name: 'Use this destination', exact: true }).click()
  await page.getByRole('button', { name: 'Send task guidance', exact: true }).click()
  await page.locator('.dock-result').waitFor()
  assert.deepEqual(calls[0].body, { taskId: 'alpha', recipientAgentIds: ['ace', 'iris'], content: 'Guidance drafted for Ace' })
  assert.deepEqual(errors, [])
})

test('failed dock send preserves an attributed recovery message and draft without replay', { timeout: 15000 }, async t => {
  const { page, input, state, calls, errors } = await fixture(t, async ({ route, path }) => {
    if (path !== '/api/tasks/steer') return false
    await route.fulfill({ status: 503, json: { error: 'FIXTURE_UNAVAILABLE' } }); return true
  })
  await input.fill('Do not silently retry this')
  await page.getByRole('button', { name: 'Guide current task', exact: true }).click()
  await page.locator('.dock-result').waitFor()
  assert.match(await page.locator('.dock-result').innerText(), /Alpha website review/)
  assert.match(await page.locator('.dock-result').innerText(), /Inspect task history before retrying/)
  await page.getByRole('button', { name: 'Browser', exact: true }).click()
  assert.equal(await input.inputValue(), 'Do not silently retry this')
  assert.equal(await page.locator('.dock-target').getAttribute('open'), null)
  state.tasks[0].status = 'completed'
  await page.locator('.dock-target summary').filter({ hasText: 'Beta export review' }).waitFor()
  assert.equal(await page.locator('.dock-target').getAttribute('open'), null, 'polling must not reopen an old result over the workspace')
  await page.locator('.dock-target summary').click()
  assert.match(await page.locator('.dock-result').innerText(), /Alpha website review/)
  assert.equal(calls.length, 1)
  assert.deepEqual(errors, [])
})

test('acknowledged send with failed state refresh is not presented as a failed send', { timeout: 15000 }, async t => {
  let accepted = false
  const { page, input, calls, errors } = await fixture(t, async ({ route, path }) => {
    if (path === '/api/tasks/steer') { accepted = true; await route.fulfill({ json: {} }); return true }
    if (path === '/api/state' && accepted) { await route.fulfill({ status: 503, json: { error: 'FIXTURE_REFRESH_FAILED' } }); return true }
    return false
  })
  await input.fill('Accepted guidance')
  await page.getByRole('button', { name: 'Guide current task', exact: true }).click()
  await page.locator('.dock-result').waitFor()
  assert.match(await page.locator('.dock-result').innerText(), /Sent/)
  assert.match(await page.locator('.dock-result').innerText(), /workspace state could not be confirmed/)
  assert.equal(await input.inputValue(), '')
  assert.equal(calls.length, 1)
  assert.deepEqual(errors, [])
})

test('command history preserves its original destination and restores the unsent draft on ArrowDown', { timeout: 15000 }, async t => {
  const { page, input, state, calls, errors } = await fixture(t)
  await input.fill('Earlier alpha guidance')
  await page.getByRole('button', { name: 'Guide current task', exact: true }).click()
  await page.getByText('Guidance saved for the next safe task boundary', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Dismiss result', exact: true }).click()
  state.tasks[0].status = 'completed'
  await page.locator('.dock-target summary').filter({ hasText: 'Beta export review' }).waitFor()
  await input.fill('Unsent beta draft')
  await input.press('Home'); await input.press('ArrowUp')
  assert.equal(await input.inputValue(), 'Earlier alpha guidance')
  await page.getByRole('button', { name: 'Review destination', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Review draft destination', exact: true })
  assert.match(await dialog.innerText(), /Alpha website review/)
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
  assert.equal(await input.inputValue(), 'Earlier alpha guidance')
  await input.press('ArrowDown')
  assert.equal(await input.inputValue(), 'Unsent beta draft')
  assert.equal(await page.getByRole('button', { name: 'Guide current task', exact: true }).isEnabled(), true)
  assert.equal(calls.length, 1, 'history navigation must not replay the earlier request')
  assert.deepEqual(errors, [])
})
