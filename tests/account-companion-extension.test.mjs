import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createCoordinator } from '../extensions/account-browser/background.js'
import { inspectDocument } from '../extensions/account-browser/document.js'
import { readFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function fixture(options = {}) {
  const now = options.now ?? Date.now
  const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn) }, emit(...v) { this.listeners.forEach(fn => fn(...v)) } })
  const injections = []; const sent = []; let leaseSequence = 0; let tab = { id: 7, url: 'https://example.com/report' }
  const port = { onMessage: event(), onDisconnect: event(), disconnect() { this.onDisconnect.emit() }, postMessage(m) {
    sent.push(m)
    queueMicrotask(() => {
      const reply = m.type === 'hello' ? { type: 'challenge', pairingId: 'pair', challenge: 'secret', expiresAt: now() + 120000 }
        : m.type === 'authenticate' ? { type: 'paired', profileId: 'profile', generation: 'gen' }
        : m.type === 'targets' ? { type: 'targets', targets: [{ taskId: 'task', agentId: 'agent' }] }
        : m.type === 'ready' ? { type: 'ready', leaseId: m.leaseId, revision: m.revision }
        : m.type === 'share' ? { type: 'shared', lease: { ...m, id: undefined, type: undefined, leaseId: ++leaseSequence === 1 ? 'lease' : `lease${leaseSequence}`, profileId: 'profile', generation: 'gen', connectionGeneration: 'connection', revision: 1, permissions: ['read'], issuedAt: now(), expiresAt: now() + 60000, status: 'active' } }
        : { type: 'revoked', leaseId: m.leaseId }
      port.onMessage.emit({ id: m.id, ...reply })
    })
  } }
  const chrome = { runtime: { id: 'extension', getURL: p => `chrome-extension://extension/${p}`, connectNative: () => { port.onMessage.listeners = []; port.onDisconnect.listeners = []; return port } }, tabs: { query: async q => { assert.deepEqual(q, { active: true, currentWindow: true }); return [tab] }, onUpdated: event(), onRemoved: event(), onReplaced: event() }, scripting: { executeScript: async spec => { injections.push(spec); return [{ frameId: 0, documentId: 'doc', result: { url: tab.url, origin: new URL(tab.url).origin, text: spec.args[0] === 'read' ? 'Visible report' : undefined } }] } } }
  const coordinator = createCoordinator({ chrome, profileId: async () => 'profile', ...options })
  const popup = (m, sender = { id: 'extension', url: 'chrome-extension://extension/popup.html' }) => coordinator.handlePopup(m, sender)
  const share = async () => { await popup({ type: 'pair' }); await popup({ type: 'finish-pairing' }); await popup({ type: 'share', acknowledged: true, taskId: 'task', agentId: 'agent' }); return coordinator.state().leases[0] }
  const command = lease => ({ type: 'read', id: 'read1', ...Object.fromEntries(['leaseId','profileId','generation','tabId','documentId','origin','urlDigest','revision','taskId','agentId','expiresAt'].map(k => [k, lease[k]])) })
  return { coordinator, popup, share, command, injections, chrome, sent, port, navigate: url => { tab = { ...tab, url } } }
}

test('unshared reads and forged page popup messages never inject', async () => {
  const f = fixture()
  await assert.rejects(f.coordinator.handleRead({ type: 'read', id: 'r1', leaseId: 'unshared' }))
  await assert.rejects(f.popup({ type: 'share', acknowledged: true }, { id: 'extension', url: 'https://example.com', tab: { id: 7 } }))
  await f.popup({ type: 'pair' }); await f.popup({ type: 'finish-pairing' })
  await assert.rejects(f.popup({ type: 'share', acknowledged: false, taskId: 'task', agentId: 'agent' }))
  assert.equal(f.injections.length, 0)
})

test('explicit sharing binds selected top-frame document; exact lease fields fence reads', async () => {
  const f = fixture(); const lease = await f.share()
  assert.deepEqual(f.injections[0].target, { tabId: 7, frameIds: [0] })
  for (const [key, value] of Object.entries({ tabId: 8, documentId: 'other', taskId: 'other', agentId: 'other', revision: 2, origin: 'https://other.com', urlDigest: 'a'.repeat(64), generation: 'other', profileId: 'other', expiresAt: 1 })) {
    await assert.rejects(f.coordinator.handleRead({ ...f.command(lease), [key]: value }))
  }
  const result = await f.coordinator.handleRead(f.command(lease))
  assert.equal(result.text, 'Visible report')
  assert.deepEqual(f.injections.at(-1).target, { tabId: 7, documentIds: ['doc'] })
})

test('same-origin URL change, known tab events and disconnect revoke leases', async () => {
  for (const trigger of [f => f.navigate('https://example.com/elsewhere'), f => f.chrome.tabs.onUpdated.emit(7, { status: 'loading' }), f => f.chrome.tabs.onRemoved.emit(7), f => f.chrome.tabs.onReplaced.emit(8, 7), f => f.port.disconnect()]) {
    const f = fixture(); const lease = await f.share(); trigger(f)
    await assert.rejects(f.coordinator.handleRead(f.command(lease)))
    assert.equal(f.coordinator.state().leases.length, 0)
  }
})

