import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DurableAgentMailbox } from '../src/agents/mailbox.mjs'
import { MemoryAuditLog } from '../src/audit-log.mjs'
import { generateIdentity, signGrant, fingerprint, exportPublicKey } from '../src/identity.mjs'
import { SignedSpecialistStub } from '../src/ceo/specialist-stub.mjs'
import { TeamDispatcher, teamMessagingProjection } from '../src/agents/team-dispatcher.mjs'

const gate = () => { let release; const promise = new Promise(r => { release = r }); return { promise, release } }
async function fixture(t, execute, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-team-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const audit = new MemoryAuditLog(), human = generateIdentity('human')
  const ids = ['ceo', 'ace', 'iris', 'bob', 'eve', 'max', 'zoe']
  const humanKeys = [[human.keyId, exportPublicKey(human.publicKey)]]
  const gateway = { submit: () => ({ status: 'allowed', actionId: 'verified-action' }) }
  const agents = new Map(ids.map(agentId => {
    const identity = generateIdentity(agentId)
    const grant = signGrant({ grantId: `grant-${agentId}`, humanId: 'human', agentId,
      agentKeyFingerprint: fingerprint(identity.publicKey), maxTier: 'auto', taskId: 'root',
      issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString(),
      scopes: ids.flatMap(id => ['task_handoff', 'structured_result'].map(type => ({ capability: `agent.message.${type}`, resource: `agent:${id}` }))),
    }, human)
    return [agentId, new SignedSpecialistStub({ agentId, identity, grant, gateway, audit, humanKeys,
      execute: (request, content, envelope) => execute(agentId, content, envelope) })]
  }))
  const mailbox = await DurableAgentMailbox.open({ filePath: join(directory, 'mailbox.jsonl'), audit })
  let resolves = 0
  const dispatcher = new TeamDispatcher({ taskId: 'root', root: agents.get('ceo'), mailbox, gateway, humanKeys,
    eligibleAgentIds: ids.slice(1), resolveSpecialist: async id => { resolves++; return agents.get(id) }, ...options })
  return { dispatcher, mailbox, agents, resolves: () => resolves,
    reopen: () => DurableAgentMailbox.open({ filePath: join(directory, 'mailbox.jsonl'), audit }) }
}

test('nested ask and explicit terminal reply are signed, correlated and durable', async t => {
  let f
  f = await fixture(t, async (id, content, envelope) => {
    if (id === 'ace') {
      const result = await f.dispatcher.executePeerTool(envelope.messageId, 'agent_ask', { recipientAgentId: 'iris', objective: 'Evidence?' })
      assert.equal(result.status, 'succeeded')
      assert.equal(result.result.summary, 'Evidence 42')
      return { summary: 'Used evidence 42' }
    }
    return { summary: 'Evidence 42' }
  })
  const result = await f.dispatcher.delegate({ specialistAgentId: 'ace', objective: 'Research', acceptanceCriteria: ['Evidence'] })
  assert.equal(result.status, 'succeeded')
  assert.equal((await f.dispatcher.drain()).length, 2)
  assert.equal(f.mailbox.list({ taskId: 'root' }).filter(row => row.status === 'completed').length, 2)
  assert.equal(f.dispatcher.state().deliveries.length, 4)
})

test('send returns delivery before completion; draining waits and serializes same agent', async t => {
  const release = gate(), entered = gate(); let active = 0, maximum = 0, f
  f = await fixture(t, async (id, content, envelope) => {
    if (id === 'ace') {
      const a = await f.dispatcher.executePeerTool(envelope.messageId, 'agent_send', { recipientAgentId: 'iris', objective: 'One' })
      const b = await f.dispatcher.executePeerTool(envelope.messageId, 'agent_send', { recipientAgentId: 'iris', objective: 'Two' })
      assert.equal(a.status, 'queued'); assert.notEqual(a.messageId, b.messageId)
      return { summary: 'Queued' }
    }
    active++; maximum = Math.max(maximum, active); entered.release(); await release.promise; active--
    return { summary: content.objective }
  })
  await f.dispatcher.delegate({ specialistAgentId: 'ace', objective: 'Research', acceptanceCriteria: ['Evidence'] })
  await entered.promise
  let drained = false
  const drain = f.dispatcher.drain().then(() => { drained = true })
  await new Promise(r => setTimeout(r, 20)); assert.equal(drained, false)
  release.release(); await drain
  assert.equal(maximum, 1); assert.equal(f.resolves(), 2)
})

