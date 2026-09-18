import crypto from 'node:crypto'
import { createAgentMessageEnvelope, verifyAgentMessage } from '../agent-message.mjs'
import { sha256 } from '../canonical.mjs'
import { signAction } from '../identity.mjs'
import { evaluatePolicy } from '../policy.mjs'
import { createEd25519SigningProvider } from '../signing-provider.mjs'
import { createActivityProjection } from './activity-projection.mjs'
import { validateModelRouter } from './model-router.mjs'

const MAX_SPECIALIST_TASKS = 8

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

function validatePlan(plan) {
  if (!isRecord(plan)
    || !Array.isArray(plan.tasks)
    || plan.tasks.length === 0
    || plan.tasks.length > MAX_SPECIALIST_TASKS) {
    throw new TypeError('model router returned an invalid task plan')
  }
  plan.tasks.forEach(validateTask)
  return plan
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
    decisions,
    specialists = [],
    specialistCatalog = [],
    resolveSpecialist = null,
    dispatchTask = null,
    drainTasks = null,
    assertActive = () => {},
    getSteering = () => [],
    onCheckpoint = async () => {},
    agentContext = null,
    taskContext = null,
    onPlan = async () => {},
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
      || typeof onPlan !== 'function') {
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
    this.decisions = decisions
    this.specialists = new Map(specialists.map((specialist) => [specialist.agentId, specialist]))
    this.specialistCatalog = new Map(specialistCatalog.map((manifest) => [manifest.agentId, structuredClone(manifest)]))
    this.resolveSpecialist = resolveSpecialist
    this.dispatchTask = dispatchTask
    this.drainTasks = drainTasks
    this.assertActive = assertActive
    this.getSteering = getSteering
    this.onCheckpoint = onCheckpoint
    this.agentContext = agentContext ? structuredClone(agentContext) : null
    this.taskContext = taskContext ? structuredClone(taskContext) : null
    this.onPlan = onPlan
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
    const plan = validatePlan(proposal.result)
    const { assertProposalCurrent } = proposal
    this.assertActive()
    if (plan.tasks.some((task) => !this.#availableSpecialists().includes(task.specialistAgentId))) {
      throw Object.assign(new Error('SPECIALIST_NOT_REGISTERED'), { code: 'SPECIALIST_NOT_REGISTERED' })
    }
    if (requestedSpecialistAgentId
      && plan.tasks.some((task) => task.specialistAgentId !== requestedSpecialistAgentId)) {
      throw Object.assign(new Error('TARGET_SPECIALIST_MISMATCH'), { code: 'TARGET_SPECIALIST_MISMATCH' })
    }
    await this.onPlan(structuredClone(plan))
    this.audit.append({
      kind: 'ceo.task.decomposed',
      taskId: envelope.payload.taskId,
      agentId: this.agentId,
      routerId: this.modelRouter.routerId,
      specialistCount: plan.tasks.length,
      at: new Date(this.now()).toISOString(),
    })

    const results = []
    for (const [index, task] of plan.tasks.entries()) {
      assertProposalCurrent()
      results.push(await this.delegateTask({
        ...task,
        taskId: this.dispatchTask ? envelope.payload.taskId : `${envelope.payload.taskId}:${index + 1}`,
        parentMessageId: envelope.payload.messageId,
        assertProposalCurrent,
      }))
    }

    if (this.drainTasks) {
      const delivered = await this.drainTasks()
      for (const result of delivered) if (!results.some(existing => existing.messageId === result.messageId)) results.push(result)
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
      ? await this.requestAction({ ...synthesis.decision, taskId: envelope.payload.taskId })
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
    taskId,
    parentMessageId = null,
    assertProposalCurrent = () => {},
  }) {
    this.assertActive()
    assertProposalCurrent()
    if (this.dispatchTask) {
      await this.onCheckpoint({ stage: 'delegating', agentId: specialistAgentId, summary: objective })
      assertProposalCurrent()
      const result = await this.dispatchTask({ specialistAgentId, objective, acceptanceCriteria, request, taskId, parentMessageId, assertProposalCurrent })
      if (result.reason?.startsWith('AGENT_LOOP_') || result.reason === 'TASK_PLAN_STALE') throw Object.assign(new Error(result.reason), { code: result.reason })
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
      ...window,
    }, this.identity)
    const messageDecision = this.gateway.submit({ grant: this.grant, action: messageAction })
    if (messageDecision.status !== 'allowed') {
      return {
        status: 'rejected',
        reason: messageDecision.reason ?? 'MESSAGE_GATEWAY_DENIED',
        specialistAgentId,
        messageDecision,
      }
    }
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
    if (handled.status !== 'completed') return handled

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
    if (resultVerification.status !== 'accepted') return resultVerification
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
    return {
      status: handled.envelope.payload.content.status,
      specialistAgentId,
      taskId,
      result: structuredClone(handled.envelope.payload.content.result),
      summary: handled.envelope.payload.content.summary,
      actionDecision: structuredClone(handled.actionDecision),
      attribution: resultVerification.attribution,
    }
  }

  async requestAction({ capability, resource, operation, actionDiff, rationale, taskId, title, detail }) {
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

  async browserCommand(command) {
    this.assertActive()
    if (!this.browserSurface?.agentCommand) return { status: 'denied', reason: 'BROWSER_SURFACE_UNAVAILABLE' }
    return this.browserSurface.agentCommand(command, { grant: this.grant })
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
