import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChromiumBrowserExecutor, assertSafeBrowserUrl } from '../src/browser/executor.mjs'
import { createPublicEgressProxy, resolvePublicDestination } from '../src/browser/public-egress-proxy.mjs'
import net from 'node:net'

test('browser launch flags cannot override the egress boundary', () => {
  for (const flag of ['--proxy-server=direct://', '--no-proxy-server', '--proxy-pac-url=file:///tmp/proxy', '--proxy-auto-detect', '--proxy-bypass-list=*', '--host-resolver-rules=MAP * 127.0.0.1']) {
    assert.throws(() => new ChromiumBrowserExecutor({ profileDir: '/unused', launchArgs: [flag] }), /BROWSER_LAUNCH_ARGUMENT_BLOCKED/)
  }
})

test('DNS validation rejects mixed answers and alternative private encodings', async () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '::1', '::ffff:7f00:1', '64:ff9b::7f00:1', '2002:7f00:1::']) {
    await assert.rejects(resolvePublicDestination('https://security-test.example/', {
      lookup: async () => [{ address: '8.8.8.8' }, { address }],
    }), /BLOCKED/)
  }
  const target = await resolvePublicDestination('https://security-test.example/', { lookup: async () => [{ address: '2606:4700:4700::1111' }] })
  assert.equal(target.address, '2606:4700:4700::1111')
})

function proxyGet(proxy, url, authenticate = true) {
  const endpoint = new URL(proxy.settings.server)
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: endpoint.hostname, port: endpoint.port, path: url,
      headers: authenticate ? { 'Proxy-Authorization': `Basic ${Buffer.from(`${proxy.settings.username}:${proxy.settings.password}`).toString('base64')}` } : {},
    }, response => { let body = ''; response.on('data', chunk => { body += chunk }); response.on('end', () => resolve({ status: response.statusCode, body })) })
    request.on('error', reject)
  })
}

test('proxy allows only the exact active callback and requires its private credential', async t => {
  let requests = 0
  const server = http.createServer((_req, res) => { requests++; res.end('callback accepted') })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}/auth/callback`
  let active = true
  const proxy = await createPublicEgressProxy({ allowsCallback: candidate => active && candidate === url })
  t.after(() => proxy.close())
  assert.equal((await proxyGet(proxy, url, false)).status, 407)
  assert.deepEqual(await proxyGet(proxy, url), { status: 200, body: 'callback accepted' })
  assert.equal((await proxyGet(proxy, `${url}/other`)).status, 403)
  active = false
  assert.equal((await proxyGet(proxy, url)).status, 403)
  assert.equal(requests, 1)
})

test('CONNECT pins the validated numerical address instead of re-resolving the host', async t => {
  const seen = []
  const destination = net.createServer(socket => socket.end('fixture'))
  await new Promise(resolve => destination.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => destination.close(resolve)))
  const connect = net.connect
  t.mock.method(net, 'connect', options => {
    seen.push(options.host)
    // Replace only the external socket dependency with a local fixture.
    return connect({ ...options, host: '127.0.0.1', port: destination.address().port })
  })
  let lookups = 0
  const proxy = await createPublicEgressProxy({ lookup: async () => { lookups++; return [{ address: lookups === 1 ? '8.8.8.8' : '127.0.0.1' }] } })
  t.after(() => proxy.close())
  const endpoint = new URL(proxy.settings.server)
  const output = await new Promise((resolve, reject) => {
    const client = connect({ host: endpoint.hostname, port: Number(endpoint.port) })
    let output = ''
    client.on('connect', () => client.write(`CONNECT security-test.example:443 HTTP/1.1\r\nHost: security-test.example:443\r\nProxy-Authorization: Basic ${Buffer.from(`chimera:${proxy.settings.password}`).toString('base64')}\r\n\r\n`))
    client.on('data', data => { output += data }); client.on('error', reject); client.on('end', () => resolve(output))
  })
  assert.match(output, /200 Connection Established/)
  assert.match(output, /fixture/)
  assert.deepEqual(seen, ['8.8.8.8'])
  assert.equal(lookups, 1)
})

test('WebSocket upgrades retain the public host but never forward proxy credentials', async t => {
  const fixture = http.createServer()
  let requests = 0
  fixture.on('upgrade', (req, socket) => {
    requests++
    assert.equal(req.headers.host, 'security-test.example')
    assert.equal(req.headers['proxy-authorization'], undefined)
    socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nfixture-stream')
  })
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => fixture.close(resolve)))
  const request = http.request
  t.mock.method(http, 'request', options => {
    assert.equal(options.hostname, '8.8.8.8', 'socket destination is the validated numeric address')
    return request({ ...options, hostname: '127.0.0.1', port: fixture.address().port })
  })
  let address = '8.8.8.8'
  const proxy = await createPublicEgressProxy({ lookup: async () => [{ address }] })
  t.after(() => proxy.close())
  const endpoint = new URL(proxy.settings.server)
  const upgrade = () => new Promise((resolve, reject) => {
    const client = net.connect({ host: endpoint.hostname, port: Number(endpoint.port) })
    let result = ''
    client.on('connect', () => client.write(`GET ws://security-test.example/live HTTP/1.1\r\nHost: security-test.example\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nProxy-Authorization: Basic ${Buffer.from(`chimera:${proxy.settings.password}`).toString('base64')}\r\n\r\n`))
    client.on('data', chunk => { result += chunk }); client.on('error', reject); client.on('close', () => resolve(result))
  })
  assert.match(await upgrade(), /fixture-stream/)
  address = '127.0.0.1'
  assert.match(await upgrade(), /403 Blocked/)
  assert.equal(requests, 1)
})

test('browser rejects mapped/private and special-use literal destinations', () => {
  for (const url of ['http://[::ffff:127.0.0.1]/', 'http://100.64.0.1/', 'http://0.1.2.3/', 'http://198.18.0.1/']) {
    assert.throws(() => assertSafeBrowserUrl(url), /blocked/, url)
  }
})

test('real Chromium cannot connect to a private service through a public-looking name', { timeout: 20000 }, async t => {
  let requests = 0
  const server = http.createServer((_req, res) => { requests++; res.end('outside sentinel') })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const profileDir = await mkdtemp(join(tmpdir(), 'chimera-egress-'))
  let lookups = 0
  const browser = new ChromiumBrowserExecutor({ profileDir, headless: true,
    egressLookup: async () => { lookups++; return [{ address: '127.0.0.1', family: 4 }] },
  })
  t.after(async () => { await browser.suspend(); await rm(profileDir, { recursive: true, force: true }) })
  await browser.start()
  assert.ok((await browser.read()).text.length > 0, 'local in-memory demo still works')
  await browser.navigate(`http://security-test.example:${server.address().port}/`).catch(() => {})
  assert.equal(requests, 0, 'the private service must receive no request')
  assert.ok(lookups > 0, 'the request must reach the DNS enforcement boundary')
  const callback = `http://127.0.0.1:${server.address().port}/auth/callback`
  browser.allowTemporaryNavigation(callback)
  await browser.navigate(callback)
  assert.equal(requests, 1, 'the exact approved sign-in callback remains usable in Chromium')
})
