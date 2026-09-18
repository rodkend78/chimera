import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ChimeraBrowserRuntime } from '../src/browser/runtime.mjs'
import { createDeterministicModelRouter } from '../src/ceo/model-router.mjs'
import { fingerprint, signAction } from '../src/identity.mjs'

function memoryBrowserExecutor() {
  const state = { running: true, tabs: [{ tabId: 'tab-1', title: 'New tab', url: 'about:blank', active: true }] }
  return {
    async start() { return structuredClone(state) },
    async state() { return structuredClone(state) },
    async suspend() { state.running = false; return structuredClone(state) },
    async close() {},
    allowTemporaryNavigation() {},
  }
}

function modelRegistry() {
  return {
    state: () => ({ schema: 'chimera.model-provider-registry.v2', selected: null, providers: [] }),
    router: () => createDeterministicModelRouter({ responder: async () => ({ summary: 'unused' }) }),
    async select() {},
  }
}

test('runtime start does not queue a fake Telegram HQ decision', async () => {
  const runtimeSource = await readFile(new URL('../src/browser/runtime.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(runtimeSource, /#queueTelegramDecision/)
  assert.doesNotMatch(runtimeSource, /Send message to Telegram HQ/)
  assert.doesNotMatch(runtimeSource, /no Telegram executor attached/)
})

test('runtime restart preserves actor authority, replay rejection, audit history, and terminalizes pending decisions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-runtime-restart-'))
  const now = Date.parse('2026-08-30T18:00:00.000Z')
  const options = () => ({
    profileDir: join(directory, 'browser/ceo'),
    decisionFile: join(directory, 'decisions/queue.jsonl'),
    taskFile: join(directory, 'tasks/events.jsonl'),
    conversationFile: join(directory, 'conversations/messages.jsonl'),
    modelCallFile: join(directory, 'model-calls/events.jsonl'),
    agentFile: join(directory, 'agents/registry.json'),
    identityFile: join(directory, 'identity/actors.json'),
    replayFile: join(directory, 'gateway/replay.jsonl'),
    auditFile: join(directory, 'audit/events.jsonl'),
    agentDiscovery: { async discover() { return { schema: 'chimera.agent-discovery.v1', source: { id: 'fixture' }, candidates: [] } } },
    modelRegistry: modelRegistry(),
    browserExecutor: memoryBrowserExecutor(),
    now: () => now,
  })
  let first
  let restarted
  try {
    first = new ChimeraBrowserRuntime(options())
    await first.start()
    const humanFingerprint = fingerprint(first.human.publicKey)
    const agentFingerprint = fingerprint(first.agent.publicKey)
    assert.equal(first.decisions.pending().length, 0)
    assert.equal((await first.state()).decisions.some((decision) => /telegram/i.test(decision.title ?? '')), false)
    await first.decisions.post({
      actionId: 'restart-pending-proof',
      challengeHash: 'restart-pending-challenge-hash',
      actionDiff: { operation: 'observe' },
      resource: 'browser:ceo:tab-1',
      expiresAt: new Date(now + 60_000).toISOString(),
      agent: {
        agentId: first.agentId,
        grantId: first.grant.payload.grantId,
        keyFingerprint: agentFingerprint,
      },
      policyRationale: {
        ruleId: 'browser-adapter',
        tier: 'confirm',
        reason: 'TEST_PENDING_DECISION',
      },
      title: 'RJ wants to observe a tab',
      detail: 'Restart proof pending decision',
    })
    const originalPending = first.decisions.pending()[0]
    assert.ok(originalPending)

    const actionPayload = {
      actionId: 'restart-replay-proof',
      agentId: 'ceo',
      capability: 'browser.observe',
      resource: 'browser:ceo:tab-1',
      operation: 'observe',
      issuedAt: new Date(now - 1_000).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
    }
    assert.equal(first.gateway.submit({ grant: first.grant, action: signAction(actionPayload, first.agent) }).status, 'allowed')
    const auditCount = first.audit.entries().length
    await first.close()
    first = null

    restarted = new ChimeraBrowserRuntime(options())
    await restarted.start()
    assert.equal(fingerprint(restarted.human.publicKey), humanFingerprint)
    assert.equal(fingerprint(restarted.agent.publicKey), agentFingerprint)
    assert.equal(restarted.decisions.get(originalPending.actionId).status, 'cancelled')
    const replay = restarted.gateway.submit({ grant: restarted.grant, action: signAction(actionPayload, restarted.agent) })
    assert.equal(replay.status, 'denied')
    assert.equal(replay.reason, 'REPLAYED_ACTION')
    assert.ok(restarted.audit.entries().length > auditCount)
    assert.equal(restarted.audit.verify().valid, true)
  } finally {
    await first?.close()
    await restarted?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
