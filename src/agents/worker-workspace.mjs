import crypto from 'node:crypto'
import { chmod, lstat, mkdir, readdir, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve, sep } from 'node:path'
import { workspaceFilesystem } from './workspace-filesystem.mjs'

const ENTRY_PATH = /^(?!\.)(?!.*(?:^|\/)\.)(?!.*\.\.)(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*$/
const MAX_FILES = 512
const MAX_FILE_BYTES = 1024 * 1024
const MAX_TOTAL_BYTES = 16 * 1024 * 1024
const MAX_CONTEXT_LAYER_BYTES = 64 * 1024
const REQUIRED_LAYER_REFS = Object.freeze({
  hermes: { persona: 'personaRefs', memory: 'memoryRefs' },
  chimera: { persona: 'personaRefs' },
})
const EXCLUDED_CATEGORIES = Object.freeze([
  'credentials',
  'provider-sessions',
  'private-keys',
  'authority-grants',
  'transient-runtime-state',
  'skill-assets',
])
const refreshLocks = new Map()

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
    await workspaceFilesystem({ path: dirname(path) }, { operation: 'cleanup', path: basename(path) })
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

async function materializeLayers({ staging, manifest, referenceProvider }) {
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
    if (definition.kind === 'persona'
      && manifest.source?.type === 'chimera'
      && definition.refs.length > 0
      && entries.length === 0) {
      throw Object.assign(new Error('NATIVE_PERSONA_UNAVAILABLE'), { code: 'NATIVE_PERSONA_UNAVAILABLE' })
    }
    const stats = await materializeMount({ destination, entries })
    layers.set(definition.kind, entries.map((entry) => ({ path: entry.path, content: bytesOf(entry.content) })))
    mounts.push({ kind: definition.kind, mode: 'read-only', ...stats })
  }
  validateRequiredContinuityLayers(manifest, layers)
  return { mounts, layers }
}

function entriesForLayer(layers, kind) {
  if (layers instanceof Map) return layers.get(kind) ?? []
  return Array.isArray(layers?.[kind]) ? layers[kind] : []
}

export function validateRequiredContinuityLayers(manifest, layers) {
  const required = REQUIRED_LAYER_REFS[manifest?.source?.type] ?? {}
  for (const [kind, referenceKey] of Object.entries(required)) {
    if (Array.isArray(manifest?.[referenceKey]) && manifest[referenceKey].length > 0
      && entriesForLayer(layers, kind).length === 0) {
      throw Object.assign(new Error('WORKER_CONTINUITY_INCOMPLETE'), { code: 'WORKER_CONTINUITY_INCOMPLETE' })
    }
  }
  return true
}

