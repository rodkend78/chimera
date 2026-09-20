import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'

async function fixture(t, configure = () => {}, handle = async () => false) {
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
    draftScope: { schema: 'chimera.draft-scope.v1', workspaceId: 'target-fixture', operatorId: 'operator-fixture' },
    browser: { running: true, tabs: [] }, activity: [], recentEvents: [], decisions: [], audit: { valid: true },
    models: { selected: { providerId: 'fixture', model: 'fixture' }, providers: [] }, auth: { codex: { connected: true, status: 'connected' } },
    agents: { main: { agentId: 'ceo', displayName: 'RJ', role: 'CEO' }, specialists: [{ agentId: 'ace', displayName: 'Ace', role: 'Specialist' }] },
    tasks: [{ taskId: 'alpha', objective: 'Alpha website review', status: 'running', destinationRevision: 4 }, { taskId: 'beta', objective: 'Beta export review', status: 'queued', destinationRevision: 9 }],
    teamMessaging: { tasks: [{ taskId: 'alpha', participants: ['ceo', 'ace'], eligibleRecipients: ['ace'], deliveries: [] }, { taskId: 'beta', participants: ['ceo', 'ace'], eligibleRecipients: ['ace'], deliveries: [] }] },
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
    const body = route.request().method() === 'POST' ? route.request().postDataJSON() : null
    if (body) calls.push({ path, body })
    if (path === '/api/operator/session') return route.fulfill({ json: { csrfToken: 'fixture', expiresAt: new Date(Date.now() + 60000).toISOString() } })
    if (path === '/api/state') return route.fulfill({ json: state })
    if (await handle({ path, body, route, state, calls })) return
    return route.fulfill({ json: {} })
  })
  const url = `http://127.0.0.1:${server.httpServer.address().port}/`
  await page.goto(url)
  assert.equal(page.url(), url)
  assert.equal(await page.title(), 'Chimera Browser Workspace')
  await page.getByRole('button', { name: 'Work', exact: true }).click()
  return { page, state, calls, errors, composer: page.getByRole('region', { name: 'Conversation composer', exact: true }) }
}

test('selected task room binds the composer without auto-sending and preserves other drafts', { timeout: 20000 }, async t => {
  const { page, composer, calls, errors } = await fixture(t)
  await composer.getByRole('combobox', { name: 'Conversation action', exact: true }).selectOption('guidance')
  await composer.getByRole('combobox', { name: 'Conversation task', exact: true }).selectOption('alpha')
  await composer.getByRole('textbox', { name: 'Task guidance', exact: true }).fill('Guide alpha, not the viewed beta room')
  await page.getByLabel('Work history', { exact: true }).getByRole('button', { name: 'Beta export review Task room', exact: true }).click()
  assert.equal(await composer.getByRole('combobox', { name: 'Conversation task', exact: true }).inputValue(), 'beta')
  assert.equal(await composer.getByRole('textbox', { name: 'Task guidance', exact: true }).inputValue(), '')
  await composer.getByRole('combobox', { name: 'Conversation task', exact: true }).selectOption('alpha')
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="Task guidance"]')?.value === 'Guide alpha, not the viewed beta room')
  assert.equal(await composer.getByRole('textbox', { name: 'Task guidance', exact: true }).inputValue(), 'Guide alpha, not the viewed beta room')
  assert.deepEqual(calls, [])
  assert.deepEqual(errors, [])
})

test('Start work preserves the selected specialist and explicit queue intent', { timeout: 20000 }, async t => {
  let requestBody
  const { composer, calls, errors } = await fixture(t, () => {}, async ({ path, body, route }) => {
    if (path !== '/api/tasks') return false
    requestBody = body
    await route.fulfill({ json: { taskId: 'task-fixture', receipt: { requestId: body.requestId, status: 'accepted', operation: 'new-task' } } })
    return true
  })
  await composer.getByRole('combobox', { name: 'Conversation action', exact: true }).selectOption('new-task')
  await composer.getByRole('combobox', { name: 'Conversation agent', exact: true }).selectOption('ace')
  await composer.getByRole('textbox', { name: 'New task objective', exact: true }).fill('Inspect only the selected workspace')
  await composer.getByRole('button', { name: 'Start work', exact: true }).click()
  await composer.getByRole('status').filter({ hasText: /Request accepted/ }).waitFor()
  assert.equal(requestBody.requestedSpecialistAgentId, 'ace')
  assert.equal(requestBody.queue, true)
  assert.deepEqual(Object.keys(requestBody).sort(), ['budget', 'conversationId', 'objective', 'queue', 'requestId', 'requestedSpecialistAgentId', 'requirements'].sort())
  assert.deepEqual(requestBody.requirements, { priorityPreset: 'balanced' })
  assert.equal(calls.filter(call => call.path === '/api/tasks').length, 1)
  assert.deepEqual(errors, [])
})

test('addressed guidance uses the selected task, validated mention and destination revision', { timeout: 20000 }, async t => {
  let requestBody
  const { composer, calls, errors } = await fixture(t, () => {}, async ({ path, body, route }) => {
    if (path !== '/api/tasks/message') return false
    requestBody = body
    await route.fulfill({ json: { taskId: body.taskId, destinationRevision: body.expectedDestinationRevision, message: { messageId: 'message-fixture' }, receipt: { requestId: body.requestId, status: 'accepted', operation: 'task-message' } } })
    return true
  })
  await composer.getByRole('combobox', { name: 'Conversation action', exact: true }).selectOption('guidance')
  await composer.getByRole('combobox', { name: 'Conversation task', exact: true }).selectOption('beta')
  await composer.getByRole('textbox', { name: 'Mention teammates', exact: true }).fill('Ace')
  await composer.getByRole('option', { name: '@Ace · ace', exact: true }).click()
  await composer.getByRole('textbox', { name: 'Task guidance', exact: true }).fill('Ace: inspect the beta export')
  await composer.getByRole('button', { name: 'Guide task', exact: true }).click()
  await composer.getByRole('status').filter({ hasText: /Request accepted/ }).waitFor()
  assert.equal(requestBody.taskId, 'beta')
  assert.deepEqual(requestBody.recipientAgentIds, ['ace'])
  assert.equal(requestBody.expectedDestinationRevision, 9)
  assert.equal(requestBody.content, 'Ace: inspect the beta export')
  assert.equal(calls.filter(call => call.path === '/api/tasks/message').length, 1)
  assert.deepEqual(errors, [])
})

test('target, editor and Send remain reachable without horizontal overflow on desktop and mobile', { timeout: 20000 }, async t => {
  const { page, composer, calls, errors } = await fixture(t, state => { state.tasks[0].objective = 'Inspect the export delivery boundary '.repeat(12) })
  for (const [width, height] of [[1440, 1000], [768, 900], [390, 844]]) {
    await page.setViewportSize({ width, height })
    const bounds = await page.evaluate(() => {
      const root = document.querySelector('.conversation-composer')
      const editor = root?.querySelector('textarea')
      const send = root?.querySelector('button[type="submit"]')
      const visible = element => { const rect = element?.getBoundingClientRect(); return rect && rect.width > 0 && rect.height > 0 && rect.right <= innerWidth && rect.bottom <= innerHeight }
      return { root: visible(root), editor: visible(editor), send: visible(send), horizontalOverflow: document.documentElement.scrollWidth > innerWidth }
    })
    assert.equal(bounds.root, true)
    assert.equal(bounds.editor, true)
    assert.equal(bounds.send, true)
    assert.equal(bounds.horizontalOverflow, false)
  }
  assert.deepEqual(calls, [])
  assert.deepEqual(errors, [])
})