test('peer scope, forged parent, ancestor waits and bounded concurrency are enforced', async t => {
  let f
  f = await fixture(t, async (id, _content, envelope) => {
    await assert.rejects(f.dispatcher.executePeerTool(envelope.messageId, 'agent_ask', { recipientAgentId: id, objective: 'Self' }), { code: 'TEAM_DEPENDENCY_CYCLE' })
    await assert.rejects(f.dispatcher.executePeerTool(envelope.messageId, 'agent_send', { recipientAgentId: 'stranger', objective: 'Escape' }), { code: 'TEAM_PEER_NOT_ELIGIBLE' })
    await assert.rejects(f.dispatcher.executePeerTool(envelope.messageId, 'agent_reply', { parentMessageId: 'fake', summary: 'Forged' }), { code: 'TEAM_TOOL_ARGUMENT_INVALID' })
    return { summary: 'Validated' }
  })
  assert.equal((await f.dispatcher.delegate({ specialistAgentId: 'ace', objective: 'Check', acceptanceCriteria: ['Safety'] })).status, 'succeeded')
})

test('timeout fences late effects and keeps agent physically busy until executor settles', async t => {
  const release = gate(), entered = gate(); let f, lateCode
  f = await fixture(t, async (id, _content, envelope) => {
    entered.release(); await release.promise
    try { f.dispatcher.assertJobActive(envelope.messageId) } catch (e) { lateCode = e.code; throw e }
    return { summary: id }
  }, { waitMs: 30 })
  const result = f.dispatcher.delegate({ specialistAgentId: 'ace', objective: 'Delayed', acceptanceCriteria: ['Answer'] })
  await entered.promise
  assert.equal((await result).reason, 'TEAM_WAIT_TIMEOUT_OUTCOME_UNKNOWN')
  assert.equal(f.dispatcher.state().deliveries[0].status, 'interrupted')
  let done = false
  const drain = f.dispatcher.drain().then(() => { done = true })
  await new Promise(r => setTimeout(r, 10)); assert.equal(done, false)
  release.release(); await drain
  assert.equal(lateCode, 'TEAM_JOB_INACTIVE')
})

test('at most four jobs execute while asking parent releases a slot', async t => {
  const release = gate(), entered = gate(); let f, active = 0, maximum = 0
  f = await fixture(t, async (id, _content, envelope) => {
    if (id === 'ace') {
      for (const target of ['iris', 'bob', 'eve']) await f.dispatcher.executePeerTool(envelope.messageId, 'agent_send', { recipientAgentId: target, objective: 'Wait' })
      return f.dispatcher.executePeerTool(envelope.messageId, 'agent_ask', { recipientAgentId: 'max', objective: 'Wait' })
    }
    active++; maximum = Math.max(active, maximum)
    if (active === 4) entered.release()
    await release.promise; active--; return { summary: id }
  })
  const root = f.dispatcher.delegate({ specialistAgentId: 'ace', objective: 'Fan out', acceptanceCriteria: ['Bound'] })
  await entered.promise; assert.equal(maximum, 4); release.release(); await root; await f.dispatcher.drain()
})

test('cross-root busy dependency cycle is rejected without deadlock', async t => {
  const both = gate(); let started = 0, f
  f = await fixture(t, async (id, _content, envelope) => {
    if (++started === 2) both.release()
    await both.promise
    try { await f.dispatcher.executePeerTool(envelope.messageId, 'agent_ask', { recipientAgentId: id === 'ace' ? 'iris' : 'ace', objective: 'Mutual wait' }) }
    catch (e) { assert.equal(e.code, 'TEAM_DEPENDENCY_CYCLE') }
    return { summary: id }
  }, { waitMs: 80 })
  await Promise.all(['ace', 'iris'].map(specialistAgentId => f.dispatcher.delegate({ specialistAgentId, objective: 'Root', acceptanceCriteria: ['Bound'] })))
  await f.dispatcher.drain()
  assert.ok(f.dispatcher.state().deliveries.length <= 6)
  assert.ok(f.dispatcher.state().deliveries.every(row => !row.reason?.includes('TIMEOUT')))
})

