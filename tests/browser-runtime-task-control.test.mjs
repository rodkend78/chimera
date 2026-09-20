import assert from 'node:assert/strict'
import test from 'node:test'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChimeraBrowserRuntime } from '../src/browser/runtime.mjs'
import { MemoryAuditLog } from '../src/audit-log.mjs'
import { LocalModelFabricRegistry } from '../src/ceo/local-model-fabric.mjs'
import { createDeterministicModelRouter } from '../src/ceo/model-router.mjs'
import { agentManifestFromHermesCandidate } from '../src/agents/registry.mjs'

function gate() {
  let release
  const promise = new Promise((resolve) => { release = resolve })
  return { promise, release }
}

test('Steering during a native executor call never automatically repeats external work', async t => {
  const entered = gate(), release = gate(); let nativeCalls = 0
  const { runtime } = await fixture(t, async () => ({ summary: 'unused' }))
  runtime.models.router = () => ({ routerId: 'model-fabric:native-fixture', nativeExecution: true, route: async () => {
    nativeCalls++; entered.release(); await release.promise
    return plan('researcher')
  } })
  const submitted = await runtime.submitTask({ objective: 'Bounded native work' })
  await entered.promise
  await runtime.messageTask({ taskId: submitted.taskId, recipientAgentIds: ['ceo'], content: 'Change the instructions.' })
  release.release()
  const terminal = await runtime.waitForTask(submitted.taskId)
  assert.equal(nativeCalls, 1)
  assert.equal(terminal.status, 'failed')
})

for (const later of [false, true]) test(`RJ-only guidance stops a stale root plan during ${later ? 'later' : 'initial'} materialization without replay`, async t => {
  const entered = gate(), release = gate(); let planningRuns = 0
  const { runtime, calls } = await fixture(t, async (_prompt, context) => {
    if (context.stage === 'decompose') {
      planningRuns++
      if (context.steering.length) return plan('researcher')
      return { tasks: [...(later ? plan('researcher').tasks : []), ...plan('ace').tasks] }
    }
    return { status: 'completed', summary: 'Preserved completed evidence.' }
  }, { agentReferenceProvider: { materialize: async () => {
    entered.release(); await release.promise
    return [{ path: 'MEMORY.md', content: 'Fixture.' }]
  } } })
  await runtime.agentRegistry.registerMany([agentManifestFromHermesCandidate({ schema: 'chimera.hermes-agent-candidate.v1',
    candidateId: 'fixture:ace', profileId: 'ace', displayName: 'Ace', sourceRef: 'hermes://fixture/profiles/ace' })])
  const task = await runtime.submitTask({ objective: 'Use the original root plan.' })
  await entered.promise
  const guidance = await runtime.messageTask({ taskId: task.taskId, recipientAgentIds: ['ceo'], content: 'Do not contact Ace. Use only the researcher instead.' })
  release.release()
  const terminal = await runtime.waitForTask(task.taskId)
  assert.equal(calls.filter(row => row.context.specialistAgent?.agentId === 'ace').length, 0, 'The obsolete root assignment must never execute')
  assert.equal(terminal.status, 'failed')
  assert.equal(terminal.failure.code, 'TASK_PLAN_STALE')
  assert.equal(planningRuns, 1, 'Stopping must not replay any original plan work')
  assert.deepEqual(guidance.recipients, [{ agentId: 'ceo', status: 'next-boundary' }])
  assert.equal(calls.filter(row => row.context.stage === 'specialist').length, later ? 1 : 0)
  for (const row of calls.filter(row => row.context.specialistAgent)) assert.deepEqual(row.context.steering, [])
  const rows = runtime.agentMailbox.list({ taskId: task.taskId })
  assert.equal(rows.some(row => row.agentId === 'ace'), false)
  if (later) {
    assert.equal(terminal.lastCompletedWork.agentId, 'researcher')
    assert.deepEqual(rows.map(row => row.status), ['completed', 'acknowledged'])
    const replies = runtime.conversationHistory({ conversationId: `task:${task.taskId}` }).messages.filter(row => row.kind === 'structured_result')
    assert.equal(replies.length, 1); assert.equal(replies[0].provenance.verification, 'verified')
  }
})

for (const ending of ['cancel', 'timeout']) for (const projectionFails of [false, true]) test(`imported worker committed reply survives ${ending} return race, projection failure ${projectionFails}`, { timeout: 10000 }, async t => {
  const committed = gate(), release = gate(), interrupted = gate(); let workerRuns = 0
  const { runtime } = await fixture(t, async (_prompt, context) => {
    if (context.stage === 'decompose') return plan('ace')
    if (context.stage === 'synthesize') return { summary: 'Retained durable evidence.' }
    workerRuns++
    return { status: 'completed', summary: 'Durable peer evidence.' }
  }, { teamWaitMs: 200, agentReferenceProvider: { materialize: async () => [{ path: 'MEMORY.md', content: 'Fixture.' }] } })
  await runtime.agentRegistry.registerMany([agentManifestFromHermesCandidate({ schema: 'chimera.hermes-agent-candidate.v1',
    candidateId: 'fixture:ace', profileId: 'ace', displayName: 'Ace', sourceRef: 'hermes://fixture/profiles/ace' })])
  const complete = runtime.agentMailbox.completeWithReply.bind(runtime.agentMailbox)
  runtime.agentMailbox.completeWithReply = async input => {
    const result = await complete(input)
    committed.release(); await release.promise
    return result
  }
  const interrupt = runtime.agentMailbox.interrupt.bind(runtime.agentMailbox)
  runtime.agentMailbox.interrupt = async input => { const result = await interrupt(input); interrupted.release(); return result }
  const append = runtime.conversations.append.bind(runtime.conversations)
  let projections = 0
  runtime.conversations.append = async input => {
    if (input.kind === 'structured_result') {
      projections++
      if (projectionFails) throw new Error('conversation unavailable')
    }
    return append(input)
  }
  const task = await runtime.submitTask({ objective: 'Keep the committed worker evidence.' })
  await committed.promise
  const dispatcher = runtime.teamDispatchers.get(task.taskId)
  const parent = runtime.agentMailbox.list({ taskId: task.taskId }).find(row => row.type === 'task_handoff')
  const stored = runtime.agentMailbox.completedReply({ agentId: 'ace', messageId: parent.messageId })
  assert.equal(stored.envelope.payload.content.result.summary, 'Durable peer evidence.')
  if (ending === 'cancel') await runtime.cancelTask({ taskId: task.taskId })
  await interrupted.promise
  assert.throws(() => dispatcher.assertJobActive(parent.messageId), /TASK_CANCELLED|TEAM_TASK_CLOSED|TEAM_JOB_INACTIVE/)
  let drained = false
  const drainage = dispatcher.drain().then(results => { drained = true; return results })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(drained, false, 'Physical drainage must retain the imported worker until its return')
  release.release()
  const outcomes = await drainage
  assert.equal((await runtime.waitForTask(task.taskId)).status, ending === 'cancel' ? 'cancelled' : 'completed')
  assert.equal(outcomes[0].result.summary, 'Durable peer evidence.')
  assert.equal(outcomes[0].attribution.senderAgentId, 'ace')
  const replies = runtime.conversationHistory({ conversationId: `task:${task.taskId}` }).messages.filter(row => row.kind === 'structured_result')
  assert.equal(projections, 1)
  assert.equal(replies.length, projectionFails ? 0 : 1, 'The committed signed reply must have one delivery attempt despite interruption')
  if (!projectionFails) {
    assert.equal(replies[0].messageId, stored.envelope.payload.messageId)
    assert.equal(replies[0].replyTo, parent.messageId)
    assert.equal(replies[0].provenance.verification, 'verified')
    assert.equal(replies[0].content, 'Durable peer evidence.')
  }
  assert.deepEqual(runtime.agentMailbox.list({ taskId: task.taskId }).map(row => row.status), ['completed', projectionFails ? 'interrupted' : 'acknowledged'])
  if (projectionFails) {
    assert.equal(runtime.teamDispatchers.has(task.taskId), false)
    const row = (await runtime.state()).teamMessaging.tasks.find(row => row.taskId === task.taskId).deliveries.find(row => row.messageId === stored.envelope.payload.messageId)
    assert.equal(row.status, 'interrupted')
    assert.equal(row.reason, 'TEAM_RESULT_DELIVERY_FAILED')
  }
  assert.equal(workerRuns, 1)
  await dispatcher.close()
  assert.deepEqual(await dispatcher.drain(), outcomes)
})

