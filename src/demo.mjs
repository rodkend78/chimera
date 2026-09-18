import { readFileSync } from 'node:fs'
import { MemoryAuditLog } from './audit-log.mjs'
import { ChimeraGateway } from './gateway.mjs'
import {
  exportPublicKey,
  fingerprint,
  generateIdentity,
  signAction,
  signDecision,
  signGrant,
} from './identity.mjs'

const policy = JSON.parse(readFileSync(new URL('../config/policy.json', import.meta.url), 'utf8'))
const human = generateIdentity('rod-demo')
const agent = generateIdentity('researcher-demo')
const now = Date.parse('2026-08-22T07:00:00.000Z')
const window = {
  issuedAt: '2026-08-22T06:55:00.000Z',
  expiresAt: '2026-08-22T07:15:00.000Z',
}
const grant = signGrant({
  grantId: 'grant-demo-001',
  humanId: 'rod-demo',
  agentId: 'researcher-demo',
  agentKeyFingerprint: fingerprint(agent.publicKey),
  maxTier: 'confirm',
  scopes: [
    { capability: 'filesystem.read', resourcePrefix: 'workspace/' },
    { capability: 'external.message', resource: 'telegram:chimera-hq' },
    { capability: 'credential.read', resourcePrefix: '' },
  ],
  ...window,
}, human)

const audit = new MemoryAuditLog()
const gateway = new ChimeraGateway({
  policy,
  humanKeys: [[human.keyId, exportPublicKey(human.publicKey)]],
  audit,
  now: () => now,
})

const read = gateway.submit({
  grant,
  action: signAction({
    actionId: 'action-read-001',
    agentId: 'researcher-demo',
    capability: 'filesystem.read',
    resource: 'workspace/research/brief.md',
    operation: 'read',
    ...window,
  }, agent),
})

const messageAction = signAction({
  actionId: 'action-message-001',
  agentId: 'researcher-demo',
  capability: 'external.message',
  resource: 'telegram:chimera-hq',
  operation: 'send',
  ...window,
}, agent)
const pending = gateway.submit({ grant, action: messageAction })
const message = gateway.decide(signDecision({
  actionId: messageAction.payload.actionId,
  challengeHash: pending.challengeHash,
  outcome: 'approve',
  ...window,
}, human))

const blocked = gateway.submit({
  grant,
  action: signAction({
    actionId: 'action-secret-001',
    agentId: 'researcher-demo',
    capability: 'credential.read',
    resource: 'aws:production',
    operation: 'read',
    ...window,
  }, agent),
})

console.log(JSON.stringify({ read, pending, message, blocked }, null, 2))
console.log(`AUDIT_CHAIN_VALID=${audit.verify().valid}`)
console.log(`AUDIT_ENTRIES=${audit.entries().length}`)