test('known authentication and unsafe selected URLs are refused without scripting', async () => {
  for (const url of ['https://accounts.google.com/foo', 'https://accounts.google.com./foo', 'https://example.com/%6cogin', 'https://example.com/login', 'https://example.com/recovery', 'http://127.0.0.1/', 'http://printer.local/', 'chrome://settings/', 'https://user:pass@example.com/']) {
    const f = fixture(); f.navigate(url); await assert.rejects(f.share()); assert.equal(f.injections.length, 0, url)
  }
})

test('navigation during share and revocation during extraction cannot publish authority or text', async () => {
  const f = fixture(); const execute = f.chrome.scripting.executeScript
  f.chrome.scripting.executeScript = async spec => { const result = await execute(spec); f.chrome.tabs.onUpdated.emit(7, { status: 'loading' }); return result }
  await assert.rejects(f.share()); assert.equal(f.coordinator.state().leases.length, 0)
  const g = fixture(); const lease = await g.share(); const original = g.chrome.scripting.executeScript
  g.chrome.scripting.executeScript = async spec => { const result = await original(spec); if (spec.args[0] === 'read') g.port.disconnect(); return result }
  await assert.rejects(g.coordinator.handleRead(g.command(lease)))
})

test('unsupported document targeting and duplicate reads fail closed', async () => {
  const f = fixture(); const lease = await f.share()
  await f.coordinator.handleRead(f.command(lease)); await assert.rejects(f.coordinator.handleRead(f.command(lease)))
  f.chrome.scripting.executeScript = async () => [{ frameId: 0, result: { url: 'https://example.com/report' } }]
  await assert.rejects(f.coordinator.handleRead({ ...f.command(lease), id: 'read2' }))
})

test('revocation arriving before share response prevents cached sharing', async () => {
  const f = fixture(); const send = f.port.postMessage
  f.port.postMessage = m => { send(m); if (m.type === 'share') f.port.onMessage.emit({ type: 'revoke', leaseId: 'lease', revision: 2, reason: 'human' }) }
  await assert.rejects(f.share()); assert.equal(f.coordinator.state().leases.length, 0)
})

test('pending ready acknowledgement never revives a navigated, revoked, disconnected or expired cache', async () => {
  for (const ending of ['navigation', 'revoke', 'disconnect', 'expiry']) {
    // Keep the injected clock behind wall time to expose mixed-clock expiry fixtures.
    let now = Date.now() - 100, entered, reply
    const ready = new Promise(resolve => { entered = resolve })
    const f = fixture({ now: () => now }), emit = f.port.onMessage.emit.bind(f.port.onMessage)
    f.port.onMessage.emit = message => { if (message.type === 'ready') { reply = message; entered() } else emit(message) }
    const sharing = f.share(); const rejected = assert.rejects(sharing, undefined, ending)
    await ready
    assert.deepEqual(f.coordinator.state().leases, [])
    if (ending === 'navigation') f.chrome.tabs.onUpdated.emit(7, { status: 'loading' })
    if (ending === 'revoke') emit({ type: 'revoke', leaseId: 'lease', revision: 2, reason: 'human' })
    if (ending === 'disconnect') f.port.disconnect()
    if (ending === 'expiry') now += 60001
    if (ending !== 'disconnect') emit(reply)
    await rejected
    assert.deepEqual(f.coordinator.state().leases, [])
  }
})

test('popup unknown fields cannot hide extra authority requests', async () => {
  const f = fixture()
  await assert.rejects(f.popup({ type: 'pair', script: 'arbitrary' })); assert.equal(f.sent.length, 0)
})

test('pairing response cannot substitute another profile', async () => {
  const f = fixture(); const emit = f.port.onMessage.emit.bind(f.port.onMessage)
  f.port.onMessage.emit = m => emit(m.type === 'paired' ? { ...m, profileId: 'other-profile' } : m)
  await f.popup({ type: 'pair' }); await assert.rejects(f.popup({ type: 'finish-pairing' }))
  assert.notEqual(f.coordinator.state().status, 'Paired')
})

test('retained reads stay bounded across disconnect and release capacity only on completion', { timeout: 5000 }, async () => {
  const f = fixture(); const execute = f.chrome.scripting.executeScript; const unblock = []; const reads = []; let entered
  f.chrome.scripting.executeScript = async spec => {
    const result = await execute(spec)
    if (spec.args[0] === 'read') await new Promise(resolve => { unblock.push(resolve); entered() })
    return result
  }
  for (let i = 0; i < 128; i++) {
    const lease = await f.share()
    const started = new Promise(resolve => { entered = resolve })
    reads.push(f.coordinator.handleRead(f.command(lease)).then(() => 'unexpected-success', () => 'revoked'))
    await started
    assert.equal(unblock.length, i + 1)
    f.port.disconnect()
  }
  const lease = await f.share()
  await assert.rejects(f.coordinator.handleRead(f.command(lease)))
  assert.equal(unblock.length, 128)
  for (const resolve of unblock) resolve()
  assert.deepEqual(await Promise.all(reads), Array(128).fill('revoked'))
  f.chrome.scripting.executeScript = execute
  assert.equal((await f.coordinator.handleRead({ ...f.command(lease), id: 'after-release' })).text, 'Visible report')
})

