import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountCompanionBroker } from '../src/account-browser/broker.mjs'
import { MemoryAuditLog } from '../src/audit-log.mjs'

const allowedOrigin = `chrome-extension://${'a'.repeat(32)}/`
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'companion-broker-'))
  let time = 1000000
  const audit = options.audit ?? new MemoryAuditLog()
  const stateFile = join(dir, 'state.json')
  const broker = await AccountCompanionBroker.open({ stateFile, audit, allowedOrigin,
    now: () => time, eligibleFor: async ({ taskId, agentId }) => taskId === 'task-1' && agentId === 'agent-1' ? { expiresAt: time + 3600000 } : null,
    ...options })
  t.after(async () => { await broker.close(); await rm(dir, { recursive: true, force: true }) })
  let seq = 0
  const request = (type, fields = {}) => ({ id: `request-${++seq}`, type, ...fields })
  async function pair(profileId = 'profile-one') {
    const commands = []
    const peer = broker.connect({ origin: allowedOrigin, send: command => commands.push(command) })
    const challenge = await peer.receive(request('hello', { profileId }))
    await broker.approvePair({ pairingId: challenge.pairingId })
    await peer.receive(request('authenticate', { pairingId: challenge.pairingId, challenge: challenge.challenge }))
    return { peer, commands }
  }
  const reserve = (peer, fields = {}) => peer.receive(request('share', { tabId: 1, documentId: 'document-one', origin: 'https://example.com', urlDigest: 'a'.repeat(64), taskId: 'task-1', agentId: 'agent-1', ...fields }))
  const ready = (peer, lease, fields = {}) => peer.receive(request('ready', { leaseId: lease.leaseId, revision: lease.revision, documentId: lease.documentId, origin: lease.origin, urlDigest: lease.urlDigest, ...fields }))
  const share = async (peer, fields = {}) => { const result = await reserve(peer, fields); await ready(peer, result.lease); return result }
  const read = lease => broker.read({ leaseId: lease.leaseId, taskId: 'task-1', agentId: 'agent-1' })
  const result = (command, fields = {}) => ({ type: 'read-result', id: command.id, leaseId: command.leaseId, revision: command.revision, documentId: command.documentId, origin: command.origin, urlDigest: command.urlDigest, text: 'Visible password=hunter2', ...fields })
  return { broker, audit, stateFile, request, pair, reserve, ready, share, read, result, advance: ms => { time += ms } }
}

test('reserved share cannot be read or advertised before document-ready acknowledgement', async t => {
  const f = await fixture(t); const { peer, commands } = await f.pair(); const { lease } = await f.reserve(peer)
  assert.deepEqual(f.broker.readyLeases(), [])
  await assert.rejects(f.read(lease)); assert.equal(commands.some(c => c.type === 'read'), false)
  assert.equal((await f.ready(peer, lease)).type, 'ready')
  assert.equal(f.broker.readyLeases()[0].leaseId, lease.leaseId)
  await assert.rejects(f.ready(peer, lease))
})

test('ready acknowledgement is bound to connection and document; abandoned reservations expire', async t => {
  const f = await fixture(t); const a = await f.pair(); const b = await f.pair('profile-two')
  const { lease } = await f.reserve(a.peer)
  await assert.rejects(f.ready(b.peer, lease))
  await assert.rejects(f.ready(a.peer, lease, { documentId: 'wrong' }))
  assert.deepEqual(f.broker.readyLeases(), [])
  f.advance(10001)
  await assert.rejects(f.ready(a.peer, lease))
  assert.equal(f.broker.state().leases.find(l => l.leaseId === lease.leaseId).status, 'expired')
})

test('abandoned reservation capacity is bounded and reclaimed on expiry', async t => {
  const f = await fixture(t); const { peer } = await f.pair()
  for (let i = 0; i < 128; i++) await f.reserve(peer)
  await assert.rejects(f.reserve(peer))
  assert.deepEqual(f.broker.readyLeases(), [])
  f.advance(10001); assert.deepEqual(f.broker.readyLeases(), [])
  assert.equal(f.broker.state().leases.filter(l => l.status === 'active').length, 0)
  const { lease } = await f.reserve(peer); await f.ready(peer, lease)
  assert.equal(f.broker.readyLeases().length, 1)
})

