import { appendFileSync, chmodSync, lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { sha256 } from '../canonical.mjs'
import { verifyAuditEntries } from '../audit-log.mjs'

const GENESIS_HASH = '0'.repeat(64)
const MAX_FACT_BYTES = 256 * 1024

function invalid(code = 'AUDIT_CHAIN_INVALID') {
  return Object.assign(new Error(code), { code })
}

function durableClone(value) {
  let encoded
  try { encoded = JSON.stringify(value) } catch { throw invalid('AUDIT_FACT_INVALID') }
  if (!encoded || Buffer.byteLength(encoded, 'utf8') > MAX_FACT_BYTES) throw invalid('AUDIT_FACT_INVALID')
  const clone = JSON.parse(encoded)
  if (!clone || typeof clone !== 'object' || Array.isArray(clone)) throw invalid('AUDIT_FACT_INVALID')
  return clone
}

export class DurableFileAuditLog {
  #entries = []

  constructor({ filePath }) {
    if (typeof filePath !== 'string' || filePath.length === 0 || filePath.length > 4096) {
      throw new TypeError('AUDIT_LOG_CONFIG_INVALID')
    }
    this.filePath = resolve(filePath)
  }

  static async open(options) {
    const audit = new DurableFileAuditLog(options)
    mkdirSync(dirname(audit.filePath), { recursive: true, mode: 0o700 })
    try {
      const info = lstatSync(audit.filePath)
      if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw invalid()
      for (const line of readFileSync(audit.filePath, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try { audit.#entries.push(JSON.parse(line)) } catch { throw invalid() }
      }
      if (!verifyAuditEntries(audit.#entries).valid) throw invalid()
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error?.code === 'AUDIT_CHAIN_INVALID' ? error : invalid()
    }
    return audit
  }

  append(fact) {
    const durableFact = durableClone(fact)
    const seq = this.#entries.length
    const prevHash = seq === 0 ? GENESIS_HASH : this.#entries[seq - 1].entryHash
    const unsigned = { seq, prevHash, fact: durableFact }
    const entry = { ...unsigned, entryHash: sha256(unsigned) }
    appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, { mode: 0o600, flag: 'a' })
    chmodSync(this.filePath, 0o600)
    this.#entries.push(Object.freeze(entry))
    return structuredClone(entry)
  }

  entries() {
    return structuredClone(this.#entries)
  }

  head() {
    return {
      nextSeq: this.#entries.length,
      headHash: this.#entries.at(-1)?.entryHash ?? GENESIS_HASH,
    }
  }

  recent(limit = 50) {
    return structuredClone(this.#entries.slice(-Math.max(1, Math.min(500, limit))))
  }

  summary() {
    // The file is verified at open; append constructs each next link. This is
    // not a new disk-integrity scan. Explicit verify() remains available.
    return { valid: true, entries: this.#entries.length, head: this.head().headHash, verification: 'verified-in-memory-chain' }
  }

  verify(entries = this.#entries) {
    return verifyAuditEntries(entries)
  }
}
