import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, lstat, readFile, open, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { redactSensitiveText } from '../security/redaction.mjs'
import { validateMessage, extensionOrigin, safeId, exactOrigin, byteLength } from './protocol.mjs'

const error = message => new Error(message)
const clone = value => structuredClone(value)

export class AccountCompanionBroker {
  #stateFile; #audit; #allowedOrigin; #eligibleFor; #targetsFor; #now
  #generation = randomUUID(); #connections = new Set(); #pairs = new Map(); #profiles = new Map(); #leases = new Map(); #pending = new Map()
  #writes = Promise.resolve(); #closed = false; #admissions = new Set(); #timer; #terminalFacts = []; #queuedWrites = 0; #processing = 0

  static async open(options) {
    const broker = new AccountCompanionBroker(options)
    await broker.#load()
    broker.#timer = setInterval(() => broker.#expire(), 1000)
    broker.#timer.unref()
    return broker
  }

  constructor({ stateFile, audit, allowedOrigin, eligibleFor = () => null, targetsFor = () => [], now = Date.now }) {
    if (!stateFile || !audit?.append || !extensionOrigin(allowedOrigin)) throw error('Invalid broker configuration')
    this.#stateFile = stateFile; this.#audit = audit; this.#allowedOrigin = allowedOrigin; this.#eligibleFor = eligibleFor; this.#targetsFor = targetsFor; this.#now = now
  }

  #time() { const time = this.#now(); if (!Number.isFinite(time) || time < 0) throw error('Invalid clock'); return time }

