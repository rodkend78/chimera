import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { MemoryAuditLog } from '../src/audit-log.mjs'
import { ChimeraGateway } from '../src/gateway.mjs'
import {
  exportPublicKey,
  fingerprint,
  generateIdentity,
  signAction,
  signDecision,
  signGrant,
  signHumanAction,
} from '../src/identity.mjs'

const policy = JSON.parse(readFileSync(new URL('../config/policy.json', import.meta.url), 'utf8'))
const now = Date.parse('2026-08-22T07:00:00.000Z')
const activeWindow = {
  issuedAt: '2026-08-22T06:55:00.000Z',
  expiresAt: '2026-08-22T07:15:00.000Z',
}

function fixture({ maxTier = 'confirm', scopes } = {}) {
  const human = generateIdentity('rod')
  const agent = generateIdentity('researcher')
  const audit = new MemoryAuditLog()
  const gateway = new ChimeraGateway({
    policy,
    humanKeys: [[human.keyId, exportPublicKey(human.publicKey)]],
    audit,
    now: () => now,
  })
  const grant = signGrant({
    grantId: 'grant-1',
    humanId: 'rod',
    agentId: 'researcher',
    agentKeyFingerprint: fingerprint(agent.publicKey),
    maxTier,
    scopes: scopes ?? [
      { capability: 'filesystem.read', resourcePrefix: 'workspace/' },
      { capability: 'filesystem.write', resourcePrefix: 'workspace/' },
      { capability: 'external.message', resource: 'telegram:chimera-hq' },
      { capability: 'credential.read', resourcePrefix: '' },
    ],
    ...activeWindow,
  }, human)
  return { human, agent, audit, gateway, grant }
}

function action(agent, overrides = {}) {
  return signAction({
    actionId: overrides.actionId ?? crypto.randomUUID(),
    agentId: 'researcher',
    capability: 'filesystem.read',
    resource: 'workspace/source.md',
    operation: 'read',
    ...activeWindow,
    ...overrides,
  }, agent)
}

function humanAction(human, overrides = {}) {
  return signHumanAction({
    actionId: overrides.actionId ?? crypto.randomUUID(),
    humanId: 'rod',
    sessionId: 'browser-ceo-1',
    capability: 'browser.navigate',
    resource: 'browser:ceo:about:blank',
    operation: 'open-tab',
    ...activeWindow,
    ...overrides,
  }, human)
}

test('auto tier accepts a signed action covered by a signed delegation grant', () => {
  const f = fixture()
  const result = f.gateway.submit({ grant: f.grant, action: action(f.agent) })
  assert.equal(result.status, 'allowed')
  assert.equal(result.tier, 'auto')
  assert.equal(f.audit.verify().valid, true)
})

test('confirm tier requires a matching one-time human signature', () => {
  const f = fixture()
  const signedAction = action(f.agent, {
    actionId: 'send-1',
    capability: 'external.message',
    resource: 'telegram:chimera-hq',
    operation: 'send',
  })
  const pending = f.gateway.submit({ grant: f.grant, action: signedAction })
  assert.equal(pending.status, 'pending')

  const result = f.gateway.decide(signDecision({
    actionId: 'send-1',
    challengeHash: pending.challengeHash,
    outcome: 'approve',
    ...activeWindow,
  }, f.human))
  assert.equal(result.status, 'allowed')
  assert.equal(result.tier, 'confirm')
})

test('a cancelled pending action cannot be approved later', () => {
  const f = fixture()
  const pending = f.gateway.submit({
    grant: f.grant,
    action: action(f.agent, {
      actionId: 'cancelled-send',
      capability: 'external.message',
      resource: 'telegram:chimera-hq',
      operation: 'send',
    }),
  })
  assert.equal(pending.status, 'pending')

  const cancelled = f.gateway.cancelPending('cancelled-send', 'PROCESS_RESTARTED')
  assert.equal(cancelled.status, 'denied')
  assert.equal(cancelled.actionId, 'cancelled-send')
  assert.equal(cancelled.reason, 'PROCESS_RESTARTED')
  const late = f.gateway.decide(signDecision({
    actionId: 'cancelled-send', challengeHash: pending.challengeHash, outcome: 'approve', ...activeWindow,
  }, f.human))
  assert.equal(late.status, 'denied')
  assert.equal(late.reason, 'NO_PENDING_ACTION')
})

test('blocked capability stays denied even when named in a grant', () => {
  const f = fixture()
  const result = f.gateway.submit({
    grant: f.grant,
    action: action(f.agent, {
      capability: 'credential.read',
      resource: 'aws:production',
      operation: 'read',
    }),
  })
  assert.equal(result.status, 'denied')
  assert.equal(result.reason, 'POLICY_BLOCKED')
})

