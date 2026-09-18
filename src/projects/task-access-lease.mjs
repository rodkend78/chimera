import crypto from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { AGENT_ACCESS_PROFILES } from '../agents/access-policy.mjs'

export const TASK_ACCESS_LEASE_SCHEMA = 'chimera.project-access-lease.v1'
export const TASK_ACCESS_LEASE_LEDGER_SCHEMA = 'chimera.project-access-lease-ledger.v1'

const PROFILE_RANK = Object.freeze({ sandbox: 0, connected: 1, live: 2 })
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

function coded(code) {
  return Object.assign(new Error(code), { code })
}

function bounded(value, maximum = 256) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function profile(profileId) {
  if (!AGENT_ACCESS_PROFILES[profileId]) throw new TypeError('PROJECT_ACCESS_PROFILE_INVALID')
  return profileId
}

function hosts(values) {
  if (!Array.isArray(values) || values.length > 32) throw new TypeError('PROJECT_ACCESS_HOSTS_INVALID')
  const normalized = values.map((value) => {
    if (typeof value !== 'string') throw new TypeError('PROJECT_ACCESS_HOSTS_INVALID')
    const host = value.trim().toLowerCase().replace(/\.$/, '')
    if (!HOST.test(host)) throw new TypeError('PROJECT_ACCESS_HOSTS_INVALID')
    return host
  })
  return [...new Set(normalized)].toSorted()
}

function clone(value) {
  return structuredClone(value)
}

export class DurableTaskAccessLeases {
  #leases = new Map()
  #writes = Promise.resolve()

  constructor({ filePath, audit, now = () => Date.now() }) {
    if (!bounded(filePath, 4096) || !audit?.append) throw new TypeError('PROJECT_ACCESS_LEASE_CONFIG_INVALID')
    this.filePath = resolve(filePath)
    this.audit = audit
    this.now = now
  }

  static async open(options) {
    const store = new DurableTaskAccessLeases(options)
    await mkdir(dirname(store.filePath), { recursive: true, mode: 0o700 })
    try {
      const document = JSON.parse(await readFile(store.filePath, 'utf8'))
      if (document?.schema !== TASK_ACCESS_LEASE_LEDGER_SCHEMA || !Array.isArray(document.leases)) {
        throw new TypeError('PROJECT_ACCESS_LEASE_LEDGER_INVALID')
      }
      for (const lease of document.leases) store.#restore(lease)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    return store
  }

  #restore(lease) {
    if (lease?.schema !== TASK_ACCESS_LEASE_SCHEMA || !bounded(lease.leaseId)
      || !bounded(lease.taskId) || !bounded(lease.agentId, 64)
      || !AGENT_ACCESS_PROFILES[lease.profileId]
      || !Array.isArray(lease.networkHosts) || !['active', 'revoked', 'expired'].includes(lease.status)
      || Number.isNaN(Date.parse(lease.issuedAt)) || Number.isNaN(Date.parse(lease.expiresAt))) {
      throw new TypeError('PROJECT_ACCESS_LEASE_LEDGER_INVALID')
    }
    this.#leases.set(lease.leaseId, clone(lease))
  }

