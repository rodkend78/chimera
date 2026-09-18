import { sha256 } from '../canonical.mjs'
import { signAction } from '../identity.mjs'

function isBoundedString(value, maximum = 2048) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

const GITHUB_REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/
const GITHUB_BRANCH = /^(?!\/)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,255}(?<!\/)$/
const GITHUB_SHA = /^[a-f0-9]{40}$/
const GITHUB_WRITE_TOOLS = new Set([
  'mcp__chimera_github__pr_create',
  'mcp__chimera_github__pr_update',
  'mcp__chimera_github__pr_comment',
  'mcp__chimera_github__pr_merge',
])

function utf8Bytes(value) {
  return typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : Number.POSITIVE_INFINITY
}

function validRepository(value) {
  return typeof value === 'string' && GITHUB_REPOSITORY.test(value)
}

function validPullNumber(value) {
  return Number.isSafeInteger(value) && value > 0
}

function githubReview(summary, fields) {
  return {
    schema: 'chimera.approval-review.v1',
    summary,
    fields,
  }
}

export function approvalReviewForTool(toolName, args) {
  if (!GITHUB_WRITE_TOOLS.has(toolName)) return null
  if (!args || typeof args !== 'object' || Array.isArray(args) || !validRepository(args.repository)) {
    throw new TypeError('DSH_APPROVAL_REVIEW_INVALID')
  }
  if (toolName === 'mcp__chimera_github__pr_merge') {
    const method = args.method ?? 'squash'
    if (!validPullNumber(args.number) || !GITHUB_SHA.test(args.expectedHeadSha ?? '')
      || !['merge', 'squash', 'rebase'].includes(method)) {
      throw new TypeError('DSH_APPROVAL_REVIEW_INVALID')
    }
    return githubReview(`Merge PR #${args.number} in ${args.repository} using ${method}`, {
      Repository: args.repository,
      'Pull request': `#${args.number}`,
      'Expected head SHA': args.expectedHeadSha,
      'Merge method': method,
    })
  }
  if (toolName === 'mcp__chimera_github__pr_create') {
    const body = args.body ?? ''
    if (!isBoundedString(args.title, 256) || utf8Bytes(args.title) > 256 || !GITHUB_BRANCH.test(args.head ?? '')
      || !GITHUB_BRANCH.test(args.base ?? '') || typeof body !== 'string' || utf8Bytes(body) > 64 * 1024) {
      throw new TypeError('DSH_APPROVAL_REVIEW_INVALID')
    }
    return githubReview(`Create a pull request in ${args.repository}`, {
      Repository: args.repository,
      Title: args.title,
      'Head branch': args.head,
      'Base branch': args.base,
      'Body bytes': utf8Bytes(body),
      'Body SHA-256': sha256({ body }),
    })
  }
  if (toolName === 'mcp__chimera_github__pr_update') {
    if (!validPullNumber(args.number)
      || (args.title !== undefined && (!isBoundedString(args.title, 256) || utf8Bytes(args.title) > 256))
      || (args.body !== undefined && (typeof args.body !== 'string' || utf8Bytes(args.body) > 64 * 1024))
      || (args.state !== undefined && !['open', 'closed'].includes(args.state))
      || (args.title === undefined && args.body === undefined && args.state === undefined)) {
      throw new TypeError('DSH_APPROVAL_REVIEW_INVALID')
    }
    const fields = {
      Repository: args.repository,
      'Pull request': `#${args.number}`,
      Changes: [args.title !== undefined ? 'title' : null, args.body !== undefined ? 'body' : null, args.state !== undefined ? 'state' : null].filter(Boolean).join(', '),
      ...(args.title !== undefined ? { Title: args.title } : {}),
      ...(args.state !== undefined ? { State: args.state } : {}),
      ...(args.body !== undefined ? { 'Body bytes': utf8Bytes(args.body), 'Body SHA-256': sha256({ body: args.body }) } : {}),
    }
    return githubReview(`Update PR #${args.number} in ${args.repository}`, fields)
  }
  if (!validPullNumber(args.number) || !isBoundedString(args.body, 64 * 1024) || utf8Bytes(args.body) > 64 * 1024) {
    throw new TypeError('DSH_APPROVAL_REVIEW_INVALID')
  }
  return githubReview(`Comment on PR #${args.number} in ${args.repository}`, {
    Repository: args.repository,
    'Pull request': `#${args.number}`,
    'Comment bytes': utf8Bytes(args.body),
    'Comment SHA-256': sha256({ body: args.body }),
  })
}

