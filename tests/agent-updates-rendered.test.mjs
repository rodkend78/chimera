import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const access = { profileId: 'sandbox', label: 'Sandbox', description: 'Private workspace only.', network: 'none' }
const routeValue = 'fixture::conversation-model'
async function fixture(t, handle) {
  const server = await createServer({ configFile: new URL('../app/vite.config.js', import.meta.url).pathname,
    server: { host: '127.0.0.1', port: 0, hmr: false, proxy: {} } })
  await server.listen()
  const browser = await chromium.launch({ headless: true })
  t.after(async () => { await browser.close(); await server.close() })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  page.setDefaultTimeout(3000)
  const errors = [], calls = [], state = {
    agent: { id: 'ceo', name: 'RJ', status: 'Idle' }, controller: { type: 'agent', id: 'ceo' }, suspended: false,
    browser: { running: true, tabs: [] }, activity: [], recentEvents: [], decisions: [], audit: { valid: true },
    models: { selected: { providerId: 'fixture', model: 'conversation-model', providerName: 'Fixture models', modelName: 'Fixture conversation' }, providers: [{ id: 'fixture', name: 'Fixture models', configured: true,
      models: [{ id: 'conversation-model', name: 'Fixture conversation', availability: 'verified-route', capabilities: ['conversation'] }] }] },
    auth: { codex: { connected: true } },
    agents: { main: { agentId: 'ceo', displayName: 'RJ', access }, accessProfiles: [access],
      specialists: ['ace', 'iris'].map(agentId => ({ agentId, displayName: agentId === 'ace' ? 'Ace' : 'Iris', role: 'Specialist',
        capabilities: ['general'], status: 'Ready', harnessState: 'Registered', access, modelPreference: { mode: 'auto' },
        source: { type: 'hermes', ref: `hermes://fixture/${agentId}` } })) },
    conversations: { channels: [], messages: [] }, tasks: [], projects: { projects: [], sessions: [], leases: [] },
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
    if (body) calls.push({ path, body })
    if (await handle?.({ path, body, route, state })) return
    await route.fulfill({ json: path === '/api/state' ? state : {} })
  })
  const url = `http://127.0.0.1:${server.httpServer.address().port}/`
  await page.goto(url)
  assert.equal(page.url(), url)
  assert.equal(await page.title(), 'Chimera Browser Workspace')
  await page.getByRole('button', { name: 'Team', exact: true }).click()
  await page.getByRole('heading', { name: 'Your team', exact: true }).waitFor()
  return { page, calls, errors, state }
}

async function roundTrip(page) {
  await page.getByRole('button', { name: 'Work', exact: true }).click()
  await page.getByRole('button', { name: 'Team', exact: true }).click()
}

function deferred() {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}

test('agent model updates are single-flight across same-turn input and section navigation', { timeout: 20000 }, async t => {
  const started = deferred(), release = deferred()
  const { page, calls, errors } = await fixture(t, async ({ path, route }) => {
    if (path !== '/api/agents/model') return false
    started.resolve(); await release.promise
    await route.fulfill({ json: { mode: 'preferred' } }); return true
  })
  t.after(() => release.resolve())
  const picker = page.getByRole('combobox', { name: 'Model for Ace', exact: true })
  await picker.evaluate((select, value) => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
    select.dispatchEvent(new Event('change', { bubbles: true }))
  }, routeValue)
  await started.promise
  await roundTrip(page)
  assert.equal(await picker.isDisabled(), true, 'pending ownership must survive navigation')
  assert.equal(await page.getByRole('button', { name: 'Remove Ace from team', exact: true }).textContent(), 'Remove', 'model update is not removal')
  assert.deepEqual(calls.filter(c => c.path === '/api/agents/model'), [{ path: '/api/agents/model', body: { agentId: 'ace', mode: 'preferred', providerId: 'fixture', model: 'conversation-model' } }])
  release.resolve()
  await page.waitForFunction(() => !document.querySelector('[aria-label="Model for Ace"]').disabled)
  assert.deepEqual(errors, [])
})

