import { lstat, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { AccountCompanionBroker } from './broker.mjs'
import { startCompanionSocket, validateSocketPath } from './socket.mjs'
import { EXPECTED_ORIGIN } from './identity.mjs'
import { safeId } from './protocol.mjs'
import { fingerprint, verifyPayload } from '../identity.mjs'

const READ = 'mcp__chimera_account__read', WAIT = 'mcp__chimera_account__await_share'
const fail = code => Object.assign(new Error(code), { code })
const metadata = ({ leaseId, profileId, taskId, agentId, origin, expiresAt, revision }) => ({ leaseId, profileId, taskId, agentId, origin, expiresAt, revision, permissions: ['read'] })

// The adapter reads only the configured runtime's own state and current signed
// worker assignments. Native messages and model arguments never supply authority.
export class AccountCompanionRuntime {
  broker = null
  socket = null
  status = 'not-installed'
  closed = false
  waits = new Set()
  constructor(runtime) { this.runtime = runtime }
  get pendingWaits() { return this.waits.size }
  async start() {
    const configPath = resolve(this.runtime.profileDir, '../../account-browser/install/runtime.json')
    let info
    try { info = await lstat(configPath) } catch (error) { if (error.code === 'ENOENT') return; this.status = 'unavailable'; return }
    try {
      if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) || info.size > 8192) throw fail('CONFIG_INVALID')
      const parent = await lstat(dirname(configPath))
      if (!parent.isDirectory() || parent.uid !== process.getuid() || (parent.mode & 0o077) || await realpath(dirname(configPath)) !== dirname(configPath)) throw fail('CONFIG_INVALID')
      const config = JSON.parse(await readFile(configPath, 'utf8'))
      if (Object.keys(config).sort().join(',') !== 'allowedOrigin,extensionPath,hostManifestPath,installationId,receiptPath,schema,socketPath'
        || config.schema !== 1 || config.allowedOrigin !== EXPECTED_ORIGIN || !safeId(config.installationId)
        || ['socketPath', 'extensionPath', 'hostManifestPath', 'receiptPath'].some(key => typeof config[key] !== 'string' || !isAbsolute(config[key]) || config[key].includes('\0'))
        || config.extensionPath !== resolve(dirname(configPath), 'extensions/account-browser') || config.receiptPath !== resolve(dirname(configPath), 'receipt.json')) throw fail('CONFIG_INVALID')
      await validateSocketPath(config.socketPath)
      this.broker = await AccountCompanionBroker.open({ stateFile: resolve(configPath, '../../state.json'), audit: this.runtime.audit,
        allowedOrigin: EXPECTED_ORIGIN, eligibleFor: identity => this.eligibleFor(identity), targetsFor: () => this.targetsFor(), now: this.runtime.now })
      this.socket = await startCompanionSocket({ socketPath: config.socketPath, broker: this.broker })
      this.status = 'available'
    } catch {
      await this.broker?.close().catch(() => {}); this.broker = null; this.status = 'unavailable'
    }
  }
  eligibleFor({ taskId, agentId, workerSessionId } = {}) {
    const r = this.runtime, now = r.now()
    if (this.closed || !safeId(taskId) || !safeId(agentId) || !Number.isFinite(now)) return null
    const controller = r.taskControllers.get(taskId), worker = r.workers.get(agentId), task = r.tasks.get(taskId), security = r.specialistSecurity.get(agentId), dispatcher = r.teamDispatchers.get(taskId)
    if (!controller || controller.signal.aborted || controller.stopped || task?.status !== 'running'
      || r.workerOwners.get(agentId) !== taskId || worker?.status().state !== 'running' || worker.manifest.source.type !== 'hermes'
      || (workerSessionId !== undefined && workerSessionId !== worker.sessionId) || !security || security.grant !== worker.grant || !dispatcher) return null
    const grant = worker.grant, payload = grant.payload, root = dispatcher.root.grant
    if (payload.taskId !== taskId || payload.agentId !== agentId || payload.agentKeyFingerprint !== fingerprint(security.identity.publicKey)
      || !verifyPayload(payload, grant.signature, r.gateway.humanKeys.get(grant.humanKeyId))
      || root.payload.taskId !== taskId || controller.grantId !== root.payload.grantId
      || !verifyPayload(root.payload, root.signature, r.gateway.humanKeys.get(root.humanKeyId))) return null
    const delivery = dispatcher.state().deliveries.find(row => row.recipientAgentId === agentId && ['processing', 'waiting'].includes(row.status))
    if (!delivery) return null
    try { dispatcher.assertJobActive(delivery.messageId) } catch { return null }
    const project = task.context?.projectId || task.context?.projectSessionTaskId
    const lease = project ? r.taskAccessLeases.activeFor(agentId, taskId) : null
    if (project && !lease) return null
    if (!['connected', 'live'].includes(lease?.profileId ?? r.agentAccessPolicy.get(agentId).profileId)) return null
    if (![READ, WAIT].every(tool => payload.scopes.some(scope => scope.resource === `dsh-tool:${tool}` && scope.capability === (tool === READ ? 'browser.account.read' : 'browser.account.wait')))) return null
    const times = [Date.parse(payload.expiresAt), Date.parse(root.payload.expiresAt), ...(lease ? [Date.parse(lease.expiresAt)] : [])]
    if (times.some(value => !Number.isFinite(value) || value <= now) || [payload, root.payload].some(value => !Number.isFinite(Date.parse(value.issuedAt)) || Date.parse(value.issuedAt) > now)) return null
    return { expiresAt: Math.min(...times), signal: controller.signal }
  }
  targetsFor() { return [...this.runtime.workerOwners].flatMap(([agentId, taskId]) => this.eligibleFor({ taskId, agentId }) ? [{ taskId, agentId }] : []) }
  leasesFor(identity) {
    if (!this.eligibleFor(identity)) return []
    return (this.broker?.readyLeases() ?? []).filter(lease => lease.taskId === identity.taskId && lease.agentId === identity.agentId).map(metadata)
  }
  state() {
    const state = this.broker?.state() ?? { pendingPairs: [], profiles: [], leases: [] }
    const ready = new Set((this.broker?.readyLeases() ?? []).map(lease => lease.leaseId))
    return { status: this.closed ? 'unavailable' : this.status, ...state,
      leases: state.leases.filter(lease => lease.status !== 'active' || ready.has(lease.leaseId)).map(lease => ({ ...metadata(lease), status: lease.status })) }
  }
  async assertExecutor(context) {
    if (!context || !safeId(context.taskId) || !safeId(context.agentId) || typeof context.workerSessionId !== 'string' || typeof context.assertActive !== 'function') throw fail('ACCOUNT_COMPANION_DENIED')
    if (!this.broker || !this.eligibleFor(context)) throw fail('ACCOUNT_COMPANION_DENIED')
    if (await context.assertActive() === false) throw fail('ACCOUNT_COMPANION_DENIED')
    const eligible = this.eligibleFor(context)
    if (!eligible || !this.broker) throw fail('ACCOUNT_COMPANION_DENIED')
    return eligible
  }
  executors() {
    return {
      [READ]: async (args, context) => {
        if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== 1 || !safeId(args.leaseId)) throw fail('ACCOUNT_COMPANION_ARGUMENT_INVALID')
        const eligible = await this.assertExecutor(context)
        const result = await this.broker.read({ leaseId: args.leaseId, taskId: context.taskId, agentId: context.agentId, signal: eligible.signal })
        await this.assertExecutor(context)
        return result
      },
      [WAIT]: async (args, context) => {
        if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length) throw fail('ACCOUNT_COMPANION_ARGUMENT_INVALID')
        const eligible = await this.assertExecutor(context)
        const deadline = Math.min(this.runtime.now() + 60000, eligible.expiresAt)
        const token = new AbortController()
        const abort = () => token.abort()
        eligible.signal.addEventListener('abort', abort, { once: true }); this.waits.add(token)
        try {
          while (true) {
            if (token.signal.aborted || eligible.signal.aborted || this.closed) throw fail('ACCOUNT_COMPANION_DENIED')
            await this.assertExecutor(context)
            const leases = this.leasesFor(context)
            if (leases.length) return { status: 'shared', leases }
            const remaining = deadline - this.runtime.now()
            if (remaining <= 0) return { status: 'no-share-timeout', leases: [] }
            await new Promise(resolve => {
              const done = () => { clearTimeout(timer); token.signal.removeEventListener('abort', done); resolve() }
              const timer = setTimeout(done, Math.min(100, remaining))
              token.signal.addEventListener('abort', done, { once: true })
              if (token.signal.aborted) done()
            })
          }
        } finally { eligible.signal.removeEventListener('abort', abort); this.waits.delete(token) }
      },
    }
  }
  revokeTask(taskId) { return this.broker?.revokeTask(taskId) ?? Promise.resolve() }
  async close() {
    this.closed = true
    for (const token of this.waits) token.abort()
    const fenced = this.broker?.close()
    try { await fenced } finally { await this.socket?.close() }
  }
}