function actionWindow(grant, now, lifetimeMs = 5 * 60_000) {
  const issuedAt = Math.max(now - 1_000, Date.parse(grant.payload.issuedAt))
  const expiresAt = Math.min(now + lifetimeMs, Date.parse(grant.payload.expiresAt))
  if (Number.isFinite(issuedAt) && Number.isFinite(expiresAt) && issuedAt < expiresAt) {
    return {
      issuedAt: new Date(issuedAt).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
    }
  }
  return {
    issuedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 1_000).toISOString(),
  }
}

function identityOf(exec) {
  const agentId = exec?.agent?.id
  const sessionId = exec?.agent?.session?.id
  if (!isBoundedString(agentId, 256) || !isBoundedString(sessionId, 256)) {
    return null
  }
  return { agentId, sessionId }
}

function callIdentity(exec, parentCallId) {
  if (!isBoundedString(exec?.callId, 256)
    || !isBoundedString(exec?.rootCallId, 256)
    || !isBoundedString(exec?.name, 256)
    || typeof exec?.token !== 'symbol') {
    return null
  }
  return {
    callId: exec.callId,
    rootCallId: exec.rootCallId,
    parentCallId,
    toolName: exec.name,
  }
}

function denial(reason) {
  return { kind: 'deny', reason }
}

export class DshEnforcementAdapter {
  #callByToken = new Map()

  constructor({
    gateway,
    inventory,
    audit,
    authorityFor,
    approvalBroker,
    now = () => Date.now(),
  }) {
    if (!gateway || !inventory || !audit || typeof authorityFor !== 'function') {
      throw new TypeError('DSH enforcement requires gateway, inventory, audit, and authority resolver')
    }
    this.gateway = gateway
    this.inventory = inventory
    this.audit = audit
    this.authorityFor = authorityFor
    this.approvalBroker = approvalBroker
    this.now = now
  }

