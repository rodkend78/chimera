import crypto from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { chmod, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

export const PROJECT_REGISTRY_SCHEMA = 'chimera.project-registry.v1'

const execFile = promisify(execFileCallback)
const PROJECT_ID = /^[a-z0-9][a-z0-9-]{2,63}$/
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

function coded(code) {
  return Object.assign(new Error(code), { code })
}

function bounded(value, maximum = 256) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum
}

function slug(value) {
  return value.toLowerCase().normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'project'
}

function childOf(root, candidate) {
  const base = resolve(root)
  const target = resolve(candidate)
  return target === base || target.startsWith(`${base}${sep}`)
}

function safeProject(project) {
  return structuredClone(project)
}

function networkHosts(values = []) {
  if (!Array.isArray(values) || values.length > 32) throw new TypeError('PROJECT_NETWORK_HOSTS_INVALID')
  return [...new Set(values.map((value) => {
    if (typeof value !== 'string') throw new TypeError('PROJECT_NETWORK_HOSTS_INVALID')
    const host = value.trim().toLowerCase().replace(/\.$/, '')
    if (!HOST.test(host)) throw new TypeError('PROJECT_NETWORK_HOSTS_INVALID')
    return host
  }))].toSorted()
}

async function runGit(path, ...args) {
  try {
    return await execFile('git', args, { cwd: path, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 })
  } catch {
    throw coded('PROJECT_GIT_REPOSITORY_REQUIRED')
  }
}

async function gitIdentity(path) {
  await execFile('git', ['config', 'user.name', 'Chimera'], { cwd: path })
  await execFile('git', ['config', 'user.email', 'chimera@localhost.invalid'], { cwd: path })
}

export class DurableProjectRegistry {
  #projects = new Map()
  #writes = Promise.resolve()

  constructor({ filePath, managedRoot, allowedRoots, audit, now = () => Date.now() }) {
    if (!bounded(filePath, 4096) || !bounded(managedRoot, 4096)
      || !Array.isArray(allowedRoots) || allowedRoots.length === 0
      || allowedRoots.some((path) => !bounded(path, 4096))
      || !audit?.append) {
      throw new TypeError('PROJECT_REGISTRY_CONFIG_INVALID')
    }
    this.filePath = resolve(filePath)
    this.managedRoot = resolve(managedRoot)
    this.allowedRoots = allowedRoots.map((path) => resolve(path))
    this.audit = audit
    this.now = now
  }

