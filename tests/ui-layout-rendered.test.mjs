import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const roster = ['researcher', 'ace', 'ada', 'ash', 'genie', 'inboxarchitect', 'iris', 'paul-blart', 'sam']
const names = ['Researcher', 'Ace', 'Ada', 'Ash', 'Genie', 'Inbox Architect', 'Iris', 'Paul Blart', 'Sam']
const access = { profileId: 'sandbox', label: 'Sandbox', description: 'Private workspace only. No network access.', network: 'none' }
const model = { id: 'long-conversation-model', name: 'Anthropic Claude Opus · long model name for layout coverage', provider: 'Anthropic', availability: 'verified-route', capabilities: ['conversation', 'research', 'coding'] }
const now = '2026-09-06T05:00:00.000Z'
const client = { id: 'layout-fixture', name: 'Responsive client workspace fixture', summary: 'Synthetic layout coverage only, no imported customer data.', status: 'pilot', documentCount: 1 }
const document = { id: 'layout-source', title: 'Responsive source with a descriptive evidence title', category: 'notes', kind: 'document', status: 'imported', origin: { label: 'Synthetic fixture', ref: 'fixture:layout' }, content: 'Synthetic source text for responsive reader coverage.' }

function fixture() {
  return {
    agent: { id: 'ceo', name: 'RJ', status: 'Idle' }, controller: { type: 'agent', id: 'ceo' }, suspended: false,
    browser: { running: true, tabs: [{ tabId: 'one', title: 'A website with a longer browser tab title', url: 'https://example.com/', active: true }] },
    recentEvents: [], audit: { valid: true },
    activity: [{ sequence: 1, label: 'Iris completed the operational handoff and returned attributed evidence to RJ', kind: 'task.completed', at: now }],
    decisions: [{ actionId: 'review-only', title: 'Review a consequential project action with a descriptive title', detail: 'Inspect the exact repository and expected commit before proceeding.', agent: { agentId: 'ace' }, actionDiff: { review: { fields: { Repository: 'team-rsi/chimera-interface-review', 'Expected head SHA': 'a'.repeat(40) } } } }],
    models: { selected: { providerId: 'aws-bedrock', model: model.id, modelName: model.name, providerName: 'AWS Bedrock' }, providers: [{ id: 'aws-bedrock', name: 'AWS Bedrock', configured: true, region: 'us-west-2', models: [model,
      { id: 'stability.image', name: 'Stability Image', provider: 'Stability', adapter: 'ready', availability: 'verified-route', capabilities: ['image-generation'] },
      { id: 'luma.video', name: 'Luma Video', provider: 'Luma', adapter: 'ready', availability: 'verified-route', capabilities: ['video-generation'] }] }] },
    auth: { codex: { connected: true, status: 'connected' } },
    agents: { main: { agentId: 'ceo', displayName: 'RJ', access }, accessProfiles: [access],
      specialists: roster.map((agentId, i) => ({ agentId, displayName: names[i], role: 'General specialist', capabilities: ['general'], access,
        status: 'Ready', harnessState: i === 0 ? 'Built in' : 'Registered', source: { type: i === 0 ? 'chimera' : 'hermes', ref: `hermes://configured-hermes/profiles/${agentId}` },
        modelPreference: i === 1 ? { mode: 'pinned', providerId: 'aws-bedrock', model: model.id } : { mode: 'auto' } })) },
    tasks: [{ taskId: 'example-task', objective: 'Review responsive controls and prepare a clear handoff for the entire team', status: 'completed', summary: 'Spacing reviewed; acceptance evidence is ready.' }],
    conversations: { channels: [{ conversationId: 'main', kind: 'hq', label: 'RJ', recipientAgentId: 'ceo', detail: 'Main conversation' }, { conversationId: 'agent:iris', kind: 'agent', recipientAgentId: 'iris', label: 'Iris', detail: 'Operations' }, { conversationId: 'task:example-task', kind: 'task-room', label: 'Review responsive controls and prepare a clear handoff', detail: 'Completed task room' }],
      messages: [{ messageId: 'reply', conversationId: 'task:example-task', senderAgentId: 'iris', recipientAgentIds: ['ceo'], role: 'agent', kind: 'structured_result', status: 'completed', content: 'The operational review is complete. A long_unbroken_reference_for_responsive_layout_verification_must_not_cover_the_status_badge_or_escape_its_message.', createdAt: now }] },
    workers: { limits: { activeSessions: 4 }, artifacts: [], sessions: [{ workerSessionId: 'worker-example', agentId: 'inboxarchitect', kind: 'code', status: 'stopped', expiresAt: now, controller: { type: 'agent' }, artifacts: [] }] },
    projects: { projects: [{ projectId: 'example-project', name: 'Team RSI responsive workspace review', source: { type: 'local', path: '/workspace/team-rsi/chimera-interface-review' }, defaultBranch: 'main', networkHosts: [] }], sessions: [], leases: [] },
  }
}

