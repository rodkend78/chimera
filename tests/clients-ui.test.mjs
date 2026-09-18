import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const app = await readFile(new URL('../app/src/App.jsx', import.meta.url), 'utf8')
const awaitNavigation = await readFile(new URL('../app/src/WorkspaceNavigation.jsx', import.meta.url), 'utf8')
test('Clients navigation and query deep link leave operator hash handling alone', () => {
  assert.match(awaitNavigation, /\['Clients', 'Clients', Users\]/)
  assert.match(app, /activeSection === 'Clients'/)
  assert.match(app, /initialClientSection\(window.location.search\)/)
  assert.doesNotMatch(app, /location.hash\s*=/)
})

let ui
const temp = await mkdtemp(join(tmpdir(), 'clients-ui-'))
try {
  await build({ entryPoints: [new URL('../app/src/ClientWorkspace.jsx', import.meta.url).pathname], outfile: join(temp, 'ui.mjs'), bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', packages: 'external', loader: { '.css': 'empty' } })
  // Resolve React from this repo even though the generated module is temporary.
  const source = (await readFile(join(temp, 'ui.mjs'), 'utf8')).replaceAll('"react"', JSON.stringify(import.meta.resolve('react'))).replaceAll('"react/jsx-runtime"', JSON.stringify(import.meta.resolve('react/jsx-runtime')))
  ui = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
} finally { await rm(temp, { recursive: true, force: true }) }

test('query routing is exact and does not consume operator tokens', () => {
  assert.equal(ui.initialClientSection('?workspace=clients'), 'Clients')
  assert.equal(ui.initialClientSection('?workspace=client'), 'Queue')
  assert.equal(ui.initialClientSection(''), 'Queue')
})
test('only an explicitly configured repository HTTPS reference becomes a link', () => {
  const repository = 'https://github.com/example-org/example-repo'
  for (const ref of ['javascript:alert(1)', 'https://github.com.evil/example-org/example-repo/a', 'https://github.com/example-org/other/a', 'https://user@github.com/example-org/example-repo/a', 'https://github.com/example-org/example-repo/../other/a']) assert.equal(ui.safeSourceUrl(ref, repository), null)
  assert.equal(ui.safeSourceUrl('https://github.com/example-org/example-repo/blob/main/a.md', repository), 'https://github.com/example-org/example-repo/blob/main/a.md')
  assert.equal(ui.safeSourceUrl('https://github.com/example-org/example-repo/blob/main/a.md'), null, 'no repository config must deny by default')
  assert.equal(ui.sourceRepositoryFromEnv({}), null)
  assert.equal(ui.sourceRepositoryFromEnv({ VITE_CHIMERA_SOURCE_REPOSITORY: repository }), repository)
  assert.equal(ui.sourceRepositoryFromEnv({ VITE_CHIMERA_SOURCE_REPOSITORY: `${repository}/nested` }), null)
})
test('source content is escaped text; unsafe attribution is inert', () => {
  const html = renderToStaticMarkup(React.createElement(ui.SourceContent, { document: { title: '<script>title</script>', content: '<img src=x onerror=alert(1)>', status: 'imported', origin: { label: 'Source', ref: 'javascript:alert(1)' } } }))
  assert.match(html, /&lt;img/)
  assert.doesNotMatch(html, /<img|<script|href="javascript:/)
})
test('large catalogs are searched and filtered before pagination with imported text first', () => {
  const docs = Array.from({ length: 4300 }, (_, i) => ({ id: `d${i}`, title: `Entry ${i}`, category: i % 2 ? 'code' : 'notes', status: i === 4298 ? 'imported' : 'linked', kind: i === 4298 ? 'document' : 'code' }))
  const first = ui.sourcePage(docs, { page: 0 })
  assert.equal(first.items.length, 50)
  assert.equal(first.total, 4300)
  assert.equal(first.items[0].id, 'd4298')
  assert.equal(ui.sourcePage(docs, { query: 'Entry 4298', category: 'notes', status: 'imported' }).total, 1)
  assert.equal(ui.sourcePage(docs, { page: 85 }).items.length, 50)
  assert.equal(ui.sourcePage([], {}).pages, 1)
})
test('duplicates resolve canonical references with cycles and missing refs rejected', () => {
  const docs = [{ id: 'a', duplicateOf: 'b' }, { id: 'b', duplicateOf: 'c' }, { id: 'c' }]
  assert.equal(ui.canonicalDocumentId(docs, 'a'), 'c')
  assert.equal(ui.canonicalDocumentId([{ id: 'a', duplicateOf: 'a' }], 'a'), null)
  assert.equal(ui.canonicalDocumentId([{ id: 'a', duplicateOf: 'missing' }], 'a'), null)
})
test('initial view honestly shows loading and labels its directory', () => {
  const html = renderToStaticMarkup(React.createElement(ui.ClientWorkspace))
  assert.match(html, /Loading clients/)
  assert.match(html, /Search clients/)
})

for (const [firstId, secondId] of [['A', 'B'], ['constructor', 'toString']]) {
test(`browser: drafts, failed saves, canonical sources and late requests are isolated by client (${firstId}, ${secondId})`, async () => {
  const { firefox } = await import('playwright')
  const bundle = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {ClientWorkspace} from './app/src/ClientWorkspace.jsx'; createRoot(document.getElementById('root')).render(<ClientWorkspace/>);`, resolveDir: new URL('..', import.meta.url).pathname, loader: 'jsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' } })
  const browser = await firefox.launch({ headless: true })
  try {
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    const notes = { [firstId]: [], [secondId]: [] }
    let saveFails = true
    let heldSource
    let sourceStarted
    const started = new Promise(resolve => { sourceStarted = resolve })
    await page.route('http://clients.test/**', async route => {
      const path = new URL(route.request().url()).pathname
      const respond = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
      if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script src="/ui.js"></script>' })
      if (path === '/ui.js') return route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0].text })
      if (path === '/api/operator/session') return respond({ csrfToken: 'test-only', expiresAt: '2099-01-01T00:00:00Z' })
      if (path === '/api/clients') return respond({ state: 'ready', clients: [firstId, secondId].map(id => ({ id, name: `Client ${id}`, summary: 'Test fixture', status: 'pilot', documentCount: 3 })) })
      const id = path.split('/')[3]
      const documents = [{ id: 'slow', title: 'Slow source', kind: 'document', status: 'imported', category: 'notes' }, { id: 'canonical', title: 'Canonical source', kind: 'document', status: 'imported', category: 'notes' }, { id: 'duplicate', title: 'Duplicate source', kind: 'reference', status: 'linked', category: 'notes', duplicateOf: 'canonical' }]
      if (path.endsWith('/documents/slow')) { heldSource = route; sourceStarted(); return }
      if (path.endsWith('/documents/canonical')) return respond({ ...documents[1], content: '<script>unsafe()</script> Canonical text' })
      if (path.endsWith('/notes')) {
        if (saveFails) return respond({ error: 'TEST_SAVE_FAILURE' }, 503)
        const note = { ...route.request().postDataJSON(), id: 'n1', clientId: id, createdAt: '2026-01-01T00:00:00Z', status: 'unreviewed' }
        notes[id].push(note)
        return respond(note, 201)
      }
      return respond({ client: { id, name: `Client ${id}`, summary: 'Test fixture', status: 'pilot' }, documents, coverage: [], notes: notes[id] })
    })
    await page.goto('http://clients.test/')
    await page.getByLabel('Note title').fill('Draft A', { timeout: 5000 }).catch(error => {
      assert.deepEqual(errors, [], 'client workspace must render without browser errors')
      throw error
    })
    await page.getByLabel('Note body').fill('Keep this text')
    await page.getByRole('button', { name: /Duplicate source/ }).click()
    await page.getByText('<script>unsafe()</script> Canonical text', { exact: true }).waitFor()
    assert.equal(await page.locator('.client-document script').count(), 0)
    assert.equal(await page.getByLabel('Note title').inputValue(), 'Draft A')
    await page.getByRole('button', { name: /Slow source/ }).click()
    await started
    await page.getByRole('button', { name: new RegExp(`Client ${secondId}`) }).click()
    await page.getByRole('heading', { name: `Client ${secondId}`, exact: true }).waitFor()
    await heldSource.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: 'slow', title: 'Wrong client', content: 'STALE CLIENT A' }) }).catch(() => {})
    assert.equal(await page.getByText('STALE CLIENT A').count(), 0)
    assert.equal(await page.getByLabel('Note title').inputValue(), '')
    await page.getByLabel('Note title').fill('Draft B')
    await page.getByRole('button', { name: new RegExp(`Client ${firstId}`) }).click()
    await page.getByRole('heading', { name: `Client ${firstId}`, exact: true }).waitFor()
    assert.equal(await page.getByLabel('Note title').inputValue(), 'Draft A')
    await page.getByRole('button', { name: 'Save unreviewed note' }).click()
    await page.getByText(/Save not confirmed/).waitFor()
    assert.equal(await page.getByLabel('Note body').inputValue(), 'Keep this text')
    saveFails = false
    await page.getByRole('button', { name: 'Save unreviewed note' }).click()
    await page.getByRole('heading', { name: 'Draft A', exact: true }).waitFor()
    assert.equal(await page.getByLabel('Note title').inputValue(), '')
    await page.getByRole('button', { name: new RegExp(`Client ${secondId}`) }).click()
    await page.getByRole('heading', { name: `Client ${secondId}`, exact: true }).waitFor()
    assert.equal(await page.getByLabel('Note title').inputValue(), 'Draft B')
    assert.equal(await page.getByText(/Note saved as unreviewed/).count(), 0)
    await page.getByLabel('Note body').fill('Second client text')
    await page.getByRole('button', { name: 'Save unreviewed note' }).click()
    await page.getByRole('heading', { name: 'Draft B', exact: true }).waitFor()
    assert.equal(await page.getByLabel('Note title').inputValue(), '')
    assert.equal(notes[firstId].length, 1)
    assert.equal(notes[secondId].length, 1)
    assert.deepEqual(errors, [])
  } finally { await browser.close() }
})
}
