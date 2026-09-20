import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'

test('project UI queues while work runs and exposes explicit recovery resume on desktop and mobile', { timeout: 30000 }, async () => {
  // Browser skill/plugin absent; use the repository's installed Playwright
  // against disposable Vite and fixture APIs, never the live operator session.
  const server = await createServer({ configFile: new URL('../app/vite.config.js', import.meta.url).pathname,
    server: { host: '127.0.0.1', port: 0, hmr: false, proxy: {} } })
  await server.listen()
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  page.setDefaultTimeout(5000)
  const calls = [], errors = []
  const state = {
    agent: { id: 'ceo', name: 'RJ', status: 'Working' }, controller: { type: 'agent', id: 'ceo' }, suspended: false,
    draftScope: { schema: 'chimera.draft-scope.v1', workspaceId: 'project-queue-fixture', operatorId: 'operator-fixture' },
    browser: { running: true, tabs: [] }, activity: [], recentEvents: [], decisions: [], audit: { valid: true },
    models: { selected: { providerId: 'fixture', model: 'fixture' }, providers: [] }, auth: { codex: { connected: true } },
    agents: { main: { agentId: 'ceo', displayName: 'RJ', role: 'CEO' }, specialists: [] }, conversations: { channels: [], messages: [] },
    tasks: [{ taskId: 'paused', projectId: 'project-one', objective: 'Resume reviewed research', status: 'queued', queuedForExecution: true, recoveryRequired: true },
      { taskId: 'running', projectId: 'project-one', objective: 'Current project work', status: 'running' }],
    projects: { projects: [{ projectId: 'project-one', name: 'Website project', defaultBranch: 'main', networkHosts: [], source: { type: 'local', path: '/fixture/site' } }], sessions: [], leases: [] },
    projectQueue: { executionConcurrency: 1, blocked: false, jobs: [] },
  }
  try {
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    await page.routeWebSocket('**/api/browser/stream', socket => socket.onMessage(() => {}))
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname
      if (path === '/api/operator/session') return route.fulfill({ json: { csrfToken: 'fixture', expiresAt: new Date(Date.now() + 60000).toISOString() } })
      if (path === '/api/state') return route.fulfill({ json: state })
      const body = route.request().method() === 'POST' ? route.request().postDataJSON() : null
      calls.push({ path, body })
      if (path === '/api/tasks/steer') {
        return route.fulfill({ json: { taskId: body.taskId, destinationRevision: body.expectedDestinationRevision ?? 1, receipt: { requestId: body.requestId, status: 'accepted', operation: 'task-steer' }, acknowledgement: 'Guidance saved for the next safe task boundary' } })
      }
      if (path === '/api/projects/tasks') {
        const task = { ...body, taskId: 'new-job', status: 'queued', queuedForExecution: true }
        state.tasks.push(task)
        return route.fulfill({ json: task })
      }
      if (path === '/api/tasks/resume-queued') { state.tasks[0].recoveryRequired = false; return route.fulfill({ json: state.tasks[0] }) }
      return route.fulfill({ json: {} })
    })
    const url = `http://127.0.0.1:${server.httpServer.address().port}/`
    await page.goto(url)
    assert.equal(await page.title(), 'Chimera Browser Workspace')
    await page.getByRole('button', { name: 'Projects', exact: true }).click()
    await page.getByRole('heading', { name: 'Website project', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Expand decisions rail', exact: true }).click()
    await page.getByRole('region', { name: 'Task plan', exact: true }).getByText('Current project work', { exact: true }).waitFor()
    const composer = page.getByRole('region', { name: 'Conversation composer', exact: true })
    await composer.getByRole('combobox', { name: 'Conversation action', exact: true }).selectOption('guidance')
    await composer.getByRole('combobox', { name: 'Conversation task', exact: true }).selectOption('running')
    await composer.getByRole('textbox', { name: 'Task guidance', exact: true }).fill('Guide the executing job, not a waiting job')
    await composer.getByRole('button', { name: 'Guide task', exact: true }).click()
    await page.getByText('Guidance saved for the next safe task boundary', { exact: true }).waitFor()
    assert.equal(calls.find(call => call.path === '/api/tasks/steer').body.taskId, 'running')
    await page.getByRole('textbox', { name: 'Objective for RJ' }).fill('A second project outcome')
    const queue = page.getByRole('button', { name: 'Queue project task', exact: true })
    assert.equal(await queue.isEnabled(), true)
    await queue.click()
    await page.getByText('Project task queued. RJ will start it when the executor is available.', { exact: true }).waitFor()
    assert.equal(calls.find(call => call.path === '/api/projects/tasks').body.objective, 'A second project outcome')
    assert.equal(await page.getByRole('combobox', { name: 'Task to control' }).inputValue(), 'new-job')
    await page.getByRole('combobox', { name: 'Task to control' }).selectOption('paused')
    await page.getByRole('region', { name: 'Task recovery and control' }).scrollIntoViewIfNeeded()
    await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))) })
    await page.screenshot({ path: '/tmp/chimera-project-queue-paused.png' })
    await page.getByRole('button', { name: 'Resume queued task', exact: true }).click()
    await page.getByText('Queued task resumed; it will run when the executor is available.', { exact: true }).waitFor()
    assert.deepEqual(calls.find(call => call.path === '/api/tasks/resume-queued').body, { taskId: 'paused' })
    assert.equal(await page.getByRole('button', { name: 'Resume queued task', exact: true }).count(), 0)
    await page.screenshot({ path: '/tmp/chimera-project-queue-desktop.png' })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('region', { name: 'Task recovery and control' }).scrollIntoViewIfNeeded()
    await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))) })
    await page.screenshot({ path: '/tmp/chimera-project-queue-mobile.png' })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    assert.equal(await page.locator('vite-error-overlay').count(), 0)
    assert.deepEqual(errors, [])
  } finally { await browser.close(); await server.close() }
})
