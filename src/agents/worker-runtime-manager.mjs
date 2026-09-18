const ACTIVE = new Set(['starting', 'ready', 'stopping'])
const PROFILE_RANK = Object.freeze({ sandbox: 0, connected: 1, live: 2 })
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

function coded(code) {
  return Object.assign(new Error(code), { code })
}

function taskPolicy({ agentId, accessProfileId, networkHosts, taskScoped }, accessProfileFor) {
  const standingProfileId = accessProfileFor(agentId)
  const profileId = accessProfileId ?? standingProfileId
  if (!(profileId in PROFILE_RANK) || !(standingProfileId in PROFILE_RANK)
    || PROFILE_RANK[profileId] > PROFILE_RANK[standingProfileId]) {
    throw coded('WORKER_TASK_ACCESS_EXCEEDS_CEILING')
  }
  if (!taskScoped) return { profileId, networkHosts: [] }
  if (!Array.isArray(networkHosts) || networkHosts.length > 32) throw coded('WORKER_TASK_HOSTS_INVALID')
  const normalizedHosts = networkHosts.map((value) => {
    if (typeof value !== 'string') throw coded('WORKER_TASK_HOSTS_INVALID')
    const host = value.trim().toLowerCase().replace(/\.$/, '')
    if (!HOST.test(host)) throw coded('WORKER_TASK_HOSTS_INVALID')
    return host
  })
  return { profileId, networkHosts: [...new Set(normalizedHosts)].toSorted() }
}

function safeArtifact({ path, storageName, ...artifact }) {
  return structuredClone(artifact)
}