test('ready audit cannot publish authority after eligibility loss or synchronous revocation', async t => {
  for (const action of ['eligibility', 'cancel', 'disconnect', 'navigation', 'expiry']) {
    let eligible = true; const gate = deferred(); const entered = deferred(); const audit = new MemoryAuditLog(); const append = audit.append.bind(audit)
    audit.append = async fact => { if (fact.kind === 'account-browser.ready') { entered.resolve(); await gate.promise } return append(fact) }
    const f = await fixture(t, { audit, eligibleFor: () => eligible ? { expiresAt: 2000000 } : null })
    const { peer } = await f.pair(); const { lease } = await f.reserve(peer)
    const pending = f.ready(peer, lease); const rejected = assert.rejects(pending)
    await entered.promise
    assert.deepEqual(f.broker.readyLeases(), [])
    let cancellation
    if (action === 'eligibility') eligible = false
    if (action === 'cancel') cancellation = f.broker.revokeTask('task-1')
    if (action === 'disconnect') cancellation = peer.disconnect()
    if (action === 'navigation') cancellation = peer.receive(f.request('invalidate', { leaseId: lease.leaseId, reason: 'navigation' }))
    if (action === 'expiry') f.advance(10001)
    gate.resolve(); await cancellation; await rejected
    assert.deepEqual(f.broker.readyLeases(), [])
  }
})

test('pairing requires exact origin, approval, connection and single-use challenge', async t => {
  const f = await fixture(t)
  assert.throws(() => f.broker.connect({ origin: 'chrome-extension://evil/', send() {} }))
  const a = f.broker.connect({ origin: allowedOrigin, send() {} })
  const c = await a.receive(f.request('hello', { profileId: 'profile-a' }))
  await assert.rejects(a.receive(f.request('authenticate', { pairingId: c.pairingId, challenge: c.challenge })))
  const b = f.broker.connect({ origin: allowedOrigin, send() {} })
  const d = await b.receive(f.request('hello', { profileId: 'profile-b' }))
  await f.broker.approvePair({ pairingId: d.pairingId })
  await assert.rejects(b.receive(f.request('authenticate', { pairingId: c.pairingId, challenge: c.challenge })))
  const { peer } = await f.pair()
  await assert.rejects(peer.receive(f.request('authenticate', { pairingId: d.pairingId, challenge: d.challenge })))
  assert.ok(!JSON.stringify(f.broker.state()).includes(c.challenge))
})

test('expired challenge cannot authenticate; unpaired sharing fails', async t => {
  const f = await fixture(t)
  const peer = f.broker.connect({ origin: allowedOrigin, send() {} })
  await assert.rejects(f.share(peer))
  const other = f.broker.connect({ origin: allowedOrigin, send() {} })
  const c = await other.receive(f.request('hello', { profileId: 'profile-a' }))
  await f.broker.approvePair({ pairingId: c.pairingId })
  f.advance(120001)
  await assert.rejects(other.receive(f.request('authenticate', { pairingId: c.pairingId, challenge: c.challenge })))
})

test('share validates runtime eligibility and caps lifetime at five/fifteen minutes and parent expiry', async t => {
  const f = await fixture(t)
  const { peer } = await f.pair()
  await assert.rejects(f.share(peer, { taskId: 'wrong' }))
  await assert.rejects(f.share(peer, { agentId: 'wrong' }))
  const { lease } = await f.share(peer)
  assert.equal(lease.expiresAt - lease.issuedAt, 300000)
  assert.deepEqual(lease.permissions, ['read'])
  const capped = await f.share(peer, { ttlSeconds: 10000 })
  assert.equal(capped.lease.expiresAt - capped.lease.issuedAt, 900000)
  const g = await fixture(t, { eligibleFor: () => ({ expiresAt: 1000010 }) })
  const p = await g.pair()
  assert.equal((await g.share(p.peer)).lease.expiresAt, 1000010)
})

test('read dispatch and redacted result use exact bindings and metadata-only audit/state', async t => {
  const f = await fixture(t)
  const { peer, commands } = await f.pair()
  const { lease } = await f.share(peer)
  const pending = f.read(lease)
  await tick()
  const command = commands.find(c => c.type === 'read')
  assert.ok(command)
  for (const key of ['leaseId', 'profileId', 'generation', 'tabId', 'documentId', 'origin', 'urlDigest', 'revision', 'taskId', 'agentId', 'expiresAt']) assert.equal(command[key], lease[key])
  assert.ok(f.audit.entries().some(e => e.fact.kind === 'account-browser.read.requested'))
  await peer.receive(f.result(command))
  assert.deepEqual(await pending, { text: 'Visible [REDACTED]', origin: 'https://example.com', leaseId: lease.leaseId, untrusted: true })
  const persisted = await readFile(f.stateFile, 'utf8')
  assert.ok(!persisted.includes('hunter2'))
  assert.ok(!JSON.stringify(f.audit.entries()).includes('hunter2'))
  assert.equal((await stat(f.stateFile)).mode & 0o777, 0o600)
})

