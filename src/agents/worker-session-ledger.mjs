import crypto from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

export const WORKER_SESSION_SCHEMA = 'chimera.worker-sessions.v1'

const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const SESSION_ID = /^[A-Za-z0-9._:-]{1,256}$/
const ACTIVE = new Set(['starting', 'ready', 'stopping'])
const STATUSES = new Set([...ACTIVE, 'stopped', 'failed', 'expired'])
const KINDS = new Set(['code', 'computer'])
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

function validHosts(value) {
  return value === undefined || (Array.isArray(value) && value.length <= 32 && value.every((host) => (
    typeof host === 'string' && HOST.test(host) && host === host.trim().toLowerCase().replace(/\.$/, '')
  )))
}

function validateCreate(input) {
  if (!AGENT_ID.test(input?.agentId ?? '')) throw new TypeError('WORKER_AGENT_ID_INVALID')
  if (!KINDS.has(input?.kind)) throw new TypeError('WORKER_KIND_INVALID')
  if (!SESSION_ID.test(input?.providerSessionId ?? '')) throw new TypeError('WORKER_PROVIDER_SESSION_ID_INVALID')
  if (!Number.isInteger(input?.ttlSeconds) || input.ttlSeconds < 300 || input.ttlSeconds > 3600) throw new TypeError('WORKER_TTL_INVALID')
  if (input.kind === 'computer' && input.viewport !== undefined) {
    if (!Number.isInteger(input.viewport?.width) || input.viewport.width < 800 || input.viewport.width > 1920
      || !Number.isInteger(input.viewport?.height) || input.viewport.height < 600 || input.viewport.height > 1080) {
      throw new TypeError('WORKER_VIEWPORT_INVALID')
    }
  }
  if (!validHosts(input.networkHosts)) throw new TypeError('WORKER_TASK_HOSTS_INVALID')
}

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function validatePersistedRecord(record, seen) {
  validateCreate(record)
  if (typeof record?.workerSessionId !== 'string' || !record.workerSessionId.startsWith('worker-') || seen.has(record.workerSessionId)) throw new TypeError('WORKER_SESSION_LEDGER_INVALID')
  if (!STATUSES.has(record.status) || !['agent', 'human'].includes(record.controller?.type) || !AGENT_ID.test(record.controller?.id ?? '')) throw new TypeError('WORKER_SESSION_LEDGER_INVALID')
  if (record.controller.type === 'agent' && record.controller.id !== record.agentId) throw new TypeError('WORKER_SESSION_LEDGER_INVALID')
  if (!SESSION_ID.test(record.providerResourceId ?? '') || typeof record.provider !== 'string' || record.provider.length < 1 || record.provider.length > 64) throw new TypeError('WORKER_SESSION_LEDGER_INVALID')
  if (!validHosts(record.networkHosts)) throw new TypeError('WORKER_SESSION_LEDGER_INVALID')
  if (![record.createdAt, record.updatedAt, record.expiresAt].every(validTimestamp) || Date.parse(record.expiresAt) <= Date.parse(record.createdAt)) throw new TypeError('WORKER_SESSION_LEDGER_INVALID')
  if (record.failureCode !== undefined && (typeof record.failureCode !== 'string' || record.failureCode.length > 128)) throw new TypeError('WORKER_SESSION_LEDGER_INVALID')
  seen.add(record.workerSessionId)
}

function clone(value) {
  return value ? structuredClone(value) : null
}

export class DurableWorkerSessionLedger {
  #records = new Map()
  #writes = Promise.resolve()

  constructor({ filePath, audit, now = () => Date.now(), activeLimit = 4 }) {
    if (typeof filePath !== 'string' || !audit?.append || !Number.isInteger(activeLimit) || activeLimit < 1 || activeLimit > 32) {
      throw new TypeError('WORKER_SESSION_LEDGER_CONFIG_INVALID')
    }
    this.filePath = resolve(filePath)
    this.audit = audit
    this.now = now
    this.activeLimit = activeLimit
  }