test('signed human browser actions bypass only the fail-closed default policy', () => {
  const f = fixture()
  const opened = f.gateway.submitHuman({
    action: humanAction(f.human, { actionId: 'human-open-tab' }),
  })
  assert.equal(opened.status, 'allowed')
  assert.equal(opened.tier, 'auto')
  assert.equal(opened.policyOverride, 'default')

  const decision = f.audit.entries().find((entry) => entry.fact.actionId === 'human-open-tab')
  assert.equal(decision.fact.policyRuleId, 'human-browser-control')
  assert.equal(decision.fact.policyOverride, 'default')
  assert.equal(decision.fact.policyOverrideTier, 'blocked')

  const nonBrowser = f.gateway.submitHuman({
    action: humanAction(f.human, {
      actionId: 'human-credential-read',
      capability: 'credential.read',
      resource: 'aws:production',
      operation: 'read',
    }),
  })
  assert.equal(nonBrowser.status, 'denied')
  assert.equal(nonBrowser.reason, 'POLICY_BLOCKED')

  f.gateway.policy = {
    version: 1,
    defaultTier: 'confirm',
    rules: [],
  }
  const explicitlyConfirm = f.gateway.submitHuman({
    action: humanAction(f.human, { actionId: 'human-default-confirm' }),
  })
  assert.equal(explicitlyConfirm.status, 'allowed')
  assert.equal(explicitlyConfirm.tier, 'confirm')
  assert.equal(explicitlyConfirm.policyOverride, undefined)

  f.gateway.policy = {
    version: 1,
    defaultTier: 'blocked',
    rules: [{
      id: 'explicit-human-browser-block',
      capability: 'browser.navigate',
      resourcePrefix: 'browser:ceo:',
      tier: 'blocked',
    }],
  }
  const explicitlyBlocked = f.gateway.submitHuman({
    action: humanAction(f.human, { actionId: 'human-explicit-block' }),
  })
  assert.equal(explicitlyBlocked.status, 'denied')
  assert.equal(explicitlyBlocked.reason, 'POLICY_BLOCKED')
})

test('unknown capabilities fail closed', () => {
  const f = fixture({
    scopes: [{ capability: 'future.capability', resourcePrefix: '' }],
  })
  const result = f.gateway.submit({
    grant: f.grant,
    action: action(f.agent, {
      capability: 'future.capability',
      resource: 'anything',
      operation: 'do',
    }),
  })
  assert.equal(result.status, 'denied')
  assert.equal(result.reason, 'POLICY_BLOCKED')
})

test('forged action signatures are denied', () => {
  const f = fixture()
  const forged = action(f.agent, { actionId: 'forged-1' })
  forged.payload.resource = 'workspace/tampered.md'
  const result = f.gateway.submit({ grant: f.grant, action: forged })
  assert.equal(result.status, 'denied')
  assert.equal(result.reason, 'ACTION_SIGNATURE_INVALID')
})

test('expired grants are denied', () => {
  const f = fixture()
  const expired = signGrant({
    ...f.grant.payload,
    issuedAt: '2026-08-22T05:00:00.000Z',
    expiresAt: '2026-08-22T06:00:00.000Z',
  }, f.human)
  const result = f.gateway.submit({ grant: expired, action: action(f.agent) })
  assert.equal(result.status, 'denied')
  assert.equal(result.reason, 'GRANT_EXPIRED_OR_NOT_ACTIVE')
})

test('action ids cannot be replayed', () => {
  const f = fixture()
  const signedAction = action(f.agent, { actionId: 'once' })
  assert.equal(f.gateway.submit({ grant: f.grant, action: signedAction }).status, 'allowed')
  const replay = f.gateway.submit({ grant: f.grant, action: signedAction })
  assert.equal(replay.status, 'denied')
  assert.equal(replay.reason, 'REPLAYED_ACTION')
})

test('audit verification detects altered history', () => {
  const f = fixture()
  f.gateway.submit({ grant: f.grant, action: action(f.agent) })
  const altered = f.audit.entries()
  altered[0].fact.outcome = 'denied'
  const verification = f.audit.verify(altered)
  assert.equal(verification.valid, false)
  assert.equal(verification.reason, 'ENTRY_HASH_MISMATCH')
})

test('malformed untrusted envelopes fail closed instead of throwing', () => {
  const f = fixture()
  const result = f.gateway.submit({ grant: { payload: {} }, action: { payload: {} } })
  assert.equal(result.status, 'denied')
  assert.equal(result.reason, 'MALFORMED_REQUEST')
})

test('an exact resource rule does not authorize a lookalike destination', () => {
  const f = fixture({
    scopes: [{ capability: 'external.message', resourcePrefix: 'telegram:' }],
  })
  const result = f.gateway.submit({
    grant: f.grant,
    action: action(f.agent, {
      capability: 'external.message',
      resource: 'telegram:chimera-hq-evil',
      operation: 'send',
    }),
  })
  assert.equal(result.status, 'denied')
  assert.equal(result.reason, 'POLICY_BLOCKED')
})
