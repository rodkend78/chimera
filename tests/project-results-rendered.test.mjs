import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'

test('Projects shows attributed reports and continues only the selected task without stale review crossover', { timeout: 40000 }, async () => {
  // Browser plugin/skill absent. Installed Playwright drives real React UI
  // with disposable fixture APIs, never the live operator or provider.
  const server = await createServer({ configFile: new URL('../app/vite.config.js', import.meta.url).pathname,
    server: { host: '127.0.0.1', port: 0, hmr: false, proxy: {} } })
  await server.listen()
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  page.setDefaultTimeout(5000)
  const calls = [], errors = []
  const tasks = [
    { taskId: 'task-new', projectId: 'demo', objective: `Review export recovery. ${'Read source without granting new permissions. '.repeat(8)}`, status: 'completed', summary: 'RJ recommends a durable export queue.', completedAt: '2026-09-06T07:30:57.000Z' },
    { taskId: 'task-old', projectId: 'demo', objective: 'Inspect the first prototype', status: 'completed', summary: 'Earlier review: prototype only.' },
    { taskId: 'task-follow', projectId: 'demo', projectSessionTaskId: 'task-new', priorTaskId: 'task-new', objective: 'Follow up on the export evidence', status: 'interrupted', failure: { message: 'Process stopped safely.' } },
  ]
  const message = (id, taskId, content) => ({ messageId: id, conversationId: `task:${taskId}`, taskId, senderAgentId: 'ace', recipientAgentIds: ['ceo'], role: 'agent', kind: 'structured_result', content, status: 'completed', createdAt: '2026-09-06T07:30:00.000Z', provenance: { verification: 'verified', signerAgentId: 'ace', envelopeHash: 'a'.repeat(64), grantId: 'fixture-grant' } })
  const state = {
    agent: { id: 'ceo', name: 'RJ', status: 'Idle' }, controller: { type: 'agent', id: 'ceo' }, suspended: false,
    browser: { running: true, tabs: [] }, activity: [], recentEvents: [], decisions: [], audit: { valid: true },
    models: { selected: { providerId: 'fixture', model: 'fixture' }, providers: [] }, auth: { codex: { connected: true } },
    agents: { specialists: [{ agentId: 'ace', displayName: 'Ace' }] }, conversations: { channels: [], messages: [message('recent', 'task-new', 'Ace found the visible-tab export dependency.')] }, tasks,
    projects: { projects: [{ projectId: 'demo', name: 'DemoStudio', defaultBranch: 'main', networkHosts: [], source: { type: 'local', path: '/fixture/demo-studio' } }],
      sessions: ['task-new', 'task-old'].map(taskId => ({ taskId, projectId: 'demo', status: 'completed', branch: `chimera/${taskId}`, baseCommit: '9d3156bf71af24ca7f35f9ecb3bd271a7d6d0736', workspace: { relativeRoot: 'scratch/repo' }, plan: { tasks: [{ specialistAgentId: 'ace', objective: 'Read the source only.', acceptanceCriteria: ['Return findings'] }] } })), leases: [] },
  }
  let releaseReview, rejectHistory = true
  try {
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (['error', 'warning'].includes(message.type()) && !message.text().includes('503 (Service Unavailable)')) errors.push(message.text()) })
    await page.routeWebSocket('**/api/browser/stream', socket => socket.onMessage(() => {}))
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url()), path = url.pathname
      if (path === '/api/operator/session') return route.fulfill({ json: { csrfToken: 'fixture', expiresAt: new Date(Date.now() + 60000).toISOString() } })
      if (path === '/api/state') return route.fulfill({ json: state })
      const body = route.request().method() === 'POST' ? route.request().postDataJSON() : null
      calls.push({ path, body, conversationId: url.searchParams.get('conversationId'), before: url.searchParams.get('before') })
      if (path === '/api/projects/review') {
        await new Promise(resolve => { releaseReview = resolve })
        return route.fulfill({ json: { changedFiles: [{ path: 'old-task-only.txt', status: 'M' }], patch: 'OLD REVIEW MUST NOT CROSS TASKS', readyToCommit: true, status: 'completed', reviewDigest: 'fixture-digest' } })
      }
      if (path === '/api/conversations/messages') {
        if (rejectHistory) { rejectHistory = false; return route.fulfill({ status: 503, json: { error: 'REPORT_HISTORY_UNAVAILABLE' } }) }
        if (url.searchParams.get('before') === 'history-page-2') return route.fulfill({ json: { messages: [message('oldest', 'task-new', 'Earliest attributable observation.')], nextCursor: null } })
        return route.fulfill({ json: { messages: [message('older', 'task-new', '<script>window.reportInjected=true</script> Earlier source evidence.'), { ...message('wrong-room', 'task-old', 'Unrelated task report must not appear.'), conversationId: 'task:task-new' }], nextCursor: 'history-page-2' } })
      }
      return route.fulfill({ json: {} })
    })
    const url = `http://127.0.0.1:${server.httpServer.address().port}/`
    await page.goto(url)
    assert.equal(await page.title(), 'Chimera Browser Workspace')
    await page.getByRole('button', { name: 'Projects', exact: true }).click()
    const report = page.getByRole('region', { name: 'Task results', exact: true })
    await report.getByText('RJ recommends a durable export queue.', { exact: true }).waitFor()
    await report.getByText('Ace found the visible-tab export dependency.', { exact: true }).waitFor()
    await report.getByText(/^Verified event/).waitFor()
    assert.equal(await report.getByText(tasks[0].objective, { exact: true }).isVisible(), false)
    await report.getByText('Full objective', { exact: true }).click()
    assert.equal(await report.getByText(tasks[0].objective, { exact: true }).isVisible(), true)
    await report.getByText('Full objective', { exact: true }).click()
    assert.equal(calls.filter(call => call.path === '/api/tasks/continue').length, 0)
    await report.getByRole('button', { name: 'Load agent report history' }).click()
    await report.getByRole('alert').waitFor()
    await report.getByRole('button', { name: 'Load agent report history' }).click()
    await report.getByText('<script>window.reportInjected=true</script> Earlier source evidence.', { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.reportInjected), undefined)
    assert.equal(await report.getByText('Unrelated task report must not appear.').count(), 0)
    await report.getByRole('button', { name: 'Load earlier agent reports' }).click()
    await report.getByText('Earliest attributable observation.', { exact: true }).waitFor()
    assert.equal(calls.filter(call => call.path === '/api/conversations/messages').at(-1).before, 'history-page-2')
    assert.equal(calls.filter(call => call.path === '/api/conversations/messages').every(call => call.conversationId === 'task:task-new'), true)
    await report.scrollIntoViewIfNeeded()
    await page.screenshot({ path: '/tmp/chimera-project-results-desktop.png' })
    await page.getByRole('button', { name: 'Review changes', exact: true }).click()
    await page.getByRole('button', { name: 'Inspect the first prototype', exact: false }).click()
    releaseReview()
    await report.getByText('Earlier review: prototype only.', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Review changes', exact: true }).waitFor()
    assert.equal(await page.getByRole('combobox', { name: 'Task to control' }).inputValue(), 'task-old')
    assert.equal(await page.getByText('OLD REVIEW MUST NOT CROSS TASKS').count(), 0)
    assert.equal(await page.getByRole('button', { name: 'Commit to source', exact: true }).count(), 0)
    await page.getByRole('textbox', { name: 'Continuation objective' }).fill('Continue only the earlier review.')
    await page.getByRole('button', { name: 'Continue task', exact: true }).click()
    await page.getByText(/Explicit continuation queued/).waitFor()
    assert.deepEqual(calls.find(call => call.path === '/api/tasks/continue').body, { taskId: 'task-old', objective: 'Continue only the earlier review.', budget: { maxTurns: 32, maxToolCalls: 24 } })
    await page.getByRole('combobox', { name: 'Task to control' }).selectOption('task-follow')
    await report.getByText('Process stopped safely.', { exact: true }).waitFor()
    await report.getByRole('article', { name: 'Runtime task outcome' }).waitFor()
    await page.getByText('chimera/task-new', { exact: true }).waitFor()
    await page.setViewportSize({ width: 390, height: 844 })
    await page.locator('.toast').waitFor({ state: 'hidden' })
    await report.scrollIntoViewIfNeeded()
    await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))) })
    await page.screenshot({ path: '/tmp/chimera-project-results-mobile.png' })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    assert.equal(await page.locator('vite-error-overlay').count(), 0)
    assert.deepEqual(errors, [])
  } finally { releaseReview?.(); await browser.close(); await server.close() }
})