test('finishing one agent update cannot unlock a different pending agent', { timeout: 20000 }, async t => {
  const starts = { ace: deferred(), iris: deferred() }, releases = { ace: deferred(), iris: deferred() }
  const { page, calls, errors } = await fixture(t, async ({ path, body, route, state }) => {
    if (path !== '/api/agents/model') return false
    starts[body.agentId].resolve(); await releases[body.agentId].promise
    const { agentId, ...preference } = body
    state.agents.specialists.find(a => a.agentId === agentId).modelPreference = preference
    await route.fulfill({ json: preference }); return true
  })
  t.after(() => Object.values(releases).forEach(value => value.resolve()))
  const ace = page.getByRole('combobox', { name: 'Model for Ace', exact: true })
  const iris = page.getByRole('combobox', { name: 'Model for Iris', exact: true })
  await ace.selectOption(routeValue); await starts.ace.promise
  await iris.selectOption(routeValue); await starts.iris.promise
  assert.equal(await ace.isDisabled(), true)
  releases.ace.resolve()
  await page.waitForFunction(() => !document.querySelector('[aria-label="Model for Ace"]').disabled)
  assert.equal(await iris.isDisabled(), true)
  await roundTrip(page)
  assert.equal(await iris.isDisabled(), true)
  releases.iris.resolve()
  await page.waitForFunction(() => !document.querySelector('[aria-label="Model for Iris"]').disabled)
  assert.deepEqual(calls.filter(c => c.path === '/api/agents/model').map(c => c.body.agentId), ['ace', 'iris'])
  assert.deepEqual(errors, [])
})

