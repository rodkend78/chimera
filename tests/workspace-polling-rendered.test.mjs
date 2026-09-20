import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'

function deferred() { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

async function fixture(t, handler = async () => false) {
  const server = await createServer({ configFile: new URL('../app/vite.config.js', import.meta.url).pathname,
    server: { host: '127.0.0.1', port: 0, hmr: false, proxy: {} } })
  await server.listen()
  const browser = await chromium.launch({ headless: true })
  t.after(async () => { await browser.close(); await server.close() })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  page.setDefaultTimeout(4000)
  await page.clock.install()
  await page.clock.pauseAt(new Date())
  const errors = [], writes = [], reads = []
  let pending = 0, maxPending = 0
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (['error', 'warning'].includes(message.type()) && !message.text().startsWith('Failed to load resource')) errors.push(message.text()) })
  await page.routeWebSocket('**/api/browser/stream', socket => socket.onMessage(() => {}))
  await page.route('**/*', async route => {
    const url = new URL(route.request().url()), path = url.pathname
    if (url.hostname !== '127.0.0.1') throw new Error(`Unexpected external request: ${url.origin}`)
    if (!path.startsWith('/api/')) return route.continue()
    if (route.request().method() !== 'GET') {
      writes.push({ path, body: route.request().postDataJSON() })
      if (path === '/api/tasks/steer') {
        const body = route.request().postDataJSON()
        return route.fulfill({ json: { taskId: body.taskId, destinationRevision: body.expectedDestinationRevision ?? 1, receipt: { requestId: body.requestId, status: 'accepted', operation: 'task-steer' }, acknowledgement: 'Guidance saved for the next safe task boundary' } })
      }
      throw new Error(`Unexpected fixture write: ${path}`)
    }
    if (path === '/api/operator/session') return route.fulfill({ json: { csrfToken: 'fixture', expiresAt: '2099-01-01T00:00:00Z' } })
    if (path === '/api/tasks/alpha/workspace') return route.fulfill({ json: {
      schema: 'chimera.task-workspace.v1',
      task: { taskId: 'alpha', objective: 'Snapshot workspace', status: 'running', destinationRevision: 1 },
      plan: null,
      team: { taskId: 'alpha', participants: ['ceo'], deliveries: [] },
      conversation: { conversationId: 'task:alpha', messages: [] },
      permissions: [], approvals: [],
      files: { status: 'unloaded', review: null, artifacts: [] },
      results: { taskId: 'alpha', summary: 'No task workspace summary is recorded.', messages: [], reports: [] },
      browser: null, routing: null,
      evidence: { taskId: 'alpha', workProduced: { state: 'not-produced' }, checksPassed: { state: 'not-run' }, readyForReview: { state: 'not-reviewed' }, published: { state: 'not-published' } },
      recovery: { taskId: 'alpha', state: 'not-needed', summary: 'No recovery action is recorded.', retained: [], actions: [], retryAllowed: false },
    } })
    if (path !== '/api/state') throw new Error(`Unexpected fixture request: ${path}`)
    const sequence = reads.length + 1
    reads.push(sequence); pending++; maxPending = Math.max(maxPending, pending)
    try {
      if (await handler({ sequence, route })) return
      await route.fulfill({ json: {
        agent: { id: 'ceo', name: 'RJ', status: 'Working' }, controller: { type: 'agent', id: 'ceo' }, suspended: false,
        draftScope: { schema: 'chimera.draft-scope.v1', workspaceId: 'polling-fixture', operatorId: 'operator-fixture' },
        browser: { running: true, tabs: [] }, activity: [], recentEvents: [], decisions: [], audit: { valid: true },
        models: { selected: { providerId: 'fixture', model: 'fixture', providerName: 'Fixture', modelName: 'Fixture' }, providers: [] },
        auth: { codex: { connected: true } }, agents: { main: { agentId: 'ceo', displayName: 'RJ', role: 'CEO' }, specialists: [] },
        tasks: [{ taskId: 'alpha', objective: `Snapshot ${sequence}`, status: 'running', destinationRevision: 1 }],
        teamMessaging: { tasks: [{ taskId: 'alpha', destinationRevision: 1, participants: ['ceo'], eligibleRecipients: [], deliveries: [] }] },
        conversations: { channels: [], messages: [] }, projects: { projects: [], sessions: [], leases: [] },
      } })
    } finally { pending-- }
  })
  const url = `http://127.0.0.1:${server.httpServer.address().port}/`
  await page.goto(url)
  assert.equal(page.url(), url)
  assert.equal(await page.title(), 'Chimera Browser Workspace')
  await page.getByRole('button', { name: 'Work', exact: true }).click()
  const composer = page.getByRole('region', { name: 'Conversation composer', exact: true })
  const selectGuidance = async () => {
    await composer.getByRole('combobox', { name: 'Conversation action', exact: true }).selectOption('guidance')
    await composer.getByRole('combobox', { name: 'Conversation task', exact: true }).selectOption('alpha')
  }
  await page.getByText('Snapshot 1', { exact: true }).first().waitFor()
  return { page, reads, writes, errors, composer, selectGuidance, maxPending: () => maxPending }
}