async function pathExists(path) {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw Object.assign(new Error('WORKER_WORKSPACE_SYMLINK'), { code: 'WORKER_WORKSPACE_SYMLINK' })
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function refreshArtifacts(root, agentId, suffix) {
  const canonical = `.${agentId}.${suffix}.tmp`
  let names
  try {
    names = await readdir(root)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  return names
    .filter((name) => name === canonical || (name.startsWith(`.${agentId}.`) && name.endsWith(`.${suffix}.tmp`)))
    .sort()
    .map((name) => resolve(root, name))
}

async function reconcileRefreshArtifacts({ root, finalPath, agentId }) {
  const staging = resolve(root, `.${agentId}.refresh.tmp`)
  await removeOwnedTree(staging)
  for (const [suffix, target] of [
    ['mounts', joinPath(finalPath, 'mounts')],
    ['manifest', joinPath(finalPath, 'manifest.json')],
  ]) {
    const candidates = await refreshArtifacts(root, agentId, suffix)
    const targetPresent = await pathExists(target)
    if (!targetPresent && candidates.length > 0) {
      // A process may have stopped after moving the old materialization to its
      // backup and before installing the staged replacement. Restore that
      // backup before beginning another refresh.
      await rename(candidates[0], target)
    }
    if (await pathExists(target)) {
      // Any remaining candidates are stale copies from an interrupted refresh;
      // the final target is a usable materialization, so cleanup cannot discard
      // the only retained copy.
      for (const candidate of candidates) await removeOwnedTree(candidate).catch(() => {})
    }
  }
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
      const { mounts, layers } = await materializeLayers({ staging, manifest, referenceProvider })
      const continuity = continuityContext(manifest.agentId, layers)
      await writeFile(joinPath(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
      await removeOwnedTree(finalPath)
      await rename(staging, finalPath)
      await audit.append({ kind: 'worker.workspace.ready', agentId: manifest.agentId, mounts, at: new Date(now()).toISOString() })
      return new AgentWorkerWorkspace({ path: finalPath, agentId: manifest.agentId, mounts, continuity, audit, now })
    } catch (error) {
      await removeOwnedTree(staging)
      throw error
    }
  }

  static async openLocal({ workspacePath, manifest, audit, now = () => Date.now() }) {
    if (typeof workspacePath !== 'string' || workspacePath.length === 0 || workspacePath.length > 4096
      || !manifest?.agentId || !audit?.append) {
      throw new TypeError('WORKER_WORKSPACE_CONFIG_INVALID')
    }
    const finalPath = resolve(workspacePath)
    const rootInfo = await lstat(finalPath).catch(error => {
      if (error?.code === 'ENOENT') throw Object.assign(new Error('WORKER_CONTINUITY_UNAVAILABLE'), { code: 'WORKER_CONTINUITY_UNAVAILABLE' })
      throw error
    })
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw Object.assign(new Error('WORKER_CONTINUITY_INVALID'), { code: 'WORKER_CONTINUITY_INVALID' })
    }
    let manifestSnapshot
    try {
      manifestSnapshot = await workspaceFilesystem({ path: finalPath }, { operation: 'snapshot', path: 'manifest.json' })
    } catch (error) {
      if (error?.code === 'WORKER_FILE_NOT_FOUND') {
        throw Object.assign(new Error('WORKER_CONTINUITY_UNAVAILABLE'), { code: 'WORKER_CONTINUITY_UNAVAILABLE' })
      }
      throw error
    }
    let persistedManifest
    let manifestBytes
    try {
      manifestBytes = Buffer.from(manifestSnapshot.base64, 'base64')
      const manifestText = manifestBytes.toString('utf8')
      if (!manifestText || !Buffer.from(manifestText, 'utf8').equals(manifestBytes)) throw new Error('invalid utf8')
      persistedManifest = JSON.parse(manifestText)
    } catch {
      throw Object.assign(new Error('WORKER_CONTINUITY_INVALID'), { code: 'WORKER_CONTINUITY_INVALID' })
    }
    const sameReferences = ['personaRefs', 'memoryRefs', 'skillRefs']
      .every(key => JSON.stringify(persistedManifest?.[key] ?? []) === JSON.stringify(manifest?.[key] ?? []))
    if (!persistedManifest
      || persistedManifest.schema !== manifest.schema
      || persistedManifest.agentId !== manifest.agentId
      || persistedManifest.source?.type !== manifest.source?.type
      || persistedManifest.source?.sourceId !== manifest.source?.sourceId
      || persistedManifest.source?.ref !== manifest.source?.ref
      || !sameReferences) {
      throw Object.assign(new Error('WORKER_CONTINUITY_MANIFEST_MISMATCH'), { code: 'WORKER_CONTINUITY_MANIFEST_MISMATCH' })
    }

    const layers = new Map()
    const mounts = []
    for (const kind of ['persona', 'memory', 'skills']) {
      const prefix = `mounts/${kind}/`
      let paths
      try {
        const discovered = await workspaceFilesystem({ path: finalPath }, { operation: 'snapshot-tree', path: `mounts/${kind}` })
        if (discovered.truncated) throw Object.assign(new Error('WORKER_CONTINUITY_INCOMPLETE'), { code: 'WORKER_CONTINUITY_INCOMPLETE' })
        paths = discovered.entries ?? []
      } catch (error) {
        if (error?.code === 'WORKER_FILE_NOT_FOUND') paths = []
        else throw error
      }
      const entries = []
      for (const entry of paths) {
        const path = entry?.path
        if (typeof path !== 'string' || !path.startsWith(prefix) || path.length <= prefix.length) {
          throw Object.assign(new Error('WORKER_CONTINUITY_INVALID'), { code: 'WORKER_CONTINUITY_INVALID' })
        }
        const relativePath = path.slice(prefix.length)
        if (!ENTRY_PATH.test(relativePath)) {
          throw Object.assign(new Error('WORKER_CONTINUITY_INVALID'), { code: 'WORKER_CONTINUITY_INVALID' })
        }
        const content = Buffer.from(entry.base64, 'base64')
        entries.push({ path: relativePath, content })
      }
      layers.set(kind, entries)
      mounts.push({ kind, mode: 'read-only', files: entries.length, bytes: entries.reduce((total, entry) => total + entry.content.byteLength, 0) })
    }
    validateRequiredContinuityLayers(manifest, layers)
    const continuity = continuityContext(manifest.agentId, layers)
    return new AgentWorkerWorkspace({ path: finalPath, agentId: manifest.agentId, mounts, continuity, audit, now })
  }

  static async refresh({ rootDir, manifest, referenceProvider, audit, now = () => Date.now() }) {
    if (typeof rootDir !== 'string' || !manifest?.agentId || !referenceProvider?.materialize || !audit?.append) {
      throw new TypeError('WORKER_WORKSPACE_CONFIG_INVALID')
    }
    const previous = refreshLocks.get(manifest.agentId) ?? Promise.resolve()
    const run = previous.then(() => refreshWorkspace({ rootDir, manifest, referenceProvider, audit, now }))
    refreshLocks.set(manifest.agentId, run.then(() => undefined, () => undefined))
    return run
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
        dependencyStatus: this.continuity.dependencyStatus,
        report: structuredClone(this.continuity.report),
      },
    }
  }

  context() {
    return structuredClone(this.continuity)
  }
}

