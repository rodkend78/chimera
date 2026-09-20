import test from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTask4Fixture, assert } from './task4-ui-fixture.mjs'

test('everyday composer leaves room for work and uses visible themed controls', { timeout: 20000 }, async t => {
  const { page, errors } = await openTask4Fixture(t)
  const composer = page.getByRole('region', { name: 'Conversation composer', exact: true })
  assert.equal(await page.title(), 'Chimera Browser Workspace')
  assert.ok((await composer.boundingBox()).height <= 285, 'Ask should not consume a 340px fixed row')
  const setup = composer.getByRole('button', { name: 'Agent setup', exact: true })
  assert.ok(await setup.evaluate(element => parseFloat(getComputedStyle(element).borderRadius) >= 8), 'Secondary controls should use the workspace button treatment')
  await setup.focus()
  await page.keyboard.press('Tab')
  await page.keyboard.press('Shift+Tab')
  assert.equal(await setup.evaluate(element => document.activeElement === element), true)
  assert.ok(await setup.evaluate(element => getComputedStyle(element).outlineStyle !== 'none'), 'Keyboard focus must be visible')
  assert.equal(await page.locator('vite-error-overlay').count(), 0)
  assert.deepEqual(errors, [])
})

test('saved-outcome recovery stays ahead of the editor and never resends a lost response', { timeout: 40000 }, async t => {
  let submitted
  let lookups = 0
  const { page, calls, errors } = await openTask4Fixture(t, async ({ path, route, body }) => {
    if (path === '/api/conversations/ask') {
      submitted = body
      await route.fulfill({ status: 503, json: { error: 'FIXTURE_ACK_LOST' } })
      return true
    }
    if (path.startsWith('/api/conversations/asks/')) {
      lookups += 1
      await route.fulfill({ json: { schema: 'chimera.ask-result.v1', ...submitted, status: 'unknown' } })
      return true
    }
    return false
  })
  const composer = page.getByRole('region', { name: 'Conversation composer', exact: true })
  const editor = composer.getByRole('textbox', { name: 'Ask agent', exact: true })
  await editor.fill('Retain this question after a lost response')
  await composer.getByRole('button', { name: 'Ask agent', exact: true }).click()
  const lookup = composer.getByRole('button', { name: 'Check saved outcome', exact: true })
  await lookup.waitFor()
  assert.equal(await composer.getByRole('button', { name: /Check outcome first/ }).isDisabled(), true)
  assert.ok((await lookup.boundingBox()).y < (await editor.boundingBox()).y, 'Recovery belongs before the editor, not below its scroll fold')
  await composer.getByText('Request details', { exact: true }).click()
  assert.equal(await composer.locator('code').filter({ hasText: submitted.requestId }).count(), 1)
  await composer.getByText('Request details', { exact: true }).click()

  const screenshots = await mkdtemp(join(tmpdir(), 'chimera-composer-qa-'))
  for (const [width, height] of [[390, 1000], [768, 1000], [1440, 1000], [2560, 1000], [720, 500]]) {
    await page.setViewportSize({ width, height })
    await editor.focus()
    await lookup.focus()
    assert.equal(await lookup.evaluate(element => {
      const rect = element.getBoundingClientRect()
      return document.activeElement === element && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight
    }), true, `Recovery keyboard reachability at ${width}x${height}`)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `Page overflow at ${width}x${height}`)
    assert.equal(await composer.evaluate(element => element.scrollWidth > element.clientWidth), false, `Composer overflow at ${width}x${height}`)
    await page.screenshot({ path: join(screenshots, `${width}x${height}.png`) })
  }
  await lookup.click()
  await composer.getByRole('status').filter({ hasText: 'Do not resend this request' }).waitFor()
  assert.equal(lookups, 1)
  assert.equal(calls.filter(call => call.path === '/api/conversations/ask').length, 1)
  assert.equal(await editor.inputValue(), 'Retain this question after a lost response')
  assert.equal(await page.locator('vite-error-overlay').count(), 0)
  assert.deepEqual(errors.filter(error => !error.includes('503 (Service Unavailable)')), [])
  t.diagnostic(`Rendered screenshot evidence: ${screenshots}; 720x500 is the 200% reflow equivalent of 1440x1000.`)
})
