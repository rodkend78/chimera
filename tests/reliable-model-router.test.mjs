import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoryAuditLog } from '../src/audit-log.mjs'
import { sha256 } from '../src/canonical.mjs'
import {
  createDeterministicModelRouter,
  createReliableModelRouter,
  DurableModelCallLedger,
} from '../src/ceo/index.mjs'

const now = Date.parse('2026-08-27T18:00:00.000Z')

async function fixture(responder) {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-model-ledger-'))
  const audit = new MemoryAuditLog()
  const ledgerPath = join(directory, '.chimera/model-calls/events.jsonl')
  const ledger = await DurableModelCallLedger.open({
    filePath: ledgerPath,
    audit,
    now: () => now,
  })
  const provider = createDeterministicModelRouter({
    routerId: 'provider-router',
    responder,
  })
  const authorizationScope = 'agent:ceo:grant:test'
  const authorizingProvider = Object.freeze({
    routerId: provider.routerId,
    authorizationScope,
    async authorize(prompt, context = {}) {
      return Object.freeze({
        authorizationScope,
        requestHash: sha256({ prompt, context }),
        dispatch: () => provider.route(prompt, context),
      })
    },
    route: (prompt, context) => provider.route(prompt, context),
  })
  const router = createReliableModelRouter({
    provider: authorizingProvider,
    ledger,
    audit,
    now: () => now,
  })
  return {
    audit,
    directory,
    ledger,
    ledgerPath,
    provider,
    router,
    async close() {
      await rm(directory, { recursive: true, force: true })
    },
  }
}

test('concurrent calls for one logical model turn share one provider request', async () => {
  let release
  let markStarted
  const gate = new Promise((resolve) => { release = resolve })
  const started = new Promise((resolve) => { markStarted = resolve })
  const f = await fixture(async () => {
    markStarted()
    await gate
    return { tasks: [{ specialistAgentId: 'researcher' }] }
  })
  try {
    const context = { stage: 'decompose', taskId: 'task-1' }
    const first = f.router.route('Create a bounded plan.', context)
    const second = f.router.route('Create a bounded plan.', context)

    await started
    assert.equal(f.provider.calls().length, 1)
    release()
    assert.deepEqual(await first, await second)
    assert.equal(f.provider.calls().length, 1)

    const kinds = f.audit.entries().map((entry) => entry.fact.kind)
    assert.equal(kinds.filter((kind) => kind === 'model.call.started').length, 1)
    assert.equal(kinds.filter((kind) => kind === 'model.call.succeeded').length, 1)
  } finally {
    await f.close()
  }
})

test('a completed logical turn replays its durable result after restart', async () => {
  const f = await fixture(async () => ({ summary: 'Durable answer.' }))
  try {
    const context = { stage: 'synthesize', taskId: 'task-2' }
    const expected = await f.router.route('Synthesize the result.', context)
    assert.equal(f.provider.calls().length, 1)

    const reloadedLedger = await DurableModelCallLedger.open({
      filePath: f.ledgerPath,
      audit: f.audit,
      now: () => now,
    })
    const replacementProvider = createDeterministicModelRouter({
      routerId: 'provider-router',
      responder: async () => { throw new Error('provider must not be called') },
    })
    const authorizationScope = 'agent:ceo:grant:test'
    const restartedProvider = Object.freeze({
      routerId: replacementProvider.routerId,
      authorizationScope,
      async authorize(prompt, replayContext = {}) {
        return Object.freeze({
          authorizationScope,
          requestHash: sha256({ prompt, context: replayContext }),
          dispatch: () => replacementProvider.route(prompt, replayContext),
        })
      },
      route: (prompt, replayContext) => replacementProvider.route(prompt, replayContext),
    })
    const restarted = createReliableModelRouter({
      provider: restartedProvider,
      ledger: reloadedLedger,
      audit: f.audit,
      now: () => now,
    })

    assert.deepEqual(await restarted.route('Synthesize the result.', context), expected)
    assert.equal(replacementProvider.calls().length, 0)
    assert.equal(f.audit.entries().some((entry) => entry.fact.kind === 'model.call.replayed'), true)
  } finally {
    await f.close()
  }
})

test('an already-dispatched failure becomes ambiguous and is never retried automatically', async () => {
  let attempts = 0
  const f = await fixture(async () => {
    attempts += 1
    const error = new Error('stream timed out after dispatch')
    error.code = 'TIMEOUT'
    error.dispatchState = 'sent'
    throw error
  })
  try {
    const context = { stage: 'decompose', taskId: 'task-3' }
    await assert.rejects(
      f.router.route('Do not duplicate this turn.', context),
      (error) => error.code === 'MODEL_CALL_OUTCOME_UNKNOWN' && error.cause?.code === 'TIMEOUT',
    )
    await assert.rejects(
      f.router.route('Do not duplicate this turn.', context),
      (error) => error.code === 'MODEL_CALL_OUTCOME_UNKNOWN',
    )
    assert.equal(attempts, 1)
    assert.equal(f.audit.entries().some((entry) => entry.fact.kind === 'model.call.ambiguous'), true)
  } finally {
    await f.close()
  }
})

test('provider supplied not_sent metadata is ambiguous and cannot authorize a retry', async () => {
  let attempts = 0
  const f = await fixture(async () => {
    attempts += 1
    const error = new Error('provider claimed the request was not sent')
    error.code = 'TIMEOUT'
    error.dispatchState = 'not_sent'
    throw error
  })
  try {
    const context = { stage: 'synthesize', taskId: 'task-4' }
    await assert.rejects(
      f.router.route('Retry only when nothing was sent.', context),
      (error) => error.code === 'MODEL_CALL_OUTCOME_UNKNOWN' && error.cause?.code === 'TIMEOUT',
    )
    await assert.rejects(
      f.router.route('Retry only when nothing was sent.', context),
      (error) => error.code === 'MODEL_CALL_OUTCOME_UNKNOWN',
    )
    assert.equal(attempts, 1)
  } finally {
    await f.close()
  }
})