async function refreshWorkspace({ rootDir, manifest, referenceProvider, audit, now }) {
  const root = resolve(rootDir)
  const finalPath = safeChild(root, manifest.agentId)
  await mkdir(root, { recursive: true, mode: 0o700 })
  if (!await pathExists(finalPath)) {
    return AgentWorkerWorkspace.open({ rootDir, manifest, referenceProvider, audit, now })
  }
  await reconcileRefreshArtifacts({ root, finalPath, agentId: manifest.agentId })
  const staging = resolve(root, `.${manifest.agentId}.refresh.tmp`)
  const mountsBackup = resolve(root, `.${manifest.agentId}.mounts.tmp`)
  const manifestBackup = resolve(root, `.${manifest.agentId}.manifest.tmp`)
  const oldMounts = joinPath(finalPath, 'mounts')
  const nextMounts = joinPath(staging, 'mounts')
  const oldManifest = joinPath(finalPath, 'manifest.json')
  const nextManifest = joinPath(staging, 'manifest.json')
  let oldMountsMoved = false
  let newMountsInstalled = false
  let oldManifestMoved = false
  let newManifestInstalled = false
  try {
    await mkdir(staging, { recursive: true, mode: 0o700 })
    const { mounts, layers } = await materializeLayers({ staging, manifest, referenceProvider })
    const continuity = continuityContext(manifest.agentId, layers)
    await writeFile(nextManifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })

    if (await pathExists(oldMounts)) {
      await rename(oldMounts, mountsBackup)
      oldMountsMoved = true
    }
    await rename(nextMounts, oldMounts)
    newMountsInstalled = true
    if (await pathExists(oldManifest)) {
      await rename(oldManifest, manifestBackup)
      oldManifestMoved = true
    }
    await rename(nextManifest, oldManifest)
    newManifestInstalled = true
    await audit.append({
      kind: 'worker.workspace.refreshed',
      agentId: manifest.agentId,
      mounts,
      continuity: {
        digest: continuity.digest,
        dependencyStatus: continuity.dependencyStatus,
        report: continuity.report,
      },
      at: new Date(now()).toISOString(),
    })
    // Keep both old backups until the audit append succeeds. If audit storage
    // fails, the catch block restores the prior usable materialization.
    await removeOwnedTree(mountsBackup).catch(() => {})
    await removeOwnedTree(manifestBackup).catch(() => {})
    await removeOwnedTree(staging).catch(() => {})
    return new AgentWorkerWorkspace({ path: finalPath, agentId: manifest.agentId, mounts, continuity, audit, now })
  } catch (error) {
    let manifestRestored = !oldManifestMoved
    let mountsRestored = !oldMountsMoved
    if (newManifestInstalled) {
      try { await removeOwnedTree(oldManifest); newManifestInstalled = false } catch { /* retain both copies */ }
    }
    if (oldManifestMoved) {
      try { await rename(manifestBackup, oldManifest); manifestRestored = true } catch { /* retain backup */ }
    }
    if (newMountsInstalled) {
      try { await removeOwnedTree(oldMounts); newMountsInstalled = false } catch { /* retain both copies */ }
    }
    if (oldMountsMoved) {
      try { await rename(mountsBackup, oldMounts); mountsRestored = true } catch { /* retain backup */ }
    }
    await removeOwnedTree(staging).catch(() => {})
    if (mountsRestored) await removeOwnedTree(mountsBackup).catch(() => {})
    if (manifestRestored) await removeOwnedTree(manifestBackup).catch(() => {})
    throw error
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
  report.dependencyStatus = 'unverified'

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
    dependencyStatus: 'unverified',
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
