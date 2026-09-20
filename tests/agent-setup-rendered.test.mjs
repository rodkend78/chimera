import test from 'node:test'
import { openTask4Fixture, assert } from './task4-ui-fixture.mjs'

test('setup renders without side effects, keeps keyboard focus, and preserves a draft across return', { timeout: 20000 }, async t => {
  const { page, calls, errors } = await openTask4Fixture(t)
  await page.getByRole('button', { name: 'New agent', exact: true }).click()
  await page.getByRole('heading', { name: 'Agent setup', exact: true }).waitFor()
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Close setup')
  assert.deepEqual(calls.filter(call => call.path !== '/api/state'), [])
  await page.getByRole('button', { name: /Create native agent/ }).click()
  await page.getByLabel('Agent ID', { exact: true }).fill('draft-native')
  await page.getByLabel('Display name', { exact: true }).fill('Draft Native')
  await page.getByRole('button', { name: 'Keep draft', exact: true }).click()
  await page.getByRole('button', { name: 'New agent', exact: true }).click()
  assert.equal(await page.getByLabel('Agent ID', { exact: true }).inputValue(), 'draft-native')
  assert.equal(await page.getByLabel('Display name', { exact: true }).inputValue(), 'Draft Native')
  assert.deepEqual(errors, [])
})

