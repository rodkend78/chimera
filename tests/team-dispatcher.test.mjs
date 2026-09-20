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
  // A timeout racing the mailbox commit leaves the external effect
  // indeterminate until reconciliation; it is not a safe failed result.
  assert.equal(result.status, boundary === 'before' ? 'unknown' : 'succeeded')
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

test('dispatcher exposes a graph-plan admission boundary for explicit plans', () => {
  assert.equal(typeof TeamDispatcher.prototype.dispatchPlan, 'function')
})

test('initial queued-step persistence failure releases an effect-free plan without replay', async t => {
  const executions = []
  const f = await fixture(t, async id => {
    executions.push(id)
    return { summary: id }
  })
  const firstSteps = []
  const first = await f.dispatcher.dispatchPlan({
    tasks: [{ nodeId: 'first', specialistAgentId: 'ace', objective: 'Do not admit', acceptanceCriteria: ['No effects'], dependsOn: [] }],
    planHash: '9'.repeat(64),
    revision: 1,
    resolveResources: async () => [{ key: 'workspace:first', access: 'read', verified: true }],
    onStep: async step => {
      firstSteps.push(step)
      throw Object.assign(new Error('FIXTURE_INITIAL_STEP_PERSIST_FAILED'), { code: 'FIXTURE_INITIAL_STEP_PERSIST_FAILED' })
    },
  }).catch(error => error)
  assert.equal(first.code, 'FIXTURE_INITIAL_STEP_PERSIST_FAILED')
  assert.equal(firstSteps.length, 1)
  assert.deepEqual(executions, [])
  assert.deepEqual(f.mailbox.list({ taskId: 'root' }), [])

  const results = await f.dispatcher.dispatchPlan({
    tasks: [{ nodeId: 'second', specialistAgentId: 'ace', objective: 'Admit once', acceptanceCriteria: ['Complete'], dependsOn: [] }],
    planHash: 'a'.repeat(64),
    revision: 1,
    resolveResources: async () => [{ key: 'workspace:second', access: 'read', verified: true }],
    onStep: async () => {},
  })
  assert.equal(results[0].status, 'succeeded')
  assert.deepEqual(executions, ['ace'])
  await f.dispatcher.drain()
})

test('graph plans overlap proven independent reads and return normalized plan order', async t => {
  const release = gate(), entered = gate(); let active = 0; let maximum = 0; let started = 0; let f
  f = await fixture(t, async (id, content) => {
    active += 1; maximum = Math.max(maximum, active); started += 1
    if (started === 2) entered.release()
    await release.promise
    active -= 1
    return { summary: content.objective }
  })
  const plan = f.dispatcher.dispatchPlan({
    tasks: [
      { nodeId: 'slow', specialistAgentId: 'ace', objective: 'Slow', acceptanceCriteria: ['Done'], dependsOn: [] },
      { nodeId: 'fast', specialistAgentId: 'iris', objective: 'Fast', acceptanceCriteria: ['Done'], dependsOn: [] },
    ],
    planHash: 'a'.repeat(64),
    revision: 1,
    resolveResources: async node => [{ key: `workspace:${node.nodeId}`, access: 'read', verified: true }],
    onStep: async () => {},
  })
  await entered.promise
  assert.equal(maximum, 2)
  release.release()
  const results = await plan
  assert.deepEqual(results.map(result => result.nodeId), ['slow', 'fast'])
  await f.dispatcher.drain()
})

test('a physically settled legacy job does not block a later graph plan', async t => {
  const f = await fixture(t, async id => ({ summary: `${id} completed.` }))
  await f.dispatcher.delegate({ specialistAgentId: 'ace', objective: 'Legacy work', acceptanceCriteria: ['Complete it.'] })
  await f.dispatcher.drain()

  const graph = f.dispatcher.dispatchPlan({
    tasks: [{ nodeId: 'iris-node', specialistAgentId: 'iris', objective: 'Graph work', acceptanceCriteria: ['Complete it.'], dependsOn: [] }],
    planHash: 'a'.repeat(64),
    revision: 1,
    resolveResources: async () => null,
    onStep: async () => {},
  })
  const results = await Promise.race([
    graph,
    new Promise((_, reject) => setTimeout(() => reject(new Error('SETTLED_LEGACY_BLOCKED_GRAPH')), 500)),
  ])
  assert.equal(results[0].status, 'succeeded')
  await f.dispatcher.drain()
})

