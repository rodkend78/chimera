import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoryAuditLog } from '../src/audit-log.mjs'
import { OpenBotBrowserComputerAdapter } from '../src/browser/adapter.mjs'
import { ChromiumBrowserExecutor } from '../src/browser/executor.mjs'
import { ChimeraGateway } from '../src/gateway.mjs'
import {
  exportPublicKey,
  fingerprint,
  generateIdentity,
  signGrant,
  signHumanAction,
} from '../src/identity.mjs'

const policy = JSON.parse(await readFile(new URL('../config/policy.json', import.meta.url), 'utf8'))
const now = Date.parse('2026-08-23T18:00:00.000Z')
const activeWindow = {
  issuedAt: '2026-08-23T17:55:00.000Z',
  expiresAt: '2026-08-23T18:30:00.000Z',
}

async function fixture({ scopes, start = true } = {}) {
  const profileDir = await mkdtemp(join(tmpdir(), 'chimera-browser-adapter-'))
  const human = generateIdentity('rod')
  const agent = generateIdentity('ceo')
  const audit = new MemoryAuditLog()
  const realtimeAudit = new MemoryAuditLog()
  const gateway = new ChimeraGateway({
    policy: structuredClone(policy),
    humanKeys: [[human.keyId, exportPublicKey(human.publicKey)]],
    audit,
    now: () => now,
  })
  const grant = signGrant({
    grantId: crypto.randomUUID(),
    humanId: 'rod',
    agentId: 'ceo',
    agentKeyFingerprint: fingerprint(agent.publicKey),
    maxTier: 'confirm',
    scopes: scopes ?? [
      { capability: 'browser.observe', resourcePrefix: 'browser:ceo:' },
      { capability: 'browser.navigate', resourcePrefix: 'browser:ceo:' },
      { capability: 'browser.interact', resourcePrefix: 'browser:ceo:' },
      { capability: 'browser.input', resourcePrefix: 'browser:ceo:' },
    ],
    ...activeWindow,
  }, human)
  const adapter = new OpenBotBrowserComputerAdapter({
    sessionId: 'browser-ceo-1',
    agentId: 'ceo',
    humanId: 'rod',
    agentIdentity: agent,
    humanIdentity: human,
    grant,
    gateway,
    audit,
    realtimeAudit,
    profileDir,
    executor: new ChromiumBrowserExecutor({
      profileDir,

    }),
    now: () => now,
  })
  if (start) await adapter.start()
  return {
    adapter,
    agent,
    audit,
    realtimeAudit,
    gateway,
    grant,
    human,
    async close() {
      await adapter.close()
      await rm(profileDir, { recursive: true, force: true })
    },
  }
}

test('an in-scope signed agent action executes in live Chromium and is attributed', async () => {
  const f = await fixture()
  try {
    const navigated = await f.adapter.agentCommand({
      command: 'navigate',
      url: 'http://chimera.local/developments',
    })
    assert.equal(navigated.status, 'allowed')
    assert.equal(navigated.result.title, 'Latest AI Developments')

    const read = await f.adapter.agentCommand({ command: 'read' })
    assert.equal(read.status, 'allowed')
    assert.match(read.result.text, /Tracking the systems shaping applied AI/)

    const executed = f.audit.entries().find((entry) => (
      entry.fact.kind === 'browser.action'
      && entry.fact.command === 'navigate'
      && entry.fact.outcome === 'executed'
    ))
    assert.equal(executed.fact.actorId, 'ceo')
    assert.equal(executed.fact.actorType, 'agent')
    assert.equal(f.audit.verify().valid, true)
  } finally {
    await f.close()
  }
})

test('an action outside the signed agent grant is refused before Chromium navigation', async () => {
  const f = await fixture({
    scopes: [{ capability: 'browser.observe', resourcePrefix: 'browser:ceo:' }],
  })
  try {
    const before = f.adapter.state().tabs.find((tab) => tab.active).url
    const denied = await f.adapter.agentCommand({
      command: 'navigate',
      url: 'http://chimera.local/developments',
    })
    const after = f.adapter.state().tabs.find((tab) => tab.active).url

    assert.equal(denied.status, 'denied')
    assert.equal(denied.reason, 'OUTSIDE_GRANT_SCOPE')
    assert.equal(after, before)
    assert.equal(f.audit.entries().some((entry) => (
      entry.fact.kind === 'browser.action'
      && entry.fact.outcome === 'denied'
      && entry.fact.reason === 'OUTSIDE_GRANT_SCOPE'
    )), true)
  } finally {
    await f.close()
  }
})

test('a pending browser action exposes the exact signed payload for the decisions queue', async () => {
  const f = await fixture()
  try {
    const pending = await f.adapter.agentCommand({
      command: 'navigate',
      url: 'https://example.com/review',
    })
    const queued = f.adapter.pendingAction(pending.actionId)

    assert.equal(pending.status, 'pending')
    assert.equal(queued.action.payload.resource, 'browser:ceo:https://example.com/review')
    assert.equal(queued.action.payload.operation, 'navigate')
    assert.equal(queued.action.payload.agentId, 'ceo')
    assert.equal(queued.command.url, 'https://example.com/review')
  } finally {
    await f.close()
  }
})

