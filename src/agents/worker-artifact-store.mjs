import crypto from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

const MANIFEST_SCHEMA = 'chimera.worker-artifacts.v1'
const SAFE_ID = /^[a-zA-Z0-9._-]{1,128}$/
const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._ -]{0,127}$/
const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function validateManifestItem(item, seen) {
  if (!SAFE_ID.test(item?.artifactId ?? '') || !String(item.artifactId).startsWith('artifact-') || seen.has(item.artifactId)) throw new TypeError('WORKER_ARTIFACT_MANIFEST_INVALID')
  if (!SAFE_ID.test(item?.workerSessionId ?? '') || !AGENT_ID.test(item?.agentId ?? '')) throw new TypeError('WORKER_ARTIFACT_MANIFEST_INVALID')
  if (!SAFE_NAME.test(item?.name ?? '') || basename(item.name) !== item.name) throw new TypeError('WORKER_ARTIFACT_MANIFEST_INVALID')
  if (typeof item?.mimeType !== 'string' || item.mimeType.length < 3 || item.mimeType.length > 128) throw new TypeError('WORKER_ARTIFACT_MANIFEST_INVALID')
  if (!Number.isInteger(item?.bytes) || item.bytes < 0 || !/^[a-f0-9]{64}$/.test(item?.sha256 ?? '') || !validTimestamp(item?.createdAt)) throw new TypeError('WORKER_ARTIFACT_MANIFEST_INVALID')
  if (typeof item?.storageName !== 'string' || basename(item.storageName) !== item.storageName || !item.storageName.startsWith(`${item.artifactId}-`)) throw new TypeError('WORKER_ARTIFACT_MANIFEST_INVALID')
  seen.add(item.artifactId)
}

export class WorkerArtifactStore {
  #items = []
  #writes = Promise.resolve()

  constructor({ rootDir, audit, now = () => Date.now(), maxFileBytes = 16 * 1024 * 1024, maxSessionBytes = 64 * 1024 * 1024 }) {
    if (typeof rootDir !== 'string' || !audit?.append || !Number.isInteger(maxFileBytes) || !Number.isInteger(maxSessionBytes)) {
      throw new TypeError('WORKER_ARTIFACT_STORE_CONFIG_INVALID')
    }
    this.rootDir = resolve(rootDir)
    this.manifestPath = join(this.rootDir, 'manifest.json')
    this.audit = audit
    this.now = now
    this.maxFileBytes = maxFileBytes
    this.maxSessionBytes = maxSessionBytes
  }

  static async open(options) {
    const store = new WorkerArtifactStore(options)
    await mkdir(store.rootDir, { recursive: true, mode: 0o700 })
    try {
      const document = JSON.parse(await readFile(store.manifestPath, 'utf8'))
      if (document?.schema !== MANIFEST_SCHEMA || !Array.isArray(document.artifacts)) throw new TypeError('WORKER_ARTIFACT_MANIFEST_INVALID')
      const seen = new Set()
      store.#items = document.artifacts.map((item) => {
        validateManifestItem(item, seen)
        return { ...item, path: join(store.rootDir, item.workerSessionId, item.storageName) }
      })
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    return store
  }

  list({ agentId, workerSessionId } = {}) {
    return this.#items
      .filter((item) => (!agentId || item.agentId === agentId) && (!workerSessionId || item.workerSessionId === workerSessionId))
      .map(({ path, storageName, ...item }) => structuredClone({ ...item, path }))
  }

  async save(input) {
    if (!SAFE_ID.test(input?.workerSessionId ?? '')) throw new TypeError('WORKER_ARTIFACT_SESSION_INVALID')
    if (!AGENT_ID.test(input?.agentId ?? '')) throw new TypeError('WORKER_ARTIFACT_AGENT_INVALID')
    if (!SAFE_NAME.test(input?.name ?? '') || basename(input.name) !== input.name) throw new TypeError('WORKER_ARTIFACT_NAME_INVALID')
    if (typeof input?.mimeType !== 'string' || input.mimeType.length < 3 || input.mimeType.length > 128) throw new TypeError('WORKER_ARTIFACT_MIME_INVALID')
    const bytes = Buffer.isBuffer(input.content) ? input.content : Buffer.from(input.content ?? '')
    if (bytes.length > this.maxFileBytes) throw Object.assign(new Error('WORKER_ARTIFACT_TOO_LARGE'), { code: 'WORKER_ARTIFACT_TOO_LARGE' })
    return this.#enqueue(async () => {
      const used = this.#items.filter((item) => item.workerSessionId === input.workerSessionId).reduce((sum, item) => sum + item.bytes, 0)
      if (used + bytes.length > this.maxSessionBytes) throw Object.assign(new Error('WORKER_ARTIFACT_SESSION_QUOTA'), { code: 'WORKER_ARTIFACT_SESSION_QUOTA' })
      const artifactId = `artifact-${crypto.randomUUID()}`
      const storageName = `${artifactId}-${input.name.replaceAll(' ', '_')}`
      const directory = join(this.rootDir, input.workerSessionId)
      const path = join(directory, storageName)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await writeFile(path, bytes, { mode: 0o600, flag: 'wx' })
      await chmod(path, 0o600)
      const item = {
        artifactId,
        workerSessionId: input.workerSessionId,
        agentId: input.agentId,
        name: input.name,
        mimeType: input.mimeType,
        bytes: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        createdAt: new Date(this.now()).toISOString(),
        storageName,
        path,
      }
      this.#items.push(item)
      try {
        await this.#persist()
      } catch (error) {
        this.#items.pop()
        await rm(path, { force: true })
        throw error
      }
      this.audit.append({ kind: 'worker.artifact.saved', artifactId, workerSessionId: input.workerSessionId, agentId: input.agentId, bytes: bytes.length, at: item.createdAt })
      return structuredClone(item)
    })
  }

  #enqueue(operation) {
    const result = this.#writes.then(operation)
    this.#writes = result.then(() => undefined, () => undefined)
    return result
  }

  async #persist() {
    const temporary = `${this.manifestPath}.${process.pid}.${crypto.randomUUID()}.tmp`
    const artifacts = this.#items.map(({ path: _path, ...item }) => item)
    try {
      await writeFile(temporary, `${JSON.stringify({ schema: MANIFEST_SCHEMA, artifacts }, null, 2)}\n`, { mode: 0o600 })
      await rename(temporary, this.manifestPath)
      await chmod(this.manifestPath, 0o600)
    } finally {
      await rm(temporary, { force: true })
    }
  }
}