  #reserveWork() {
    if (this.#processing >= 128) throw error('Companion work limit exceeded')
    this.#processing++
    // Caller settlement and connection closure must not release this slot:
    // the backend await (and potentially result text) is still retained.
    return () => { this.#processing-- }
  }

  async #load() {
    await mkdir(dirname(this.#stateFile), { recursive: true, mode: 0o700 })
    const dir = await lstat(dirname(this.#stateFile))
    if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid() || (dir.mode & 0o077)) throw error('Unsafe state directory')
    try {
      const info = await lstat(this.#stateFile)
      if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) || info.size > 512 * 1024) throw error('Unsafe state file')
      const saved = JSON.parse(await readFile(this.#stateFile, 'utf8'))
      for (const profile of (saved.profiles ?? []).slice(-128)) {
        if (safeId(profile.profileId)) this.#profiles.set(profile.profileId, { profileId: profile.profileId, status: 'disconnected' })
      }
      for (const item of (saved.leases ?? []).slice(-128)) {
        if (!safeId(item.leaseId) || !safeId(item.profileId) || !safeId(item.taskId) || !safeId(item.agentId) || !exactOrigin(item.origin)) continue
        // Persisted data is never loaded into the live authority map as active.
        this.#leases.set(item.leaseId, { leaseId: item.leaseId, profileId: item.profileId, taskId: item.taskId, agentId: item.agentId, origin: item.origin, status: 'restarted' })
      }
    } catch (e) { if (e.code !== 'ENOENT') throw e }
    await this.#persist()
  }

  #snapshot() {
    return { pendingPairs: [...this.#pairs.values()].map(p => ({ pairingId: p.pairingId, profileId: p.profileId, expiresAt: p.expiresAt, approved: p.approved })),
      profiles: [...this.#profiles.values()].map(clone), leases: [...this.#leases.values()].map(l => this.#publicLease(l)) }
  }
  #publicLease(lease) { const { connection, ready, readyBy, offered, acknowledging, ...metadata } = lease; return clone(metadata) }
  state() { this.#expire(); return this.#snapshot() }
  readyLeases() {
    this.#expire()
    if (this.#closed) return []
    return [...this.#leases.values()].filter(lease => lease.ready && lease.status === 'active' && lease.connection.active && lease.connection.paired).map(lease => this.#publicLease(lease))
  }
  #persist() {
    if (this.#queuedWrites >= 128) return Promise.reject(error('Metadata backlog exceeded'))
    this.#queuedWrites++
    const snapshot = this.#snapshot(); delete snapshot.pendingPairs
    const data = JSON.stringify(snapshot)
    const facts = this.#terminalFacts.splice(0)
    const operation = this.#writes.then(async () => {
      const temporary = `${this.#stateFile}.${randomUUID()}.tmp`
      let file
      try {
        file = await open(temporary, 'wx', 0o600); await file.writeFile(data); await file.sync(); await file.close(); file = null
        await rename(temporary, this.#stateFile)
        for (const fact of facts) await this.#audit.append(fact)
      } finally { await file?.close(); await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e }) }
    }).finally(() => { this.#queuedWrites-- })
    this.#writes = operation.catch(() => {})
    return operation
  }

  #expire() {
    const now = this.#time(); let changed = false
    for (const connection of this.#connections) if (!connection.paired && now >= connection.createdAt + 120000) { this.#disconnect(connection); changed = true }
    for (const [id, pair] of this.#pairs) if (now >= pair.expiresAt) { this.#pairs.delete(id); changed = true }
    for (const lease of this.#leases.values()) if (lease.status === 'active' && (now >= lease.expiresAt || (!lease.ready && now >= lease.readyBy))) { this.#invalidate(lease, 'expired'); changed = true }
    if (changed) this.#persist().catch(() => {})
  }
  #assertConnection(c) { if (this.#closed || !c.active || !this.#connections.has(c)) throw error('Disconnected') }
  #assertCurrent(lease) {
    this.#assertConnection(lease.connection)
    if (!lease.connection.paired || lease.status !== 'active' || lease.generation !== this.#generation || this.#time() >= lease.expiresAt || (!lease.ready && this.#time() >= lease.readyBy)) {
      if (lease.status === 'active') { this.#invalidate(lease, 'expired'); this.#persist().catch(() => {}) }
      throw error('Lease is no longer current')
    }
  }
  #invalidate(lease, reason) {
    if (lease.status !== 'active') return
    lease.status = reason; lease.revision++
    this.#terminalFacts.push({ kind: 'account-browser.revoked', leaseId: lease.leaseId, taskId: lease.taskId, agentId: lease.agentId, revision: lease.revision, reason })
    const pending = this.#pending.get(lease.leaseId)
    if (pending) this.#settle(pending, error('Read invalidated'))
    try { lease.connection.send({ type: 'revoke', leaseId: lease.leaseId, revision: lease.revision, reason }) } catch {}
    this.#prune()
  }
  #prune() {
    const terminal = [...this.#leases.values()].filter(l => l.status !== 'active')
    for (const lease of terminal.slice(0, Math.max(0, terminal.length - 128))) this.#leases.delete(lease.leaseId)
    while (this.#profiles.size > 128) {
      const old = [...this.#profiles.values()].find(p => p.status !== 'paired')
      if (!old) break
      this.#profiles.delete(old.profileId)
    }
  }
  #disconnect(c) {
    if (!c.active) return
    c.active = false; c.paired = false; this.#connections.delete(c)
    for (const admission of this.#admissions) if (admission.connection === c) admission.cancelled = true
    for (const [id, p] of this.#pairs) if (p.connection === c) this.#pairs.delete(id)
    for (const l of this.#leases.values()) if (l.connection === c) this.#invalidate(l, 'disconnected')
    if (c.profileId) this.#profiles.set(c.profileId, { profileId: c.profileId, status: 'disconnected' })
    this.#prune()
  }

  connect({ origin, send }) {
    this.#expire()
    if (this.#closed || origin !== this.#allowedOrigin || typeof send !== 'function' || this.#connections.size >= 32) throw error('Connection denied')
    const c = { active: true, paired: false, generation: randomUUID(), createdAt: this.#time(), send, seen: new Set(), hello: false }
    this.#connections.add(c)
    return {
      receive: async raw => {
        this.#assertConnection(c)
        let message
        try {
          message = clone(validateMessage(raw))
          if (c.seen.has(message.id) || c.seen.size >= 4096) throw error('Duplicate or excessive IDs')
          c.seen.add(message.id)
        } catch (e) { this.#disconnect(c); await this.#persist(); throw e }
        // Revocation must still fence synchronously at saturation. Its durable
        // work is separately bounded by the metadata-write queue.
        if (message.type === 'invalidate') return this.#receive(c, message)
        const release = this.#reserveWork()
        try { return await this.#receive(c, message) } finally { release() }
      },
      disconnect: () => { this.#disconnect(c); return this.#persist() },
    }
  }

  async #receive(c, m) {
    const reply = { id: m.id }
    if (m.type === 'hello') {
      if (c.hello || c.paired || this.#pairs.size >= 32) throw error('Handshake denied')
      c.hello = true
      const pair = { pairingId: randomUUID(), challenge: randomBytes(32).toString('hex'), profileId: m.profileId, connection: c, expiresAt: this.#time() + 120000, approved: false }
      this.#pairs.set(pair.pairingId, pair)
      return { ...reply, type: 'challenge', pairingId: pair.pairingId, challenge: pair.challenge, expiresAt: pair.expiresAt }
    }
    if (m.type === 'authenticate') {
      const p = this.#pairs.get(m.pairingId)
      if (!p || p.connection !== c || !p.approved || this.#time() >= p.expiresAt || p.challenge.length !== m.challenge.length || !timingSafeEqual(Buffer.from(p.challenge), Buffer.from(m.challenge))) {
        this.#disconnect(c); await this.#persist(); throw error('Authentication denied')
      }
      this.#pairs.delete(p.pairingId)
      c.profileId = p.profileId
      await this.#audit.append({ kind: 'account-browser.paired', profileId: p.profileId })
      this.#assertConnection(c)
      if (this.#time() >= p.expiresAt) throw error('Authentication expired')
      this.#profiles.set(c.profileId, { profileId: c.profileId, status: 'paired' }); this.#prune()
      try { await this.#persist(); this.#assertConnection(c); if (this.#time() >= p.expiresAt) throw error('Authentication expired') }
      catch (e) { this.#disconnect(c); await this.#persist(); throw e }
      c.paired = true
      return { ...reply, type: 'paired', profileId: c.profileId, generation: this.#generation }
    }
    if (!c.paired) throw error('Pairing required')
    if (m.type === 'targets') {
      const targets = await this.#targetsFor(); this.#assertConnection(c)
      return { ...reply, type: 'targets', targets: Array.isArray(targets) ? targets.slice(0, 128).filter(v => safeId(v.taskId) && safeId(v.agentId)).map(v => ({ taskId: v.taskId, agentId: v.agentId })) : [] }
    }
    if (m.type === 'share') return this.#share(c, m)
    if (m.type === 'ready') return this.#ready(c, m)
    if (m.type === 'invalidate') {
      const lease = this.#leases.get(m.leaseId)
      if (!lease || lease.connection !== c) throw error('Lease denied')
      await this.revokeLease({ leaseId: m.leaseId, reason: m.reason })
      return { ...reply, type: 'revoked', leaseId: m.leaseId }
    }
    if (['read-result', 'read-error'].includes(m.type)) return this.#result(c, m)
    throw error('Unexpected message')
  }

  async approvePair({ pairingId }) {
    const p = this.#pairs.get(pairingId)
    if (!p || this.#time() >= p.expiresAt) throw error('Pairing unavailable')
    this.#assertConnection(p.connection)
    const release = this.#reserveWork()
    try {
      await this.#audit.append({ kind: 'account-browser.pair.approved', pairingId, profileId: p.profileId })
      this.#assertConnection(p.connection)
      if (this.#pairs.get(pairingId) !== p || this.#time() >= p.expiresAt) throw error('Pairing unavailable')
      p.approved = true
    } finally { release() }
  }
  async #share(c, m) {
    if (this.#admissions.size >= 128) throw error('Admission limit')
    const admission = { connection: c, taskId: m.taskId, cancelled: false }
    this.#admissions.add(admission)
    const assertAdmission = () => { this.#assertConnection(c); if (!c.paired || admission.cancelled) throw error('Share invalidated') }
    let eligible
    try { eligible = await this.#eligibleFor({ taskId: m.taskId, agentId: m.agentId }); assertAdmission() }
    finally { this.#admissions.delete(admission) }
    const now = this.#time()
    if (!eligible || !Number.isFinite(eligible.expiresAt) || eligible.expiresAt <= now) throw error('Recipient is ineligible')
    if ([...this.#leases.values()].filter(l => l.status === 'active').length >= 128) throw error('Lease limit')
    const lease = { leaseId: randomUUID(), generation: this.#generation, connectionGeneration: c.generation, profileId: c.profileId, tabId: m.tabId, documentId: m.documentId, origin: m.origin, urlDigest: m.urlDigest, taskId: m.taskId, agentId: m.agentId, permissions: ['read'], revision: 1, issuedAt: now, expiresAt: Math.min(now + Math.min(m.ttlSeconds ?? 300, 900) * 1000, eligible.expiresAt), status: 'active', connection: c, ready: false }
    lease.readyBy = now + 10000
    // Reserve the lease before I/O so disconnect/cancellation also fences admission.
    this.#leases.set(lease.leaseId, lease)
    try {
      await this.#audit.append({ kind: 'account-browser.shared', leaseId: lease.leaseId, profileId: lease.profileId, taskId: lease.taskId, agentId: lease.agentId, origin: lease.origin, expiresAt: lease.expiresAt })
      assertAdmission(); this.#assertCurrent(lease)
      await this.#persist(); assertAdmission(); this.#assertCurrent(lease)
      const currentRecipient = await this.#eligibleFor({ taskId: lease.taskId, agentId: lease.agentId })
      assertAdmission(); this.#assertCurrent(lease)
      if (!currentRecipient || !Number.isFinite(currentRecipient.expiresAt) || currentRecipient.expiresAt <= this.#time()) throw error('Recipient is ineligible')
      lease.expiresAt = Math.min(lease.expiresAt, currentRecipient.expiresAt)
      lease.offered = true
      return { id: m.id, type: 'shared', lease: this.#publicLease(lease) }
    } catch (e) { this.#invalidate(lease, 'failed'); await this.#persist(); throw e }
  }

  async #ready(c, m) {
    const lease = this.#leases.get(m.leaseId)
    if (!lease || lease.connection !== c || !lease.offered || lease.ready || lease.acknowledging || ['revision', 'documentId', 'origin', 'urlDigest'].some(key => m[key] !== lease[key])) throw error('Ready acknowledgement denied')
    this.#assertCurrent(lease)
    lease.acknowledging = true
    const assertEligible = async () => {
      const eligible = await this.#eligibleFor({ taskId: lease.taskId, agentId: lease.agentId })
      this.#assertCurrent(lease)
      // Do not alter the immutable expiry already installed in the companion.
      if (!eligible || !Number.isFinite(eligible.expiresAt) || eligible.expiresAt < lease.expiresAt || eligible.expiresAt <= this.#time()) throw error('Recipient is ineligible')
    }
    try {
      await assertEligible(); this.#assertCurrent(lease)
      await this.#audit.append({ kind: 'account-browser.ready', leaseId: lease.leaseId, taskId: lease.taskId, agentId: lease.agentId, revision: lease.revision })
      this.#assertCurrent(lease)
      await this.#persist(); this.#assertCurrent(lease)
      await assertEligible(); this.#assertCurrent(lease)
      // The extension installs its inspected cache before sending this ack.
      lease.ready = true
      return { id: m.id, type: 'ready', leaseId: lease.leaseId, revision: lease.revision }
    } catch (e) { this.#invalidate(lease, 'failed'); await this.#persist(); throw e }
  }

  #settle(p, failure, value) {
    if (p.settled) return
    p.settled = true; clearTimeout(p.timer); p.signal?.removeEventListener('abort', p.abort)
    if (this.#pending.get(p.lease.leaseId) === p) this.#pending.delete(p.lease.leaseId)
    if (failure) p.reject(failure); else p.resolve(value)
  }
  async read({ leaseId, taskId, agentId, signal }) {
    const lease = this.#leases.get(leaseId)
    if (!lease || !lease.ready || lease.taskId !== taskId || lease.agentId !== agentId || lease.status !== 'active') throw error('Read denied')
    this.#assertCurrent(lease)
    if (signal?.aborted || this.#pending.has(leaseId)) throw error('Read unavailable')
    const release = this.#reserveWork()
    let resolve, reject
    const promise = new Promise((yes, no) => { resolve = yes; reject = no })
    // Attach synchronously, even when invalidation races an awaited admission check.
    promise.catch(() => {})
    const p = { id: randomUUID(), lease, resolve, reject, signal, settled: false, dispatched: false, receiving: false }
    p.abort = () => { this.#invalidate(lease, 'cancelled'); this.#persist().catch(() => {}) }
    signal?.addEventListener('abort', p.abort, { once: true })
    p.timer = setTimeout(() => { this.#invalidate(lease, 'unknown'); this.#persist().catch(() => {}) }, 10000); p.timer.unref()
    this.#pending.set(leaseId, p)
    const current = () => { this.#assertCurrent(lease); if (p.settled || this.#pending.get(leaseId) !== p) throw error('Read invalidated') }
    void (async () => { try {
      const eligible = await this.#eligibleFor({ taskId, agentId }); current()
      if (!eligible || !Number.isFinite(eligible.expiresAt) || eligible.expiresAt <= this.#time()) throw error('Recipient is ineligible')
      await this.#audit.append({ kind: 'account-browser.read.requested', commandId: p.id, leaseId, taskId, agentId }); current()
      const currentRecipient = await this.#eligibleFor({ taskId, agentId }); current()
      if (!currentRecipient || !Number.isFinite(currentRecipient.expiresAt) || this.#time() >= Math.min(eligible.expiresAt, currentRecipient.expiresAt)) throw error('Recipient grant expired')
      p.dispatched = true
      lease.connection.send({ type: 'read', id: p.id, leaseId, profileId: lease.profileId, generation: lease.generation, tabId: lease.tabId, documentId: lease.documentId, origin: lease.origin, urlDigest: lease.urlDigest, revision: lease.revision, taskId, agentId, expiresAt: lease.expiresAt })
    } catch (e) { this.#settle(p, e); if (p.dispatched) { this.#invalidate(lease, 'unknown'); this.#persist().catch(() => {}) } }
    finally { release() } })()
    return promise
  }
  async #result(c, m) {
    const p = this.#pending.get(m.leaseId)
    if (!p || p.id !== m.id || p.lease.connection !== c || !p.dispatched || p.receiving) {
      this.#disconnect(c); await this.#persist(); throw error('Unexpected read result')
    }
    const lease = p.lease
    try {
      this.#assertCurrent(lease); p.receiving = true
      if (m.type === 'read-error') { this.#invalidate(lease, m.error); await this.#persist(); return undefined }
      for (const key of ['revision', 'documentId', 'origin', 'urlDigest']) if (m[key] !== lease[key]) throw error('Read binding mismatch')
      const eligible = await this.#eligibleFor({ taskId: lease.taskId, agentId: lease.agentId }); this.#assertCurrent(lease)
      if (!eligible || !Number.isFinite(eligible.expiresAt) || eligible.expiresAt <= this.#time()) throw error('Recipient is ineligible')
      await this.#audit.append({ kind: 'account-browser.read.result', commandId: p.id, leaseId: lease.leaseId, taskId: lease.taskId, agentId: lease.agentId, bytes: byteLength(m.text) })
      this.#assertCurrent(lease)
      const currentRecipient = await this.#eligibleFor({ taskId: lease.taskId, agentId: lease.agentId })
      this.#assertCurrent(lease)
      if (!currentRecipient || !Number.isFinite(currentRecipient.expiresAt) || p.settled || this.#pending.get(lease.leaseId) !== p || this.#time() >= Math.min(eligible.expiresAt, currentRecipient.expiresAt)) throw error('Read invalidated')
      this.#settle(p, null, { text: redactSensitiveText(m.text), origin: lease.origin, leaseId: lease.leaseId, untrusted: true })
    } catch (e) { this.#settle(p, e); this.#invalidate(lease, 'failed'); await this.#persist(); throw e }
  }
  revokeLease({ leaseId, reason = 'human' }) {
    const lease = this.#leases.get(leaseId)
    if (lease) this.#invalidate(lease, ['human', 'navigation', 'closed', 'replaced', 'authentication'].includes(reason) ? reason : 'human')
    return this.#persist()
  }
  revokeTask(taskId) {
    for (const admission of this.#admissions) if (admission.taskId === taskId) admission.cancelled = true
    for (const lease of this.#leases.values()) if (lease.taskId === taskId) this.#invalidate(lease, 'cancelled')
    return this.#persist()
  }
  revokePair({ profileId }) {
    for (const c of this.#connections) if (c.profileId === profileId || [...this.#pairs.values()].some(p => p.profileId === profileId && p.connection === c)) this.#disconnect(c)
    return this.#persist()
  }
  async close() {
    if (!this.#closed) {
      this.#closed = true; clearInterval(this.#timer)
      for (const c of this.#connections) this.#disconnect(c)
    }
    await this.#persist()
  }
}
