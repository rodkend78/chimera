import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'

async function fixture(t, configure = () => {}) {
  // Browser plugin unavailable: actual React/API client, isolated HTTP/WS
  // fixtures. No real operator session, agent task, or metered service is used.
  const server = await createServer({ configFile: new URL('../app/vite.config.js', import.meta.url).pathname,
    server: { host: '127.0.0.1', port: 0, hmr: false, proxy: {} } })
  await server.listen()
  const browser = await chromium.launch({ headless: true })
  t.after(async () => { await browser.close(); await server.close() })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  page.setDefaultTimeout(5000)
  const state = {
    agent: { id: 'ceo', name: 'RJ', status: 'Working' }, controller: { type: 'agent', id: 'ceo' }, suspended: false,
    draftScope: { schema: 'chimera.draft-scope.v1', workspaceId: 'queue-selection-fixture', operatorId: 'operator-fixture' },
    browser: { running: true, tabs: [] }, activity: [], recentEvents: [], decisions: [], audit: { valid: true },
    models: { selected: { providerId: 'fixture', model: 'fixture' }, providers: [] }, auth: { codex: { connected: true, status: 'connected' } },
    agents: { main: { agentId: 'ceo', displayName: 'RJ', role: 'CEO' }, specialists: [{ agentId: 'ace', displayName: 'Ace' }] },
    tasks: [{ taskId: 'alpha', objective: 'Alpha website review', status: 'running' }, { taskId: 'beta', objective: 'Beta export review', status: 'queued' }],
    teamMessaging: { tasks: [{ taskId: 'alpha', eligibleRecipients: ['ace'], participants: ['ceo', 'ace'], deliveries: [] }, { taskId: 'beta', eligibleRecipients: ['ace'], participants: ['ceo', 'ace'], deliveries: [] }] },
    conversations: { channels: [
      { conversationId: 'main', kind: 'hq', recipientAgentId: 'ceo', label: 'RJ headquarters', detail: 'Main conversation' },
      { conversationId: 'agent:ace', kind: 'agent', recipientAgentId: 'ace', label: 'Ace profile chat', detail: 'Agent conversation' },
      { conversationId: 'task:alpha', kind: 'task-room', taskId: 'alpha', label: 'Alpha website review', detail: 'Task room' },
      { conversationId: 'task:beta', kind: 'task-room', taskId: 'beta', label: 'Beta export review', detail: 'Task room' },
    ], messages: [] },
  }
  const calls = [], errors = [], older = []
  const workspace = taskId => {
    const task = state.tasks.find(candidate => candidate.taskId === taskId) ?? { taskId, objective: taskId, status: 'unknown' }
    return {
      schema: 'chimera.task-workspace.v1',
      task,
      plan: null,
      team: { taskId, participants: [], deliveries: [] },
      conversation: { conversationId: `task:${taskId}`, messages: [] },
      permissions: [], approvals: [],
      files: { status: 'unloaded', review: null, artifacts: [] },
      results: { taskId, summary: null, messages: [], reports: [] },
      browser: null, routing: null,
      evidence: { taskId, workProduced: { state: 'not-produced' }, checksPassed: { state: 'not-run' }, readyForReview: { state: 'not-reviewed' }, published: { state: 'not-published' } },
      recovery: { taskId, state: 'not-needed', summary: 'No recovery action is recorded.', retained: [], actions: [], retryAllowed: false },
    }
  }
  configure(state, older)
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()) })
  await page.routeWebSocket('**/api/browser/stream', socket => socket.onMessage(() => {}))
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/operator/session') return route.fulfill({ json: { csrfToken: 'fixture', expiresAt: new Date(Date.now() + 60000).toISOString() } })
    if (path === '/api/state') return route.fulfill({ json: state })
    const body = route.request().method() === 'POST' ? route.request().postDataJSON() : null
    const workspacePath = path.startsWith('/api/tasks/') && path.endsWith('/workspace')
    if (workspacePath) {
      assert.equal(route.request().method(), 'GET', 'workspace reads must never hide a write')
      const taskId = decodeURIComponent(path.slice('/api/tasks/'.length, -'/workspace'.length))
      return route.fulfill({ json: workspace(taskId) })
    }
    calls.push({ path, body })
    if (path === '/api/tasks' && !body) return route.fulfill({ json: { tasks: older, nextCursor: null } })
    if (path === '/api/conversations/messages' && !body) return route.fulfill({ json: { messages: [], nextCursor: null } })
    if (path === '/api/tasks/cancel') {
      const task = state.tasks.find(task => task.taskId === body.taskId)
      task.status = 'cancelled'
      return route.fulfill({ json: task })
    }
    return route.fulfill({ json: {} })
  })
  const url = `http://127.0.0.1:${server.httpServer.address().port}/`
  await page.goto(url)
  assert.equal(page.url(), url)
  assert.equal(await page.title(), 'Chimera Browser Workspace')
  await page.getByRole('button', { name: 'Work', exact: true }).click()
  const controls = page.getByRole('region', { name: 'Task recovery and control', exact: true })
  const rooms = page.getByLabel('Work history', { exact: true })
  return { page, controls, rooms, calls, errors, state }
}

