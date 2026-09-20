import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'

async function fixture(t, handle = async () => false) {
  const server = await createServer({ configFile: new URL('../app/vite.config.js', import.meta.url).pathname,
    server: { host: '127.0.0.1', port: 0, hmr: false, proxy: {} } })
  await server.listen()
  const browser = await chromium.launch({ headless: true })
  t.after(async () => { await browser.close(); await server.close() })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  page.setDefaultTimeout(5000)
  const state = {
    agent: { id: 'ceo', name: 'RJ', status: 'Working' }, controller: { type: 'agent', id: 'ceo' }, suspended: false,
    draftScope: { schema: 'chimera.draft-scope.v1', workspaceId: 'recovery-fixture', operatorId: 'operator-fixture' },
    browser: { running: true, tabs: [] }, activity: [], recentEvents: [], decisions: [], audit: { valid: true },
    models: { selected: { providerId: 'fixture', model: 'fixture' }, providers: [] }, auth: { codex: { connected: true, status: 'connected' } },
    agents: { main: { agentId: 'ceo', displayName: 'RJ', role: 'CEO' }, specialists: [{ agentId: 'ace', displayName: 'Ace', role: 'Specialist' }, { agentId: 'iris', displayName: 'Iris', role: 'Specialist' }] },
    tasks: [{ taskId: 'alpha', objective: 'Alpha website review', status: 'running', destinationRevision: 4 }, { taskId: 'beta', objective: 'Beta export review', status: 'queued', destinationRevision: 8 }],
    teamMessaging: { tasks: [{ taskId: 'alpha', participants: ['ceo', 'ace', 'iris'], eligibleRecipients: ['ace', 'iris'], deliveries: [] }, { taskId: 'beta', participants: ['ceo', 'ace'], eligibleRecipients: ['ace'], deliveries: [] }] },
    conversations: { channels: [{ conversationId: 'task:alpha', taskId: 'alpha', kind: 'task-room', label: 'Alpha website review', detail: 'Task room' }], messages: [] },
  }
  const calls = [], errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (['error', 'warning'].includes(message.type()) && !message.text().startsWith('Failed to load resource')) errors.push(message.text()) })
  await page.routeWebSocket('**/api/browser/stream', socket => socket.onMessage(() => {}))
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    const body = route.request().method() === 'POST' ? route.request().postDataJSON() : null
    if (body) calls.push({ path, body })
    if (path === '/api/operator/session') return route.fulfill({ json: { csrfToken: 'fixture', expiresAt: '2099-01-01T00:00:00Z' } })
    if (path === '/api/state') return route.fulfill({ json: state })
    if (await handle({ path, body, route, state, calls })) return
    return route.fulfill({ json: {} })
  })
  const url = `http://127.0.0.1:${server.httpServer.address().port}/`
  await page.goto(url)
  await page.getByRole('button', { name: 'Work', exact: true }).click()
  const composer = page.getByRole('region', { name: 'Conversation composer', exact: true })
  return { page, state, calls, errors, composer }
}

async function selectGuidance(composer, taskId = 'alpha') {
  await composer.getByRole('combobox', { name: 'Conversation action', exact: true }).selectOption('guidance')
  await composer.getByRole('combobox', { name: 'Conversation task', exact: true }).selectOption(taskId)
}

test('same-turn guidance submissions are single-flight and acceptance preserves a newer draft after reload', { timeout: 20000 }, async t => {
  let release
  let requestBody
  const responseGate = new Promise(resolve => { release = resolve })
  const { page, composer, calls, errors } = await fixture(t, async ({ path, body, route }) => {
    if (path !== '/api/tasks/steer') return false
    requestBody = body
    await responseGate
    await route.fulfill({ json: { taskId: body.taskId, destinationRevision: 5, receipt: { requestId: body.requestId, status: 'accepted', operation: 'task-steer' } } })
    return true
  })
  await selectGuidance(composer)
  const editor = composer.getByRole('textbox', { name: 'Task guidance', exact: true })
  await editor.fill('Original guidance')
  await composer.locator('form').evaluate(form => { form.requestSubmit(); form.requestSubmit() })
  await composer.locator('button[type="submit"]').filter({ hasText: 'Sending' }).waitFor()
  assert.equal(calls.filter(call => call.path === '/api/tasks/steer').length, 1)
  await editor.fill('Newer unsent guidance')
  release()
  await composer.getByRole('status').filter({ hasText: /preserved/i }).waitFor()
  assert.equal(await editor.inputValue(), 'Newer unsent guidance')
  assert.equal(requestBody.content, 'Original guidance')
  await page.reload()
  const reloadedComposer = page.getByRole('region', { name: 'Conversation composer', exact: true })
  await selectGuidance(reloadedComposer)
  assert.equal(await reloadedComposer.getByRole('textbox', { name: 'Task guidance', exact: true }).inputValue(), 'Newer unsent guidance')
  assert.equal(calls.filter(call => call.path === '/api/tasks/steer').length, 1)
  assert.deepEqual(errors, [])
})