function safeSession(record, artifacts = []) {
  return {
    workerSessionId: record.workerSessionId,
    agentId: record.agentId,
    kind: record.kind,
    provider: record.provider,
    status: record.status,
    controller: structuredClone(record.controller),
    ttlSeconds: record.ttlSeconds,
    ...(record.viewport ? { viewport: structuredClone(record.viewport) } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    expiresAt: record.expiresAt,
    ...(Array.isArray(record.networkHosts) ? { networkHosts: [...record.networkHosts] } : {}),
    ...(record.failureCode ? { failureCode: record.failureCode } : {}),
    artifacts: artifacts.map(safeArtifact),
  }
}

export class WorkerRuntimeManager {
  #mutations = Promise.resolve()
  #sessionMutations = new Map()

  constructor({ ledger, artifacts, provider, audit, agentExists, accessProfileFor, now = () => Date.now(), humanId = 'rod' }) {
    if (!ledger?.create || !artifacts?.save || !provider?.start || !audit?.append
      || typeof agentExists !== 'function' || typeof accessProfileFor !== 'function') {
      throw new TypeError('WORKER_RUNTIME_MANAGER_CONFIG_INVALID')
    }
    this.ledger = ledger
    this.artifacts = artifacts
    this.provider = provider
    this.audit = audit
    this.agentExists = agentExists
    this.accessProfileFor = accessProfileFor
    this.now = now
    this.humanId = humanId
  }

  state() {
    const artifacts = this.artifacts.list().map(safeArtifact)
    return {
      schema: 'chimera.worker-runtime.v1',
      provider: { id: 'aws-agentcore', label: 'AWS AgentCore', region: this.provider.region ?? 'us-west-2' },
      limits: { ttlMinimumSeconds: 300, ttlMaximumSeconds: 3600, activeSessions: 4 },
      sessions: this.ledger.list().map((record) => safeSession(record, artifacts.filter((artifact) => artifact.workerSessionId === record.workerSessionId))),
      artifacts,
    }
  }

  async start({ agentId, kind, ttlSeconds = 900, viewport, accessProfileId, networkHosts, taskScoped = false } = {}) {
    if (!this.agentExists(agentId)) throw coded('AGENT_NOT_REGISTERED')
    if (!['code', 'computer'].includes(kind)) throw new TypeError('WORKER_KIND_INVALID')
    const policy = taskPolicy({ agentId, accessProfileId, networkHosts, taskScoped }, this.accessProfileFor)
    if (taskScoped && kind === 'code') throw coded('WORKER_PROJECT_CODE_EXECUTOR_UNAVAILABLE')
    const profileId = policy.profileId
    if (kind === 'computer' && !['connected', 'live'].includes(profileId)) throw coded('WORKER_COMPUTER_ACCESS_REQUIRED')
    return this.#enqueue(async () => {
      const current = this.ledger.list().filter((record) => ACTIVE.has(record.status))
      if (current.some((record) => record.agentId === agentId && record.kind === kind)) throw coded('WORKER_SESSION_ALREADY_ACTIVE')
      if (current.length >= 4) throw coded('WORKER_SESSION_LIMIT_REACHED')
      let launched
      try {
        launched = await this.provider.start({ agentId, kind, ttlSeconds, ...(viewport ? { viewport } : {}), ...(taskScoped ? { networkHosts: policy.networkHosts } : {}) })
      } catch {
        throw coded('WORKER_PROVIDER_START_FAILED')
      }
      try {
        const record = await this.ledger.create({
          agentId,
          kind,
          ttlSeconds,
          ...(viewport ? { viewport } : {}),
          ...(taskScoped ? { networkHosts: policy.networkHosts } : {}),
          ...launched,
        })
        this.audit.append({ kind: 'worker.runtime.started', workerSessionId: record.workerSessionId, agentId, workerKind: kind, profileId, at: new Date(this.now()).toISOString() })
        return safeSession(record)
      } catch (error) {
        await this.provider.stop({ agentId, kind, ...launched }).catch(() => {})
        throw error
      }
    })
  }

  #record(workerSessionId) {
    const record = this.ledger.get(workerSessionId)
    if (!record) throw coded('WORKER_SESSION_NOT_FOUND')
    return record
  }

  #owned(workerSessionId, agentId) {
    const record = this.#record(workerSessionId)
    if (agentId && record.agentId !== agentId) throw coded('WORKER_SESSION_OWNER_MISMATCH')
    return record
  }

  async stop(workerSessionId, { agentId } = {}) {
    return this.#enqueueSession(workerSessionId, async () => {
      let record = this.#owned(workerSessionId, agentId)
      if (!ACTIVE.has(record.status)) return safeSession(record, this.artifacts.list({ workerSessionId }))
      record = await this.ledger.update(workerSessionId, { status: 'stopping' })
      try {
        await this.provider.stop(record)
        record = await this.ledger.update(workerSessionId, { status: 'stopped', controller: { type: 'agent', id: record.agentId } })
      } catch {
        await this.ledger.update(workerSessionId, { status: 'failed', failureCode: 'WORKER_PROVIDER_STOP_FAILED' })
        throw coded('WORKER_PROVIDER_STOP_FAILED')
      }
      this.audit.append({ kind: 'worker.runtime.stopped', workerSessionId, agentId: record.agentId, at: new Date(this.now()).toISOString() })
      return safeSession(record, this.artifacts.list({ workerSessionId }))
    })
  }

  async takeControl(workerSessionId, { humanId = this.humanId } = {}) {
    return this.#enqueueSession(workerSessionId, async () => {
      const record = this.#record(workerSessionId)
      if (record.kind !== 'computer' || record.status !== 'ready') throw coded('WORKER_COMPUTER_NOT_READY')
      if (record.controller.type === 'human') {
        if (record.controller.id !== humanId) throw coded('WORKER_CONTROL_OWNER_MISMATCH')
        return safeSession(record, this.artifacts.list({ workerSessionId }))
      }
      try {
        await this.provider.setAutomation(record, false)
      } catch {
        throw coded('WORKER_PROVIDER_CONTROL_FAILED')
      }
      let updated
      try {
        updated = await this.ledger.update(workerSessionId, { controller: { type: 'human', id: humanId } })
      } catch (error) {
        await this.provider.setAutomation(record, true).catch(() => {})
        throw error
      }
      this.audit.append({ kind: 'worker.control.taken', workerSessionId, agentId: record.agentId, humanId, at: new Date(this.now()).toISOString() })
      return safeSession(updated, this.artifacts.list({ workerSessionId }))
    })
  }

  async returnControl(workerSessionId, { humanId = this.humanId } = {}) {
    return this.#enqueueSession(workerSessionId, async () => {
      const record = this.#record(workerSessionId)
      if (record.kind !== 'computer' || record.status !== 'ready') throw coded('WORKER_COMPUTER_NOT_READY')
      if (record.controller.type !== 'human' || record.controller.id !== humanId) throw coded('WORKER_CONTROL_OWNER_MISMATCH')
      try {
        await this.provider.setAutomation(record, true)
      } catch {
        throw coded('WORKER_PROVIDER_CONTROL_FAILED')
      }
      let updated
      try {
        updated = await this.ledger.update(workerSessionId, { controller: { type: 'agent', id: record.agentId } })
      } catch (error) {
        await this.provider.setAutomation(record, false).catch(() => {})
        throw error
      }
      this.audit.append({ kind: 'worker.control.returned', workerSessionId, agentId: record.agentId, humanId, at: new Date(this.now()).toISOString() })
      return safeSession(updated, this.artifacts.list({ workerSessionId }))
    })
  }

  async liveView(workerSessionId, { humanId = this.humanId } = {}) {
    return this.#enqueueSession(workerSessionId, async () => {
      const record = this.#record(workerSessionId)
      if (record.kind !== 'computer' || record.status !== 'ready') throw coded('WORKER_COMPUTER_NOT_READY')
      if (record.controller.type !== 'human' || record.controller.id !== humanId) throw coded('WORKER_HUMAN_CONTROL_REQUIRED')
      let url
      try {
        url = await this.provider.liveView(record, { expiresIn: 45 })
      } catch {
        throw coded('WORKER_PROVIDER_LIVE_VIEW_FAILED')
      }
      this.audit.append({ kind: 'worker.live-view.issued', workerSessionId, agentId: record.agentId, humanId, expiresIn: 45, at: new Date(this.now()).toISOString() })
      return url
    })
  }

  async action(workerSessionId, input = {}, { agentId, accessProfileId, networkHosts, taskScoped = false } = {}) {
    return this.#enqueueSession(workerSessionId, async () => {
      const record = this.#owned(workerSessionId, agentId)
      if (record.status !== 'ready') throw coded('WORKER_SESSION_NOT_READY')
      if (record.controller.type === 'human') throw coded('WORKER_CONTROLLED_BY_HUMAN')
      const policy = taskPolicy({ agentId: record.agentId, accessProfileId, networkHosts, taskScoped }, this.accessProfileFor)
      if (Array.isArray(record.networkHosts)
        && (!taskScoped || policy.networkHosts.some((host) => !record.networkHosts.includes(host)))) {
        throw coded('WORKER_TASK_ACCESS_EXCEEDS_CEILING')
      }
      if (taskScoped && record.kind === 'code') throw coded('WORKER_PROJECT_CODE_EXECUTOR_UNAVAILABLE')
      if (record.kind === 'computer' && !['connected', 'live'].includes(policy.profileId)) {
        throw coded('WORKER_COMPUTER_ACCESS_REQUIRED')
      }
      if (taskScoped && record.kind === 'computer' && input.operation === 'navigate') {
        let hostname
        try { hostname = new URL(input.url).hostname.toLowerCase().replace(/\.$/, '') } catch { throw coded('WORKER_URL_INVALID') }
        if (!policy.networkHosts.includes(hostname)) throw coded('WORKER_NETWORK_HOST_NOT_LEASED')
      }
      try {
        if (record.kind === 'computer' && input.operation === 'screenshot') {
          const content = await this.provider.action(record, input)
          const artifact = await this.artifacts.save({
            workerSessionId, agentId: record.agentId, name: input.name ?? `screenshot-${this.now()}.png`, mimeType: 'image/png', content,
          })
          return { status: 'completed', artifact: safeArtifact(artifact) }
        }
        if (record.kind === 'code' && input.operation === 'export-files') {
          const content = await this.provider.action(record, { operation: 'read-files', paths: input.paths })
          const artifact = await this.artifacts.save({
            workerSessionId, agentId: record.agentId, name: input.name ?? `export-${this.now()}.json`, mimeType: 'application/json', content,
          })
          return { status: 'completed', artifact: safeArtifact(artifact) }
        }
        return await this.provider.action(record, input, {
          networkHosts: policy.networkHosts,
          taskScoped,
        })
      } catch (error) {
        if (typeof error?.code === 'string' && error.code.startsWith('WORKER_')) throw error
        throw coded('WORKER_PROVIDER_ACTION_FAILED')
      }
    })
  }

  async reconcile() {
    const reconciled = []
    for (const record of this.ledger.list()) {
      if (!ACTIVE.has(record.status)) continue
      await this.#enqueueSession(record.workerSessionId, async () => {
        try {
          await this.provider.stop(record)
          await this.ledger.update(record.workerSessionId, {
            status: 'stopped',
            controller: { type: 'agent', id: record.agentId },
            failureCode: 'PROCESS_RESTARTED',
          })
        } catch {
          await this.ledger.update(record.workerSessionId, { status: 'failed', failureCode: 'WORKER_RECONCILE_STOP_FAILED' })
        }
      })
      reconciled.push(record.workerSessionId)
    }
    return reconciled
  }

  async reapExpired() {
    const expired = []
    for (const record of this.ledger.list()) {
      if (!ACTIVE.has(record.status) || Date.parse(record.expiresAt) > this.now()) continue
      await this.#enqueueSession(record.workerSessionId, async () => {
        let current = this.ledger.get(record.workerSessionId)
        if (!current || !ACTIVE.has(current.status) || Date.parse(current.expiresAt) > this.now()) return
        current = await this.ledger.update(current.workerSessionId, { status: 'stopping' })
        try {
          await this.provider.stop(current)
          await this.ledger.update(current.workerSessionId, { status: 'expired', controller: { type: 'agent', id: current.agentId } })
          expired.push(current.workerSessionId)
        } catch (error) {
          await this.ledger.update(current.workerSessionId, { status: 'stopping', failureCode: 'WORKER_EXPIRY_STOP_FAILED' })
          this.audit.append({ kind: 'worker.runtime.expiry-stop-failed', workerSessionId: current.workerSessionId, agentId: current.agentId, code: typeof error?.code === 'string' ? error.code : 'WORKER_STOP_FAILED', at: new Date(this.now()).toISOString() })
        }
      })
    }
    return expired
  }

  executors() {
    const execute = (kind) => async (args = {}, context = {}) => {
      const agentId = context.agentId
      if (!agentId) throw coded('WORKER_AGENT_CONTEXT_REQUIRED')
      const taskContext = {
        agentId,
        ...(context.accessProfileId ? { accessProfileId: context.accessProfileId } : {}),
        ...(Array.isArray(context.networkHosts) ? { networkHosts: context.networkHosts } : {}),
        taskScoped: context.taskScoped === true,
      }
      if (args.operation === 'start') return this.start({ agentId, kind, ttlSeconds: args.ttlSeconds ?? 900, ...(args.viewport ? { viewport: args.viewport } : {}), ...taskContext })
      if (args.operation === 'stop') return this.stop(args.workerSessionId, { agentId })
      return this.action(args.workerSessionId, args, taskContext)
    }
    return {
      mcp__chimera_worker__code: execute('code'),
      mcp__chimera_worker__computer: execute('computer'),
    }
  }

  #enqueue(operation) {
    const result = this.#mutations.then(operation)
    this.#mutations = result.then(() => undefined, () => undefined)
    return result
  }

  #enqueueSession(workerSessionId, operation) {
    const previous = this.#sessionMutations.get(workerSessionId) ?? Promise.resolve()
    const result = previous.then(operation)
    const settled = result.then(() => undefined, () => undefined)
    this.#sessionMutations.set(workerSessionId, settled)
    void settled.finally(() => {
      if (this.#sessionMutations.get(workerSessionId) === settled) this.#sessionMutations.delete(workerSessionId)
    })
    return result
  }
}
