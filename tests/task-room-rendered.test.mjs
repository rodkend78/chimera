import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'

async function assertTextPainted(page, locator, screenshot) {
  const rectangle = await locator.boundingBox()
  const foreground = await locator.evaluate(element => getComputedStyle(element).color.match(/[\d.]+/g).slice(0, 3).map(Number))
  const pixels = await page.evaluate(async ({ png, rectangle, foreground }) => {
    const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode()
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0)
    const { data } = context.getImageData(0, 0, image.width, image.height)
    let ink = 0
    for (let y = Math.max(0, Math.ceil(rectangle.y)); y < Math.min(image.height, rectangle.y + rectangle.height); y++) {
      for (let x = Math.max(0, Math.ceil(rectangle.x)); x < Math.min(image.width, rectangle.x + rectangle.width); x++) {
        const offset = (y * image.width + x) * 4
        if (foreground.every((value, channel) => Math.abs(data[offset + channel] - value) < 35)) ink++
      }
    }
    return ink
  }, { png: screenshot.toString('base64'), rectangle, foreground })
  assert.ok(pixels > 20, `Terminal text must be painted in the captured PNG; found ${pixels} foreground pixels`)
}

test('rendered task room addresses participants through dock, replies, acknowledges, blocks inactive sends and stops on desktop/mobile', { timeout: 30000 }, async () => {
  // Browser plugin not available. Installed Playwright; fixture APIs on a
  // disposable localhost Vite port. Actual runtime/API effects tested separately.
  const server = await createServer({ configFile: new URL('../app/vite.config.js', import.meta.url).pathname,
    server: { host: '127.0.0.1', port: 0, hmr: false, proxy: {} } })
  await server.listen()
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(5000)
  const calls = [], errors = []
  let rejectGuidance = true
  const state = {
    agent: { id: 'ceo', name: 'RJ', status: 'Working' }, controller: { type: 'agent', id: 'ceo' }, suspended: false,
    browser: { running: true, tabs: [] }, activity: [], recentEvents: [], decisions: [], audit: { valid: true },
    models: { selected: { providerId: 'fixture', model: 'fixture' }, providers: [] }, auth: { codex: { connected: true, status: 'connected' } },
    agents: { specialists: [{ agentId: 'ace', displayName: 'Ace' }, { agentId: 'iris', displayName: 'Iris' }] },
    tasks: [{ taskId: 'room', objective: 'Review the shared evidence', status: 'running' }],
    teamMessaging: { tasks: [{ taskId: 'room', participants: ['ceo', 'ace', 'iris'], eligibleRecipients: ['ceo', 'ace', 'iris'], deliveries: [
      { messageId: 'handoff', senderAgentId: 'ceo', recipientAgentId: 'ace', status: 'waiting', waitingForAgentId: 'iris' },
      { messageId: 'expired', senderAgentId: 'ace', recipientAgentId: 'iris', status: 'expired', reason: 'GRANT_EXPIRED' },
    ] }] },
    conversations: { channels: [{ conversationId: 'task:room', kind: 'task-room', taskId: 'room', label: 'Review the shared evidence', detail: 'Task room' }],
      messages: [{ messageId: 'handoff', conversationId: 'task:room', taskId: 'room', senderAgentId: 'ceo', recipientAgentIds: ['ace'], role: 'rj', content: 'Review the evidence.', kind: 'task_handoff', status: 'completed', createdAt: new Date().toISOString(), provenance: { verification: 'verified' } },
        { messageId: 'ace-reply', replyTo: 'handoff', conversationId: 'task:room', taskId: 'room', senderAgentId: 'ace', recipientAgentIds: ['ceo'], role: 'agent', content: 'Evidence needs Iris.', kind: 'structured_result', status: 'failed', createdAt: new Date().toISOString(), provenance: { verification: 'verified' } }] },
  }
  try {
    page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error' && !m.text().includes('400 (Bad Request)')) errors.push(m.text()) })
    await page.routeWebSocket('**/api/browser/stream', socket => socket.onMessage(() => {}))
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname
      if (path === '/api/operator/session') return route.fulfill({ json: { csrfToken: 'fixture', expiresAt: new Date(Date.now() + 60000).toISOString() } })
      if (path === '/api/state') return route.fulfill({ json: state })
      const body = route.request().method() === 'POST' ? route.request().postDataJSON() : null
      calls.push({ path, body })
      if (path === '/api/tasks/message') {
        if (rejectGuidance) { rejectGuidance = false; return route.fulfill({ status: 400, json: { error: 'TASK_MESSAGE_RECIPIENT_INVALID' } }) }
        return route.fulfill({ json: { acknowledgement: 'Guidance saved. Applies only at the next safe boundary; finished assignments are not restarted.' } })
      }
      if (path === '/api/tasks/cancel') { state.tasks[0].status = 'cancelled'; state.teamMessaging.tasks[0].eligibleRecipients = []; state.teamMessaging.tasks[0].deliveries[0].status = 'interrupted' }
      return route.fulfill({ json: {} })
    })
    const url = `http://127.0.0.1:${server.httpServer.address().port}/`
    await page.goto(url); assert.equal(await page.title(), 'Chimera Browser Workspace')
    await page.getByRole('button', { name: 'Work', exact: true }).click()
    await page.getByRole('region', { name: 'Task collaboration' }).waitFor()
    await page.getByText('blocked (expired)', { exact: true }).waitFor()
    await page.getByRole('checkbox', { name: '@Ace' }).check()
    await page.getByRole('checkbox', { name: '@Iris' }).check()
    await page.getByRole('button', { name: 'Reply to Ace', exact: true }).click()
    await page.getByRole('button', { name: 'Clear reply' }).click()
    await page.getByRole('button', { name: 'Reply to Ace', exact: true }).click()
    await page.getByRole('textbox', { name: 'RJ queue objective' }).fill('Use the existing evidence only.')
    await page.getByRole('button', { name: 'Send task guidance' }).click()
    await page.getByText('task message recipient invalid', { exact: true }).waitFor()
    assert.equal(await page.getByRole('textbox', { name: 'RJ queue objective' }).inputValue(), 'Use the existing evidence only.')
    await page.getByRole('button', { name: 'Send task guidance' }).click()
    await page.getByText(/Guidance saved\. Applies only/).waitFor()
    assert.deepEqual(calls.find(call => call.path === '/api/tasks/message').body, { taskId: 'room', recipientAgentIds: ['ace', 'iris'], replyTo: 'ace-reply', content: 'Use the existing evidence only.' })
    await page.locator('.toast').waitFor({ state: 'hidden' })
    await page.getByText('Reply to RJ: Review the evidence.', { exact: true }).waitFor()
    await page.getByRole('region', { name: 'Task collaboration' }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: '/tmp/chimera-team-room-desktop.png' })
    await page.getByText('Reply to RJ: Review the evidence.', { exact: true }).scrollIntoViewIfNeeded()
    await page.locator('.queue-region').evaluate(element => { element.scrollTop = element.scrollHeight })
    await page.locator('.chat-transcript').evaluate(element => { element.scrollTop = element.scrollHeight })
    await page.screenshot({ path: '/tmp/chimera-team-room-thread.png' })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('region', { name: 'Task collaboration' }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: '/tmp/chimera-team-room-mobile.png' })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await page.getByRole('button', { name: 'Stop task', exact: true }).click()
    await page.getByText('Task cancelled. Guidance is inactive.', { exact: true }).waitFor()
    assert.equal(await page.getByRole('checkbox', { name: '@Ace' }).count(), 0)
    assert.equal(await page.getByRole('button', { name: 'Send task guidance' }).isDisabled(), true)
    await page.getByText('interrupted', { exact: true }).waitFor()
    await page.locator('.toast').waitFor({ state: 'hidden' })
    await page.getByText('Task cancelled. Guidance is inactive.', { exact: true }).scrollIntoViewIfNeeded()
    // Visibility can precede Chromium's paint after the nested mobile scroll.
    // Cross a rendering opportunity after fonts/layout settle before capturing.
    await page.evaluate(async () => {
      await document.fonts.ready
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    })
    const stopped = await page.screenshot({ path: '/tmp/chimera-team-room-stopped.png' })
    await assertTextPainted(page, page.getByText('Task cancelled. Guidance is inactive.', { exact: true }), stopped)
    state.tasks[0].status = 'completed'
    await page.reload(); await page.getByRole('button', { name: 'Work', exact: true }).click()
    await page.getByText('Task completed. Guidance is inactive.', { exact: true }).waitFor()
    state.teamMessaging.tasks[0].participants = []; state.teamMessaging.tasks[0].deliveries = []
    await page.reload(); await page.getByRole('button', { name: 'Work', exact: true }).click()
    await page.getByText('No peer assignments yet.', { exact: true }).waitFor()
    await page.getByText('No peer deliveries yet.', { exact: true }).waitFor()
    assert.equal(calls.some(call => call.path === '/api/conversations/messages' && call.body), false)
    assert.equal(await page.locator('vite-error-overlay').count(), 0)
    assert.deepEqual(errors, [])
  } catch (error) { console.error('Rendered diagnostics', errors, await page.locator('body').innerText()); throw error }
  finally { await browser.close(); await server.close() }
})
