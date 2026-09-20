import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoryAuditLog } from '../src/audit-log.mjs'
import {
  createDeterministicModelRouter,
  createGatewayModelRouter,
  createReliableModelRouter,
  DurableModelCallLedger,
} from '../src/ceo/index.mjs'
import { ChimeraGateway } from '../src/gateway.mjs'
import {
  exportPublicKey,
  fingerprint,
  generateIdentity,
  signGrant,
} from '../src/identity.mjs'
import { sha256 } from '../src/canonical.mjs'
import { createTrustedModelCallNotSentError } from '../src/ceo/model-call-errors.mjs'

const now = Date.parse('2026-08-27T18:00:00.000Z')
const window = {
  issuedAt: '2026-08-27T17:55:00.000Z',
  expiresAt: '2026-08-27T18:30:00.000Z',
}

function fixture({
  grantedResource = 'model:provider-router',
  responder = async () => ({ summary: 'Governed result.' }),
} = {}) {
  const human = generateIdentity('rod')
  const agent = generateIdentity('ceo')
  const audit = new MemoryAuditLog()
  const gateway = new ChimeraGateway({
    policy: {
      version: 1,
      defaultTier: 'blocked',
      rules: [{
        id: 'approved-model-router',
        capability: 'model.invoke',
        resourcePrefix: 'model:',
        tier: 'auto',
      }],
    },
    humanKeys: [[human.keyId, exportPublicKey(human.publicKey)]],
    audit,
    now: () => now,
  })
  const grant = signGrant({
    grantId: 'grant-ceo-model',
    humanId: 'rod',
    agentId: 'ceo',
    agentKeyFingerprint: fingerprint(agent.publicKey),
    maxTier: 'auto',
    scopes: [{ capability: 'model.invoke', resource: grantedResource }],
    ...window,
  }, human)
  const provider = createDeterministicModelRouter({
    routerId: 'provider-router',
    responder,
  })
  const router = createGatewayModelRouter({
    provider,
    gateway,
    grant,
    identity: agent,
    audit,
    agentId: 'ceo',
    now: () => now,
  })
  return { agent, audit, gateway, grant, human, provider, router }
}

