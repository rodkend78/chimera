import test from 'node:test'
import assert from 'node:assert/strict'
import { assertSafeBrowserUrl } from '../src/browser/executor.mjs'

test('browser URL policy permits public web destinations and the Chimera demo origin', () => {
  assert.equal(assertSafeBrowserUrl('https://example.com/research?q=agents'), 'https://example.com/research?q=agents')
  assert.equal(assertSafeBrowserUrl('http://chimera.local/research'), 'http://chimera.local/research')
  assert.equal(assertSafeBrowserUrl('about:blank'), 'about:blank')
})

test('browser URL policy rejects active-content and local-file protocols', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,hello', 'file:///etc/passwd', 'about:config']) {
    assert.throws(() => assertSafeBrowserUrl(url), /protocol is blocked/)
  }
})

test('browser URL policy rejects embedded credentials and private network destinations', () => {
  const blocked = [
    'https://user:secret@example.com/',
    'http://localhost:3000/',
    'http://127.0.0.1/',
    'http://10.1.2.3/',
    'http://169.254.169.254/latest/meta-data/',
    'http://172.20.1.2/',
    'http://192.168.1.2/',
    'http://[::1]/',
    'http://[fc00::1]/',
    'http://[fe80::1]/',
    'http://internal.local/',
  ]

  for (const url of blocked) assert.throws(() => assertSafeBrowserUrl(url), /blocked/)
})

test('malformed browser URLs fail closed', () => {
  assert.throws(() => assertSafeBrowserUrl('not a URL'), /invalid/)
})