  async preExecute(exec) {
    const actor = identityOf(exec)
    if (!actor) return denial('INVALID_DSH_EXECUTION_IDENTITY')

    let route
    try {
      route = this.inventory.classify(exec?.name)
    } catch (error) {
      const reason = isBoundedString(error?.code, 128) ? error.code : 'UNOWNED_DSH_TOOL'
      this.#auditDenied({
        ...actor,
        callId: isBoundedString(exec?.callId, 256) ? exec.callId : 'unknown',
        rootCallId: isBoundedString(exec?.rootCallId, 256) ? exec.rootCallId : 'unknown',
        parentCallId: null,
        toolName: isBoundedString(exec?.name, 256) ? exec.name : 'unknown',
      }, reason)
      return denial(reason)
    }

    const preliminaryFacts = {
      ...actor,
      callId: isBoundedString(exec?.callId, 256) ? exec.callId : 'unknown',
      rootCallId: isBoundedString(exec?.rootCallId, 256) ? exec.rootCallId : 'unknown',
      parentCallId: null,
      toolName: isBoundedString(exec?.name, 256) ? exec.name : 'unknown',
      capability: route.capability,
      resource: `dsh-tool:${exec.name}`,
    }

    const authority = await this.authorityFor(actor.agentId, actor.sessionId)
    if (!authority?.grant || !authority?.identity?.privateKey) {
      this.#auditDenied(preliminaryFacts, 'NO_DSH_AGENT_AUTHORITY')
      return denial('NO_DSH_AGENT_AUTHORITY')
    }

    let parentCallId = null
    if (exec.parent !== undefined) {
      parentCallId = this.#callByToken.get(exec.parent) ?? null
      if (parentCallId === null) {
        this.#auditDenied(preliminaryFacts, 'UNRESOLVED_DSH_PARENT')
        return denial('UNRESOLVED_DSH_PARENT')
      }
    }
    const call = callIdentity(exec, parentCallId)
    if (!call) {
      this.#auditDenied(preliminaryFacts, 'INVALID_DSH_CALL_IDENTITY')
      return denial('INVALID_DSH_CALL_IDENTITY')
    }

    const resource = `dsh-tool:${call.toolName}`
    const requestHash = sha256({
      sessionId: actor.sessionId,
      callId: call.callId,
      rootCallId: call.rootCallId,
      parentCallId: call.parentCallId,
      toolName: call.toolName,
      arguments: exec.arguments,
    })
    let review = null
    try {
      review = approvalReviewForTool(call.toolName, exec.arguments)
    } catch {
      this.#auditDenied({
        ...actor,
        ...call,
        capability: route.capability,
        resource,
        requestHash,
      }, 'DSH_APPROVAL_REVIEW_INVALID')
      return denial('DSH_APPROVAL_REVIEW_INVALID')
    }
    const action = signAction({
      actionId: `dsh-${sha256({
        agentId: actor.agentId,
        sessionId: actor.sessionId,
        callId: call.callId,
      }).slice(0, 40)}`,
      agentId: actor.agentId,
      capability: route.capability,
      resource,
      operation: 'execute',
      requestHash,
      dshSessionId: actor.sessionId,
      dshCallId: call.callId,
      dshRootCallId: call.rootCallId,
      dshParentCallId: call.parentCallId,
      dshToolName: call.toolName,
      ...actionWindow(authority.grant, this.now()),
    }, authority.identity)
    const gatewayDecision = this.gateway.submit({ grant: authority.grant, action })
    const facts = {
      agentId: actor.agentId,
      grantId: authority.grant.payload.grantId,
      sessionId: actor.sessionId,
      callId: call.callId,
      rootCallId: call.rootCallId,
      parentCallId: call.parentCallId,
      toolName: call.toolName,
      capability: route.capability,
      resource,
      requestHash,
      actionId: gatewayDecision.actionId,
    }

    if (gatewayDecision.status === 'allowed') {
      this.#callByToken.set(exec.token, call.callId)
      this.#auditAuthorized(facts, gatewayDecision.tier)
      return { kind: 'allow', actionId: gatewayDecision.actionId }
    }
    if (gatewayDecision.status !== 'pending') {
      this.#auditDenied(facts, gatewayDecision.reason)
      return denial(gatewayDecision.reason)
    }

    this.audit.append({
      kind: 'dsh.approval.asked',
      ...facts,
      challengeHash: gatewayDecision.challengeHash,
      at: new Date(this.now()).toISOString(),
    })
    if (!this.approvalBroker || typeof this.approvalBroker.request !== 'function') {
      this.audit.append({
        kind: 'dsh.approval.decided',
        ...facts,
        challengeHash: gatewayDecision.challengeHash,
        outcome: 'unavailable',
        at: new Date(this.now()).toISOString(),
      })
      return denial('CHIMERA_SIGNED_APPROVAL_UNAVAILABLE')
    }

    let signedDecision
    try {
      signedDecision = await this.approvalBroker.request({
        ...facts,
        challengeHash: gatewayDecision.challengeHash,
        ...(review ? { review } : {}),
        signal: exec.signal,
        assertActive: exec.assertActive,
      })
    } catch {
      signedDecision = null
    }
    const finalDecision = signedDecision
      ? this.gateway.decide(signedDecision)
      : { status: 'denied', reason: 'CHIMERA_SIGNED_APPROVAL_UNAVAILABLE' }
    await this.approvalBroker.complete?.(gatewayDecision.actionId, finalDecision)
    this.audit.append({
      kind: 'dsh.approval.decided',
      ...facts,
      challengeHash: gatewayDecision.challengeHash,
      outcome: finalDecision.status,
      ...(finalDecision.reason ? { reason: finalDecision.reason } : {}),
      at: new Date(this.now()).toISOString(),
    })
    if (finalDecision.status !== 'allowed') {
      this.#auditDenied(facts, finalDecision.reason ?? 'CHIMERA_SIGNED_APPROVAL_DENIED')
      return denial(finalDecision.reason ?? 'CHIMERA_SIGNED_APPROVAL_DENIED')
    }
    this.#callByToken.set(exec.token, call.callId)
    this.#auditAuthorized(facts, 'confirm')
    return { kind: 'allow', actionId: finalDecision.actionId }
  }

  observeResult(exec, result) {
    if (typeof exec?.token === 'symbol') this.#callByToken.delete(exec.token)
    const actor = identityOf(exec)
    if (!actor || !isBoundedString(exec?.callId, 256) || !isBoundedString(exec?.name, 256)) return
    this.audit.append({
      kind: 'dsh.tool.result',
      ...actor,
      callId: exec.callId,
      rootCallId: isBoundedString(exec.rootCallId, 256) ? exec.rootCallId : exec.callId,
      toolName: exec.name,
      outcome: result?.isError === true ? 'error' : 'success',
      at: new Date(this.now()).toISOString(),
    })
  }

  guardReason(exec) {
    if (typeof exec?.token === 'symbol' && this.#callByToken.has(exec.token)) return undefined
    const actor = identityOf(exec) ?? { agentId: 'unknown', sessionId: 'unknown' }
    let route
    try {
      route = this.inventory.classify(exec?.name)
    } catch {
      route = { capability: 'unknown' }
    }
    this.#auditDenied({
      ...actor,
      callId: isBoundedString(exec?.callId, 256) ? exec.callId : 'unknown',
      rootCallId: isBoundedString(exec?.rootCallId, 256) ? exec.rootCallId : 'unknown',
      parentCallId: null,
      toolName: isBoundedString(exec?.name, 256) ? exec.name : 'unknown',
      capability: route.capability,
      resource: isBoundedString(exec?.name, 256) ? `dsh-tool:${exec.name}` : 'dsh-tool:unknown',
    }, 'CHIMERA_DSH_GATE_BYPASSED')
    return 'CHIMERA_DSH_GATE_BYPASSED'
  }

  #auditAuthorized(facts, tier) {
    this.audit.append({
      kind: 'dsh.tool.authorized',
      ...facts,
      tier,
      at: new Date(this.now()).toISOString(),
    })
  }

  #auditDenied(facts, reason) {
    this.audit.append({
      kind: 'dsh.tool.denied',
      ...facts,
      reason,
      at: new Date(this.now()).toISOString(),
    })
  }
}

export function installDshCordisEnforcement(ctx, adapter) {
  if (!ctx
    || typeof ctx.on !== 'function'
    || typeof ctx.tools?.guard !== 'function'
    || !(adapter instanceof DshEnforcementAdapter)) {
    throw new TypeError('Cordis enforcement installation requires a context and adapter')
  }
  const disposers = [
    ctx.on('tools/pre-execute', async (exec, next) => {
      const decision = await adapter.preExecute(exec)
      if (decision.kind !== 'allow') return decision
      return next()
    }, { prepend: true }),
    ctx.on('tools/result', (exec, result) => {
      adapter.observeResult(exec, result)
    }),
    ctx.tools.guard((exec) => adapter.guardReason(exec)),
  ]
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}
