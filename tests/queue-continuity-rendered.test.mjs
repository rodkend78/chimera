import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const message = (room, id, content) => ({ messageId: id, conversationId: `task:${room}`, taskId: room,
  senderAgentId: 'ace', recipientAgentIds: ['ceo'], role: 'agent', kind: 'structured_result', status: 'completed',
  content, createdAt: '2026-09-07T06:00:00Z', provenance: { verification: 'verified' } })
const betaOld = message('beta', 'beta-old', 'Earlier Beta evidence')
const gamma = { taskId: 'gamma', objective: 'Gamma archived review', status: 'completed', summary: 'Earlier completed work.' }

async function fixture(t, handler) {
  // Browser plugin unavailable. Real React/client; only loopback HTTP/WS fixtures.
  const server = await createServer({ configFile: new URL('../app/vite.config.js', import.meta.url).pathname,
    server: { host: '127.0.0.1', port: 0, hmr: false, proxy: {} } })
  await server.listen()
  const browser = await chromium.launch({ headless: true })
  t.after(async () => { await browser.close(); await server.close() })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  page.setDefaultTimeout(3000)
  const state = {
    agent: { id: 'ceo', name: 'RJ', status: 'Working' }, controller: { type: 'agent', id: 'ceo' }, suspended: false,
    draftScope: { schema: 'chimera.draft-scope.v1', workspaceId: 'queue-continuity-fixture', operatorId: 'operator-fixture' },
    browser: { running: true, tabs: [] }, activity: [], recentEvents: [], decisions: [], audit: { valid: true },
    models: { selected: { providerId: 'fixture', model: 'fixture', providerName: 'Fixture', modelName: 'Fixture' }, providers: [] },
    auth: { codex: { connected: true, status: 'connected' } }, agents: { main: { agentId: 'ceo', displayName: 'RJ', role: 'CEO' }, specialists: [{ agentId: 'ace', displayName: 'Ace' }] },
    tasks: [{ taskId: 'alpha', objective: 'Alpha website review', status: 'running' }, { taskId: 'beta', objective: 'Beta export review', status: 'queued' }],
    teamMessaging: { tasks: ['alpha', 'beta'].map(taskId => ({ taskId, eligibleRecipients: ['ace'], participants: ['ceo', 'ace'], deliveries: [] })) },
    conversations: { channels: [
      { conversationId: 'main', kind: 'hq', recipientAgentId: 'ceo', label: 'RJ headquarters', detail: 'Main conversation' },
      ...['alpha', 'beta'].map(taskId => ({ conversationId: `task:${taskId}`, taskId, kind: 'task-room', label: taskId === 'alpha' ? 'Alpha website review' : 'Beta export review', detail: 'Task room' })),
    ], messages: [message('alpha', 'alpha-recent', 'Recent Alpha evidence'), message('beta', 'beta-recent', 'Recent Beta evidence')] },
  }
  const calls = [], errors = []
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
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', m => { if (['error', 'warning'].includes(m.type()) && !m.text().includes('503 (Service Unavailable)')) errors.push(m.text()) })
  await page.routeWebSocket('**/api/browser/stream', socket => socket.onMessage(() => {}))
  await page.route('**/*', async route => {
    const url = new URL(route.request().url()), path = url.pathname
    if (url.hostname !== '127.0.0.1') throw new Error(`Unexpected external request: ${url.origin}`)
    if (!path.startsWith('/api/')) return route.continue()
    if (path === '/api/operator/session') return route.fulfill({ json: { csrfToken: 'fixture', expiresAt: '2099-01-01T00:00:00Z' } })
    const body = route.request().method() === 'POST' ? route.request().postDataJSON() : null
    // Selecting a task room now also reads the task-bound workspace. That is
    // a separate read model, not conversation/task history, so keep it out of
    // the history/action call ledger used by these continuity assertions.
    const workspacePath = path.startsWith('/api/tasks/') && path.endsWith('/workspace')
    if (workspacePath) {
      assert.equal(route.request().method(), 'GET', 'workspace reads must never hide a write')
      const taskId = decodeURIComponent(path.slice('/api/tasks/'.length, -'/workspace'.length))
      return route.fulfill({ json: workspace(taskId) })
    }
    if (path !== '/api/state') calls.push({ path, body, conversationId: url.searchParams.get('conversationId'), before: url.searchParams.get('before') })
    if (await handler?.({ path, body, route, state, url })) return
    await route.fulfill({ json: path === '/api/state' ? state : path === '/api/tasks' ? { tasks: [gamma], nextCursor: null }
      : path === '/api/conversations/messages' ? { messages: [betaOld], nextCursor: null } : {} })
  })
  const url = `http://127.0.0.1:${server.httpServer.address().port}/`
  await page.goto(url)
  assert.equal(page.url(), url)
  assert.equal(await page.title(), 'Chimera Browser Workspace')
  await page.getByRole('button', { name: 'Work', exact: true }).click()
  await page.getByRole('heading', { name: 'What are we working on?', exact: true }).waitFor()
  const rooms = page.getByLabel('Work history', { exact: true })
  return { page, rooms, state, calls, errors }
}
async function roundTrip(page) {
  if (await page.getByRole('button', { name: 'More tools', exact: true }).getAttribute('aria-expanded') === 'false') await page.getByRole('button', { name: 'More tools', exact: true }).click()
  await page.getByRole('button', { name: 'Media', exact: true }).click()
  await page.getByRole('button', { name: 'Work', exact: true }).click()
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const betaRoom = rooms => rooms.getByRole('button', { name: 'Beta export review Task room', exact: true })

test('Queue restores the viewed room after navigation but clears old reply recipients', { timeout: 20000 }, async t => {
  const { page, rooms, calls, errors } = await fixture(t)
  await betaRoom(rooms).click()
  await page.getByRole('checkbox', { name: '@Ace', exact: true }).check()
  await page.getByRole('button', { name: 'Reply to Ace', exact: true }).click()
  await roundTrip(page)
  assert.match(await page.locator('.chat-thread-header').textContent(), /Beta export review/)
  assert.equal(await page.getByRole('combobox', { name: 'Task to control' }).inputValue(), 'beta')
  assert.equal(await page.getByRole('checkbox', { name: '@Ace', exact: true }).isChecked(), false)
  assert.equal(await page.locator('.dock-address').count(), 0)
  assert.equal(calls.length, 0)
  assert.deepEqual(errors, [])
})

test('older tasks and room messages survive navigation and the next read uses the retained cursor', { timeout: 20000 }, async t => {
  const { page, rooms, calls, errors } = await fixture(t)
  await page.getByRole('button', { name: 'Load older tasks', exact: true }).click()
  await rooms.getByRole('button', { name: /Gamma archived review/ }).waitFor()
  await betaRoom(rooms).click()
  await page.getByRole('button', { name: 'Load older messages', exact: true }).click()
  await page.getByLabel('Conversation transcript', { exact: true }).getByText('Earlier Beta evidence', { exact: true }).waitFor()
  await roundTrip(page)
  assert.equal(await rooms.getByRole('button', { name: /Gamma archived review/ }).count(), 1)
  assert.equal(await page.getByLabel('Conversation transcript', { exact: true }).getByText('Earlier Beta evidence', { exact: true }).count(), 1)
  assert.equal(calls.length, 2, 'navigation must not fetch history again')
  await page.getByRole('button', { name: 'Load older messages', exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('.chat-transcript .history-load').disabled)
  assert.deepEqual(calls.filter(c => c.path === '/api/conversations/messages').map(c => [c.conversationId, c.before]), [['task:beta', 'beta-recent'], ['task:beta', 'beta-old']])
  assert.equal(await page.getByLabel('Conversation transcript', { exact: true }).getByText('Earlier Beta evidence', { exact: true }).count(), 1)
  assert.equal(calls.some(c => c.body), false)
  assert.deepEqual(errors, [])
})

test('late history reads remain single-flight across navigation and cannot switch the selected room', { timeout: 20000 }, async t => {
  const started = deferred(), release = deferred()
  const { page, rooms, calls, errors } = await fixture(t, async ({ path, route }) => {
    if (path !== '/api/conversations/messages') return false
    started.resolve(); await release.promise
    await route.fulfill({ json: { messages: [betaOld], nextCursor: null } }); return true
  })
  t.after(() => release.resolve())
  await betaRoom(rooms).click()
  await page.getByRole('button', { name: 'Load older messages', exact: true }).evaluate(button => { button.click(); button.click() })
  await started.promise
  await roundTrip(page)
  assert.equal(await page.getByRole('button', { name: 'Load older messages', exact: true }).isDisabled(), true)
  await rooms.getByRole('button', { name: 'Alpha website review Task room', exact: true }).click()
  if (await page.getByRole('button', { name: 'More tools', exact: true }).getAttribute('aria-expanded') === 'false') await page.getByRole('button', { name: 'More tools', exact: true }).click()
  await page.getByRole('button', { name: 'Media', exact: true }).click()
  const completed = page.waitForResponse(r => new URL(r.url()).pathname === '/api/conversations/messages')
  release.resolve(); await completed
  await page.getByRole('button', { name: 'Work', exact: true }).click()
  assert.match(await page.locator('.chat-thread-header').textContent(), /Alpha website review/)
  assert.equal(await page.getByLabel('Conversation transcript', { exact: true }).getByText('Earlier Beta evidence', { exact: true }).count(), 0)
  await betaRoom(rooms).click()
  await page.getByLabel('Conversation transcript', { exact: true }).getByText('Earlier Beta evidence', { exact: true }).waitFor()
  assert.deepEqual(calls.filter(c => c.path === '/api/conversations/messages').map(c => [c.conversationId, c.before]), [['task:beta', 'beta-recent']])
  assert.equal(calls.some(c => c.body), false)
  assert.deepEqual(errors, [])
})

test('failed history reads retain readable room-specific feedback across navigation and retry only explicitly', { timeout: 20000 }, async t => {
  let reads = 0
  const { page, rooms, calls, errors } = await fixture(t, async ({ path, route }) => {
    if (path !== '/api/conversations/messages') return false
    await route.fulfill(++reads === 1 ? { status: 503, json: { error: 'HISTORY_UNAVAILABLE' } } : { json: { messages: [betaOld], nextCursor: null } }); return true
  })
  await betaRoom(rooms).click()
  await page.getByRole('button', { name: 'Load older messages', exact: true }).click()
  const notice = page.getByRole('region', { name: 'History read status', exact: true })
  await notice.getByRole('alert').waitFor()
  await roundTrip(page)
  assert.match(await notice.textContent(), /Beta export review/)
  assert.match(await notice.textContent(), /history unavailable/i)
  assert.equal(calls.length, 1)
  await notice.scrollIntoViewIfNeeded()
  await page.screenshot({ path: '/tmp/chimera-queue-history-desktop.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  await notice.scrollIntoViewIfNeeded()
  await page.screenshot({ path: '/tmp/chimera-queue-history-mobile.png' })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  assert.equal(await page.locator('vite-error-overlay').count(), 0)
  await page.getByRole('button', { name: 'Load older messages', exact: true }).click()
  await page.getByLabel('Conversation transcript', { exact: true }).getByText('Earlier Beta evidence', { exact: true }).waitFor()
  assert.equal(await notice.getByRole('alert').count(), 0)
  assert.equal(calls.length, 2)
  assert.equal(calls.some(c => c.body), false)
  assert.deepEqual(errors, [])
})

test('history from another room cannot be attributed to the selected conversation', { timeout: 20000 }, async t => {
  const { page, rooms, errors } = await fixture(t, async ({ path, route }) => {
    if (path !== '/api/conversations/messages') return false
    await route.fulfill({ json: { messages: [message('alpha', 'wrong-room', 'Wrong room evidence')], nextCursor: null } }); return true
  })
  await betaRoom(rooms).click()
  await page.getByRole('button', { name: 'Load older messages', exact: true }).click()
  await page.getByRole('region', { name: 'History read status', exact: true }).getByRole('alert').waitFor()
  assert.equal(await page.getByText('Wrong room evidence', { exact: true }).count(), 0)
  assert.equal(await page.getByLabel('Conversation transcript', { exact: true }).getByText('Recent Beta evidence', { exact: true }).count(), 1)
  assert.deepEqual(errors, [])
})

test('navigation does not replace a disappeared selected room with a different active task', { timeout: 20000 }, async t => {
  const { page, rooms, state, calls, errors } = await fixture(t)
  await betaRoom(rooms).click()
  state.tasks = state.tasks.filter(task => task.taskId !== 'beta')
  state.conversations.channels = state.conversations.channels.filter(room => room.conversationId !== 'task:beta')
  await page.getByText('Selected conversation unavailable. Choose another room or load older tasks.', { exact: true }).waitFor()
  await roundTrip(page)
  assert.match(await page.locator('.chat-thread-header').textContent(), /Conversation unavailable/)
  assert.equal(await page.getByRole('region', { name: 'Task recovery and control', exact: true }).count(), 0)
  assert.equal(calls.length, 0)
  assert.deepEqual(errors, [])
})

test('overlapping task-history pages produce one selectable record for each task', { timeout: 20000 }, async t => {
  let reads = 0
  const { page, rooms, calls, errors } = await fixture(t, async ({ path, route }) => {
    if (path !== '/api/tasks') return false
    await route.fulfill({ json: { tasks: ++reads === 1 ? [gamma] : [gamma, { taskId: 'delta', objective: 'Delta archived work', status: 'completed' }], nextCursor: null } }); return true
  })
  await page.getByRole('button', { name: 'Load older tasks', exact: true }).click()
  await rooms.getByRole('button', { name: /Gamma archived review/ }).waitFor()
  await page.getByRole('button', { name: 'Load older tasks', exact: true }).click()
  await rooms.getByRole('button', { name: /Delta archived work/ }).waitFor()
  assert.equal(await rooms.getByRole('button', { name: /Gamma archived review/ }).count(), 1)
  assert.equal(await page.getByLabel('RJ queue', { exact: true }).getByRole('button', { name: /Gamma archived review/ }).count(), 1)
  assert.deepEqual(calls.map(c => c.before), ['beta', 'gamma'])
  assert.deepEqual(errors, [])
})

for (const kind of ['tasks', 'messages']) {
  test(`malformed ${kind} history keeps existing records and explains the incomplete response`, { timeout: 20000 }, async t => {
    const { page, rooms, calls, errors } = await fixture(t, async ({ path, route }) => {
      if (path !== (kind === 'tasks' ? '/api/tasks' : '/api/conversations/messages')) return false
      await route.fulfill({ json: { [kind]: [null], nextCursor: null } }); return true
    })
    await betaRoom(rooms).click()
    await page.getByRole('button', { name: `Load older ${kind}`, exact: true }).click()
    const alert = page.getByRole('region', { name: 'History read status', exact: true }).getByRole('alert')
    await alert.waitFor()
    assert.match(await alert.textContent(), /response did not identify/i)
    assert.equal(await page.getByLabel('Conversation transcript', { exact: true }).getByText('Recent Beta evidence', { exact: true }).count(), 1)
    assert.equal(await betaRoom(rooms).count(), 1)
    assert.equal(calls.length, 1)
    assert.deepEqual(errors, [])
  })
}

async function scrollingFixture(t, handler) {
  let seeded = false
  return fixture(t, async request => {
    if (request.path === '/api/state' && !seeded) {
      seeded = true
      request.state.conversations.messages = ['alpha', 'beta'].flatMap(room => Array.from({ length: 40 }, (_, i) =>
        message(room, `${room}-${i}`, `${room} evidence ${i}. This detailed fixture report preserves the original findings, review notes and specialist attribution for the operator.`)))
    }
    return handler?.(request)
  })
}
const scrollTo = (transcript, top) => transcript.evaluate((node, value) => {
  node.scrollTop = value; node.dispatchEvent(new Event('scroll', { bubbles: true }))
}, top)
const readingAnchor = transcript => transcript.evaluate(node => {
  const top = node.getBoundingClientRect().top
  const row = [...node.querySelectorAll('.conversation-message')].find(row => row.getBoundingClientRect().bottom > top + 1)
  return { text: row.querySelector('p').textContent, offset: row.getBoundingClientRect().top - top }
})
async function assertAnchor(transcript, anchor) {
  const offset = await transcript.evaluate((node, text) => [...node.querySelectorAll('.conversation-message')]
    .find(row => row.querySelector('p').textContent === text)?.getBoundingClientRect().top - node.getBoundingClientRect().top, anchor.text)
  assert.ok(Math.abs(offset - anchor.offset) <= 2, `reading anchor moved from ${anchor.offset} to ${offset}`)
}

test('new transcript messages preserve an older reading position until Jump to latest is chosen', { timeout: 20000 }, async t => {
  const { page, state, calls, errors } = await scrollingFixture(t)
  const transcript = page.locator('.chat-transcript')
  await scrollTo(transcript, 1800)
  const anchor = await readingAnchor(transcript)
  state.conversations.messages.push(message('alpha', 'alpha-new', 'New Alpha findings'))
  await page.getByLabel('Conversation transcript', { exact: true }).getByText('New Alpha findings', { exact: true }).waitFor({ state: 'attached' })
  await assertAnchor(transcript, anchor)
  const latest = page.getByRole('button', { name: 'Jump to latest', exact: true })
  await latest.click()
  await page.waitForFunction(() => {
    const node = document.querySelector('.chat-transcript'); return node.scrollHeight - node.scrollTop - node.clientHeight < 2
  })
  assert.equal(await latest.count(), 0)
  assert.equal(calls.length, 0)
  assert.deepEqual(errors, [])
})

test('following latest transcript messages never scrolls the surrounding Queue workspace', { timeout: 20000 }, async t => {
  const { page, state, calls, errors } = await scrollingFixture(t)
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  assert.equal(await page.locator('.queue-region').evaluate(node => node.scrollTop), 0, 'opening Queue must not jump past its header')
  state.conversations.messages.push(message('alpha', 'alpha-follow', 'Latest Alpha follow-up'))
  await page.getByLabel('Conversation transcript', { exact: true }).getByText('Latest Alpha follow-up', { exact: true }).waitFor({ state: 'attached' })
  await page.waitForFunction(() => {
    const node = document.querySelector('.chat-transcript'); return node.scrollHeight - node.scrollTop - node.clientHeight < 2
  })
  assert.equal(await page.locator('.queue-region').evaluate(node => node.scrollTop), 0)
  assert.equal(calls.length, 0)
  assert.deepEqual(errors, [])
})

test('each conversation keeps its reading anchor across room changes and section navigation', { timeout: 20000 }, async t => {
  const { page, rooms, calls, errors } = await scrollingFixture(t)
  const transcript = page.locator('.chat-transcript')
  await scrollTo(transcript, 1600)
  const alpha = await readingAnchor(transcript)
  await betaRoom(rooms).click()
  await scrollTo(transcript, 2200)
  const beta = await readingAnchor(transcript)
  await roundTrip(page)
  await assertAnchor(transcript, beta)
  await rooms.getByRole('button', { name: 'Alpha website review Task room', exact: true }).click()
  await assertAnchor(transcript, alpha)
  assert.equal(calls.length, 0)
  assert.deepEqual(errors, [])
})

test('older messages arriving during reading preserve the visible anchor and expose a local latest control', { timeout: 20000 }, async t => {
  const started = deferred(), release = deferred()
  const { page, calls, errors } = await scrollingFixture(t, async ({ path, route }) => {
    if (path !== '/api/conversations/messages') return false
    started.resolve(); await release.promise
    await route.fulfill({ json: { messages: Array.from({ length: 8 }, (_, i) => message('alpha', `alpha-older-${i}`, `Archived Alpha evidence ${i}`)), nextCursor: null } }); return true
  })
  t.after(() => release.resolve())
  await page.getByRole('button', { name: 'Load older messages', exact: true }).click()
  await started.promise
  const transcript = page.locator('.chat-transcript')
  await scrollTo(transcript, 1700)
  const anchor = await readingAnchor(transcript)
  release.resolve()
  await page.getByLabel('Conversation transcript', { exact: true }).getByText('Archived Alpha evidence 0', { exact: true }).waitFor({ state: 'attached' })
  await assertAnchor(transcript, anchor)
  const latest = page.getByRole('button', { name: 'Jump to latest', exact: true })
  await latest.scrollIntoViewIfNeeded()
  await page.screenshot({ path: '/tmp/chimera-transcript-reading-desktop.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  await latest.scrollIntoViewIfNeeded()
  await assertAnchor(transcript, anchor)
  await page.screenshot({ path: '/tmp/chimera-transcript-reading-mobile.png' })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  assert.equal(await page.locator('vite-error-overlay').count(), 0)
  assert.equal(calls.length, 1)
  assert.equal(calls.some(c => c.body), false)
  await latest.focus(); await latest.press('Enter')
  await page.waitForFunction(() => {
    const node = document.querySelector('.chat-transcript'); return node.scrollHeight - node.scrollTop - node.clientHeight < 2
  })
  assert.deepEqual(errors, [])
})

test('reading collaboration controls above messages is not displaced by an older history response', { timeout: 20000 }, async t => {
  const started = deferred(), release = deferred()
  const { page, errors } = await scrollingFixture(t, async ({ path, state, route }) => {
    if (path === '/api/state') {
      state.teamMessaging.tasks[0].participants = Array.from({ length: 24 }, (_, i) => `specialist-${i}-reviewer`)
      state.teamMessaging.tasks[0].deliveries = Array.from({ length: 20 }, (_, i) => ({ messageId: `delivery-${i}`, senderAgentId: 'ceo', recipientAgentId: 'ace', status: 'completed' }))
    }
    if (path !== '/api/conversations/messages') return false
    started.resolve(); await release.promise
    await route.fulfill({ json: { messages: [message('alpha', 'alpha-archive', 'Archived before the current evidence')], nextCursor: null } }); return true
  })
  t.after(() => release.resolve())
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Load older messages', exact: true }).click()
  await started.promise
  const transcript = page.locator('.chat-transcript')
  await scrollTo(transcript, 0)
  assert.equal(await transcript.evaluate(node => node.querySelector('.conversation-message').getBoundingClientRect().top >= node.getBoundingClientRect().bottom), true)
  release.resolve()
  await page.getByLabel('Conversation transcript', { exact: true }).getByText('Archived before the current evidence', { exact: true }).waitFor({ state: 'attached' })
  assert.equal(await transcript.evaluate(node => node.scrollTop), 0)
  assert.deepEqual(errors, [])
})