test('failed graph predecessors block dependents before their executor runs', async t => {
  const executions = []
  const f = await fixture(t, async id => {
    executions.push(id)
    if (id === 'ace') throw Object.assign(new Error('failed root'), { code: 'SPECIALIST_FAILED' })
    return { summary: id }
  })
  const results = await f.dispatcher.dispatchPlan({
    tasks: [
      { nodeId: 'root', specialistAgentId: 'ace', objective: 'Fail', acceptanceCriteria: ['Fail'], dependsOn: [] },
      { nodeId: 'child', specialistAgentId: 'iris', objective: 'Must not run', acceptanceCriteria: ['Block'], dependsOn: ['root'] },
    ],
    planHash: 'b'.repeat(64),
    revision: 1,
    resolveResources: async () => [{ key: 'workspace:shared', access: 'write', verified: true }],
    onStep: async () => {},
  })
  assert.deepEqual(executions, ['ace'])
  assert.deepEqual(results.map(result => result.status), ['failed', 'blocked'])
  assert.equal(results[1].reason, 'TASK_DEPENDENCY_NOT_COMPLETED')
  await f.dispatcher.drain()
})

for (const [label, specialistAgentIds, resolveResources] of [
  ['same agent', ['ace', 'ace'], async node => [{ key: `workspace:${node.nodeId}`, access: 'read', verified: true }]],
  ['shared write', ['ace', 'iris'], async () => [{ key: 'workspace:shared', access: 'write', verified: true }]],
  ['unknown ownership', ['ace', 'iris'], async () => null],
]) test(`graph plans serialize ${label} work`, async t => {
  const entered = gate(), release = gate(); let active = 0; let maximum = 0; const executions = []
  const f = await fixture(t, async id => {
    executions.push(id); active += 1; maximum = Math.max(maximum, active)
    entered.release(); await release.promise; active -= 1
    return { summary: id }
  })
  const plan = f.dispatcher.dispatchPlan({
    tasks: specialistAgentIds.map((specialistAgentId, index) => ({
      nodeId: `${label.replaceAll(' ', '-')}-${index}`,
      specialistAgentId,
      objective: `${label} ${index}`,
      acceptanceCriteria: ['Done'],
      dependsOn: [],
    })),
    planHash: 'd'.repeat(64),
    revision: 1,
    resolveResources,
    onStep: async () => {},
  })
  await entered.promise
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(executions.length, 1)
  assert.equal(maximum, 1)
  release.release()
  await plan
  await f.dispatcher.drain()
})

test('graph plans retain the existing maximum-four execution cap', async t => {
  const entered = gate(), release = gate(); let active = 0; let maximum = 0; const executions = []
  const ids = ['ace', 'iris', 'bob', 'eve', 'max', 'zoe']
  const f = await fixture(t, async id => {
    executions.push(id); active += 1; maximum = Math.max(maximum, active)
    if (executions.length === 4) entered.release()
    await release.promise; active -= 1
    return { summary: id }
  })
  const plan = f.dispatcher.dispatchPlan({
    tasks: ids.map((specialistAgentId, index) => ({ nodeId: `cap-${index}`, specialistAgentId,
      objective: `Cap ${index}`, acceptanceCriteria: ['Done'], dependsOn: [] })),
    planHash: 'e'.repeat(64),
    revision: 1,
    resolveResources: async node => [{ key: `workspace:${node.nodeId}`, access: 'read', verified: true }],
    onStep: async () => {},
  })
  await entered.promise
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(maximum, 4)
  assert.equal(executions.length, 4)
  release.release()
  const results = await plan
  assert.deepEqual(results.map(result => result.nodeId), ids.map((_, index) => `cap-${index}`))
  await f.dispatcher.drain()
})