async function withLedger(audit, operation) {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-gateway-model-ledger-'))
  try {
    const ledger = await DurableModelCallLedger.open({
      filePath: join(directory, 'events.jsonl'),
      audit,
      now: () => now,
    })
    return await operation(ledger)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('an allowed model call is signed, policy checked, and attributed before provider dispatch', async () => {
  const f = fixture()
  const result = await f.router.route('Synthesize the evidence.', {
    stage: 'synthesize',
    taskId: 'task-model-1',
  })

  assert.deepEqual(result, { summary: 'Governed result.' })
  assert.equal(f.provider.calls().length, 1)
  const facts = f.audit.entries().map((entry) => entry.fact)
  const authorized = facts.find((fact) => fact.kind === 'model.call.authorized')
  assert.equal(authorized.agentId, 'ceo')
  assert.equal(authorized.resource, 'model:provider-router')
  assert.equal(authorized.policyRuleId, 'approved-model-router')
  assert.equal(facts.some((fact) => (
    fact.kind === 'action.decision'
    && fact.actionId === authorized.actionId
    && fact.outcome === 'allowed'
  )), true)
})

test('a trusted provider fence remains failed-not-sent through the gateway and reliable ledger', async () => {
  const f = fixture({ grantedResource: 'model:fenced-provider' })
  const fencedProvider = {
    routerId: 'fenced-provider',
    async route() {
      throw createTrustedModelCallNotSentError('connection disabled', {
        code: 'CONNECTION_DISABLED',
        reason: 'CONNECTION_DISABLED',
      })
    },
  }
  const gatewayRouter = createGatewayModelRouter({
    provider: fencedProvider,
    gateway: f.gateway,
    grant: f.grant,
    identity: f.agent,
    audit: f.audit,
    agentId: 'ceo',
    now: () => now,
  })
  await withLedger(f.audit, async ledger => {
    const reliable = createReliableModelRouter({ provider: gatewayRouter, ledger, audit: f.audit, now: () => now })
    const prompt = 'This must be fenced before provider dispatch.'
    const context = { stage: 'specialist', taskId: 'fenced-task' }
    await assert.rejects(() => reliable.route(prompt, context), error => (
      error.code === 'CONNECTION_DISABLED' && error.dispatchState === 'not_sent'
    ))
    const requestHash = sha256({ prompt, context })
    const callId = `model-${sha256({ providerRouterId: gatewayRouter.routerId, requestHash, scopeId: gatewayRouter.authorizationScope }).slice(0, 32)}`
    const record = await ledger.lookup(callId)
    assert.equal(record.status, 'failed-not-sent')
    assert.equal(record.failure.dispatchState, 'not_sent')
  })
})

test('opaque execution controls cross gateway and reliable wrappers without entering request identity', async () => {
  const f = fixture()
  const seen = []
  const provider = {
    routerId: 'provider-router',
    async route(prompt, context, controls) {
      seen.push({ prompt, context, controls })
      return { summary: 'controlled result' }
    },
  }
  const gatewayRouter = createGatewayModelRouter({
    provider,
    gateway: f.gateway,
    grant: f.grant,
    identity: f.agent,
    audit: f.audit,
    agentId: 'ceo',
    now: () => now,
  })
  await withLedger(f.audit, async ledger => {
    const reliable = createReliableModelRouter({ provider: gatewayRouter, ledger, audit: f.audit, now: () => now })
    const prompt = 'Keep controls out of the signed request.'
    const context = { stage: 'specialist', taskId: 'controls-task' }
    const controls = { signal: new AbortController().signal, onProgress() {}, authorityProof: { secret: true } }
    assert.deepEqual(await reliable.route(prompt, context, controls), { summary: 'controlled result' })
    assert.equal(seen.length, 1)
    assert.equal(seen[0].controls, controls)
    assert.deepEqual(seen[0].context, context)
    const authorized = f.audit.entries().map(entry => entry.fact).find(fact => fact.kind === 'model.call.authorized')
    assert.equal(authorized.requestHash, sha256({ prompt, context }))
    assert.equal(Object.hasOwn(authorized, 'controls'), false)
    assert.equal(Object.hasOwn(authorized, 'authorityProof'), false)
  })
})

test('an out-of-grant model call is denied before provider dispatch and is safe to retry', async () => {
  const f = fixture({ grantedResource: 'model:different-router' })

  await assert.rejects(
    f.router.route('This must not reach the provider.', { stage: 'decompose', taskId: 'task-model-2' }),
    (error) => (
      error.code === 'MODEL_CALL_DENIED'
      && error.reason === 'OUTSIDE_GRANT_SCOPE'
      && error.dispatchState === 'not_sent'
    ),
  )
  assert.equal(f.provider.calls().length, 0)
  assert.equal(f.audit.entries().some((entry) => (
    entry.fact.kind === 'action.decision'
    && entry.fact.outcome === 'denied'
    && entry.fact.reason === 'OUTSIDE_GRANT_SCOPE'
  )), true)
})

test('authorization scope changes when the exact signed grant changes', () => {
  const f = fixture()
  const replacementGrant = signGrant({
    ...f.grant.payload,
    expiresAt: '2026-08-27T18:25:00.000Z',
  }, f.human)
  const replacement = createGatewayModelRouter({
    provider: f.provider,
    gateway: f.gateway,
    grant: replacementGrant,
    identity: f.agent,
    audit: f.audit,
    agentId: 'ceo',
    now: () => now,
  })

  assert.notEqual(replacement.authorizationScope, f.router.authorizationScope)
})

test('a shared ledger cannot replay one agent result across a different agent grant', async () => {
  const f = fixture()
  const other = generateIdentity('other-agent')
  const otherGrant = signGrant({
    grantId: 'grant-other-model',
    humanId: 'rod',
    agentId: 'other-agent',
    agentKeyFingerprint: fingerprint(other.publicKey),
    maxTier: 'auto',
    scopes: [{ capability: 'model.invoke', resource: 'model:different-router' }],
    ...window,
  }, f.human)
  const otherGatewayRouter = createGatewayModelRouter({
    provider: f.provider,
    gateway: f.gateway,
    grant: otherGrant,
    identity: other,
    audit: f.audit,
    agentId: 'other-agent',
    now: () => now,
  })

  await withLedger(f.audit, async (ledger) => {
    const ceo = createReliableModelRouter({ provider: f.router, ledger, audit: f.audit, now: () => now })
    const otherAgent = createReliableModelRouter({
      provider: otherGatewayRouter,
      ledger,
      audit: f.audit,
      scopeId: f.router.authorizationScope,
      now: () => now,
    })
    const context = { stage: 'synthesize', taskId: 'shared-task' }

    assert.deepEqual(await ceo.route('Return the private result.', context), { summary: 'Governed result.' })
    await assert.rejects(
      otherAgent.route('Return the private result.', context),
      (error) => error.code === 'MODEL_CALL_DENIED' && error.reason === 'OUTSIDE_GRANT_SCOPE',
    )
    assert.equal(f.provider.calls().length, 1)
    assert.equal(f.audit.entries().filter((entry) => entry.fact.kind === 'action.decision').length, 2)
  })
})

test('a caller cannot override the gateway authorization scope used by the ledger', async () => {
  const f = fixture()
  const other = generateIdentity('other-agent')
  const otherGrant = signGrant({
    grantId: 'grant-other-allowed-model',
    humanId: 'rod',
    agentId: 'other-agent',
    agentKeyFingerprint: fingerprint(other.publicKey),
    maxTier: 'auto',
    scopes: [{ capability: 'model.invoke', resource: 'model:provider-router' }],
    ...window,
  }, f.human)
  const otherGatewayRouter = createGatewayModelRouter({
    provider: f.provider,
    gateway: f.gateway,
    grant: otherGrant,
    identity: other,
    audit: f.audit,
    agentId: 'other-agent',
    now: () => now,
  })

  await withLedger(f.audit, async (ledger) => {
    const ceo = createReliableModelRouter({ provider: f.router, ledger, audit: f.audit, now: () => now })
    const otherAgent = createReliableModelRouter({
      provider: otherGatewayRouter,
      ledger,
      audit: f.audit,
      scopeId: f.router.authorizationScope,
      now: () => now,
    })
    const context = { stage: 'synthesize', taskId: 'scope-override-task' }

    await ceo.route('Return the scoped result.', context)
    await otherAgent.route('Return the scoped result.', context)

    assert.equal(f.provider.calls().length, 2)
    assert.equal(f.audit.entries().filter((entry) => entry.fact.kind === 'model.call.replayed').length, 0)
  })
})

test('durable replay revalidates possession of the grant-bound agent key', async () => {
  const f = fixture()
  const impostor = generateIdentity('ceo-impostor')
  const impostorGatewayRouter = createGatewayModelRouter({
    provider: f.provider,
    gateway: f.gateway,
    grant: f.grant,
    identity: impostor,
    audit: f.audit,
    agentId: 'ceo',
    now: () => now,
  })

  await withLedger(f.audit, async (ledger) => {
    const legitimate = createReliableModelRouter({ provider: f.router, ledger, audit: f.audit, now: () => now })
    const attemptedReplay = createReliableModelRouter({
      provider: impostorGatewayRouter,
      ledger,
      audit: f.audit,
      now: () => now,
    })
    const context = { stage: 'synthesize', taskId: 'key-bound-task' }

    assert.deepEqual(await legitimate.route('Return the key-bound result.', context), {
      summary: 'Governed result.',
    })
    await assert.rejects(
      attemptedReplay.route('Return the key-bound result.', context),
      (error) => error.code === 'MODEL_CALL_DENIED' && error.reason === 'AGENT_KEY_MISMATCH',
    )
    assert.equal(f.provider.calls().length, 1)
  })
})

test('durable replay revalidates the current grant window', async () => {
  let currentTime = now
  const human = generateIdentity('rod')
  const agent = generateIdentity('ceo')
  const audit = new MemoryAuditLog()
  const gateway = new ChimeraGateway({
    policy: {
      version: 1,
      defaultTier: 'blocked',
      rules: [{
        id: 'approved-model-router',
        capability: 'model.invoke',
        resourcePrefix: 'model:',
        tier: 'auto',
      }],
    },
    humanKeys: [[human.keyId, exportPublicKey(human.publicKey)]],
    audit,
    now: () => currentTime,
  })
  const grant = signGrant({
    grantId: 'grant-expiring-model',
    humanId: 'rod',
    agentId: 'ceo',
    agentKeyFingerprint: fingerprint(agent.publicKey),
    maxTier: 'auto',
    scopes: [{ capability: 'model.invoke', resource: 'model:provider-router' }],
    ...window,
  }, human)
  const provider = createDeterministicModelRouter({
    routerId: 'provider-router',
    responder: async () => ({ summary: 'Time-bound result.' }),
  })

  await withLedger(audit, async (ledger) => {
    const gatewayRouter = createGatewayModelRouter({
      provider,
      gateway,
      grant,
      identity: agent,
      audit,
      agentId: 'ceo',
      now: () => currentTime,
    })
    const reliable = createReliableModelRouter({ provider: gatewayRouter, ledger, audit, now: () => currentTime })
    const context = { stage: 'synthesize', taskId: 'expiring-task' }

    assert.deepEqual(await reliable.route('Return the time-bound result.', context), {
      summary: 'Time-bound result.',
    })
    currentTime = Date.parse('2026-08-27T18:31:00.000Z')
    await assert.rejects(
      reliable.route('Return the time-bound result.', context),
      (error) => error.code === 'MODEL_CALL_DENIED' && error.reason === 'GRANT_EXPIRED_OR_NOT_ACTIVE',
    )
    assert.equal(provider.calls().length, 1)
  })
})

test('durable replay revalidates current policy without redispatching the provider', async () => {
  const f = fixture()

  await withLedger(f.audit, async (ledger) => {
    const initiallyAllowed = createReliableModelRouter({
      provider: f.router,
      ledger,
      audit: f.audit,
      now: () => now,
    })
    const context = { stage: 'synthesize', taskId: 'policy-change-task' }
    assert.deepEqual(await initiallyAllowed.route('Return the policy-bound result.', context), {
      summary: 'Governed result.',
    })

    const blockedGateway = new ChimeraGateway({
      policy: { version: 1, defaultTier: 'blocked', rules: [] },
      humanKeys: [[f.human.keyId, exportPublicKey(f.human.publicKey)]],
      audit: f.audit,
      now: () => now,
    })
    const blockedGatewayRouter = createGatewayModelRouter({
      provider: f.provider,
      gateway: blockedGateway,
      grant: f.grant,
      identity: f.agent,
      audit: f.audit,
      agentId: 'ceo',
      now: () => now,
    })
    const attemptedReplay = createReliableModelRouter({
      provider: blockedGatewayRouter,
      ledger,
      audit: f.audit,
      now: () => now,
    })

    await assert.rejects(
      attemptedReplay.route('Return the policy-bound result.', context),
      (error) => error.code === 'MODEL_CALL_DENIED' && error.reason === 'POLICY_BLOCKED',
    )
    assert.equal(f.provider.calls().length, 1)
  })
})

test('provider not_sent metadata becomes ambiguous and cannot trigger a second dispatch', async () => {
  const f = fixture({
    responder: async () => {
      const error = new Error('provider claimed not sent after dispatch')
      error.code = 'TIMEOUT'
      error.dispatchState = 'not_sent'
      throw error
    },
  })

  await withLedger(f.audit, async (ledger) => {
    const reliable = createReliableModelRouter({ provider: f.router, ledger, audit: f.audit, now: () => now })
    const context = { stage: 'decompose', taskId: 'ambiguous-task' }

    await assert.rejects(
      reliable.route('Do not dispatch twice.', context),
      (error) => error.code === 'MODEL_CALL_OUTCOME_UNKNOWN' && error.cause?.code === 'TIMEOUT',
    )
    await assert.rejects(
      reliable.route('Do not dispatch twice.', context),
      (error) => error.code === 'MODEL_CALL_OUTCOME_UNKNOWN',
    )
    assert.equal(f.provider.calls().length, 1)
  })
})

test('gateway denial remains a trusted pre-dispatch failure across the reliability layer', async () => {
  const f = fixture({ grantedResource: 'model:different-router' })

  await withLedger(f.audit, async (ledger) => {
    const reliable = createReliableModelRouter({ provider: f.router, ledger, audit: f.audit, now: () => now })
    const context = { stage: 'decompose', taskId: 'denied-task' }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(
        reliable.route('This must remain pre-dispatch.', context),
        (error) => error.code === 'MODEL_CALL_DENIED' && error.dispatchState === 'not_sent',
      )
    }
    assert.equal(f.provider.calls().length, 0)
  })
})