test('projection failure after delivery cannot strand a durable queued job', async t => {
  let ran = false
  const f = await fixture(t, async () => { ran = true; return { summary: 'Forbidden' } }, { onEvent: async () => { throw new Error('projection unavailable') } })
  const result = await f.dispatcher.delegate({ specialistAgentId: 'ace', objective: 'Root', acceptanceCriteria: ['Bound'] })
  assert.equal(result.reason, 'TEAM_PROJECTION_FAILED')
  await f.dispatcher.close()
  assert.equal(ran, false)
  assert.equal(f.mailbox.list()[0].status, 'interrupted')
})

test('durability failure during timeout settles waiter but close retains the physical lock', async t => {
  const release = gate(), entered = gate()
  const f = await fixture(t, async () => { entered.release(); await release.promise; return { summary: 'Late' } }, { waitMs: 40 })
  const work = f.dispatcher.delegate({ specialistAgentId: 'ace', objective: 'Root', acceptanceCriteria: ['Bound'] })
  await entered.promise
  f.mailbox.interrupt = async () => { throw new Error('fsync failed') }
  const result = await work
  assert.equal(result.durabilityReason, 'TEAM_INTERRUPTION_DURABILITY_FAILED')
  let closed = false
  const close = f.dispatcher.close().then(() => { closed = true })
  await new Promise(r => setTimeout(r, 10)); assert.equal(closed, false)
  release.release(); await close
})

test('drain waits for terminal persistence as well as physical executor settlement', async t => {
  const release = gate(), entered = gate(), persistEntered = gate(), persistRelease = gate()
  const f = await fixture(t, async () => { entered.release(); await release.promise; return { summary: 'Late' } }, { waitMs: 30 })
  const interrupt = f.mailbox.interrupt.bind(f.mailbox)
  f.mailbox.interrupt = async input => { persistEntered.release(); await persistRelease.promise; return interrupt(input) }
  const work = f.dispatcher.delegate({ specialistAgentId: 'ace', objective: 'Root', acceptanceCriteria: ['Bound'] })
  await entered.promise; await persistEntered.promise; release.release()
  let drained = false
  const drain = f.dispatcher.drain().then(results => { drained = true; return results })
  await new Promise(r => setTimeout(r, 15)); const prematurelyDrained = drained
  persistRelease.release(); await work
  const results = await drain
  assert.equal(prematurelyDrained, false)
  assert.equal(results[0].reason, 'TEAM_WAIT_TIMEOUT_OUTCOME_UNKNOWN')
})

for (const ending of ['timeout', 'close']) test(`durable completion stays immutable during result projection ${ending}`, async t => {
  const entered = gate(), release = gate()
  const f = await fixture(t, async () => ({ summary: 'Durable success.' }), {
    waitMs: 60,
    onEvent: async event => { if (event.kind === 'structured_result') { entered.release(); await release.promise } },
  })
  const work = f.dispatcher.delegate({ specialistAgentId: 'ace', objective: 'Complete', acceptanceCriteria: ['Bound'] })
  await entered.promise
  const closing = ending === 'close' ? f.dispatcher.close('TASK_CANCELLED') : null
  const result = await work
  if (ending === 'timeout') await new Promise(resolve => setTimeout(resolve, 80))
  release.release(); await closing
  const [drained] = await f.dispatcher.drain()
  assert.deepEqual(result, drained)
  assert.equal(result.status, 'succeeded')
  assert.equal(f.mailbox.list()[0].status, 'completed')
})