test('graph timeout returns unknown but retains its claim until physical return', async t => {
  const entered = gate(), release = gate(); let graphExecutions = 0; let legacyExecutions = 0
  const f = await fixture(t, async id => {
    if (id === 'ace') { graphExecutions += 1; entered.release(); await release.promise; return { summary: 'late graph' } }
    legacyExecutions += 1
    return { summary: 'legacy' }
  }, { waitMs: 30 })
  const graph = f.dispatcher.dispatchPlan({
    tasks: [{ nodeId: 'late', specialistAgentId: 'ace', objective: 'Delayed', acceptanceCriteria: ['Unknown'], dependsOn: [] }],
    planHash: 'f'.repeat(64),
    revision: 1,
    resolveResources: async () => [{ key: 'workspace:late', access: 'write', verified: true }],
    onStep: async () => {},
  })
  await entered.promise
  const graphResult = await graph
  assert.equal(graphResult[0].status, 'unknown')
  const legacy = f.dispatcher.delegate({ specialistAgentId: 'iris', objective: 'Wait for physical return', acceptanceCriteria: ['Run'] })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(legacyExecutions, 0)
  release.release()
  assert.equal((await legacy).status, 'succeeded')
  assert.equal(graphExecutions, 1)
  await f.dispatcher.drain()
})

test('graph result waits for the canonical terminal persistence barrier', async t => {
  const entered = gate(), release = gate(); let settled = false
  const f = await fixture(t, async () => ({ summary: 'done' }))
  const graph = f.dispatcher.dispatchPlan({
    tasks: [{ nodeId: 'persist', specialistAgentId: 'ace', objective: 'Persist', acceptanceCriteria: ['Durable'], dependsOn: [] }],
    planHash: '1'.repeat(64),
    revision: 1,
    resolveResources: async () => [{ key: 'workspace:persist', access: 'write', verified: true }],
    onStep: async step => {
      if (step.status === 'completed') { entered.release(); await release.promise }
    },
  }).then(result => { settled = true; return result })
  await entered.promise
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(settled, false)
  release.release()
  assert.equal((await graph)[0].status, 'succeeded')
  await f.dispatcher.drain()
})

test('terminal projection failure returns unknown and stops queued graph admissions without rerun', async t => {
  const executions = []; let terminalAttempts = 0
  const f = await fixture(t, async id => { executions.push(id); return { summary: id } })
  const graph = f.dispatcher.dispatchPlan({
    tasks: [
      { nodeId: 'first', specialistAgentId: 'ace', objective: 'First', acceptanceCriteria: ['Run'], dependsOn: [] },
      { nodeId: 'second', specialistAgentId: 'ace', objective: 'Second', acceptanceCriteria: ['Do not rerun'], dependsOn: [] },
    ],
    planHash: '2'.repeat(64),
    revision: 1,
    resolveResources: async node => [{ key: `workspace:${node.nodeId}`, access: 'read', verified: true }],
    onStep: async step => {
      if (step.status === 'completed' && terminalAttempts++ === 0) throw new Error('projection unavailable')
    },
  })
  const results = await graph
  assert.equal(executions.length, 1)
  assert.ok(results.every(result => result.status === 'unknown'), JSON.stringify(results))
  await f.dispatcher.close()
})

test('graph parent peer asks fail before child delivery when claims are retained', async t => {
  let f; let childExecutions = 0
  f = await fixture(t, async (id, _content, envelope) => {
    if (id === 'iris') childExecutions += 1
    if (id === 'ace') {
      await assert.rejects(
        f.dispatcher.executePeerTool(envelope.messageId, 'agent_ask', { recipientAgentId: 'iris', objective: 'Conflicting child' }),
        { code: 'TEAM_RESOURCE_DEPENDENCY_CYCLE' },
      )
    }
    return { summary: id }
  })
  const results = await f.dispatcher.dispatchPlan({
    tasks: [{ nodeId: 'parent', specialistAgentId: 'ace', objective: 'Parent', acceptanceCriteria: ['No deadlock'], dependsOn: [] }],
    planHash: '3'.repeat(64),
    revision: 1,
    resolveResources: async () => [{ key: 'workspace:parent', access: 'write', verified: true }],
    onStep: async () => {},
  })
  assert.equal(results[0].status, 'succeeded')
  assert.equal(childExecutions, 0)
  assert.equal(f.mailbox.list().filter(row => row.agentId === 'iris').length, 0)
  await f.dispatcher.drain()
})