test('guided native creation, Hermes discovery/import, and editable identity use explicit writes only', { timeout: 20000 }, async t => {
  const { page, calls, state, errors } = await openTask4Fixture(t, async ({ path, body, route }) => {
    if (path === '/api/agents/create') {
      const agent = { agentId: body.agentId, displayName: body.displayName, role: body.role, capabilities: body.capabilities, source: { type: 'chimera', sourceId: 'native', ref: `chimera://native/${body.agentId}` }, access: state.agents.accessProfiles[0], modelPreference: { mode: 'auto' }, continuity: { status: 'unavailable', report: { persona: { files: 1 } } }, readiness: state.agents.main.readiness }
      state.agents.specialists.push(agent)
      await route.fulfill({ status: 201, json: { schema: 'chimera.agent-create-result.v1', requestId: body.requestId, agent, continuity: [agent.continuity] } })
      return true
    }
    if (path === '/api/agents/discover') {
      await route.fulfill({ json: { schema: 'chimera.agent-discovery.v1', discoveryId: 'discovery-fixture', source: { id: 'hermes-fixture', type: 'hermes-ssm', host: 'fixture-hermes' }, expiresAt: new Date(Date.now() + 60_000).toISOString(), candidates: [{ candidateId: 'hermes-ace', profileId: 'ace-2', displayName: 'Hermes Ace', defaultRole: 'Research', sourceRef: 'hermes://fixture/ace-2', defaultCapabilities: ['research'], imported: false, reservedForMain: false, exclusions: ['credentials'], dependencyStatus: 'unverified / not inspected' }] } })
      return true
    }
    if (path === '/api/agents/import') {
      const agent = { agentId: 'ace-2', displayName: 'Hermes Ace', role: 'Research', capabilities: ['research'], source: { type: 'hermes', ref: 'hermes://fixture/ace-2' }, access: state.agents.accessProfiles[0], modelPreference: { mode: 'auto' }, continuity: { status: 'materialized', report: { persona: { files: 1 }, memory: { files: 1 } } }, readiness: state.agents.main.readiness }
      state.agents.specialists.push(agent)
      await route.fulfill({ json: { schema: 'chimera.agent-import-result.v1', imported: [agent], continuity: [agent.continuity] } })
      return true
    }
    if (path === '/api/agents/metadata') {
      const agent = state.agents.specialists.find(item => item.agentId === body.agentId)
      Object.assign(agent, { displayName: body.displayName, role: body.role, capabilities: body.capabilities })
      await route.fulfill({ json: agent })
      return true
    }
    return false
  })
  await page.getByRole('button', { name: 'New agent', exact: true }).click()
  await page.getByRole('button', { name: /Create native agent/ }).click()
  await page.getByLabel('Agent ID', { exact: true }).fill('native-ace')
  await page.getByLabel('Display name', { exact: true }).fill('Native Ace')
  await page.getByLabel('Role', { exact: true }).fill('Research')
  await page.getByLabel('Capabilities', { exact: true }).fill('research, coding')
  await page.getByLabel('Persona', { exact: true }).fill('Bounded fixture persona')
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.getByRole('heading', { name: 'Identity and continuity', exact: true }).waitFor()
  assert.equal(calls.filter(call => call.path === '/api/agents/create').length, 1)
  await page.getByRole('button', { name: 'Close setup', exact: true }).click()
  await page.getByRole('button', { name: 'New agent', exact: true }).click()
  await page.locator('.agent-setup-steps button').nth(0).click()
  await page.getByRole('button', { name: /Import from Hermes/ }).click()
  await page.getByRole('button', { name: 'Find Hermes agents', exact: true }).click()
  await page.getByText('Dependencies: unverified / not inspected', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Import selected', exact: true }).click()
  await page.getByRole('heading', { name: 'Identity and continuity', exact: true }).waitFor()
  assert.equal(calls.filter(call => call.path === '/api/agents/discover').length, 1)
  assert.equal(calls.filter(call => call.path === '/api/agents/import').length, 1)
  await page.getByLabel('Display name', { exact: true }).fill('Edited Hermes Ace')
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  assert.equal(calls.filter(call => call.path === '/api/agents/metadata').length, 1)
  assert.deepEqual(errors, [])
})

test('Hermes import stays closed when source or expiry evidence is missing', { timeout: 20000 }, async t => {
  const { page, calls, errors } = await openTask4Fixture(t, async ({ path, route }) => {
    if (path !== '/api/agents/discover') return false
    await route.fulfill({ json: {
      schema: 'chimera.agent-discovery.v1',
      discoveryId: 'discovery-incomplete',
      candidates: [{ candidateId: 'hermes-incomplete', profileId: 'incomplete', displayName: 'Incomplete Hermes', defaultRole: 'Research', sourceRef: 'hermes://fixture/incomplete', imported: false, reservedForMain: false }],
    } })
    return true
  })
  await page.getByRole('button', { name: 'New agent', exact: true }).click()
  await page.getByRole('button', { name: /Import from Hermes/ }).click()
  await page.getByRole('button', { name: 'Find Hermes agents', exact: true }).click()
  await page.locator('.hermes-preview').waitFor()
  assert.equal(await page.getByText('Source unavailable; discover again.', { exact: true }).count(), 1)
  assert.equal(await page.getByRole('button', { name: 'Import selected', exact: true }).isDisabled(), true)
  assert.equal(calls.filter(call => call.path === '/api/agents/import').length, 0)
  assert.deepEqual(errors, [])
})

test('legacy Hermes intake renders the server dependencyStatus projection', { timeout: 20000 }, async t => {
  const { page, errors } = await openTask4Fixture(t, async ({ path, route }) => {
    if (path !== '/api/agents/discover') return false
    await route.fulfill({ json: {
      schema: 'chimera.agent-discovery.v1',
      discoveryId: 'discovery-legacy-fixture',
      source: { id: 'hermes-fixture', type: 'hermes-ssm', host: 'fixture-hermes' },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      candidates: [{ candidateId: 'hermes-legacy', profileId: 'legacy', displayName: 'Legacy Hermes', defaultRole: 'Research', sourceRef: 'hermes://fixture/legacy', defaultCapabilities: ['research'], imported: false, reservedForMain: false, dependencyStatus: 'unverified / not inspected' }],
    } })
    return true
  })
  await page.getByText('Import agents', { exact: true }).click()
  await page.getByRole('button', { name: 'Find Hermes agents', exact: true }).click()
  await page.getByText('Dependencies: unverified / not inspected', { exact: true }).waitFor()
  assert.deepEqual(errors, [])
})

test('inference-only test requires explicit quota consent and reuses one durable request id', { timeout: 20000 }, async t => {
  let release
  let started
  const start = new Promise(resolve => { started = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const { page, calls, state, errors } = await openTask4Fixture(t, async ({ path, body, route }) => {
    if (path !== '/api/agents/test') return false
    start.then(() => {})
    started()
    await gate
    state.agents.main.readiness.lastTest = { status: 'passed', fingerprint: body.expectedFingerprint, observedAt: '2026-09-19T00:00:00.000Z', historical: false }
    await route.fulfill({ json: { status: 'passed', requestId: body.requestId, receipt: { status: 'passed', scope: 'inference-only' } } })
    return true
  })
  await page.getByRole('button', { name: 'New agent', exact: true }).click()
  await page.locator('.agent-setup-steps button').nth(4).click()
  const run = page.getByRole('button', { name: 'Run inference-only test', exact: true })
  page.once('dialog', dialog => dialog.dismiss())
  await run.click()
  assert.equal(calls.filter(call => call.path === '/api/agents/test').length, 0)
  page.once('dialog', dialog => dialog.accept())
  await run.click()
  await start
  assert.equal(calls.filter(call => call.path === '/api/agents/test').length, 1)
  const firstRequestId = calls.find(call => call.path === '/api/agents/test').body.requestId
  assert.match(firstRequestId, /^agent-test-/)
  assert.equal(await page.getByRole('button', { name: 'Testing…', exact: true }).isDisabled(), true)
  release()
  await page.getByText('This verifies one inference response only; it does not verify tools, task execution, or publication.', { exact: true }).waitFor()
  assert.deepEqual(calls.filter(call => call.path === '/api/agents/test').map(call => call.body.requestId), [firstRequestId])
  assert.deepEqual(errors, [])
})

test('lost agent-test acknowledgement retains the exact request for read-only receipt lookup', { timeout: 20000 }, async t => {
  let attemptedRequestId = null
  let lookedUpRequestId = null
  let lookupResolve
  const lookupSeen = new Promise(resolve => { lookupResolve = resolve })
  const { page, calls, errors } = await openTask4Fixture(t, async ({ path, body, search, route }) => {
    if (path === '/api/agents/test') {
      attemptedRequestId = body.requestId
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{not-json' })
      return true
    }
    if (path === '/api/agents/readiness') {
      lookedUpRequestId = search.get('requestId')
      lookupResolve()
      await route.fulfill({ json: { schema: 'chimera.agent-readiness-receipt.v1', agentId: 'ceo', requestId: lookedUpRequestId, status: 'unknown', fingerprint: 'a'.repeat(64), scope: 'inference-only', observedAt: '2026-09-19T00:00:00.000Z' } })
      return true
    }
    return false
  })
  await page.getByRole('button', { name: 'New agent', exact: true }).click()
  await page.locator('.agent-setup-steps button').nth(4).click()
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Run inference-only test', exact: true }).click()
  const lookup = page.getByRole('button', { name: 'Check saved outcome', exact: true })
  await lookup.waitFor()
  assert.match(attemptedRequestId, /^agent-test-/)
  await lookup.click()
  await lookupSeen
  assert.equal(lookedUpRequestId, attemptedRequestId)
  assert.equal(calls.filter(call => call.path === '/api/agents/test').length, 1)
  assert.deepEqual(errors, [])
})

test('saved test receipts stay bound to the agent and readiness fingerprint', { timeout: 20000 }, async t => {
  const { page, calls, errors } = await openTask4Fixture(t, async ({ path, route }) => {
    if (path !== '/api/agents/test') return false
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{not-json' })
    return true
  })
  await page.getByRole('button', { name: 'New agent', exact: true }).click()
  await page.locator('.agent-setup-steps button').nth(4).click()
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Run inference-only test', exact: true }).click()
  await page.getByRole('button', { name: 'Check saved outcome', exact: true }).waitFor()
  await page.locator('.agent-setup-steps button').nth(1).click()
  await page.locator('.setup-step select').first().selectOption('ace')
  await page.locator('.agent-setup-steps button').nth(4).click()
  assert.equal(await page.getByRole('button', { name: 'Check saved outcome', exact: true }).count(), 0)
  assert.equal(calls.filter(call => call.path === '/api/agents/readiness').length, 0)
  assert.deepEqual(errors, [])
})

test('Done does not replay identity, model, or access writes already accepted during setup', { timeout: 20000 }, async t => {
  const { page, calls, errors } = await openTask4Fixture(t, async ({ path, route }) => {
    if (path === '/api/agents/metadata' || path === '/api/agents/model' || path === '/api/agents/access') {
      await route.fulfill({ json: { ok: true } })
      return true
    }
    if (path === '/api/agents/test') {
      const body = route.request().postDataJSON()
      await route.fulfill({ json: { schema: 'chimera.agent-test-result.v1', status: 'passed', requestId: body.requestId, fingerprint: body.expectedFingerprint, scope: 'inference-only' } })
      return true
    }
    return false
  })
  await page.getByRole('button', { name: 'New agent', exact: true }).click()
  await page.locator('.agent-setup-steps button').nth(1).click()
  await page.locator('.setup-step select').first().selectOption('ace')
  await page.getByLabel('Display name', { exact: true }).fill('Ace reviewed once')
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.locator('#wizard-model-ace').selectOption('fixture::conversation-model')
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.locator('#wizard-access-ace').selectOption('sandbox')
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.getByRole('heading', { name: 'Check and save', exact: true }).waitFor()
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Run inference-only test', exact: true }).click()
  await page.getByRole('button', { name: 'Done', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  assert.equal(calls.filter(call => call.path === '/api/agents/metadata').length, 1)
  assert.equal(calls.filter(call => call.path === '/api/agents/model').length, 1)
  assert.equal(calls.filter(call => call.path === '/api/agents/access').length, 1)
  assert.equal(calls.filter(call => call.path === '/api/agents/test').length, 1)
  assert.deepEqual(errors, [])
})

test('setup dialog remains usable at mobile width without horizontal overflow', { timeout: 20000 }, async t => {
  const { page, errors } = await openTask4Fixture(t, undefined, { width: 390, height: 844 })
  await page.getByRole('button', { name: 'New agent', exact: true }).click()
  await page.getByRole('heading', { name: 'Agent setup', exact: true }).waitFor()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({ path: '/tmp/chimera-task4-agent-setup-mobile.png' })
  assert.deepEqual(errors, [])
})

test('Team can start setup and Connections returns to the same repair step', { timeout: 20000 }, async t => {
  const { page, state, errors } = await openTask4Fixture(t)
  state.agents.specialists[0].continuity = { status: 'unavailable', report: { persona: { files: 0 }, memory: { files: 0 }, skills: { files: 0 }, excluded: ['credentials'], dependencyStatus: 'unverified' }, failureCode: 'AGENT_CONTINUITY_UNAVAILABLE' }
  await page.getByRole('button', { name: 'Team', exact: true }).click()
  await page.getByRole('heading', { name: 'Your team', exact: true }).waitFor()
  await page.getByRole('button', { name: 'New agent', exact: true }).click()
  await page.locator('.agent-setup-steps button').nth(1).click()
  await page.getByRole('heading', { name: 'Identity and continuity', exact: true }).waitFor()
  await page.locator('.setup-step select').first().selectOption('ace')
  await page.getByRole('button', { name: 'Open Connections to repair', exact: true }).click()
  await page.getByRole('heading', { name: 'Connections', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Return to setup', exact: true }).click()
  await page.getByRole('heading', { name: 'Agent setup', exact: true }).waitFor()
  assert.equal(await page.locator('.setup-step select').first().inputValue(), 'ace')
  assert.equal(await page.locator('.agent-setup-steps button').nth(1).getAttribute('aria-current'), 'step')
  assert.deepEqual(errors, [])
})
