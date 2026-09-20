import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'

test('selected task workspace fences late replies and preserves keyboard-safe navigation', { timeout: 30000 }, async t => {
  const server = await createServer({ configFile: new URL('../app/vite.config.js', import.meta.url).pathname,
    server: { host: '127.0.0.1', port: 0, hmr: false, proxy: {} } })
  await server.listen()
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  page.setDefaultTimeout(5000)
  const errors = []
  const held = new Map()
  const task = (taskId, objective, status = 'running') => ({ taskId, objective, status, destinationRevision: 1 })
  const state = {
    agent: { id: 'ceo', name: 'RJ', status: 'Working' }, controller: { type: 'agent', id: 'ceo' }, suspended: false,
    draftScope: { schema: 'chimera.draft-scope.v1', workspaceId: 'fixture', operatorId: 'operator' },
    browser: { running: true, tabs: [] }, activity: [], recentEvents: [], decisions: [], audit: { valid: true },
    models: { selected: { providerId: 'fixture', model: 'fixture' }, providers: [] }, auth: { codex: { connected: true, status: 'connected' } },
    agents: { main: { agentId: 'ceo', displayName: 'RJ', role: 'CEO' }, specialists: [{ agentId: 'ace', displayName: 'Ace' }] },
    tasks: [task('alpha', `Alpha objective ${'with a long name '.repeat(12)}`), task('beta', 'Beta objective', 'queued')],
    teamMessaging: { tasks: [{ taskId: 'alpha', participants: ['ceo', 'ace'], eligibleRecipients: ['ace'], deliveries: [] }, { taskId: 'beta', participants: ['ceo', 'ace'], eligibleRecipients: ['ace'], deliveries: [] }] },
    conversations: { channels: [{ conversationId: 'task:alpha', kind: 'task-room', taskId: 'alpha', label: 'Alpha task', detail: 'Task room' }, { conversationId: 'task:beta', kind: 'task-room', taskId: 'beta', label: 'Beta task', detail: 'Task room' }], messages: [] },
  }
  const workspace = taskId => ({ schema: 'chimera.task-workspace.v1', task: task(taskId, taskId === 'alpha' ? 'Alpha objective' : 'Beta objective'), plan: { revision: 1, nodes: [] }, team: { participants: [] }, conversation: { messages: [] }, permissions: [], approvals: [], files: { status: 'unavailable', artifacts: [] }, results: { messages: [] }, browser: null, routing: null, evidence: { status: 'unavailable' }, recovery: { status: 'unavailable' } })
  try {
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (['error', 'warning'].includes(message.type()) && !message.text().includes('503 (Service Unavailable)')) errors.push(message.text()) })
    await page.routeWebSocket('**/api/browser/stream', socket => socket.onMessage(() => {}))
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url()), path = url.pathname
      if (path === '/api/operator/session') return route.fulfill({ json: { csrfToken: 'fixture', expiresAt: new Date(Date.now() + 60000).toISOString() } })
      if (path === '/api/state') return route.fulfill({ json: state })
      if (path.startsWith('/api/tasks/') && path.endsWith('/workspace')) {
        const taskId = path.split('/')[3]
        await new Promise(resolve => {
          let released = false
          held.set(taskId, () => {
            if (released) return
            released = true
            void route.fulfill({ json: workspace(taskId) }); resolve()
          })
        })
        return
      }
      return route.fulfill({ json: {} })
    })
    const url = `http://127.0.0.1:${server.httpServer.address().port}/`
    await page.goto(url)
    await page.getByRole('button', { name: 'Work', exact: true }).click()
    await page.getByRole('button', { name: 'Alpha task Task room', exact: true }).click()
    await page.getByRole('region', { name: 'Selected task workspace', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Beta task Task room', exact: true }).click()
    held.get('beta')?.()
    await page.getByRole('heading', { name: 'Beta objective', exact: true }).waitFor()
    held.get('alpha')?.()
    assert.equal(await page.getByText('Alpha objective', { exact: true }).count(), 0)
    await page.keyboard.press('Tab')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    assert.equal(await page.locator('vite-error-overlay').count(), 0)
    assert.deepEqual(errors, [])
  } finally { for (const release of held.values()) release?.(); await browser.close(); await server.close() }
})

