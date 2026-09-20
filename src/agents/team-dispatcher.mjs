import { randomUUID } from 'node:crypto'
import { createAgentMessageEnvelope, verifyAgentMessage } from '../agent-message.mjs'
import { createEd25519SigningProvider } from '../signing-provider.mjs'
import { signAction } from '../identity.mjs'
import { sha256 } from '../canonical.mjs'
import { redactSensitiveData } from '../security/redaction.mjs'
import { planNodeReadiness, resourcesConflict } from './plan-resources.mjs'

export const PEER_TOOLS = Object.freeze(['agent_send', 'agent_ask', 'agent_reply', 'agent_report_blocker', 'agent_inbox'])
const error = code => Object.assign(new Error(code), { code })
const bounded = (text, limit = 16384) => typeof text === 'string' && text.length > 0 && text.length <= limit
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const publicAgent = agent => ({ agentId: agent.agentId, publicIdentity: agent.signingProvider.publicIdentity() })
const AMBIGUOUS_INTERRUPTION_REASONS = new Set([
  'MODEL_CALL_OUTCOME_UNKNOWN',
  'TEAM_WAIT_TIMEOUT_OUTCOME_UNKNOWN',
  'TEAM_INTERRUPTION_DURABILITY_FAILED',
])
const PLAN_HASH = /^[0-9a-f]{64}$/u
const PLAN_MAX_REVISION = 0x7fffffff

function planError(code) { return Object.assign(new TypeError(code), { code }) }
function isSuccess(status) { return status === 'completed' || status === 'succeeded' }

function normalizeGraphTasks(tasks, eligibleAgentIds) {
  if (!Array.isArray(tasks) || tasks.length < 1 || tasks.length > 8) throw planError('TEAM_PLAN_INVALID')
  const eligible = new Set(eligibleAgentIds)
  const ids = new Set()
  const nodes = tasks.map(task => {
    if (!task || typeof task !== 'object' || Array.isArray(task)
      || typeof task.nodeId !== 'string' || task.nodeId.length < 1 || task.nodeId.length > 128
      || typeof task.specialistAgentId !== 'string' || !eligible.has(task.specialistAgentId)
      || typeof task.objective !== 'string' || task.objective.length < 1 || task.objective.length > 16_384
      || !Array.isArray(task.acceptanceCriteria) || task.acceptanceCriteria.length < 1 || task.acceptanceCriteria.length > 64
      || task.acceptanceCriteria.some(item => typeof item !== 'string' || item.length < 1 || item.length > 4_096)
      || !Array.isArray(task.dependsOn) || task.dependsOn.length > 8
      || task.dependsOn.some(id => typeof id !== 'string' || id.length < 1 || id.length > 128)) {
      throw planError('TEAM_PLAN_INVALID')
    }
    if (ids.has(task.nodeId)) throw planError('TEAM_PLAN_DUPLICATE_NODE')
    ids.add(task.nodeId)
    const dependsOn = [...new Set(task.dependsOn)]
    if (dependsOn.length !== task.dependsOn.length || dependsOn.includes(task.nodeId)) throw planError('TEAM_PLAN_INVALID')
    return structuredClone({ ...task, dependsOn })
  })
  const byId = new Map(nodes.map(node => [node.nodeId, node]))
  const indegree = new Map(nodes.map(node => [node.nodeId, node.dependsOn.length]))
  const dependents = new Map(nodes.map(node => [node.nodeId, []]))
  for (const node of nodes) for (const dependency of node.dependsOn) {
    if (!byId.has(dependency)) throw planError('TEAM_PLAN_MISSING_DEPENDENCY')
    dependents.get(dependency).push(node.nodeId)
  }
  const ready = nodes.filter(node => indegree.get(node.nodeId) === 0).map(node => node.nodeId)
  const order = []
  while (ready.length > 0) {
    const current = ready.shift()
    order.push(current)
    for (const dependent of dependents.get(current)) {
      const remaining = indegree.get(dependent) - 1
      indegree.set(dependent, remaining)
      if (remaining === 0) {
        const position = nodes.findIndex(node => node.nodeId === dependent)
        const insertAt = ready.findIndex(id => nodes.findIndex(node => node.nodeId === id) > position)
        if (insertAt < 0) ready.push(dependent)
        else ready.splice(insertAt, 0, dependent)
      }
    }
  }
  if (order.length !== nodes.length) throw planError('TEAM_PLAN_CYCLE')
  const orderIndex = new Map(order.map((id, index) => [id, index]))
  return nodes.toSorted((left, right) => orderIndex.get(left.nodeId) - orderIndex.get(right.nodeId))
}

