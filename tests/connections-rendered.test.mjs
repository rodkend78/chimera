import test from 'node:test'
import { openTask4Fixture, assert } from './task4-ui-fixture.mjs'

test('Connections workspace renders projected rows without probing or posting on render', { timeout: 20000 }, async t => {
  const { page, calls, errors } = await openTask4Fixture(t)
  await page.getByRole('heading', { name: 'Connections', exact: true }).waitFor()
  assert.equal(await page.getByText('Catalog available; inference not verified', { exact: true }).count(), 1)
  assert.equal(await page.getByRole('button', { name: 'Test inference', exact: true }).count(), 1)
  assert.deepEqual(calls.filter(call => call.path !== '/api/state'), [])
  assert.deepEqual(errors.filter(error => !/status of 503/.test(error)), [])
})

test('connection test has one explicit quota-confirmed request and distinguishes accepted write from refresh failure', { timeout: 20000 }, async t => {
  let accepted = false
  const { page, calls, errors } = await openTask4Fixture(t, async ({ path, route }) => {
    if (path === '/api/connections/action') {
      accepted = true
      await route.fulfill({ json: { state: {}, receipt: { status: 'succeeded', requestId: 'connection-test-fixture-conversation-model-1', providerId: 'fixture', operation: 'test-model', model: 'conversation-model' } } })
      return true
    }
    if (path === '/api/state' && accepted) {
      await route.fulfill({ status: 503, json: { error: 'STATE_UNAVAILABLE' } })
      return true
    }
    return false
  })
  const testButton = page.getByRole('button', { name: 'Test inference', exact: true })
  page.once('dialog', dialog => dialog.dismiss())
  await testButton.click()
  assert.equal(calls.filter(call => call.path === '/api/connections/action').length, 0)
  page.once('dialog', dialog => dialog.accept())
  await testButton.click()
  await page.getByRole('status').filter({ hasText: /accepted.*refresh failed|accepted.*could not be confirmed/i }).waitFor()
  assert.equal(calls.filter(call => call.path === '/api/connections/action').length, 1)
  assert.deepEqual(errors.filter(error => !/status of 503/.test(error)), [])
})

test('unknown connection acknowledgement exposes receipt lookup and never retries the model action', { timeout: 20000 }, async t => {
  let lookupCount = 0
  let lookedUpRequestId = null
  const { page, calls, errors } = await openTask4Fixture(t, async ({ path, route }) => {
    if (path === '/api/connections/action') {
      await route.fulfill({ status: 409, json: { error: 'CONNECTION_OPERATION_UNKNOWN', reconciliationRequired: true, retryAllowed: false, receipt: { status: 'unknown', requestId: 'saved-request', providerId: 'fixture', operation: 'test-model' } } })
      return true
    }
    if (path === '/api/connections/receipt') {
      lookupCount += 1
      lookedUpRequestId = new URL(route.request().url()).searchParams.get('requestId')
      await route.fulfill({ json: { receipt: { status: 'unknown', requestId: 'saved-request', providerId: 'fixture', operation: 'test-model' } } })
      return true
    }
    return false
  })
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Test inference', exact: true }).click()
  const lookup = page.getByRole('button', { name: /Check saved receipt for/ })
  await lookup.waitFor()
  await lookup.click()
  assert.equal(lookupCount, 1)
  assert.equal(lookedUpRequestId, 'saved-request')
  assert.equal(calls.filter(call => call.path === '/api/connections/action').length, 1)
  assert.deepEqual(errors.filter(error => !/status of 409/.test(error)), [])
})

test('malformed connection acknowledgement preserves the attempted receipt through remount and never resubmits', { timeout: 20000 }, async t => {
  let attemptedRequestId = null
  let lookedUpRequestId = null
  let unknownState = false
  const { page, calls, state, errors } = await openTask4Fixture(t, async ({ path, search, route }) => {
    if (path === '/api/connections/action') {
      attemptedRequestId = route.request().postDataJSON().requestId
      state.connections.connections[0].verification = {
        status: 'unknown', requestId: attemptedRequestId, operation: 'test-model',
        model: 'conversation-model', revision: 3, machineRef: 'machine-fixture',
      }
      unknownState = true
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{malformed acknowledgement' })
      return true
    }
    if (path === '/api/connections/receipt') {
      lookedUpRequestId = search.get('requestId')
      await route.fulfill({ json: { receipt: { status: 'unknown', requestId: lookedUpRequestId, providerId: 'fixture', operation: 'test-model' } } })
      return true
    }
    if (path === '/api/state' && unknownState) {
      await route.fulfill({ json: state })
      return true
    }
    return false
  })
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Test inference', exact: true }).click()
  await page.getByRole('button', { name: 'Team', exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor()
  await page.getByRole('button', { name: /Check saved receipt for/ }).waitFor()
  await page.getByRole('button', { name: /Check saved receipt for/ }).click()
  await page.getByRole('alert').filter({ hasText: /durable receipt is still unresolved/i }).waitFor()
  assert.match(attemptedRequestId, /^connection-test-/)
  assert.equal(lookedUpRequestId, attemptedRequestId)
  assert.equal(calls.filter(call => call.path === '/api/connections/action').length, 1)
  assert.deepEqual(errors, [])
})

test('receipt-less successful JSON is also treated as an unconfirmed connection write', { timeout: 20000 }, async t => {
  let actionCount = 0
  let lookedUpRequestId = null
  const { page, calls, errors } = await openTask4Fixture(t, async ({ path, search, route }) => {
    if (path === '/api/connections/action') {
      actionCount += 1
      await route.fulfill({ status: 200, json: {} })
      return true
    }
    if (path === '/api/connections/receipt') {
      lookedUpRequestId = search.get('requestId')
      await route.fulfill({ json: { receipt: { status: 'unknown', requestId: lookedUpRequestId, providerId: 'fixture', operation: 'test-model' } } })
      return true
    }
    return false
  })
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Test inference', exact: true }).click()
  await page.getByRole('button', { name: /Check saved receipt for/ }).waitFor()
  await page.getByRole('button', { name: 'Team', exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: /Check saved receipt for/ }).waitFor()
  await page.getByRole('button', { name: /Check saved receipt for/ }).click()
  await page.getByRole('alert').filter({ hasText: /durable receipt is still unresolved/i }).waitFor()
  assert.equal(actionCount, 1)
  assert.match(lookedUpRequestId, /^connection-test-/)
  assert.equal(calls.filter(call => call.path === '/api/connections/action').length, 1)
  assert.deepEqual(errors, [])
})

test('Connections cards fit a 390-pixel viewport', { timeout: 20000 }, async t => {
  const { page, errors } = await openTask4Fixture(t, undefined, { width: 390, height: 844 })
  await page.getByRole('heading', { name: 'Connections', exact: true }).waitFor()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({ path: '/tmp/chimera-task4-connections-mobile.png' })
  assert.deepEqual(errors, [])
})