test('fixed document extractor excludes controls/hidden content and refuses authentication before text', async t => {
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close())
  const page = await browser.newPage()
  await page.route('https://example.com/**', route => route.fulfill({ body: '<p>Public report</p><form>form secret<input value="secret"></form><div hidden>hidden secret</div><div contenteditable>editable secret</div><textarea>textarea secret</textarea><select><option>option secret</option></select><script>"script secret"</script>' }))
  await page.goto('https://example.com/report')
  const result = await page.evaluate(inspectDocument, 'read')
  assert.equal(result.text, 'Public report')
  await page.evaluate(() => { const input = document.createElement('input'); input.type = 'password'; input.hidden = true; document.body.append(input) })
  assert.equal((await page.evaluate(inspectDocument, 'read')).error, 'authentication')
  await page.setContent(`<p>${'界'.repeat(20000)}</p>`)
  assert.ok(new TextEncoder().encode((await page.evaluate(inspectDocument, 'read')).text).length <= 32768)
  const expired = await page.evaluate(({ source }) => (0, eval)(`(${source})`)('read', location.href, Date.now() - 1), { source: inspectDocument.toString() })
  assert.equal(expired.error, 'expired')
  await page.setContent('<body contenteditable><p>Private editor</p></body>')
  assert.equal((await page.evaluate(inspectDocument, 'read')).text, '')
})

test('actual popup requires consent, renders hostile metadata as text, and installation ID persists in IndexedDB', async t => {
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close())
  const context = await browser.newContext(); const page = await context.newPage({ viewport: { width: 400, height: 1000 } })
  await context.route('https://fixture.example/**', async route => {
    const path = new URL(route.request().url()).pathname.slice(1)
    if (!['popup.html', 'popup.js', 'popup.css', 'background.js', 'document.js'].includes(path)) return route.abort()
    await route.fulfill({ body: await readFile(new URL('../extensions/account-browser/' + path, import.meta.url)), contentType: path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html' })
  })
  await page.addInitScript(() => {
    globalThis.calls = []; let paired = false; let shared = false
    const state = () => ({ status: paired ? 'Paired' : 'Disconnected', pairing: null, leases: shared ? [{ leaseId: 'lease', origin: 'https://example.com', taskId: '<img src=x onerror=alert(1)>', agentId: 'agent', expiresAt: Date.now() + 60000 }] : [] })
    globalThis.chrome = { runtime: { sendMessage: async message => {
      calls.push(message)
      if (message.type === 'pair') return { ...state(), status: 'Pairing', pairing: { pairingId: 'local-pair', challenge: 'local-challenge' } }
      if (message.type === 'finish-pairing') paired = true
      if (message.type === 'targets') return { targets: [{ taskId: 'task', agentId: 'agent' }] }
      if (message.type === 'share') shared = true
      if (message.type === 'stop') shared = false
      return state()
    } } }
  })
  await page.goto('https://fixture.example/popup.html')
  assert.equal(await page.locator('#sharing').isVisible(), false)
  await page.getByRole('button', { name: 'Pair with Chimera', exact: true }).click()
  assert.equal(await page.locator('#challenge').textContent(), 'local-challenge')
  assert.match(await page.locator('#challenge-panel').textContent(), /Pairing ID/)
  assert.equal(await page.locator('#pairing-id').textContent(), 'local-pair')
  await page.getByRole('button', { name: 'Finish pairing', exact: true }).click()
  await page.locator('#target').selectOption('0'); assert.equal(await page.locator('#share').isDisabled(), true)
  await page.locator('#acknowledge').check(); await page.locator('#share').click()
  await page.getByRole('button', { name: 'Stop sharing', exact: true }).waitFor()
  assert.equal(await page.locator('#leases img').count(), 0)
  assert.match(await page.locator('#leases').textContent(), /<img/)
  const output = await mkdtemp(join(tmpdir(), 'companion-popup-'))
  await page.screenshot({ path: join(output, 'desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 280, height: 1000 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({ path: join(output, 'narrow.png'), fullPage: true })
  t.diagnostic('Popup screenshots: ' + output)
  const getProfile = () => page.evaluate(async () => (await import('/background.js')).installationProfileId())
  const first = await getProfile(); await page.reload(); assert.equal(await getProfile(), first)
  assert.match(first, /^[a-f0-9-]{36}$/)
})
