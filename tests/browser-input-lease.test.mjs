import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { OpenBotBrowserComputerAdapter } from '../src/browser/adapter.mjs'
import { MemoryAuditLog } from '../src/audit-log.mjs'
import { ChimeraGateway } from '../src/gateway.mjs'
import { exportPublicKey, fingerprint, generateIdentity, signGrant } from '../src/identity.mjs'

const policy = JSON.parse(await readFile(new URL('../config/policy.json', import.meta.url), 'utf8'))
async function fixture() {
  const now = Date.parse('2026-08-23T18:00:00.000Z')
  const human = generateIdentity('rod')
  const agent = generateIdentity('ceo')
  const audit = new MemoryAuditLog()
  const gateway = new ChimeraGateway({ policy, humanKeys: [[human.keyId, exportPublicKey(human.publicKey)]], audit, now: () => now })
  const grant = signGrant({ grantId: crypto.randomUUID(), humanId: 'rod', agentId: 'ceo', agentKeyFingerprint: fingerprint(agent.publicKey), maxTier: 'confirm', scopes: [{ capability: 'browser.input', resourcePrefix: 'browser:ceo:' }], issuedAt: new Date(now - 1_000).toISOString(), expiresAt: new Date(now + 60_000).toISOString() }, human)
  const calls = []
  const state = { running: true, tabs: [{ tabId: 'tab-1', url: 'https://example.org/', active: true }] }
  const executor = {
    start: async () => state,
    state: async () => state,
    humanInput: async (message) => calls.push(message),
    releaseHumanInput: async () => calls.push({ released: true }),
    suspend: async () => ({}),
    uploadFiles: async (files) => ({ uploaded: true, count: files.length }),
    browserFiles: () => ({ upload: { pending: true }, downloads: [] }),
    downloadFile: () => ({ name: 'test.txt', bytes: 6, base64: 'c2VjcmV0' }),
  }
  const adapter = new OpenBotBrowserComputerAdapter({ sessionId: 'browser-ceo-1', agentId: 'ceo', humanId: 'rod', agentIdentity: agent, humanIdentity: human, grant, gateway, audit, executor, now: () => now })
  await adapter.start()
  return { adapter, executor, audit, calls }
}

test('stream inputs remain ordered and queued input cannot survive handback', async () => {
  const f = await fixture()
  assert.equal((await f.adapter.humanStreamInput({ type: 'key', key: 'Shift', event: 'down' })).reason, 'AGENT_CONTROL_ACTIVE')
  assert.equal(f.adapter.takeControl().status, 'allowed')
  await f.adapter.releaseHumanInput()
  f.calls.length = 0
  let unblock
  let started
  const began = new Promise((resolve) => { started = resolve })
  f.executor.humanInput = async (message) => {
    f.calls.push(message)
    started()
    await new Promise((resolve) => { unblock = resolve })
  }
  const first = f.adapter.humanStreamInput({ type: 'key', key: 'Shift', event: 'down' })
  await Promise.race([began, first.then((result) => { throw new Error(`Input never reached executor: ${JSON.stringify(result)}`) })])
  const queued = f.adapter.humanStreamInput({ type: 'mouse', event: 'pressed', button: 'left', x: 40, y: 50 })
  assert.equal(f.adapter.returnControl().status, 'allowed')
  unblock()
  assert.equal((await first).status, 'allowed')
  assert.equal((await queued).status, 'denied')
  await f.adapter.releaseHumanInput()
  assert.equal(f.calls.some((message) => message.event === 'pressed'), false)
  assert.equal(f.calls.at(-1).released, true)
  await f.adapter.close()
})

test('human file commands require control and signed audit contains no file contents', async () => {
  const f = await fixture()
  const upload = { command: 'upload-files', files: [{ name: 'test.txt', mimeType: 'text/plain', base64: 'c2VjcmV0' }] }
  assert.equal((await f.adapter.agentCommand(upload)).reason, 'HUMAN_BROWSER_FILES_ONLY')
  assert.equal((await f.adapter.humanCommand(upload)).reason, 'AGENT_CONTROL_ACTIVE')
  f.adapter.takeControl()
  assert.deepEqual((await f.adapter.humanCommand(upload)).result, { uploaded: true, count: 1 })
  assert.equal((await f.adapter.humanCommand({ command: 'download-file', downloadId: 'a' })).result.base64, 'c2VjcmV0')
  assert.equal((await f.adapter.humanCommand({ command: 'browser-files' })).result.upload.pending, true)
  const auditSize = f.audit.entries().length
  assert.equal(f.adapter.humanFileState().result.upload.pending, true)
  assert.equal(f.audit.entries().length, auditSize)
  const auditText = JSON.stringify(f.audit.entries())
  assert.equal(auditText.includes('c2VjcmV0'), false)
  assert.equal(auditText.includes('test.txt'), false)
  assert.equal(auditText.includes('secret'), false)
  await f.adapter.close()
})

test('suspended input is refused without implicitly restarting Chromium', async () => {
  const f = await fixture()
  f.adapter.takeControl()
  await f.adapter.suspend()
  f.calls.length = 0
  assert.equal((await f.adapter.humanStreamInput({ type: 'click', x: 20, y: 20 })).reason, 'SESSION_SUSPENDED')
  assert.equal(f.adapter.humanFileState().reason, 'SESSION_SUSPENDED')
  assert.deepEqual(f.calls, [])
  await f.adapter.close()
})

test('browser metadata refresh follows page navigation without slowing stream input', async () => {
  const f = await fixture()
  f.adapter.takeControl()
  let reads = 0
  f.executor.state = async () => {
    reads += 1
    return { running: true, tabs: [{ tabId: 'tab-1', url: 'https://example.org/next', title: 'Next', active: true }] }
  }
  assert.equal((await f.adapter.humanStreamInput({ type: 'click', x: 20, y: 20 })).status, 'allowed')
  assert.equal(reads, 0, 'pointer input must not wait on metadata reads')
  assert.equal((await f.adapter.refreshState()).tabs[0].url, 'https://example.org/next')
  assert.equal(f.adapter.state().tabs[0].title, 'Next')
  await f.adapter.close()
})

test('coalesced metadata reads cannot revive a suspended browser', async () => {
  const f = await fixture()
  f.adapter.takeControl()
  let finish, reads = 0
  f.executor.state = () => { reads += 1; return new Promise(resolve => { finish = resolve }) }
  const first = f.adapter.refreshState(), second = f.adapter.refreshState()
  assert.equal(reads, 1)
  await f.adapter.suspend()
  finish({ running: true, tabs: [{ tabId: 'stale', url: 'https://example.org/stale' }] })
  assert.equal((await first).running, false)
  assert.equal((await second).running, false)
  await f.adapter.refreshState()
  assert.equal(reads, 1)
  await f.adapter.close()
})
