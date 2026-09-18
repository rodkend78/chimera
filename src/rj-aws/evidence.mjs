import { constants } from 'node:fs'
import { mkdir, lstat, open, readdir, realpath, rename } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { canonicalJson, sha256 } from '../canonical.mjs'
import { checkPath, readOwnerFile } from './worker.mjs'
import { exactFields, RJ_REQUEST_LIMIT, RJ_RECEIPT_LIMIT } from './protocol.mjs'

const unavailable = () => Object.assign(new Error('RJ_EVIDENCE_UNAVAILABLE'), { code: 'RJ_EVIDENCE_UNAVAILABLE' })
const LIMIT = RJ_REQUEST_LIMIT + RJ_RECEIPT_LIMIT + 1024

// Independent local evidence is retained even when the configured audit sink is remote.
export class RjAwsEvidence {
  static async open({ stateDir }) {
    const store = new RjAwsEvidence()
    try {
      await mkdir(stateDir, { recursive: true, mode: 0o700 })
      if ((await lstat(stateDir)).isSymbolicLink()) throw unavailable()
      store.stateDir = await realpath(resolve(stateDir))
      await checkPath(store.stateDir, { directory: true, writable: true })
      store.records = new Map()
      store.queue = Promise.resolve()
      for (const name of await readdir(store.stateDir)) {
        if (/^[a-f0-9]{64}\.[a-f0-9-]+\.tmp$/.test(name)) continue
        if (!/^[a-f0-9]{64}\.json$/.test(name)) throw unavailable()
        const entry = JSON.parse(await readOwnerFile(join(store.stateDir, name), LIMIT))
        if (!exactFields(entry, entry.receipt ? ['request', 'receipt'] : ['request'])
          || typeof entry.request?.action?.payload?.requestId !== 'string'
          || name !== `${sha256(entry.request.action.payload.requestId)}.json`) throw unavailable()
        store.records.set(entry.request.action.payload.requestId, entry)
      }
      return store
    } catch { throw unavailable() }
  }
  get(requestId) { return structuredClone(this.records.get(requestId) ?? null) }
  list() { return structuredClone([...this.records.values()]) }
  put(request, receipt) {
    const snapshot = structuredClone({ request, ...(receipt ? { receipt } : {}) })
    const operation = this.queue.then(async () => {
      try {
        const requestId = snapshot.request.action.payload.requestId
        const previous = this.records.get(requestId)
        if (previous && canonicalJson(previous.request) !== canonicalJson(snapshot.request)) throw unavailable()
        if (!receipt && previous?.receipt) return
        await checkPath(this.stateDir, { directory: true, writable: true })
        const bytes = canonicalJson(snapshot)
        if (Buffer.byteLength(bytes) > LIMIT) throw unavailable()
        const name = sha256(requestId)
        const temporary = join(this.stateDir, `${name}.${randomUUID()}.tmp`)
        const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
        await rename(temporary, join(this.stateDir, `${name}.json`))
        const directory = await open(this.stateDir, constants.O_RDONLY)
        try { await directory.sync() } finally { await directory.close() }
        this.records.set(requestId, snapshot)
      } catch { throw unavailable() }
    })
    this.queue = operation.catch(() => {})
    return operation
  }
}
