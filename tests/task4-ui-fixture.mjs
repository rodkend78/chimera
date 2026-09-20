import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'

export function task4State() {
  const access = { profileId: 'sandbox', label: 'Sandbox', description: 'Private workspace only.', network: 'none' }
  const checks = ['identity', 'continuity', 'model', 'access', 'executor', 'execution']
    .map(name => ({ name, status: name === 'execution' ? 'unknown' : 'pass', reason: null, details: {} }))
  return {
    agent: { id: 'ceo', name: 'RJ', status: 'Idle' }, controller: { type: 'agent', id: 'ceo' }, suspended: false,
    draftScope: { schema: 'chimera.draft-scope.v1', workspaceId: 'machine-fixture', operatorId: 'rod-fixture' },
    browser: { running: true, tabs: [] }, activity: [], recentEvents: [], decisions: [], audit: { valid: true },
    models: { selected: { providerId: 'fixture', model: 'conversation-model', providerName: 'Fixture models', modelName: 'Fixture conversation' }, providers: [{ id: 'fixture', name: 'Fixture models', configured: true,
      models: [{ id: 'conversation-model', name: 'Fixture conversation', availability: 'verified-route', capabilities: ['conversation'] }] }] },
    auth: { codex: { connected: true } },
    connections: { schema: 'chimera.connections.v1', connections: [{ providerId: 'fixture', status: 'available', enabled: true, revision: 3, catalogAvailable: true,
      provenance: { machineRef: 'machine-fixture', accountRef: 'fixture-account', signedIn: true }, operations: { 'test-model': true, refresh: true, connect: false, reconnect: false, disconnect: false }, verification: null, error: null }] },
    connectors: { github: { connected: false, repositories: [], status: 'not-configured' }, rjAws: { configured: false } },
    agents: {
      main: { agentId: 'ceo', displayName: 'RJ', personaProfileId: 'rj', role: 'CEO', capabilities: ['orchestration'], access, modelPreference: { mode: 'auto' },
        source: { type: 'hermes', profileId: 'rj', ref: 'hermes://fixture/rj' }, continuity: { status: 'materialized', report: { persona: { files: 1 }, memory: { files: 1 }, skills: { files: 0 } }, digest: 'b'.repeat(64) },
        readiness: { schema: 'chimera.agent-readiness.v1', agentId: 'ceo', status: 'configured', fingerprint: 'a'.repeat(64), checks, lastTest: null } },
      accessProfiles: [access],
      specialists: [{ agentId: 'ace', displayName: 'Ace', role: 'Specialist', capabilities: ['general'], status: 'Ready', harnessState: 'Registered', access,
        modelPreference: { mode: 'auto' }, source: { type: 'hermes', profileId: 'ace', ref: 'hermes://fixture/ace' }, continuity: { status: 'materialized', report: { persona: { files: 1 }, memory: { files: 1 }, skills: { files: 0 } }, digest: 'c'.repeat(64) },
        readiness: { schema: 'chimera.agent-readiness.v1', agentId: 'ace', status: 'configured', fingerprint: 'c'.repeat(64), checks, lastTest: null } }] },
    conversations: { channels: [], messages: [] }, tasks: [], projects: { projects: [], sessions: [], leases: [] }, workers: {},
  }
}

export async function openTask4Fixture(t, handle = async () => false, { width = 1440, height = 1000 } = {}) {
  const server = await createServer({ configFile: new URL('../app/vite.config.js', import.meta.url).pathname, server: { host: '127.0.0.1', port: 0, hmr: false, proxy: {} } })
  await server.listen()
  const browser = await chromium.launch({ headless: true })
  t.after(async () => { await browser.close(); await server.close() })
  const page = await browser.newPage({ viewport: { width, height } })
  page.setDefaultTimeout(4000)
  const state = task4State()
  const calls = []
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()) })
  await page.routeWebSocket('**/api/browser/stream', socket => socket.onMessage(() => {}))
  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.hostname !== '127.0.0.1') throw new Error(`Unexpected external request: ${url.origin}`)
    if (!url.pathname.startsWith('/api/')) return route.continue()
    if (url.pathname === '/api/operator/session') return route.fulfill({ json: { csrfToken: 'fixture', expiresAt: '2099-01-01T00:00:00Z' } })
    const body = route.request().method() === 'POST' ? route.request().postDataJSON() : null
    if (body) calls.push({ path: url.pathname, body })
    if (await handle({ path: url.pathname, search: url.searchParams, body, route, state, calls })) return
    await route.fulfill({ json: url.pathname === '/api/state' ? state : {} })
  })
  const url = `http://127.0.0.1:${server.httpServer.address().port}/`
  await page.goto(url)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor()
  return { page, state, calls, errors }
}

export function assertNoHorizontalOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
}

export { assert }
