import crypto from 'node:crypto'
import { createAgentMessageEnvelope, verifyAgentMessage } from '../agent-message.mjs'
import { sha256 } from '../canonical.mjs'
import { signAction } from '../identity.mjs'
import { evaluatePolicy } from '../policy.mjs'
import { createEd25519SigningProvider } from '../signing-provider.mjs'
import { createActivityProjection } from './activity-projection.mjs'
import { validateModelRouter } from './model-router.mjs'
import { TASK_PLAN_SCHEMA, normalizeTaskPlan } from './task-plan.mjs'

function isRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
}

function boundedString(value, maximum = 16_384) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function containedWindow(grants, now, lifetimeMs = 15 * 60_000) {
  const issuedAt = Math.max(now - 1_000, ...grants.map((grant) => Date.parse(grant.payload.issuedAt)))
  const expiresAt = Math.min(now + lifetimeMs, ...grants.map((grant) => Date.parse(grant.payload.expiresAt)))
  if (issuedAt >= expiresAt) throw new Error('NO_SHARED_ACTIVE_GRANT_WINDOW')
  return {
    issuedAt: new Date(issuedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
  }
}

function validateTask(task) {
  if (!isRecord(task)
    || !boundedString(task.specialistAgentId, 256)
    || !boundedString(task.objective)
    || !Array.isArray(task.acceptanceCriteria)
    || task.acceptanceCriteria.length === 0
    || task.acceptanceCriteria.length > 64
    || task.acceptanceCriteria.some((item) => !boundedString(item, 4096))
    || (task.request !== null && task.request !== undefined && (!isRecord(task.request)
      || !boundedString(task.request.capability, 128)
      || !boundedString(task.request.resource, 2048)
      || !boundedString(task.request.operation, 128)))) {
    throw new TypeError('model router returned an invalid specialist task')
  }
  return task
}

function validatePlan(plan, eligibleAgentIds) {
  try {
    return normalizeTaskPlan(plan, { eligibleAgentIds })
  } catch (error) {
    if (error?.code) throw error
    throw new TypeError('model router returned an invalid task plan')
  }
}

function validateSynthesis(synthesis) {
  if (!isRecord(synthesis) || !boundedString(synthesis.summary)) {
    throw new TypeError('model router returned an invalid synthesis')
  }
  if (synthesis.decision !== undefined) {
    const decision = synthesis.decision
    if (!isRecord(decision)
      || !boundedString(decision.capability, 128)
      || !boundedString(decision.resource, 2048)
      || !boundedString(decision.operation, 128)
      || !isRecord(decision.actionDiff)
      || !boundedString(decision.rationale, 2048)) {
      throw new TypeError('model router returned an invalid decision request')
    }
  }
  return synthesis
}

export class CeoWorkspace {
  constructor({
    agentId = 'ceo',
    identity,
    grant,
    gateway,
    audit,
    humanKeys,
    modelRouter,
    decisionService = null,
    specialistRouteCandidates = null,
    decisions,
    specialists = [],
    specialistCatalog = [],
    resolveSpecialist = null,
    dispatchTask = null,
    dispatchPlan = null,
    resolveResources = null,
    drainTasks = null,
    assertActive = () => {},
    getSteering = () => [],
    onCheckpoint = async () => {},
    agentContext = null,
    taskContext = null,
    onPlan = async () => {},
    onStep = async () => {},
    browserSurface,
    onAgentMessage = async () => {},
    now = () => Date.now(),
  }) {
    if (!boundedString(agentId, 256)
      || !identity?.privateKey
      || !grant
      || !gateway
      || !audit
      || !decisions
      || typeof onAgentMessage !== 'function'
      || typeof onPlan !== 'function'
      || typeof onStep !== 'function') {
      throw new TypeError('CEO workspace requires identity, grant, gateway, audit, and decisions')
    }
    this.agentId = agentId
    this.identity = identity
    this.signingProvider = createEd25519SigningProvider(identity)
    this.grant = grant
    this.gateway = gateway
    this.audit = audit
    this.humanKeys = new Map(humanKeys)
    this.modelRouter = validateModelRouter(modelRouter)
    this.decisionService = decisionService
    this.specialistRouteCandidates = specialistRouteCandidates
    this.decisions = decisions
    this.specialists = new Map(specialists.map((specialist) => [specialist.agentId, specialist]))
    this.specialistCatalog = new Map(specialistCatalog.map((manifest) => [manifest.agentId, structuredClone(manifest)]))
    this.resolveSpecialist = resolveSpecialist
    this.dispatchTask = dispatchTask
    this.dispatchPlan = dispatchPlan
    this.resolveResources = resolveResources
    this.drainTasks = drainTasks
    this.assertActive = assertActive
    this.getSteering = getSteering
    this.onCheckpoint = onCheckpoint
    this.agentContext = agentContext ? structuredClone(agentContext) : null
    this.taskContext = taskContext ? structuredClone(taskContext) : null
    this.onPlan = onPlan
    this.onStep = onStep
    this.browserSurface = browserSurface
    this.onAgentMessage = onAgentMessage
    this.now = now
    this.audit.append({
      kind: 'delegation.grant.registered',
      agentId,
      grantId: grant.payload.grantId,
      humanId: grant.payload.humanId,
      at: new Date(now()).toISOString(),
    })
    for (const specialist of specialists) {
      this.audit.append({
        kind: 'delegation.grant.registered',
        agentId: specialist.agentId,
        grantId: specialist.grant.payload.grantId,
        humanId: specialist.grant.payload.humanId,
        at: new Date(now()).toISOString(),
      })
    }
  }

  async receive({ envelope, senderGrant }) {
    this.assertActive()
    const verification = verifyAgentMessage({
      envelope,
      senderGrant,
      recipientGrant: this.grant,
      recipient: {
        agentId: this.agentId,
        publicIdentity: this.signingProvider.publicIdentity(),
      },
      humanKeys: this.humanKeys,
      now: this.now,
    })
    this.#recordReceived(envelope, verification)
    if (verification.status !== 'accepted') return verification
    if (!['direct_message', 'task_handoff'].includes(envelope.payload.type)) {
      return { status: 'accepted', messageId: envelope.payload.messageId, ignored: true }
    }

    const taskPrompt = envelope.payload.type === 'direct_message'
      ? envelope.payload.content.text
      : envelope.payload.content.objective
    const requestedSpecialistAgentId = envelope.payload.type === 'direct_message'
      ? envelope.payload.content.requestedSpecialistAgentId ?? null
      : null
    if (requestedSpecialistAgentId !== null
      && (!boundedString(requestedSpecialistAgentId, 256) || !this.#availableSpecialists().includes(requestedSpecialistAgentId))) {
      throw Object.assign(new Error('TARGET_SPECIALIST_INVALID'), { code: 'TARGET_SPECIALIST_INVALID' })
    }
    await this.onCheckpoint({ stage: 'planning', summary: 'RJ is planning the next bounded task.' })
    const proposal = await this.#route(taskPrompt, {
      stage: 'decompose',
      taskId: envelope.payload.taskId,
      sourceMessageId: envelope.payload.messageId,
      ...(requestedSpecialistAgentId ? { requestedSpecialistAgentId } : {}),
      ...(this.agentContext ? { agentContinuity: structuredClone(this.agentContext) } : {}),
      ...(this.taskContext ? structuredClone(this.taskContext) : {}),
      availableSpecialists: this.#availableSpecialists(),
      specialistCatalog: this.#availableSpecialists().map((agentId) => {
        const manifest = this.specialistCatalog.get(agentId)
        return manifest ? {
          agentId,
          displayName: manifest.displayName,
          role: manifest.role,
          capabilities: manifest.capabilities,
        } : { agentId }
      }),
    }, { captureProposal: true })
    // Capture the model's identity mode before normalization assigns legacy
    // step-N IDs. Only plans that were explicitly fully identified may enter
    // the dependency/resource scheduler; omission remains the sequential A2A
    // compatibility path.
    const proposedTasks = proposal.result?.tasks
    const explicitGraph = Array.isArray(proposedTasks) && proposedTasks.length > 0
      && proposedTasks.every(task => isRecord(task) && typeof task.nodeId === 'string' && task.nodeId.length > 0)
    const plan = validatePlan(proposal.result, this.#availableSpecialists())
    const { assertProposalCurrent } = proposal
    this.assertActive()
    if (plan.tasks.some((task) => !this.#availableSpecialists().includes(task.specialistAgentId))) {
      throw Object.assign(new Error('SPECIALIST_NOT_REGISTERED'), { code: 'SPECIALIST_NOT_REGISTERED' })
    }
    if (requestedSpecialistAgentId
      && plan.tasks.some((task) => task.specialistAgentId !== requestedSpecialistAgentId)) {
      throw Object.assign(new Error('TARGET_SPECIALIST_MISMATCH'), { code: 'TARGET_SPECIALIST_MISMATCH' })
    }
    if (this.decisionService && !requestedSpecialistAgentId) {
      const available = this.#availableSpecialists()
      const candidates = this.specialistRouteCandidates === null ? available
        : available.filter(agentId => this.specialistRouteCandidates.includes(agentId))
      if (candidates.length > 1 && candidates.length <= 8) {
        const criteria = Object.fromEntries(candidates.map((agentId, index) => {
          const manifest = this.specialistCatalog.get(agentId)
          return [`agent${index}`, `${agentId}; role: ${manifest?.role ?? 'specialist'}; capabilities: ${(manifest?.capabilities ?? []).join(', ')}`.slice(0, 512)]
        }))
        for (const task of plan.tasks) {
          assertProposalCurrent()
          // An exact request or declared resource can be tied to the planned
          // specialist's grant, so only unbound assignments may be rerouted.
          if (task.request || task.resources) continue
          try {
            const answer = await this.decisionService.choose({
              state: JSON.stringify({ objective: task.objective.slice(0, 4000),
                acceptanceCriteria: task.acceptanceCriteria.slice(0, 8).map(item => item.slice(0, 256)),
                plannedSpecialist: task.specialistAgentId }),
              criteria, taskId: envelope.payload.taskId, use: 'specialist-route',
            })
            const index = answer ? Number(answer.choice.slice(5)) : -1
            if (answer && Number.isInteger(index) && answer.choice === `agent${index}` && candidates[index]) {
              const previousAgentId = task.specialistAgentId
              task.specialistAgentId = candidates[index]
              this.audit.append({ kind: 'jev.specialist.selected', taskId: envelope.payload.taskId,
                previousAgentId, agentId: task.specialistAgentId, confidence: answer.confidence,
                at: new Date(this.now()).toISOString() })
            }
          } catch (error) {
            this.audit.append({ kind: 'jev.decision.fallback', use: 'specialist-route',
              taskId: envelope.payload.taskId,
              reason: boundedString(error?.code, 128) ? error.code : 'JEV_UNAVAILABLE',
              at: new Date(this.now()).toISOString() })
          }
          assertProposalCurrent()
        }
      }
    }
    await this.onPlan(structuredClone(plan), assertProposalCurrent)
    this.audit.append({
      kind: 'ceo.task.decomposed',
      taskId: envelope.payload.taskId,
      agentId: this.agentId,
      routerId: this.modelRouter.routerId,
      specialistCount: plan.tasks.length,
      at: new Date(this.now()).toISOString(),
    })

    let results = []
    const resultsByNode = new Map()
    if (explicitGraph && this.dispatchPlan) {
      assertProposalCurrent()
      results = await this.dispatchPlan({
        taskId: envelope.payload.taskId,
        tasks: plan.tasks,
        planHash: sha256({ schema: TASK_PLAN_SCHEMA, tasks: plan.tasks }),
        revision: 1,
        assertProposalCurrent,
        resolveResources: this.resolveResources ?? (async () => null),
        onStep: this.onStep,
      })
    } else for (const [index, task] of plan.tasks.entries()) {
      assertProposalCurrent()
      const unmetDependency = task.dependsOn.find((dependency) => {
        const dependencyResult = resultsByNode.get(dependency)
        return !dependencyResult || !['completed', 'succeeded'].includes(dependencyResult.status)
      })
      if (unmetDependency) {
        const blocked = {
          status: 'blocked',
          reason: 'TASK_DEPENDENCY_NOT_COMPLETED',
          dependency: unmetDependency,
          taskId: envelope.payload.taskId,
          nodeId: task.nodeId,
          specialistAgentId: task.specialistAgentId,
        }
        await this.onStep({ taskId: envelope.payload.taskId, nodeId: task.nodeId, status: 'blocked', reason: unmetDependency })
        results.push(blocked)
        resultsByNode.set(task.nodeId, blocked)
        continue
      }
      const result = await this.delegateTask({
        ...task,
        taskId: this.dispatchTask ? envelope.payload.taskId : `${envelope.payload.taskId}:${index + 1}`,
        parentMessageId: envelope.payload.messageId,
        assertProposalCurrent,
      })
      results.push(result)
      resultsByNode.set(task.nodeId, result)
    }

    if (this.drainTasks) {
      const delivered = await this.drainTasks()
      for (const result of delivered) {
        // Peer jobs may inherit the root/node provenance for signed evidence.
        // They remain evidence for RJ synthesis, but only the canonical CEO
        // assignment is allowed to drive this plan step's durable state.
        if (!results.some(existing => existing.messageId === result.messageId)) results.push(result)
      }
    }

    const synthesis = validateSynthesis(await this.#route(
      `Synthesize ${results.length} bounded specialist result(s) for task ${envelope.payload.taskId}.`,
      {
        stage: 'synthesize',
        taskId: envelope.payload.taskId,
        results: structuredClone(results),
        ...(this.agentContext ? { agentContinuity: structuredClone(this.agentContext) } : {}),
        ...(this.taskContext ? structuredClone(this.taskContext) : {}),
      },
    ))
    this.assertActive()
    this.audit.append({
      kind: 'ceo.synthesis.completed',
      taskId: envelope.payload.taskId,
      agentId: this.agentId,
      routerId: this.modelRouter.routerId,
      resultCount: results.length,
      summary: synthesis.summary,
      at: new Date(this.now()).toISOString(),
    })

    const decision = synthesis.decision
      ? await this.requestAction({
        capability: synthesis.decision.capability,
        resource: synthesis.decision.resource,
        operation: synthesis.decision.operation,
        actionDiff: synthesis.decision.actionDiff,
        rationale: synthesis.decision.rationale,
        title: synthesis.decision.title,
        detail: synthesis.decision.detail,
        taskId: envelope.payload.taskId,
        // The synthesis model cannot select a plan node. CEO synthesis is a
        // root-task decision unless a future trusted node owner invokes it.
        nodeId: null,
      })
      : null
    return {
      status: 'completed',
      taskId: envelope.payload.taskId,
      plan: structuredClone(plan),
      results,
      synthesis: structuredClone(synthesis),
      decision,
    }
  }

  async delegateTask({
    specialistAgentId,
    objective,
    acceptanceCriteria,
    request = null,
    nodeId = null,
    dependsOn = [],
    requirements = undefined,
    resources = undefined,
    taskId,
    parentMessageId = null,
    assertProposalCurrent = () => {},
  }) {
    this.assertActive()
    assertProposalCurrent()
    if (this.dispatchTask) {
      await this.onCheckpoint({ stage: 'delegating', agentId: specialistAgentId, summary: objective })
      assertProposalCurrent()
      let assignmentMessageId = null
      let canonicalAssignmentId = null
      let result
      try {
        result = await this.dispatchTask({ specialistAgentId, objective, acceptanceCriteria, request, nodeId, dependsOn, requirements, resources, taskId, parentMessageId, assertProposalCurrent,
          onAssignment: async ({ assignmentMessageId: messageId, canonicalAssignmentId: canonicalId }) => {
            assignmentMessageId = messageId ?? null
            canonicalAssignmentId = canonicalId ?? assignmentMessageId
            await this.onStep({ taskId, nodeId, status: 'running', messageId: assignmentMessageId })
            assertProposalCurrent()
          } })
      } catch (failure) {
        // A signed handoff was admitted before the dispatcher can reject or
        // lose a later boundary. Never leave its canonical node running.
        if (assignmentMessageId !== null) {
          const reason = failure?.code ?? 'SPECIALIST_DISPATCH_FAILED'
          const unknown = ['MODEL_CALL_OUTCOME_UNKNOWN', 'TEAM_WAIT_TIMEOUT_OUTCOME_UNKNOWN', 'TEAM_INTERRUPTION_DURABILITY_FAILED'].includes(reason)
          await this.onStep({ taskId, nodeId, status: unknown ? 'unknown' : 'failed', messageId: canonicalAssignmentId ?? assignmentMessageId, resultId: null, reason })
        }
        throw failure
      }
      const propagateFailure = result.reason?.startsWith('AGENT_LOOP_') || result.reason === 'TASK_PLAN_STALE'
      await this.onStep({
        taskId,
        nodeId,
        status: result.status === 'completed' || result.status === 'succeeded' ? 'completed'
          : result.status === 'unknown'
            || result.reason === 'TEAM_WAIT_TIMEOUT_OUTCOME_UNKNOWN'
            || result.reason === 'TEAM_INTERRUPTION_DURABILITY_FAILED'
            || result.reason === 'MODEL_CALL_OUTCOME_UNKNOWN'
            || result.durability === 'unknown'
            || typeof result.durabilityReason === 'string' ? 'unknown'
            : result.status === 'blocked' ? 'blocked' : 'failed',
        messageId: result.assignmentMessageId ?? result.messageId ?? null,
        // The handoff is an assignment identity, never a signed result.
        resultId: result.resultId ?? null,
        reason: result.reason ?? null,
      })
      if (propagateFailure) throw Object.assign(new Error(result.reason), { code: result.reason })
      if (result.attribution) await this.onCheckpoint({ stage: 'specialist-completed', agentId: specialistAgentId,
        summary: result.summary, effectOutcome: result.status, result: result.result })
      return result
    }
    if (!this.#availableSpecialists().includes(specialistAgentId)) return { status: 'rejected', reason: 'SPECIALIST_NOT_REGISTERED', specialistAgentId }
    let specialist = this.specialists.get(specialistAgentId)
    if (!specialist && this.resolveSpecialist) {
      specialist = await this.resolveSpecialist(specialistAgentId)
      this.assertActive()
      assertProposalCurrent()
      if (specialist?.agentId !== specialistAgentId || !specialist?.grant || typeof specialist.handle !== 'function') throw new TypeError('SPECIALIST_RESOLVER_INVALID')
      this.specialists.set(specialistAgentId, specialist)
      this.audit.append({ kind: 'delegation.grant.registered', agentId: specialist.agentId,
        grantId: specialist.grant.payload.grantId, humanId: specialist.grant.payload.humanId, at: new Date(this.now()).toISOString() })
    }
    if (!specialist) return { status: 'rejected', reason: 'SPECIALIST_NOT_REGISTERED', specialistAgentId }
    await this.onCheckpoint({ stage: 'delegating', agentId: specialistAgentId, summary: objective })
    this.assertActive()
    assertProposalCurrent()
    const window = containedWindow([this.grant, specialist.grant], this.now())
    const envelope = createAgentMessageEnvelope({
      signingProvider: this.signingProvider,
      senderAgentId: this.agentId,
      recipientAgentId: specialistAgentId,
      messageId: `handoff-${crypto.randomUUID()}`,
      type: 'task_handoff',
      taskId,
      nodeId,
      parentMessageId,
      ...window,
      request,
      content: { objective, acceptanceCriteria },
    })
    const messageAction = signAction({
      actionId: `message-${crypto.randomUUID()}`,
      agentId: this.agentId,
      capability: 'agent.message.task_handoff',
      resource: `agent:${specialistAgentId}`,
      operation: 'send',
      messageId: envelope.payload.messageId,
      messageHash: sha256(envelope),
      taskId,
      nodeId,
      ...window,
    }, this.identity)
    const messageDecision = this.gateway.submit({ grant: this.grant, action: messageAction })
    if (messageDecision.status !== 'allowed') {
      // The model never owns this gateway decision. The canonical node was
      // admitted to the durable plan, so a direct denial must still leave an
      // explicit terminal step rather than a queued row that synthesis can
      // accidentally treat as unattempted work.
      await this.onStep({
        taskId,
        nodeId,
        status: 'blocked',
        messageId: null,
        resultId: null,
        reason: messageDecision.reason ?? 'MESSAGE_GATEWAY_DENIED',
      })
      return {
        status: 'rejected',
        reason: messageDecision.reason ?? 'MESSAGE_GATEWAY_DENIED',
        specialistAgentId,
        messageDecision,
      }
    }
    // The assignment is now signed and durably accepted by the gateway. Link
    // that exact handoff before invoking the specialist; it is not a result
    // identifier and must never be substituted for one.
    await this.onStep({ taskId, nodeId, status: 'running', messageId: envelope.payload.messageId })
    let stepTerminalRecorded = false
    try {
      assertProposalCurrent()
      this.audit.append({
      kind: 'agent.message.sent',
      messageId: envelope.payload.messageId,
      taskId,
      senderAgentId: this.agentId,
      recipientAgentId: specialistAgentId,
      messageType: 'task_handoff',
      grantId: this.grant.payload.grantId,
      gatewayActionId: messageDecision.actionId,
      at: new Date(this.now()).toISOString(),
      })
      await this.onAgentMessage({
      messageId: envelope.payload.messageId,
      taskId,
      senderAgentId: this.agentId,
      recipientAgentId: specialistAgentId,
      kind: 'task_handoff',
      content: objective,
      status: 'sent',
      provenance: {
        verification: 'verified',
        envelopeHash: sha256(envelope),
        signerAgentId: this.agentId,
        grantId: this.grant.payload.grantId,
        gatewayActionId: messageDecision.actionId,
      },
      })
      assertProposalCurrent()
      const handled = await specialist.handle({
      envelope,
      senderGrant: this.grant,
      sender: { agentId: this.agentId, publicIdentity: this.signingProvider.publicIdentity() },
      })
      this.assertActive()
      if (handled.status !== 'completed') {
        const unknown = handled.status === 'unknown' || ['MODEL_CALL_OUTCOME_UNKNOWN', 'TEAM_INTERRUPTION_DURABILITY_FAILED'].includes(handled.reason)
        await this.onStep({ taskId, nodeId, status: unknown ? 'unknown' : 'failed', messageId: envelope.payload.messageId, resultId: null, reason: handled.reason ?? 'SPECIALIST_HANDOFF_FAILED' })
        stepTerminalRecorded = true
        return handled
      }

      const resultVerification = verifyAgentMessage({
      envelope: handled.envelope,
      senderGrant: specialist.grant,
      recipientGrant: this.grant,
      recipient: {
        agentId: this.agentId,
        publicIdentity: this.signingProvider.publicIdentity(),
      },
      humanKeys: this.humanKeys,
      now: this.now,
      })
      this.#recordReceived(handled.envelope, resultVerification)
      if (resultVerification.status !== 'accepted') {
        await this.onStep({ taskId, nodeId, status: 'unknown', messageId: envelope.payload.messageId, resultId: null, reason: resultVerification.reason ?? 'SPECIALIST_RESULT_UNVERIFIED' })
        stepTerminalRecorded = true
        return resultVerification
      }
      if ((resultVerification.nodeId ?? null) !== (nodeId ?? null)
      || resultVerification.taskId !== taskId
      || handled.envelope.payload.parentMessageId !== envelope.payload.messageId) {
        await this.onStep({ taskId, nodeId, status: 'unknown', messageId: envelope.payload.messageId, resultId: null, reason: 'SPECIALIST_RESULT_ASSIGNMENT_MISMATCH' })
        stepTerminalRecorded = true
        return { status: 'rejected', reason: 'SPECIALIST_RESULT_ASSIGNMENT_MISMATCH', taskId, nodeId }
      }
      await this.onAgentMessage({
      messageId: handled.envelope.payload.messageId,
      parentMessageId: handled.envelope.payload.parentMessageId,
      taskId,
      senderAgentId: specialistAgentId,
      recipientAgentId: this.agentId,
      kind: 'structured_result',
      content: handled.envelope.payload.content.result?.summary ?? handled.envelope.payload.content.summary,
      status: handled.envelope.payload.content.status === 'failed' ? 'failed' : 'completed',
      provenance: {
        verification: 'verified',
        envelopeHash: sha256(handled.envelope),
        signerAgentId: specialistAgentId,
        grantId: specialist.grant.payload.grantId,
      },
      })
      await this.onCheckpoint({ stage: 'specialist-completed', agentId: specialistAgentId, summary: handled.envelope.payload.content.summary, effectOutcome: handled.envelope.payload.content.status,
        result: handled.envelope.payload.content.result })
      await this.onStep({
      taskId,
      nodeId,
      status: handled.envelope.payload.content.status === 'succeeded' || handled.envelope.payload.content.status === 'completed' ? 'completed' : 'failed',
      messageId: envelope.payload.messageId,
      resultId: handled.envelope.payload.messageId,
        reason: handled.envelope.payload.content.status === 'failed' ? handled.envelope.payload.content.summary : null,
      })
      stepTerminalRecorded = true
      return {
      status: handled.envelope.payload.content.status,
      specialistAgentId,
      taskId,
      result: structuredClone(handled.envelope.payload.content.result),
      summary: handled.envelope.payload.content.summary,
      actionDecision: structuredClone(handled.actionDecision),
      attribution: resultVerification.attribution,
      nodeId,
      assignmentMessageId: envelope.payload.messageId,
      messageId: handled.envelope.payload.messageId,
      resultId: handled.envelope.payload.messageId,
      }
    } catch (failure) {
      const reason = failure?.code ?? 'SPECIALIST_EXECUTION_FAILED'
      const unknown = ['MODEL_CALL_OUTCOME_UNKNOWN', 'TEAM_WAIT_TIMEOUT_OUTCOME_UNKNOWN', 'TEAM_INTERRUPTION_DURABILITY_FAILED'].includes(reason)
      if (!stepTerminalRecorded) await this.onStep({ taskId, nodeId, status: unknown ? 'unknown' : 'failed', messageId: envelope.payload.messageId, resultId: null, reason })
      throw failure
    }
  }

  async requestAction({ capability, resource, operation, actionDiff, rationale, taskId = null, nodeId = null, title, detail }) {
    this.assertActive()
    const steering = JSON.stringify(this.getSteering())
    const window = containedWindow([this.grant], this.now())
    const action = signAction({
      actionId: `ceo-${crypto.randomUUID()}`,
      agentId: this.agentId,
      capability,
      resource,
      operation,
      actionDiff: structuredClone(actionDiff),
      taskId,
      nodeId,
      ...window,
    }, this.identity)
    const policyDecision = evaluatePolicy(this.gateway.policy, action.payload)
    const result = this.gateway.submit({ grant: this.grant, action })
    if (result.status === 'pending') {
      await this.decisions.post({
        actionId: result.actionId,
        challengeHash: result.challengeHash,
        actionDiff: structuredClone(action.payload.actionDiff),
        resource: action.payload.resource,
        expiresAt: action.payload.expiresAt,
        taskId,
        nodeId,
        agent: {
          agentId: this.agentId,
          grantId: this.grant.payload.grantId,
          keyFingerprint: this.grant.payload.agentKeyFingerprint,
        },
        policyRationale: {
          ruleId: policyDecision.ruleId,
          tier: policyDecision.tier,
          reason: rationale ?? result.reason,
        },
        title: title ?? `Approve ${operation} on ${resource}`,
        detail: detail ?? rationale,
      })
      if (steering !== JSON.stringify(this.getSteering())) {
        this.gateway.cancelPending(result.actionId, 'TASK_STEERED')
        await this.decisions.cancel(result.actionId, 'TASK_STEERED')
        return { status: 'denied', actionId: result.actionId, reason: 'TASK_STEERED' }
      }
    }
    return result
  }

  async browserCommand(command, { taskId = null, nodeId = null } = {}) {
    this.assertActive()
    if (!this.browserSurface?.agentCommand) return { status: 'denied', reason: 'BROWSER_SURFACE_UNAVAILABLE' }
    // Browser actions issued by the CEO are bound to the trusted root task;
    // model-proposed command fields never choose task or node identity.
    return this.browserSurface.agentCommand(command, {
      grant: this.grant,
      scope: { taskId, nodeId },
    })
  }

  #availableSpecialists() {
    return [...new Set([...this.specialists.keys(), ...(this.resolveSpecialist ? this.specialistCatalog.keys() : [])])]
  }

  async #route(prompt, context, { captureProposal = false } = {}) {
    // A bounded replan incorporates steering that arrived during a provider call
    // without dispatching the outdated plan's tools or signed actions.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      this.assertActive()
      const steering = structuredClone(this.getSteering())
      const result = await this.modelRouter.route(prompt, { ...context, steering })
      this.assertActive()
      const revision = JSON.stringify(steering)
      if (revision === JSON.stringify(this.getSteering())) {
        if (!captureProposal) return result
        // Keep the exact revision that produced this plan through checkpoint,
        // resolver, delivery and claim awaits. After acceptance, stop explicitly
        // on changes; replaying a plan could repeat already-completed effects.
        return { result, assertProposalCurrent: () => {
          this.assertActive()
          if (revision !== JSON.stringify(this.getSteering())) {
            throw Object.assign(new Error('TASK_PLAN_STALE'), { code: 'TASK_PLAN_STALE' })
          }
        } }
      }
    }
    throw Object.assign(new Error('TASK_STEERING_LIMIT'), { code: 'TASK_STEERING_LIMIT' })
  }

  state(options = {}) {
    return createActivityProjection({
      audit: this.audit,
      decisions: this.decisions,
      browserSurface: this.browserSurface,
      agent: options.agent ?? {
        id: this.agentId,
        name: 'RJ',
        model: this.modelRouter.routerId,
        status: 'Working',
      },
      session: options.session,
      now: this.now,
      limit: options.limit,
    })
  }

  #recordReceived(envelope, verification) {
    this.audit.append({
      kind: verification.status === 'accepted' ? 'agent.message.accepted' : 'agent.message.rejected',
      messageId: verification.messageId,
      taskId: envelope?.payload?.taskId ?? 'unknown',
      senderAgentId: envelope?.sender?.agentId ?? 'unknown',
      recipientAgentId: this.agentId,
      messageType: envelope?.payload?.type ?? 'unknown',
      outcome: verification.status,
      ...(verification.reason ? { reason: verification.reason } : {}),
      at: new Date(this.now()).toISOString(),
    })
  }
}