test('a signed human takeover suspends agent actions without changing browser state', async () => {
  const f = await fixture()
  try {
    const before = f.adapter.state().tabs.find((tab) => tab.active).url
    assert.equal(f.adapter.takeControl().status, 'allowed')

    const denied = await f.adapter.agentCommand({ command: 'read' })
    assert.equal(denied.status, 'denied')
    assert.equal(denied.reason, 'HUMAN_CONTROL_ACTIVE')
    assert.equal(f.adapter.state().tabs.find((tab) => tab.active).url, before)
    assert.deepEqual(f.adapter.controller(), { type: 'human', id: 'rod' })
  } finally {
    await f.close()
  }
})

test('human takeover can open a blank tab and interact without the agent policy block', async () => {
  const f = await fixture()
  try {
    assert.equal(f.adapter.takeControl().status, 'allowed')
    const before = f.adapter.state().tabs.length

    const opened = await f.adapter.humanCommand({ command: 'open-tab', url: 'about:blank' })
    assert.equal(opened.status, 'allowed')
    assert.equal(opened.policyOverride, 'default')
    assert.equal(opened.result.tabs.length, before + 1)
    assert.equal(opened.result.tabs.some((tab) => tab.active && tab.url === 'about:blank'), true)

    const clicked = await f.adapter.humanStreamInput({ type: 'click', x: 10, y: 10 })
    assert.equal(clicked.status, 'allowed')
    assert.equal(f.realtimeAudit.entries().some((entry) => (
      entry.fact.kind === 'browser.action'
      && entry.fact.actorType === 'human'
      && entry.fact.command === 'stream-click'
      && entry.fact.outcome === 'executed'
    )), true)
    assert.equal(f.realtimeAudit.verify().valid, true)
    assert.equal(f.audit.verify().valid, true)
  } finally {
    await f.close()
  }
})

test('realtime human input never waits on the remote audit hot path', async () => {
  const f = await fixture()
  const append = f.audit.append.bind(f.audit)
  try {
    assert.equal(f.adapter.takeControl().status, 'allowed')
    f.audit.append = () => { throw new Error('REMOTE_AUDIT_HOT_PATH_TOUCHED') }

    const result = await f.adapter.humanStreamInput({ type: 'wheel', deltaX: 0, deltaY: 240 })

    assert.equal(result.status, 'allowed')
    assert.deepEqual(
      f.realtimeAudit.entries().slice(-2).map((entry) => [entry.fact.kind, entry.fact.command ?? entry.fact.outcome]),
      [
        ['action.decision', 'allowed'],
        ['browser.action', 'stream-wheel'],
      ],
    )
  } finally {
    f.audit.append = append
    await f.close()
  }
})

test('returning control anchors the realtime input audit head in the remote audit', async () => {
  const f = await fixture()
  try {
    assert.equal(f.adapter.takeControl().status, 'allowed')
    assert.equal((await f.adapter.humanStreamInput({ type: 'click', x: 10, y: 10 })).status, 'allowed')
    assert.equal(f.adapter.returnControl().status, 'allowed')

    const returned = f.audit.entries().findLast((entry) => entry.fact.kind === 'browser.control.returned')
    assert.equal(returned.fact.realtimeInputAudit.entries, 2)
    assert.match(returned.fact.realtimeInputAudit.headHash, /^[a-f0-9]{64}$/)
  } finally {
    await f.close()
  }
})

test('handback does not resume agent control when the current policy check fails', async () => {
  const f = await fixture({ start: false })
  try {
    assert.equal(f.adapter.takeControl().status, 'allowed')
    f.gateway.policy = {
      version: 1,
      defaultTier: 'blocked',
      rules: [],
    }

    const denied = f.adapter.returnControl()
    assert.equal(denied.status, 'denied')
    assert.equal(denied.reason, 'POLICY_BLOCKED')
    assert.deepEqual(f.adapter.controller(), { type: 'human', id: 'rod' })
  } finally {
    await f.close()
  }
})

test('a forged takeover event is rejected and enters the audit chain', async () => {
  const f = await fixture({ start: false })
  try {
    const attacker = generateIdentity('attacker')
    const forged = signHumanAction({
      actionId: 'forged-takeover',
      humanId: 'rod',
      sessionId: 'browser-ceo-1',
      capability: 'browser.control',
      resource: 'browser:ceo:browser-ceo-1',
      operation: 'take_control',
      ...activeWindow,
    }, attacker)

    const denied = f.adapter.takeControl({ action: forged })
    assert.equal(denied.status, 'denied')
    assert.equal(denied.reason, 'HUMAN_ACTION_SIGNATURE_INVALID')
    assert.deepEqual(f.adapter.controller(), { type: 'agent', id: 'ceo' })
    assert.equal(f.audit.entries().some((entry) => (
      entry.fact.kind === 'browser.control.rejected'
      && entry.fact.actionId === 'forged-takeover'
      && entry.fact.authority === 'unverified'
    )), true)
    assert.equal(f.audit.verify().valid, true)
  } finally {
    await f.close()
  }
})