test('targeted human guidance fences stale Ace tools and reaches only Ace, persists reply without restarting finished peers', async t => {
  const entered = gate(), release = gate(), synthesis = gate(), finish = gate(); let effects = 0
  const { runtime, calls } = await fixture(t, async (_prompt, context) => {
    if (context.stage === 'decompose') return { tasks: [...plan('ace').tasks, ...plan('iris').tasks] }
    if (context.stage === 'synthesize') { synthesis.release(); await finish.promise; return { summary: 'Finished.' } }
    if (context.specialistAgent.agentId === 'iris') return { status: 'completed', summary: 'Iris result.' }
    if (context.loop.turn === 1) { entered.release(); await release.promise; return { status: 'tool_request', toolCall: { name: 'write', arguments: { path: 'scratch/stale', content: 'stale' } } } }
    assert.match(JSON.stringify(context.steering), /Only Ace should see this/)
    return { status: 'completed', summary: 'Ace adjusted.' }
  }, { agentReferenceProvider: { materialize: async () => [{ path: 'MEMORY.md', content: 'Fixture.' }] }, workerToolExecutors: { write: async () => { effects++; return {} } } })
  await runtime.agentRegistry.registerMany(['ace', 'iris'].map(id => agentManifestFromHermesCandidate({ schema: 'chimera.hermes-agent-candidate.v1', candidateId: `fixture:${id}`, profileId: id, displayName: id, sourceRef: `hermes://fixture/profiles/${id}` })))
  const task = await runtime.submitTask({ objective: 'Run the scoped team.' }); await entered.promise
  const parent = runtime.conversationHistory({ conversationId: `task:${task.taskId}` }).messages.find(row => row.kind === 'task_handoff')
  const accepted = await runtime.messageTask({ taskId: task.taskId, content: 'Only Ace should see this', recipientAgentIds: ['ace'], replyTo: parent.messageId })
  assert.equal(accepted.message.provenance.verification, 'human')
  assert.equal(accepted.message.replyTo, parent.messageId)
  assert.equal(accepted.recipients[0].status, 'next-boundary')
  assert.deepEqual(runtime.tasks.get(task.taskId).steering ?? [], [])
  release.release(); await synthesis.promise
  const saved = await runtime.messageTask({ taskId: task.taskId, content: 'Saved after Ace finished', recipientAgentIds: ['ace'] })
  assert.equal(saved.recipients[0].status, 'saved-no-active-assignment')
  finish.release(); assert.equal((await runtime.waitForTask(task.taskId)).status, 'completed')
  assert.equal(effects, 0)
  assert.equal(calls.filter(row => row.context.specialistAgent?.agentId === 'ace').length, 2)
  for (const row of calls.filter(row => row.context.specialistAgent?.agentId !== 'ace')) assert.doesNotMatch(JSON.stringify(row.context.steering), /Only Ace/)
  await assert.rejects(runtime.messageTask({ taskId: task.taskId, content: 'Too late', recipientAgentIds: ['ace'] }), { code: 'TASK_NOT_ACTIVE' })
})

test('targeting RJ replans its next boundary without leaking guidance to the specialist; validates bounded same-task recipients and parent', async t => {
  const entered = gate(), release = gate(); let turns = 0
  const { runtime, calls } = await fixture(t, async (_prompt, context) => {
    if (context.stage === 'decompose') { if (++turns === 1) { entered.release(); await release.promise } return plan() }
    return { summary: 'Done.' }
  })
  const task = await runtime.submitTask({ objective: 'Start planning.' }); await entered.promise
  const planningState = await runtime.state()
  assert.ok(planningState.conversations.channels.some(channel => channel.conversationId === `task:${task.taskId}`), 'A planning task needs a room before the first peer handoff')
  await runtime.conversations.append({ messageId: 'foreign', conversationId: 'task:foreign', taskId: 'foreign', senderAgentId: 'operator', recipientAgentIds: ['ceo'], content: 'Other task' })
  for (const patch of [{ recipientAgentIds: [] }, { recipientAgentIds: ['ceo', 'ceo'] }, { recipientAgentIds: ['unknown'] }, { recipientAgentIds: ['ceo'], replyTo: 'foreign' }, { recipientAgentIds: ['ceo'], content: 'x'.repeat(4097) }]) {
    await assert.rejects(runtime.messageTask({ taskId: task.taskId, content: 'Bad scope', recipientAgentIds: ['ceo'], ...patch }), /TASK_MESSAGE_/)
  }
  await runtime.messageTask({ taskId: task.taskId, content: 'Only RJ planning instruction', recipientAgentIds: ['ceo'] })
  release.release(); assert.equal((await runtime.waitForTask(task.taskId)).status, 'completed')
  assert.equal(turns, 2)
  assert.match(JSON.stringify(calls[1].context.steering), /Only RJ/)
  assert.doesNotMatch(JSON.stringify(calls.find(row => row.context.stage === 'specialist').context.steering), /Only RJ/)
})

test('guidance and steering revalidate the destination after their durable reservation', async t => {
  const entered = gate(), releasePlan = gate()
  let reservationGate = gate()
  const { runtime } = await fixture(t, async (_prompt, context) => {
    if (context.stage === 'decompose') { entered.release(); await releasePlan.promise; return plan() }
    return { summary: 'Done.' }
  })
  const task = await runtime.submitTask({ objective: 'Hold a task while its destination changes.' })
  await entered.promise
  const initialRevision = runtime.tasks.get(task.taskId).destinationRevision
  const originalReserve = runtime.tasks.reserveAdmission.bind(runtime.tasks)
  let heldOperation = null
  runtime.tasks.reserveAdmission = async input => {
    const admission = await originalReserve(input)
    if (input.operation === 'task-message' || input.operation === 'task-steer') {
      heldOperation = input.operation
      await reservationGate.promise
    }
    return admission
  }
  const guidance = runtime.messageTask({ taskId: task.taskId, content: 'Reject stale guidance.', recipientAgentIds: ['ceo'], requestId: 'stale-guidance', expectedDestinationRevision: initialRevision })
  await waitFor(() => heldOperation, Boolean)
  await runtime.tasks.reviseDestination(task.taskId)
  reservationGate.release()
  await assert.rejects(guidance, { code: 'TASK_DESTINATION_STALE' })
  assert.equal(runtime.tasks.getAdmission('stale-guidance').status, 'failed')
  assert.equal(runtime.conversationHistory({ conversationId: `task:${task.taskId}` }).messages.some(message => message.provenance.source === 'operator-task-guidance'), false)

  const currentRevision = runtime.tasks.get(task.taskId).destinationRevision
  reservationGate = gate()
  heldOperation = null
  const steering = runtime.steerTask({ taskId: task.taskId, content: 'Reject stale steering.', requestId: 'stale-steering', expectedDestinationRevision: currentRevision })
  await waitFor(() => heldOperation === 'task-steer', Boolean)
  await runtime.tasks.reviseDestination(task.taskId)
  reservationGate.release()
  await assert.rejects(steering, { code: 'TASK_DESTINATION_STALE' })
  assert.equal(runtime.tasks.getAdmission('stale-steering').status, 'failed')
  assert.deepEqual(runtime.tasks.get(task.taskId).steering ?? [], [])
  releasePlan.release()
  await runtime.waitForTask(task.taskId)
})

test('exact guidance and steering receipts reconcile durable effects without mutating on GET', async t => {
  const entered = gate(), release = gate()
  t.after(() => release.release())
  const { runtime } = await fixture(t, async (_prompt, context) => {
    if (context.stage === 'decompose') { entered.release(); await release.promise; return plan() }
    return { summary: 'Reconciled safely.' }
  })
  const task = await runtime.submitTask({ objective: 'Hold for exact receipt reconciliation.' })
  await entered.promise
  const baseAppend = runtime.audit.append.bind(runtime.audit)
  let failConversationAudit = true
  runtime.audit.append = fact => {
    if (failConversationAudit && fact.kind === 'ceo.conversation.message' && fact.messageKind === 'message') throw Object.assign(new Error('FIXTURE_AUDIT_FAILED'), { code: 'FIXTURE_AUDIT_FAILED' })
    return baseAppend(fact)
  }
  const messageId = 'guidance-audit-reconcile'
  await assert.rejects(runtime.messageTask({ taskId: task.taskId, requestId: messageId, content: 'Persist this exact guidance.', recipientAgentIds: ['ceo'] }), { code: 'FIXTURE_AUDIT_FAILED' })
  const before = runtime.conversationHistory({ conversationId: `task:${task.taskId}` }).messages.length
  const first = runtime.taskAdmissionStatus(messageId)
  assert.equal(first.status, 'accepted')
  assert.equal(first.messageId, `human-guidance-${(await import('../src/canonical.mjs')).sha256({ requestId: messageId, taskId: task.taskId, operation: 'task-message' }).slice(0, 48)}`)
  const repeated = runtime.taskAdmissionStatus(messageId)
  assert.deepEqual(repeated, first)
  assert.equal(runtime.conversationHistory({ conversationId: `task:${task.taskId}` }).messages.length, before)

  failConversationAudit = false
  let failSteerAudit = true
  runtime.audit.append = fact => {
    if (failSteerAudit && fact.kind === 'ceo.task.steered') throw Object.assign(new Error('FIXTURE_STEER_AUDIT_FAILED'), { code: 'FIXTURE_STEER_AUDIT_FAILED' })
    return baseAppend(fact)
  }
  const steerId = 'steer-audit-reconcile'
  await assert.rejects(runtime.steerTask({ taskId: task.taskId, requestId: steerId, content: 'Persist this exact steering.' }), { code: 'FIXTURE_STEER_AUDIT_FAILED' })
  const steerReceipt = runtime.taskAdmissionStatus(steerId)
  assert.equal(steerReceipt.status, 'accepted')
  assert.equal(runtime.taskAdmissionStatus(steerId).status, 'accepted')
  release.release()
  await runtime.waitForTask(task.taskId)
})

