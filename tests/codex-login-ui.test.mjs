import assert from 'node:assert/strict'
import test from 'node:test'
import * as apiModule from '../app/src/api.js'

test('Codex connect action takes human control and opens the managed login inside Chimera', async () => {
  assert.equal(typeof apiModule.startCodexBrowserLogin, 'function')
  const requests = []
  const result = await apiModule.startCodexBrowserLogin({
    humanControl: false,
    async postImpl(path, body = {}) {
      requests.push({ path, body })
      if (path === '/api/auth/codex/login') {
        return { loginId: 'login-1', authUrl: 'https://chatgpt.com/auth/login' }
      }
      return { status: 'allowed' }
    },
  })

  assert.deepEqual(requests, [
    { path: '/api/auth/codex/login', body: {} },
    { path: '/api/control/take', body: {} },
    { path: '/api/browser/human', body: { command: 'open-tab', url: 'https://chatgpt.com/auth/login' } },
  ])
  assert.deepEqual(result, { loginId: 'login-1', authUrl: 'https://chatgpt.com/auth/login' })
})

test('Codex connect action preserves an existing human browser lease', async () => {
  assert.equal(typeof apiModule.startCodexBrowserLogin, 'function')
  const requests = []
  await apiModule.startCodexBrowserLogin({
    humanControl: true,
    async postImpl(path, body = {}) {
      requests.push({ path, body })
      if (path === '/api/auth/codex/login') {
        return { loginId: 'login-2', authUrl: 'https://chatgpt.com/auth/login' }
      }
      return { status: 'allowed' }
    },
  })

  assert.deepEqual(requests.map(({ path }) => path), [
    '/api/auth/codex/login',
    '/api/browser/human',
  ])
})
