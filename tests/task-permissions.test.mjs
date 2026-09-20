import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const bundle = await build({
  entryPoints: [new URL('../app/src/TaskPermissions.jsx', import.meta.url).pathname],
  bundle: true, write: false, platform: 'node', format: 'esm', jsx: 'automatic', packages: 'external',
  loader: { '.css': 'empty' },
})
const source = bundle.outputFiles[0].text
  .replaceAll('"react"', JSON.stringify(import.meta.resolve('react')))
  .replaceAll('"react/jsx-runtime"', JSON.stringify(import.meta.resolve('react/jsx-runtime')))
const { TaskPermissions } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
const now = Date.parse('2026-09-20T00:00:00Z')
const lease = {
  taskId: 'alpha', leaseId: 'lease-alpha', agentId: 'ace', profileId: 'connected',
  ceilingProfileId: 'live', agentProfileId: 'sandbox', status: 'active',
  expiresAt: '2026-09-20T01:00:00Z', networkHosts: ['example.test'], tools: ['read', 'web_fetch'],
  executor: 'isolated-workspace',
}
const render = (workspace) => renderToStaticMarkup(React.createElement(TaskPermissions, { workspace, now }))

test('task access shows observed lease, current profile, tool ceiling, hosts, expiry and executor', () => {
  const html = render({ task: { taskId: 'alpha' }, permissions: [lease] })
  for (const value of ['Task access', 'ace', 'lease-alpha', 'connected', 'live', 'sandbox', 'example.test', 'read', 'web_fetch', 'isolated-workspace', '2026-09-20T01:00:00Z']) assert.ok(html.includes(value), value)
  assert.match(html, /not a new permission grant/)
})

test('access summary never inherits unrelated task leases or globally selected executor', () => {
  const html = render({ task: { taskId: 'beta' }, permissions: [lease], routing: { selected: { agentId: 'ace', executor: 'foreign-executor' } } })
  assert.match(html, /No task-bound access lease/)
  assert.doesNotMatch(html, /example\.test|lease-alpha|foreign-executor/)
})

test('missing permissions remain unknown and active-but-expired leases are shown expired', () => {
  const html = render({ task: { taskId: 'alpha' }, permissions: [{ ...lease, expiresAt: '2026-09-19T23:59:00Z', tools: undefined, agentProfileId: undefined, executor: undefined }] })
  assert.match(html, /expired/)
  assert.match(html, /Not recorded/)
  assert.doesNotMatch(html, /Tools unrestricted|Network unrestricted/)
})

test('numeric epoch-millisecond lease expiries render and expire correctly', () => {
  const expiresAt = now - 60_000
  const html = render({ task: { taskId: 'alpha' }, permissions: [{ ...lease, expiresAt }] })
  assert.match(html, /expired/)
  assert.ok(html.includes(`dateTime="${new Date(expiresAt).toISOString()}"`))
  assert.doesNotMatch(html, /Invalid Date/)
})

test('out-of-range lease timestamps remain unknown without throwing', () => {
  const html = render({ task: { taskId: 'alpha' }, permissions: [{ ...lease, expiresAt: Number.MAX_VALUE }] })
  assert.match(html, /Not recorded/)
  assert.doesNotMatch(html, /Invalid Date/)
})

test('native Antigravity executor keeps its distinct permission warning', () => {
  const html = render({ task: { taskId: 'alpha' }, permissions: [{ ...lease, executor: 'antigravity-native' }] })
  assert.match(html, /Antigravity uses its own native permissions/)
  assert.match(html, /does not replace those controls/)
})

test('missing workspace is safe and exact-task native routes warn even without a lease', () => {
  assert.match(render(undefined), /No task-bound access lease/)
  const html = render({ task: { taskId: 'alpha' }, permissions: [], routing: { taskId: 'alpha', selected: { executor: 'antigravity-native' } } })
  assert.match(html, /Antigravity uses its own native permissions/)
})

test('permission labels remain escaped and no mutable controls are introduced', () => {
  const html = render({ task: { taskId: 'alpha' }, permissions: [{ ...lease, agentId: '<script>agent</script>', networkHosts: ['<img src=x onerror=alert(1)>'] }] })
  assert.match(html, /&lt;script&gt;/)
  assert.match(html, /&lt;img/)
  assert.doesNotMatch(html, /<script|<img|<button|<form/)
})