for (const mutation of [{ documentId: 'wrong' }, { revision: 900 }, { origin: 'https://other.com' }, { urlDigest: 'b'.repeat(64) }, { leaseId: 'wrong' }]) {
  test(`rejects mismatched read result ${JSON.stringify(mutation)}`, async t => {
    const f = await fixture(t); const { peer, commands } = await f.pair(); const { lease } = await f.share(peer)
    const pending = f.read(lease); const rejected = assert.rejects(pending); await tick()
    await assert.rejects(peer.receive(f.result(commands.find(c => c.type === 'read'), mutation)))
    await rejected
  })
}

test('wrong recipient, overlapping reads, unsolicited and duplicate results fail closed', async t => {
  const f = await fixture(t); const { peer, commands } = await f.pair(); const { lease } = await f.share(peer)
  await assert.rejects(f.broker.read({ leaseId: lease.leaseId, taskId: 'wrong', agentId: 'agent-1' }))
  await assert.rejects(f.broker.read({ leaseId: lease.leaseId, taskId: 'task-1', agentId: 'wrong' }))
  const pending = f.read(lease); await tick(); await assert.rejects(f.read(lease))
  const command = commands.find(c => c.type === 'read')
  await peer.receive(f.result(command)); await pending
  await assert.rejects(peer.receive(f.result(command)))
  assert.equal(commands.filter(c => c.type === 'read').length, 1)
})

test('result from another connection never settles the original command', async t => {
  const f = await fixture(t); const a = await f.pair(); const b = await f.pair('profile-two'); const { lease } = await f.share(a.peer)
  const pending = f.read(lease); const rejected = assert.rejects(pending); await tick()
  await assert.rejects(b.peer.receive(f.result(a.commands.find(c => c.type === 'read'))))
  await f.broker.revokeLease({ leaseId: lease.leaseId, reason: 'human' }); await rejected
})

for (const action of ['navigation', 'revoke', 'disconnect', 'cancel', 'expiry', 'abort', 'close', 'pair']) {
  test(`${action} fences an outstanding read and rejects late content`, async t => {
    const f = await fixture(t); const { peer, commands } = await f.pair(); const { lease } = await f.share(peer)
    const controller = new AbortController()
    const pending = f.broker.read({ leaseId: lease.leaseId, taskId: 'task-1', agentId: 'agent-1', signal: controller.signal }); const rejected = assert.rejects(pending); await tick()
    const command = commands.find(c => c.type === 'read')
    if (action === 'navigation') await peer.receive(f.request('invalidate', { leaseId: lease.leaseId, reason: 'navigation' }))
    if (action === 'revoke') await f.broker.revokeLease({ leaseId: lease.leaseId, reason: 'human' })
    if (action === 'disconnect') await peer.disconnect()
    if (action === 'cancel') await f.broker.revokeTask('task-1')
    if (action === 'expiry') f.advance(300001)
    if (action === 'abort') controller.abort()
    if (action === 'close') await f.broker.close()
    if (action === 'pair') await f.broker.revokePair({ profileId: 'profile-one' })
    await assert.rejects(peer.receive(f.result(command))); await rejected
  })
}

test('revocation fences before delayed request/result audit or eligibility completes', async t => {
  for (const phase of ['eligibility', 'requested', 'result']) {
    const audit = new MemoryAuditLog(); const gate = deferred(); let block = false
    const append = audit.append.bind(audit)
    audit.append = async fact => { if (block && fact.kind === `account-browser.read.${phase}`) await gate.promise; return append(fact) }
    const f = await fixture(t, { audit, eligibleFor: async () => { if (block && phase === 'eligibility') await gate.promise; return { expiresAt: 2000000 } } })
    const { peer, commands } = await f.pair(); const { lease } = await f.share(peer); block = true
    const pending = f.read(lease); const rejected = assert.rejects(pending); await tick()
    let receiving
    if (phase === 'result') { receiving = peer.receive(f.result(commands.find(c => c.type === 'read'))); receiving.catch(() => {}); await tick() }
    const revoked = f.broker.revokeLease({ leaseId: lease.leaseId, reason: 'human' })
    gate.resolve(); await revoked; await rejected
    if (receiving) await assert.rejects(receiving)
    if (phase !== 'result') assert.equal(commands.filter(c => c.type === 'read').length, 0)
  }
})