for (const boundary of ['before', 'after']) test(`timeout selects the journal outcome ${boundary} atomic reply commit`, async t => {
  const entered = gate(), release = gate()
  const events = []
  const f = await fixture(t, async () => ({ summary: 'Durable result.' }), { waitMs: 50, onEvent: async event => { events.push(event) } })
  const complete = f.mailbox.completeWithReply.bind(f.mailbox)
  f.mailbox.completeWithReply = async input => {
    if (boundary === 'before') { entered.release(); await release.promise; return complete(input) }
    const result = await complete(input); entered.release(); await release.promise; return result
  }
  const work = f.dispatcher.delegate({ specialistAgentId: 'ace', objective: 'Complete', acceptanceCriteria: ['Bound'] })
  await entered.promise
  const result = await work
  release.release()
  assert.deepEqual((await f.dispatcher.drain())[0], result)
  assert.equal(result.status, boundary === 'before' ? 'failed' : 'succeeded')
  assert.equal(f.mailbox.list()[0].status, boundary === 'before' ? 'interrupted' : 'completed')
  assert.equal(events.filter(event => event.kind === 'structured_result').length, boundary === 'before' ? 0 : 1)
})

for (const boundary of ['deliver', 'event', 'claim']) test(`root proposal guard fences stale work after awaited ${boundary}`, async t => {
  const entered = gate(), release = gate(); let revision = 0, executions = 0
  const f = await fixture(t, async () => { executions++; return { summary: 'Obsolete' } }, {
    onEvent: async event => { if (boundary === 'event' && event.kind === 'task_handoff') { entered.release(); await release.promise } },
  })
  if (boundary !== 'event') {
    const original = f.mailbox[boundary].bind(f.mailbox)
    f.mailbox[boundary] = async input => { const result = await original(input); entered.release(); await release.promise; return result }
  }
  const work = f.dispatcher.delegate({ specialistAgentId: 'ace', objective: 'Old plan', acceptanceCriteria: ['Bound'],
    assertProposalCurrent: () => { if (revision !== 0) throw Object.assign(new Error('TASK_PLAN_STALE'), { code: 'TASK_PLAN_STALE' }) },
  }).catch(error => ({ reason: error.code }))
  await entered.promise; revision++; release.release()
  const result = await work; await f.dispatcher.drain()
  assert.equal(executions, 0)
  assert.equal(result.reason, 'TASK_PLAN_STALE')
  assert.equal(f.mailbox.list()[0].status, 'interrupted')
})

test('interruption reports committed reply projection failure explicitly without changing its terminal outcome', async t => {
  const entered = gate(), release = gate(); let executions = 0, projections = 0
  const f = await fixture(t, async () => { executions++; return { summary: 'Durable result.' } }, { waitMs: 50,
    onEvent: async event => { if (event.kind === 'structured_result') { projections++; throw new Error('conversation unavailable') } },
  })
  const complete = f.mailbox.completeWithReply.bind(f.mailbox)
  f.mailbox.completeWithReply = async input => { const result = await complete(input); entered.release(); await release.promise; return result }
  const work = f.dispatcher.delegate({ specialistAgentId: 'ace', objective: 'Complete', acceptanceCriteria: ['Bound'] })
  await entered.promise
  const result = await work
  release.release(); const [drained] = await f.dispatcher.drain()
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(drained, result)
  assert.equal(executions, 1); assert.equal(projections, 1)
  const reply = f.dispatcher.state().deliveries.find(row => row.parentMessageId === f.mailbox.list()[0].messageId)
  assert.equal(reply.status, 'interrupted')
  assert.equal(reply.reason, 'TEAM_RESULT_DELIVERY_FAILED')
  assert.equal(f.mailbox.list()[0].status, 'completed')
  const reopened = await f.reopen()
  assert.equal(reopened.list()[1].status, 'interrupted')
  assert.equal(reopened.list()[1].reason, 'TEAM_RESULT_DELIVERY_FAILED')
})

