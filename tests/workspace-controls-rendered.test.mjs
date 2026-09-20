import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'

test('rendered workspace reconnects, guides and stops a task, then explicitly continues with a budget', { timeout: 30000 }, async () => {
  // Browser plugin unavailable: use the installed Playwright against Vite on a
  // disposable port. APIs below are fixtures; runtime effects have separate tests.
  const server = await createServer({ configFile: new URL('../app/vite.config.js', import.meta.url).pathname,
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, proxy: {} } })
  await server.listen()
  const address = server.httpServer.address()
  const url = `http://127.0.0.1:${address.port}/`
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  page.setDefaultTimeout(7000)
  const errors = []
  const calls = []
  let initialization = 0
  const state = {
    agent: { id: 'ceo', name: 'RJ', status: 'Working', model: 'Fixture' },
    browser: { running: true, tabs: [{ tabId: 'one', title: 'Fixture', url: 'about:blank', active: true }] },
    controller: { type: 'agent', id: 'ceo' }, suspended: false, hourlyCost: null,
    draftScope: { schema: 'chimera.draft-scope.v1', workspaceId: 'workspace-controls-fixture', operatorId: 'operator-fixture' },
    activity: [], recentEvents: [], decisions: [], audit: { valid: true },
    models: { selected: { providerId: 'fixture', model: 'fixture', modelName: 'Fixture' }, providers: [{ id: 'fixture', name: 'Fixture', configured: true, models: [{ id: 'fixture', name: 'Fixture', availability: 'verified-route', capabilities: ['conversation'] }] }] },
    auth: { codex: { connected: true, status: 'connected' } },
    tasks: [{ taskId: 'task-fixture', objective: 'Build a fixture page', status: 'running', budget: { maxTurns: 32, maxToolCalls: 24 } }],
    conversations: { messages: [], channels: [{ conversationId: 'main', kind: 'hq', recipientAgentId: 'ceo', label: 'RJ', detail: 'Your main conversation' }, { conversationId: 'task:task-fixture', kind: 'task-room', label: 'Build a fixture page', detail: 'Task room' }] },
    agents: { specialists: [] },
  }
  try {
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => { if (message.type() === 'error' && !message.text().includes('503')) errors.push(message.text()) })
    await page.routeWebSocket('**/api/browser/stream', (socket) => socket.onMessage(() => {}))
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname
      const body = route.request().method() === 'POST' ? route.request().postDataJSON() : null
      if (path === '/api/operator/session') {
        if (++initialization === 1) return route.fulfill({ status: 503, json: { error: 'FIXTURE_TEMPORARILY_OFFLINE' } })
        return route.fulfill({ json: { csrfToken: 'fixture-token', expiresAt: new Date(Date.now() + 60000).toISOString() } })
      }
      if (path === '/api/state') return route.fulfill({ json: state })
      if (path === '/api/tasks' && !body) return route.fulfill({ json: { tasks: [{ taskId: 'older-task', objective: 'Older completed task', status: 'completed' }], nextCursor: null } })
      if (path === '/api/conversations/messages' && !body) {
        const conversationId = new URL(route.request().url()).searchParams.get('conversationId')
        const taskId = conversationId?.startsWith('task:') ? conversationId.slice('task:'.length) : null
        return route.fulfill({ json: { messages: [{ messageId: 'older-message', conversationId, ...(taskId ? { taskId } : {}), role: 'human', senderAgentId: 'rod', recipientAgentIds: ['ceo'], content: 'Earlier project context', kind: 'message', createdAt: new Date().toISOString(), status: 'completed' }], nextCursor: null } })
      }
      if (path === '/api/browser/files') return route.fulfill({ json: { status: 'allowed', result: { upload: { pending: false }, downloads: [] } } })
      calls.push({ path, body })
      if (path === '/api/tasks/cancel') { state.tasks[0].status = 'cancelled'; state.agent.status = 'Idle' }
      if (path === '/api/tasks/continue') { state.tasks.unshift({ ...state.tasks[0], taskId: 'continuation-fixture', status: 'running', objective: body.objective, budget: body.budget }); state.agent.status = 'Working' }
      if (path === '/api/control/take') state.controller = { type: 'human', id: 'rod' }
      return route.fulfill({ json: { status: 'allowed' } })
    })
    await page.goto(url)
    await page.getByRole('navigation', { name: 'Primary navigation' }).waitFor()
    assert.equal(await page.title(), 'Chimera Browser Workspace')
    assert.ok(initialization >= 2)
    await page.getByRole('region', { name: 'Conversation composer', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Work', exact: true }).click()
    const controls = page.getByRole('region', { name: 'Task recovery and control' })
    await controls.waitFor()
    await controls.getByRole('textbox', { name: 'Task guidance' }).fill('Use an accessible form')
    await controls.getByRole('button', { name: 'Guide task', exact: true }).click()
    await page.getByText('Guidance saved for next safe boundary', { exact: true }).waitFor()
    assert.deepEqual(calls.find((call) => call.path === '/api/tasks/steer').body, { taskId: 'task-fixture', content: 'Use an accessible form' })
    await controls.getByRole('button', { name: 'Stop task', exact: true }).click()
    await controls.getByRole('textbox', { name: 'Continuation objective' }).waitFor()
    await controls.getByRole('textbox', { name: 'Continuation objective' }).fill('Inspect artifacts, then finish the form')
    await controls.getByRole('combobox', { name: 'Continuation budget' }).selectOption('extended')
    await controls.getByRole('button', { name: 'Continue task', exact: true }).click()
    await page.getByText('Explicit continuation queued; previous effects will not be replayed automatically', { exact: true }).waitFor()
    // A newly queued continuation is a different task. Stay on the reviewed
    // task until the operator explicitly chooses that new task's room.
    assert.equal(await controls.getByRole('combobox', { name: 'Task to control' }).inputValue(), 'task-fixture')
    await controls.getByRole('combobox', { name: 'Task to control' }).selectOption('continuation-fixture')
    await controls.getByRole('textbox', { name: 'Task guidance' }).waitFor()
    const continued = calls.find((call) => call.path === '/api/tasks/continue')
    assert.deepEqual(continued.body.budget, { maxTurns: 64, maxToolCalls: 48 })
    await page.getByRole('button', { name: 'Load older tasks', exact: true }).click()
    await page.getByLabel('RJ queue', { exact: true }).getByRole('button', { name: 'Older completed task completed', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Load older messages', exact: true }).click()
    await page.getByText('Earlier project context', { exact: true }).waitFor()
    await page.locator('.queue-region').evaluate((element) => { element.scrollTop = 0 })
    await page.screenshot({ path: '/tmp/chimera-corrections-desktop.png' })
    await page.getByRole('button', { name: 'Browser', exact: true }).click()
    await page.getByRole('button', { name: 'Take control', exact: true }).click()
    await page.getByRole('button', { name: 'Uploads & downloads' }).click()
    await page.getByText('No upload requested by the website', { exact: true }).waitFor()
    const viewBox = await page.locator('.live-viewport').boundingBox()
    assert.ok(viewBox.height > 200, 'Files controls must not consume the browser viewport')
    assert.equal(await page.locator('vite-error-overlay').count(), 0)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: '/tmp/chimera-corrections-mobile.png' })
    assert.deepEqual(errors, [])
  } finally { await browser.close(); await server.close() }
})
