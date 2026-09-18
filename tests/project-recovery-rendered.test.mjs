import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'

// Exercise the real React UI and API client; replace only disposable server
// responses so these failure tests never submit live work or touch source.
async function fixture(t, handler) {
  const server = await createServer({ configFile: new URL('../app/vite.config.js', import.meta.url).pathname,
    server: { host: '127.0.0.1', port: 0, hmr: false, proxy: {} } })
  await server.listen()
  const browser = await chromium.launch({ headless: true })
  t.after(async () => { await browser.close(); await server.close() })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  page.setDefaultTimeout(3000)
  const errors = [], calls = []
  const state = {
    agent: { id: 'ceo', name: 'RJ', status: 'Idle' }, controller: { type: 'agent', id: 'ceo' }, suspended: false,
    browser: { running: true, tabs: [] }, activity: [], recentEvents: [], decisions: [], audit: { valid: true },
    models: { selected: { providerId: 'fixture', model: 'fixture' }, providers: [] }, auth: { codex: { connected: true } },
    agents: { specialists: [] }, conversations: { channels: [], messages: [] },
    tasks: ['alpha', 'beta'].map(projectId => ({ taskId: `${projectId}-task`, projectId, objective: `${projectId} review`, status: 'completed', summary: `${projectId} result` })),
    projects: { projects: ['alpha', 'beta'].map(projectId => ({ projectId, name: projectId, defaultBranch: 'main', networkHosts: ['github.com'], source: { type: 'local', path: `/fixture/${projectId}` } })),
      sessions: ['alpha', 'beta'].map(projectId => ({ taskId: `${projectId}-task`, projectId, status: 'completed', branch: `chimera/${projectId}`, workspace: { relativeRoot: 'scratch/repo' }, plan: { tasks: [] } })), leases: [] },
  }
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => {
    if (['error', 'warning'].includes(message.type()) && !message.text().includes('503 (Service Unavailable)')) errors.push(message.text())
  })
  await page.routeWebSocket('**/api/browser/stream', socket => socket.onMessage(() => {}))
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/operator/session') return route.fulfill({ json: { csrfToken: 'fixture', expiresAt: new Date(Date.now() + 60000).toISOString() } })
    if (path === '/api/state') return route.fulfill({ json: state })
    const body = route.request().method() === 'POST' ? route.request().postDataJSON() : null
    calls.push({ path, body })
    if (await handler?.({ route, path, body, state })) return
    await route.fulfill({ json: {} })
  })
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`)
  assert.equal(await page.title(), 'Chimera Browser Workspace')
  await page.getByRole('button', { name: 'Projects', exact: true }).click()
  return { page, errors, calls }
}

async function leaveProjects(page) {
  await page.getByRole('button', { name: 'Work', exact: true }).click()
}

async function returnToProjects(page) {
  await page.getByRole('button', { name: 'Projects', exact: true }).click()
}

test('project drafts survive section navigation but source review must be explicitly reloaded', { timeout: 20000 }, async t => {
  const { page, errors, calls } = await fixture(t, async ({ route, path }) => {
    if (path !== '/api/projects/review') return false
    await route.fulfill({ json: { changedFiles: [{ path: 'readme.md', status: 'M' }], patch: '+ change', readyToCommit: true, status: 'completed', reviewDigest: 'review-one' } }); return true
  })
  await page.getByRole('combobox', { name: 'Repository mode' }).selectOption('managed')
  await page.getByRole('textbox', { name: 'Project name', exact: true }).fill('Next project')
  await page.getByRole('textbox', { name: /^Approved network hosts/ }).fill('github.com')
  await page.getByRole('button', { name: /^beta local/ }).click()
  await page.getByRole('textbox', { name: 'Objective for RJ', exact: true }).fill('Beta draft to retain')
  await page.getByRole('combobox', { name: 'Task access', exact: true }).selectOption('connected')
  await page.getByRole('textbox', { name: 'Hosts for this task' }).fill('github.com')
  await page.getByRole('button', { name: 'Review changes', exact: true }).click()
  await page.getByPlaceholder('Commit message', { exact: true }).fill('Unsubmitted commit')
  await leaveProjects(page)
  await returnToProjects(page)
  assert.equal(await page.getByRole('textbox', { name: 'Project name', exact: true }).inputValue(), 'Next project')
  assert.equal(await page.getByRole('combobox', { name: 'Repository mode' }).inputValue(), 'managed')
  assert.equal(await page.getByRole('textbox', { name: /^Approved network hosts/ }).inputValue(), 'github.com')
  assert.equal(await page.getByRole('heading', { name: 'beta', exact: true }).isVisible(), true)
  assert.equal(await page.getByRole('textbox', { name: 'Objective for RJ', exact: true }).inputValue(), 'Beta draft to retain')
  assert.equal(await page.getByRole('combobox', { name: 'Task access', exact: true }).inputValue(), 'connected')
  assert.equal(await page.getByRole('textbox', { name: 'Hosts for this task' }).inputValue(), 'github.com')
  assert.equal(await page.getByRole('button', { name: 'Commit to source', exact: true }).count(), 0)
  assert.equal(calls.filter(call => call.path === '/api/projects/review').length, 1, 'navigation never automatically reloads reviews')
  assert.equal(calls.filter(call => call.path === '/api/projects/commit').length, 0)
  await page.screenshot({ path: '/tmp/chimera-project-session-desktop.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: '/tmp/chimera-project-session-mobile.png' })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  assert.equal(await page.locator('vite-error-overlay').count(), 0)
  assert.deepEqual(errors, [])
})

test('pending project task stays locked across navigation and cannot retarget or erase a newer draft', { timeout: 20000 }, async t => {
  let release, arrived
  const pending = new Promise(resolve => { arrived = resolve })
  const { page, errors, calls } = await fixture(t, async ({ route, path, body, state }) => {
    if (path !== '/api/projects/tasks') return false
    arrived(); await new Promise(resolve => { release = resolve })
    const task = { ...body, taskId: 'alpha-next', status: 'queued' }
    state.tasks.push(task)
    await route.fulfill({ json: task }); return true
  })
  t.after(() => release?.())
  const objective = page.getByRole('textbox', { name: 'Objective for RJ', exact: true })
  await objective.fill('Original task')
  await page.getByRole('button', { name: 'Plan and delegate', exact: true }).click()
  await pending
  await leaveProjects(page)
  await returnToProjects(page)
  assert.equal(await objective.inputValue(), 'Original task')
  assert.equal(await page.getByRole('button', { name: 'Queuing…', exact: true }).isDisabled(), true)
  await objective.fill('New draft after returning')
  await page.locator('.project-task-form').evaluate(form => { form.requestSubmit(); form.requestSubmit() })
  await leaveProjects(page)
  release()
  await page.getByText('Project task queued. RJ will start it when the executor is available.', { exact: true }).waitFor()
  await returnToProjects(page)
  await page.locator('.project-operation-notice').filter({ hasText: /accepted/i }).waitFor()
  assert.equal(await objective.inputValue(), 'New draft after returning')
  assert.equal(await page.getByRole('combobox', { name: 'Task to control' }).inputValue(), 'alpha-task', 'late acceptance must not select a task after navigation')
  assert.equal(calls.filter(call => call.path === '/api/projects/tasks').length, 1)
  assert.deepEqual(errors, [])
})

test('late intake response preserves a changed intake mode and failure remains actionable after navigation', { timeout: 20000 }, async t => {
  let release, arrived
  const pending = new Promise(resolve => { arrived = resolve })
  const { page, errors, calls } = await fixture(t, async ({ route, path, body, state }) => {
    if (path === '/api/projects') {
      arrived(); await new Promise(resolve => { release = resolve })
      const project = { projectId: 'added', name: body.name, defaultBranch: 'main', networkHosts: [], source: { type: 'local', path: body.path } }
      state.projects.projects.push(project)
      await route.fulfill({ json: project }); return true
    }
    await route.fulfill({ status: 503, json: { error: 'PROJECT_TASK_UNAVAILABLE' } }); return true
  })
  t.after(() => release?.())
  await page.getByRole('textbox', { name: 'Project name', exact: true }).fill('Same name, different mode')
  await page.getByRole('textbox', { name: 'Repository path', exact: true }).fill('/fixture/new')
  await page.getByRole('button', { name: 'Add project', exact: true }).click()
  await pending
  await page.getByRole('combobox', { name: 'Repository mode' }).selectOption('managed')
  await leaveProjects(page)
  await returnToProjects(page)
  assert.equal(await page.getByRole('button', { name: 'Adding…', exact: true }).isDisabled(), true)
  release()
  await page.getByRole('button', { name: 'Create project', exact: true }).waitFor()
  assert.equal(await page.getByRole('textbox', { name: 'Project name', exact: true }).inputValue(), 'Same name, different mode')
  assert.equal(await page.getByRole('heading', { name: 'alpha', exact: true }).isVisible(), true)
  await page.getByRole('textbox', { name: 'Objective for RJ', exact: true }).fill('Keep this failed task')
  await page.getByRole('button', { name: 'Plan and delegate', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: /project task unavailable/i }).waitFor()
  await leaveProjects(page)
  await returnToProjects(page)
  assert.equal(await page.getByRole('alert').filter({ hasText: /project task unavailable/i }).isVisible(), true)
  assert.equal(await page.getByRole('textbox', { name: 'Objective for RJ', exact: true }).inputValue(), 'Keep this failed task')
  assert.equal(calls.filter(call => call.path === '/api/projects').length, 1)
  assert.equal(calls.filter(call => call.path === '/api/projects/tasks').length, 1)
  assert.deepEqual(errors, [])
})

test('pending source commit remains single-flight after navigation and cannot restore its old review', { timeout: 20000 }, async t => {
  let release, arrived
  const pending = new Promise(resolve => { arrived = resolve })
  const { page, errors, calls } = await fixture(t, async ({ route, path }) => {
    if (path === '/api/projects/review') {
      await route.fulfill({ json: { changedFiles: [{ path: 'readme.md', status: 'M' }], patch: '+ change', readyToCommit: true, status: 'completed', reviewDigest: 'review-one' } }); return true
    }
    if (path === '/api/projects/commit') {
      arrived(); await new Promise(resolve => { release = resolve })
      await route.fulfill({ json: { committed: true } }); return true
    }
    return false
  })
  t.after(() => release?.())
  await page.getByRole('button', { name: 'Review changes', exact: true }).click()
  await page.getByPlaceholder('Commit message', { exact: true }).fill('Deliver reviewed change')
  await page.getByRole('button', { name: 'Commit to source', exact: true }).click()
  await pending
  await leaveProjects(page)
  await returnToProjects(page)
  assert.equal(await page.getByRole('button', { name: 'Review changes', exact: true }).isDisabled(), true)
  assert.equal(await page.getByRole('button', { name: 'Commit to source', exact: true }).count(), 0)
  release()
  await page.locator('.project-operation-notice').filter({ hasText: /source commit accepted/i }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Review changes', exact: true }).isEnabled(), true)
  assert.equal(await page.getByRole('button', { name: 'Commit to source', exact: true }).count(), 0, 'late follow-up review belongs to the old view')
  assert.deepEqual(calls.filter(call => call.path === '/api/projects/commit').map(call => call.body), [{ taskId: 'alpha-task', message: 'Deliver reviewed change', expectedReviewDigest: 'review-one' }])
  assert.equal(calls.filter(call => call.path === '/api/projects/review').length, 2)
  await page.getByRole('button', { name: 'Review changes', exact: true }).click()
  await page.getByPlaceholder('Commit message', { exact: true }).waitFor()
  assert.equal(await page.getByPlaceholder('Commit message', { exact: true }).inputValue(), '')
  assert.equal(calls.filter(call => call.path === '/api/projects/review').length, 3, 'fresh review is explicit')
  assert.deepEqual(errors, [])
})

test('failed project actions preserve drafts and give persistent recovery without unhandled rejection', { timeout: 20000 }, async t => {
  const { page, errors, calls } = await fixture(t, async ({ route }) => {
    await route.fulfill({ status: 503, json: { error: 'PROJECT_REPOSITORY_UNAVAILABLE' } }); return true
  })
  await page.getByRole('textbox', { name: 'Project name', exact: true }).fill('My project')
  await page.getByRole('textbox', { name: 'Repository path', exact: true }).fill('/fixture/repo')
  await page.getByRole('button', { name: 'Add project', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: /project repository unavailable/i }).waitFor()
  await page.locator('.toast').waitFor({ state: 'hidden' })
  assert.deepEqual(errors, [], 'project failures must not escape the UI event handler')
  assert.equal(await page.getByRole('textbox', { name: 'Project name', exact: true }).inputValue(), 'My project')
  assert.equal(await page.getByRole('alert').isVisible(), true, 'recovery remains visible after the toast disappears')
  assert.equal(calls.filter(call => call.path === '/api/projects').length, 1, 'failed mutations are never auto-retried')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('alert').scrollIntoViewIfNeeded()
  await page.screenshot({ path: '/tmp/chimera-project-recovery-mobile.png' })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  assert.equal(await page.locator('vite-error-overlay').count(), 0)
  await page.getByRole('textbox', { name: 'Objective for RJ', exact: true }).fill('Keep my failed task objective')
  await page.getByRole('button', { name: 'Plan and delegate', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: /Queue task: alpha/ }).waitFor()
  assert.equal(await page.getByRole('textbox', { name: 'Objective for RJ', exact: true }).inputValue(), 'Keep my failed task objective')
  assert.equal(calls.filter(call => call.path === '/api/projects/tasks').length, 1)
  await page.getByRole('button', { name: 'Review changes', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: /Review changes: alpha/ }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Commit to source', exact: true }).count(), 0)
  assert.deepEqual(errors, [])
})

test('delayed repository intake preserves edited fields and the project selected in the meantime', { timeout: 20000 }, async t => {
  let release, arrived
  const pending = new Promise(resolve => { arrived = resolve })
  const { page, errors, calls } = await fixture(t, async ({ route, path, body, state }) => {
    if (path !== '/api/projects') return false
    arrived(); await new Promise(resolve => { release = resolve })
    const project = { projectId: 'new-repo', name: body.name, defaultBranch: 'main', networkHosts: body.networkHosts, source: { type: 'local', path: body.path } }
    state.projects.projects.push(project)
    await route.fulfill({ json: project }); return true
  })
  t.after(() => release?.())
  await page.getByRole('textbox', { name: 'Project name', exact: true }).fill('First repo')
  await page.getByRole('textbox', { name: 'Repository path', exact: true }).fill('/fixture/first')
  await page.getByRole('button', { name: 'Add project', exact: true }).click()
  await pending
  await page.getByRole('textbox', { name: 'Project name', exact: true }).fill('Second repo')
  await page.getByRole('textbox', { name: 'Repository path', exact: true }).fill('/fixture/second')
  await page.getByRole('textbox', { name: /^Approved network hosts/ }).fill('github.com')
  await page.getByRole('button', { name: /^beta local/ }).click()
  release()
  await page.getByRole('button', { name: /^First repo local/ }).waitFor()
  await page.getByRole('button', { name: 'Add project', exact: true }).waitFor()
  assert.equal(await page.getByRole('heading', { name: 'beta', exact: true }).isVisible(), true)
  assert.equal(await page.getByRole('textbox', { name: 'Project name', exact: true }).inputValue(), 'Second repo')
  assert.equal(await page.getByRole('textbox', { name: 'Repository path', exact: true }).inputValue(), '/fixture/second')
  assert.equal(await page.getByRole('textbox', { name: /^Approved network hosts/ }).inputValue(), 'github.com')
  assert.deepEqual(calls.filter(call => call.path === '/api/projects').map(call => call.body), [{ mode: 'local', name: 'First repo', path: '/fixture/first', networkHosts: [] }])
  assert.deepEqual(errors, [])
})

test('project drafts and access stay scoped while delayed submission cannot overwrite new work', { timeout: 20000 }, async t => {
  let release, arrived
  const pending = new Promise(resolve => { arrived = resolve })
  const { page, errors, calls } = await fixture(t, async ({ route, path, body, state }) => {
    if (path !== '/api/projects/tasks') return false
    arrived(); await new Promise(resolve => { release = resolve })
    const task = { ...body, taskId: 'alpha-next', status: 'queued' }
    state.tasks.push(task)
    await route.fulfill({ json: task }); return true
  })
  t.after(() => release?.())
  const objective = page.getByRole('textbox', { name: 'Objective for RJ', exact: true })
  await objective.fill('Alpha original objective')
  await page.getByRole('combobox', { name: 'Task access', exact: true }).selectOption('connected')
  await page.getByRole('textbox', { name: 'Hosts for this task' }).fill('github.com')
  // Two native submits in the same turn catch a missing synchronous guard,
  // even before React has rendered the disabled button.
  await page.locator('.project-task-form').evaluate(form => { form.requestSubmit(); form.requestSubmit() })
  await pending
  assert.equal(calls.filter(call => call.path === '/api/projects/tasks').length, 1)
  assert.equal(await page.getByRole('button', { name: 'Review changes', exact: true }).isDisabled(), true)
  await objective.fill('Alpha newer draft')
  await page.getByRole('button', { name: /^beta local/ }).click()
  assert.equal(await objective.inputValue(), '', 'another project must not inherit the submitted objective')
  assert.equal(await page.getByRole('combobox', { name: 'Task access', exact: true }).inputValue(), 'sandbox')
  await objective.fill('Beta draft')
  assert.equal(await page.getByRole('button', { name: 'Queuing…', exact: true }).isDisabled(), true)
  release()
  await page.getByRole('button', { name: 'Queue project task', exact: true }).waitFor()
  assert.equal(await objective.inputValue(), 'Beta draft')
  assert.equal(await page.getByRole('combobox', { name: 'Task to control' }).inputValue(), 'beta-task')
  await page.getByRole('button', { name: /^alpha local/ }).click()
  assert.equal(await objective.inputValue(), 'Alpha newer draft')
  assert.equal(await page.getByRole('combobox', { name: 'Task access', exact: true }).inputValue(), 'connected')
  assert.equal(await page.getByRole('textbox', { name: 'Hosts for this task' }).inputValue(), 'github.com')
  assert.deepEqual(calls.filter(call => call.path === '/api/projects/tasks').map(call => call.body), [{ projectId: 'alpha', objective: 'Alpha original objective', access: { profileId: 'connected', networkHosts: ['github.com'], ttlSeconds: 900 } }])
  assert.deepEqual(errors, [])
})

test('acknowledged commit invalidates its review even if the subsequent review fails', { timeout: 20000 }, async t => {
  let reviews = 0
  const { page, errors, calls } = await fixture(t, async ({ route, path }) => {
    if (path === '/api/projects/review') {
      reviews++
      await route.fulfill(reviews === 1 ? { json: { changedFiles: [{ path: 'readme.md', status: 'M' }], patch: '+ reviewed change', readyToCommit: true, status: 'completed', reviewDigest: 'review-one' } }
        : { status: 503, json: { error: 'PROJECT_REVIEW_UNAVAILABLE' } }); return true
    }
    return false
  })
  await page.getByRole('button', { name: 'Review changes', exact: true }).click()
  await page.getByPlaceholder('Commit message', { exact: true }).fill('Deliver reviewed change')
  await page.getByRole('button', { name: 'Commit to source', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: /commit succeeded/i }).waitFor()
  await page.locator('.toast').waitFor({ state: 'hidden' })
  assert.equal(await page.getByRole('button', { name: 'Commit to source', exact: true }).count(), 0, 'an accepted commit must invalidate its old review')
  await page.getByRole('alert').scrollIntoViewIfNeeded()
  await page.screenshot({ path: '/tmp/chimera-project-recovery-desktop.png' })
  assert.deepEqual(calls.filter(call => call.path === '/api/projects/commit').map(call => call.body), [{ taskId: 'alpha-task', message: 'Deliver reviewed change', expectedReviewDigest: 'review-one' }])
  assert.deepEqual(errors, [])
})