  list() {
    return [...this.#leases.values()]
      .toSorted((left, right) => Date.parse(right.issuedAt) - Date.parse(left.issuedAt))
      .map(clone)
  }

  activeFor(agentId, taskId) {
    const currentTime = this.now()
    const lease = [...this.#leases.values()].find((candidate) => candidate.agentId === agentId
      && candidate.taskId === taskId && candidate.status === 'active' && Date.parse(candidate.expiresAt) > currentTime)
    return lease ? clone(lease) : null
  }

  async issue({
    taskId,
    agentId,
    ceilingProfileId,
    requestedProfileId = 'sandbox',
    approvedHosts = [],
    requestedHosts = [],
    ttlSeconds = 900,
    issuedBy,
  } = {}) {
    if (![taskId, agentId, issuedBy].every((value) => bounded(value))
      || !Number.isSafeInteger(ttlSeconds) || ttlSeconds < 300 || ttlSeconds > 3600) {
      throw new TypeError('PROJECT_ACCESS_LEASE_INVALID')
    }
    const ceiling = profile(ceilingProfileId)
    const requested = profile(requestedProfileId)
    if (PROFILE_RANK[requested] > PROFILE_RANK[ceiling]) throw coded('PROJECT_ACCESS_LEASE_EXCEEDS_CEILING')
    if (this.activeFor(agentId, taskId)) throw coded('PROJECT_ACCESS_LEASE_ALREADY_ACTIVE')
    const allowed = new Set(hosts(approvedHosts))
    const selectedHosts = hosts(requestedHosts)
    if (selectedHosts.some((host) => !allowed.has(host))) throw coded('PROJECT_ACCESS_HOST_NOT_APPROVED')
    if (requested === 'sandbox' && selectedHosts.length > 0) throw coded('PROJECT_ACCESS_HOST_NOT_APPROVED')
    const issuedAtMs = this.now()
    const lease = {
      schema: TASK_ACCESS_LEASE_SCHEMA,
      leaseId: `lease-${crypto.randomUUID()}`,
      taskId,
      agentId,
      profileId: requested,
      ceilingProfileId: ceiling,
      networkHosts: selectedHosts,
      issuedBy,
      status: 'active',
      issuedAt: new Date(issuedAtMs).toISOString(),
      expiresAt: new Date(issuedAtMs + ttlSeconds * 1000).toISOString(),
    }
    this.#leases.set(lease.leaseId, lease)
    try { await this.#persist() } catch (error) { this.#leases.delete(lease.leaseId); throw error }
    this.audit.append({ kind: 'project.access-lease.issued', leaseId: lease.leaseId, taskId, agentId, profileId: requested, ceilingProfileId: ceiling, networkHosts: selectedHosts, issuedBy, expiresAt: lease.expiresAt, at: lease.issuedAt })
    return clone(lease)
  }

  async revokeTask(taskId, { reason, revokedBy } = {}) {
    if (![taskId, reason, revokedBy].every((value) => bounded(value))) throw new TypeError('PROJECT_ACCESS_LEASE_REVOKE_INVALID')
    const revoked = []
    const revokedAt = new Date(this.now()).toISOString()
    for (const lease of this.#leases.values()) {
      if (lease.taskId !== taskId || lease.status !== 'active') continue
      lease.status = 'revoked'
      lease.revokedAt = revokedAt
      lease.revocationReason = reason
      lease.revokedBy = revokedBy
      revoked.push(clone(lease))
      this.audit.append({ kind: 'project.access-lease.revoked', leaseId: lease.leaseId, taskId, agentId: lease.agentId, reason, revokedBy, at: revokedAt })
    }
    if (revoked.length) await this.#persist()
    return revoked
  }

  async reapExpired() {
    const expired = []
    const at = new Date(this.now()).toISOString()
    for (const lease of this.#leases.values()) {
      if (lease.status !== 'active' || Date.parse(lease.expiresAt) > this.now()) continue
      lease.status = 'expired'
      lease.expiredAt = at
      expired.push(clone(lease))
      this.audit.append({ kind: 'project.access-lease.expired', leaseId: lease.leaseId, taskId: lease.taskId, agentId: lease.agentId, at })
    }
    if (expired.length) await this.#persist()
    return expired
  }

  async #persist() {
    const snapshot = `${JSON.stringify({ schema: TASK_ACCESS_LEASE_LEDGER_SCHEMA, leases: this.list() }, null, 2)}\n`
    const operation = this.#writes.then(async () => {
      const temporary = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
      try {
        await writeFile(temporary, snapshot, { mode: 0o600 })
        await rename(temporary, this.filePath)
        await chmod(this.filePath, 0o600)
      } finally {
        await rm(temporary, { force: true })
      }
    })
    this.#writes = operation.then(() => undefined, () => undefined)
    return operation
  }

  async close() {
    await this.#writes
  }
}