test('inbox revision after durable peer admission interrupts stale queued work before recipient execution', async t => {
  const entered = gate(), release = gate(); let revision = 0, f, irisRuns = 0
  f = await fixture(t, async (id, _content, message) => {
    if (id === 'iris') { irisRuns++; return { summary: 'Stale' } }
    const before = revision
    try {
      await f.dispatcher.executePeerTool(message.messageId, 'agent_send', { recipientAgentId: 'iris', objective: 'Old proposal' }, {
        assertProposalCurrent: () => { if (revision !== before) throw Object.assign(new Error('TASK_INBOX_UPDATED'), { code: 'TASK_INBOX_UPDATED' }) },
      })
    } catch (error) { assert.equal(error.code, 'TASK_INBOX_UPDATED') }
    return { summary: 'Used updated inbox.' }
  }, { onEvent: async event => { if (event.kind === 'task_handoff' && event.recipientAgentId === 'iris') { entered.release(); await release.promise } } })
  const work = f.dispatcher.delegate({ specialistAgentId: 'ace', objective: 'Root', acceptanceCriteria: ['Bound'] })
  await entered.promise; revision++; release.release()
  await work; await f.dispatcher.drain()
  assert.equal(irisRuns, 0)
  assert.equal(f.mailbox.list().find(row => row.agentId === 'iris').status, 'interrupted')
})

test('message reservation and depth limits bound every signed handoff and result pair', async t => {
  const f = await fixture(t, async () => ({ summary: 'Result' }))
  for (let n = 0; n < 16; n++) await f.dispatcher.delegate({ specialistAgentId: 'ace', objective: `Task ${n}`, acceptanceCriteria: ['Bound'] })
  await assert.rejects(f.dispatcher.delegate({ specialistAgentId: 'iris', objective: 'Overflow', acceptanceCriteria: ['Bound'] }), { code: 'TEAM_MESSAGE_LIMIT' })
  assert.equal(f.mailbox.list().length, 32)
  let nested
  const chain = ['ace', 'iris', 'bob', 'eve', 'max']
  nested = await fixture(t, async (id, _content, envelope) => {
    const next = chain[chain.indexOf(id) + 1]
    if (id === 'eve') {
      await assert.rejects(nested.dispatcher.executePeerTool(envelope.messageId, 'agent_ask', { recipientAgentId: next, objective: 'Too deep' }), { code: 'TEAM_DEPTH_LIMIT' })
    } else await nested.dispatcher.executePeerTool(envelope.messageId, 'agent_ask', { recipientAgentId: next, objective: 'Next' })
    return { summary: id }
  })
  await nested.dispatcher.delegate({ specialistAgentId: 'ace', objective: 'Chain', acceptanceCriteria: ['Bound'] })
  await nested.dispatcher.drain()
  assert.equal(nested.mailbox.list().length, 8)
})

test('forged signed reply correlation cannot complete or acknowledge stored work', async t => {
  const f = await fixture(t, async () => ({ summary: 'True result' }))
  const ace = f.agents.get('ace'), handle = ace.handle.bind(ace)
  ace.handle = async input => {
    const result = await handle(input)
    result.envelope.payload.parentMessageId = 'forged-parent'
    return result
  }
  const result = await f.dispatcher.delegate({ specialistAgentId: 'ace', objective: 'Root', acceptanceCriteria: ['Bound'] })
  assert.equal(result.reason, 'TEAM_REPLY_MISMATCH')
  await f.dispatcher.drain()
  assert.equal(f.mailbox.list()[0].status, 'interrupted')
  assert.equal(f.mailbox.list()[0].acknowledgedAt, null)
})

test('restart preserves replied rows and fences processing while queued rows never execute automatically', async t => {
  const release = gate(), entered = gate(); let f, runs = 0
  f = await fixture(t, async () => { runs++; entered.release(); await release.promise; return { summary: 'Done' } })
  const one = f.dispatcher.delegate({ specialistAgentId: 'ace', objective: 'One', acceptanceCriteria: ['Bound'] })
  await entered.promise
  const two = f.dispatcher.delegate({ specialistAgentId: 'ace', objective: 'Two', acceptanceCriteria: ['Bound'] })
  for (let n = 0; f.mailbox.list().length < 2 && n < 100; n++) await new Promise(r => setTimeout(r, 2))
  const reopened = await f.reopen()
  assert.deepEqual(reopened.list().map(row => row.status), ['interrupted', 'pending'])
  const closing = f.dispatcher.close('PROCESS_STOPPED').catch(() => {})
  release.release()
  await Promise.all([one, two, closing])
  assert.equal(runs, 1)
  assert.equal(teamMessagingProjection(reopened, 'root').deliveries.length, 2)
})
