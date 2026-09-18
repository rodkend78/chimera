import { appendFileSync, chmodSync, lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export const GATEWAY_REPLAY_SCHEMA = 'chimera.gateway-replay.v1'
const ACTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/

function invalid() {
  return Object.assign(new Error('GATEWAY_REPLAY_LEDGER_INVALID'), { code: 'GATEWAY_REPLAY_LEDGER_INVALID' })
}

export class GatewayReplayLedger {
  #actions = new Set()

  constructor({ filePath }) {
    if (typeof filePath !== 'string' || filePath.length === 0 || filePath.length > 4096) {
      throw new TypeError('GATEWAY_REPLAY_LEDGER_CONFIG_INVALID')
    }
    this.filePath = resolve(filePath)
  }

  static async open(options) {
    const ledger = new GatewayReplayLedger(options)
    mkdirSync(dirname(ledger.filePath), { recursive: true, mode: 0o700 })
    try {
      const info = lstatSync(ledger.filePath)
      if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw invalid()
      for (const line of readFileSync(ledger.filePath, 'utf8').split('\n')) {
        if (!line.trim()) continue
        let event
        try { event = JSON.parse(line) } catch { throw invalid() }
        if (event?.schema !== GATEWAY_REPLAY_SCHEMA || event.event !== 'seen'
          || !ACTION_ID.test(event.actionId ?? '') || ledger.#actions.has(event.actionId)) throw invalid()
        ledger.#actions.add(event.actionId)
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error?.code === 'GATEWAY_REPLAY_LEDGER_INVALID' ? error : invalid()
    }
    return ledger
  }

  has(actionId) {
    return this.#actions.has(actionId)
  }

  record(actionId) {
    if (!ACTION_ID.test(actionId ?? '')) throw new TypeError('GATEWAY_REPLAY_ACTION_ID_INVALID')
    if (this.#actions.has(actionId)) return false
    const event = { schema: GATEWAY_REPLAY_SCHEMA, event: 'seen', actionId }
    appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, { mode: 0o600, flag: 'a' })
    chmodSync(this.filePath, 0o600)
    this.#actions.add(actionId)
    return true
  }
}