test('root producers reconcile exact task effects after post-publish audit failures', async t => {
  const { runtime } = await fixture(t, async (_prompt, context) => {
    if (context.stage === 'decompose') return plan()
    return { summary: 'Fixture terminal result.' }
  })
  const baseAppend = runtime.audit.append.bind(runtime.audit)
  let failSubmissionAudit = true
  runtime.audit.append = fact => {
    if (failSubmissionAudit && fact.kind === 'ceo.task.submitted') throw Object.assign(new Error('FIXTURE_SUBMIT_AUDIT_FAILED'), { code: 'FIXTURE_SUBMIT_AUDIT_FAILED' })
    return baseAppend(fact)
  }

  const rootRequestId = 'root-producer-audit-failure'
  await assert.rejects(runtime.submitTask({ requestId: rootRequestId, objective: 'Reconcile the published root task.' }), { code: 'FIXTURE_SUBMIT_AUDIT_FAILED' })
  const rootReceipt = runtime.taskAdmissionStatus(rootRequestId)
  assert.equal(rootReceipt.status, 'accepted')
  assert.equal(rootReceipt.reconciled, true)
  assert.equal(runtime.tasks.get(rootReceipt.taskId).admissionRequestId, rootRequestId)
  await runtime.cancelTask({ taskId: rootReceipt.taskId })

  const project = await runtime.registerProject({ mode: 'managed', name: 'Audit reconciliation fixture' })
  const projectRequestId = 'project-producer-audit-failure'
  await assert.rejects(runtime.submitProjectTask({ requestId: projectRequestId, projectId: project.projectId, objective: 'Reconcile the published project task.' }), { code: 'FIXTURE_SUBMIT_AUDIT_FAILED' })
  const projectReceipt = runtime.taskAdmissionStatus(projectRequestId)
  assert.equal(projectReceipt.status, 'accepted')
  assert.equal(projectReceipt.reconciled, true)
  assert.equal(runtime.tasks.get(projectReceipt.taskId).context.projectId, project.projectId)
  await runtime.cancelTask({ taskId: projectReceipt.taskId })

  const messageRequestId = 'message-producer-audit-failure'
  await assert.rejects(runtime.sendMessage({ requestId: messageRequestId, content: 'Reconcile the published message task.' }), { code: 'FIXTURE_SUBMIT_AUDIT_FAILED' })
  const messageReceipt = runtime.taskAdmissionStatus(messageRequestId)
  assert.equal(messageReceipt.status, 'unknown')
  assert.equal(messageReceipt.reconciled, undefined)
  assert.equal(runtime.tasks.get(messageReceipt.taskId).status, 'queued')
  await runtime.cancelTask({ taskId: messageReceipt.taskId })

  failSubmissionAudit = false
  const prior = await runtime.tasks.submit({ taskId: 'prior-terminal-for-audit', objective: 'Prior terminal task.', model: null })
  await runtime.tasks.start(prior.taskId)
  await runtime.tasks.complete(prior.taskId, { summary: 'Prior terminal evidence.', result: {} })
  failSubmissionAudit = true
  const continuationRequestId = 'continuation-producer-audit-failure'
  await assert.rejects(runtime.continueTask({ requestId: continuationRequestId, taskId: prior.taskId, objective: 'Reconcile the published continuation.' }), { code: 'FIXTURE_SUBMIT_AUDIT_FAILED' })
  const continuationReceipt = runtime.taskAdmissionStatus(continuationRequestId)
  assert.equal(continuationReceipt.status, 'accepted')
  assert.equal(continuationReceipt.reconciled, true)
  assert.equal(runtime.tasks.get(continuationReceipt.taskId).context.priorTaskId, prior.taskId)
  await runtime.cancelTask({ taskId: continuationReceipt.taskId })
})

for (const delayedPost of [false, true]) test(`targeted guidance releases only superseded Ace approval including posting race ${delayedPost}`, { timeout: 10000 }, async t => {
  const posting = gate(), release = gate(); let effects = 0
  const { runtime } = await fixture(t, async (_prompt, context) => {
    if (context.stage === 'decompose') return plan('ace')
    if (context.stage === 'synthesize') return { summary: 'Guided safely.' }
    if (context.steering.length) return { status: 'completed', summary: 'No write necessary.' }
    return { status: 'tool_request', toolCall: { name: 'write', arguments: { path: 'scratch/result', content: 'superseded' } } }
  }, { agentReferenceProvider: { materialize: async () => [{ path: 'MEMORY.md', content: 'Fixture.' }] }, workerToolExecutors: { write: async () => { effects++; return {} } } })
  await runtime.agentRegistry.registerMany([agentManifestFromHermesCandidate({ schema: 'chimera.hermes-agent-candidate.v1', candidateId: 'fixture:ace', profileId: 'ace', displayName: 'Ace', sourceRef: 'hermes://fixture/profiles/ace' })])
  const post = runtime.decisions.post.bind(runtime.decisions)
  if (delayedPost) runtime.decisions.post = async input => { posting.release(); await release.promise; return post(input) }
  const task = await runtime.submitTask({ objective: 'Prepare the artifact.' })
  if (delayedPost) await posting.promise
  else await waitFor(() => runtime.decisions.pending()[0], Boolean)
  await runtime.messageTask({ taskId: task.taskId, content: 'Skip that write.', recipientAgentIds: ['ace'] })
  release.release()
  assert.equal((await runtime.waitForTask(task.taskId)).status, 'completed')
  assert.equal(runtime.decisions.pending().length, 0); assert.equal(effects, 0)
})

test('builtin one-shot specialist revises its result at its next recipient guidance boundary', async t => {
  const entered = gate(), release = gate(); let turns = 0
  const { runtime } = await fixture(t, async (_prompt, context) => {
    if (context.stage === 'decompose') return plan()
    if (context.stage === 'synthesize') { assert.match(JSON.stringify(context.results), /Revised evidence/); return { summary: 'Revised.' } }
    if (++turns === 1) { entered.release(); await release.promise; return { summary: 'Stale evidence.' } }
    assert.match(JSON.stringify(context.steering), /Recheck/); return { summary: 'Revised evidence.' }
  })
  const task = await runtime.submitTask({ objective: 'Research.' }); await entered.promise
  await runtime.messageTask({ taskId: task.taskId, content: 'Recheck the evidence.', recipientAgentIds: ['researcher'] })
  release.release(); assert.equal((await runtime.waitForTask(task.taskId)).status, 'completed'); assert.equal(turns, 2)
})

test('targeting Ace cancels its pending proposal while Iris approval remains pending', async t => {
  const { runtime } = await fixture(t, async (_prompt, context) => {
    if (context.stage === 'decompose') return plan('ace')
    if (context.stage === 'synthesize') return { summary: 'Scoped approvals.' }
    const id = context.specialistAgent.agentId
    if (id === 'ace' && !context.loop.observations.length) return { status: 'tool_request', toolCall: { name: 'agent_send', arguments: { recipientAgentId: 'iris', objective: 'Prepare separate proposal.' } } }
    if (context.steering.length || context.loop.observations.some(row => row.tool === 'write')) return { status: 'completed', summary: 'Finished without effect.' }
    return { status: 'tool_request', toolCall: { name: 'write', arguments: { path: `scratch/${id}.txt`, content: 'pending' } } }
  }, { agentReferenceProvider: { materialize: async () => [{ path: 'MEMORY.md', content: 'Fixture.' }] } })
  await runtime.agentRegistry.registerMany(['ace', 'iris'].map(id => agentManifestFromHermesCandidate({ schema: 'chimera.hermes-agent-candidate.v1', candidateId: `fixture:${id}`, profileId: id, displayName: id, sourceRef: `hermes://fixture/profiles/${id}` })))
  const task = await runtime.submitTask({ objective: 'Prepare two independent proposals.' })
  const pending = await waitFor(() => runtime.decisions.pending(), rows => rows.length === 2)
  await runtime.messageTask({ taskId: task.taskId, content: 'Ace: do not write.', recipientAgentIds: ['ace'] })
  assert.equal(runtime.decisions.get(pending.find(row => row.agent.agentId === 'ace').actionId).status, 'cancelled')
  const iris = pending.find(row => row.agent.agentId === 'iris')
  assert.equal(runtime.decisions.get(iris.actionId).status, 'pending')
  await runtime.decide(iris.actionId, 'deny')
  assert.equal((await runtime.waitForTask(task.taskId)).status, 'completed')
})

test('RJ-targeted guidance fences an obsolete synthesis approval posted after guidance was saved', async t => {
  const entered = gate(), release = gate()
  const { runtime } = await fixture(t, async (_prompt, context) => context.stage === 'decompose' ? plan()
    : context.stage === 'specialist' ? { summary: 'Evidence.' } : { summary: 'Review delivery.', decision: { capability: 'external.message', resource: 'telegram:chimera-hq', operation: 'send', actionDiff: { before: null, after: { message: 'Obsolete proposal' } }, rationale: 'Review.' } })
  const post = runtime.decisions.post.bind(runtime.decisions)
  runtime.decisions.post = async input => { entered.release(); await release.promise; return post(input) }
  const task = await runtime.submitTask({ objective: 'Prepare a reviewed delivery.' }); await entered.promise
  await runtime.messageTask({ taskId: task.taskId, content: 'Do not send the delivery.', recipientAgentIds: ['ceo'] })
  release.release(); await runtime.waitForTask(task.taskId)
  assert.equal(runtime.decisions.pending().length, 0)
})

