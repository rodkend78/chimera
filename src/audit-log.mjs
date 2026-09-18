import { sha256 } from './canonical.mjs'

const GENESIS_HASH = '0'.repeat(64)

export function verifyAuditEntries(entries) {
  let expectedPrevious = GENESIS_HASH
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (entry.seq !== index) return { valid: false, index, reason: 'SEQUENCE_MISMATCH' }
    if (entry.prevHash !== expectedPrevious) return { valid: false, index, reason: 'PREVIOUS_HASH_MISMATCH' }
    const expectedHash = sha256({ seq: entry.seq, prevHash: entry.prevHash, fact: entry.fact })
    if (entry.entryHash !== expectedHash) return { valid: false, index, reason: 'ENTRY_HASH_MISMATCH' }
    expectedPrevious = entry.entryHash
  }
  return { valid: true, entries: entries.length, head: expectedPrevious }
}

export class MemoryAuditLog {
  #entries = []

  append(fact) {
    fact = structuredClone(fact)
    const seq = this.#entries.length
    const prevHash = seq === 0 ? GENESIS_HASH : this.#entries[seq - 1].entryHash
    const unsigned = { seq, prevHash, fact }
    const entry = Object.freeze({ ...unsigned, entryHash: sha256(unsigned) })
    this.#entries.push(entry)
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
    return { valid: true, entries: this.#entries.length, head: this.head().headHash, verification: 'verified-in-memory-chain' }
  }

  verify(entries = this.#entries) {
    return verifyAuditEntries(entries)
  }
}