test('unconfirmed agent updates remain attributable after navigation without unhandled errors or replay', { timeout: 20000 }, async t => {
  const { page, calls, errors } = await fixture(t, async ({ path, route }) => {
    if (path !== '/api/agents/model') return false
    await route.fulfill({ status: 503, json: { error: 'MODEL_UPDATE_UNAVAILABLE' } }); return true
  })
  await page.getByRole('combobox', { name: 'Model for Ace', exact: true }).selectOption(routeValue)
  const outcome = page.getByRole('region', { name: 'Agent updates', exact: true })
  await outcome.getByRole('alert').waitFor()
  await roundTrip(page)
  assert.match(await outcome.textContent(), /Ace.*Model update/s)
  assert.match(await outcome.textContent(), /unconfirmed/i)
  assert.match(await outcome.textContent(), /inspect.*before.*retry/i)
  assert.equal(await page.getByRole('combobox', { name: 'Model for Ace', exact: true }).isEnabled(), true)
  assert.equal(calls.filter(c => c.path === '/api/agents/model').length, 1)
  assert.deepEqual(errors, [])
  await outcome.scrollIntoViewIfNeeded()
  await page.screenshot({ path: '/tmp/chimera-agent-update-desktop.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  await outcome.scrollIntoViewIfNeeded()
  await page.screenshot({ path: '/tmp/chimera-agent-update-mobile.png' })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  assert.equal(await page.locator('vite-error-overlay').count(), 0)
  await outcome.getByRole('button', { name: 'Dismiss update for Ace' }).click()
  assert.equal(await outcome.count(), 0)
  assert.equal(calls.filter(c => c.path === '/api/agents/model').length, 1)
})

test('acknowledged agent model change stays accepted when the following state refresh fails', { timeout: 20000 }, async t => {
  let accepted = false
  const { page, calls, errors } = await fixture(t, async ({ path, route }) => {
    if (path === '/api/agents/model') { accepted = true; await route.fulfill({ json: { mode: 'preferred' } }); return true }
    if (path === '/api/state' && accepted) { await route.fulfill({ status: 503, json: { error: 'STATE_UNAVAILABLE' } }); return true }
    return false
  })
  await page.getByRole('combobox', { name: 'Model for Ace', exact: true }).selectOption(routeValue)
  const outcome = page.getByRole('region', { name: 'Agent updates', exact: true })
  await outcome.getByText(/status could not refresh/i).waitFor()
  await roundTrip(page)
  assert.match(await outcome.textContent(), /accepted/i)
  assert.match(await outcome.textContent(), /do not repeat/i)
  assert.equal(await outcome.getByRole('alert').count(), 0)
  assert.equal(calls.filter(c => c.path === '/api/agents/model').length, 1)
  assert.deepEqual(errors, [])
})

test('agent removal keeps confirmation and retains its exact outcome after the card disappears', { timeout: 20000 }, async t => {
  const started = deferred(), release = deferred()
  const { page, calls, errors } = await fixture(t, async ({ path, body, route, state }) => {
    if (path !== '/api/agents/remove') return false
    started.resolve(); await release.promise
    state.agents.specialists = state.agents.specialists.filter(a => a.agentId !== body.agentId)
    await route.fulfill({ json: { agentId: body.agentId, displayName: 'Ace' } }); return true
  })
  t.after(() => release.resolve())
  const remove = page.getByRole('button', { name: 'Remove Ace from team', exact: true })
  page.once('dialog', dialog => dialog.dismiss())
  await remove.click()
  assert.equal(calls.length, 0, 'cancelled confirmation must not submit')
  page.once('dialog', dialog => dialog.accept())
  await remove.click(); await started.promise
  await roundTrip(page)
  assert.equal(await remove.textContent(), 'Removing…')
  assert.equal(await remove.isDisabled(), true)
  await page.getByRole('button', { name: 'Work', exact: true }).click()
  const completed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/agents/remove')
  release.resolve()
  await completed
  await page.getByRole('button', { name: 'Team', exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('[aria-label="Remove Ace from team"]'))
  await roundTrip(page)
  const outcome = page.getByRole('region', { name: 'Agent updates', exact: true })
  assert.match(await outcome.textContent(), /Ace.*Remove agent.*accepted/s)
  assert.deepEqual(calls, [{ path: '/api/agents/remove', body: { agentId: 'ace' } }])
  assert.deepEqual(errors, [])
})

test('agent access updates preserve live confirmation and the exact agent/profile across navigation', { timeout: 20000 }, async t => {
  const started = deferred(), release = deferred()
  const { page, calls, errors } = await fixture(t, async ({ path, body, route, state }) => {
    const live = { profileId: 'live', label: 'Live', description: 'Fixture public-host ceiling.', warning: 'Fixture Live confirmation', network: 'public-allowlist' }
    if (path === '/api/state') state.agents.accessProfiles = [access, live]
    if (path !== '/api/agents/access') return false
    started.resolve(); await release.promise
    state.agents.specialists.find(a => a.agentId === body.agentId).access = live
    await route.fulfill({ json: live }); return true
  })
  t.after(() => release.resolve())
  const picker = page.getByRole('combobox', { name: 'Access level for Iris', exact: true })
  page.once('dialog', dialog => dialog.dismiss())
  await picker.selectOption('live')
  assert.equal(calls.length, 0)
  page.once('dialog', dialog => dialog.accept())
  await picker.selectOption('live'); await started.promise
  await roundTrip(page)
  assert.equal(await picker.isDisabled(), true)
  assert.equal(await page.getByRole('combobox', { name: 'Model for Iris', exact: true }).isDisabled(), true)
  release.resolve()
  await page.waitForFunction(() => !document.querySelector('[aria-label="Access level for Iris"]').disabled)
  assert.equal(await picker.inputValue(), 'live')
  assert.deepEqual(calls, [{ path: '/api/agents/access', body: { agentId: 'iris', profileId: 'live' } }])
  assert.match(await page.getByRole('region', { name: 'Agent updates', exact: true }).textContent(), /Iris.*Access update.*accepted/s)
  assert.deepEqual(errors, [])
})

for (const [harnessState, label, action] of [['Built in', 'Start worker', 'start'], ['Running', 'Stop worker', 'stop'], ['Interrupted', 'Recover', 'recover']]) {
  test(`unconfirmed ${action} worker is handled without replay after navigation`, { timeout: 20000 }, async t => {
    const { page, calls, errors } = await fixture(t, async ({ path, route, state }) => {
      if (path === '/api/state') {
        state.agents.specialists[0].source.type = 'chimera'
        state.agents.specialists[0].harnessState = harnessState
      }
      if (path !== `/api/agents/workers/${action}`) return false
      await route.fulfill({ status: 503, json: { error: 'WORKER_UPDATE_UNAVAILABLE' } }); return true
    })
    await page.getByRole('button', { name: label, exact: true }).click()
    const outcome = page.getByRole('region', { name: 'Agent updates', exact: true })
    await outcome.getByRole('alert').waitFor()
    await roundTrip(page)
    assert.match(await outcome.textContent(), /Ace.*worker.*unconfirmed/s)
    assert.equal(await page.getByRole('button', { name: label, exact: true }).isEnabled(), true)
    assert.deepEqual(calls, [{ path: `/api/agents/workers/${action}`, body: { agentId: 'ace' } }])
    assert.deepEqual(errors, [])
  })
}

for (const [agentId, name, mode, disappearance] of [
  ['iris', 'Iris', 'pinned', 'offline'],
  ['ace', 'Ace', 'preferred', 'model'],
  ['ceo', 'RJ', 'pinned', 'provider'],
]) {
  test(`${name} keeps the exact saved ${mode} model visible when its ${disappearance} route becomes unavailable`, { timeout: 20000 }, async t => {
    let seeded = false
    const { page, calls, errors, state } = await fixture(t, async ({ path, state, body, route }) => {
      const agent = agentId === 'ceo' ? state.agents.main : state.agents.specialists.find(a => a.agentId === agentId)
      if (path === '/api/state' && !seeded) {
        seeded = true
        agent.modelPreference = { mode, providerId: 'fixture', model: 'conversation-model' }
      }
      if (path !== '/api/agents/model') return false
      const { agentId: _, ...preference } = body
      agent.modelPreference = preference
      await route.fulfill({ json: preference }); return true
    })
    const picker = page.getByRole('combobox', { name: `Model for ${name}`, exact: true })
    assert.equal(await picker.inputValue(), routeValue)
    const provider = state.models.providers[0]
    if (disappearance === 'offline') provider.configured = false
    else if (disappearance === 'model') provider.models = []
    else state.models.providers = []
    // Wait for the actual state update to render, not an arbitrary timer.
    state.agent.status = 'Fixture catalog updated'
    await page.locator('.agent-card').getByText('Fixture catalog updated', { exact: true }).waitFor()
    assert.equal(await picker.inputValue(), routeValue, 'unavailable selection must not visually become Auto')
    assert.match(await picker.locator('option:checked').textContent(), /Unavailable/)
    const card = picker.locator('..')
    assert.match(await card.getByRole('status').textContent(), /fixture.*conversation-model/s)
    assert.equal(await page.getByRole('combobox', { name: `Routing behavior for ${name}`, exact: true }).inputValue(), mode)
    await roundTrip(page)
    assert.equal(await picker.inputValue(), routeValue)
    assert.equal(calls.length, 0, 'catalog changes and navigation must not submit a routing update')
    await picker.selectOption('auto')
    await page.waitForFunction(name => document.querySelector(`[aria-label="Model for ${name}"]`).value === 'auto'
      && !document.querySelector(`[aria-label="Routing behavior for ${name}"]`), name)
    assert.deepEqual(calls, [{ path: '/api/agents/model', body: { agentId, mode: 'auto' } }])
    assert.equal(await card.getByRole('status').count(), 0)
    assert.deepEqual(errors, [])
  })
}

test('an initially unavailable long model pin recovers without writes and can explicitly switch to another eligible route', { timeout: 20000 }, async t => {
  const model = `fixture-model-${'long-model-name-'.repeat(12)}`
  const providerId = 'fixture-cloud-gpu'
  let seeded = false
  const { page, calls, errors, state } = await fixture(t, async ({ path, state, body, route }) => {
    if (path === '/api/state' && !seeded) {
      seeded = true
      state.agents.specialists[1].modelPreference = { mode: 'pinned', providerId, model }
    }
    if (path !== '/api/agents/model') return false
    const { agentId: _, ...preference } = body
    state.agents.specialists[1].modelPreference = preference
    await route.fulfill({ json: preference }); return true
  })
  const picker = page.getByRole('combobox', { name: 'Model for Iris', exact: true })
  const card = picker.locator('..'), warning = card.getByRole('status')
  assert.equal(await picker.inputValue(), `${providerId}::${model}`)
  assert.match(await warning.textContent(), /Pinned.*fails closed/s)
  assert.equal(await picker.getAttribute('aria-describedby'), await warning.getAttribute('id'))
  await warning.scrollIntoViewIfNeeded()
  await page.screenshot({ path: '/tmp/chimera-model-unavailable-desktop.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  await warning.scrollIntoViewIfNeeded()
  await page.screenshot({ path: '/tmp/chimera-model-unavailable-mobile.png' })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  assert.equal(await page.locator('vite-error-overlay').count(), 0)
  state.models.providers.push({ id: providerId, name: 'Fixture cloud GPU', configured: true,
    models: [{ id: model, name: 'Recovered fixture model', capabilities: ['conversation'], availability: 'verified-route' }] })
  await warning.waitFor({ state: 'detached' })
  assert.equal(await picker.inputValue(), `${providerId}::${model}`)
  assert.match(await picker.locator('option:checked').textContent(), /Recovered fixture model/)
  assert.equal(calls.length, 0, 'route recovery must not submit or check a model')
  state.models.providers[1].models[0].availability = 'unverified'
  await warning.waitFor()
  await picker.selectOption(routeValue)
  await page.waitForFunction(() => document.querySelector('[aria-label="Model for Iris"]').value === 'fixture::conversation-model')
  await warning.waitFor({ state: 'detached' })
  assert.deepEqual(calls, [{ path: '/api/agents/model', body: { agentId: 'iris', mode: 'pinned', providerId: 'fixture', model: 'conversation-model' } }])
  assert.equal(await page.getByRole('combobox', { name: 'Routing behavior for Iris', exact: true }).inputValue(), 'pinned')
  assert.deepEqual(errors, [])
})

for (const disappearance of ['provider', 'model', 'eligibility']) {
  test(`RJ top-bar selection stays exact when its ${disappearance} disappears and recovers without writes`, { timeout: 15000 }, async t => {
    const { page, calls, errors, state } = await fixture(t, async ({ path, body, route, state }) => {
      if (path !== '/api/models/select') return false
      state.models.selected = body
      await route.fulfill({ json: { selected: body } }); return true
    })
    const picker = page.getByRole('combobox', { name: 'RJ model', exact: true })
    const expected = '{"providerId":"fixture","model":"conversation-model"}'
    assert.equal(await picker.inputValue(), expected)
    const provider = state.models.providers[0], model = provider.models[0]
    if (disappearance === 'provider') state.models.providers = []
    else if (disappearance === 'model') provider.models = []
    else model.availability = 'unverified'
    state.agent.status = 'Catalog changed'
    await page.locator('.agent-status').getByText('Catalog changed', { exact: true }).waitFor()
    assert.equal(await picker.inputValue(), expected, 'native select must not substitute Auto for the current missing route')
    assert.match(await picker.locator('option:checked').textContent(), /Unavailable/)
    assert.match(await picker.getAttribute('aria-description'), /fixture.*conversation-model/s)
    await roundTrip(page)
    assert.equal(await picker.inputValue(), expected)
    model.availability = 'verified-route'; provider.models = [model]; state.models.providers = [provider]
    state.agent.status = 'Catalog recovered'
    await page.locator('.agent-status').getByText('Catalog recovered', { exact: true }).waitFor()
    assert.equal(await picker.inputValue(), expected)
    assert.doesNotMatch(await picker.locator('option:checked').textContent(), /Unavailable/)
    assert.equal(calls.length, 0, 'catalog changes must not select or check models')
    await picker.selectOption('{"providerId":"chimera-auto","model":"auto"}')
    await page.waitForFunction(() => document.querySelector('[aria-label="RJ model"]').value === '{"providerId":"chimera-auto","model":"auto"}')
    assert.deepEqual(calls, [{ path: '/api/models/select', body: { providerId: 'chimera-auto', model: 'auto' } }])
    assert.deepEqual(errors, [])
  })
}

test('an initially missing long RJ route remains inspectable without overflowing the workspace', { timeout: 15000 }, async t => {
  const model = `missing-${'long-model-id-'.repeat(18)}`
  let seeded = false
  const { page, calls, errors } = await fixture(t, async ({ path, body, route, state }) => {
    if (path === '/api/state' && !seeded) {
      seeded = true
      state.models.selected = { providerId: 'missing-provider', model, providerName: 'Saved fixture provider', modelName: 'Saved research model' }
    }
    if (path !== '/api/models/select') return false
    state.models.selected = body
    await route.fulfill({ json: { selected: body } }); return true
  })
  const picker = page.getByRole('combobox', { name: 'RJ model', exact: true })
  assert.equal(await picker.inputValue(), JSON.stringify({ providerId: 'missing-provider', model }))
  assert.match(await picker.locator('option:checked').textContent(), /Unavailable.*Saved research model/)
  assert.ok((await picker.getAttribute('title')).includes(model))
  assert.ok((await picker.getAttribute('aria-description')).includes(model))
  await picker.focus()
  await page.screenshot({ path: '/tmp/chimera-rj-route-desktop.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await picker.isVisible(), false, 'retain the existing compact phone header')
  await page.screenshot({ path: '/tmp/chimera-rj-route-mobile.png' })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  assert.equal(await page.locator('vite-error-overlay').count(), 0)
  assert.equal(calls.length, 0)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await picker.selectOption('{"providerId":"fixture","model":"conversation-model"}')
  await page.waitForFunction(() => document.querySelector('[aria-label="RJ model"]').value === '{"providerId":"fixture","model":"conversation-model"}')
  assert.deepEqual(calls, [{ path: '/api/models/select', body: { providerId: 'fixture', model: 'conversation-model' } }])
  assert.deepEqual(errors, [])
})

for (const selected of [null, { providerId: 'chimera-auto', model: 'auto' }]) {
  test(`RJ top bar does not label ${selected ? 'Auto' : 'an unset route'} unavailable`, { timeout: 15000 }, async t => {
    const { page, calls, errors } = await fixture(t, async ({ path, state }) => {
      if (path === '/api/state') { state.models.selected = selected; state.models.providers = [] }
      return false
    })
    const picker = page.getByRole('combobox', { name: 'RJ model', exact: true })
    assert.equal(await picker.inputValue(), selected ? '{"providerId":"chimera-auto","model":"auto"}' : '')
    assert.doesNotMatch(await picker.locator('option:checked').textContent(), /Unavailable/)
    assert.deepEqual(calls, [])
    assert.deepEqual(errors, [])
  })
}
