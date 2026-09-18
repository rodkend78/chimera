import { randomUUID } from 'node:crypto'
import { createAgentMessageEnvelope, verifyAgentMessage } from '../agent-message.mjs'
import { createEd25519SigningProvider } from '../signing-provider.mjs'
import { signAction } from '../identity.mjs'
import { sha256 } from '../canonical.mjs'
import { redactSensitiveData } from '../security/redaction.mjs'

export const PEER_TOOLS = Object.freeze(['agent_send', 'agent_ask', 'agent_reply', 'agent_report_blocker', 'agent_inbox'])
const error = code => Object.assign(new Error(code), { code })
const bounded = (text, limit = 16384) => typeof text === 'string' && text.length > 0 && text.length <= limit
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const publicAgent = agent => ({ agentId: agent.agentId, publicIdentity: agent.signingProvider.publicIdentity() })

export function teamMessagingProjection(mailbox, taskId) {
  const rows = mailbox.list({ taskId }).slice(-64)
  const counts = {}
  for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1
  return { taskId, participants: [...new Set(rows.flatMap(row => [row.senderAgentId, row.agentId]))], counts,
    deliveries: rows.map(row => ({ messageId: row.messageId, parentMessageId: row.parentMessageId,
      senderAgentId: row.senderAgentId, recipientAgentId: row.agentId, status: row.status, reason: redactSensitiveData(row.reason) })) }
}