// Catches controls escaping cards, header text painting under adjacent badges,
// and main sections pushing navigation/dock outside the viewport. Real React +
// CSS; only backend responses are fixtures, so no tasks or paid APIs are invoked.
test('all workspace sections keep controls contained at desktop, tablet and phone widths', { timeout: 60000 }, async t => {
  // Browser plugin not available: use the installed Playwright against Vite.
  const server = await createServer({ configFile: new URL('../app/vite.config.js', import.meta.url).pathname,
    server: { host: '127.0.0.1', port: 0, hmr: false, proxy: {} } })
  await server.listen()
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
  page.setDefaultTimeout(5000)
  const errors = [], findings = [], state = fixture()
  try {
    page.on('pageerror', e => errors.push(e.message))
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
    await page.routeWebSocket('**/api/browser/stream', socket => socket.onMessage(() => {}))
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname
      if (path === '/api/state') return route.fulfill({ json: state })
      if (path === '/api/clients') return route.fulfill({ json: { state: 'ready', clients: [client] } })
      if (path === '/api/clients/layout-fixture') return route.fulfill({ json: { client, documents: [document], notes: [], coverage: [{ source: 'Synthetic fixture', status: 'imported', details: 'Layout test only.' }] } })
      if (path === '/api/clients/layout-fixture/documents/layout-source') return route.fulfill({ json: document })
      if (path === '/api/account-browser/state') return route.fulfill({ json: { status: 'available' } })
      if (path === '/api/account-companion/state') return route.fulfill({ json: { paired: false, leases: [] } })
      if (path === '/api/agents/model') {
        const body = route.request().postDataJSON()
        const agent = state.agents.specialists.find(a => a.agentId === body.agentId) ?? state.agents.main
        const { agentId: _agentId, ...preference } = body
        agent.modelPreference = preference
        return route.fulfill({ json: preference })
      }
      return route.fulfill({ json: { csrfToken: 'fixture', expiresAt: '2099-01-01T00:00:00Z', status: 'allowed', result: { upload: { pending: false }, downloads: [] } } })
    })
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`)
    assert.equal(await page.title(), 'Chimera Browser Workspace')
    const nav = page.getByRole('navigation', { name: 'Primary navigation' })
    await page.getByRole('heading', { name: 'What are we working on?', exact: true }).waitFor()
    await nav.getByRole('button', { name: 'Settings', exact: true }).click()
    assert.equal(await page.locator('.agent-roster-stack').count(), 0)
    await page.getByRole('heading', { name: 'Connections', exact: true }).waitFor()
    await nav.getByRole('button', { name: 'Team', exact: true }).click()
    assert.equal(await page.getByRole('heading', { name: 'Connections', exact: true }).count(), 0)
    await page.setViewportSize({ width: 390, height: 844 })
    await nav.getByRole('button', { name: 'Needs you (1)', exact: true }).click()
    assert.equal(await nav.getByRole('button', { name: 'Decisions', exact: true }).getAttribute('aria-current'), 'page')
    await page.setViewportSize({ width: 1440, height: 1000 })
    await t.test('agent portraits load for the whole roster without replacing identity labels', async () => {
      await nav.getByRole('button', { name: 'Team', exact: true }).click()
      const portraits = page.locator('.agent-roster-stack img')
      assert.equal(await portraits.count(), 10)
      for (const portrait of await portraits.all()) {
        await portrait.scrollIntoViewIfNeeded()
        await portrait.evaluate(img => img.decode())
        assert.ok(await portrait.evaluate(img => img.naturalWidth >= 128))
      }
      assert.equal(new Set(await portraits.evaluateAll(images => images.map(img => img.currentSrc))).size, 10)
      for (const name of ['RJ', ...names]) assert.equal(await page.locator('.agent-roster-stack').getByRole('heading', { name, exact: true }).count(), 1)
      const picker = page.getByRole('combobox', { name: 'Routing behavior for Ace', exact: true })
      await picker.selectOption('preferred')
      await page.waitForFunction(() => document.querySelector('[aria-label="Routing behavior for Ace"]')?.value === 'preferred')
      assert.equal(await picker.inputValue(), 'preferred')
      await picker.selectOption('pinned')
      await page.waitForFunction(() => document.querySelector('[aria-label="Routing behavior for Ace"]')?.value === 'pinned')
    })
    const inspect = async (label, width) => {
      const issues = await page.evaluate(() => {
        const bad = [], rect = el => el.getBoundingClientRect()
        const visible = el => { const r = rect(el); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' }
        const rgba = color => color.match(/[\d.]+/g).map(Number)
        const background = el => {
          if (!el) return [255, 255, 255]
          const [r, g, b, a = 1] = rgba(getComputedStyle(el).backgroundColor)
          const under = a < 1 ? background(el.parentElement) : [0, 0, 0]
          return [r, g, b].map((v, i) => v * a + under[i] * (1 - a))
        }
        const luminance = rgb => rgb.slice(0, 3).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0)
        for (const el of document.querySelectorAll('.dialog-heading h2, .dialog-meta strong, .dialog-actions button, main .decision-actions button')) {
          const fg = luminance(rgba(getComputedStyle(el).color)), bg = luminance(background(el))
          if ((Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05) < 4.5) bad.push(`Low contrast approval text: ${el.textContent}`)
        }
        for (const el of document.querySelectorAll('main select, main input, main textarea, .surface-card button, .client-workspace button')) {
          if (!visible(el)) continue
          const r = rect(el), card = el.closest('.surface-card, .media-studio, main'), c = rect(card)
          if (r.left < c.left - 2 || r.right > c.right + 2) bad.push(`Control outside card: ${el.getAttribute('aria-label') ?? el.textContent.slice(0, 55)}`)
        }
        for (const heading of document.querySelectorAll('.card-heading')) {
          const title = heading.querySelector('h2'), badge = heading.querySelector('.status-chip')
          if (!title || !badge) continue
          const range = document.createRange(); range.selectNodeContents(title)
          const b = rect(badge)
          for (const r of range.getClientRects()) if (r.left < b.right && r.right > b.left && r.top < b.bottom && r.bottom > b.top) bad.push(`Title overlaps badge: ${title.textContent}`)
        }
        for (const el of document.querySelectorAll('main, .topbar, .statusbar, .primary-nav, [role="dialog"]')) {
          if (!visible(el)) continue
          const r = rect(el)
          if (r.left < -1 || r.right > innerWidth + 1) bad.push(`Region outside viewport: ${el.className}`)
        }
        for (const el of document.querySelectorAll('.primary-nav button')) {
          if (!visible(el)) continue
          const r = rect(el)
          if (r.top < 0 || r.bottom > innerHeight + 1) bad.push(`Navigation outside viewport: ${el.getAttribute('aria-label')}`)
          if (r.left < 0 || r.right > innerWidth + 1 || r.height < 44 || r.width < 40) bad.push(`Navigation target too small or outside viewport: ${el.getAttribute('aria-label')}`)
        }
        for (const el of document.querySelectorAll('main .surface-card, .media-studio, .chat-transcript, .account-browser, .client-workspace, .client-directory, .client-detail, .client-reader')) {
          if (visible(el) && el.scrollWidth > el.clientWidth + 2) bad.push(`Horizontal content overflow: ${el.className}`)
        }
        for (const el of document.querySelectorAll('.task-plan-panel, .decisions-panel')) {
          if (visible(el) && el.scrollHeight > el.clientHeight + 2) bad.push(`Rail panel clips content: ${el.className}`)
        }
        const history = document.querySelector('.queue-history')
        if (history && rect(history).height < 180) bad.push('Queue history collapses below usable height')
        const summary = document.querySelector('.agent-summary'), actions = document.querySelector('.topbar-actions')
        if (rect(summary).right > rect(actions).left) bad.push('Top-bar controls overlap agent summary')
        return [...new Set(bad)]
      })
      findings.push(...issues.map(issue => `${width} ${label}: ${issue}`))
      await page.screenshot({ path: `/tmp/chimera-ui-${width}-${label}.png` })
    }
    for (const width of [1440, 1100, 820, 768, 390, 375, 320]) {
      await page.setViewportSize({ width, height: width <= 390 ? 844 : 1000 })
      if (await nav.getByRole('button', { name: 'More tools', exact: true }).getAttribute('aria-expanded') === 'false') await nav.getByRole('button', { name: 'More tools', exact: true }).click()
      for (const section of ['Team', 'Settings', 'Work', 'Workers', 'Media', 'Projects', 'Clients', 'Activity', 'Decisions', 'Browser']) {
        await nav.getByRole('button', { name: section, exact: true }).click()
        if (section === 'Clients') {
          await page.getByRole('heading', { name: client.name, exact: true }).waitFor()
          await page.getByRole('button', { name: new RegExp(document.title) }).click()
          await page.getByRole('article', { name: 'Source content' }).waitFor()
          await page.getByLabel('Note title', { exact: true }).fill('Synthetic intake draft')
          await page.getByLabel('Note body', { exact: true }).fill('Not saved. Layout fixture only.')
        }
        await page.locator('main').evaluateAll(elements => elements.forEach(el => { el.scrollTop = 0 }))
        assert.equal(await nav.getByRole('button', { name: section, exact: true }).getAttribute('aria-current'), 'page')
        await inspect(section, width)
        if (section === 'Team' && [1440, 390].includes(width)) {
          for (const name of ['Researcher', 'Ace', 'Genie']) {
            const card = page.locator('.specialist-card').filter({ has: page.getByRole('heading', { name, exact: true }) })
            await card.screenshot({ path: `/tmp/chimera-ui-${width}-card-${name}.png` })
          }
        }
        if (section === 'Media') { await page.getByRole('tab', { name: 'Luma Video' }).click(); await inspect('Video', width) }
        if (section === 'Decisions') {
          await page.locator('main').getByRole('button', { name: 'Review', exact: true }).click()
          await page.getByRole('dialog').waitFor(); await inspect('Approval', width)
          await page.getByRole('button', { name: 'Close', exact: true }).click()
        }
        if (section === 'Browser') {
          await page.getByRole('button', { name: 'My accounts', exact: true }).click()
          await page.getByRole('heading', { name: 'My accounts', exact: true }).waitFor()
          await inspect('Accounts', width)
        }
      }
    }
    assert.equal(await page.locator('vite-error-overlay').count(), 0)
    assert.deepEqual(errors, [])
    assert.deepEqual(findings, [])
    await t.test('missing and unknown portraits preserve usable initials', async () => {
      state.agents.specialists.push({ ...state.agents.specialists[1], agentId: 'new-agent', displayName: 'New Agent' })
      await page.route('**/agent-portraits/ace.jpg', route => route.fulfill({ contentType: 'image/jpeg', body: 'invalid-image-fixture' }))
      await page.reload()
      await nav.getByRole('button', { name: 'Team', exact: true }).click()
      const ace = page.locator('.agent-roster-stack [data-agent-id="ace"]')
      await ace.scrollIntoViewIfNeeded()
      await ace.locator('img').waitFor({ state: 'detached' })
      assert.equal(await ace.innerText(), 'A')
      assert.equal(await page.locator('.agent-roster-stack [data-agent-id="new-agent"]').innerText(), 'NA')
      assert.deepEqual(errors, [])
    })
  } finally { await browser.close(); await server.close() }
})
