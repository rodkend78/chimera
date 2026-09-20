import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

export const AGENT_READINESS_STORE_SCHEMA = 'chimera.agent-readiness.v1'
export const VERIFICATION_RECEIPTS_SCHEMA = 'chimera.verification-receipts.v1'

const MAX_RECORDS = 512
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const STATUS = new Set(['pending', 'passed', 'failed', 'unknown'])

function clone(value) { return structuredClone(value) }
function fail(code) { return Object.assign(new Error(code), { code }) }
function keyOf(agentId, requestScope, requestId) { return `${agentId}:${requestScope}:${requestId}` }

function safeResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const result = {}
  for (const key of ['status', 'costClass', 'executor', 'operation', 'model', 'machineRef', 'accountRef', 'sessionStatus', 'bindingFingerprint']) {
    const maximum = key === 'model' ? 512 : 128
    if (typeof value[key] === 'string' && value[key].length <= maximum) result[key] = value[key]
  }
  for (const key of ['modelCallSent', 'signedIn']) if (typeof value[key] === 'boolean') result[key] = value[key]
  for (const key of ['revision']) if (Number.isSafeInteger(value[key]) && value[key] >= 0) result[key] = value[key]
  return Object.keys(result).length > 0 ? result : undefined
}

function validateRecord(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || !AGENT_ID.test(input.agentId ?? '')
    || !REQUEST_ID.test(input.requestId ?? '')
    || typeof input.requestScope !== 'string' || input.requestScope.length === 0 || input.requestScope.length > 128
    || typeof input.intentFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(input.intentFingerprint)
    || typeof input.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(input.fingerprint)
    || typeof input.scope !== 'string' || input.scope.length === 0 || input.scope.length > 128
    || !STATUS.has(input.status)
    || typeof input.observedAt !== 'string' || Number.isNaN(Date.parse(input.observedAt))) {
    throw fail('AGENT_READINESS_RECORD_INVALID')
  }
  return {
    agentId: input.agentId,
    requestId: input.requestId,
    requestScope: input.requestScope,
    intentFingerprint: input.intentFingerprint,
    fingerprint: input.fingerprint,
    scope: input.scope,
    status: input.status,
    observedAt: input.observedAt,
    ...(Number.isSafeInteger(input.sequence) && input.sequence >= 0 ? { sequence: input.sequence } : {}),
    ...(safeResult(input.result) ? { result: safeResult(input.result) } : {}),
    ...(input.errorCode ? { errorCode: String(input.errorCode).slice(0, 128) } : {}),
  }
}

class DurableReceiptStore {
  #records = new Map()
  #writes = Promise.resolve()

  constructor({ filePath, audit, schema = AGENT_READINESS_STORE_SCHEMA, now = () => Date.now() } = {}) {
    if (typeof filePath !== 'string' || filePath.length === 0 || !audit?.append) throw new TypeError('AGENT_READINESS_STORE_CONFIG_INVALID')
    this.filePath = resolve(filePath)
    this.audit = audit
    this.schema = schema
    this.now = now
  }

