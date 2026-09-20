import crypto from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const RECEIPT_SCHEMA = 'chimera.agent-create-receipts.v1'

function validRequestId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
}

function validHash(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function clone(value) {
  return structuredClone(value)
}

export class DurableAgentCreationReceipts {
  #receipts = new Map()
  #writes = Promise.resolve()

  constructor({ filePath }) {
    if (typeof filePath !== 'string' || filePath.length === 0 || filePath.length > 4096) {
      throw new TypeError('AGENT_CREATE_RECEIPT_CONFIG_INVALID')
    }
    this.filePath = resolve(filePath)
  }

  static async open({ filePath } = {}) {
    const receipts = new DurableAgentCreationReceipts({ filePath })
    await mkdir(dirname(receipts.filePath), { recursive: true, mode: 0o700 })
    try {
      const document = JSON.parse(await readFile(receipts.filePath, 'utf8'))
      if (document?.schema !== RECEIPT_SCHEMA || !Array.isArray(document.receipts)) {
        throw Object.assign(new Error('AGENT_CREATE_RECEIPT_INVALID'), { code: 'AGENT_CREATE_RECEIPT_INVALID' })
      }
      for (const receipt of document.receipts) {
        if (!validRequestId(receipt?.requestId) || !validHash(receipt?.inputHash)
          || (receipt.status !== 'reserved' && (!receipt?.result || receipt.status !== 'completed'))
          || (receipt.status === 'reserved' && !validRequestId(receipt.agentId))
          || receipts.#receipts.has(receipt.requestId)) {
          throw Object.assign(new Error('AGENT_CREATE_RECEIPT_INVALID'), { code: 'AGENT_CREATE_RECEIPT_INVALID' })
        }
        receipts.#receipts.set(receipt.requestId, clone(receipt))
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    return receipts
  }

  get(requestId) {
    const receipt = this.#receipts.get(requestId)
    return receipt ? clone(receipt) : null
  }

  list() {
    return clone([...this.#receipts.values()])
  }

  async reserve({ requestId, inputHash, agentId } = {}) {
    if (!validRequestId(requestId) || !validHash(inputHash) || !validRequestId(agentId)) {
      throw Object.assign(new TypeError('AGENT_CREATE_RECEIPT_INVALID'), { code: 'AGENT_CREATE_RECEIPT_INVALID' })
    }
    const operation = this.#writes.then(async () => {
      const existing = this.#receipts.get(requestId)
      if (existing) {
        if (existing.inputHash !== inputHash) {
          throw Object.assign(new Error('AGENT_CREATE_REQUEST_CONFLICT'), { code: 'AGENT_CREATE_REQUEST_CONFLICT' })
        }
        return clone(existing)
      }
      const owner = [...this.#receipts.values()].find((receipt) => receipt.agentId === agentId)
      if (owner) {
        throw Object.assign(new Error('AGENT_ALREADY_REGISTERED'), { code: 'AGENT_ALREADY_REGISTERED' })
      }
      const receipt = { requestId, inputHash, agentId, status: 'reserved' }
      await this.#persist(receipt)
      return clone(receipt)
    })
    this.#writes = operation.then(() => undefined, () => undefined)
    return operation
  }

  async put({ requestId, inputHash, result } = {}) {
    if (!validRequestId(requestId) || !validHash(inputHash) || !result || typeof result !== 'object') {
      throw Object.assign(new TypeError('AGENT_CREATE_RECEIPT_INVALID'), { code: 'AGENT_CREATE_RECEIPT_INVALID' })
    }
    const operation = this.#writes.then(async () => {
      const existing = this.#receipts.get(requestId)
      if (existing) {
        if (existing.inputHash !== inputHash) {
          throw Object.assign(new Error('AGENT_CREATE_REQUEST_CONFLICT'), { code: 'AGENT_CREATE_REQUEST_CONFLICT' })
        }
        if (existing.status === 'reserved') {
          await this.#persist({ requestId, inputHash, agentId: existing.agentId, status: 'completed', result: clone(result) })
          return clone(result)
        }
        return clone(existing.result)
      }
      const receipt = { requestId, inputHash, status: 'completed', result: clone(result) }
      await this.#persist(receipt)
      return clone(result)
    })
    this.#writes = operation.then(() => undefined, () => undefined)
    return operation
  }

  async #persist(receipt) {
    const previous = new Map(this.#receipts)
    this.#receipts.set(receipt.requestId, receipt)
    const document = { schema: RECEIPT_SCHEMA, receipts: [...this.#receipts.values()] }
    const temporary = `${this.filePath}.${crypto.randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
      await rename(temporary, this.filePath)
    } catch (error) {
      this.#receipts = previous
      throw error
    } finally {
      await rm(temporary, { force: true })
    }
  }
}
