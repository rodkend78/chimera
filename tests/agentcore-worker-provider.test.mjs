import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentCoreWorkerProvider, assertPublicWorkerUrl, createPublicRequestGuard } from '../src/agents/agentcore-worker-provider.mjs'

function fixture() {
  const calls = []
  const browser = {
    attachSession(sessionId) { calls.push(['browser.attach', sessionId]) },
    async startSession(input) { calls.push(['browser.start', input]); return { sessionId: 'browser-provider-1' } },
    async getSession(input) { calls.push(['browser.status', input]); return { status: 'READY' } },
    async stopSession() { calls.push(['browser.stop']) },
    async generateLiveViewUrl(seconds) { calls.push(['browser.live', seconds]); return 'https://signed.example/live?secret=1' },
    async updateBrowserStream(input) { calls.push(['browser.stream', input]); return input },
    async navigate(input) { calls.push(['browser.navigate', input]) },
    async getText(input) { calls.push(['browser.text', input]); return 'Example' },
    async click(input) { calls.push(['browser.click', input]) },
    async type(input) { calls.push(['browser.type', input]) },
    async screenshot(input) { calls.push(['browser.screenshot', input]); return Buffer.from('png') },
  }
  const code = {
    async startSession(input) { calls.push(['code.start', input]); return { sessionId: 'code-provider-1' } },
    async getSession(input) { calls.push(['code.status', input]); return { status: 'READY' } },
    async stopSession() { calls.push(['code.stop']) },
    async executeCode(input) { calls.push(['code.execute', input]); return '42' },
    async executeCommand(input) { calls.push(['code.command', input]); return 'ok' },
    async readFiles(input) { calls.push(['code.read', input]); return 'contents' },
    async listFiles(input) { calls.push(['code.list', input]); return '[]' },
  }
  return {
    calls,
    provider: new AgentCoreWorkerProvider({
      browserFactory: () => browser,
      codeFactory: () => code,
      resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
    }),
  }
}

test('AgentCore provider uses managed system resources and bounded launch settings', async () => {
  const { calls, provider } = fixture()
  const computer = await provider.start({ kind: 'computer', agentId: 'ace', ttlSeconds: 900, viewport: { width: 1280, height: 800 } })
  const code = await provider.start({ kind: 'code', agentId: 'ace', ttlSeconds: 600 })
  assert.deepEqual(computer, { providerSessionId: 'browser-provider-1', providerResourceId: 'aws.browser.v1' })
  assert.deepEqual(code, { providerSessionId: 'code-provider-1', providerResourceId: 'aws.codeinterpreter.v1' })
  assert.deepEqual(calls.slice(0, 2), [
    ['browser.start', { sessionName: 'chimera-ace-computer', timeout: 900, viewport: { width: 1280, height: 800 } }],
    ['code.start', { sessionName: 'chimera-ace-code', description: 'Chimera isolated code worker for ace', timeout: 600 }],
  ])
})

test('AgentCore provider attaches the exact session for view, control, actions, and teardown', async () => {
  const { calls, provider } = fixture()
  const record = { kind: 'computer', providerSessionId: 'browser-provider-1', providerResourceId: 'aws.browser.v1' }
  assert.equal(await provider.liveView(record, { expiresIn: 45 }), 'https://signed.example/live?secret=1')
  await provider.setAutomation(record, false)
  await provider.action(record, { operation: 'navigate', url: 'https://example.com' })
  assert.equal(await provider.action(record, { operation: 'get-text', selector: 'h1' }), 'Example')
  assert.deepEqual(await provider.action(record, { operation: 'screenshot' }), Buffer.from('png'))
  await provider.stop(record)
  assert.equal(calls.some(([name, input]) => name === 'browser.live' && input === 45), true)
  assert.equal(calls.some(([name, input]) => name === 'browser.stream' && input.streamStatus === 'DISABLED'), true)
  assert.equal(calls.some(([name, input]) => name === 'browser.navigate' && input.url === 'https://example.com/'), true)
  assert.equal(calls.at(-1)[0], 'browser.stop')
})