// One runtime per data directory. The mailbox is the durable queue and result
// journal; runtime identities, grants, promises and physical locks stay private.
export class TeamDispatcher {
  #agents = new Map()
  #jobs = new Map()
  #busy = new Map()
  #queue = []
  #resumes = []
  #executing = 0
  #closed = false
  #reserved = 0
  #admissions = Promise.resolve()
  constructor({ taskId, root, mailbox, gateway, humanKeys, eligibleAgentIds,
    resolveSpecialist, assertActive = () => {}, eligible = () => true,
    onEvent = async () => {}, waitMs = 300_000, maxExecuting = 4, now = () => Date.now() }) {
    if (!bounded(taskId, 256) || !root?.identity || !mailbox?.interrupt || !Array.isArray(eligibleAgentIds)
      || eligibleAgentIds.length > 8 || !Number.isInteger(waitMs) || waitMs < 1 || waitMs > 900_000
      || !Number.isInteger(maxExecuting) || maxExecuting < 1 || maxExecuting > 4) throw error('TEAM_CONFIG_INVALID')
    Object.assign(this, { taskId, root, mailbox, gateway, humanKeys, resolveSpecialist, assertActive, eligible, onEvent, waitMs, maxExecuting, now })
    this.eligibleAgentIds = [...new Set(eligibleAgentIds)]
    this.#agents.set(root.agentId, Promise.resolve(root))
  }
  state() {
    const projection = teamMessagingProjection(this.mailbox, this.taskId)
    for (const row of projection.deliveries) {
      const job = this.#jobs.get(row.messageId)
      if (job?.deliveryReason) row.reason = job.deliveryReason
      if (job?.waiting && !job.terminal && row.status === 'processing') {
        projection.counts[row.status]--; projection.counts.waiting = (projection.counts.waiting ?? 0) + 1
        row.status = 'waiting'; row.waitingForAgentId = job.waiting
      }
      if (job?.outcome?.durabilityReason) {
        projection.counts[row.status]--; projection.counts.interrupted = (projection.counts.interrupted ?? 0) + 1
        row.status = 'interrupted'; row.reason = job.outcome.durabilityReason
      }
    }
    return projection
  }
  peers(agentId) { return this.eligibleAgentIds.filter(id => id !== agentId && this.eligible(id)) }
  #assertOpen() { this.assertActive(); if (this.#closed) throw error('TEAM_TASK_CLOSED') }
  assertJobActive(messageId) {
    this.#assertOpen()
    const job = this.#jobs.get(messageId)
    if (!job || job.terminal || !job.claim) throw error('TEAM_JOB_INACTIVE')
    this.mailbox.assertClaim({ ...job.claim, envelope: job.envelope })
    if (!this.eligible(job.agentId)) throw error('TEAM_PEER_NOT_ELIGIBLE')
  }
  async #resolve(agentId) {
    if (!this.#agents.has(agentId)) this.#agents.set(agentId, Promise.resolve().then(() => this.resolveSpecialist(agentId)))
    const agent = await this.#agents.get(agentId)
    this.#assertOpen()
    if (!agent || agent.agentId !== agentId || !agent.grant || !agent.signingProvider) throw error('TEAM_RESOLVER_INVALID')
    return agent
  }
  async delegate({ specialistAgentId, objective, acceptanceCriteria, request = null, parentMessageId = null, assertProposalCurrent = () => {} }) {
    const job = await this.#enqueue({ sender: this.root, agentId: specialistAgentId, objective, acceptanceCriteria, request, parentMessageId, assertProposalCurrent })
    return job.result.promise
  }
  async executePeerTool(messageId, name, args, { assertProposalCurrent = () => {} } = {}) {
    this.assertJobActive(messageId)
    assertProposalCurrent()
    const job = this.#jobs.get(messageId)
    if (!PEER_TOOLS.includes(name) || !args || typeof args !== 'object' || Array.isArray(args)) throw error('TEAM_TOOL_ARGUMENT_INVALID')
    const keys = name === 'agent_send' || name === 'agent_ask' ? ['recipientAgentId', 'objective', 'acceptanceCriteria']
      : name === 'agent_inbox' ? [] : ['summary']
    if (Object.keys(args).some(key => !keys.includes(key))) throw error('TEAM_TOOL_ARGUMENT_INVALID')
    if (name === 'agent_inbox') return { status: 'completed', messages: this.inbox(messageId) }
    if (name === 'agent_reply' || name === 'agent_report_blocker') {
      if (!bounded(args.summary)) throw error('TEAM_TOOL_ARGUMENT_INVALID')
      return { status: name === 'agent_reply' ? 'completed' : 'blocked', terminal: true, summary: redactSensitiveData(args.summary) }
    }
    if (name === 'agent_ask') job.waiting = args.recipientAgentId
    let child
    try {
      child = await this.#enqueue({ sender: job.agent, agentId: args.recipientAgentId, objective: args.objective,
        acceptanceCriteria: args.acceptanceCriteria ?? ['Return evidence or a concrete blocker.'], parentMessageId: messageId, assertProposalCurrent })
    } catch (failure) { job.waiting = null; throw failure }
    if (name === 'agent_send') return { status: 'queued', messageId: child.envelope.payload.messageId }
    // A suspended assignment retains the per-agent lock, but yields its global
    // execution slot. Resume must reacquire that slot before another model turn.
    this.#executing--; job.slot = false; this.#pump()
    try { return await child.result.promise } finally {
      job.waiting = null
      if (!job.terminal && !this.#closed) {
        const resume = deferred(); this.#resumes.push({ job, resume }); this.#pump(); await resume.promise
      }
    }
  }
  inbox(messageId) {
    const job = this.#jobs.get(messageId)
    if (!job) return []
    return redactSensitiveData([...this.#jobs.values()].filter(child => child.parentMessageId === messageId && child.outcome)
      .map(child => child.outcome).slice(-16))
  }
  async #enqueue(input) {
    // Serialize admission across asynchronous resolver/durability boundaries so
    // depth and message limits cannot be bypassed by concurrent submissions.
    const operation = this.#admissions.then(() => this.#admit(input))
    this.#admissions = operation.catch(() => {})
    return operation
  }
  async #admit({ sender, agentId, objective, acceptanceCriteria, request = null, parentMessageId, assertProposalCurrent = () => {} }) {
    this.#assertOpen()
    assertProposalCurrent()
    if (!this.eligibleAgentIds.includes(agentId) || !this.eligible(agentId)) throw error('TEAM_PEER_NOT_ELIGIBLE')
    if (!bounded(objective) || !Array.isArray(acceptanceCriteria) || acceptanceCriteria.length < 1 || acceptanceCriteria.length > 64
      || acceptanceCriteria.some(item => !bounded(item, 4096))) throw error('TEAM_TOOL_ARGUMENT_INVALID')
    const parent = this.#jobs.get(parentMessageId)
    if (sender.agentId !== this.root.agentId) {
      this.assertJobActive(parentMessageId)
      if (parent.agentId !== sender.agentId) throw error('TEAM_PARENT_MISMATCH')
    }
    const ancestors = parent ? [...parent.ancestors, parent.agentId] : [this.root.agentId]
    if (ancestors.includes(agentId)) throw error('TEAM_DEPENDENCY_CYCLE')
    // Follow active wait dependencies, including jobs belonging to another
    // top-level assignment, before admitting a dependency on its busy agent.
    const visited = new Set(ancestors)
    let busy = this.#busy.get(agentId)
    while (busy) {
      if (visited.has(busy.agentId)) throw error('TEAM_DEPENDENCY_CYCLE')
      visited.add(busy.agentId)
      busy = busy.waiting ? this.#busy.get(busy.waiting) : null
    }
    if (ancestors.length > 4) throw error('TEAM_DEPTH_LIMIT')
    if (this.#reserved + 2 > 32) throw error('TEAM_MESSAGE_LIMIT')
    const agent = await this.#resolve(agentId)
    this.#assertOpen()
    if (parent) this.assertJobActive(parentMessageId)
    assertProposalCurrent()
    const grants = [sender.grant, agent.grant]
    const window = { issuedAt: new Date(Math.max(this.now() - 1000, ...grants.map(g => Date.parse(g.payload.issuedAt)))).toISOString(),
      expiresAt: new Date(Math.min(this.now() + 900000, ...grants.map(g => Date.parse(g.payload.expiresAt)))).toISOString() }
    const envelope = createAgentMessageEnvelope({ signingProvider: sender.signingProvider ?? createEd25519SigningProvider(sender.identity),
      senderAgentId: sender.agentId, recipientAgentId: agentId, type: 'task_handoff', messageId: `handoff-${randomUUID()}`,
      taskId: this.taskId, parentMessageId, request, ...window, content: redactSensitiveData({ objective, acceptanceCriteria }) })
    const action = signAction({ actionId: `message-${randomUUID()}`, agentId: sender.agentId,
      capability: 'agent.message.task_handoff', resource: `agent:${agentId}`, operation: 'send', taskId: this.taskId,
      messageId: envelope.payload.messageId, messageHash: sha256(envelope), ...window }, sender.identity)
    const decision = this.gateway.submit({ grant: sender.grant, action })
    if (decision.status !== 'allowed') throw error(decision.reason ?? 'TEAM_GATEWAY_DENIED')
    const delivered = await this.mailbox.deliver({ envelope, senderGrant: sender.grant, recipientGrant: agent.grant,
      recipient: publicAgent(agent), humanKeys: this.humanKeys })
    if (delivered.status !== 'delivered') throw error(delivered.reason)
    this.#reserved += 2
    const job = { envelope, agent, agentId, sender, parentMessageId, ancestors, assertProposalCurrent, result: deferred(), done: deferred(), slot: false, terminal: false }
    this.#jobs.set(envelope.payload.messageId, job)
    try { this.#assertOpen(); assertProposalCurrent() } catch (failure) {
      await this.#interrupt(job, failure.code ?? 'TEAM_PROPOSAL_INVALID')
      throw failure
    }
    try { await this.#event(envelope, sender.grant, 'sent', decision.actionId) } catch {
      await this.#interrupt(job, 'TEAM_PROJECTION_FAILED')
      return job
    }
    try { this.#assertOpen(); assertProposalCurrent() } catch (failure) {
      await this.#interrupt(job, failure.code ?? 'TEAM_PROPOSAL_INVALID')
      throw failure
    }
    job.timer = setTimeout(() => { void this.#interrupt(job, job.started ? 'TEAM_WAIT_TIMEOUT_OUTCOME_UNKNOWN' : 'TEAM_WAIT_TIMEOUT_QUEUED') }, this.waitMs)
    this.#queue.push(job); this.#pump()
    return job
  }
  #pump() {
    while (!this.#closed && this.#executing < this.maxExecuting) {
      const resume = this.#resumes.shift()
      if (resume) {
        if (!resume.job.terminal) { this.#executing++; resume.job.slot = true }
        resume.resume.resolve(); continue
      }
      const index = this.#queue.findIndex(job => !job.terminal && !this.#busy.has(job.agentId))
      if (index < 0) break
      const [job] = this.#queue.splice(index, 1)
      this.#executing++; job.slot = true; this.#busy.set(job.agentId, job)
      void this.#run(job)
    }
  }
  async #run(job) {
    const messageId = job.envelope.payload.messageId
    try {
      this.#assertOpen()
      if (job.terminal) return
      job.assertProposalCurrent()
      const claimed = await this.mailbox.claim({ agentId: job.agentId, messageId, ownerId: `team:${this.taskId}`, leaseMs: 900000 })
      job.claim = { agentId: job.agentId, messageId, claimToken: claimed.claimToken }
      this.assertJobActive(messageId)
      job.assertProposalCurrent()
      job.started = true
      const input = { envelope: job.envelope, senderGrant: job.sender.grant, sender: publicAgent(job.sender), claimToken: claimed.claimToken }
      const handled = job.agent.processClaim ? await job.agent.processClaim(input) : await job.agent.handle(input)
      job.actionDecision = handled.actionDecision
      if (job.terminal) return
      this.#assertOpen()
      if (handled.status !== 'completed') throw error(handled.reason ?? 'TEAM_RESULT_REJECTED')
      const verification = verifyAgentMessage({ envelope: handled.envelope, senderGrant: job.agent.grant,
        recipientGrant: job.sender.grant, recipient: publicAgent(job.sender), humanKeys: this.humanKeys, now: this.now })
      if (verification.status !== 'accepted' || handled.envelope.payload.parentMessageId !== messageId
        || handled.envelope.payload.taskId !== this.taskId) throw error('TEAM_REPLY_MISMATCH')
      if (!job.agent.processClaim) {
        this.assertJobActive(messageId)
        const completed = await this.mailbox.completeWithReply({ ...job.claim, reply: { envelope: handled.envelope,
          senderGrant: job.agent.grant, recipientGrant: job.sender.grant, recipient: publicAgent(job.sender), humanKeys: this.humanKeys } })
        if (completed.status !== 'completed') throw error(completed.reason)
      }
      // The journal commit decides success. Publish that immutable outcome
      // before optional projection/ack awaits can race timeout or cancellation.
      this.#settle(job, this.#committedOutcome(job))
      await this.#deliverCommittedReply(job)
    } catch (failure) {
      if (job.outcome) job.deliveryReason = 'TEAM_RESULT_DELIVERY_FAILED'
      else if (!job.terminal) await this.#interrupt(job, bounded(failure?.code, 128) ? failure.code : 'TEAM_EXECUTION_FAILED')
    } finally {
      clearTimeout(job.timer)
      if (job.slot) this.#executing--
      job.slot = false; this.#busy.delete(job.agentId); job.done.resolve(); this.#pump()
    }
  }
  #committedOutcome(job) {
    const stored = this.mailbox.completedReply({ agentId: job.agentId, messageId: job.envelope.payload.messageId })
    if (!stored) throw error('TEAM_RESULT_NOT_COMMITTED')
    // Verification at the commit time establishes historical evidence without
    // minting current authority when a timeout observes an expired grant later.
    const verification = verifyAgentMessage({ envelope: stored.envelope, senderGrant: job.agent.grant,
      recipientGrant: job.sender.grant, recipient: publicAgent(job.sender), humanKeys: this.humanKeys,
      now: () => Date.parse(stored.completedAt) })
    const payload = stored.envelope.payload
    if (verification.status !== 'accepted' || payload.taskId !== this.taskId
      || payload.parentMessageId !== job.envelope.payload.messageId) throw error('TEAM_REPLY_MISMATCH')
    return { status: payload.content.status, specialistAgentId: job.agentId, taskId: this.taskId,
      messageId: payload.messageId, parentMessageId: payload.parentMessageId, result: redactSensitiveData(payload.content.result),
      summary: payload.content.summary, attribution: verification.attribution, actionDecision: job.actionDecision ?? null }
  }
  #deliverCommittedReply(job) {
    // Normal return and interruption can both observe the same journal commit.
    // Share one projection/ack attempt; this consumes historical signed evidence
    // and never reopens a claim or calls the worker after cancellation.
    job.replyDelivery ??= Promise.resolve().then(async () => {
      this.#committedOutcome(job)
      const stored = this.mailbox.completedReply({ agentId: job.agentId, messageId: job.envelope.payload.messageId })
      const payload = stored.envelope.payload
      try {
        await this.#event(stored.envelope, job.agent.grant, payload.content.status === 'failed' ? 'failed' : 'completed')
        await this.mailbox.acknowledge({ agentId: job.sender.agentId, messageId: payload.messageId })
      } catch (failure) {
        job.deliveryReason = 'TEAM_RESULT_DELIVERY_FAILED'
        // Persist the transport diagnostic even after the runtime discards its
        // dispatcher. This fences the reply only; the input's signed completion
        // remains immutable and cannot be replayed.
        try { await this.mailbox.interrupt({ agentId: job.sender.agentId, messageId: payload.messageId, reason: job.deliveryReason }) }
        catch { /* Preserve the in-memory diagnostic if the journal also fails. */ }
        throw failure
      }
    })
    return job.replyDelivery
  }
  #settle(job, outcome) {
    if (job.outcome) return
    job.terminal = true; job.outcome = structuredClone(outcome); clearTimeout(job.timer); job.result.resolve(structuredClone(outcome))
  }
  async #interrupt(job, reason) {
    if (job.terminal) return
    // Fence synchronously before awaiting durable interruption. Physical locks
    // remain until #run finally observes executor settlement.
    job.terminal = true
    let outcome = { status: 'failed', specialistAgentId: job.agentId, taskId: this.taskId, messageId: job.envelope.payload.messageId, reason }
    try {
      const terminal = await this.mailbox.interrupt({ agentId: job.agentId, messageId: job.envelope.payload.messageId, reason })
      // Mailbox completion and interruption serialize on the same journal.
      // If completion won, its signed result is known, never outcome-unknown.
      if (terminal.status === 'completed') outcome = this.#committedOutcome(job)
    }
    catch { outcome.durability = 'unknown'; outcome.durabilityReason = 'TEAM_INTERRUPTION_DURABILITY_FAILED' }
    try {
      if (outcome.attribution) await this.#deliverCommittedReply(job)
      else await this.onEvent({ messageId: `status-${randomUUID()}`, parentMessageId: job.envelope.payload.messageId, taskId: this.taskId,
        senderAgentId: job.agentId, recipientAgentId: job.sender.agentId, kind: 'status', content: reason, status: 'failed',
        provenance: { verification: 'derived', source: 'team-dispatcher' } })
    } catch { if (!outcome.attribution) outcome.projectionReason = 'TEAM_PROJECTION_FAILED' }
    finally {
      this.#settle(job, outcome)
      if (!this.#busy.has(job.agentId) || this.#busy.get(job.agentId) !== job) job.done.resolve()
      this.#pump()
    }
  }
  async #event(envelope, grant, status, gatewayActionId) {
    await this.onEvent({ messageId: envelope.payload.messageId, parentMessageId: envelope.payload.parentMessageId,
      taskId: this.taskId, senderAgentId: envelope.sender.agentId, recipientAgentId: envelope.payload.recipientAgentId,
      kind: envelope.payload.type, content: envelope.payload.content.objective ?? envelope.payload.content.result?.summary ?? envelope.payload.content.summary,
      status, provenance: { verification: 'verified', envelopeHash: sha256(envelope), signerAgentId: envelope.sender.agentId,
        grantId: grant.payload.grantId, ...(gatewayActionId ? { gatewayActionId } : {}) } })
  }
  async drain() {
    // Children can be admitted while waiting; repeat until the physical job set
    // is stable. An uncertain effect is never detached to let a new task overlap.
    while (true) {
      await this.#admissions
      const jobs = [...this.#jobs.values()]
      await Promise.all(jobs.flatMap(job => [job.done.promise, job.result.promise]))
      if (jobs.length === this.#jobs.size) return jobs.map(job => structuredClone(job.outcome))
    }
  }
  async close(reason = 'TEAM_TASK_CLOSED') {
    this.#closed = true
    await this.#admissions
    await Promise.all([...this.#jobs.values()].filter(job => !job.terminal).map(job => this.#interrupt(job, reason)))
    for (const resume of this.#resumes.splice(0)) resume.resume.resolve()
    await this.drain()
  }
}
