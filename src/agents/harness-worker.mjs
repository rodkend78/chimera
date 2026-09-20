import crypto from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { SignedSpecialistStub } from '../ceo/specialist-stub.mjs'
import { DshEnforcementAdapter } from '../dsh/enforcement-adapter.mjs'
import { createEd25519SigningProvider } from '../signing-provider.mjs'
import { agentMessageKeyFingerprint, verifyAgentMessage } from '../agent-message.mjs'

const SCHEMA = 'chimera.agent-worker-state.v1'
const STATES = new Set(['registered', 'starting', 'running', 'stopped', 'interrupted', 'crashed'])
const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

function bounded(value, maximum = 256) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function publicStatus(state, workspace) {
  return {
    agentId: state.agentId,
    state: state.state,
    restartCount: state.restartCount,
    lastTransitionAt: state.lastTransitionAt,
    lastHeartbeatAt: state.lastHeartbeatAt,
    ...(state.lastFailure ? { lastFailure: state.lastFailure } : {}),
    workspace: workspace?.state?.() ?? null,
  }
}

export async function removeAgentWorkerState({ stateDir, agentId } = {}) {
  if (typeof stateDir !== 'string' || stateDir.length === 0 || stateDir.length > 4096
    || typeof agentId !== 'string' || !AGENT_ID.test(agentId)) {
    throw new TypeError('AGENT_WORKER_STATE_REMOVE_INVALID')
  }
  const root = resolve(stateDir)
  const target = resolve(root, `${agentId}.json`)
  if (!target.startsWith(`${root}${sep}`)) throw new TypeError('AGENT_WORKER_STATE_REMOVE_INVALID')
  await rm(target, { force: true })
  return target
}

export class AgentHarnessWorker {
  #state
  #writes = Promise.resolve()
  #processing = new Set()

  constructor(options, state, runtimeId) {
    Object.assign(this, options)
    this.agentId = options.manifest.agentId
    this.stateFile = resolve(options.stateFile)
    this.humanKeys = new Map(options.humanKeys)
    this.toolExecutors = { ...options.toolExecutors }
    this.runtimeId = runtimeId
    this.#state = state
    this.signingProvider = createEd25519SigningProvider(options.identity)
    this.specialist = new SignedSpecialistStub({
      agentId: options.manifest.agentId,
      identity: options.identity,
      grant: options.grant,
      gateway: options.gateway,
      audit: options.audit,
      humanKeys: this.humanKeys,
      execute: options.executeModel,
      now: options.now,
    })
    this.sessionId = `worker-${options.manifest.agentId}`
    this.dsh = new DshEnforcementAdapter({
      gateway: options.gateway,
      inventory: options.inventory,
      audit: options.audit,
      approvalBroker: options.approvalBroker,
      authorityFor: async (agentId, sessionId) => (
        agentId === options.manifest.agentId && sessionId === this.sessionId
          ? { grant: options.grant, identity: options.identity }
          : null
      ),
      now: options.now,
    })
  }

