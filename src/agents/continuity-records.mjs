import crypto from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

export const AGENT_CONTINUITY_RECORDS_SCHEMA = 'chimera.agent-continuity-records.v1'
const OPEN_TOKEN = Symbol('chimera-agent-continuity-records-open')
const VALID_STATUSES = new Set(['materialized', 'unavailable', 'not-requested'])
const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const DIGEST = /^[a-f0-9]{64}$/
const FAILURE_CODE = /^[A-Z][A-Z0-9_]{2,127}$/
const MAX_RECORD_BYTES = 64 * 1024

function clone(value) {
  return structuredClone(value)
}

function validateRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || Object.getPrototypeOf(record) !== Object.prototype
    || !AGENT_ID.test(record.agentId)
    || !VALID_STATUSES.has(record.status)
    || (record.digest !== null && !DIGEST.test(record.digest))
    || !record.report || typeof record.report !== 'object' || Array.isArray(record.report)
    || (record.failureCode !== null && !FAILURE_CODE.test(record.failureCode))) {
    throw Object.assign(new TypeError('AGENT_CONTINUITY_RECORD_INVALID'), { code: 'AGENT_CONTINUITY_RECORD_INVALID' })
  }
  const normalized = {
    agentId: record.agentId,
    status: record.status,
    digest: record.digest,
    report: clone(record.report),
    failureCode: record.failureCode,
  }
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > MAX_RECORD_BYTES) {
    throw Object.assign(new TypeError('AGENT_CONTINUITY_RECORD_TOO_LARGE'), { code: 'AGENT_CONTINUITY_RECORD_TOO_LARGE' })
  }
  return normalized
}

export class DurableAgentContinuityRecords {
  #records = new Map()
  #writes = Promise.resolve()

  constructor({ filePath }, token) {
    if (token !== OPEN_TOKEN || typeof filePath !== 'string' || filePath.length === 0 || filePath.length > 4096) {
      throw new TypeError('AGENT_CONTINUITY_RECORD_CONFIG_INVALID')
    }
    this.filePath = resolve(filePath)
    this.closed = false
  }

  static async open({ filePath } = {}) {
    const records = new DurableAgentContinuityRecords({ filePath }, OPEN_TOKEN)
    await mkdir(dirname(records.filePath), { recursive: true, mode: 0o700 })
    try {
      const document = JSON.parse(await readFile(records.filePath, 'utf8'))
      if (document?.schema !== AGENT_CONTINUITY_RECORDS_SCHEMA || !Array.isArray(document.records)) {
        throw Object.assign(new Error('AGENT_CONTINUITY_RECORD_INVALID'), { code: 'AGENT_CONTINUITY_RECORD_INVALID' })
      }
      for (const record of document.records) {
        const normalized = validateRecord(record)
        if (records.#records.has(normalized.agentId)) {
          throw Object.assign(new Error('AGENT_CONTINUITY_RECORD_INVALID'), { code: 'AGENT_CONTINUITY_RECORD_INVALID' })
        }
        records.#records.set(normalized.agentId, normalized)
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    return records
  }

  get(agentId) {
    const record = this.#records.get(agentId)
    return record ? clone(record) : null
  }

  list() {
    return clone([...this.#records.values()])
  }

  async put(record) {
    const normalized = validateRecord(record)
    const operation = this.#writes.then(async () => {
      if (this.closed) throw Object.assign(new Error('AGENT_CONTINUITY_RECORDS_CLOSED'), { code: 'AGENT_CONTINUITY_RECORDS_CLOSED' })
      const previous = new Map(this.#records)
      this.#records.set(normalized.agentId, normalized)
      try {
        await this.#persist()
      } catch (error) {
        this.#records = previous
        throw error
      }
      return clone(normalized)
    })
    this.#writes = operation.then(() => undefined, () => undefined)
    return operation
  }

  async close() {
    if (this.closed) return
    await this.#writes
    this.closed = true
  }

  async #persist() {
    const document = {
      schema: AGENT_CONTINUITY_RECORDS_SCHEMA,
      records: [...this.#records.values()].map(clone),
    }
    const temporary = `${this.filePath}.${crypto.randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600, flush: true })
      await rename(temporary, this.filePath)
    } finally {
      await rm(temporary, { force: true })
    }
  }
}