test('malformed Ask acknowledgement remains an explicit unresolved receipt and reload does not resend', { timeout: 20000 }, async t => {
  const { page, composer, calls, errors } = await fixture(t, async ({ path, route }) => {
    if (path !== '/api/conversations/ask') return false
    await route.fulfill({ json: { taskId: 'unrelated-task' } })
    return true
  })
  await composer.getByRole('combobox', { name: 'Conversation action', exact: true }).selectOption('ask')
  await composer.getByRole('combobox', { name: 'Conversation agent', exact: true }).selectOption('ceo')
  const editor = composer.getByRole('textbox', { name: 'Ask agent', exact: true })
  await editor.fill('Do not accept a task-shaped acknowledgement')
  await composer.getByRole('button', { name: 'Ask agent', exact: true }).click()
  await page.waitForTimeout(1000)
  await composer.getByRole('status').filter({ hasText: /Outcome unknown/ }).waitFor()
  assert.equal(await editor.inputValue(), 'Do not accept a task-shaped acknowledgement')
  assert.equal(await composer.getByRole('button', { name: /Check outcome first/ }).count(), 1)
  assert.equal(calls.filter(call => call.path === '/api/conversations/ask').length, 1)
  await page.reload()
  const reloaded = page.getByRole('region', { name: 'Conversation composer', exact: true })
  await reloaded.getByRole('combobox', { name: 'Conversation action', exact: true }).selectOption('ask')
  await reloaded.getByRole('combobox', { name: 'Conversation agent', exact: true }).selectOption('ceo')
  await reloaded.getByRole('button', { name: /Check outcome first/ }).waitFor()
  assert.equal(await reloaded.getByRole('textbox', { name: 'Ask agent', exact: true }).inputValue(), 'Do not accept a task-shaped acknowledgement')
  assert.equal(calls.filter(call => call.path === '/api/conversations/ask').length, 1)
  assert.deepEqual(errors, [])
})

test('destination revision changes keep the draft and require explicit review before sending', { timeout: 20000 }, async t => {
  const { page, state, composer, calls, errors } = await fixture(t)
  await selectGuidance(composer)
  const editor = composer.getByRole('textbox', { name: 'Task guidance', exact: true })
  await editor.fill('Review before retargeting')
  await page.waitForFunction(() => Object.keys(sessionStorage).some(key => key.includes('chimera.conversation-drafts.v1:') && sessionStorage.getItem(key)?.includes('Review before retargeting')))
  state.tasks[0].destinationRevision = 5
  await page.reload()
  const reloaded = page.getByRole('region', { name: 'Conversation composer', exact: true })
  await selectGuidance(reloaded)
  await reloaded.getByRole('alert').waitFor()
  assert.equal(await reloaded.getByRole('textbox', { name: 'Task guidance', exact: true }).inputValue(), 'Review before retargeting')
  assert.equal(await reloaded.getByRole('button', { name: 'Guide task', exact: true }).isDisabled(), true)
  await reloaded.getByRole('button', { name: 'Review current destination', exact: true }).click()
  assert.equal(await reloaded.getByRole('button', { name: 'Guide task', exact: true }).isEnabled(), true)
  assert.deepEqual(calls, [])
  assert.deepEqual(errors, [])
})

test('known pre-dispatch failure preserves its draft and does not replay on reload', { timeout: 20000 }, async t => {
  const { page, composer, calls, errors } = await fixture(t, async ({ path, route }) => {
    if (path !== '/api/tasks/steer') return false
    await route.fulfill({ status: 400, json: { error: 'TASK_NOT_ACTIVE' } })
    return true
  })
  await selectGuidance(composer)
  const editor = composer.getByRole('textbox', { name: 'Task guidance', exact: true })
  await editor.fill('Keep this actionable after a known rejection')
  await composer.getByRole('button', { name: 'Guide task', exact: true }).click()
  await composer.getByRole('alert').filter({ hasText: /task not active/i }).waitFor()
  assert.equal(await editor.inputValue(), 'Keep this actionable after a known rejection')
  await page.reload()
  const reloaded = page.getByRole('region', { name: 'Conversation composer', exact: true })
  await selectGuidance(reloaded)
  assert.equal(await reloaded.getByRole('textbox', { name: 'Task guidance', exact: true }).inputValue(), 'Keep this actionable after a known rejection')
  assert.equal(calls.filter(call => call.path === '/api/tasks/steer').length, 1)
  assert.deepEqual(errors, [])
})