  static async open(options = {}) {
    const store = new DurableReceiptStore(options)
    await mkdir(dirname(store.filePath), { recursive: true, mode: 0o700 })
    try {
      const document = JSON.parse(await readFile(store.filePath, 'utf8'))
      if (document?.schema !== store.schema || !Array.isArray(document.records) || document.records.length > MAX_RECORDS) throw fail('AGENT_READINESS_STORE_INVALID')
      for (const [index, input] of document.records.entries()) {
        const value = validateRecord(input)
        if (value.sequence === undefined) value.sequence = index
        if (store.#records.has(keyOf(value.agentId, value.requestScope, value.requestId))) throw fail('AGENT_READINESS_STORE_INVALID')
        store.#records.set(keyOf(value.agentId, value.requestScope, value.requestId), value)
      }
      let changed = false
      for (const [key, value] of store.#records) {
        if (value.status === 'pending') {
          value.status = 'unknown'
          value.errorCode = 'PROCESS_RESTARTED'
          changed = true
          store.#records.set(key, value)
        }
      }
      if (changed) await store.#persist()
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    await chmod(store.filePath, 0o600).catch(error => { if (error?.code !== 'ENOENT') throw error })
    return store
  }

  getRequest({ agentId, requestScope, requestId } = {}) {
    if (typeof agentId !== 'string' || typeof requestScope !== 'string' || typeof requestId !== 'string') return null
    const item = this.#records.get(keyOf(agentId, requestScope, requestId))
    return item ? clone(item) : null
  }

  latest(agentId, requestScope = null) {
    const rows = [...this.#records.values()].filter(item => item.agentId === agentId && (requestScope === null || item.requestScope === requestScope))
    rows.sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt) || (b.sequence ?? 0) - (a.sequence ?? 0))
    return rows[0] ? clone(rows[0]) : null
  }

  list() { return [...this.#records.values()].map(clone) }

  /**
   * Return durable receipts whose external effect cannot be safely replayed.
   * This is intentionally synchronous and read-only so a restarted runtime can
   * project the fence before any new provider request is admitted.
   */
  findUnresolved({ agentId, requestScope, fingerprint = null, excludeRequestId = null } = {}) {
    return [...this.#records.values()]
      .filter(item => item.agentId === agentId
        && item.requestScope === requestScope
        && (item.status === 'pending' || item.status === 'unknown')
        && (fingerprint === null || item.fingerprint === fingerprint)
        && item.requestId !== excludeRequestId)
      .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt) || (b.sequence ?? 0) - (a.sequence ?? 0))
      .map(clone)
  }

  async record(input = {}, { unresolvedGuard = null } = {}) {
    const value = validateRecord(input)
    const key = keyOf(value.agentId, value.requestScope, value.requestId)
    const next = clone(value)
    const operation = this.#writes.then(async () => {
      const existing = this.#records.get(key)
      if (existing) {
        if (existing.intentFingerprint !== next.intentFingerprint || existing.fingerprint !== next.fingerprint || existing.scope !== next.scope) throw fail('AGENT_READINESS_REQUEST_CONFLICT')
        // A durable terminal receipt is immutable. Callers may safely replay
        // an exact request after restart, but must never downgrade a passed,
        // failed, or unknown external effect to a new pending dispatch.
        if (existing.status !== 'pending') return clone(existing)
      } else if (this.#records.size >= MAX_RECORDS) {
        throw fail('AGENT_READINESS_STORE_FULL')
      }
      if (!existing && unresolvedGuard && typeof unresolvedGuard === 'object') {
        const matches = this.findUnresolved({
          agentId: next.agentId,
          requestScope: next.requestScope,
          fingerprint: typeof unresolvedGuard.fingerprint === 'string' ? unresolvedGuard.fingerprint : null,
          excludeRequestId: next.requestId,
        })
        if (matches.length > 0) {
          const error = fail(typeof unresolvedGuard.code === 'string' ? unresolvedGuard.code : 'AGENT_READINESS_UNRESOLVED_BINDING')
          error.record = matches[0]
          throw error
        }
      }
      next.sequence = (existing?.sequence ?? Math.max(-1, ...[...this.#records.values()].map(item => item.sequence ?? -1))) + (existing ? 0 : 1)
      await this.audit.append({
        kind: 'agent.readiness.receipt',
        agentId: next.agentId,
        requestId: next.requestId,
        requestScope: next.requestScope,
        status: next.status,
        fingerprint: next.fingerprint,
        at: next.observedAt,
      })
      const staged = new Map(this.#records)
      staged.set(key, next)
      try {
        await this.#persist(staged)
      } catch (error) {
        throw error
      }
      this.#records = staged
      return clone(next)
    })
    this.#writes = operation.then(() => undefined, () => undefined)
    return operation
  }

  async #persist(records = this.#records) {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
    const temporary = `${this.filePath}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`
    try {
      await writeFile(temporary, `${JSON.stringify({ schema: this.schema, records: [...records.values()].map(clone) }, null, 2)}\n`, { mode: 0o600 })
      await chmod(temporary, 0o600)
      await rename(temporary, this.filePath)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {})
      throw error
    }
  }
}

export class DurableAgentReadinessStore extends DurableReceiptStore {
  constructor(options = {}) { super({ ...options, schema: AGENT_READINESS_STORE_SCHEMA }) }
  static async open(options = {}) { return super.open({ ...options, schema: AGENT_READINESS_STORE_SCHEMA }) }
}

export class DurableVerificationReceiptStore extends DurableReceiptStore {
  constructor(options = {}) { super({ ...options, schema: VERIFICATION_RECEIPTS_SCHEMA }) }
  static async open(options = {}) { return super.open({ ...options, schema: VERIFICATION_RECEIPTS_SCHEMA }) }
}