test('acceptance: RJ Ace Iris Ace RJ reads real evidence, approves one artifact, cancels the next effect, and restart preserves replies without replay', async t => {
  const irisEntered = gate(), irisRelease = gate(); let mode = 'acceptance'
  const { runtime, calls } = await fixture(t, async (_prompt, context) => {
    if (context.stage === 'decompose') return plan('ace')
    if (context.stage === 'synthesize') { assert.match(JSON.stringify(context.results), /evidence 42/); return { summary: 'RJ accepted evidence 42 from Ace and Iris.' } }
    if (mode === 'cancel') return { status: 'tool_request', toolCall: { name: 'write', arguments: { path: 'scratch/unsafe.txt', content: 'must not execute' } } }
    if (context.specialistAgent.agentId === 'iris') {
      if (context.loop.turn === 1) { irisEntered.release(); await irisRelease.promise }
      if (!context.loop.observations.length) return { status: 'tool_request', toolCall: { name: 'read', arguments: { path: 'mounts/memory/MEMORY.md' } } }
      assert.match(JSON.stringify(context.loop.observations), /evidence 42/)
      return { status: 'tool_request', toolCall: { name: 'agent_reply', arguments: { summary: 'Read mounts/memory/MEMORY.md: evidence 42.' } } }
    }
    if (!context.loop.observations.length) return { status: 'tool_request', toolCall: { name: 'agent_ask', arguments: { recipientAgentId: 'iris', objective: 'Read the fixture evidence.' } } }
    if (context.loop.observations.length === 1) {
      assert.match(JSON.stringify(context.loop.observations), /evidence 42/)
      return { status: 'tool_request', toolCall: { name: 'write', arguments: { path: 'scratch/report.txt', content: 'Accepted evidence 42\n' } } }
    }
    return { status: 'tool_request', toolCall: { name: 'agent_reply', arguments: { summary: 'Artifact scratch/report.txt contains evidence 42.' } } }
  }, { agentReferenceProvider: { materialize: async () => [{ path: 'MEMORY.md', content: 'Read-only fixture evidence 42.' }] } })
  await runtime.agentRegistry.registerMany(['ace', 'iris'].map(id => agentManifestFromHermesCandidate({ schema: 'chimera.hermes-agent-candidate.v1', candidateId: `fixture:${id}`, profileId: id, displayName: id, sourceRef: `hermes://fixture/profiles/${id}` })))
  const task = await runtime.submitTask({ objective: 'Read evidence and prepare one reviewed local artifact.' }); await irisEntered.promise
  const parent = runtime.conversationHistory({ conversationId: `task:${task.taskId}` }).messages.find(row => row.recipientAgentIds.includes('iris') && row.kind === 'task_handoff')
  const guidance = await runtime.messageTask({ taskId: task.taskId, content: 'Cite the read-only source path.', recipientAgentIds: ['iris'], replyTo: parent.messageId })
  irisRelease.release()
  const decision = await waitFor(() => runtime.decisions.pending()[0], Boolean)
  const workspacePath = runtime.workers.get('ace').workspace.path
  await assert.rejects(readFile(join(workspacePath, 'scratch/report.txt')), { code: 'ENOENT' })
  assert.equal(decision.agent.agentId, 'ace')
  await runtime.decide(decision.actionId, 'approve')
  assert.equal((await runtime.waitForTask(task.taskId)).status, 'completed')
  assert.equal(await readFile(join(workspacePath, 'scratch/report.txt'), 'utf8'), 'Accepted evidence 42\n')
  const transcript = runtime.conversationHistory({ conversationId: `task:${task.taskId}` }).messages
  const signed = transcript.filter(row => row.provenance.verification === 'verified')
  assert.deepEqual(signed.map(row => [row.senderAgentId, row.recipientAgentIds[0]]), [['ceo', 'ace'], ['ace', 'iris'], ['iris', 'ace'], ['ace', 'ceo']])
  assert.equal(signed[2].replyTo, signed[1].messageId); assert.equal(signed[3].replyTo, signed[0].messageId)
  assert.equal(transcript.find(row => row.messageId === guidance.message.messageId).replyTo, parent.messageId)
  mode = 'cancel'
  const cancelled = await runtime.submitTask({ objective: 'Propose an effect, then stop.' })
  const pending = await waitFor(() => runtime.decisions.pending()[0], Boolean)
  await runtime.cancelTask({ taskId: cancelled.taskId })
  assert.equal((await runtime.waitForTask(cancelled.taskId)).status, 'cancelled')
  assert.equal((await runtime.decide(pending.actionId, 'approve')).status, 'denied')
  await assert.rejects(readFile(join(runtime.workers.get('ace').workspace.path, 'scratch/unsafe.txt')), { code: 'ENOENT' })
  const callCount = calls.length
  await runtime.close()
  const restarted = new ChimeraBrowserRuntime({ profileDir: runtime.profileDir, modelRegistry: runtime.models,
    browserExecutor: { start: async () => ({ running: true, tabs: [] }), state: async () => ({ running: true, tabs: [] }), suspend: async () => ({ running: false, tabs: [] }), close: async () => {} } })
  try {
    await restarted.start()
    assert.deepEqual(restarted.conversationHistory({ conversationId: `task:${task.taskId}` }).messages, transcript)
    assert.equal(restarted.decisions.pending().length, 0)
    assert.equal(restarted.tasks.get(cancelled.taskId).status, 'cancelled')
    assert.equal(calls.length, callCount); assert.equal(restarted.activeTasks.size, 0)
    assert.equal((await restarted.decide(pending.actionId, 'approve')).status, 'denied')
    await assert.rejects(readFile(join(workspacePath, 'scratch/unsafe.txt')), { code: 'ENOENT' })
  } finally { await restarted.close() }
})

test('expired task grant fences a delayed peer model before its proposed tool executes', async t => {
  let clock = Date.now(), effects = 0
  const entered = gate(), release = gate()
  const { runtime } = await fixture(t, async (_prompt, context) => {
    if (context.stage === 'decompose') return plan('ace')
    if (context.stage === 'specialist-loop') { entered.release(); await release.promise; return { status: 'tool_request', toolCall: { name: 'write', arguments: { path: 'scratch/expired', content: 'expired' } } } }
    return { summary: 'Expired work.' }
  }, { now: () => clock, agentReferenceProvider: { materialize: async () => [{ path: 'MEMORY.md', content: 'Fixture.' }] }, workerToolExecutors: { write: async () => { effects++; return {} } } })
  await runtime.agentRegistry.registerMany([agentManifestFromHermesCandidate({ schema: 'chimera.hermes-agent-candidate.v1', candidateId: 'fixture:ace', profileId: 'ace', displayName: 'Ace', sourceRef: 'hermes://fixture/profiles/ace' })])
  const task = await runtime.submitTask({ objective: 'Respect grant expiry.' }); await entered.promise
  clock += 16 * 60_000; release.release()
  await runtime.waitForTask(task.taskId)
  assert.equal(effects, 0); assert.equal(runtime.decisions.pending().length, 0)
  assert.ok(runtime.agentMailbox.list({ taskId: task.taskId }).every(row => ['expired', 'interrupted', 'failed'].includes(row.status)))
})

function plan(agentId = 'researcher', objective = 'Return a bounded result.') {
  return { tasks: [{ specialistAgentId: agentId, objective, acceptanceCriteria: ['Return evidence.'] }] }
}