const visibility = (page, hidden, repeat = 1) => page.evaluate(({ hidden, repeat }) => {
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden })
  for (let index = 0; index < repeat; index += 1) document.dispatchEvent(new Event('visibilitychange'))
}, { hidden, repeat })

test('returning between polls keeps future snapshots flowing without clearing a scoped human draft', { timeout: 20000 }, async t => {
  const { page, reads, writes, errors, composer, selectGuidance } = await fixture(t)
  await selectGuidance()
  const editor = composer.getByRole('textbox', { name: 'Task guidance', exact: true })
  await editor.fill('Keep this unsent review')
  await visibility(page, true); await visibility(page, false)
  await page.getByText('Snapshot 2', { exact: true }).first().waitFor()
  await page.clock.runFor(1100); await page.getByText('Snapshot 3', { exact: true }).first().waitFor()
  await page.clock.runFor(1100); await page.getByText('Snapshot 4', { exact: true }).first().waitFor()
  assert.equal(reads.length, 4)
  assert.equal(await editor.inputValue(), 'Keep this unsent review')
  assert.deepEqual(writes, [])
  assert.deepEqual(errors, [])
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
})

test('rapid tab returns during a pending snapshot keep one poll in flight and one future loop', { timeout: 20000 }, async t => {
  const started = deferred(), release = deferred()
  t.after(() => release.resolve())
  const { page, reads, writes, errors, maxPending } = await fixture(t, async ({ sequence, route }) => {
    if (sequence >= 2) { started.resolve(); await release.promise }
    return false
  })
  await visibility(page, false)
  await started.promise
  await visibility(page, true); await visibility(page, false, 5)
  await page.clock.runFor(200)
  assert.equal(reads.length, 2)
  assert.equal(maxPending(), 1)
  release.resolve()
  await page.getByText('Snapshot 2', { exact: true }).first().waitFor()
  await page.clock.runFor(1100)
  await page.getByText('Snapshot 3', { exact: true }).first().waitFor()
  assert.equal(reads.length, 3)
  assert.deepEqual(writes, [])
  assert.deepEqual(errors, [])
})

test('a failed foreground snapshot keeps the prior composer draft and recovers without writes', { timeout: 20000 }, async t => {
  const { page, composer, selectGuidance, reads, writes, errors } = await fixture(t, async ({ sequence, route }) => {
    if (sequence !== 2) return false
    await route.fulfill({ status: 503, json: { error: 'FIXTURE_STATE_UNAVAILABLE' } }); return true
  })
  await selectGuidance()
  const editor = composer.getByRole('textbox', { name: 'Task guidance', exact: true })
  await editor.fill('Do not lose the draft on read failure')
  await visibility(page, false)
  await page.getByRole('alert').filter({ hasText: 'fixture state unavailable' }).waitFor()
  await page.clock.runFor(1100)
  await page.getByText('Snapshot 3', { exact: true }).first().waitFor()
  assert.equal(await page.getByRole('alert').filter({ hasText: 'fixture state unavailable' }).count(), 0)
  assert.equal(await editor.inputValue(), 'Do not lose the draft on read failure')
  assert.equal(reads.length, 3)
  assert.deepEqual(writes, [])
  assert.deepEqual(errors, [])
})