test('audit failure prevents dispatch and result failure never returns content', async t => {
  for (const phase of ['requested', 'result']) {
    const audit = new MemoryAuditLog(); const append = audit.append.bind(audit)
    audit.append = fact => { if (fact.kind === `account-browser.read.${phase}`) throw new Error('audit unavailable'); return append(fact) }
    const f = await fixture(t, { audit }); const { peer, commands } = await f.pair(); const { lease } = await f.share(peer)
    const pending = f.read(lease); const rejected = assert.rejects(pending); await tick()
    if (phase === 'result') await assert.rejects(peer.receive(f.result(commands.find(c => c.type === 'read'))))
    else assert.equal(commands.filter(c => c.type === 'read').length, 0)
    await rejected
  }
})

test('restart keeps terminal metadata but never restores authority', async t => {
  const f = await fixture(t); const { peer } = await f.pair(); const { lease } = await f.share(peer)
  const restarted = await AccountCompanionBroker.open({ stateFile: f.stateFile, audit: f.audit, allowedOrigin })
  assert.equal(restarted.state().leases.find(l => l.leaseId === lease.leaseId).status, 'restarted')
  await assert.rejects(restarted.read({ leaseId: lease.leaseId, taskId: 'task-1', agentId: 'agent-1' }))
  await restarted.close()
})

test('strict fields, duplicate IDs, and finite resource limits', async t => {
  const f = await fixture(t)
  for (const fields of [{ ttlSeconds: NaN }, { tabId: Number.MAX_SAFE_INTEGER + 1 }, { origin: 'https://example.com/private?token=x' }, { unexpected: true }]) {
    const { peer } = await f.pair()
    await assert.rejects(f.share(peer, fields), /Invalid companion message/)
  }
  const peers = []
  for (let i = 0; i < 32; i++) { try { peers.push(f.broker.connect({ origin: allowedOrigin, send() {} })) } catch { break } }
  assert.throws(() => f.broker.connect({ origin: allowedOrigin, send() {} }))
  await Promise.all(peers.map(p => p.disconnect()))
  const a = f.broker.connect({ origin: allowedOrigin, send() {} }); const message = f.request('hello', { profileId: 'profile-dup' })
  await a.receive(message); await assert.rejects(a.receive(message))
})

test('cancellation while share eligibility is pending fences admission', async t => {
  const gate = deferred(); const f = await fixture(t, { eligibleFor: async () => { await gate.promise; return { expiresAt: 2000000 } } })
  const { peer } = await f.pair(); const pending = f.share(peer); const rejected = assert.rejects(pending)
  await tick(); await f.broker.revokeTask('task-1'); gate.resolve(); await rejected
  assert.equal(f.broker.state().leases.filter(l => l.status === 'active').length, 0)
})

test('read cancellation settles without waiting for an unavailable eligibility backend', async t => {
  const gate = deferred(); let block = false
  const f = await fixture(t, { eligibleFor: async () => { if (block) await gate.promise; return { expiresAt: 2000000 } } })
  const { peer } = await f.pair(); const { lease } = await f.share(peer); block = true
  const pending = f.read(lease); let settled = false; pending.catch(() => { settled = true })
  await f.broker.revokeLease({ leaseId: lease.leaseId, reason: 'human' }); await tick()
  try { assert.equal(settled, true) } finally { gate.resolve(); await assert.rejects(pending) }
})

test('an eligibility grant that expires during request audit prevents dispatch', async t => {
  const gate = deferred(); let block = false; const audit = new MemoryAuditLog(); const append = audit.append.bind(audit)
  audit.append = async fact => { if (fact.kind === 'account-browser.read.requested') await gate.promise; return append(fact) }
  const f = await fixture(t, { audit, eligibleFor: () => ({ expiresAt: block ? 1000010 : 2000000 }) })
  const { peer, commands } = await f.pair(); const { lease } = await f.share(peer); block = true
  const pending = f.read(lease); const rejected = assert.rejects(pending); await tick(); f.advance(11); gate.resolve(); await rejected
  assert.equal(commands.filter(c => c.type === 'read').length, 0)
})

