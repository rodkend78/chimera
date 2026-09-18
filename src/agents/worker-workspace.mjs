import crypto from 'node:crypto'
import { chmod, lstat, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'

const ENTRY_PATH = /^(?!\.)(?!.*(?:^|\/)\.)(?!.*\.\.)(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*$/
const MAX_FILES = 512
const MAX_FILE_BYTES = 1024 * 1024
const MAX_TOTAL_BYTES = 16 * 1024 * 1024
const MAX_CONTEXT_LAYER_BYTES = 64 * 1024
const EXCLUDED_CATEGORIES = Object.freeze([
  'credentials',
  'provider-sessions',
  'private-keys',
  'authority-grants',
  'transient-runtime-state',
  'skill-assets',
])

function safeChild(root, relative) {
  if (typeof relative !== 'string' || relative.length > 1024 || !ENTRY_PATH.test(relative)) {
    throw new TypeError('WORKER_REFERENCE_PATH_INVALID')
  }
  const target = resolve(root, relative)
  if (!target.startsWith(`${resolve(root)}${sep}`)) throw new TypeError('WORKER_REFERENCE_PATH_INVALID')
  return target
}

function bytesOf(content) {
  if (typeof content === 'string') return Buffer.from(content)
  if (content instanceof Uint8Array) return Buffer.from(content)
  throw new TypeError('WORKER_REFERENCE_CONTENT_INVALID')
}

async function materializeMount({ destination, entries }) {
  if (!Array.isArray(entries) || entries.length > MAX_FILES) throw new TypeError('WORKER_REFERENCE_SET_INVALID')
  const prepared = []
  let total = 0
  for (const entry of entries) {
    const target = safeChild(destination, entry?.path)
    const content = bytesOf(entry?.content)
    if (content.byteLength > MAX_FILE_BYTES) throw new TypeError('WORKER_REFERENCE_FILE_TOO_LARGE')
    total += content.byteLength
    if (total > MAX_TOTAL_BYTES) throw new TypeError('WORKER_REFERENCE_SET_TOO_LARGE')
    prepared.push({ target, content })
  }
  for (const entry of prepared) {
    await mkdir(dirname(entry.target), { recursive: true, mode: 0o700 })
    await writeFile(entry.target, entry.content, { mode: 0o400, flag: 'wx' })
  }
  const directories = new Set([destination, ...prepared.map((entry) => dirname(entry.target))])
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) await chmod(directory, 0o500)
  return { files: prepared.length, bytes: total }
}

async function removeOwnedTree(path) {
  try {
    const info = await lstat(path)
    if (info.isDirectory()) {
      await chmod(path, 0o700)
      for (const entry of await readdir(path)) await removeOwnedTree(resolve(path, entry))
    } else {
      await chmod(path, 0o600)
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  await rm(path, { recursive: true, force: true })
}

export async function removeAgentWorkerWorkspace({ rootDir, agentId } = {}) {
  if (typeof rootDir !== 'string' || rootDir.length === 0 || rootDir.length > 4096
    || typeof agentId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(agentId)) {
    throw new TypeError('WORKER_WORKSPACE_REMOVE_INVALID')
  }
  const target = safeChild(resolve(rootDir), agentId)
  await removeOwnedTree(target)
  return target
}

export class AgentWorkerWorkspace {
  constructor({ path, agentId, mounts, continuity, audit, now }) {
    this.path = path
    this.agentId = agentId
    this.mounts = mounts
    this.continuity = continuity
    this.audit = audit
    this.now = now
  }

  static async open({ rootDir, manifest, referenceProvider, audit, now = () => Date.now() }) {
    if (typeof rootDir !== 'string' || !manifest?.agentId || !referenceProvider?.materialize || !audit?.append) {
      throw new TypeError('WORKER_WORKSPACE_CONFIG_INVALID')
    }
    const root = resolve(rootDir)
    const finalPath = safeChild(root, manifest.agentId)
    const staging = resolve(root, `.${manifest.agentId}.${crypto.randomUUID()}.tmp`)
    await mkdir(root, { recursive: true, mode: 0o700 })
    await removeOwnedTree(staging)
    try {
      await mkdir(joinPath(staging, 'scratch'), { recursive: true, mode: 0o700 })
      const definitions = [
        { kind: 'persona', refs: manifest.personaRefs ?? [] },
        { kind: 'memory', refs: manifest.memoryRefs ?? [] },
        { kind: 'skills', refs: manifest.skillRefs ?? [] },
      ]
      const mounts = []
      const layers = new Map()
      for (const definition of definitions) {
        const destination = joinPath(staging, `mounts/${definition.kind}`)
        await mkdir(destination, { recursive: true, mode: 0o700 })
        const entries = []
        for (const reference of definition.refs) {
          entries.push(...await referenceProvider.materialize(reference.ref, {
            agentId: manifest.agentId,
            kind: definition.kind,
          }))
        }
        const stats = await materializeMount({ destination, entries })
        layers.set(definition.kind, entries.map((entry) => ({ path: entry.path, content: bytesOf(entry.content) })))
        mounts.push({ kind: definition.kind, mode: 'read-only', ...stats })
      }
      const continuity = continuityContext(manifest.agentId, layers)
      await writeFile(joinPath(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
      await removeOwnedTree(finalPath)
      await rename(staging, finalPath)
      audit.append({ kind: 'worker.workspace.ready', agentId: manifest.agentId, mounts, at: new Date(now()).toISOString() })
      return new AgentWorkerWorkspace({ path: finalPath, agentId: manifest.agentId, mounts, continuity, audit, now })
    } catch (error) {
      await removeOwnedTree(staging)
      throw error
    }
  }

  state() {
    return {
      agentId: this.agentId,
      path: this.path,
      isolation: 'per-agent-workspace',
      scratch: { mode: 'private-writable' },
      mounts: structuredClone(this.mounts),
      continuity: {
        digest: this.continuity.digest,
        report: structuredClone(this.continuity.report),
      },
    }
  }

  context() {
    return structuredClone(this.continuity)
  }
}

function continuityContext(agentId, layers) {
  const hash = crypto.createHash('sha256')
  const report = {}
  for (const kind of ['persona', 'memory', 'skills']) {
    const entries = [...(layers.get(kind) ?? [])].sort((left, right) => left.path.localeCompare(right.path))
    let bytes = 0
    for (const entry of entries) {
      bytes += entry.content.byteLength
      hash.update(kind)
      hash.update('\0')
      hash.update(entry.path)
      hash.update('\0')
      hash.update(String(entry.content.byteLength))
      hash.update('\0')
      hash.update(entry.content)
    }
    report[kind] = { files: entries.length, bytes }
  }
  report.excluded = [...EXCLUDED_CATEGORIES]

  const includeContent = (kind) => {
    const projected = []
    let bytes = 0
    for (const entry of [...(layers.get(kind) ?? [])].sort((left, right) => left.path.localeCompare(right.path))) {
      if (bytes + entry.content.byteLength > MAX_CONTEXT_LAYER_BYTES) break
      projected.push({ path: entry.path, content: entry.content.toString('utf8') })
      bytes += entry.content.byteLength
    }
    return projected
  }

  return Object.freeze({
    schema: 'chimera.agent-continuity-context.v1',
    agentId,
    digest: hash.digest('hex'),
    persona: includeContent('persona'),
    memory: includeContent('memory'),
    skills: [...(layers.get('skills') ?? [])]
      .map((entry) => ({ path: entry.path }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    report,
  })
}

function joinPath(root, relative) {
  return safeChild(root, relative)
}
