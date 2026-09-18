import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'

async function loadAuthClient() {
  return import('../src/ceo/codex-app-server-auth.mjs').catch(() => ({}))
}

function fakeAppServer(responder) {
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => {
    child.emit('exit', 0, null)
    return true
  }
  let buffer = ''
  child.stdin.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    while (buffer.includes('\n')) {
      const newline = buffer.indexOf('\n')
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      const message = JSON.parse(line)
      const response = responder(message)
      if (response) child.stdout.write(`${JSON.stringify(response)}\n`)
    }
  })
  return child
}

test('Codex App Server auth reports ChatGPT connection without exposing account secrets', async () => {
  const { CodexAppServerAuth } = await loadAuthClient()
  assert.equal(typeof CodexAppServerAuth, 'function')
  const child = fakeAppServer((message) => {
    if (message.method === 'initialize') return { id: message.id, result: { userAgent: 'codex-test' } }
    if (message.method === 'account/read') {
      return {
        id: message.id,
        result: {
          account: {
            type: 'chatgpt',
            email: 'private@example.com',
            planType: 'plus',
            accessToken: 'must-not-leak',
          },
          requiresOpenaiAuth: true,
        },
      }
    }
    return null
  })
  const auth = new CodexAppServerAuth({ spawnImpl: () => child })
  try {
    assert.deepEqual(await auth.read(), {
      provider: 'codex',
      available: true,
      connected: true,
      status: 'connected',
      authentication: 'chatgpt-subscription',
      planType: 'plus',
    })
    assert.equal(JSON.stringify(auth.state()).includes('private@example.com'), false)
    assert.equal(JSON.stringify(auth.state()).includes('must-not-leak'), false)
  } finally {
    await auth.close()
  }
})

test('Codex App Server auth starts the managed ChatGPT browser flow and tracks completion', async () => {
  const { CodexAppServerAuth } = await loadAuthClient()
  assert.equal(typeof CodexAppServerAuth, 'function')
  const child = fakeAppServer((message) => {
    if (message.method === 'initialize') return { id: message.id, result: { userAgent: 'codex-test' } }
    if (message.method === 'account/login/start') {
      assert.deepEqual(message.params, {
        type: 'chatgpt',
        useHostedLoginSuccessPage: true,
        appBrand: 'chatgpt',
      })
      return {
        id: message.id,
        result: {
          type: 'chatgpt',
          loginId: 'f80cc022-40d8-489f-8071-4f0ea40478e0',
          authUrl: 'https://chatgpt.com/auth/login?redirect_uri=http%3A%2F%2Flocalhost%3A53100%2Fauth%2Fcallback',
        },
      }
    }
    return null
  })
  const auth = new CodexAppServerAuth({ spawnImpl: () => child })
  try {
    const login = await auth.startLogin()
    assert.deepEqual(login, {
      loginId: 'f80cc022-40d8-489f-8071-4f0ea40478e0',
      authUrl: 'https://chatgpt.com/auth/login?redirect_uri=http%3A%2F%2Flocalhost%3A53100%2Fauth%2Fcallback',
      callbackUrl: 'http://localhost:53100/auth/callback',
    })
    assert.equal(auth.state().status, 'connecting')

    child.stdout.write(`${JSON.stringify({
      method: 'account/login/completed',
      params: { loginId: login.loginId, success: true, error: null },
    })}\n`)
    child.stdout.write(`${JSON.stringify({
      method: 'account/updated',
      params: { authMode: 'chatgpt', planType: 'plus', email: 'never-return-this@example.com' },
    })}\n`)
    await new Promise((resolve) => setImmediate(resolve))

    assert.deepEqual(auth.state(), {
      provider: 'codex',
      available: true,
      connected: true,
      status: 'connected',
      authentication: 'chatgpt-subscription',
      planType: 'plus',
      login: {
        loginId: 'f80cc022-40d8-489f-8071-4f0ea40478e0',
        status: 'succeeded',
      },
    })
    assert.equal(JSON.stringify(auth.state()).includes('never-return-this@example.com'), false)
  } finally {
    await auth.close()
  }
})

test('Codex App Server auth rejects an untrusted authorization URL', async () => {
  const { CodexAppServerAuth } = await loadAuthClient()
  assert.equal(typeof CodexAppServerAuth, 'function')
  const child = fakeAppServer((message) => {
    if (message.method === 'initialize') return { id: message.id, result: {} }
    if (message.method === 'account/login/start') {
      return {
        id: message.id,
        result: {
          type: 'chatgpt',
          loginId: '5dc255b4-93f9-40f8-bf00-7a4853e95d13',
          authUrl: 'https://chatgpt.com.attacker.example/steal',
        },
      }
    }
    return null
  })
  const auth = new CodexAppServerAuth({ spawnImpl: () => child })
  try {
    await assert.rejects(auth.startLogin(), (error) => error.code === 'CODEX_AUTH_URL_UNTRUSTED')
  } finally {
    await auth.close()
  }
})

test('Codex App Server auth completes one initialization before concurrent account reads', async () => {
  const { CodexAppServerAuth } = await loadAuthClient()
  assert.equal(typeof CodexAppServerAuth, 'function')
  let initialized = false
  let child
  child = fakeAppServer((message) => {
    if (message.method === 'initialize') {
      setImmediate(() => {
        initialized = true
        child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`)
      })
      return null
    }
    if (message.method === 'account/read') {
      return initialized
        ? { id: message.id, result: { account: { type: 'chatgpt', planType: 'plus' }, requiresOpenaiAuth: true } }
        : { id: message.id, error: { code: -32002, message: 'Not initialized' } }
    }
    return null
  })
  let spawnCount = 0
  const auth = new CodexAppServerAuth({
    spawnImpl: () => {
      spawnCount += 1
      return child
    },
  })
  try {
    const states = await Promise.all([auth.read(), auth.read()])
    assert.deepEqual(states.map((state) => state.status), ['connected', 'connected'])
    assert.equal(spawnCount, 1)
  } finally {
    await auth.close()
  }
})