test('lease and duplicate-ID caps bound a long-lived paired connection', async t => {
  const f = await fixture(t); const { peer } = await f.pair()
  for (let i = 0; i < 128; i++) await f.share(peer)
  await assert.rejects(f.share(peer))
  for (const lease of f.broker.state().leases) await f.broker.revokeLease({ leaseId: lease.leaseId, reason: 'human' })
  for (let i = 0; i < 3; i++) { const { lease } = await f.share(peer); await f.broker.revokeLease({ leaseId: lease.leaseId, reason: 'human' }) }
  assert.equal(f.broker.state().leases.length, 128)
  let accepted = 0
  for (let i = 0; i < 4096; i++) { try { await peer.receive(f.request('targets')); accepted++ } catch { break } }
  assert.ok(accepted < 4096)
  await assert.rejects(f.share(peer))
})

test('safe target choices are sanitized and never confer eligibility', async t => {
  const f = await fixture(t, { targetsFor: () => [{ taskId: 'other-task', agentId: 'other-agent', title: 'secret' }] })
  const { peer } = await f.pair()
  assert.deepEqual((await peer.receive(f.request('targets'))).targets, [{ taskId: 'other-task', agentId: 'other-agent' }])
  await assert.rejects(f.share(peer, { taskId: 'other-task', agentId: 'other-agent' }))
})

test('read timeout is terminal unknown and never dispatches a retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await fixture(t); const { peer, commands } = await f.pair(); const { lease } = await f.share(peer)
  const pending = f.read(lease); const rejected = assert.rejects(pending); await tick()
  t.mock.timers.tick(10001); await rejected
  assert.equal(f.broker.state().leases[0].status, 'unknown')
  await assert.rejects(f.read(lease))
  await assert.rejects(peer.receive(f.result(commands.find(c => c.type === 'read'))))
  assert.equal(commands.filter(c => c.type === 'read').length, 1)
})

test('oversized text and unapproved read errors never return page content', async t => {
  for (const mutation of [{ text: 'é'.repeat(16385) }, { type: 'read-error', error: 'raw secret error' }]) {
    const f = await fixture(t); const { peer, commands } = await f.pair(); const { lease } = await f.share(peer)
    const pending = f.read(lease); const rejected = assert.rejects(pending); await tick()
    await assert.rejects(peer.receive(f.result(commands.find(c => c.type === 'read'), mutation))); await rejected
  }
})

test('revocation audit records bounded terminal metadata after admission closes', async t => {
  const f = await fixture(t); const { peer } = await f.pair(); const { lease } = await f.share(peer)
  await f.broker.revokeLease({ leaseId: lease.leaseId, reason: 'human' })
  assert.ok(f.audit.entries().some(e => e.fact.kind === 'account-browser.revoked' && e.fact.leaseId === lease.leaseId && e.fact.reason === 'human'))
})

test('a reserved share cannot dispatch reads before its admission audit completes', async t => {
  const gate = deferred(); const audit = new MemoryAuditLog(); const append = audit.append.bind(audit)
  audit.append = async fact => { if (fact.kind === 'account-browser.shared') await gate.promise; return append(fact) }
  const f = await fixture(t, { audit }); const { peer, commands } = await f.pair()
  const sharing = f.reserve(peer); await tick(); const reserved = f.broker.state().leases[0]
  assert.deepEqual(f.broker.readyLeases(), [], 'Reserved metadata is not usable authority')
  let rejected = false
  const read = f.read(reserved).catch(() => { rejected = true })
  await tick()
  try { assert.equal(commands.filter(c => c.type === 'read').length, 0); assert.equal(rejected, true); await assert.rejects(f.ready(peer, reserved)) }
  finally { gate.resolve(); await sharing; await f.broker.revokeLease({ leaseId: reserved.leaseId, reason: 'human' }); await read }
})