async function waitFor(read, predicate) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const value = await read()
    if (predicate(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('TASK_CONTROL_TEST_TIMEOUT')
}

async function fixture(t, responder, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-task-control-'))
  const calls = []
  const provider = createDeterministicModelRouter({ routerId: 'openai-compatible:fixture:control',
    responder: async (prompt, context) => { calls.push({ prompt, context }); return responder(prompt, context) } })
  const modelRegistry = {
    state: () => ({ selected: { providerId: 'fixture', model: 'control' }, providers: [{ id: 'fixture', configured: true,
      models: [{ id: 'offline', availability: 'verified-route', capabilities: ['conversation'] }] }] }),
    router: () => provider,
    routerFor: async () => { throw Object.assign(new Error('MODEL_UNAVAILABLE'), { code: 'MODEL_UNAVAILABLE' }) },
  }
  const runtime = new ChimeraBrowserRuntime({ profileDir: join(directory, 'profiles/ceo'), modelRegistry,
    browserExecutor: { start: async () => ({ running: true, tabs: [] }), state: async () => ({ running: true, tabs: [] }), suspend: async () => ({ running: false, tabs: [] }), close: async () => {} }, ...overrides })
  await runtime.start()
  t.after(async () => {
    await runtime.close()
    const writable = async (path) => {
      if ((await lstat(path)).isDirectory()) {
        await chmod(path, 0o700)
        for (const name of await readdir(path)) await writable(join(path, name))
      }
    }
    await writable(directory)
    await rm(directory, { recursive: true, force: true })
  })
  return { runtime, calls, directory }
}

test('unselected unavailable pinned specialist does not block RJ planning or initialize a worker', async (t) => {
  let materializations = 0
  const { runtime, calls } = await fixture(t, async (_prompt, context) => context.stage === 'decompose'
    ? plan(context.requestedSpecialistAgentId ?? 'researcher') : { summary: 'Evidence returned.' }, { agentReferenceProvider: { materialize: async () => { materializations += 1; throw new Error('must not materialize') } } })
  await runtime.agentRegistry.registerMany([agentManifestFromHermesCandidate({
    schema: 'chimera.hermes-agent-candidate.v1', candidateId: 'fixture:offline', profileId: 'offline',
    displayName: 'Offline', sourceRef: 'hermes://fixture/profiles/offline',
  })])
  await runtime.setAgentModel('offline', { mode: 'pinned', providerId: 'fixture', model: 'offline' })
  const submitted = await runtime.submitTask({ objective: 'Answer with the built-in researcher.' })
  assert.equal((await runtime.waitForTask(submitted.taskId)).status, 'completed')
  assert.ok(calls[0].context.availableSpecialists.includes('offline'))
  assert.equal(materializations, 0)
  assert.equal(runtime.workers.has('offline'), false)
  const requested = await runtime.sendMessage({ content: 'Run offline explicitly.', recipientAgentId: 'offline' })
  assert.equal((await runtime.waitForTask(requested.task.taskId)).failure.code, 'MODEL_UNAVAILABLE')
})

test('real runtime Ace asks Iris in sandbox, replies with evidence, and RJ synthesizes signed peer results', async t => {
  const { runtime, calls } = await fixture(t, async (_prompt, context) => {
    if (context.stage === 'decompose') return plan('ace')
    if (context.stage === 'synthesize') {
      assert.match(JSON.stringify(context.results), /Iris evidence 42/)
      assert.equal(context.results.length, 2)
      assert.ok(context.results.every(result => result.attribution.senderKeyFingerprint))
      return { summary: 'RJ verified Iris evidence through Ace.' }
    }
    if (context.specialistAgent.agentId === 'iris') return { status: 'completed', summary: 'Iris evidence 42' }
    if (context.loop.turn === 1) {
      assert.ok(context.eligiblePeers.includes('iris'))
      return { status: 'tool_request', toolCall: { name: 'agent_ask', arguments: { recipientAgentId: 'iris', objective: 'Find fixture evidence' } } }
    }
    assert.match(JSON.stringify(context.loop.observations), /Iris evidence 42/)
    return { status: 'tool_request', toolCall: { name: 'agent_reply', arguments: { summary: 'Ace used Iris evidence 42' } } }
  }, { agentReferenceProvider: { materialize: async () => [{ path: 'MEMORY.md', content: 'Fixture agent.' }] } })
  await runtime.agentRegistry.registerMany(['ace', 'iris'].map(id => agentManifestFromHermesCandidate({
    schema: 'chimera.hermes-agent-candidate.v1', candidateId: `fixture:${id}`, profileId: id,
    displayName: id, sourceRef: `hermes://fixture/profiles/${id}`,
  })))
  let pinnedCalls = 0
  runtime.models.routerFor = async preference => {
    assert.equal(preference.model, 'offline')
    return createDeterministicModelRouter({ routerId: 'openai-compatible:fixture:iris-pin', responder: async (prompt, context) => {
      pinnedCalls++; calls.push({ prompt, context })
      assert.equal(context.specialistAgent.agentId, 'iris')
      return { status: 'completed', summary: 'Iris evidence 42' }
    } })
  }
  await runtime.setAgentModel('iris', { mode: 'pinned', providerId: 'fixture', model: 'offline' })
  const task = await runtime.submitTask({ objective: 'Collaborate with bounded evidence.' })
  const completed = await runtime.waitForTask(task.taskId)
  assert.equal(completed.status, 'completed', JSON.stringify(completed.failure))
  const aceResult = completed.result.results.find((result) => result.specialistAgentId === 'ace')
  const irisResult = completed.result.results.find((result) => result.specialistAgentId === 'iris')
  assert.ok(aceResult?.assignmentMessageId)
  assert.ok(aceResult?.resultId)
  assert.notEqual(aceResult.assignmentMessageId, aceResult.resultId)
  assert.equal(irisResult.canonicalAssignmentId, aceResult.assignmentMessageId)
  const aceStep = completed.steps.find((step) => step.nodeId === 'step-1')
  assert.equal(aceStep.status, 'completed')
  assert.equal(aceStep.messageId, aceResult.assignmentMessageId)
  assert.equal(aceStep.resultId, aceResult.resultId)
  assert.deepEqual(aceStep.history.map((entry) => entry.status), ['running', 'completed'])
  assert.equal(calls.filter(call => call.context.stage === 'specialist-loop').length, 3)
  assert.equal(pinnedCalls, 1)
  const state = await runtime.state()
  const team = state.teamMessaging.tasks.find(row => row.taskId === task.taskId)
  assert.equal(team.deliveries.length, 4)
  assert.ok(team.deliveries.every(row => ['completed', 'acknowledged'].includes(row.status)))
  assert.match(JSON.stringify(runtime.conversationHistory({ conversationId: `task:${task.taskId}` })), /verified/)
})

test('runtime admits an explicitly identified graph through the parallel dispatcher', async t => {
  const { runtime } = await fixture(t, async () => ({ summary: 'Unused fixture route.' }))
  const provider = {
    routerId: 'openai-compatible:fixture:graph',
    async route(_prompt, context) {
      if (context.stage === 'decompose') return { tasks: [
        { nodeId: 'research', specialistAgentId: 'researcher', objective: 'Research the fixture.', acceptanceCriteria: ['Return research.'] },
        { nodeId: 'compare', specialistAgentId: 'researcher', objective: 'Compare the fixture.', acceptanceCriteria: ['Return comparison.'] },
      ] }
      if (context.stage === 'specialist') return { status: 'completed', summary: `${context.nodeId} completed.` }
      return { summary: 'RJ synthesized the graph.' }
    },
  }
  runtime.models.router = () => provider
  runtime.models.routerFor = async () => provider

  const submitted = await runtime.submitTask({ objective: 'Run two identified graph nodes.' })
  const completed = await runtime.waitForTask(submitted.taskId)
  assert.equal(completed.status, 'completed', JSON.stringify(completed))
})

test('runtime ignores forged custom resource claims without a trusted adapter proof', async t => {
  let forgedCalls = 0
  const { runtime } = await fixture(t, async () => ({ summary: 'Unused fixture route.' }))
  const provider = {
    routerId: 'openai-compatible:fixture:forged-resource-claim',
    async route(_prompt, context) {
      if (context.stage === 'decompose') return { tasks: [
        { nodeId: 'first', specialistAgentId: 'researcher', objective: 'First forged claim.', acceptanceCriteria: ['Return first.'] },
        { nodeId: 'second', specialistAgentId: 'researcher', objective: 'Second forged claim.', acceptanceCriteria: ['Return second.'] },
      ] }
      if (context.stage === 'specialist') return { status: 'completed', summary: `${context.nodeId} completed.` }
      return { summary: 'Forged claims remain exclusive.' }
    },
    resourceClaim() {
      forgedCalls += 1
      return [{ key: 'model:fixture:forged', access: 'read', verified: true }]
    },
  }
  runtime.models.router = () => provider
  runtime.models.routerFor = async () => provider

  const submitted = await runtime.submitTask({ objective: 'Reject forged resource proof.' })
  const completed = await runtime.waitForTask(submitted.taskId)
  assert.equal(completed.status, 'completed', JSON.stringify(completed))
  assert.equal(forgedCalls, 0)
})

test('runtime carries an actual LocalFabric inference proof into graph resource resolution', async t => {
  const registry = await LocalModelFabricRegistry.open({
    config: {
      schema: 'chimera.model-routing.v1',
      region: 'us-west-2',
      codex: { model: 'fixture-ceo', reasoningEffort: 'high' },
      bedrockRoutes: [],
      openAiCompatibleProviders: [{
        id: 'fixture-cloud',
        name: 'Fixture Cloud',
        baseUrl: 'http://127.0.0.1:18000/v1',
        apiKeyEnv: 'FIXTURE_CLOUD_KEY',
        models: [{ id: 'fixture-model', name: 'Fixture Model', capabilities: ['conversation', 'orchestration', 'research'] }],
      }],
    },
    audit: new MemoryAuditLog(),
    workingDirectory: '/workspace/chimera',
    codexStatus: { configured: false, authentication: null },
    bedrockModels: [],
    bedrockProfiles: [],
    env: { FIXTURE_CLOUD_KEY: 'fixture-key' },
    openAiCompatibleFetch: async (_url, init) => {
      const body = JSON.parse(init.body)
      const prompt = body.messages?.find(message => message.role === 'user')?.content ?? ''
      const stage = prompt.includes('"stage":"decompose"') ? 'decompose'
        : prompt.includes('"stage":"specialist"') ? 'specialist' : 'synthesize'
      const result = stage === 'decompose'
        ? { tasks: [
          { nodeId: 'research', specialistAgentId: 'researcher', objective: 'Research the actual fixture.', acceptanceCriteria: ['Return research.'] },
          { nodeId: 'compare', specialistAgentId: 'researcher', objective: 'Compare the actual fixture.', acceptanceCriteria: ['Return comparison.'] },
        ] }
        : stage === 'specialist'
          ? { status: 'completed', summary: 'Actual LocalFabric specialist result.' }
          : { summary: 'Actual LocalFabric graph synthesis.' }
      return { ok: true, status: 200, async text() { return JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }) } }
    },
  })
  await registry.select({ providerId: 'fixture-cloud', model: 'fixture-model' })
  const trustedRouter = await registry.routerFor({ mode: 'pinned', providerId: 'fixture-cloud', model: 'fixture-model' })
  assert.deepEqual(trustedRouter.resourceClaim({
    requirements: { capabilities: ['research'] },
    context: { stage: 'specialist', taskId: 'actual-fabric-proof' },
  }), [{ key: 'model:fixture-cloud:fixture-model', access: 'read', verified: true }])
  const { runtime } = await fixture(t, async () => ({ summary: 'Unused fixture route.' }), { modelRegistry: registry })

  const submitted = await runtime.submitTask({ objective: 'Use the actual LocalFabric graph route.' })
  const completed = await runtime.waitForTask(submitted.taskId)
  assert.equal(completed.status, 'completed', JSON.stringify(completed))
})

