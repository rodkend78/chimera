import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'

test('selected task renders receipt-backed outcomes and only retries the read', { timeout: 30000 }, async () => {
  const server = await createServer({
    configFile: new URL('../app/vite.config.js', import.meta.url).pathname,
    server: { host: '127.0.0.1', port: 0, hmr: false, proxy: {} },
  })
  await server.listen()
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  page.setDefaultTimeout(5000)
  const errors = []
  const workspaceReads = []
  const task = { taskId: 'alpha', objective: 'Review the bounded task evidence', status: 'failed', destinationRevision: 2,
    failure: { code: 'MODEL_CALL_OUTCOME_UNKNOWN', message: 'An external effect may have started.' } }
  const state = {
    agent: { id: 'ceo', name: 'RJ', status: 'Idle' }, controller: { type: 'agent', id: 'ceo' }, suspended: false,
    draftScope: { schema: 'chimera.draft-scope.v1', workspaceId: 'fixture', operatorId: 'operator' },
    browser: { running: true, tabs: [] }, activity: [], recentEvents: [], decisions: [], audit: { valid: true },
    models: { selected: { providerId: 'fixture', model: 'fixture' }, providers: [] }, auth: { codex: { connected: true, status: 'connected' } },
    agents: { main: { agentId: 'ceo', displayName: 'RJ', role: 'CEO' }, specialists: [{ agentId: 'ace', displayName: 'Ace' }] },
    tasks: [task],
    teamMessaging: { tasks: [{ taskId: 'alpha', participants: ['ceo', 'ace'], eligibleRecipients: ['ace'], deliveries: [] }] },
    conversations: { channels: [{ conversationId: 'task:alpha', kind: 'task-room', taskId: 'alpha', label: 'Evidence task', detail: 'Task room' }], messages: [] },
  }
  const workspace = {
    schema: 'chimera.task-workspace.v1',
    task,
    plan: { schema: 'chimera.task-plan.v2', revision: 4, nodes: [{ nodeId: 'node-1', specialistAgentId: 'ace', objective: 'Bounded evidence', dependsOn: [] }], steps: [{ nodeId: 'node-1', status: 'failed' }] },
    team: { taskId: 'alpha', participants: ['ceo', 'ace'], deliveries: [] },
    conversation: { conversationId: 'task:alpha', messages: [] }, permissions: [], approvals: [],
    files: { status: 'stale', review: { taskId: 'alpha', stale: true, changedFiles: [{ path: 'README.md', status: 'M' }] }, artifacts: [] },
    results: { taskId: 'alpha', summary: 'Summary is not evidence.', messages: [], reports: [] }, browser: null,
    routing: { schema: 'chimera.routing-explanation.v1', taskId: 'alpha', selected: { agentId: 'ace', model: 'fixture-model', executor: 'fixture' }, candidates: [], reasons: [] },
    evidence: {
      taskId: 'alpha',
      workProduced: { state: 'observed', evidenceRefs: ['artifact-1'], observedAt: '2026-09-19T10:00:00.000Z', scope: 'task:alpha' },
      checksPassed: { state: 'unknown', evidenceRefs: ['check-1'], observedAt: '2026-09-19T10:01:00.000Z', scope: 'task:alpha/workspace:scratch/repo' },
      readyForReview: { state: 'stale', evidenceRefs: ['review-1'], observedAt: '2026-09-19T10:02:00.000Z', scope: 'task:alpha/workspace:scratch/repo' },
      published: { state: 'not-published', evidenceRefs: [], observedAt: '2026-09-19T10:02:00.000Z', scope: 'task:alpha/workspace:scratch/repo' },
    },
    recovery: {
      taskId: 'alpha', state: 'unknown', summary: 'An external effect may have started; inspect before continuing.',
      retained: [{ kind: 'model-call', operationId: 'call-1', status: 'ambiguous', taskId: 'alpha' }],
      actions: [{ id: 'inspect', label: 'Inspect retained work', enabled: true }, { id: 'retry-read', label: 'Retry workspace read', enabled: true }],
      retryAllowed: false,
    },
  }
  try {
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()) })
    await page.routeWebSocket('**/api/browser/stream', socket => socket.onMessage(() => {}))
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url())
      if (url.pathname === '/api/operator/session') return route.fulfill({ json: { csrfToken: 'fixture', expiresAt: new Date(Date.now() + 60000).toISOString() } })
      if (url.pathname === '/api/state') return route.fulfill({ json: state })
      if (url.pathname === '/api/tasks/alpha/workspace') {
        workspaceReads.push(route.request().method())
        return route.fulfill({ json: workspace })
      }
      return route.fulfill({ json: {} })
    })
    const url = `http://127.0.0.1:${server.httpServer.address().port}/`
    await page.goto(url)
    await page.getByRole('button', { name: 'Work', exact: true }).click()
    await page.getByRole('button', { name: 'Evidence task Task room', exact: true }).click()
    await page.getByRole('heading', { name: 'Review the bounded task evidence', exact: true }).waitFor()
    const outcome = page.getByRole('region', { name: 'Task outcomes and recovery', exact: true })
    await outcome.getByRole('article', { name: 'Work produced outcome', exact: true }).getByText('Observed', { exact: true }).waitFor()
    await outcome.getByRole('article', { name: 'Checks passed outcome', exact: true }).getByText('Unknown', { exact: true }).waitFor()
    await outcome.getByRole('article', { name: 'Ready for review outcome', exact: true }).getByText('Stale', { exact: true }).waitFor()
    await outcome.getByRole('article', { name: 'Published outcome', exact: true }).getByText('Not published', { exact: true }).waitFor()
    await page.getByText('An external effect may have started; inspect before continuing.', { exact: true }).waitFor()
    await page.locator('.task-outcome-technical summary').click()
    await page.getByText('Recovery state', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Inspect retained work', exact: true }).click()
    assert.equal(await page.locator('.task-workspace-files').evaluate(element => element.open), true)
    const readsBeforeRetry = workspaceReads.length
    await page.getByRole('button', { name: 'Retry workspace read', exact: true }).click()
    const readDeadline = Date.now() + 3000
    while (workspaceReads.length <= readsBeforeRetry && Date.now() < readDeadline) await new Promise(resolve => setTimeout(resolve, 25))
    assert.equal(workspaceReads.length > readsBeforeRetry, true)
    assert.equal(workspaceReads.every(method => method === 'GET'), true)
    assert.equal(await page.getByRole('button', { name: 'Retry this attempt', exact: true }).count(), 0)
    for (const width of [390, 768, 1440, 2560]) {
      await page.setViewportSize({ width, height: 1000 })
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `horizontal overflow at ${width}px`)
    }
    assert.equal(await page.locator('vite-error-overlay').count(), 0)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
    await server.close()
  }
})