for (const stage of ['shared', 'read.requested', 'read.result']) test(`eligibility lost during ${stage} audit never admits a share, dispatch or result`, async t => {
  const gate = deferred(), entered = deferred(), audit = new MemoryAuditLog(), append = audit.append.bind(audit)
  let eligible = true
  audit.append = async fact => { if (fact.kind === `account-browser.${stage}`) { entered.resolve(); await gate.promise } return append(fact) }
  const f = await fixture(t, { audit, eligibleFor: () => eligible ? { expiresAt: 2000000 } : null })
  const { peer, commands } = await f.pair()
  if (stage === 'shared') {
    const sharing = f.share(peer).then(() => false, () => true)
    await entered.promise; eligible = false; gate.resolve()
    assert.equal(await sharing, true)
    assert.deepEqual(f.broker.readyLeases(), [])
    return
  }
  const { lease } = await f.share(peer)
  const reading = f.read(lease).then(() => false, () => true)
  if (stage === 'read.result') {
    await tick()
    const result = peer.receive(f.result(commands.find(row => row.type === 'read'))).catch(() => {})
    await entered.promise; eligible = false; gate.resolve()
    await result
    assert.equal(await reading, true)
  } else {
    await entered.promise; eligible = false; gate.resolve(); await tick()
    const count = commands.filter(row => row.type === 'read').length
    await f.broker.revokeLease({ leaseId: lease.leaseId }); await reading
    assert.equal(count, 0)
  }
})

test('blocked durable revocation cannot accumulate unbounded metadata writes', async t => {
  const gate = deferred(); const audit = new MemoryAuditLog(); const append = audit.append.bind(audit)
  audit.append = async fact => { if (fact.kind === 'account-browser.revoked') await gate.promise; return append(fact) }
  const f = await fixture(t, { audit }); const { peer } = await f.pair(); const { lease } = await f.share(peer)
  const first = f.broker.revokeLease({ leaseId: lease.leaseId, reason: 'human' })
  const queued = Promise.allSettled(Array.from({ length: 150 }, () => f.broker.revokeLease({ leaseId: lease.leaseId, reason: 'human' })))
  gate.resolve(); await first
  const outcomes = await queued
  assert.ok(outcomes.some(outcome => outcome.status === 'rejected'))
  await assert.rejects(f.read(lease))
})

for (const phase of ['read-eligibility', 'request-audit', 'result-eligibility', 'result-audit', 'share-audit']) {
  test(`outstanding ${phase} work stays bounded after repeated cancellation and disconnect`, async t => {
    const gate = deferred(); const audit = new MemoryAuditLog(); const append = audit.append.bind(audit)
    let blocked = 0; let eligibilityBlocked = false
    audit.append = async fact => {
      if ((phase === 'request-audit' && fact.kind === 'account-browser.read.requested') ||
          (phase === 'result-audit' && fact.kind === 'account-browser.read.result') ||
          (phase === 'share-audit' && fact.kind === 'account-browser.shared')) { blocked++; await gate.promise }
      return append(fact)
    }
    const f = await fixture(t, { audit, eligibleFor: async () => {
      if (eligibilityBlocked) { blocked++; await gate.promise }
      return { expiresAt: 2000000 }
    } })
    const { peer, commands } = await f.pair(); const retained = []
    try {
      for (let i = 0; i < 140; i++) {
        eligibilityBlocked = false
        const sharing = f.share(peer)
        if (phase === 'share-audit') {
          retained.push(sharing.catch(() => {})); await tick()
          const lease = f.broker.state().leases.find(l => l.status === 'active')
          if (!lease) break
          await f.broker.revokeLease({ leaseId: lease.leaseId, reason: 'human' })
          continue
        }
        let lease
        try { ({ lease } = await sharing) } catch { break }
        eligibilityBlocked = phase === 'read-eligibility'
        const pending = f.read(lease); let cancelled = false
        retained.push(pending.catch(() => { cancelled = true })); await tick()
        if (phase.startsWith('result-')) {
          eligibilityBlocked = phase === 'result-eligibility'
          const command = commands.findLast(c => c.type === 'read')
          retained.push(peer.receive(f.result(command, { text: 'x'.repeat(32768) })).catch(() => {})); await tick()
        }
        await peer.receive(f.request('invalidate', { leaseId: lease.leaseId, reason: 'human' })); await tick()
        assert.equal(cancelled, true, 'caller cancellation must not wait for backend work')
      }
      assert.equal(blocked, 128, 'detached backend processing must retain its slot until it actually completes')
      await peer.disconnect()
      const reconnect = f.broker.connect({ origin: allowedOrigin, send() {} })
      await assert.rejects(reconnect.receive(f.request('hello', { profileId: 'reconnected-profile' })), /work limit/)
      await reconnect.disconnect()
    } finally { eligibilityBlocked = false; gate.resolve(); await Promise.all(retained); await tick() }
    const fresh = await f.pair('after-drain')
    // Capacity is released after the real operations finish, not permanently lost.
    if (phase !== 'share-audit') assert.equal((await f.share(fresh.peer)).type, 'shared')
  })
}