  static async open(options) {
    const registry = new DurableProjectRegistry(options)
    await mkdir(dirname(registry.filePath), { recursive: true, mode: 0o700 })
    await mkdir(registry.managedRoot, { recursive: true, mode: 0o700 })
    registry.allowedRoots = await Promise.all(registry.allowedRoots.map(async (path) => {
      await mkdir(path, { recursive: true, mode: 0o700 })
      return realpath(path)
    }))
    registry.managedRoot = await realpath(registry.managedRoot)
    try {
      const document = JSON.parse(await readFile(registry.filePath, 'utf8'))
      if (document?.schema !== PROJECT_REGISTRY_SCHEMA || !Array.isArray(document.projects)) {
        throw new TypeError('PROJECT_REGISTRY_INVALID')
      }
      for (const project of document.projects) registry.#restore(project)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    return registry
  }

  #restore(project) {
    if (!project || !PROJECT_ID.test(project.projectId) || !bounded(project.name)
      || !['local', 'managed'].includes(project.source?.type)
      || !bounded(project.source?.path, 4096)
      || !Array.isArray(project.networkHosts ?? [])
      || !bounded(project.defaultBranch, 256)
      || project.status !== 'ready'
      || Number.isNaN(Date.parse(project.createdAt))) {
      throw new TypeError('PROJECT_REGISTRY_INVALID')
    }
    if (this.#projects.has(project.projectId)) throw new TypeError('PROJECT_REGISTRY_INVALID')
    this.#projects.set(project.projectId, safeProject({ ...project, networkHosts: networkHosts(project.networkHosts ?? []) }))
  }

  list() {
    return [...this.#projects.values()]
      .toSorted((left, right) => left.name.localeCompare(right.name))
      .map(safeProject)
  }

  get(projectId) {
    const project = this.#projects.get(projectId)
    return project ? safeProject(project) : null
  }

  async registerLocal({ name, path, networkHosts: approvedHosts = [] } = {}) {
    if (!bounded(name) || !bounded(path, 4096)) throw new TypeError('PROJECT_INTAKE_INVALID')
    const canonical = await this.#canonicalAllowedPath(path)
    const repositoryRoot = (await runGit(canonical, 'rev-parse', '--show-toplevel')).stdout.trim()
    if (await realpath(repositoryRoot) !== canonical) throw coded('PROJECT_GIT_REPOSITORY_REQUIRED')
    return this.#register({ name: name.trim(), path: canonical, type: 'local', networkHosts: networkHosts(approvedHosts) })
  }

  async createManaged({ name, networkHosts: approvedHosts = [] } = {}) {
    if (!bounded(name)) throw new TypeError('PROJECT_INTAKE_INVALID')
    const normalizedName = name.trim()
    const seed = `${normalizedName}:${crypto.randomUUID()}`
    const projectId = this.#availableId(normalizedName, seed)
    const path = resolve(this.managedRoot, projectId)
    if (!childOf(this.managedRoot, path)) throw coded('PROJECT_PATH_OUTSIDE_ALLOWED_ROOTS')
    await mkdir(path, { recursive: false, mode: 0o700 })
    try {
      await execFile('git', ['init', '-b', 'main'], { cwd: path })
      await gitIdentity(path)
      await writeFile(resolve(path, 'README.md'), `# ${normalizedName}\n`, { mode: 0o600 })
      await execFile('git', ['add', 'README.md'], { cwd: path })
      await execFile('git', ['commit', '-m', `Initialize ${normalizedName}`], { cwd: path })
      return await this.#register({ name: normalizedName, path: await realpath(path), type: 'managed', projectId, networkHosts: networkHosts(approvedHosts) })
    } catch (error) {
      await rm(path, { recursive: true, force: true })
      throw error
    }
  }

  async #canonicalAllowedPath(path) {
    let canonical
    try {
      const info = await stat(path)
      if (!info.isDirectory()) throw coded('PROJECT_PATH_INVALID')
      canonical = await realpath(path)
    } catch (error) {
      if (error?.code?.startsWith?.('PROJECT_')) throw error
      throw coded('PROJECT_PATH_INVALID')
    }
    if (!this.allowedRoots.some((root) => childOf(root, canonical))) {
      throw coded('PROJECT_PATH_OUTSIDE_ALLOWED_ROOTS')
    }
    return canonical
  }

  #availableId(name, seed) {
    const prefix = slug(name)
    for (let index = 0; index < 32; index += 1) {
      const digest = crypto.createHash('sha256').update(`${seed}:${index}`).digest('hex').slice(0, 8)
      const candidate = `${prefix.slice(0, 55)}-${digest}`
      if (!this.#projects.has(candidate)) return candidate
    }
    throw coded('PROJECT_ID_EXHAUSTED')
  }

  async #register({ name, path, type, projectId = null, networkHosts: approvedHosts = [] }) {
    if ([...this.#projects.values()].some((project) => project.source.path === path)) {
      throw coded('PROJECT_SOURCE_ALREADY_REGISTERED')
    }
    const defaultBranch = (await runGit(path, 'branch', '--show-current')).stdout.trim()
      || (await runGit(path, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim()
    if (!bounded(defaultBranch, 256) || defaultBranch === 'HEAD') throw coded('PROJECT_DEFAULT_BRANCH_REQUIRED')
    const id = projectId ?? this.#availableId(name, path)
    const createdAt = new Date(this.now()).toISOString()
    const project = {
      schema: 'chimera.project.v1',
      projectId: id,
      name,
      source: { type, path },
      networkHosts: networkHosts(approvedHosts),
      defaultBranch,
      status: 'ready',
      createdAt,
    }
    this.#projects.set(id, project)
    try {
      await this.#persist()
    } catch (error) {
      this.#projects.delete(id)
      throw error
    }
    this.audit.append({
      kind: 'project.registered',
      projectId: id,
      projectName: name,
      sourceType: type,
      at: createdAt,
    })
    return safeProject(project)
  }

  async #persist() {
    const snapshot = `${JSON.stringify({ schema: PROJECT_REGISTRY_SCHEMA, projects: this.list() }, null, 2)}\n`
    const operation = this.#writes.then(async () => {
      const temporary = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
      try {
        await writeFile(temporary, snapshot, { mode: 0o600 })
        await rename(temporary, this.filePath)
        await chmod(this.filePath, 0o600)
      } finally {
        await rm(temporary, { force: true })
      }
    })
    this.#writes = operation.then(() => undefined, () => undefined)
    return operation
  }

  async close() {
    await this.#writes
  }
}
