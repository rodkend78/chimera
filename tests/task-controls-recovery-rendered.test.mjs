import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'

async function fixture(t, { section = 'Work', status = 'completed', handler, stateHandler } = {}) {
  // Browser plugin unavailable: real React/API client with isolated fixture
  // HTTP responses. Never execute a live continuation or cancellation.
  const server = await createServer({ configFile: new URL('../app/vite.config.js', import.meta.url).pathname,
    server: { host: '127.0.0.1', port: 0, hmr: false, proxy: {} } })
  await server.listen()
  const browser = await chromium.launch({ headless: true })
  t.after(async () => { await browser.close(); await server.close() })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  page.setDefaultTimeout(4000)
  const calls = [], errors = []
  const state = {
    agent: { id: 'ceo', name: 'RJ', status: status === 'running' ? 'Working' : 'Idle' }, controller: { type: 'agent', id: 'ceo' }, suspended: false,
    browser: { running: true, tabs: [] }, activity: [], recentEvents: [], decisions: [], audit: { valid: true },
    models: { selected: { providerId: 'fixture', model: 'fixture' }, providers: [] }, auth: { codex: { connected: true } },
    agents: { specialists: [] }, conversations: { channels: [], messages: [] },
    tasks: [{ taskId: 'alpha', projectId: 'project', objective: 'First review', status }, { taskId: 'beta', projectId: 'project', objective: 'Second review', status: 'completed' }],
    projects: { projects: [{ projectId: 'project', name: 'Fixture project', defaultBranch: 'main', networkHosts: [], source: { type: 'local', path: '/fixture/project' } }], sessions: [], leases: [] },
  }
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (['error', 'warning'].includes(message.type()) && !message.text().includes('503 (Service Unavailable)')) errors.push(message.text()) })
  await page.routeWebSocket('**/api/browser/stream', socket => socket.onMessage(() => {}))
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/operator/session') return route.fulfill({ json: { csrfToken: 'fixture', expiresAt: new Date(Date.now() + 60000).toISOString() } })
    if (path === '/api/state') {
      if (await stateHandler?.({ route, state })) return
      return route.fulfill({ json: state })
    }
    const body = route.request().method() === 'POST' ? route.request().postDataJSON() : null
    calls.push({ path, body })
    if (await handler?.({ route, path, body, state })) return
    await route.fulfill({ json: {} })
  })
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`)
  assert.equal(await page.title(), 'Chimera Browser Workspace')
  await page.getByRole('button', { name: section, exact: true }).click()
  const controls = page.getByRole('region', { name: 'Task recovery and control', exact: true })
  await controls.waitFor()
  return { page, controls, calls, errors }
}

function gate(t) {
  let release, arrive
  const wait = new Promise(resolve => { release = resolve })
  const arrived = new Promise(resolve => { arrive = resolve })
  t.after(() => release())
  return { release, arrive, wait, arrived }
}

for (const scenario of [
  { action: 'continue', status: 'completed', button: 'Continue task', input: 'Continuation objective', accepted: /Explicit continuation queued/ },
  { action: 'steer', status: 'running', button: 'Guide task', input: 'Task guidance', accepted: /Guidance saved/ },
  { action: 'cancel', status: 'running', button: 'Stop task', accepted: /Task cancelled/ },
  { action: 'resume-queued', status: 'queued', button: 'Resume queued task', accepted: /Queued task resumed/ },
]) test(`${scenario.action} acceptance survives a failed state refresh without replay or a false action failure`, { timeout: 20000 }, async t => {
  // Ignoring refresh() === false hides stale state; treating it as a failed POST
  // misrepresents an accepted effect and risks replaying it.
  let failRefresh = false
  const { page, controls, calls, errors } = await fixture(t, { status: scenario.status,
    stateHandler: async ({ route, state }) => {
      if (scenario.action === 'resume-queued') state.tasks[0].recoveryRequired = true
      if (!failRefresh) return false
      await route.fulfill({ status: 503, json: { error: 'STATE_TEMPORARILY_UNAVAILABLE' } }); return true
    },
    handler: async ({ route, path }) => {
      if (path !== `/api/tasks/${scenario.action}`) return false
      failRefresh = true
      await route.fulfill({ json: { taskId: 'accepted-effect' } }); return true
    },
  })
  if (scenario.input) await controls.getByRole('textbox', { name: scenario.input }).fill('One explicitly approved request')
  await controls.getByRole('button', { name: scenario.button, exact: true }).click()
  const outcome = controls.locator('.task-action-notice.accepted')
  await outcome.waitFor()
  assert.match(await outcome.innerText(), scenario.accepted)
  assert.match(await outcome.innerText(), /status refresh failed/i)
  assert.match(await outcome.innerText(), /do not repeat/i)
  assert.equal(await controls.getByRole('alert').count(), 0, 'a failed read is not a failed effect')
  if (scenario.input) assert.equal(await controls.getByRole('textbox', { name: scenario.input }).inputValue(), '', 'acknowledged text is cleared even when the refresh fails')
  await page.getByRole('button', { name: 'Browser', exact: true }).click()
  await page.getByRole('button', { name: 'Projects', exact: true }).click()
  await outcome.waitFor()
  assert.match(await outcome.innerText(), /status refresh failed/i)
  const expected = { taskId: 'alpha', ...(scenario.action === 'steer' ? { content: 'One explicitly approved request' }
    : scenario.action === 'continue' ? { objective: 'One explicitly approved request', budget: { maxTurns: 32, maxToolCalls: 24 } } : {}) }
  assert.deepEqual(calls.filter(call => call.path === `/api/tasks/${scenario.action}`).map(call => call.body), [expected])
  if (scenario.action === 'continue') {
    await page.locator('.toast').waitFor({ state: 'hidden' })
    await outcome.scrollIntoViewIfNeeded()
    await page.screenshot({ path: '/tmp/chimera-task-refresh-desktop.png' })
    await page.setViewportSize({ width: 390, height: 844 })
    await outcome.scrollIntoViewIfNeeded()
    await page.screenshot({ path: '/tmp/chimera-task-refresh-mobile.png' })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  }
  assert.equal(await page.locator('vite-error-overlay').count(), 0)
  assert.deepEqual(errors, [])
})

test('same-turn continuation submits once and its response preserves newer draft text', { timeout: 20000 }, async t => {
  const pending = gate(t)
  const { controls, calls, errors } = await fixture(t, { handler: async ({ route, path }) => {
    if (path !== '/api/tasks/continue') return false
    pending.arrive(); await pending.wait; await route.fulfill({ json: { taskId: 'continued' } }); return true
  } })
  await controls.getByRole('textbox', { name: 'Continuation objective' }).fill('Original objective')
  await controls.getByRole('combobox', { name: 'Continuation budget' }).selectOption('extended')
  await controls.locator('form').evaluate(form => { form.requestSubmit(); form.requestSubmit() })
  await pending.arrived
  assert.equal(calls.filter(call => call.path === '/api/tasks/continue').length, 1)
  await controls.getByRole('textbox', { name: 'Continuation objective' }).fill('Newer unsent draft')
  pending.release()
  await controls.getByText('Explicit continuation queued; previous effects will not be replayed automatically', { exact: true }).waitFor()
  assert.equal(await controls.getByRole('textbox', { name: 'Continuation objective' }).inputValue(), 'Newer unsent draft')
  assert.deepEqual(calls.find(call => call.path === '/api/tasks/continue').body, { taskId: 'alpha', objective: 'Original objective', budget: { maxTurns: 64, maxToolCalls: 48 } })
  assert.deepEqual(errors, [])
})

for (const section of ['Work', 'Projects']) test(`${section} selection keeps in-flight locks without clearing another task's draft`, { timeout: 20000 }, async t => {
  const pending = gate(t)
  const { page, controls, errors } = await fixture(t, { section, handler: async ({ route, path }) => {
    if (path !== '/api/tasks/continue') return false
    pending.arrive(); await pending.wait; await route.fulfill({ json: { taskId: 'continued' } }); return true
  } })
  await controls.getByRole('textbox', { name: 'Continuation objective' }).fill('Same text, different task')
  await controls.getByRole('combobox', { name: 'Continuation budget' }).selectOption('extended')
  await controls.getByRole('button', { name: 'Continue task', exact: true }).click()
  await pending.arrived
  await controls.getByRole('combobox', { name: 'Task to control' }).selectOption('beta')
  assert.equal(await controls.getByRole('combobox', { name: 'Continuation budget' }).inputValue(), 'standard')
  await controls.getByRole('combobox', { name: 'Task to control' }).selectOption('alpha')
  await controls.getByRole('textbox', { name: 'Continuation objective' }).fill('Possible accidental repeat')
  assert.equal(await controls.getByRole('button', { name: 'Continue task', exact: true }).isDisabled(), true, 'selection must not reset the pending request lock')
  await controls.getByRole('combobox', { name: 'Task to control' }).selectOption('beta')
  await controls.getByRole('textbox', { name: 'Continuation objective' }).fill('Same text, different task')
  pending.release()
  await page.getByText('First review: continuation accepted', { exact: true }).waitFor()
  assert.equal(await controls.getByRole('textbox', { name: 'Continuation objective' }).inputValue(), 'Same text, different task')
  // Returning to the original task exposes its acknowledgement, not beta's.
  await controls.getByRole('combobox', { name: 'Task to control' }).selectOption('alpha')
  await controls.getByText('Explicit continuation queued; previous effects will not be replayed automatically', { exact: true }).waitFor()
  await controls.getByRole('combobox', { name: 'Task to control' }).selectOption('beta')
  assert.equal(await controls.getByRole('status').count(), 0, 'another task must not inherit the acknowledgement')
  assert.deepEqual(errors, [])
})

