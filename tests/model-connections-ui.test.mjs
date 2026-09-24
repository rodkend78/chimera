import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { firefox } from 'playwright'

test('Settings saves and disconnects an OpenRouter key without redisplaying it', async () => {
  const bundle = await build({ stdin: {
    contents: "import React from 'react'; import { createRoot } from 'react-dom/client'; import { OpenRouterConnection } from './app/src/OpenRouterConnection.jsx'; createRoot(document.getElementById('root')).render(<OpenRouterConnection />);",
    resolveDir: new URL('..', import.meta.url).pathname,
    loader: 'jsx',
  }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' } })
  const browser = await firefox.launch({ headless: true })
  try {
    const page = await browser.newPage()
    const key = 'synthetic_openrouter_key_123'
    let stored = null
    let models = ['openrouter/free']
    const responses = []
    await page.route('http://openrouter.test/**', async route => {
      const request = route.request()
      const path = new URL(request.url()).pathname
      const respond = (body, status = 200) => {
        responses.push(body)
        return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
      }
      if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script src="/ui.js"></script>' })
      if (path === '/ui.js') return route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0].text })
      if (path === '/api/operator/session') return respond({ csrfToken: 'test-only', expiresAt: '2099-01-01T00:00:00Z' })
      if (path === '/api/openrouter/settings' && request.method() === 'GET') return respond({ configured: stored !== null, provider: 'openrouter', models })
      if (path === '/api/openrouter/settings' && request.method() === 'POST') {
        assert.equal(request.headers()['x-chimera-csrf'], 'test-only')
        const body = request.postDataJSON()
        stored = body.apiKey ?? stored
        models = body.models
        return respond({ configured: true, provider: 'openrouter', models })
      }
      if (path === '/api/openrouter/disconnect') {
        stored = null; models = ['openrouter/free']
        return respond({ configured: false, provider: 'openrouter', models })
      }
      return respond({ error: 'NOT_FOUND' }, 404)
    })
    await page.goto('http://openrouter.test/')
    await page.getByText('Not configured', { exact: true }).waitFor()
    await page.getByLabel('OpenRouter API key').fill(key)
    await page.getByLabel('Model IDs, one per line').fill('openrouter/free\nanthropic/claude-sonnet-4')
    await page.getByRole('button', { name: 'Save connection' }).click()
    await page.getByText('Key saved', { exact: true }).waitFor()
    assert.equal(stored, key)
    assert.deepEqual(models, ['openrouter/free', 'anthropic/claude-sonnet-4'])
    assert.equal(await page.getByLabel('OpenRouter API key').inputValue(), '')
    assert.equal((await page.locator('body').innerText()).includes(key), false)
    assert.equal(responses.some(response => JSON.stringify(response).includes(key)), false)
    await page.getByRole('button', { name: 'Disconnect OpenRouter' }).click()
    await page.getByText('Not configured', { exact: true }).waitFor()
    assert.equal(stored, null)
    await page.setViewportSize({ width: 390, height: 844 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  } finally { await browser.close() }
})
