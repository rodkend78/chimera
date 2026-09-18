import crypto from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

export const PROJECT_SESSION_SCHEMA = 'chimera.project-session.v1'
export const PROJECT_SESSION_LEDGER_SCHEMA = 'chimera.project-session-ledger.v1'
export const PROJECT_IDENTITY_PATH = 'mounts/project/identity.json'

const execFile = promisify(execFileCallback)
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,255}$/
const MAX_PATCH_BYTES = 2 * 1024 * 1024

function coded(code) {
  return Object.assign(new Error(code), { code })
}

function bounded(value, maximum = 256) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum
}

function childOf(root, candidate) {
  const base = resolve(root)
  const target = resolve(candidate)
  return target === base || target.startsWith(`${base}${sep}`)
}

function clone(value) {
  return structuredClone(value)
}

function digestReview({ taskId, baseCommit, branch, status, changedFiles, patch }) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({ taskId, baseCommit, branch, status, changedFiles, patch }))
    .digest('hex')
}

const SAFE_GIT_CONFIG = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.attributesFile=/dev/null',
  '-c', 'credential.helper=',
  '-c', 'filter.lfs.clean=',
  '-c', 'filter.lfs.smudge=',
  '-c', 'filter.lfs.process=',
]

async function git(cwd, args, { allowDiff = false, env = {} } = {}) {
  try {
    return await execFile('git', [...SAFE_GIT_CONFIG, ...args], {
      cwd,
      timeout: 60_000,
      maxBuffer: MAX_PATCH_BYTES + 256 * 1024,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        ...env,
      },
    })
  } catch (error) {
    if (allowDiff && error?.code === 1) return { stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
    throw error
  }
}

function validatePlan(plan) {
  let encoded
  try { encoded = JSON.stringify(plan) } catch { throw new TypeError('PROJECT_SESSION_PLAN_INVALID') }
  if (!plan || typeof plan !== 'object' || Array.isArray(plan) || !Array.isArray(plan.tasks)
    || plan.tasks.length < 1 || plan.tasks.length > 8 || Buffer.byteLength(encoded) > 256 * 1024) {
    throw new TypeError('PROJECT_SESSION_PLAN_INVALID')
  }
  return JSON.parse(encoded)
}

function parseStatus(value) {
  const changed = []
  const entries = value.split('\0')
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (!entry) continue
    const status = entry.slice(0, 2)
    const path = entry.slice(3)
    if (!path || path.includes('\0')) throw coded('PROJECT_REVIEW_INVALID')
    if (['R', 'C'].includes(status[0])) {
      const destination = entries[index + 1]
      if (!destination) throw coded('PROJECT_REVIEW_INVALID')
      changed.push({ status, path, previousPath: destination })
      index += 1
    } else {
      changed.push({ status, path })
    }
  }
  return changed.toSorted((left, right) => left.path.localeCompare(right.path))
}

function sessionProjection(session) {
  return clone(session)
}

export class ProjectSessionManager {
  #sessions = new Map()
  #writes = Promise.resolve()

  constructor({ filePath, sessionRoot, audit, now = () => Date.now() }) {
    if (!bounded(filePath, 4096) || !bounded(sessionRoot, 4096) || !audit?.append) {
      throw new TypeError('PROJECT_SESSION_MANAGER_CONFIG_INVALID')
    }
    this.filePath = resolve(filePath)
    this.sessionRoot = resolve(sessionRoot)
    this.audit = audit
    this.now = now
  }

  static async open(options) {
    const manager = new ProjectSessionManager(options)
    await mkdir(dirname(manager.filePath), { recursive: true, mode: 0o700 })
    await mkdir(manager.sessionRoot, { recursive: true, mode: 0o700 })
    manager.sessionRoot = await realpath(manager.sessionRoot)
    try {
      const document = JSON.parse(await readFile(manager.filePath, 'utf8'))
      if (document?.schema !== PROJECT_SESSION_LEDGER_SCHEMA || !Array.isArray(document.sessions)) {
        throw new TypeError('PROJECT_SESSION_LEDGER_INVALID')
      }
      for (const session of document.sessions) manager.#restore(session)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    return manager
  }

  #restore(session) {
    if (session?.schema !== PROJECT_SESSION_SCHEMA || !TASK_ID.test(session.taskId)
      || !bounded(session.projectId, 64) || !bounded(session.projectName)
      || !bounded(session.source?.path, 4096) || !bounded(session.baseCommit, 64)
      || !bounded(session.branch, 256) || !bounded(session.workspace?.repositoryPath, 4096)
      || session.workspace?.relativeRoot !== 'scratch/repo'
      || !Array.isArray(session.networkHosts ?? [])
      || (session.accessRequest !== null && session.accessRequest !== undefined
        && (!bounded(session.accessRequest.profileId, 64)
          || !Array.isArray(session.accessRequest.networkHosts)
          || !Number.isSafeInteger(session.accessRequest.ttlSeconds)))
      || !['working', 'completed', 'failed', 'committed'].includes(session.status)
      || Number.isNaN(Date.parse(session.createdAt))) {
      throw new TypeError('PROJECT_SESSION_LEDGER_INVALID')
    }
    const restored = clone(session)
    restored.workspace.protectedWriteRoots = [resolve(restored.workspace.repositoryPath, '.git')]
    this.#sessions.set(session.taskId, restored)
  }