test('imported harness graph nodes remain exclusive beside an unproven custom route', async t => {
  const researchEntered = gate()
  const researchRelease = gate()
  const harnessEntered = gate()
  let harnessRuns = 0
  const { runtime } = await fixture(t, async () => ({ summary: 'Unused fixture route.' }), {
    agentReferenceProvider: {
      async materialize(_reference, { kind }) {
        if (kind === 'persona') return [{ path: 'SOUL.md', content: 'Fixture harness.' }]
        if (kind === 'memory') return [{ path: 'MEMORY.md', content: 'Fixture memory.' }]
        return [{ path: 'SKILL.md', content: 'Fixture skill.' }]
      },
    },
  })
  const provider = {
    routerId: 'openai-compatible:fixture:harness',
    async route(_prompt, context) {
      if (context.stage === 'decompose') return { tasks: [
        { nodeId: 'research', specialistAgentId: 'researcher', objective: 'Research the proven route.', acceptanceCriteria: ['Return research.'] },
        { nodeId: 'z-harness', specialistAgentId: 'ace', objective: 'Run the imported harness.', acceptanceCriteria: ['Return harness evidence.'] },
      ] }
      if (context.stage === 'specialist') {
        researchEntered.release()
        await researchRelease.promise
        return { status: 'completed', summary: 'Proven inference completed.' }
      }
      if (context.stage === 'specialist-loop') {
        harnessRuns += 1
        harnessEntered.release()
        return { status: 'completed', summary: 'Imported harness completed.' }
      }
      return { summary: 'Harness graph synthesized.' }
    },
  }
  runtime.models.router = () => provider
  runtime.models.routerFor = async () => provider
  await runtime.agentRegistry.registerMany([agentManifestFromHermesCandidate({
    schema: 'chimera.hermes-agent-candidate.v1',
    candidateId: 'fixture:ace', profileId: 'ace', displayName: 'Ace', sourceRef: 'hermes://fixture/profiles/ace',
  })])

  t.after(() => researchRelease.release())
  const submitted = await runtime.submitTask({ objective: 'Keep imported harness work exclusive.' })
  let entryTimeout
  try {
    await Promise.race([
      researchEntered.promise,
      new Promise((_, reject) => {
        entryTimeout = setTimeout(() => reject(new Error(`research node did not enter: ${JSON.stringify(runtime.tasks.get(submitted.taskId))}`)), 3000)
      }),
    ])
  } finally {
    clearTimeout(entryTimeout)
  }
  assert.equal(harnessRuns, 0)
  researchRelease.release()
  await harnessEntered.promise
  const completed = await runtime.waitForTask(submitted.taskId)
  assert.equal(completed.status, 'completed', JSON.stringify(completed))
  assert.equal(harnessRuns, 1)
})

test('cancelled delayed peer model cannot dispatch its proposed filesystem tool', async t => {
  const entered = gate(), release = gate(); let effects = 0
  const { runtime } = await fixture(t, async (_prompt, context) => {
    if (context.stage === 'decompose') return plan('ace')
    if (context.stage === 'specialist-loop') {
      entered.release(); await release.promise
      return { status: 'tool_request', toolCall: { name: 'write', arguments: { path: 'scratch/late', content: 'late' } } }
    }
    throw new Error('No synthesis after cancellation')
  }, { agentReferenceProvider: { materialize: async () => [{ path: 'MEMORY.md', content: 'Fixture.' }] },
    workerToolExecutors: { write: async () => { effects++; return {} } } })
  await runtime.agentRegistry.registerMany([agentManifestFromHermesCandidate({ schema: 'chimera.hermes-agent-candidate.v1',
    candidateId: 'fixture:ace', profileId: 'ace', displayName: 'Ace', sourceRef: 'hermes://fixture/profiles/ace' })])
  const task = await runtime.submitTask({ objective: 'Delayed model.' })
  await entered.promise; await runtime.cancelTask({ taskId: task.taskId })
  await assert.rejects(runtime.submitTask({ objective: 'Cannot overlap pending physical call.' }))
  release.release(); assert.equal((await runtime.waitForTask(task.taskId)).status, 'cancelled')
  assert.equal(effects, 0)
  assert.equal(runtime.agentMailbox.list({ taskId: task.taskId })[0].status, 'interrupted')
})

test('runtime async send drains signed blocker into RJ synthesis before root completion', async t => {
  const entered = gate(), release = gate(); let synthesized = false
  const { runtime } = await fixture(t, async (_prompt, context) => {
    if (context.stage === 'decompose') return plan('ace')
    if (context.stage === 'synthesize') {
      synthesized = true
      assert.ok(context.results.some(result => result.status === 'failed' && result.summary === 'Missing fixture evidence.'))
      return { summary: 'RJ reports the signed Iris blocker.' }
    }
    if (context.specialistAgent.agentId === 'iris') {
      entered.release(); await release.promise
      return { status: 'tool_request', toolCall: { name: 'agent_report_blocker', arguments: { summary: 'Missing fixture evidence.' } } }
    }
    if (context.loop.turn === 1) return { status: 'tool_request', toolCall: { name: 'agent_send', arguments: { recipientAgentId: 'iris', objective: 'Check evidence.' } } }
    assert.equal(context.loop.observations[0].status, 'queued')
    return { status: 'completed', summary: 'Queued Iris.' }
  }, { agentReferenceProvider: { materialize: async () => [{ path: 'MEMORY.md', content: 'Fixture.' }] } })
  await runtime.agentRegistry.registerMany(['ace', 'iris'].map(id => agentManifestFromHermesCandidate({ schema: 'chimera.hermes-agent-candidate.v1',
    candidateId: `fixture:${id}`, profileId: id, displayName: id, sourceRef: `hermes://fixture/profiles/${id}` })))
  const task = await runtime.submitTask({ objective: 'Send background check.' })
  await entered.promise
  await new Promise(r => setTimeout(r, 20))
  assert.equal(synthesized, false); assert.equal(runtime.tasks.get(task.taskId).status, 'running')
  release.release()
  const completed = await runtime.waitForTask(task.taskId)
  assert.equal(completed.status, 'completed', JSON.stringify(completed.failure))
  assert.equal(runtime.agentMailbox.list({ taskId: task.taskId }).length, 4)
})

test('direct specialist selection forbids hidden peer delegation and shared tool budget spans peer jobs', async t => {
  let mode = 'direct'
  const { runtime, calls } = await fixture(t, async (_prompt, context) => {
    if (context.stage === 'decompose') return plan('ace')
    if (context.stage === 'synthesize') return { summary: 'Bounded failure reported.' }
    if (context.specialistAgent.agentId === 'ace') {
      if (mode === 'direct') await assert.rejects(runtime.messageTask({ taskId: context.taskId, content: 'No hidden peer scope', recipientAgentIds: ['iris'] }), { code: 'TASK_MESSAGE_RECIPIENT_INVALID' })
      if (context.loop.turn === 1) return { status: 'tool_request', toolCall: { name: 'agent_ask', arguments: { recipientAgentId: 'iris', objective: 'Evidence' } } }
      return { status: 'tool_request', toolCall: { name: 'agent_reply', arguments: { summary: 'Reply' } } }
    }
    assert.equal(mode, 'budget')
    return { status: 'tool_request', toolCall: { name: 'agent_inbox', arguments: {} } }
  }, { agentReferenceProvider: { materialize: async () => [{ path: 'MEMORY.md', content: 'Fixture.' }] } })
  await runtime.agentRegistry.registerMany(['ace', 'iris'].map(id => agentManifestFromHermesCandidate({ schema: 'chimera.hermes-agent-candidate.v1',
    candidateId: `fixture:${id}`, profileId: id, displayName: id, sourceRef: `hermes://fixture/profiles/${id}` })))
  const direct = await runtime.sendMessage({ content: 'Only Ace.', recipientAgentId: 'ace' })
  await runtime.waitForTask(direct.task.taskId)
  assert.equal(calls.some(call => call.context.specialistAgent?.agentId === 'iris'), false)
  assert.equal(runtime.agentMailbox.list({ taskId: direct.task.taskId })[0].reason, 'TEAM_PEER_NOT_ELIGIBLE')
  mode = 'budget'
  const task = await runtime.submitTask({ objective: 'Shared budget.', budget: { maxTurns: 5, maxToolCalls: 1 } })
  const result = await runtime.waitForTask(task.taskId)
  assert.equal(result.status, 'failed')
  assert.equal(result.failure.code, 'AGENT_LOOP_TOOL_LIMIT')
  assert.equal(result.checkpoint.budgetUsage.toolCalls, 1)
})