test('choosing a Queue task room targets its controls, and the control selector changes the viewed room', { timeout: 25000 }, async t => {
  // Independent selectors previously showed beta while sending guidance to alpha.
  const { page, controls, rooms, calls, errors } = await fixture(t)
  await rooms.getByRole('button', { name: 'Beta export review Task room', exact: true }).click()
  assert.equal(await controls.getByRole('combobox', { name: 'Task to control' }).inputValue(), 'beta')
  const composer = page.getByRole('region', { name: 'Conversation composer', exact: true })
  await composer.getByRole('combobox', { name: 'Conversation action', exact: true }).waitFor()
  assert.equal(await composer.getByRole('combobox', { name: 'Conversation action', exact: true }).inputValue(), 'guidance')
  assert.equal(await composer.getByRole('combobox', { name: 'Conversation task', exact: true }).inputValue(), 'beta')
  await controls.getByRole('textbox', { name: 'Task guidance' }).fill('Inspect only the beta export')
  await controls.getByRole('button', { name: 'Guide task', exact: true }).click()
  await controls.getByText('Guidance saved for next safe boundary', { exact: true }).waitFor()
  assert.deepEqual(calls.find(call => call.path === '/api/tasks/steer').body, { taskId: 'beta', content: 'Inspect only the beta export' })
  await page.getByRole('checkbox', { name: '@Ace' }).check()
  await controls.getByRole('combobox', { name: 'Task to control' }).selectOption('alpha')
  assert.equal(await composer.getByRole('combobox', { name: 'Conversation task', exact: true }).inputValue(), 'alpha')
  assert.match(await page.locator('.chat-thread-header').innerText(), /Alpha website review/)
  assert.equal(await page.getByRole('checkbox', { name: '@Ace' }).isChecked(), false)
  const betaObjective = page.getByLabel('RJ queue', { exact: true }).getByRole('button', { name: 'Beta export review queued', exact: true })
  await betaObjective.click()
  assert.equal(await betaObjective.getAttribute('aria-pressed'), 'true')
  assert.equal(await controls.getByRole('combobox', { name: 'Task to control' }).inputValue(), 'beta')
  await controls.getByRole('button', { name: 'Stop task', exact: true }).click()
  await controls.getByText('Task cancelled. Already-started effects cannot be undone.', { exact: true }).waitFor()
  assert.deepEqual(calls.find(call => call.path === '/api/tasks/cancel').body, { taskId: 'beta' })
  await page.locator('.toast').waitFor({ state: 'hidden' })
  await page.locator('.queue-region').evaluate(element => { element.scrollTop = 0 })
  await page.screenshot({ path: '/tmp/chimera-queue-selection-desktop.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  await controls.scrollIntoViewIfNeeded()
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await page.screenshot({ path: '/tmp/chimera-queue-selection-mobile.png' })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  assert.equal(await page.locator('vite-error-overlay').count(), 0)
  assert.deepEqual(errors, [])
})

test('HQ and agent chats do not expose controls for an unrelated task', { timeout: 15000 }, async t => {
  const { page, controls, rooms, calls, errors } = await fixture(t)
  for (const room of ['RJ headquarters Main conversation', 'Ace profile chat Agent conversation']) {
    await rooms.getByRole('button', { name: room, exact: true }).click()
    assert.equal(await controls.count(), 0)
    await page.getByText('Select a task room or objective to use task controls.', { exact: true }).waitFor()
  }
  assert.equal(calls.some(call => call.body), false)
  assert.deepEqual(errors, [])
})

test('a task record without channel metadata gets its own derived room instead of another task room', { timeout: 15000 }, async t => {
  const { page, controls, rooms, calls, errors } = await fixture(t, state => {
    state.conversations.channels = state.conversations.channels.filter(channel => channel.conversationId !== 'task:alpha')
  })
  assert.match(await page.locator('.chat-thread-header').innerText(), /Alpha website review/)
  assert.match(await page.locator('.chat-thread-header').innerText(), /Task record/)
  await rooms.getByRole('button', { name: 'Beta export review Task room', exact: true }).click()
  await page.getByLabel('RJ queue', { exact: true }).getByRole('button', { name: 'Alpha website review running', exact: true }).click()
  assert.equal(await controls.getByRole('combobox', { name: 'Task to control' }).inputValue(), 'alpha')
  assert.match(await page.locator('.chat-thread-header').innerText(), /Alpha website review/)
  assert.equal(calls.some(call => call.body), false)
  assert.deepEqual(errors, [])
})

test('missing task context stays read-only until older task records are explicitly loaded', { timeout: 15000 }, async t => {
  const { page, controls, rooms, calls, errors } = await fixture(t, (state, older) => {
    older.push({ ...state.tasks[1], status: 'completed' })
    state.tasks = [state.tasks[0]]
  })
  await rooms.getByRole('button', { name: 'Beta export review Task room', exact: true }).click()
  assert.equal(await controls.count(), 0)
  await page.getByText('Task details are missing or inconsistent. Load older tasks or select another room before using task controls.', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Load older tasks', exact: true }).click()
  await controls.getByRole('textbox', { name: 'Continuation objective' }).fill('Continue only the older beta review')
  assert.equal(await controls.getByRole('combobox', { name: 'Task to control' }).inputValue(), 'beta')
  await controls.getByRole('button', { name: 'Continue task', exact: true }).click()
  await controls.getByText('Explicit continuation queued; previous effects will not be replayed automatically', { exact: true }).waitFor()
  assert.deepEqual(calls.find(call => call.path === '/api/tasks/continue').body, { taskId: 'beta', objective: 'Continue only the older beta review', budget: { maxTurns: 32, maxToolCalls: 24 } })
  assert.deepEqual(errors, [])
})

test('contradictory room identity never enables a task action', { timeout: 15000 }, async t => {
  const { controls, rooms, calls, errors } = await fixture(t, state => {
    state.conversations.channels.find(channel => channel.conversationId === 'task:beta').taskId = 'alpha'
  })
  await rooms.getByRole('button', { name: 'Beta export review Task room', exact: true }).click()
  assert.equal(await controls.count(), 0)
  assert.equal(calls.some(call => call.body), false)
  assert.deepEqual(errors, [])
})

test('a disappearing selected room does not silently retarget controls to the newest task', { timeout: 15000 }, async t => {
  const { page, controls, rooms, calls, errors, state } = await fixture(t)
  await rooms.getByRole('button', { name: 'Beta export review Task room', exact: true }).click()
  state.tasks = state.tasks.filter(task => task.taskId !== 'beta')
  state.conversations.channels = state.conversations.channels.filter(channel => channel.conversationId !== 'task:beta')
  await page.getByText('Selected conversation unavailable. Choose another room or load older tasks.', { exact: true }).waitFor()
  assert.equal(await controls.count(), 0)
  assert.equal(await page.getByRole('button', { name: 'Load older messages', exact: true }).isDisabled(), true)
  assert.equal(calls.some(call => call.body), false)
  assert.deepEqual(errors, [])
})
