import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { build } from 'esbuild'
import { firefox } from 'playwright'

test('Settings lets an operator save and remove their own Jev key without displaying it again', async () => {
  const bundle = await build({ stdin: {
    contents: "import React from 'react'; import { createRoot } from 'react-dom/client'; import { JevConnection } from './app/src/JevConnection.jsx'; createRoot(document.getElementById('root')).render(<JevConnection />);",
    resolveDir: new URL('..', import.meta.url).pathname,
    loader: 'jsx',
  }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' } })
  const browser = await firefox.launch({ headless: true })
  const css = await readFile(new URL('../app/src/jev-connection.css', import.meta.url), 'utf8')
  try {
    const page = await browser.newPage()
    const key = 'test_personal_key_123'
    let stored = null
    const responses = []
    await page.route('http://jev.test/**', async route => {
      const request = route.request()
      const path = new URL(request.url()).pathname
      const respond = (body, status = 200) => {
        responses.push({ path, body })
        return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
      }
      if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/ui.js"></script>' })
      if (path === '/ui.js') return route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0].text })
      if (path === '/style.css') return route.fulfill({ contentType: 'text/css', body: css })
      if (path === '/api/operator/session') return respond({ csrfToken: 'test-only', expiresAt: '2099-01-01T00:00:00Z' })
      if (path === '/api/jev/settings' && request.method() === 'GET') return respond({ configured: stored !== null, provider: 'typesafe', model: 'jev-latest' })
      if (path === '/api/jev/settings' && request.method() === 'POST') {
        assert.equal(request.headers()['x-chimera-csrf'], 'test-only')
        stored = request.postDataJSON().apiKey
        return respond({ configured: true, provider: 'typesafe', model: 'jev-latest' })
      }
      if (path === '/api/jev/disconnect') {
        stored = null
        return respond({ configured: false, provider: 'typesafe', model: 'jev-latest' })
      }
      return respond({ error: 'NOT_FOUND' }, 404)
    })
    await page.goto('http://jev.test/')
    await page.getByText('Not configured', { exact: true }).waitFor()
    await page.getByLabel('TypeSafe API key').fill(key)
    await page.getByRole('button', { name: 'Save key' }).click()
    await page.getByText('Key saved', { exact: true }).waitFor()
    assert.equal(stored, key)
    assert.equal(await page.getByLabel('TypeSafe API key').inputValue(), '')
    assert.equal((await page.locator('body').innerText()).includes(key), false)
    assert.equal(responses.some(response => JSON.stringify(response.body).includes(key)), false)
    await page.getByRole('button', { name: 'Disconnect Jev' }).click()
    await page.getByText('Not configured', { exact: true }).waitFor()
    assert.equal(stored, null)
    await page.setViewportSize({ width: 390, height: 844 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  } finally { await browser.close() }
})