test('project peer eligibility and signed scopes never mint a lease for an unstaffed specialist', async t => {
  let seenDispatcher
  const { runtime, directory } = await fixture(t, async (_prompt, context) => {
    if (context.stage === 'decompose') return plan('ace')
    if (context.stage === 'synthesize') return { summary: 'Unstaffed peer rejected.' }
    assert.equal(context.specialistAgent.agentId, 'ace')
    assert.equal(context.eligiblePeers.includes('iris'), false)
    await assert.rejects(runtime.messageTask({ taskId: context.taskId, content: 'Unleased staff', recipientAgentIds: ['iris'] }), { code: 'TASK_MESSAGE_RECIPIENT_INVALID' })
    seenDispatcher = runtime.teamDispatchers.get(context.taskId)
    assert.equal(seenDispatcher.maxExecuting, 1)
    return { status: 'tool_request', toolCall: { name: 'agent_ask', arguments: { recipientAgentId: 'iris', objective: 'Expand staff' } } }
  }, { projectAllowedRoots: [tmpdir()], agentReferenceProvider: { materialize: async () => [{ path: 'MEMORY.md', content: 'Fixture.' }] } })
  const source = join(directory, 'source'); await mkdir(source)
  const git = (...args) => promisify(execFileCallback)('git', args, { cwd: source })
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Test'); await git('config', 'user.email', 'test@example.invalid')
  await writeFile(join(source, 'README.md'), 'Fixture\n'); await git('add', 'README.md'); await git('commit', '-m', 'Fixture')
  await runtime.agentRegistry.registerMany(['ace', 'iris'].map(id => agentManifestFromHermesCandidate({ schema: 'chimera.hermes-agent-candidate.v1',
    candidateId: `fixture:${id}`, profileId: id, displayName: id, sourceRef: `hermes://fixture/profiles/${id}` })))
  const project = await runtime.registerProject({ mode: 'local', name: 'Peer scope', path: source })
  const task = await runtime.submitProjectTask({ projectId: project.projectId, objective: 'Use only leased staff.' })
  await runtime.waitForTask(task.taskId)
  assert.ok(seenDispatcher)
  assert.equal(runtime.taskAccessLeases.list().some(lease => lease.agentId === 'iris'), false)
  assert.equal(runtime.specialistSecurity.get('ace').grant.payload.scopes.some(scope => scope.resource === 'agent:iris'), false)
  assert.equal(runtime.workers.has('iris'), false)
})

test('steering during lazy peer materialization prevents the superseded handoff and replans Ace', async t => {
  const entered = gate(), release = gate(); let irisRuns = 0, materialized = false
  const { runtime } = await fixture(t, async (_prompt, context) => {
    if (context.stage === 'decompose') return plan('ace')
    if (context.stage === 'synthesize') return { summary: 'Revised scope only.' }
    if (context.specialistAgent.agentId === 'iris') { irisRuns++; return { status: 'completed', summary: 'Stale work.' } }
    if (context.steering.length) return { status: 'completed', summary: 'Ace used revised scope.' }
    return { status: 'tool_request', toolCall: { name: 'agent_send', arguments: { recipientAgentId: 'iris', objective: 'Obsolete delegation.' } } }
  }, { agentReferenceProvider: { materialize: async reference => {
    if (reference.includes('/iris') && !materialized) { materialized = true; entered.release(); await release.promise }
    return [{ path: 'MEMORY.md', content: 'Fixture.' }]
  } } })
  await runtime.agentRegistry.registerMany(['ace', 'iris'].map(id => agentManifestFromHermesCandidate({ schema: 'chimera.hermes-agent-candidate.v1',
    candidateId: `fixture:${id}`, profileId: id, displayName: id, sourceRef: `hermes://fixture/profiles/${id}` })))
  const task = await runtime.submitTask({ objective: 'Initially ask Iris.' })
  await entered.promise
  await runtime.steerTask({ taskId: task.taskId, content: 'Do not contact Iris. Only summarize what Ace already knows.' })
  release.release()
  const result = await runtime.waitForTask(task.taskId)
  assert.equal(result.status, 'completed', JSON.stringify(result.failure))
  assert.equal(irisRuns, 0)
  assert.equal(runtime.agentMailbox.list({ taskId: task.taskId }).some(row => row.agentId === 'iris'), false)
})

for (const mode of ['builtin', 'automatic', 'reply', 'blocker']) test(`signed ${mode} result is redacted before mailbox persistence`, async t => {
  const marker = 'password=fixture-only-do-not-persist'
  const { runtime } = await fixture(t, async (_prompt, context) => {
    if (context.stage === 'decompose') return plan(mode === 'builtin' ? 'researcher' : 'ace')
    if (context.stage === 'synthesize') return { summary: 'Redacted evidence.' }
    if (mode === 'builtin') return { summary: marker, nested: { password: 'fixture-only-do-not-persist' } }
    if (mode === 'automatic') return { status: 'completed', summary: marker }
    return { status: 'tool_request', toolCall: { name: mode === 'reply' ? 'agent_reply' : 'agent_report_blocker', arguments: { summary: marker } } }
  }, { agentReferenceProvider: { materialize: async () => [{ path: 'MEMORY.md', content: 'Fixture.' }] } })
  if (mode !== 'builtin') await runtime.agentRegistry.registerMany([agentManifestFromHermesCandidate({ schema: 'chimera.hermes-agent-candidate.v1',
    candidateId: 'fixture:ace', profileId: 'ace', displayName: 'Ace', sourceRef: 'hermes://fixture/profiles/ace' })])
  const task = await runtime.submitTask({ objective: 'Return synthetic sensitive fixture data.' })
  assert.equal((await runtime.waitForTask(task.taskId)).status, 'completed')
  const journal = await readFile(runtime.mailboxFile, 'utf8')
  assert.equal(journal.includes('fixture-only-do-not-persist'), false)
  assert.ok(journal.includes('[REDACTED]'))
  assert.equal(runtime.agentMailbox.list({ taskId: task.taskId }).find(row => row.type === 'task_handoff').status, 'completed')
})

test('followup provides bounded prior conversation and signed project-result summaries to all stages', async (t) => {
  const { runtime, calls } = await fixture(t, async (_prompt, context) => context.stage === 'decompose' ? plan()
    : { summary: context.stage === 'specialist' ? 'Artifact: report.md; confirmed result 42.' : 'The answer is 42.' })
  const first = await runtime.sendMessage({ content: 'Compute the result.' })
  await runtime.waitForTask(first.task.taskId)
  const second = await runtime.sendMessage({ content: 'Explain that result.' })
  const completed = await runtime.waitForTask(second.task.taskId)
  assert.equal(completed.status, 'completed', JSON.stringify(completed.failure))
  const followup = calls.filter(({ context }) => context.taskId === second.task.taskId)
  assert.equal(followup.length, 3)
  for (const { context } of followup) {
    assert.match(JSON.stringify(context.history), /The answer is 42/)
    assert.match(JSON.stringify(context.history), /report.md/)
    assert.equal(context.history.tasks[0].taskId, first.task.taskId)
    assert.ok(JSON.stringify(context.history).length < 100_000)
  }
  assert.equal((await runtime.state()).agents.main.status, 'Idle')
  assert.equal((await runtime.state()).hourlyCost, null)
  const taskPage = runtime.taskHistory({ limit: 1 })
  assert.equal(taskPage.tasks[0].taskId, second.task.taskId)
  assert.equal(runtime.taskHistory({ limit: 1, before: taskPage.nextCursor }).tasks[0].taskId, first.task.taskId)
  const messagePage = runtime.conversationHistory({ limit: 2 })
  assert.equal(messagePage.messages[0].taskId, second.task.taskId)
  assert.equal(runtime.conversationHistory({ limit: 2, before: messagePage.nextCursor }).messages[0].taskId, first.task.taskId)
  assert.throws(() => runtime.taskHistory({ limit: 201 }), { code: 'TASK_LIST_LIMIT_INVALID' })
  assert.throws(() => runtime.conversationHistory({ limit: 0 }), { code: 'CONVERSATION_LIST_LIMIT_INVALID' })
})

test('cancellation during planning prevents later calls and explicit continuation retains durable linkage', async (t) => {
  const entered = gate()
  const release = gate()
  let first = true
  const { runtime, calls } = await fixture(t, async (_prompt, context) => {
    if (context.stage === 'decompose') {
      if (first) { first = false; entered.release(); await release.promise }
      return plan()
    }
    return { summary: 'Fresh continuation finished.' }
  })
  const task = await runtime.submitTask({ objective: 'Original work.', budget: { maxTurns: 40, maxToolCalls: 30 } })
  await entered.promise
  const cancelled = await runtime.cancelTask({ taskId: task.taskId })
  assert.equal(cancelled.status, 'cancelled')
  assert.equal((await runtime.state()).agents.main.status, 'Cancelling')
  release.release()
  assert.equal((await runtime.waitForTask(task.taskId)).status, 'cancelled')
  assert.equal(calls.length, 1)
  await assert.rejects(runtime.continueTask({ taskId: task.taskId }))
  const next = await runtime.continueTask({ taskId: task.taskId, objective: 'Inspect what happened, then summarize.' })
  assert.notEqual(next.taskId, task.taskId)
  assert.equal(next.context.priorTaskId, task.taskId)
  assert.deepEqual(next.context.budget, { maxTurns: 40, maxToolCalls: 30 })
  const continued = await runtime.waitForTask(next.taskId)
  assert.equal(continued.status, 'completed', JSON.stringify(continued.failure))
  assert.match(calls[1].context.continuation.instruction, /Never replay/)
  assert.equal(calls[1].context.history.tasks[0].status, 'cancelled')
  assert.equal(calls[1].prompt, 'Inspect what happened, then summarize.')
})