test('trusted not-sent retry is routed to explicit continuation without replaying the task', { timeout: 30000 }, async () => {
  const server = await createServer({
    configFile: new URL('../app/vite.config.js', import.meta.url).pathname,
    server: { host: '127.0.0.1', port: 0, hmr: false, proxy: {} },
  })
  await server.listen()
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  page.setDefaultTimeout(5000)
  let retryRequests = 0
  const task = { taskId: 'retryable', objective: 'Explicitly continue after a trusted pre-dispatch denial', status: 'failed', destinationRevision: 1,
    failure: { code: 'CONNECTION_DISABLED', dispatchState: 'not_sent', message: 'The request was denied before dispatch.' } }
  const state = {
    agent: { id: 'ceo', name: 'RJ', status: 'Idle' }, controller: { type: 'agent', id: 'ceo' }, suspended: false,
    draftScope: { schema: 'chimera.draft-scope.v1', workspaceId: 'fixture', operatorId: 'operator' },
    browser: { running: true, tabs: [] }, activity: [], recentEvents: [], decisions: [], audit: { valid: true },
    models: { selected: { providerId: 'fixture', model: 'fixture' }, providers: [] }, auth: { codex: { connected: true, status: 'connected' } },
    agents: { main: { agentId: 'ceo', displayName: 'RJ', role: 'CEO' }, specialists: [] }, tasks: [task], teamMessaging: { tasks: [] },
    conversations: { channels: [{ conversationId: 'task:retryable', kind: 'task-room', taskId: 'retryable', label: 'Retry task', detail: 'Task room' }], messages: [] },
  }
  const workspace = {
    schema: 'chimera.task-workspace.v1', task, plan: null,
    team: { taskId: 'retryable', participants: [], deliveries: [] }, conversation: { conversationId: 'task:retryable', messages: [] },
    permissions: [], approvals: [], files: { status: 'unloaded', review: null, artifacts: [] },
    results: { taskId: 'retryable', summary: 'The denial happened before dispatch.', messages: [], reports: [] }, browser: null, routing: null,
    evidence: { taskId: 'retryable', workProduced: { state: 'not-produced' }, checksPassed: { state: 'not-run' }, readyForReview: { state: 'not-reviewed' }, published: { state: 'not-published' } },
    recovery: { taskId: 'retryable', state: 'retryable', summary: 'The task was denied before dispatch and can be explicitly retried.', retained: [], actions: [{ id: 'retry', label: 'Retry this attempt', enabled: true }], retryAllowed: true },
  }
  try {
    await page.routeWebSocket('**/api/browser/stream', socket => socket.onMessage(() => {}))
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url())
      if (url.pathname === '/api/operator/session') return route.fulfill({ json: { csrfToken: 'fixture', expiresAt: new Date(Date.now() + 60000).toISOString() } })
      if (url.pathname === '/api/state') return route.fulfill({ json: state })
      if (url.pathname === '/api/tasks/retryable/workspace') return route.fulfill({ json: workspace })
      if (url.pathname === '/api/tasks/retry') retryRequests += 1
      return route.fulfill({ json: {} })
    })
    const url = `http://127.0.0.1:${server.httpServer.address().port}/`
    await page.goto(url)
    await page.getByRole('button', { name: 'Work', exact: true }).click()
    await page.getByRole('button', { name: 'Retry task Task room', exact: true }).click()
    await page.getByRole('heading', { name: 'Explicitly continue after a trusted pre-dispatch denial', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Retry this attempt', exact: true }).click()
    const continuation = page.getByRole('textbox', { name: 'Continuation objective' })
    await continuation.waitFor()
    assert.equal(await continuation.evaluate(element => document.activeElement === element), true)
    await page.getByText('No automatic replay was sent.', { exact: false }).waitFor()
    assert.equal(retryRequests, 0)
  } finally {
    await browser.close()
    await server.close()
  }
})