  static async open(options) {
    if (!bounded(options?.manifest?.agentId)
      || !options?.workspace?.state
      || !options?.mailbox?.deliver
      || !options?.mailbox?.claim
      || !options?.mailbox?.completeWithReply
      || !options?.mailbox?.assertClaim
      || !options?.mailbox?.fail
      || !options?.identity?.privateKey
      || !options?.grant
      || !options?.gateway
      || !options?.audit?.append
      || !bounded(options?.stateFile, 4096)
      || !options?.inventory?.classify
      || typeof options?.executeModel !== 'function'
      || !options?.toolExecutors
      || typeof options?.now !== 'function') {
      throw new TypeError('AGENT_HARNESS_WORKER_CONFIG_INVALID')
    }
    const runtimeId = bounded(options.runtimeId) ? options.runtimeId : crypto.randomUUID()
    const stateFile = resolve(options.stateFile)
    let state
    try {
      state = JSON.parse(await readFile(stateFile, 'utf8'))
      if (state?.schema !== SCHEMA
        || state.agentId !== options.manifest.agentId
        || !STATES.has(state.state)
        || !Number.isSafeInteger(state.restartCount)
        || state.restartCount < 0) {
        throw new TypeError('AGENT_WORKER_STATE_INVALID')
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      const at = new Date(options.now()).toISOString()
      state = {
        schema: SCHEMA,
        agentId: options.manifest.agentId,
        state: 'registered',
        runtimeId,
        restartCount: 0,
        lastTransitionAt: at,
        lastHeartbeatAt: null,
        lastFailure: null,
      }
    }
    const worker = new AgentHarnessWorker(options, state, runtimeId)
    if (state.state === 'running' && state.runtimeId !== runtimeId) {
      await worker.#transition('interrupted', 'process-restarted')
    } else if (state.state === 'registered') {
      await worker.#persist()
    }
    return worker
  }

  status() {
    return structuredClone(publicStatus(this.#state, this.workspace))
  }

  health() {
    return {
      ...this.status(),
      healthy: this.#state.state === 'running',
    }
  }

  async start() {
    if (!['registered', 'stopped'].includes(this.#state.state)) {
      throw Object.assign(new Error('AGENT_WORKER_START_INVALID_STATE'), { code: 'AGENT_WORKER_START_INVALID_STATE' })
    }
    await this.#transition('starting')
    await this.#transition('running')
    return this.status()
  }

  async stop() {
    if (!['running', 'interrupted', 'crashed'].includes(this.#state.state)) {
      throw Object.assign(new Error('AGENT_WORKER_STOP_INVALID_STATE'), { code: 'AGENT_WORKER_STOP_INVALID_STATE' })
    }
    await this.#transition('stopped')
    return this.status()
  }

  async recover() {
    if (!['interrupted', 'crashed'].includes(this.#state.state)) {
      throw Object.assign(new Error('AGENT_WORKER_RECOVER_INVALID_STATE'), { code: 'AGENT_WORKER_RECOVER_INVALID_STATE' })
    }
    this.#state.restartCount += 1
    await this.#transition('running')
    return this.status()
  }

  async heartbeat() {
    if (this.#state.state !== 'running') return this.health()
    this.#state.lastHeartbeatAt = new Date(this.now()).toISOString()
    await this.#persist()
    return this.health()
  }

  async handle({ envelope, senderGrant, sender }) {
    if (this.#state.state !== 'running') return { status: 'rejected', reason: 'WORKER_NOT_RUNNING' }
    const delivery = await this.mailbox.deliver({
      envelope,
      senderGrant,
      recipientGrant: this.grant,
      recipient: { agentId: this.manifest.agentId, publicIdentity: this.signingProvider.publicIdentity() },
      humanKeys: this.humanKeys,
    })
    if (delivery.status !== 'delivered') return delivery
    const claim = await this.mailbox.claim({
      agentId: this.agentId, messageId: envelope.payload.messageId,
      ownerId: this.runtimeId, leaseMs: this.claimLeaseMs ?? 15 * 60_000,
    })
    return this.processClaim({ envelope, senderGrant, sender, claimToken: claim.claimToken })
  }

  async processClaim(input) {
    if (this.#state.state !== 'running') return { status: 'rejected', reason: 'WORKER_NOT_RUNNING' }
    const { envelope, senderGrant, sender, claimToken } = structuredClone(input)
    const claim = { agentId: this.agentId, messageId: envelope?.payload?.messageId, claimToken }
    this.mailbox.assertClaim({ ...claim, envelope })
    if (this.#processing.has(claim.messageId)) return { status: 'rejected', reason: 'WORKER_MESSAGE_ALREADY_PROCESSING' }
    const verification = verifyAgentMessage({ envelope, senderGrant, recipientGrant: this.grant,
      recipient: { agentId: this.agentId, publicIdentity: this.signingProvider.publicIdentity() },
      humanKeys: this.humanKeys, now: this.now })
    if (verification.status !== 'accepted') return verification
    try {
      if (sender?.agentId !== envelope.sender.agentId
        || agentMessageKeyFingerprint(sender.publicIdentity) !== envelope.sender.keyFingerprint) {
        return { status: 'rejected', reason: 'WORKER_SENDER_MISMATCH' }
      }
    } catch { return { status: 'rejected', reason: 'WORKER_SENDER_MISMATCH' } }
    this.#processing.add(claim.messageId)
    try {
      const result = await this.specialist.handle({ envelope, senderGrant, sender })
      if (result.status === 'completed') {
        const resultDelivery = await this.mailbox.completeWithReply({ ...claim, reply: {
          envelope: result.envelope, senderGrant: this.grant,
          recipientGrant: senderGrant, recipient: sender, humanKeys: this.humanKeys,
        } })
        if (resultDelivery.status !== 'completed') {
          await this.mailbox.fail({ ...claim, reason: 'result-delivery-rejected' })
          return { status: 'rejected', reason: resultDelivery.reason ?? 'RESULT_MAILBOX_REJECTED' }
        }
        await this.heartbeat()
      } else {
        await this.mailbox.fail({ ...claim, reason: 'specialist-result-rejected' })
      }
      return result
    } catch (error) {
      // Never silently requeue work after execution may have performed an
      // external effect. An expired/failed journal claim is recovered explicitly.
      try { await this.mailbox.fail({ ...claim, reason: bounded(error?.code, 128) ? error.code : 'worker-execution-failed' }) } catch { /* Retain input for recovery. */ }
      await this.#transition('crashed', bounded(error?.code, 128) ? error.code : 'worker-execution-failed')
      throw error
    } finally {
      this.#processing.delete(claim.messageId)
    }
  }

  async executeTool({ name, arguments: args = {}, callId = crypto.randomUUID(), rootCallId = callId }, execution = {}) {
    if (this.#state.state !== 'running') return { status: 'denied', reason: 'WORKER_NOT_RUNNING' }
    const exec = {
      agent: { id: this.manifest.agentId, session: { id: this.sessionId } },
      callId,
      rootCallId,
      name,
      arguments: structuredClone(args),
      token: Symbol(callId),
      assertActive: execution.assertActive,
    }
    const decision = await this.dsh.preExecute(exec)
    if (decision.kind !== 'allow') return { status: 'denied', reason: decision.reason }
    // A confirm-tier approval can wait for several minutes. Revalidate the
    // task lease after DSH approval and immediately before entering the tool
    // body so an approval cannot outlive the authority that requested it.
    if (typeof execution.assertActive === 'function') {
      try {
        const active = await execution.assertActive()
        if (active === false) throw Object.assign(new Error('PROJECT_ACCESS_LEASE_INACTIVE'), { code: 'PROJECT_ACCESS_LEASE_INACTIVE' })
      } catch (error) {
        this.dsh.observeResult(exec, { isError: true })
        return { status: 'denied', reason: error?.code === 'PROJECT_ACCESS_LEASE_INACTIVE' ? error.code : 'PROJECT_ACCESS_LEASE_INACTIVE' }
      }
    }
    const executor = this.toolExecutors[name]
    if (typeof executor !== 'function') {
      this.dsh.observeResult(exec, { isError: true })
      return { status: 'denied', reason: 'WORKER_TOOL_EXECUTOR_UNAVAILABLE' }
    }
    try {
      const workspace = execution.workspace?.state && bounded(execution.workspace.path, 4096)
        ? execution.workspace
        : this.workspace
      const result = await executor(structuredClone(exec.arguments), {
        workspace,
        agentId: this.manifest.agentId,
        taskId: this.grant.payload.taskId,
        workerSessionId: this.sessionId,
        assertActive: execution.assertTaskActive ?? execution.assertActive,
        assertAccessActive: execution.assertActive,
        ...(bounded(execution.accessProfileId, 32) ? { accessProfileId: execution.accessProfileId } : {}),
        ...(Array.isArray(execution.networkHosts) ? { networkHosts: [...execution.networkHosts] } : {}),
        ...(execution.taskScoped === true ? { taskScoped: true } : {}),
      })
      this.dsh.observeResult(exec, { isError: false })
      await this.heartbeat()
      return { status: 'completed', result }
    } catch (error) {
      this.dsh.observeResult(exec, { isError: true })
      return { status: 'failed', reason: bounded(error?.code, 128) ? error.code : 'WORKER_TOOL_FAILED' }
    }
  }

  async #transition(next, failure = null) {
    this.#state.state = next
    this.#state.runtimeId = this.runtimeId
    this.#state.lastTransitionAt = new Date(this.now()).toISOString()
    this.#state.lastHeartbeatAt = next === 'running' ? this.#state.lastTransitionAt : this.#state.lastHeartbeatAt
    this.#state.lastFailure = failure
    await this.#persist()
    this.audit.append({
      kind: 'agent.worker.lifecycle',
      agentId: this.manifest.agentId,
      state: next,
      restartCount: this.#state.restartCount,
      ...(failure ? { reason: failure } : {}),
      at: this.#state.lastTransitionAt,
    })
  }

  async #persist() {
    const snapshot = JSON.stringify(this.#state, null, 2)
    this.#writes = this.#writes.then(async () => {
      await mkdir(dirname(this.stateFile), { recursive: true, mode: 0o700 })
      const temporary = `${this.stateFile}.${process.pid}.${crypto.randomUUID()}.tmp`
      await writeFile(temporary, snapshot, { mode: 0o600 })
      await rename(temporary, this.stateFile)
      await chmod(this.stateFile, 0o600)
    })
    return this.#writes
  }
}