test('AgentCore provider executes bounded code operations and rejects unsupported input', async () => {
  const { provider } = fixture()
  const started = await provider.start({ kind: 'code', agentId: 'ace', ttlSeconds: 600 })
  const record = { kind: 'code', ...started }
  assert.equal(await provider.action(record, { operation: 'execute-code', code: '6 * 7', language: 'python' }), '42')
  assert.equal(await provider.action(record, { operation: 'execute-command', command: 'pwd' }), 'ok')
  await assert.rejects(provider.action(record, { operation: 'execute-command', command: 'x'.repeat(20_001) }), /WORKER_COMMAND_INVALID/)
  await assert.rejects(provider.liveView(record), /WORKER_COMPUTER_REQUIRED/)
})

test('computer navigation rejects local and private destinations including DNS rebinding targets', async () => {
  await assert.rejects(assertPublicWorkerUrl('http://127.0.0.1:4174'), /WORKER_URL_BLOCKED/)
  await assert.rejects(assertPublicWorkerUrl('http://169.254.169.254/latest/meta-data'), /WORKER_URL_BLOCKED/)
  await assert.rejects(assertPublicWorkerUrl('file:///etc/passwd'), /WORKER_URL_BLOCKED/)
  await assert.rejects(assertPublicWorkerUrl('https://public.example', { resolveHost: async () => [{ address: '10.0.0.5', family: 4 }] }), /WORKER_URL_BLOCKED/)
  await assert.rejects(assertPublicWorkerUrl('http://[::ffff:169.254.169.254]/latest/meta-data'), /WORKER_URL_BLOCKED/)
  await assert.rejects(assertPublicWorkerUrl('http://[::ffff:ac10:5]/'), /WORKER_URL_BLOCKED/)
  await assert.rejects(assertPublicWorkerUrl('https://192.0.2.10/'), /WORKER_URL_BLOCKED/)
  assert.equal((await assertPublicWorkerUrl('https://example.com', { resolveHost: async () => [{ address: '93.184.216.34', family: 4 }] })).href, 'https://example.com/')
})

test('browser request guard revalidates redirect hops and subresources', async () => {
  const calls = []
  const guard = createPublicRequestGuard({
    resolveHost: async (hostname) => hostname === 'private.example'
      ? [{ address: '169.254.169.254', family: 4 }]
      : [{ address: '93.184.216.34', family: 4 }],
  })
  const route = (url) => ({
    request: () => ({ url: () => url }),
    async continue() { calls.push(['continue', url]) },
    async abort(reason) { calls.push(['abort', url, reason]) },
  })

  await guard(route('https://example.com/app.js'))
  await guard(route('https://private.example/latest/meta-data'))

  assert.deepEqual(calls, [
    ['continue', 'https://example.com/app.js'],
    ['abort', 'https://private.example/latest/meta-data', 'blockedbyclient'],
  ])
})

test('task-scoped browser sessions pin every request to the leased host set', async () => {
  const { calls } = fixture()
  let browserOptions
  const browser = {
    async startSession(input) { calls.push(['browser.start', input]); return { sessionId: 'browser-scoped-1' } },
    async navigate(input) { calls.push(['browser.navigate', input]) },
  }
  const provider = new AgentCoreWorkerProvider({
    browserFactory: (options) => { browserOptions = options; return browser },
    resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
  })
  await provider.start({ kind: 'computer', agentId: 'ace', ttlSeconds: 900, networkHosts: ['Docs.Example.com'] })
  assert.deepEqual(browserOptions.allowedHosts, ['docs.example.com'])

  const guardedCalls = []
  const guard = createPublicRequestGuard({
    allowedHosts: browserOptions.allowedHosts,
    resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
  })
  const route = (url) => ({
    request: () => ({ url: () => url }),
    async continue() { guardedCalls.push(['continue', url]) },
    async abort(reason) { guardedCalls.push(['abort', url, reason]) },
  })
  await guard(route('https://docs.example.com/redirect'))
  await guard(route('https://example.com/redirect'))
  assert.deepEqual(guardedCalls, [
    ['continue', 'https://docs.example.com/redirect'],
    ['abort', 'https://example.com/redirect', 'blockedbyclient'],
  ])
})