test('selected workspace renders recorded plan and preserves task addressing across guide, live refresh, and stale reads', { timeout: 40000 }, async () => {
  const server = await createServer({ configFile: new URL('../app/vite.config.js', import.meta.url).pathname,
    server: { host: '127.0.0.1', port: 0, hmr: false, proxy: {} } })
  await server.listen()
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  page.setDefaultTimeout(5000)
  const errors = []
  let workspaceMode = 'current'
  let workspaceVersion = 1
  const planNode = { nodeId: 'alpha-node', specialistAgentId: 'ace', objective: 'Inspect the recorded alpha handoff', acceptanceCriteria: ['Return the alpha report'], dependsOn: [] }
  const task = { taskId: 'alpha', objective: 'Alpha objective', status: 'running', destinationRevision: 1,
    summary: 'Alpha summary v1', plan: { schema: 'chimera.task-plan.v2', revision: 3, planHash: 'a'.repeat(64), nodes: [planNode] }, steps: [{ nodeId: 'alpha-node', status: 'running' }] }
  const taskMessage = { messageId: 'alpha-note', conversationId: 'task:alpha', taskId: 'alpha', senderAgentId: 'ace', recipientAgentIds: ['ceo'], role: 'agent', kind: 'message', content: 'Addressed note', status: 'completed', createdAt: '2026-09-18T12:00:00.000Z', provenance: { verification: 'derived', source: 'fixture' } }
  const wrongTaskRoomMessage = { ...taskMessage, messageId: 'wrong-task-room-note', taskId: 'beta', content: 'Wrong task transcript must stay hidden' }
  const unboundTaskRoomMessage = { ...taskMessage, messageId: 'unbound-task-room-note', taskId: undefined, content: 'Unbound transcript must stay hidden' }
  const state = {
    agent: { id: 'ceo', name: 'RJ', status: 'Working' }, controller: { type: 'agent', id: 'ceo' }, suspended: false,
    draftScope: { schema: 'chimera.draft-scope.v1', workspaceId: 'fixture', operatorId: 'operator' },
    browser: { running: true, tabs: [] }, activity: [],
    recentEvents: [{ kind: 'model.route.selected', routeId: 'global-route', capability: 'conversation', selectionReason: 'global fixture', costClass: 'standard' }],
    decisions: [], audit: { valid: true }, models: { selected: { providerId: 'fixture', model: 'fixture' }, providers: [] },
    auth: { codex: { connected: true, status: 'connected' } }, agents: { main: { agentId: 'ceo', displayName: 'RJ', role: 'CEO' }, specialists: [{ agentId: 'ace', displayName: 'Ace' }] },
    tasks: [task],
    teamMessaging: { tasks: [{ taskId: 'alpha', participants: ['ceo', 'ace'], eligibleRecipients: ['ace'], deliveries: [] }] },
    conversations: { channels: [{ conversationId: 'task:alpha', kind: 'task-room', taskId: 'alpha', label: 'Alpha task', detail: 'Task room' }], messages: [taskMessage, wrongTaskRoomMessage, unboundTaskRoomMessage] },
  }
  const workspace = () => ({ schema: 'chimera.task-workspace.v1', task: { ...task, summary: `Alpha summary v${workspaceVersion}` },
    plan: { schema: 'chimera.task-plan.v2', revision: 3, nodes: [planNode], steps: [{ nodeId: 'alpha-node', status: workspaceVersion > 1 ? 'completed' : 'running' }] },
    team: { taskId: 'alpha', participants: ['ceo', 'ace'], eligibleRecipients: ['ace'], deliveries: [] }, conversation: { conversationId: 'task:alpha', messages: [taskMessage] },
    permissions: [], approvals: workspaceVersion > 1 ? [{ actionId: 'alpha-approval', taskId: 'alpha', title: 'Approve alpha handoff', resource: 'task:alpha', expiresAt: 1790000000000, actionDiff: {} }] : [], files: { status: 'unloaded', artifacts: [] }, results: { summary: `Alpha summary v${workspaceVersion}`, messages: [] },
    browser: workspaceVersion > 1 ? { taskId: 'alpha', leaseId: 'alpha-browser', agentId: 'ace', status: 'recorded', expiresAt: 1790000000000, observedAt: 1789990000000 } : null,
    routing: { schema: 'chimera.routing-explanation.v1', taskId: 'alpha', selected: { agentId: 'ace', model: 'task-model', executor: 'fixture', reason: 'Task-scoped model pin' }, candidates: [{ routeId: 'task-route', model: 'task-model', status: 'eligible', reasons: [] }], reasons: ['Task-scoped model pin'], evidence: { status: 'recorded' } },
    evidence: { workProduced: { state: 'observed', evidenceRefs: ['artifact-1'], observedAt: '2026-09-19T10:00:00.000Z', scope: 'task:alpha' }, checksPassed: { state: 'passed', evidenceRefs: ['check-1'], observedAt: '2026-09-19T10:01:00.000Z', scope: 'task:alpha@rev-1' }, readyForReview: { state: 'ready', evidenceRefs: ['review-1'], observedAt: '2026-09-19T10:02:00.000Z', scope: 'task:alpha@rev-1' }, published: { state: 'not-published', evidenceRefs: [], observedAt: '2026-09-19T10:02:00.000Z', scope: 'task:alpha@rev-1' } },
    recovery: { state: 'unknown', summary: 'An external effect may have started; inspect before continuing.', retained: [{ kind: 'model-call', status: 'ambiguous', operationId: 'call-1' }], actions: [{ id: 'inspect', label: 'Inspect retained work', enabled: true }], retryAllowed: false } })
  try {
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (['error', 'warning'].includes(message.type()) && !message.text().includes('503 (Service Unavailable)')) errors.push(message.text()) })
    await page.routeWebSocket('**/api/browser/stream', socket => socket.onMessage(() => {}))
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url()), path = url.pathname
      if (path === '/api/operator/session') return route.fulfill({ json: { csrfToken: 'fixture', expiresAt: new Date(Date.now() + 60000).toISOString() } })
      if (path === '/api/state') return route.fulfill({ json: state })
      if (path === '/api/tasks/alpha/workspace') {
        if (workspaceMode === 'error') return route.fulfill({ status: 503, json: { error: 'WORKSPACE_READ_UNAVAILABLE' } })
        return route.fulfill({ json: workspace() })
      }
      return route.fulfill({ json: {} })
    })
    const url = `http://127.0.0.1:${server.httpServer.address().port}/`
    await page.goto(url)
    await page.getByRole('button', { name: 'Work', exact: true }).click()
    await page.getByRole('button', { name: 'Alpha task Task room', exact: true }).click()
    await page.getByRole('heading', { name: 'Alpha objective', exact: true }).waitFor()
    await page.getByText('Inspect the recorded alpha handoff', { exact: true }).first().waitFor()
    assert.equal(await page.getByText('Wrong task transcript must stay hidden', { exact: true }).count(), 0)
    assert.equal(await page.getByText('Unbound transcript must stay hidden', { exact: true }).count(), 0)
    assert.equal(await page.getByText('Request received', { exact: true }).count(), 0)
    assert.equal(await page.getByText('RJ planning', { exact: true }).count(), 0)
    await page.getByText('Selected ace · task-model · fixture.', { exact: true }).waitFor()
    await page.getByText('Checks passed', { exact: true }).waitFor()
    await page.getByText('Not published', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Inspect retained work', exact: true }).waitFor()
    await page.getByText(/Global last model route \(not this task's route\)/).waitFor()
    await page.getByRole('checkbox', { name: '@Ace', exact: true }).check()
    await page.getByRole('button', { name: 'Reply to Ace', exact: true }).click()
    await page.getByText('Replying to Ace: Addressed note', { exact: true }).waitFor()
    const composer = page.locator('textarea[aria-label="Task guidance"]')
    await composer.fill('Keep this addressed draft')
    await page.getByRole('button', { name: 'Guide this task', exact: true }).click()
    await page.getByText('Replying to Ace: Addressed note', { exact: true }).waitFor()
    assert.equal(await page.getByRole('checkbox', { name: '@Ace', exact: true }).isChecked(), true)
    assert.equal(await composer.inputValue(), 'Keep this addressed draft')
    workspaceVersion = 2
    await page.getByText('Alpha summary v2', { exact: true }).first().waitFor({ timeout: 8000 })
    assert.equal(await page.getByText('completed', { exact: true }).count() > 0, true)
    await page.getByText('1 task-bound', { exact: true }).waitFor()
    const decisions = page.locator('details.task-workspace-disclosure').filter({ hasText: 'Decisions' })
    await decisions.locator('summary').click()
    await page.getByText('Approve alpha handoff', { exact: true }).waitFor()
    const browserDetails = page.locator('details.task-workspace-disclosure').filter({ hasText: 'Browser' })
    await browserDetails.locator('summary').click()
    await page.getByText(/Recorded task-bound browser binding for ace/).waitFor()
    assert.equal(await page.getByText('1790000000000', { exact: true }).count(), 0)
    workspaceMode = 'error'
    await page.getByRole('button', { name: 'Refresh view', exact: true }).click()
    await page.getByText('Stale view', { exact: true }).waitFor()
    await page.getByText('Alpha summary v2', { exact: true }).first().waitFor()
    for (const width of [390, 768, 1440, 2560]) {
      await page.setViewportSize({ width, height: 1000 })
      await page.screenshot({ path: `/tmp/chimera-task-workspace-${width}.png`, fullPage: true })
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `horizontal overflow at ${width}px`)
    }
    assert.equal(await page.locator('vite-error-overlay').count(), 0)
    assert.deepEqual(errors, [])
  } finally { await browser.close(); await server.close() }
})
