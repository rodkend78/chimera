import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'
import { chromium } from 'playwright'

for (const succeeds of [true, false]) test(`RJ AWS connection is isolated, responsive and reports ${succeeds ? 'verified execution' : 'uncertain failure'} honestly`, async t => {
  const temporaryArtifacts = await mkdtemp(join(tmpdir(), 'chimera-rj-aws-ui-'))
  const screenshotDirectory = process.env.CHIMERA_RJ_AWS_TEST_ARTIFACT_DIR || temporaryArtifacts
  t.after(() => rm(temporaryArtifacts, { recursive: true, force: true }))
  const source = await readFile(new URL('../app/src/RjAwsConnection.jsx', import.meta.url), 'utf8').catch(() => '')
  assert.ok(source.length, 'RJ AWS connection UI exists')
  const configured = { schema: 'chimera.rj-aws-connection.v1', configured: true, status: 'transport-ready',
    target: { account: '000000000000', region: 'example-region-1', instanceId: 'i-example00000000000', ssh: 'example-user@example.invalid' },
    transport: { status: 'ready' }, execution: { status: 'not-verified' }, lastReceipt: null }
  const failedState = { ...configured, execution: { status: 'unknown' }, retention: { status: 'retained' }, audit: { status: 'unavailable' },
    requests: [{ requestId: 'original-request', taskId: 'original-task', operation: 'rj.aws.identity', outcome: 'unknown' }] }
  const reconciledState = { ...failedState, execution: { status: 'reconciled' }, audit: { status: 'retained' },
    requests: [{ requestId: 'original-request', taskId: 'original-task', operation: 'rj.aws.identity', outcome: 'succeeded' }] }
  const verified = { ...configured, status: 'execution-verified', execution: { status: 'verified' },
    lastReceipt: { requestId: 'request-fixture', operation: 'rj.aws.instance_status', outcome: 'succeeded', completedAt: '2026-09-08T12:00:02.000Z' } }
  const bundle = await build({ stdin: { contents: `import React,{useState} from 'react'; import {createRoot} from 'react-dom/client'; import {RjAwsConnection} from './app/src/RjAwsConnection.jsx';
    let refreshCount=0; function Harness(){const [connection,setConnection]=useState(${JSON.stringify(configured)}); return <RjAwsConnection connection={connection} refresh={async()=>setConnection(++refreshCount===1?${JSON.stringify(succeeds ? verified : failedState)}:${JSON.stringify(reconciledState)})}/>}; createRoot(document.getElementById('root')).render(<Harness/>);`,
    resolveDir: new URL('..', import.meta.url).pathname, loader: 'jsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' } })
  const css = await readFile(new URL('../app/src/rj-aws-connection.css', import.meta.url), 'utf8')
  await mkdir(screenshotDirectory, { recursive: true })
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    const apiCalls = [], errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => {
      if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) errors.push(message.text())
    })
    await page.route('http://rj-aws.test/**', route => {
      const path = new URL(route.request().url()).pathname
      const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
      if (path === '/') return route.fulfill({ contentType: 'text/html', body: `<title>RJ AWS connection test</title><style>:root{--border:#dce4ee;--surface:#f4f7fc}body{font-family:system-ui;color:#18283e;margin:0;background:#f9fbfd} ${css}</style><div id="root"></div><script src="/ui.js"></script>` })
      if (path === '/ui.js') return route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0].text })
      if (path === '/api/operator/session') return json({ csrfToken: 'fixture', expiresAt: '2099-01-01T00:00:00Z' })
      apiCalls.push({ path, method: route.request().method(), body: route.request().postData(), csrf: route.request().headers()['x-chimera-csrf'] })
      if (path === '/api/rj-aws/reconcile') return json({ status: 'reconciled' })
      return succeeds ? json({ status: 'verified' }) : json({ error: 'RJ_AWS_OUTCOME_UNKNOWN' }, 503)
    })
    await page.goto('http://rj-aws.test/')
    await page.getByRole('heading', { name: 'RJ AWS worker' }).waitFor()
    assert.deepEqual(apiCalls, [], 'render and state presentation perform no connector request')
    await page.getByRole('button', { name: 'Verify signed execution' }).click()
    await page.getByRole(succeeds ? 'status' : 'alert').waitFor()
    assert.deepEqual(apiCalls, [{ path: '/api/rj-aws/verify', method: 'POST', body: '{}', csrf: 'fixture' }])
    await page.getByText(succeeds ? 'Execution verified' : 'Execution not verified', { exact: true }).waitFor()
    if (!succeeds) {
      assert.equal(await page.getByText('Signed evidence retained locally', { exact: true }).count(), 1)
      assert.equal(await page.getByText('Audit unavailable', { exact: true }).count(), 1)
      await page.screenshot({ path: `${screenshotDirectory}/rj-aws-audit-failure-mobile.png`, fullPage: true })
      await page.setViewportSize({ width: 1100, height: 800 })
      await page.screenshot({ path: `${screenshotDirectory}/rj-aws-audit-failure-desktop.png`, fullPage: true })
      await page.setViewportSize({ width: 390, height: 844 })
      await page.getByRole('button', { name: 'Reconcile original request' }).click()
      await page.getByRole('status').waitFor()
      assert.deepEqual(apiCalls[1], { path: '/api/rj-aws/reconcile', method: 'POST', body: '{"requestId":"original-request"}', csrf: 'fixture' })
      assert.equal(apiCalls.length, 2, 'reconciliation never invokes Verify or creates a replacement execution')
      await page.getByText('Execution not verified', { exact: true }).waitFor()
      await page.getByText('rj.aws.identity · succeeded', { exact: true }).waitFor()
    }
    assert.deepEqual(errors, [])
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    const label = succeeds ? 'verified' : 'failure'
    await page.screenshot({ path: `${screenshotDirectory}/rj-aws-${label}-mobile.png`, fullPage: true })
    await page.setViewportSize({ width: 1100, height: 800 })
    await page.screenshot({ path: `${screenshotDirectory}/rj-aws-${label}-desktop.png`, fullPage: true })
  } finally { await browser.close() }
})
