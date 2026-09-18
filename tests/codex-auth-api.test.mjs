import assert from 'node:assert/strict'
import test from 'node:test'

test('Codex auth HTTP boundary exposes status, starts login, and refreshes connection', async () => {
  const module = await import('../src/browser/auth-api.mjs').catch(() => ({}))
  assert.equal(typeof module.handleCodexAuthRequest, 'function')
  const calls = []
  const runtime = {
    codexAuthState() {
      calls.push('state')
      return { provider: 'codex', connected: false, status: 'disconnected' }
    },
    async startCodexLogin() {
      calls.push('login')
      return { loginId: 'login-1', authUrl: 'https://chatgpt.com/auth/login' }
    },
    async refreshCodexAuth() {
      calls.push('refresh')
      return { provider: 'codex', connected: true, status: 'connected' }
    },
  }

  assert.deepEqual(await module.handleCodexAuthRequest({
    pathname: '/api/auth/codex', method: 'GET', runtime,
  }), { status: 200, body: { provider: 'codex', connected: false, status: 'disconnected' } })
  assert.deepEqual(await module.handleCodexAuthRequest({
    pathname: '/api/auth/codex/login', method: 'POST', runtime,
  }), { status: 200, body: { loginId: 'login-1', authUrl: 'https://chatgpt.com/auth/login' } })
  assert.deepEqual(await module.handleCodexAuthRequest({
    pathname: '/api/auth/codex/refresh', method: 'POST', runtime,
  }), { status: 200, body: { provider: 'codex', connected: true, status: 'connected' } })
  assert.equal(await module.handleCodexAuthRequest({
    pathname: '/api/auth/codex/unknown', method: 'POST', runtime,
  }), null)
  assert.deepEqual(calls, ['state', 'login', 'refresh'])
})
