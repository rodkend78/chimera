import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  TemporaryCallbackPolicy,
  inspectCodexLoginUrl,
  redactSensitiveBrowserUrl,
} from '../src/browser/auth-navigation.mjs'
import { ChromiumBrowserExecutor } from '../src/browser/executor.mjs'

const loginUrl = 'https://auth.openai.com/oauth/authorize?state=private-state&code_challenge=private-challenge&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback'

test('managed Codex login accepts only the narrow OpenAI to loopback callback shape', () => {
  assert.deepEqual(inspectCodexLoginUrl(loginUrl), {
    authUrl: loginUrl,
    callbackUrl: 'http://localhost:1455/auth/callback',
  })
  assert.throws(() => inspectCodexLoginUrl(
    'https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2F169.254.169.254%2Flatest',
  ), /CODEX_AUTH_CALLBACK_UNTRUSTED/)
  assert.throws(() => inspectCodexLoginUrl(
    'https://chatgpt.com.attacker.example/oauth?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback',
  ), /CODEX_AUTH_URL_UNTRUSTED/)
})

test('temporary callback policy permits only the issued origin and callback path', () => {
  let now = 1_000
  const policy = new TemporaryCallbackPolicy({ now: () => now })
  policy.allow('http://localhost:1455/auth/callback', { lifetimeMs: 5_000 })

  assert.equal(policy.allows('http://localhost:1455/auth/callback?code=one&state=two'), true)
  assert.equal(policy.allows('http://localhost:1455/other?code=one'), false)
  assert.equal(policy.allows('http://127.0.0.1:1455/auth/callback?code=one'), false)
  now = 6_001
  assert.equal(policy.allows('http://localhost:1455/auth/callback?code=one'), false)
})

test('OAuth transaction parameters are removed from observable browser URLs', () => {
  assert.equal(redactSensitiveBrowserUrl(loginUrl), 'https://auth.openai.com/oauth/authorize')
  assert.equal(
    redactSensitiveBrowserUrl('http://localhost:1455/auth/callback?code=private-code&state=private-state'),
    'http://localhost:1455/auth/callback',
  )
  assert.equal(
    redactSensitiveBrowserUrl('https://example.com/search?q=keep-this'),
    'https://example.com/search?q=keep-this',
  )
})

test('Chromium admits only an issued loopback OAuth callback and does not persist it', async () => {
  const profileDir = await mkdtemp(join(tmpdir(), 'chimera-auth-callback-'))
  const server = createServer((_request, response) => response.end('<title>Codex connected</title>'))
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  const callbackUrl = `http://127.0.0.1:${port}/auth/callback`
  const executor = new ChromiumBrowserExecutor({
    profileDir,

  })
  try {
    await assert.rejects(
      executor.openTab(`${callbackUrl}?code=blocked&state=blocked`),
      /Private-network browser destinations are blocked/,
    )
    executor.allowTemporaryNavigation(callbackUrl)
    const opened = await executor.openTab(`${callbackUrl}?code=private-code&state=private-state`)
    assert.equal(opened.tabs.some((tab) => tab.url === callbackUrl), true)

    await executor.suspend()
    const saved = JSON.parse(await readFile(join(profileDir, 'chimera-tabs.json'), 'utf8'))
    assert.equal(JSON.stringify(saved).includes('private-code'), false)
    assert.equal(JSON.stringify(saved).includes('private-state'), false)
    assert.equal(saved.tabs.some((tab) => tab.url === 'about:blank'), true)
  } finally {
    await executor.suspend().catch(() => undefined)
    await new Promise((resolve) => server.close(resolve))
    await rm(profileDir, { recursive: true, force: true })
  }
})