function terminalGraphStatus(outcome, blockedDependency = null) {
  if (blockedDependency === 'TEAM_PROJECTION_FAILED') return 'unknown'
  if (blockedDependency) return 'blocked'
  if (outcome?.status === 'unknown' || typeof outcome?.durabilityReason === 'string') return 'unknown'
  if (outcome?.status === 'cancelled' || ['TASK_CANCELLED', 'PROCESS_STOPPED'].includes(outcome?.reason)) return 'cancelled'
  return isSuccess(outcome?.status) ? 'completed' : 'failed'
}

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
  #activePlan = null
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
  assignment(messageId) {
    const job = this.#jobs.get(messageId)
    if (!job) return null
    return {
      taskId: this.taskId,
      nodeId: job.nodeId ?? null,
      assignmentMessageId: job.envelope.payload.messageId,
      canonicalAssignment: job.canonicalAssignment,
      canonicalAssignmentId: job.canonicalAssignmentId,
    }
  }
  async #resolve(agentId) {
    if (!this.#agents.has(agentId)) this.#agents.set(agentId, Promise.resolve().then(() => this.resolveSpecialist(agentId)))
    const agent = await this.#agents.get(agentId)
    this.#assertOpen()
    if (!agent || agent.agentId !== agentId || !agent.grant || !agent.signingProvider) throw error('TEAM_RESOLVER_INVALID')
    return agent
  }
  async delegate({ specialistAgentId, objective, acceptanceCriteria, request = null, nodeId = null, dependsOn = [], requirements = undefined, resources = undefined, parentMessageId = null, assertProposalCurrent = () => {}, onAssignment = async () => {} }) {
    const job = await this.#enqueue({ sender: this.root, agentId: specialistAgentId, objective, acceptanceCriteria, request, nodeId, dependsOn, requirements, resources, parentMessageId, assertProposalCurrent, onAssignment })
    return job.result.promise
  }
  async dispatchPlan({ tasks, planHash, revision, assertProposalCurrent = () => {}, resolveResources, onStep = async () => {} }) {
    this.#assertOpen()
    if (this.#activePlan) throw planError('TEAM_PLAN_ACTIVE')
    if (typeof planHash !== 'string' || !PLAN_HASH.test(planHash)
      || !Number.isSafeInteger(revision) || revision < 1 || revision > PLAN_MAX_REVISION
      || typeof resolveResources !== 'function' || typeof onStep !== 'function') throw planError('TEAM_PLAN_INVALID')
    const normalized = normalizeGraphTasks(tasks, this.eligibleAgentIds)
    const plan = {
      planHash,
      revision,
      tasks: normalized,
      nodes: new Map(normalized.map(node => [node.nodeId, node])),
      jobs: new Map(),
      states: new Map(normalized.map(node => [node.nodeId, 'queued'])),
      results: new Map(),
      resolveResources,
      onStep,
      assertProposalCurrent,
      admissionsComplete: false,
      logicalDone: deferred(),
      logicalDoneResolved: false,
      physicalDone: deferred(),
      physicalDoneResolved: false,
      persistenceFailed: false,
    }
    this.#activePlan = plan
    try {
      plan.assertProposalCurrent()
      for (const node of normalized) {
        plan.assertProposalCurrent()
        await plan.onStep({ taskId: this.taskId, nodeId: node.nodeId, status: 'queued', revision, planHash })
        plan.assertProposalCurrent()
      }
      const admissions = normalized.map(node => this.#enqueue({
        sender: this.root,
        agentId: node.specialistAgentId,
        objective: node.objective,
        acceptanceCriteria: node.acceptanceCriteria,
        request: node.request ?? null,
        nodeId: node.nodeId,
        dependsOn: node.dependsOn,
        requirements: node.requirements,
        resources: node.resources,
        parentMessageId: null,
        assertProposalCurrent: plan.assertProposalCurrent,
        graphPlan: plan,
      }))
      const settledAdmissions = await Promise.allSettled(admissions)
      plan.admissionsComplete = true
      for (let index = 0; index < settledAdmissions.length; index += 1) {
        const outcome = settledAdmissions[index]
        if (outcome.status === 'fulfilled') continue
        const node = normalized[index]
        if (['TASK_PLAN_STALE', 'TASK_CANCELLED', 'TEAM_TASK_CLOSED'].includes(outcome.reason?.code)) {
          await this.#cancelPlan(plan, outcome.reason)
          throw outcome.reason
        }
        const reason = outcome.reason?.code ?? 'TEAM_ADMISSION_FAILED'
        plan.states.set(node.nodeId, 'failed')
        plan.results.set(node.nodeId, { status: 'failed', reason, taskId: this.taskId, nodeId: node.nodeId, specialistAgentId: node.specialistAgentId,
          assignmentMessageId: null, messageId: null, resultId: null })
        try {
          plan.assertProposalCurrent()
          await plan.onStep({ taskId: this.taskId, nodeId: node.nodeId, status: 'failed', messageId: null, resultId: null, reason, revision, planHash })
          plan.assertProposalCurrent()
        } catch {
          plan.persistenceFailed = true
          plan.states.set(node.nodeId, 'unknown')
          plan.results.set(node.nodeId, { ...plan.results.get(node.nodeId), status: 'unknown', reason: 'TEAM_PROJECTION_FAILED' })
        }
      }
      this.#pump()
      return await plan.logicalDone.promise
    } catch (failure) {
      plan.admissionsComplete = true
      plan.persistenceFailed = true
      await this.#cancelPlan(plan, failure)
      throw failure
    }
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
    // A graph node cannot safely suspend on a child whose future effects are
    // unknown. Retain the parent's claim and fail before child delivery.
    if (job.plan && resourcesConflict(job.resourceClaims ?? null, null)) {
      job.waiting = null
      throw error('TEAM_RESOURCE_DEPENDENCY_CYCLE')
    }
    let child
    try {
      child = await this.#enqueue({ sender: job.agent, agentId: args.recipientAgentId, objective: args.objective,
        acceptanceCriteria: args.acceptanceCriteria ?? ['Return evidence or a concrete blocker.'], nodeId: job.nodeId,
        parentMessageId: messageId, assertProposalCurrent })
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
  async #admit({ sender, agentId, objective, acceptanceCriteria, request = null, nodeId = null, dependsOn = [], requirements = undefined, resources = undefined, parentMessageId, assertProposalCurrent = () => {}, onAssignment = async () => {}, graphPlan = null }) {
    this.#assertOpen()
    assertProposalCurrent()
    if (!this.eligibleAgentIds.includes(agentId) || !this.eligible(agentId)) throw error('TEAM_PEER_NOT_ELIGIBLE')
    if (!bounded(objective) || !Array.isArray(acceptanceCriteria) || acceptanceCriteria.length < 1 || acceptanceCriteria.length > 64
      || acceptanceCriteria.some(item => !bounded(item, 4096))) throw error('TEAM_TOOL_ARGUMENT_INVALID')
    if (nodeId !== null && !bounded(nodeId, 128)) throw error('TEAM_NODE_ID_INVALID')
    if (graphPlan && graphPlan.jobs.has(nodeId)) throw planError('TEAM_PLAN_DUPLICATE_NODE')
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
      taskId: this.taskId, nodeId, parentMessageId, request, ...window, content: redactSensitiveData({ objective, acceptanceCriteria }) })
    const action = signAction({ actionId: `message-${randomUUID()}`, agentId: sender.agentId,
      capability: 'agent.message.task_handoff', resource: `agent:${agentId}`, operation: 'send', taskId: this.taskId,
      nodeId, messageId: envelope.payload.messageId, messageHash: sha256(envelope), ...window }, sender.identity)
    const decision = this.gateway.submit({ grant: sender.grant, action })
    if (decision.status !== 'allowed') throw error(decision.reason ?? 'TEAM_GATEWAY_DENIED')
    const delivered = await this.mailbox.deliver({ envelope, senderGrant: sender.grant, recipientGrant: agent.grant,
      recipient: publicAgent(agent), humanKeys: this.humanKeys })
    if (delivered.status !== 'delivered') throw error(delivered.reason)
    this.#reserved += 2
    const job = { envelope, agent, agentId, sender, nodeId, dependsOn, requirements, resources, parentMessageId, ancestors, plan: graphPlan,
      canonicalAssignmentId: parent ? parent.canonicalAssignmentId : envelope.payload.messageId,
      canonicalAssignment: sender.agentId === this.root.agentId, assertProposalCurrent, result: deferred(), done: deferred(), slot: false, terminal: false,
      graphNode: graphPlan?.nodes.get(nodeId) ?? null, resourceClaims: undefined, physicalSettled: false,
      resourceAcquired: false, terminalPersisted: false, logicalTerminal: false, graphReleased: false, graphFinalization: null, graphBlockReason: null, blocking: false }
    this.#jobs.set(envelope.payload.messageId, job)
    if (graphPlan) graphPlan.jobs.set(nodeId, job)
    try { this.#assertOpen(); assertProposalCurrent() } catch (failure) {
      await this.#interrupt(job, failure.code ?? 'TEAM_PROPOSAL_INVALID')
      throw failure
    }
    try { await this.#event(envelope, sender.grant, 'sent', decision.actionId) } catch {
      await this.#interrupt(job, 'TEAM_PROJECTION_FAILED')
      return job
    }
    try {
      if (!graphPlan) await onAssignment({
          taskId: this.taskId,
          nodeId: job.nodeId ?? null,
          assignmentMessageId: job.envelope.payload.messageId,
          canonicalAssignment: job.canonicalAssignment,
          canonicalAssignmentId: job.canonicalAssignmentId,
        })
    } catch (failure) {
      await this.#interrupt(job, bounded(failure?.code, 128) ? failure.code : 'TEAM_ASSIGNMENT_LINK_FAILED')
      throw failure
    }
    try { this.#assertOpen(); assertProposalCurrent() } catch (failure) {
      await this.#interrupt(job, failure.code ?? 'TEAM_PROPOSAL_INVALID')
      throw failure
    }
    if (graphPlan) {
      try { await this.#resolveGraphResources(job) }
      catch (failure) {
        await this.#interrupt(job, bounded(failure?.code, 128) ? failure.code : 'TEAM_RESOURCE_RESOLUTION_FAILED')
        throw failure
      }
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
      const index = this.#queue.findIndex(job => !job.terminal && !job.blocking && !this.#busy.has(job.agentId) && this.#jobReady(job))
      if (index < 0) break
      const [job] = this.#queue.splice(index, 1)
      if (job.plan && job.resourceClaims === undefined) {
        // Resolution is an exclusive boundary. Until the runtime supplies a
        // proven claim, the node is an unknown future effect.
        job.resourceClaims = null
        job.resourceResolving = true
      }
      if (job.plan) job.resourceAcquired = true
      this.#executing++; job.slot = true; this.#busy.set(job.agentId, job)
      void this.#run(job)
    }
  }
  #jobReady(job) {
    if (!job.plan) return !this.#legacyBlockedByGraph()
    if (job.plan.persistenceFailed) return false
    const readiness = planNodeReadiness({
      node: job.graphNode,
      states: job.plan.states,
      heldResources: this.#heldResourcesFor(job),
      claims: job.resourceClaims,
    })
    if (readiness === 'blocked') {
      job.blocking = true
      void this.#blockGraphJob(job)
      return false
    }
    return readiness === 'ready'
  }
  #legacyBlockedByGraph() {
    return Boolean(this.#activePlan && !this.#activePlan.physicalDoneResolved)
  }
  #heldResourcesFor(candidate) {
    const held = []
    for (const job of this.#jobs.values()) {
      if (job === candidate || job.graphReleased) continue
      if (job.plan) {
        if (job.resourceAcquired && job.resourceClaims !== undefined) held.push(job.resourceClaims)
      } else if (!job.physicalSettled && (job.slot || job.claim)) {
        // Legacy/native/harness work has no runtime proof and stays exclusive.
        held.push(null)
      }
    }
    return held
  }
  async #resolveGraphResources(job) {
    if (!job.plan) return
    job.assertProposalCurrent()
    this.#assertOpen()
    const resolved = await job.plan.resolveResources(structuredClone(job.graphNode))
    job.assertProposalCurrent()
    this.#assertOpen()
    job.resourceClaims = resolved === null || resolved === undefined || !Array.isArray(resolved)
      ? null
      : structuredClone(resolved)
    job.resourceResolving = false
    this.#pump()
  }
  async #graphStep(job, status, { messageId = null, resultId = null, reason = null } = {}) {
    const plan = job.plan
    if (!plan) return
    plan.assertProposalCurrent()
    await plan.onStep({ taskId: this.taskId, nodeId: job.nodeId, status, messageId, resultId, reason,
      revision: plan.revision, planHash: plan.planHash })
    plan.assertProposalCurrent()
  }
  #noteGraphOutcome(job, outcome) {
    if (!job.plan || job.plan.results.has(job.nodeId)) return
    const plan = job.plan
    plan.results.set(job.nodeId, structuredClone(outcome))
    plan.states.set(job.nodeId, isSuccess(outcome.status)
      ? 'settling'
      : outcome.status === 'cancelled' ? 'cancelled' : outcome.status === 'unknown' ? 'unknown' : 'failed')
    this.#pump()
    this.#maybeResolvePlan(plan)
  }
  async #finalizeGraphJob(job) {
    if (!job.plan || job.terminalPersisted) return
    if (job.graphFinalization) return job.graphFinalization
    job.graphFinalization = (async () => {
      const plan = job.plan
      const outcome = job.outcome ?? { status: 'failed', reason: 'TEAM_EXECUTION_FAILED' }
      const status = terminalGraphStatus(outcome, job.graphBlockReason)
      const result = job.graphBlockReason === 'TEAM_PROJECTION_FAILED'
        ? { status: 'unknown', reason: 'TEAM_PROJECTION_FAILED', taskId: this.taskId, nodeId: job.nodeId, specialistAgentId: job.agentId }
        : job.graphBlockReason
          ? { status: 'blocked', reason: 'TASK_DEPENDENCY_NOT_COMPLETED', dependency: job.graphBlockReason,
            taskId: this.taskId, nodeId: job.nodeId, specialistAgentId: job.agentId }
          : structuredClone(outcome)
      try {
        await this.#graphStep(job, status, {
          messageId: outcome.assignmentMessageId ?? outcome.messageId ?? job.envelope.payload.messageId,
          resultId: outcome.resultId ?? null,
          reason: job.graphBlockReason ?? outcome.reason ?? null,
        })
        job.terminalPersisted = true
        job.logicalTerminal = true
        plan.states.set(job.nodeId, status)
        plan.results.set(job.nodeId, result)
      } catch {
        // A logical result is not enough to release a claim. Stop further graph
        // admissions when the canonical terminal projection cannot persist.
        plan.persistenceFailed = true
        job.logicalTerminal = true
        plan.states.set(job.nodeId, 'unknown')
        plan.results.set(job.nodeId, { ...structuredClone(result), status: 'unknown', reason: 'TEAM_PROJECTION_FAILED' })
        await this.#cancelQueuedGraphJobs(plan)
      }
      this.#maybeReleaseGraphJob(job)
      this.#maybeResolvePlan(plan)
      this.#pump()
    })()
    return job.graphFinalization
  }
  #maybeReleaseGraphJob(job) {
    if (!job.plan || job.graphReleased || !job.physicalSettled || !job.terminalPersisted) return
    job.graphReleased = true
    this.#maybeFinishPlan(job.plan)
    this.#pump()
  }
  #maybeResolvePlan(plan) {
    if (plan.logicalDoneResolved || !plan.admissionsComplete) return
    if (plan.tasks.some(node => !plan.results.has(node.nodeId))) return
    if ([...plan.jobs.values()].some(job => !job.logicalTerminal)) return
    plan.logicalDoneResolved = true
    plan.logicalDone.resolve(plan.tasks.map(node => structuredClone(plan.results.get(node.nodeId))))
  }
  #maybeFinishPlan(plan) {
    if (plan.physicalDoneResolved || !plan.admissionsComplete) return
    if ([...plan.jobs.values()].some(job => !job.graphReleased)) return
    if (plan.tasks.some(node => !plan.results.has(node.nodeId))) return
    plan.physicalDoneResolved = true
    if (this.#activePlan === plan) this.#activePlan = null
    plan.physicalDone.resolve()
  }
  async #blockGraphJob(job) {
    if (job.terminal || job.graphFinalization) return
    const dependency = job.graphNode.dependsOn.find(id => ['blocked', 'failed', 'cancelled', 'unknown'].includes(job.plan.states.get(id)))
    if (!dependency) { job.blocking = false; this.#pump(); return }
    job.graphBlockReason = dependency
    await this.#interrupt(job, 'TASK_DEPENDENCY_NOT_COMPLETED')
  }
  async #cancelQueuedGraphJobs(plan) {
    const pending = [...plan.jobs.values()].filter(job => !job.terminal && !job.slot)
    for (const job of pending) job.graphBlockReason = 'TEAM_PROJECTION_FAILED'
    await Promise.all(pending.map(job => this.#interrupt(job, 'TEAM_PROJECTION_FAILED')))
  }
  async #cancelPlan(plan, failure) {
    await Promise.all([...plan.jobs.values()].filter(job => !job.terminal).map(job => this.#interrupt(job, failure?.code ?? 'TEAM_TASK_CLOSED')))
    plan.admissionsComplete = true
    // A queued-step journal failure can happen before any mailbox admission.
    // There is then no physical or logical effect to retain, so release only
    // this empty plan; admitted/in-flight plans still use the normal barriers.
    if (plan.jobs.size === 0 && plan.results.size === 0) {
      plan.logicalDoneResolved = true
      plan.logicalDone.resolve([])
      plan.physicalDoneResolved = true
      plan.physicalDone.resolve()
      if (this.#activePlan === plan) this.#activePlan = null
      return
    }
    this.#maybeResolvePlan(plan)
    this.#maybeFinishPlan(plan)
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
      if (job.plan && job.resourceClaims === undefined) {
        try {
          await this.#resolveGraphResources(job)
          this.assertJobActive(messageId)
          job.assertProposalCurrent()
        } catch (failure) {
          if (!job.terminal) await this.#interrupt(job, bounded(failure?.code, 128) ? failure.code : 'TEAM_RESOURCE_RESOLUTION_FAILED')
          return
        }
      }
      if (job.plan) {
        try {
          await this.#graphStep(job, 'running', { messageId })
          this.assertJobActive(messageId)
          job.assertProposalCurrent()
        } catch (failure) {
          // A canonical running transition is itself a durability boundary.
          // If it rejects, fail closed before #interrupt can pump a sibling;
          // no later graph node may execute against an unrecorded step.
          job.plan.persistenceFailed = true
          job.graphBlockReason = 'TEAM_PROJECTION_FAILED'
          if (!job.terminal) await this.#interrupt(job, bounded(failure?.code, 128) ? failure.code : 'TEAM_PROJECTION_FAILED')
          await this.#cancelQueuedGraphJobs(job.plan)
          return
        }
      }
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
        || handled.envelope.payload.taskId !== this.taskId
        || (handled.envelope.payload.nodeId ?? null) !== (job.nodeId ?? null)) throw error('TEAM_REPLY_MISMATCH')
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
      // The body may return after a timeout fenced the job but before the
      // interruption journal has settled. Keep the physical slot/agent lock
      // until that persistence boundary is complete.
      if (job.interruptionPersistence) {
        await job.interruptionPersistence.catch(() => {})
        if (!job.outcome && job.pendingInterruptionOutcome) this.#settle(job, job.pendingInterruptionOutcome)
      }
      if (job.slot) this.#executing--
      job.slot = false; this.#busy.delete(job.agentId)
      job.physicalSettled = true
      if (job.plan) {
        try { await this.#finalizeGraphJob(job) } catch { job.plan.persistenceFailed = true }
      }
      this.#maybeReleaseGraphJob(job)
      job.done.resolve(); this.#pump()
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
      || payload.parentMessageId !== job.envelope.payload.messageId
      || (payload.nodeId ?? null) !== (job.nodeId ?? null)) throw error('TEAM_REPLY_MISMATCH')
    return { status: payload.content.status, specialistAgentId: job.agentId, taskId: this.taskId,
      nodeId: job.nodeId ?? null, assignmentMessageId: job.envelope.payload.messageId,
      messageId: payload.messageId, resultId: payload.messageId, parentMessageId: payload.parentMessageId,
      canonicalAssignmentId: job.canonicalAssignmentId,
      canonicalAssignment: job.canonicalAssignment, result: redactSensitiveData(payload.content.result),
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
    this.#noteGraphOutcome(job, job.outcome)
  }
  async #interrupt(job, reason) {
    if (job.terminal) {
      if (job.interruptionPersistence) await job.interruptionPersistence.catch(() => {})
      return
    }
    // Fence synchronously before awaiting durable interruption. Physical locks
    // remain until #run finally observes executor settlement.
    job.terminal = true
    const ambiguous = job.started && AMBIGUOUS_INTERRUPTION_REASONS.has(reason)
    let outcome = { status: ambiguous ? 'unknown' : 'failed', specialistAgentId: job.agentId, taskId: this.taskId, nodeId: job.nodeId ?? null,
      assignmentMessageId: job.envelope.payload.messageId, canonicalAssignment: job.canonicalAssignment,
      messageId: null, resultId: null, reason,
      ...(job.canonicalAssignmentId ? { canonicalAssignmentId: job.canonicalAssignmentId } : {}),
    }
    job.interruptionPersistence = (async () => {
      try {
        const terminal = await this.mailbox.interrupt({ agentId: job.agentId, messageId: job.envelope.payload.messageId, reason })
        // Mailbox completion and interruption serialize on the same journal.
        // If completion won, its signed result is known, never outcome-unknown.
        if (terminal.status === 'completed') outcome = this.#committedOutcome(job)
      } catch {
        outcome.status = 'unknown'
        outcome.durability = 'unknown'
        outcome.durabilityReason = 'TEAM_INTERRUPTION_DURABILITY_FAILED'
      }
      try {
        if (outcome.attribution) await this.#deliverCommittedReply(job)
        else await this.onEvent({ messageId: `status-${randomUUID()}`, parentMessageId: job.envelope.payload.messageId, taskId: this.taskId,
          nodeId: job.nodeId ?? null,
          senderAgentId: job.agentId, recipientAgentId: job.sender.agentId, kind: 'status', content: reason, status: outcome.status,
          provenance: { verification: 'derived', source: 'team-dispatcher' } })
      } catch { if (!outcome.attribution) outcome.projectionReason = 'TEAM_PROJECTION_FAILED' }
      job.pendingInterruptionOutcome = outcome
      return outcome
    })()
    const persisted = await job.interruptionPersistence
    this.#settle(job, persisted)
    if (job.plan) {
      try { await this.#finalizeGraphJob(job) } catch { job.plan.persistenceFailed = true }
    }
    if (!this.#busy.has(job.agentId) || this.#busy.get(job.agentId) !== job) {
      job.physicalSettled = true
      this.#maybeReleaseGraphJob(job)
      job.done.resolve()
    }
    this.#pump()
  }
  async #event(envelope, grant, status, gatewayActionId) {
    await this.onEvent({ messageId: envelope.payload.messageId, parentMessageId: envelope.payload.parentMessageId,
      taskId: this.taskId, nodeId: envelope.payload.nodeId ?? null, senderAgentId: envelope.sender.agentId, recipientAgentId: envelope.payload.recipientAgentId,
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