  static async open(options) {
    const ledger = new DurableWorkerSessionLedger(options)
    await mkdir(dirname(ledger.filePath), { recursive: true, mode: 0o700 })
    try {
      const document = JSON.parse(await readFile(ledger.filePath, 'utf8'))
      if (document?.schema !== WORKER_SESSION_SCHEMA || !Array.isArray(document.sessions)) throw new TypeError('WORKER_SESSION_LEDGER_INVALID')
      const seen = new Set()
      for (const record of document.sessions) {
        validatePersistedRecord(record, seen)
        ledger.#records.set(record.workerSessionId, structuredClone(record))
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    return ledger
  }

  get(workerSessionId) {
    return clone(this.#records.get(workerSessionId))
  }

  list({ agentId } = {}) {
    return [...this.#records.values()]
      .filter((record) => !agentId || record.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((record) => structuredClone(record))
  }

  async create(input) {
    validateCreate(input)
    return this.#enqueue(async () => {
      const active = [...this.#records.values()].filter((record) => ACTIVE.has(record.status))
      if (active.length >= this.activeLimit) throw Object.assign(new Error('WORKER_SESSION_LIMIT_REACHED'), { code: 'WORKER_SESSION_LIMIT_REACHED' })
      if (active.some((record) => record.agentId === input.agentId && record.kind === input.kind)) {
        throw Object.assign(new Error('WORKER_SESSION_ALREADY_ACTIVE'), { code: 'WORKER_SESSION_ALREADY_ACTIVE' })
      }
      const now = this.now()
      const workerSessionId = `worker-${crypto.randomUUID()}`
      const record = {
        workerSessionId,
        agentId: input.agentId,
        kind: input.kind,
        provider: input.provider ?? 'aws-agentcore',
        providerResourceId: input.providerResourceId ?? (input.kind === 'computer' ? 'aws.browser.v1' : 'aws.codeinterpreter.v1'),
        providerSessionId: input.providerSessionId,
        status: input.status ?? 'ready',
        controller: { type: 'agent', id: input.agentId },
        ttlSeconds: input.ttlSeconds,
        ...(input.kind === 'computer' ? { viewport: input.viewport ?? { width: 1280, height: 800 } } : {}),
        ...(input.networkHosts !== undefined ? { networkHosts: structuredClone(input.networkHosts) } : {}),
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + input.ttlSeconds * 1000).toISOString(),
      }
      this.#records.set(workerSessionId, record)
      try {
        await this.#persist()
      } catch (error) {
        this.#records.delete(workerSessionId)
        throw error
      }
      this.audit.append({ kind: 'worker.session.created', workerSessionId, agentId: input.agentId, workerKind: input.kind, at: record.createdAt })
      return structuredClone(record)
    })
  }

  async update(workerSessionId, changes = {}) {
    if (typeof workerSessionId !== 'string' || !workerSessionId.startsWith('worker-')) throw new TypeError('WORKER_SESSION_ID_INVALID')
    return this.#enqueue(async () => {
      const current = this.#records.get(workerSessionId)
      if (!current) throw Object.assign(new Error('WORKER_SESSION_NOT_FOUND'), { code: 'WORKER_SESSION_NOT_FOUND' })
      if (changes.status !== undefined && !STATUSES.has(changes.status)) throw new TypeError('WORKER_SESSION_STATUS_INVALID')
      if (changes.controller !== undefined && !['agent', 'human'].includes(changes.controller?.type)) throw new TypeError('WORKER_CONTROLLER_INVALID')
      const record = {
        ...current,
        ...(changes.status ? { status: changes.status } : {}),
        ...(changes.controller ? { controller: structuredClone(changes.controller) } : {}),
        ...(changes.failureCode ? { failureCode: String(changes.failureCode).slice(0, 128) } : {}),
        updatedAt: new Date(this.now()).toISOString(),
      }
      this.#records.set(workerSessionId, record)
      try {
        await this.#persist()
      } catch (error) {
        this.#records.set(workerSessionId, current)
        throw error
      }
      this.audit.append({ kind: 'worker.session.updated', workerSessionId, agentId: record.agentId, status: record.status, controller: record.controller.type, at: record.updatedAt })
      return structuredClone(record)
    })
  }

  #enqueue(operation) {
    const result = this.#writes.then(operation)
    this.#writes = result.then(() => undefined, () => undefined)
    return result
  }

  async #persist() {
    const temporary = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify({ schema: WORKER_SESSION_SCHEMA, sessions: [...this.#records.values()] }, null, 2)}\n`, { mode: 0o600 })
      await rename(temporary, this.filePath)
      await chmod(this.filePath, 0o600)
    } finally {
      await rm(temporary, { force: true })
    }
  }
}