test('a polling refresh never auto-sends a draft, while an explicit guidance submit remains attributed', { timeout: 20000 }, async t => {
  const { page, composer, selectGuidance, writes, errors } = await fixture(t)
  await selectGuidance()
  const editor = composer.getByRole('textbox', { name: 'Task guidance', exact: true })
  await editor.fill('Fixture guidance, exactly once')
  await page.clock.runFor(1100)
  assert.deepEqual(writes, [])
  await composer.getByRole('button', { name: 'Guide task', exact: true }).click()
  await composer.getByRole('status').filter({ hasText: /Guidance saved/ }).waitFor()
  await editor.fill('A newer unsent draft')
  assert.equal(writes.length, 1)
  assert.equal(writes[0].path, '/api/tasks/steer')
  assert.equal(writes[0].body.content, 'Fixture guidance, exactly once')
  assert.equal(await editor.inputValue(), 'A newer unsent draft')
  assert.deepEqual(errors, [])
})

test('an older successful poll cannot replace a newer accepted guidance action or newer draft', { timeout: 20000 }, async t => {
  const oldStarted = deferred()
  const oldRelease = deferred()
  const newStarted = deferred()
  t.after(() => { oldRelease.resolve() })
  const { page, composer, selectGuidance, writes, errors } = await fixture(t, async ({ sequence, route }) => {
    if (sequence === 2) {
      oldStarted.resolve()
      await oldRelease.promise
      return false
    }
    if (sequence === 3) {
      newStarted.resolve()
      return false
    }
    return false
  })
  await selectGuidance()
  const editor = composer.getByRole('textbox', { name: 'Task guidance', exact: true })
  await visibility(page, false)
  await oldStarted.promise
  await editor.fill('Original guidance')
  await composer.getByRole('button', { name: 'Guide task', exact: true }).click()
  await newStarted.promise
  await composer.getByRole('status').filter({ hasText: /Guidance saved/i }).waitFor()
  await editor.fill('Newer unsent guidance')
  oldRelease.resolve()
  await page.clock.runFor(200)
  await page.getByText('Snapshot 3', { exact: true }).first().waitFor()
  assert.equal(await page.getByText('Snapshot 2', { exact: true }).count(), 0)
  assert.equal(await editor.inputValue(), 'Newer unsent guidance')
  assert.equal(writes.filter(write => write.path === '/api/tasks/steer').length, 1)
  assert.deepEqual(errors, [])
})

test('accepted guidance remains accepted when its newer refresh fails while an older poll settles later', { timeout: 20000 }, async t => {
  const oldStarted = deferred()
  const oldRelease = deferred()
  const refreshFailed = deferred()
  t.after(() => { oldRelease.resolve() })
  const { page, composer, selectGuidance, writes, errors } = await fixture(t, async ({ sequence, route }) => {
    if (sequence === 2) {
      oldStarted.resolve()
      await oldRelease.promise
      return false
    }
    if (sequence === 3) {
      refreshFailed.resolve()
      await route.fulfill({ status: 503, json: { error: 'NEW_SNAPSHOT_FAILURE' } })
      return true
    }
    return false
  })
  await selectGuidance()
  const editor = composer.getByRole('textbox', { name: 'Task guidance', exact: true })
  await visibility(page, false)
  await oldStarted.promise
  await editor.fill('Accepted before refresh failure')
  await composer.getByRole('button', { name: 'Guide task', exact: true }).click()
  await refreshFailed.promise
  await composer.getByRole('status').filter({ hasText: /could not be confirmed|do not resend/i }).waitFor()
  await page.getByRole('alert').filter({ hasText: /new snapshot failure/i }).waitFor()
  oldRelease.resolve()
  await page.clock.runFor(200)
  assert.equal(await composer.getByRole('status').filter({ hasText: /could not be confirmed|do not resend/i }).count(), 1)
  assert.equal(await page.getByRole('alert').filter({ hasText: /new snapshot failure/i }).count(), 1)
  assert.equal(writes.filter(write => write.path === '/api/tasks/steer').length, 1)
  assert.deepEqual(errors, [])
})