test('steering during planning discards stale plan before delegation and reaches next model call', async (t) => {
  const entered = gate()
  const release = gate()
  let plans = 0
  const { runtime, calls } = await fixture(t, async (_prompt, context) => {
    if (context.stage === 'decompose') {
      plans += 1
      if (plans === 1) { entered.release(); await release.promise; return plan('researcher', 'Outdated task') }
      assert.equal(context.steering[0].content, 'Use the revised scope.')
      return plan('researcher', 'Revised task')
    }
    return { summary: 'Revised result.' }
  })
  const task = await runtime.submitTask({ objective: 'Initial scope.' })
  await entered.promise
  await runtime.steerTask({ taskId: task.taskId, content: 'Use the revised scope.' })
  release.release()
  const completed = await runtime.waitForTask(task.taskId)
  assert.equal(completed.status, 'completed')
  assert.equal(plans, 2)
  assert.equal(calls.find(({ context }) => context.stage === 'specialist').prompt, 'Revised task')
  assert.equal(completed.steering.length, 1)
  assert.equal(completed.lastCompletedWork.stage, 'specialist-completed')
})

test('cancelling a pending worker approval denies the action and stops future model calls', async (t) => {
  let executed = 0
  const { runtime, calls } = await fixture(t, async (_prompt, context) => {
    if (context.stage === 'decompose') return plan('ace')
    if (context.stage === 'specialist-loop') return { status: 'tool_request', toolCall: { name: 'write', arguments: { path: 'scratch/result.txt', content: 'pending' } } }
    return { summary: 'must not synthesize' }
  }, {
    agentReferenceProvider: { materialize: async () => [{ path: 'MEMORY.md', content: 'Local test continuity.' }] },
    workerToolExecutors: { write: async () => { executed += 1; return { ok: true } } },
  })
  await runtime.agentRegistry.registerMany([agentManifestFromHermesCandidate({
    schema: 'chimera.hermes-agent-candidate.v1', candidateId: 'fixture:ace', profileId: 'ace',
    displayName: 'Ace', sourceRef: 'hermes://fixture/profiles/ace',
  })])
  const task = await runtime.submitTask({ objective: 'Write the bounded artifact.' })
  const waitingStep = await waitFor(
    () => runtime.tasks.get(task.taskId)?.steps?.find((step) => step.nodeId === 'step-1'),
    (step) => step?.status === 'waiting-for-approval',
  )
  const decision = await waitFor(
    () => runtime.decisions.pending().find((candidate) => candidate.taskId === task.taskId
      && candidate.nodeId === waitingStep.nodeId
      && candidate.canonicalAssignmentId === waitingStep.messageId),
    Boolean,
  )
  assert.equal((await runtime.state()).agents.main.status, 'Waiting')
  assert.equal(runtime.tasks.get(task.taskId).checkpoint.effectOutcome, 'unknown')
  assert.equal(waitingStep.status, 'waiting-for-approval')
  assert.match(waitingStep.messageId, /^handoff-/)
  assert.equal(waitingStep.resultId, null)
  assert.equal(waitingStep.history.at(-1).status, 'waiting-for-approval')
  assert.equal(decision.taskId, task.taskId)
  assert.equal(decision.nodeId, 'step-1')
  assert.equal(decision.assignmentId, waitingStep.messageId)
  assert.equal(decision.canonicalAssignmentId, waitingStep.messageId)
  await runtime.cancelTask({ taskId: task.taskId })
  const terminal = await runtime.waitForTask(task.taskId)
  assert.equal(terminal.status, 'cancelled')
  const cancelledStep = terminal.steps.find((step) => step.nodeId === 'step-1')
  assert.equal(cancelledStep.status, 'cancelled')
  assert.equal(cancelledStep.messageId, waitingStep.messageId)
  assert.equal(cancelledStep.resultId, null)
  assert.equal(runtime.decisions.get(decision.actionId).status, 'cancelled')
  assert.equal((await runtime.decide(decision.actionId, 'approve')).status, 'denied')
  assert.equal(executed, 0)
  assert.equal(calls.filter(({ context }) => context.stage === 'specialist-loop').length, 1)
  assert.equal(calls.some(({ context }) => context.stage === 'synthesize'), false)
  assert.equal(terminal.checkpoint.observation.status, 'denied')
  assert.equal(terminal.lastCompletedWork, undefined)
})

test('cancellation also denies an RJ approval that finishes posting after the cancel request', async (t) => {
  const entered = gate()
  const release = gate()
  const { runtime } = await fixture(t, async (_prompt, context) => {
    if (context.stage === 'decompose') return plan()
    if (context.stage === 'specialist') return { summary: 'Prepared the result.' }
    return { summary: 'Requesting delivery.', decision: { capability: 'external.message', resource: 'telegram:chimera-hq', operation: 'send',
      actionDiff: { before: null, after: { message: 'Bounded fixture result' } }, rationale: 'Review delivery.' } }
  })
  const post = runtime.decisions.post.bind(runtime.decisions)
  runtime.decisions.post = async (input) => { entered.release(); await release.promise; return post(input) }
  const task = await runtime.submitTask({ objective: 'Prepare a delivery for review.' })
  await entered.promise
  await runtime.cancelTask({ taskId: task.taskId })
  release.release()
  assert.equal((await runtime.waitForTask(task.taskId)).status, 'cancelled')
  assert.equal(runtime.decisions.pending().length, 0)
})

test('explicit project continuation reuses partial artifacts and fresh leases after budget exhaustion', async (t) => {
  const { runtime, calls, directory } = await fixture(t, async (_prompt, context) => {
    if (context.stage === 'decompose') return plan('ace', context.continuation ? 'Inspect the existing artifact.' : 'Create the artifact.')
    if (context.stage === 'specialist-loop') {
      if (!context.continuation) return { status: 'tool_request', toolCall: { name: 'write', arguments: { path: 'scratch/repo/partial.txt', content: 'durable partial work\n' } } }
      if (context.loop.turn === 1) return { status: 'tool_request', toolCall: { name: 'read', arguments: { path: 'scratch/repo/partial.txt' } } }
      assert.match(JSON.stringify(context.loop.observations), /durable partial work/)
      return { status: 'completed', summary: 'Verified the prior artifact.' }
    }
    return { summary: 'Existing project result verified.' }
  }, { projectAllowedRoots: [tmpdir()], agentReferenceProvider: { materialize: async () => [{ path: 'MEMORY.md', content: 'Use isolated project files.' }] } })
  const execFile = promisify(execFileCallback)
  const source = join(directory, 'source')
  await mkdir(source)
  const git = (...args) => execFile('git', args, { cwd: source })
  await git('init', '-b', 'main')
  await git('config', 'user.name', 'Test')
  await git('config', 'user.email', 'test@example.invalid')
  await writeFile(join(source, 'README.md'), 'fixture\n')
  await git('add', 'README.md')
  await git('commit', '-m', 'Fixture')
  await runtime.agentRegistry.registerMany([agentManifestFromHermesCandidate({
    schema: 'chimera.hermes-agent-candidate.v1', candidateId: 'fixture:ace', profileId: 'ace',
    displayName: 'Ace', sourceRef: 'hermes://fixture/profiles/ace',
  })])
  const project = await runtime.registerProject({ mode: 'local', name: 'Continuation', path: source })
  const first = await runtime.submitProjectTask({ projectId: project.projectId, objective: 'Create a partial artifact.', budget: { maxTurns: 1, maxToolCalls: 1 } })
  const decision = await waitFor(() => runtime.decisions.pending()[0], Boolean)
  await runtime.decide(decision.actionId, 'approve')
  const stopped = await runtime.waitForTask(first.taskId)
  assert.equal(stopped.status, 'failed')
  assert.equal(stopped.lastCompletedWork.tool, 'write')
  const original = runtime.projectSessions.get(first.taskId)
  assert.match(await readFile(join(original.workspace.repositoryPath, 'partial.txt'), 'utf8'), /durable partial work/)
  const next = await runtime.continueTask({ taskId: first.taskId, objective: 'Inspect the existing artifact; do not repeat the write.', budget: { maxTurns: 3, maxToolCalls: 2 } })
  const finished = await runtime.waitForTask(next.taskId)
  assert.equal(finished.status, 'completed', JSON.stringify(finished.failure))
  assert.equal(next.context.projectSessionTaskId, first.taskId)
  const nextContext = calls.find(({ context }) => context.taskId === next.taskId && context.stage === 'specialist-loop').context
  assert.equal(nextContext.project.projectId, project.projectId)
  assert.equal(nextContext.continuation.projectSessionTaskId, first.taskId)
  assert.equal(runtime.projectSessions.get(first.taskId).workspace.repositoryPath, original.workspace.repositoryPath)
  assert.match((await runtime.projectReview(next.taskId)).patch, /durable partial work/)
  assert.equal(runtime.taskAccessLeases.list().filter((lease) => lease.taskId === next.taskId).length, 1)
  await assert.rejects(readFile(join(source, 'partial.txt')), { code: 'ENOENT' })
  const review = await runtime.projectReview(next.taskId)
  await runtime.commitProjectSession({ taskId: next.taskId, message: 'Accept the verified fixture', expectedReviewDigest: review.reviewDigest })
  const afterCommit = await runtime.continueTask({ taskId: next.taskId, objective: 'Verify the accepted result in a fresh session.' })
  assert.equal((await runtime.waitForTask(afterCommit.taskId)).status, 'completed')
  assert.equal(afterCommit.context.projectId, project.projectId)
  assert.equal(afterCommit.context.projectSessionTaskId, afterCommit.taskId)
  assert.notEqual(runtime.projectSessions.get(afterCommit.taskId).workspace.repositoryPath, original.workspace.repositoryPath)
  assert.equal(runtime.projectSessions.get(first.taskId).status, 'committed')
})
