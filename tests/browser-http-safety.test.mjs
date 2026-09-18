import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { assertLoopbackHost, corsAllowOrigin, isAllowedRequestOrigin, resolveAppAsset } from '../src/browser/http-safety.mjs'

test('browser workspace binds only to an explicit loopback host', () => {
  for (const host of ['127.0.0.1', '::1', 'localhost']) assert.doesNotThrow(() => assertLoopbackHost(host))
  for (const host of ['0.0.0.0', '::', '192.168.1.10', 'chimera.local']) {
    assert.throws(() => assertLoopbackHost(host), /CHIMERA_HOST_MUST_BE_LOOPBACK/)
  }
})

test('browser control API accepts only the Chimera app origins or non-browser clients', () => {
  assert.equal(isAllowedRequestOrigin(undefined), true)
  assert.equal(isAllowedRequestOrigin('http://127.0.0.1:4174'), true)
  assert.equal(isAllowedRequestOrigin('http://127.0.0.1:5173'), true)
  assert.equal(isAllowedRequestOrigin('http://localhost:5173'), true)
  assert.equal(isAllowedRequestOrigin('https://malicious.example'), false)
  assert.equal(isAllowedRequestOrigin('http://127.0.0.1:4174.malicious.example'), false)
})

test('CORS echoes a validated Origin and never invents an unlisted host', () => {
  assert.equal(corsAllowOrigin('http://localhost:5173'), 'http://localhost:5173')
  assert.equal(corsAllowOrigin('http://127.0.0.1:5173'), 'http://127.0.0.1:5173')
  assert.equal(corsAllowOrigin('http://127.0.0.1:4174'), 'http://127.0.0.1:4174')
  assert.equal(corsAllowOrigin(undefined), 'http://127.0.0.1:5173')
  assert.equal(corsAllowOrigin('https://malicious.example'), 'http://127.0.0.1:5173')
})

test('static asset resolution cannot escape the compiled app directory', () => {
  const root = resolve('/tmp/chimera-app-dist')
  assert.equal(resolveAppAsset(root, '/assets/app.js'), resolve(root, 'assets/app.js'))
  assert.equal(resolveAppAsset(root, '/'), resolve(root, 'index.html'))
  assert.equal(resolveAppAsset(root, '/../README.md'), resolve(root, 'index.html'))
  assert.equal(resolveAppAsset(root, '/../../.env'), resolve(root, 'index.html'))
})