test('failed continuation remains actionable without losing its draft or replaying the request', { timeout: 20000 }, async t => {
  const { page, controls, calls, errors } = await fixture(t, { handler: async ({ route, path }) => {
    if (path !== '/api/tasks/continue') return false
    await route.fulfill({ status: 503, json: { error: 'TASK_EXECUTOR_UNAVAILABLE' } }); return true
  } })
  await controls.getByRole('textbox', { name: 'Continuation objective' }).fill('Keep this objective')
  await controls.getByRole('combobox', { name: 'Continuation budget' }).selectOption('extended')
  await controls.getByRole('button', { name: 'Continue task', exact: true }).click()
  await controls.getByRole('alert').waitFor()
  await page.locator('.toast').waitFor({ state: 'hidden' })
  assert.match(await controls.getByRole('alert').innerText(), /task executor unavailable/i)
  assert.equal(await controls.getByRole('textbox', { name: 'Continuation objective' }).inputValue(), 'Keep this objective')
  assert.equal(await controls.getByRole('combobox', { name: 'Continuation budget' }).inputValue(), 'extended')
  assert.equal(calls.filter(call => call.path === '/api/tasks/continue').length, 1)
  await controls.scrollIntoViewIfNeeded()
  await page.screenshot({ path: '/tmp/chimera-task-recovery-desktop.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  await controls.scrollIntoViewIfNeeded()
  await page.screenshot({ path: '/tmp/chimera-task-recovery-mobile.png' })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  assert.equal(await page.locator('vite-error-overlay').count(), 0)
  assert.deepEqual(errors, [])
})

test('Stop stays available during pending guidance and a late guidance failure cannot undo its acknowledgement', { timeout: 20000 }, async t => {
  const pending = gate(t)
  const { controls, calls, errors } = await fixture(t, { status: 'running', handler: async ({ route, path, state }) => {
    if (path === '/api/tasks/steer') { pending.arrive(); await pending.wait; await route.fulfill({ status: 503, json: { error: 'TASK_NO_LONGER_ACTIVE' } }); return true }
    if (path === '/api/tasks/cancel') { state.tasks[0].status = 'cancelled'; await route.fulfill({ json: state.tasks[0] }); return true }
    return false
  } })
  await controls.getByRole('textbox', { name: 'Task guidance' }).fill('Pending guidance')
  await controls.getByRole('button', { name: 'Guide task', exact: true }).click()
  await pending.arrived
  assert.equal(await controls.getByRole('button', { name: 'Stop task', exact: true }).isEnabled(), true)
  await controls.getByRole('button', { name: 'Stop task', exact: true }).click()
  await controls.getByRole('textbox', { name: 'Continuation objective' }).waitFor()
  await controls.getByText('Task cancelled. Already-started effects cannot be undone.', { exact: true }).waitFor()
  await controls.getByRole('textbox', { name: 'Continuation objective' }).fill('Inspect before resuming')
  pending.release()
  await controls.getByRole('button', { name: 'Continue task', exact: true }).click({ trial: true })
  assert.equal(await controls.getByRole('textbox', { name: 'Continuation objective' }).inputValue(), 'Inspect before resuming')
  assert.equal(await controls.getByText('Task cancelled. Already-started effects cannot be undone.', { exact: true }).isVisible(), true)
  assert.equal(await controls.getByRole('alert').count(), 0)
  assert.equal(calls.filter(call => call.path === '/api/tasks/cancel').length, 1)
  assert.equal(calls.filter(call => call.path === '/api/tasks/continue').length, 0)
  assert.deepEqual(errors, [])
})

test('task drafts and budget follow their exact task across Queue, Browser and Projects', { timeout: 20000 }, async t => {
  // A view-local draft or a key shared by different tasks loses/misattributes text.
  const { page, controls, calls, errors } = await fixture(t)
  await controls.getByRole('textbox', { name: 'Continuation objective' }).fill('Alpha review follow-up')
  await controls.getByRole('combobox', { name: 'Continuation budget' }).selectOption('extended')
  await page.getByRole('button', { name: 'Projects', exact: true }).click()
  assert.equal(await controls.getByRole('textbox', { name: 'Continuation objective' }).inputValue(), 'Alpha review follow-up')
  assert.equal(await controls.getByRole('combobox', { name: 'Continuation budget' }).inputValue(), 'extended')
  await controls.getByRole('combobox', { name: 'Task to control' }).selectOption('beta')
  assert.equal(await controls.getByRole('textbox', { name: 'Continuation objective' }).inputValue(), '')
  assert.equal(await controls.getByRole('combobox', { name: 'Continuation budget' }).inputValue(), 'standard')
  await controls.getByRole('textbox', { name: 'Continuation objective' }).fill('Beta review follow-up')
  await page.getByRole('button', { name: 'Browser', exact: true }).click()
  await page.getByRole('button', { name: 'Work', exact: true }).click()
  await controls.getByRole('combobox', { name: 'Task to control' }).selectOption('alpha')
  assert.equal(await controls.getByRole('textbox', { name: 'Continuation objective' }).inputValue(), 'Alpha review follow-up')
  assert.equal(await controls.getByRole('combobox', { name: 'Continuation budget' }).inputValue(), 'extended')
  await controls.getByRole('combobox', { name: 'Task to control' }).selectOption('beta')
  assert.equal(await controls.getByRole('textbox', { name: 'Continuation objective' }).inputValue(), 'Beta review follow-up')
  assert.equal(calls.filter(call => call.body).length, 0, 'navigation never submits a saved draft')
  await page.reload()
  await page.getByRole('button', { name: 'Work', exact: true }).click()
  assert.equal(await controls.getByRole('textbox', { name: 'Continuation objective' }).inputValue(), '', 'drafts are not stored across page reloads')
  assert.deepEqual(errors, [])
})

test('pending continuation and its eventual failure survive section navigation without duplicate writes', { timeout: 20000 }, async t => {
  // Remounting request tracking permits a second POST and loses a reply received
  // while no task control is mounted. Both are observable at the UI boundary.
  const pending = gate(t)
  const { page, controls, calls, errors } = await fixture(t, { handler: async ({ route, path }) => {
    if (path !== '/api/tasks/continue') return false
    pending.arrive(); await pending.wait
    await route.fulfill({ status: 503, json: { error: 'TASK_EXECUTOR_UNAVAILABLE' } }); return true
  } })
  await controls.getByRole('textbox', { name: 'Continuation objective' }).fill('Preserve this uncertain request')
  await controls.getByRole('combobox', { name: 'Continuation budget' }).selectOption('extended')
  await controls.getByRole('button', { name: 'Continue task', exact: true }).click()
  await pending.arrived
  await page.getByRole('button', { name: 'Projects', exact: true }).click()
  await controls.getByText('Sending continuation request…', { exact: true }).waitFor()
  assert.equal(await controls.getByRole('button', { name: 'Continue task', exact: true }).isDisabled(), true)
  await controls.locator('form').evaluate(form => { form.requestSubmit(); form.requestSubmit() })
  await page.getByRole('button', { name: 'Browser', exact: true }).click()
  pending.release()
  await page.getByText('First review: continuation request failed', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Projects', exact: true }).click()
  await controls.getByRole('alert').waitFor()
  assert.match(await controls.getByRole('alert').innerText(), /task executor unavailable/i)
  assert.equal(await controls.getByRole('textbox', { name: 'Continuation objective' }).inputValue(), 'Preserve this uncertain request')
  assert.equal(await controls.getByRole('combobox', { name: 'Continuation budget' }).inputValue(), 'extended')
  assert.equal(calls.filter(call => call.path === '/api/tasks/continue').length, 1)
  await controls.scrollIntoViewIfNeeded()
  await page.screenshot({ path: '/tmp/chimera-task-continuity-desktop.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  await controls.getByRole('combobox', { name: 'Continuation budget' }).selectOption('standard')
  assert.equal(await controls.getByRole('textbox', { name: 'Continuation objective' }).inputValue(), 'Preserve this uncertain request')
  await controls.getByRole('button', { name: 'Continue task', exact: true }).click({ trial: true })
  await page.locator('.toast').waitFor({ state: 'hidden' })
  await page.screenshot({ path: '/tmp/chimera-task-continuity-mobile.png' })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  assert.equal(await page.locator('vite-error-overlay').count(), 0)
  assert.deepEqual(errors, [])
})

test('accepted continuation clears only its submitted draft after navigating away', { timeout: 20000 }, async t => {
  // Keeping the clearing callback on the unmounted form leaves accepted text
  // ready to repeat; clearing without identity checks destroys newer work.
  const pending = gate(t)
  const { page, controls, errors } = await fixture(t, { handler: async ({ route, path }) => {
    if (path !== '/api/tasks/continue') return false
    pending.arrive(); await pending.wait; await route.fulfill({ json: { taskId: 'continued' } }); return true
  } })
  await controls.getByRole('textbox', { name: 'Continuation objective' }).fill('Submitted from Queue')
  await controls.getByRole('button', { name: 'Continue task', exact: true }).click()
  await pending.arrived
  await page.getByRole('button', { name: 'Browser', exact: true }).click()
  pending.release()
  await page.getByText('First review: continuation accepted', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Projects', exact: true }).click()
  await controls.getByText('Explicit continuation queued; previous effects will not be replayed automatically', { exact: true }).waitFor()
  assert.equal(await controls.getByRole('textbox', { name: 'Continuation objective' }).inputValue(), '')
  assert.deepEqual(errors, [])
})

test('a reply cannot clear newer text entered for the same task from the other section', { timeout: 20000 }, async t => {
  const pending = gate(t)
  const { page, controls, errors } = await fixture(t, { handler: async ({ route, path }) => {
    if (path !== '/api/tasks/continue') return false
    pending.arrive(); await pending.wait; await route.fulfill({ json: { taskId: 'continued' } }); return true
  } })
  await controls.getByRole('textbox', { name: 'Continuation objective' }).fill('Original Queue objective')
  await controls.getByRole('button', { name: 'Continue task', exact: true }).click()
  await pending.arrived
  await page.getByRole('button', { name: 'Projects', exact: true }).click()
  await controls.getByRole('textbox', { name: 'Continuation objective' }).fill('Newer project-room objective')
  pending.release()
  await controls.getByText('Explicit continuation queued; previous effects will not be replayed automatically', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Work', exact: true }).click()
  assert.equal(await controls.getByRole('textbox', { name: 'Continuation objective' }).inputValue(), 'Newer project-room objective')
  assert.deepEqual(errors, [])
})

test('stop from Projects supersedes pending Queue guidance without converting it into a continuation', { timeout: 20000 }, async t => {
  const pending = gate(t)
  const { page, controls, calls, errors } = await fixture(t, { status: 'running', handler: async ({ route, path, state }) => {
    if (path === '/api/tasks/steer') { pending.arrive(); await pending.wait; await route.fulfill({ status: 503, json: { error: 'TASK_NO_LONGER_ACTIVE' } }); return true }
    if (path === '/api/tasks/cancel') { state.tasks[0].status = 'cancelled'; await route.fulfill({ json: state.tasks[0] }); return true }
    return false
  } })
  await controls.getByRole('textbox', { name: 'Task guidance' }).fill('Guidance is not a new objective')
  await controls.getByRole('button', { name: 'Guide task', exact: true }).click()
  await pending.arrived
  await page.getByRole('button', { name: 'Projects', exact: true }).click()
  await controls.getByRole('button', { name: 'Stop task', exact: true }).click()
  await controls.getByRole('textbox', { name: 'Continuation objective' }).waitFor()
  assert.equal(await controls.getByRole('textbox', { name: 'Continuation objective' }).inputValue(), '')
  assert.equal(await controls.getByRole('combobox', { name: 'Continuation budget' }).inputValue(), 'standard')
  await page.getByRole('button', { name: 'Work', exact: true }).click()
  await controls.getByRole('textbox', { name: 'Continuation objective' }).fill('Inspect cancelled work first')
  pending.release()
  await controls.getByRole('button', { name: 'Continue task', exact: true }).click({ trial: true })
  await controls.getByText('Task cancelled. Already-started effects cannot be undone.', { exact: true }).waitFor()
  assert.equal(await controls.getByRole('textbox', { name: 'Continuation objective' }).inputValue(), 'Inspect cancelled work first')
  assert.equal(await controls.getByRole('alert').count(), 0)
  assert.equal(calls.filter(call => call.path === '/api/tasks/cancel').length, 1)
  assert.equal(calls.filter(call => call.path === '/api/tasks/continue').length, 0)
  assert.deepEqual(errors, [])
})