  list() {
    return [...this.#sessions.values()]
      .toSorted((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      .map(sessionProjection)
  }

  get(taskId) {
    const session = this.#sessions.get(taskId)
    return session ? sessionProjection(session) : null
  }

  async prepare({ taskId, project, accessRequest = null } = {}) {
    if (!TASK_ID.test(taskId ?? '') || !bounded(project?.projectId, 64) || !bounded(project?.name)
      || !bounded(project?.source?.path, 4096) || !bounded(project?.defaultBranch, 256)) {
      throw new TypeError('PROJECT_SESSION_PREPARE_INVALID')
    }
    if (this.#sessions.has(taskId)) throw coded('PROJECT_SESSION_ALREADY_EXISTS')
    const sessionPath = resolve(this.sessionRoot, taskId.replace(/[^A-Za-z0-9._-]/g, '-'))
    if (!childOf(this.sessionRoot, sessionPath)) throw coded('PROJECT_SESSION_PATH_INVALID')
    const scratch = resolve(sessionPath, 'scratch')
    const repositoryPath = resolve(scratch, 'repo')
    const sourcePath = await realpath(project.source.path)
    const sourceStatus = (await git(sourcePath, ['status', '--porcelain=v1'])).stdout.trim()
    const sourceBranch = (await git(sourcePath, ['branch', '--show-current'])).stdout.trim()
    if (sourceStatus || sourceBranch !== project.defaultBranch) throw coded('PROJECT_SOURCE_NOT_READY')
    const baseCommit = (await git(sourcePath, ['rev-parse', `${project.defaultBranch}^{commit}`])).stdout.trim()
    const branch = `chimera/${taskId.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 120)}`
    await rm(sessionPath, { recursive: true, force: true })
    await mkdir(scratch, { recursive: true, mode: 0o700 })
    try {
      await git(scratch, ['clone', '--no-hardlinks', '--single-branch', '--branch', project.defaultBranch, sourcePath, 'repo'])
      await git(repositoryPath, ['switch', '-c', branch])
      await git(repositoryPath, ['config', 'user.name', 'Chimera ADE'])
      await git(repositoryPath, ['config', 'user.email', 'chimera@localhost.invalid'])
      const createdAt = new Date(this.now()).toISOString()
      const session = {
        schema: PROJECT_SESSION_SCHEMA,
        taskId,
        projectId: project.projectId,
        projectName: project.name,
        source: { type: project.source.type, path: sourcePath, defaultBranch: project.defaultBranch },
        networkHosts: clone(project.networkHosts ?? []),
        accessRequest: accessRequest ? clone(accessRequest) : null,
        baseCommit,
        branch,
        status: 'working',
        workspace: {
          path: sessionPath,
          repositoryPath,
          relativeRoot: 'scratch/repo',
          protectedWriteRoots: [resolve(repositoryPath, '.git')],
        },
        plan: null,
        createdAt,
        updatedAt: createdAt,
      }
      this.#sessions.set(taskId, session)
      try { await this.#persist() } catch (error) { this.#sessions.delete(taskId); throw error }
      this.audit.append({ kind: 'project.session.prepared', taskId, projectId: project.projectId, baseCommit, branch, at: createdAt })
      return sessionProjection(session)
    } catch (error) {
      await rm(sessionPath, { recursive: true, force: true })
      throw error
    }
  }

  async recordPlan(taskId, plan) {
    const session = this.#required(taskId)
    if (session.status !== 'working') throw coded('PROJECT_SESSION_NOT_WORKING')
    session.plan = validatePlan(plan)
    session.updatedAt = new Date(this.now()).toISOString()
    await this.#persist()
    this.audit.append({
      kind: 'project.session.staffed',
      taskId,
      projectId: session.projectId,
      specialists: session.plan.tasks.map((task) => task.specialistAgentId),
      at: session.updatedAt,
    })
    return sessionProjection(session)
  }

  async resume(taskId) {
    const session = this.#required(taskId)
    if (!['completed', 'failed'].includes(session.status)) throw coded('PROJECT_SESSION_NOT_RESUMABLE')
    // Reuse the exact isolated workspace, including uncommitted artifacts. A
    // continuation receives fresh task leases; no prior effect is replayed.
    await realpath(session.workspace.repositoryPath)
    session.status = 'working'
    session.updatedAt = new Date(this.now()).toISOString()
    await this.#persist()
    this.audit.append({ kind: 'project.session.resumed', taskId, projectId: session.projectId, at: session.updatedAt })
    return sessionProjection(session)
  }

  async markOutcome(taskId, status) {
    const session = this.#required(taskId)
    if (!['completed', 'failed'].includes(status)) throw new TypeError('PROJECT_SESSION_OUTCOME_INVALID')
    if (session.status === 'committed') return sessionProjection(session)
    session.status = status
    session.updatedAt = new Date(this.now()).toISOString()
    await this.#persist()
    this.audit.append({ kind: 'project.session.outcome', taskId, projectId: session.projectId, status, at: session.updatedAt })
    return sessionProjection(session)
  }

  async review(taskId) {
    const session = this.#required(taskId)
    const repository = session.workspace.repositoryPath
    const changedFiles = parseStatus((await git(repository, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).stdout)
    let patch = (await git(repository, ['diff', '--no-ext-diff', '--no-textconv', '--binary', session.baseCommit, '--'])).stdout
    if (Buffer.byteLength(patch) > MAX_PATCH_BYTES) throw coded('PROJECT_REVIEW_TOO_LARGE')
    for (const file of changedFiles.filter((entry) => entry.status === '??')) {
      const result = await git(repository, ['diff', '--no-ext-diff', '--no-textconv', '--no-index', '--binary', '--', '/dev/null', file.path], { allowDiff: true })
      patch += result.stdout
      if (Buffer.byteLength(patch) > MAX_PATCH_BYTES) throw coded('PROJECT_REVIEW_TOO_LARGE')
    }
    const reviewDigest = digestReview({
      taskId,
      baseCommit: session.baseCommit,
      branch: session.branch,
      status: session.status,
      changedFiles,
      patch,
    })
    return {
      schema: 'chimera.project-review.v1',
      taskId,
      projectId: session.projectId,
      projectName: session.projectName,
      status: session.status,
      baseCommit: session.baseCommit,
      branch: session.branch,
      plan: clone(session.plan),
      changedFiles,
      patch,
      reviewDigest,
      readyToCommit: changedFiles.length > 0 && session.status === 'completed',
      ...(session.commit ? { commit: clone(session.commit) } : {}),
    }
  }

  async identityReceipt(taskId) {
    const session = this.#required(taskId)
    const repository = session.workspace.repositoryPath
    // These are runtime-owned clones, not arbitrary repositories selected by
    // a tool argument. Refuse redirected paths/metadata before invoking Git.
    const actual = await realpath(repository)
    const metadata = resolve(actual, '.git')
    if (actual !== repository || !childOf(this.sessionRoot, actual)
      || !(await lstat(metadata)).isDirectory() || await realpath(metadata) !== metadata) {
      throw coded('PROJECT_IDENTITY_WORKSPACE_INVALID')
    }
    const env = {
      GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_COMMON_DIR: undefined,
      GIT_INDEX_FILE: undefined, GIT_OBJECT_DIRECTORY: undefined,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined, GIT_CONFIG_PARAMETERS: undefined,
      GIT_CONFIG_COUNT: undefined, GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1',
    }
    const head = async () => (await git(actual, ['rev-parse', '--verify', 'HEAD^{commit}'], { env })).stdout.trim()
    const checkoutCommit = await head()
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(checkoutCommit)
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(session.baseCommit)) throw coded('PROJECT_IDENTITY_INVALID')
    const changed = parseStatus((await git(actual, [
      'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching', '--ignore-submodules=none',
    ], { env })).stdout)
    if (await head() !== checkoutCommit) throw coded('PROJECT_IDENTITY_CHANGED_DURING_READ')
    return {
      schema: 'chimera.project-identity.v1',
      provenance: 'chimera-runtime-git-observation',
      taskId: session.taskId,
      projectId: session.projectId,
      projectName: session.projectName,
      relativeRoot: session.workspace.relativeRoot,
      preparedBranch: session.branch,
      baseCommit: session.baseCommit,
      checkoutCommit,
      matchesBaseCommit: checkoutCommit === session.baseCommit,
      hasWorkingTreeChanges: changed.some(entry => entry.status !== '!!'),
      hasIgnoredFiles: changed.some(entry => entry.status === '!!'),
      preparedAt: session.createdAt,
      observedAt: new Date(this.now()).toISOString(),
      limitations: [
        'Runtime observation of Git HEAD and status, not an independent signature or remote-origin verification.',
        'Not an atomic filesystem snapshot or a digest of every file; files may change after observation.',
        'Ignored file contents and untracked file contents are not hashed; commit equality alone does not prove an unchanged workspace.',
      ],
    }
  }

  async commit({ taskId, message, committedBy, expectedReviewDigest } = {}) {
    const session = this.#required(taskId)
    if (!bounded(message, 512) || !bounded(committedBy, 128) || !/^[a-f0-9]{64}$/.test(expectedReviewDigest ?? '')) throw new TypeError('PROJECT_COMMIT_INVALID')
    if (session.status === 'committed') return sessionProjection(session)
    if (session.status !== 'completed') throw coded('PROJECT_SESSION_NOT_COMPLETED')
    const source = session.source.path
    const sourceHead = (await git(source, ['rev-parse', 'HEAD'])).stdout.trim()
    const sourceStatus = (await git(source, ['status', '--porcelain=v1'])).stdout.trim()
    const sourceBranch = (await git(source, ['branch', '--show-current'])).stdout.trim()
    if (sourceHead !== session.baseCommit || sourceStatus || sourceBranch !== session.source.defaultBranch) {
      throw coded('PROJECT_SOURCE_CHANGED')
    }
    const review = await this.review(taskId)
    if (!review.readyToCommit) throw coded('PROJECT_SESSION_NO_CHANGES')
    if (review.reviewDigest !== expectedReviewDigest) throw coded('PROJECT_REVIEW_CHANGED')

    const repository = session.workspace.repositoryPath
    const patchPath = resolve(session.workspace.path, 'delivery.patch')
    await writeFile(patchPath, review.patch, { mode: 0o600 })
    await git(repository, ['read-tree', session.baseCommit])
    await git(repository, ['apply', '--cached', '--binary', '--whitespace=nowarn', patchPath])
    const sessionTree = (await git(repository, ['write-tree'])).stdout.trim()
    const commitEnv = {
      GIT_AUTHOR_NAME: 'Chimera ADE',
      GIT_AUTHOR_EMAIL: 'chimera@localhost.invalid',
      GIT_COMMITTER_NAME: 'Chimera ADE',
      GIT_COMMITTER_EMAIL: 'chimera@localhost.invalid',
    }
    const sessionCommit = (await git(repository, ['commit-tree', sessionTree, '-p', session.baseCommit, '-m', message.trim()], { env: commitEnv })).stdout.trim()
    await git(repository, ['update-ref', `refs/heads/${session.branch}`, sessionCommit, session.baseCommit])
    const patch = (await git(repository, ['diff', '--binary', session.baseCommit, sessionCommit, '--'])).stdout
    if (!patch.trim() || Buffer.byteLength(patch) > MAX_PATCH_BYTES) throw coded('PROJECT_REVIEW_TOO_LARGE')
    await git(source, ['apply', '--check', '--index', '--binary', patchPath])
    try {
      await git(source, ['apply', '--index', '--binary', patchPath])
      const sourceTree = (await git(source, ['write-tree'])).stdout.trim()
      const sourceCommit = (await git(source, ['commit-tree', sourceTree, '-p', sourceHead, '-m', message.trim()], { env: commitEnv })).stdout.trim()
      await git(source, ['update-ref', `refs/heads/${sourceBranch}`, sourceCommit, sourceHead])
    } catch (error) {
      await git(source, ['apply', '--reverse', '--index', '--binary', patchPath]).catch(() => {})
      throw error
    }
    const commit = (await git(source, ['rev-parse', 'HEAD'])).stdout.trim()
    const committedAt = new Date(this.now()).toISOString()
    session.status = 'committed'
    session.updatedAt = committedAt
    session.commit = { commit, sessionCommit, message: message.trim(), committedBy, committedAt }
    await this.#persist()
    this.audit.append({ kind: 'project.session.committed', taskId, projectId: session.projectId, commit, sessionCommit, committedBy, at: committedAt })
    return { status: 'committed', taskId, projectId: session.projectId, commit, sessionCommit, committedAt }
  }

  #required(taskId) {
    const session = this.#sessions.get(taskId)
    if (!session) throw coded('PROJECT_SESSION_NOT_FOUND')
    return session
  }

  async #persist() {
    const snapshot = `${JSON.stringify({ schema: PROJECT_SESSION_LEDGER_SCHEMA, sessions: this.list() }, null, 2)}\n`
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
