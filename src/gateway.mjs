import { sha256 } from './canonical.mjs'
import { fingerprint, verifyPayload } from './identity.mjs'
import { evaluatePolicy, grantCovers, validatePolicy } from './policy.mjs'

// Human takeover is an interactive browser session, not an agent delegation.
// These are the only capabilities that may use the human-control override when
// the policy has no matching rule (the fail-closed default). Explicit browser
// rules, including an explicit block or an ambiguous match, still win.
const HUMAN_BROWSER_CAPABILITIES = new Set([
  'browser.observe',
  'browser.navigate',
  'browser.interact',
  'browser.input',
])

function isActiveWindow(payload, now) {
  const issuedAt = Date.parse(payload.issuedAt)
  const expiresAt = Date.parse(payload.expiresAt)
  return Number.isFinite(issuedAt)
    && Number.isFinite(expiresAt)
    && issuedAt <= now
    && now < expiresAt
}

function isBoundedString(value, maximum = 2048) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function validateWindow(payload) {
  if (!isBoundedString(payload.issuedAt, 64) || !isBoundedString(payload.expiresAt, 64)) {
    throw new TypeError('invalid time window')
  }
  if (!Number.isFinite(Date.parse(payload.issuedAt)) || !Number.isFinite(Date.parse(payload.expiresAt))) {
    throw new TypeError('invalid time window')
  }
}

function validateSelector(selector) {
  if (!selector || typeof selector !== 'object' || !isBoundedString(selector.capability, 128)) {
    throw new TypeError('invalid scope selector')
  }
  const exact = typeof selector.resource === 'string'
  const prefix = typeof selector.resourcePrefix === 'string'
  if (exact === prefix) throw new TypeError('scope needs exactly one resource selector')
  const value = exact ? selector.resource : selector.resourcePrefix
  if (value.length > 2048) throw new TypeError('scope resource selector is too long')
}

function validateGrant(grant) {
  if (!grant || typeof grant !== 'object' || !isBoundedString(grant.humanKeyId, 256)) {
    throw new TypeError('invalid grant envelope')
  }
  if (!isBoundedString(grant.signature, 512) || !grant.payload || typeof grant.payload !== 'object') {
    throw new TypeError('invalid grant envelope')
  }
  const payload = grant.payload
  for (const value of [payload.grantId, payload.humanId, payload.agentId, payload.agentKeyFingerprint]) {
    if (!isBoundedString(value, 256)) throw new TypeError('invalid grant identity')
  }
  if (!['auto', 'confirm'].includes(payload.maxTier)) throw new TypeError('invalid grant tier')
  if (!Array.isArray(payload.scopes) || payload.scopes.length === 0 || payload.scopes.length > 64) {
    throw new TypeError('invalid grant scopes')
  }
  payload.scopes.forEach(validateSelector)
  validateWindow(payload)
}

function validateAction(action) {
  if (!action || typeof action !== 'object' || !isBoundedString(action.agentPublicKey, 2048)) {
    throw new TypeError('invalid action envelope')
  }
  if (!isBoundedString(action.signature, 512) || !action.payload || typeof action.payload !== 'object') {
    throw new TypeError('invalid action envelope')
  }
  const payload = action.payload
  if (!isBoundedString(payload.actionId, 256)
    || !isBoundedString(payload.agentId, 256)
    || !isBoundedString(payload.capability, 128)
    || !isBoundedString(payload.resource, 2048)
    || !isBoundedString(payload.operation, 128)) {
    throw new TypeError('invalid action payload')
  }
  validateWindow(payload)
}

function validateHumanAction(action) {
  if (!action || typeof action !== 'object'
    || !isBoundedString(action.humanKeyId, 256)
    || !isBoundedString(action.signature, 512)
    || !action.payload
    || typeof action.payload !== 'object') {
    throw new TypeError('invalid human action envelope')
  }
  const payload = action.payload
  if (!isBoundedString(payload.actionId, 256)
    || !isBoundedString(payload.humanId, 256)
    || !isBoundedString(payload.capability, 128)
    || !isBoundedString(payload.resource, 2048)
    || !isBoundedString(payload.operation, 128)) {
    throw new TypeError('invalid human action payload')
  }
  validateWindow(payload)
}

function validateDecision(decision) {
  if (!decision || typeof decision !== 'object'
    || !isBoundedString(decision.humanKeyId, 256)
    || !isBoundedString(decision.signature, 512)
    || !decision.payload
    || typeof decision.payload !== 'object') {
    throw new TypeError('invalid decision envelope')
  }
  const payload = decision.payload
  if (!isBoundedString(payload.actionId, 256)
    || !isBoundedString(payload.challengeHash, 128)
    || !['approve', 'deny'].includes(payload.outcome)) {
    throw new TypeError('invalid decision payload')
  }
  validateWindow(payload)
}

export class ChimeraGateway {
  #pending = new Map()
  #seenActions = new Set()

