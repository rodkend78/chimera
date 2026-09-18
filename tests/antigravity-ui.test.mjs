import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { readFile } from 'node:fs/promises'

test('Only Antigravity local-ready entries enter the model picker before a live call', async () => {
  const mod = await import('../app/src/model-availability.js').catch(() => ({}))
  assert.equal(typeof mod.isSelectableConversationModel, 'function')
  assert.equal(mod.isSelectableConversationModel({ id: 'antigravity', configured: true }, { capabilities: ['conversation'], availability: 'local-ready' }), true)
  assert.equal(mod.isSelectableConversationModel({ id: 'aws-bedrock', configured: true }, { capabilities: ['conversation'], availability: 'local-ready' }), false)
  assert.equal(mod.isSelectableConversationModel({ id: 'antigravity', configured: false }, { capabilities: ['conversation'], availability: 'local-ready' }), false)
})

for (const blocked of [false, true]) test(`Antigravity connection card requires explicit discovery and reports ${blocked ? 'blocked delegation' : 'launch uncertainty'} honestly`, async () => {
  const provider = { configured: !blocked, connectionStatus: blocked ? 'unavailable' : 'ready-to-test', ...(blocked ? { error: 'ANTIGRAVITY_HANDSHAKE_INVALID' } : {}), models: Array.from({ length: blocked ? 14 : 1 }, (_, index) => ({ id: `gemini-test-${index}`, name: `Gemini Test ${index}` })) }
  const source = await readFile(new URL('../app/src/AntigravityConnection.jsx', import.meta.url), 'utf8').catch(() => '')
  assert.ok(source.length, 'Connection UI exists')
  const bundle = await build({ stdin: { contents: `import React,{useState} from 'react'; import {createRoot} from 'react-dom/client'; import {AntigravityConnection} from './app/src/AntigravityConnection.jsx';
    function Harness(){const [provider,setProvider]=useState({connectionStatus:'not-checked'}); return <AntigravityConnection provider={provider} refresh={async()=>setProvider(${JSON.stringify(provider)})}/>}; createRoot(document.getElementById('root')).render(<Harness/>);`, resolveDir: new URL('..', import.meta.url).pathname, loader: 'jsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' } })
  const css = await readFile(new URL('../app/src/antigravity-connection.css', import.meta.url), 'utf8')
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    const calls = [], errors = []
    page.on('pageerror', e => errors.push(e.message))
    await page.route('http://antigravity.test/**', route => {
      const path = new URL(route.request().url()).pathname
      const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
      if (path === '/') return route.fulfill({ contentType: 'text/html', body: `<title>Chimera Antigravity test</title><style>body{font-family:system-ui;color:#18283e;margin:0;background:#f9fbfd} ${css}</style><div id="root"></div><script src="/ui.js"></script>` })
      if (path === '/ui.js') return route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0].text })
      if (path === '/api/operator/session') return json({ csrfToken: 'fixture', expiresAt: '2099-01-01T00:00:00Z' })
      calls.push(path)
      if (path.endsWith('/refresh')) return json(provider)
      return json({ error: 'ANTIGRAVITY_DESKTOP_LAUNCH_FAILED' }, 503)
    })
    await page.goto('http://antigravity.test/')
    await page.getByRole('heading', { name: 'Antigravity' }).waitFor()
    assert.equal(calls.length, 0)
    await page.getByRole('button', { name: 'Find Antigravity models' }).click()
    if (blocked) {
      await page.getByRole('alert').filter({ hasText: 'Could not verify the CLI session' }).waitFor()
      await page.getByText('Not connected', { exact: true }).waitFor()
      await page.getByText('View available models (14)', { exact: true }).click()
      assert.equal(await page.getByRole('list', { name: 'Antigravity models' }).getByRole('listitem').count(), 14)
    } else await page.getByText('Available to select', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Open Antigravity app' }).click()
    await page.getByText(/Launch not confirmed/).waitFor()
    assert.deepEqual(calls, ['/api/antigravity/refresh', '/api/antigravity/open'])
    assert.deepEqual(errors, [])
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await page.screenshot({ path: `/tmp/chimera-antigravity-${blocked ? 'blocked-' : ''}mobile.png`, fullPage: true })
    await page.setViewportSize({ width: 1100, height: 800 })
    await page.screenshot({ path: `/tmp/chimera-antigravity-${blocked ? 'blocked-' : ''}desktop.png`, fullPage: true })
  } finally { await browser.close() }
})