test('graph resource resolver rechecks the proposal fence before execution', async t => {
  const entered = gate(), release = gate(); let revision = 0; let executions = 0
  const f = await fixture(t, async () => { executions += 1; return { summary: 'stale' } })
  const assertCurrent = () => {
    if (revision !== 0) throw Object.assign(new Error('TASK_PLAN_STALE'), { code: 'TASK_PLAN_STALE' })
  }
  const graph = f.dispatcher.dispatchPlan({
    tasks: [{ nodeId: 'stale', specialistAgentId: 'ace', objective: 'Stale', acceptanceCriteria: ['Do not run'], dependsOn: [] }],
    planHash: '4'.repeat(64),
    revision: 1,
    assertProposalCurrent: assertCurrent,
    resolveResources: async () => { entered.release(); await release.promise; return [{ key: 'workspace:stale', access: 'write', verified: true }] },
    onStep: async () => {},
  }).catch(error => error)
  await entered.promise
  revision += 1
  release.release()
  assert.equal((await graph).code, 'TASK_PLAN_STALE')
  assert.equal(executions, 0)
  await f.dispatcher.drain()
})

test('running-step persistence failure fences siblings before any executor starts', async t => {
  const executions = []; let runningWrites = 0
  const f = await fixture(t, async id => { executions.push(id); return { summary: id } })
  const graph = f.dispatcher.dispatchPlan({
    tasks: [
      { nodeId: 'persist-fails', specialistAgentId: 'ace', objective: 'Persistence failure', acceptanceCriteria: ['Stop'], dependsOn: [] },
      { nodeId: 'sibling', specialistAgentId: 'iris', objective: 'Must not execute', acceptanceCriteria: ['Stop'], dependsOn: [] },
    ],
    planHash: '5'.repeat(64),
    revision: 1,
    resolveResources: async () => [{ key: 'workspace:shared', access: 'write', verified: true }],
    onStep: async step => {
      if (step.status === 'running' && runningWrites++ === 0) throw Object.assign(new Error('FIXTURE_STEP_PERSIST_FAILED'), { code: 'FIXTURE_STEP_PERSIST_FAILED' })
    },
  })
  const results = await graph
  assert.deepEqual(executions, [])
  assert.ok(results.every(result => result.status === 'unknown'), JSON.stringify(results))
  await f.dispatcher.close()
})

test('resolved queued claims are prospective until dependency nodes acquire them', async t => {
  const rootEntered = gate(), releaseRoot = gate(); const resolved = []; const executions = []
  const f = await fixture(t, async id => {
    executions.push(id)
    if (id === 'ace') { rootEntered.release(); await releaseRoot.promise }
    return { summary: id }
  })
  const graph = f.dispatcher.dispatchPlan({
    tasks: [
      { nodeId: 'root', specialistAgentId: 'ace', objective: 'Root', acceptanceCriteria: ['Root'], dependsOn: [] },
      { nodeId: 'middle', specialistAgentId: 'iris', objective: 'Middle', acceptanceCriteria: ['Middle'], dependsOn: ['root'] },
      { nodeId: 'leaf', specialistAgentId: 'bob', objective: 'Leaf', acceptanceCriteria: ['Leaf'], dependsOn: ['middle'] },
    ],
    planHash: '6'.repeat(64),
    revision: 1,
    resolveResources: async node => {
      resolved.push(node.nodeId)
      return [{ key: node.nodeId === 'root' ? 'workspace:root' : 'workspace:shared', access: 'write', verified: true }]
    },
    onStep: async () => {},
  })
  await rootEntered.promise
  for (let attempt = 0; resolved.length < 3 && attempt < 100; attempt += 1) await new Promise(resolve => setTimeout(resolve, 1))
  assert.deepEqual(resolved.toSorted(), ['leaf', 'middle', 'root'])
  assert.deepEqual(executions, ['ace'])
  releaseRoot.release()
  const results = await graph
  assert.deepEqual(results.map(result => result.nodeId), ['root', 'middle', 'leaf'])
  assert.deepEqual(executions, ['ace', 'iris', 'bob'])
  await f.dispatcher.drain()
})
