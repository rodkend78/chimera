import crypto from 'node:crypto'
import { sha256 } from '../canonical.mjs'
import { signAction } from '../identity.mjs'
import { evaluatePolicy } from '../policy.mjs'
import { createTrustedModelCallNotSentError } from './model-call-errors.mjs'
import { validateModelRouter } from './model-router.mjs'

function isBoundedString(value, maximum = 2048) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function containedWindow(grant, now, lifetimeMs = 15 * 60_000) {
  const issuedAt = Math.max(now - 1_000, Date.parse(grant.payload.issuedAt))
  const expiresAt = Math.min(now + lifetimeMs, Date.parse(grant.payload.expiresAt))
  if (Number.isFinite(issuedAt) && Number.isFinite(expiresAt) && issuedAt < expiresAt) {
    return {
      issuedAt: new Date(issuedAt).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
    }
  }
  // Use a valid current action window so the gateway remains the authority that
  // records and explains an inactive or malformed grant denial.
  return {
    issuedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 1_000).toISOString(),
  }
}

function deniedModelCall(decision) {
  return createTrustedModelCallNotSentError(
    `model call denied: ${decision.reason ?? decision.status}`,
    {
      name: 'ModelCallDeniedError',
      code: 'MODEL_CALL_DENIED',
      reason: decision.reason ?? 'MODEL_CALL_NOT_ALLOWED',
      actionId: decision.actionId,
    },
  )
}

function providerFailure(error) {
  if (error instanceof Error) {
    const wrapped = new Error(error.message, { cause: error })
    wrapped.name = error.name
    wrapped.code = isBoundedString(error.code, 256) ? error.code : 'MODEL_PROVIDER_FAILURE'
    wrapped.dispatchState = 'unknown'
    return wrapped
  }
  const wrapped = new Error(String(error))
  wrapped.code = 'MODEL_PROVIDER_FAILURE'
  wrapped.dispatchState = 'unknown'
  return wrapped
}

export function createGatewayModelRouter({
  provider,
  gateway,
  grant,
  identity,
  audit,
  agentId,
  now = () => Date.now(),
}) {
  const routed = validateModelRouter(provider)
  if (!gateway || !grant || !identity?.privateKey || !audit || !isBoundedString(agentId, 256)) {
    throw new TypeError('gateway model router requires provider, gateway, grant, identity, audit, and agent id')
  }
  const resource = `model:${routed.routerId}`
  const authorizationScope = sha256({
    agentId,
    grantHash: sha256(grant),
    resource,
  })

  function authorize(prompt, context = {}) {
    const requestHash = sha256({ prompt, context })
    const action = signAction({
      actionId: `model-${crypto.randomUUID()}`,
      agentId,
      capability: 'model.invoke',
      resource,
      operation: 'invoke',
      requestHash,
      ...containedWindow(grant, now()),
    }, identity)
    const policyDecision = evaluatePolicy(gateway.policy, action.payload)
    const decision = gateway.submit({ grant, action })
    if (decision.status !== 'allowed') throw deniedModelCall(decision)
    audit.append({
      kind: 'model.call.authorized',
      actionId: decision.actionId,
      agentId,
      grantId: grant.payload.grantId,
      providerRouterId: routed.routerId,
      resource,
      requestHash,
      policyRuleId: policyDecision.ruleId,
      at: new Date(now()).toISOString(),
    })

    let dispatched = false
    return Object.freeze({
      authorizationScope,
      requestHash,
      async dispatch() {
        if (dispatched) throw new Error('MODEL_CALL_AUTHORIZATION_ALREADY_USED')
        dispatched = true
        try {
          return await routed.route(prompt, structuredClone(context))
        } catch (error) {
          throw providerFailure(error)
        }
      },
    })
  }

  return validateModelRouter(Object.freeze({
    routerId: `gateway:${routed.routerId}`,
    authorizationScope,
    authorize,
    async route(prompt, context = {}) {
      const authorized = authorize(prompt, context)
      return authorized.dispatch()
    },
  }))
}