  constructor({ policy, humanKeys, audit, replayLedger = null, now = () => Date.now() }) {
    this.policy = validatePolicy(policy)
    this.humanKeys = new Map(humanKeys)
    this.audit = audit
    this.replayLedger = replayLedger
    this.now = now
  }

  #hasSeen(actionId) {
    return this.replayLedger?.has(actionId) ?? this.#seenActions.has(actionId)
  }

  #markSeen(actionId) {
    if (this.replayLedger) return this.replayLedger.record(actionId)
    if (this.#seenActions.has(actionId)) return false
    this.#seenActions.add(actionId)
    return true
  }

  submit({ grant, action }) {
    const actionId = action?.payload?.actionId ?? 'unknown'
    try {
      validateGrant(grant)
      validateAction(action)
      return this.#submitValidated({ grant, action })
    } catch {
      return this.#deny(isBoundedString(actionId, 256) ? actionId : 'unknown', 'MALFORMED_REQUEST')
    }
  }

  submitHuman({ action, audit = this.audit }) {
    const actionId = action?.payload?.actionId ?? 'unknown'
    try {
      validateHumanAction(action)
      if (!audit || typeof audit.append !== 'function') throw new TypeError('invalid human audit sink')
      return this.#submitHumanValidated(action, audit)
    } catch {
      return this.#deny(isBoundedString(actionId, 256) ? actionId : 'unknown', 'MALFORMED_HUMAN_ACTION', undefined, audit)
    }
  }

  #submitHumanValidated(action, audit) {
    const { payload } = action
    if (this.#hasSeen(payload.actionId)) return this.#deny(payload.actionId, 'REPLAYED_ACTION', undefined, audit)

    const humanPublicKey = this.humanKeys.get(action.humanKeyId)
    if (!humanPublicKey || !verifyPayload(payload, action.signature, humanPublicKey)) {
      return this.#deny(payload.actionId, 'HUMAN_ACTION_SIGNATURE_INVALID', undefined, audit)
    }
    if (!isActiveWindow(payload, this.now())) {
      return this.#deny(payload.actionId, 'HUMAN_ACTION_EXPIRED_OR_NOT_ACTIVE', undefined, audit)
    }

    const policyDecision = evaluatePolicy(this.policy, payload)
    const humanBrowserOverride = policyDecision.ruleId === 'default'
      && policyDecision.tier === 'blocked'
      && HUMAN_BROWSER_CAPABILITIES.has(payload.capability)
    if (!this.#markSeen(payload.actionId)) return this.#deny(payload.actionId, 'REPLAYED_ACTION', undefined, audit)
    if (policyDecision.tier === 'blocked' && !humanBrowserOverride) {
      return this.#deny(payload.actionId, policyDecision.reason ?? 'POLICY_BLOCKED', policyDecision, audit)
    }

    const effectivePolicyDecision = humanBrowserOverride
      ? {
          ruleId: 'human-browser-control',
          tier: 'auto',
          originalRuleId: policyDecision.ruleId,
          originalTier: policyDecision.tier,
        }
      : policyDecision
    const entry = audit.append({
      kind: 'action.decision',
      actionId: payload.actionId,
      actorType: 'human',
      humanId: payload.humanId,
      humanSignature: action.signature,
      authority: action.humanKeyId,
      outcome: 'allowed',
      policyRuleId: effectivePolicyDecision.ruleId,
      tier: effectivePolicyDecision.tier,
      ...(humanBrowserOverride
        ? {
            policyOverride: policyDecision.ruleId,
            policyOverrideTier: policyDecision.tier,
          }
        : {}),
      at: new Date(this.now()).toISOString(),
    })
    return {
      status: 'allowed',
      actionId: payload.actionId,
      auditHash: entry.entryHash,
      tier: effectivePolicyDecision.tier,
      ...(humanBrowserOverride ? { policyOverride: policyDecision.ruleId } : {}),
    }
  }

  #submitValidated({ grant, action }) {
    const actionId = action.payload.actionId
    if (this.#hasSeen(actionId)) return this.#deny(actionId, 'REPLAYED_ACTION')

    const humanPublicKey = this.humanKeys.get(grant.humanKeyId)
    if (!humanPublicKey || !verifyPayload(grant.payload, grant.signature, humanPublicKey)) {
      return this.#deny(actionId, 'GRANT_SIGNATURE_INVALID')
    }
    if (!isActiveWindow(grant.payload, this.now())) return this.#deny(actionId, 'GRANT_EXPIRED_OR_NOT_ACTIVE')

    if (!verifyPayload(action.payload, action.signature, action.agentPublicKey)) {
      return this.#deny(actionId, 'ACTION_SIGNATURE_INVALID')
    }
    if (fingerprint(action.agentPublicKey) !== grant.payload.agentKeyFingerprint) {
      return this.#deny(actionId, 'AGENT_KEY_MISMATCH')
    }
    if (!isActiveWindow(action.payload, this.now())) return this.#deny(actionId, 'ACTION_EXPIRED_OR_NOT_ACTIVE')
    if (Date.parse(action.payload.issuedAt) < Date.parse(grant.payload.issuedAt)
      || Date.parse(action.payload.expiresAt) > Date.parse(grant.payload.expiresAt)) {
      return this.#deny(actionId, 'ACTION_OUTSIDE_GRANT_WINDOW')
    }

    const policyDecision = evaluatePolicy(this.policy, action.payload)
    const coverage = grantCovers(grant.payload, action.payload, policyDecision.tier)
    if (!coverage.covered) return this.#deny(actionId, coverage.reason, policyDecision)

    if (!this.#markSeen(actionId)) return this.#deny(actionId, 'REPLAYED_ACTION')
    if (policyDecision.tier === 'blocked') {
      return this.#deny(actionId, policyDecision.reason ?? 'POLICY_BLOCKED', policyDecision)
    }

    if (policyDecision.tier === 'auto') {
      return this.#allow(actionId, grant, action, policyDecision, 'delegation-grant')
    }

    const challengeHash = sha256({
      action: action.payload,
      actionSignature: action.signature,
      grantId: grant.payload.grantId,
      policyRuleId: policyDecision.ruleId,
    })
    this.#pending.set(actionId, { grant, action, policyDecision, challengeHash })
    this.audit.append({
      kind: 'action.pending',
      actionId,
      agentId: action.payload.agentId,
      challengeHash,
      grantId: grant.payload.grantId,
      policyRuleId: policyDecision.ruleId,
      tier: 'confirm',
      at: new Date(this.now()).toISOString(),
    })
    return { status: 'pending', actionId, challengeHash, reason: 'HUMAN_CONFIRMATION_REQUIRED' }
  }

  decide(decision) {
    const actionId = decision?.payload?.actionId ?? 'unknown'
    try {
      validateDecision(decision)
      return this.#decideValidated(decision)
    } catch {
      return this.#deny(isBoundedString(actionId, 256) ? actionId : 'unknown', 'MALFORMED_DECISION')
    }
  }

  cancelPending(actionId, reason = 'ACTION_CANCELLED') {
    if (!isBoundedString(actionId, 256)) return this.#deny('unknown', 'MALFORMED_ACTION_ID')
    if (!this.#pending.has(actionId)) return this.#deny(actionId, 'NO_PENDING_ACTION')
    this.#pending.delete(actionId)
    return this.#deny(actionId, isBoundedString(reason, 128) ? reason : 'ACTION_CANCELLED')
  }

  #decideValidated(decision) {
    const pending = this.#pending.get(decision.payload.actionId)
    if (!pending) return this.#deny(decision?.payload?.actionId ?? 'unknown', 'NO_PENDING_ACTION')
    const humanPublicKey = this.humanKeys.get(decision.humanKeyId)
    if (!humanPublicKey || !verifyPayload(decision.payload, decision.signature, humanPublicKey)) {
      return this.#deny(decision.payload.actionId, 'DECISION_SIGNATURE_INVALID')
    }
    if (decision.humanKeyId !== pending.grant.humanKeyId) {
      return this.#deny(decision.payload.actionId, 'APPROVER_MISMATCH')
    }
    if (decision.payload.challengeHash !== pending.challengeHash) {
      return this.#deny(decision.payload.actionId, 'CHALLENGE_MISMATCH')
    }
    if (!isActiveWindow(decision.payload, this.now())) {
      return this.#deny(decision.payload.actionId, 'DECISION_EXPIRED_OR_NOT_ACTIVE')
    }

    this.#pending.delete(decision.payload.actionId)
    if (decision.payload.outcome !== 'approve') {
      return this.#deny(decision.payload.actionId, 'HUMAN_DENIED', pending.policyDecision)
    }
    return this.#allow(
      decision.payload.actionId,
      pending.grant,
      pending.action,
      pending.policyDecision,
      decision.humanKeyId,
      decision.signature,
    )
  }

  #allow(actionId, grant, action, policyDecision, authority, approvalSignature) {
    const entry = this.audit.append({
      kind: 'action.decision',
      actionId,
      agentId: action.payload.agentId,
      agentSignature: action.signature,
      authority,
      grantId: grant.payload.grantId,
      grantSignature: grant.signature,
      outcome: 'allowed',
      policyRuleId: policyDecision.ruleId,
      tier: policyDecision.tier,
      ...(approvalSignature ? { approvalSignature } : {}),
      at: new Date(this.now()).toISOString(),
    })
    return { status: 'allowed', actionId, auditHash: entry.entryHash, tier: policyDecision.tier }
  }

  #deny(actionId, reason, policyDecision = { ruleId: 'validation', tier: 'blocked' }, audit = this.audit) {
    const entry = audit.append({
      kind: 'action.decision',
      actionId,
      outcome: 'denied',
      policyRuleId: policyDecision.ruleId,
      reason,
      tier: policyDecision.tier,
      at: new Date(this.now()).toISOString(),
    })
    return { status: 'denied', actionId, auditHash: entry.entryHash, reason }
  }
}
