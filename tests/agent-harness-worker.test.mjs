import assert from 'node:assert/strict'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoryAuditLog } from '../src/audit-log.mjs'
import { createAgentMessageEnvelope } from '../src/agent-message.mjs'
import { agentManifestFromHermesCandidate } from '../src/agents/registry.mjs'
import { AgentWorkerWorkspace } from '../src/agents/worker-workspace.mjs'
import { DurableAgentMailbox } from '../src/agents/mailbox.mjs'
import { loadDshEffectInventory } from '../src/dsh/effect-inventory.mjs'
import { ChimeraGateway } from '../src/gateway.mjs'
import { exportPublicKey, fingerprint, generateIdentity, signDecision, signGrant } from '../src/identity.mjs'
import { createEd25519SigningProvider } from '../src/signing-provider.mjs'
import { createHarnessExecutors } from '../src/agents/harness-executors.mjs'

const clock = Date.parse('2026-08-29T22:00:00.000Z')
const window = { issuedAt: '2026-08-29T21:55:00.000Z', expiresAt: '2026-08-29T22:30:00.000Z' }

async function removeTree(path) {
  try {
    const info = await lstat(path)
    if (info.isDirectory()) {
      await chmod(path, 0o700)
      for (const entry of await readdir(path)) await removeTree(join(path, entry))
    } else await chmod(path, 0o600)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  await rm(path, { recursive: true, force: true })
}

async function fixture(directory, { readTier = 'auto', approvalBroker } = {}) {
  const { AgentHarnessWorker } = await import('../src/agents/harness-worker.mjs')
  const human = generateIdentity('rod')
  const ceo = generateIdentity('ceo')
  const ace = generateIdentity('ace')
  const audit = new MemoryAuditLog()
  const humanKeys = [[human.keyId, exportPublicKey(human.publicKey)]]
  const gateway = new ChimeraGateway({
    policy: {
      version: 1, defaultTier: 'blocked', rules: [
        { id: 'handoff', capability: 'agent.message.task_handoff', resource: 'agent:ace', tier: 'auto' },
        { id: 'result', capability: 'agent.message.structured_result', resource: 'agent:ceo', tier: 'auto' },
        { id: 'read', capability: 'filesystem.read', resource: 'dsh-tool:read', tier: readTier },
      ],
    },
    humanKeys, audit, now: () => clock,
  })
  const ceoGrant = signGrant({
    grantId: 'ceo-worker-grant', humanId: 'rod', agentId: 'ceo', agentKeyFingerprint: fingerprint(ceo.publicKey),
    maxTier: 'auto', scopes: [{ capability: 'agent.message.task_handoff', resource: 'agent:ace' }], ...window,
  }, human)
  const workerGrant = signGrant({
    grantId: 'ace-worker-grant', humanId: 'rod', agentId: 'ace', agentKeyFingerprint: fingerprint(ace.publicKey),
    maxTier: readTier === 'confirm' ? 'confirm' : 'auto', scopes: [
      { capability: 'agent.message.structured_result', resource: 'agent:ceo' },
      { capability: 'filesystem.read', resource: 'dsh-tool:read' },
    ], ...window,
  }, human)
  const manifest = agentManifestFromHermesCandidate({
    schema: 'chimera.hermes-agent-candidate.v1', candidateId: 'hermes-aws:ace', profileId: 'ace',
    displayName: 'Ace', sourceRef: 'hermes://configured-hermes/profiles/ace',
  })
  const workspace = await AgentWorkerWorkspace.open({
    rootDir: join(directory, 'workers'), manifest, audit,
    referenceProvider: {
      async materialize(_reference, { kind }) {
        if (kind === 'persona') return [{ path: 'SOUL.md', content: 'Ace worker fixture.' }]
        if (kind === 'memory') return [{ path: 'MEMORY.md', content: '' }]
        return []
      },
    }, now: () => clock,
  })
  const mailbox = await DurableAgentMailbox.open({ filePath: join(directory, 'mailbox.jsonl'), audit, now: () => clock })
  let modelRuns = 0
  const toolRuns = { read: 0, bash: 0 }
  const options = {
    manifest, workspace, mailbox, identity: ace, grant: workerGrant, gateway, audit, humanKeys,
    approvalBroker,
    stateFile: join(directory, 'workers.json'), inventory: await loadDshEffectInventory(), now: () => clock,
    executeModel: async () => { modelRuns += 1; return { summary: 'Ace completed the work.' } },
    toolExecutors: {
      read: async () => { toolRuns.read += 1; return { content: 'safe' } },
      bash: async () => { toolRuns.bash += 1; return { content: 'unsafe' } },
    },
  }
  return { AgentHarnessWorker, human, ace, ceo, ceoGrant, workerGrant, humanKeys, mailbox, options, modelRuns: () => modelRuns, toolRuns }
}

test('CEO dispatch reaches a running worker through the durable signed mailbox', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-harness-dispatch-'))
  try {
    const f = await fixture(directory)
    const worker = await f.AgentHarnessWorker.open(f.options)
    await worker.start()
    const envelope = createAgentMessageEnvelope({
      signingProvider: createEd25519SigningProvider(f.ceo), senderAgentId: 'ceo', recipientAgentId: 'ace',
      messageId: 'handoff-worker-1', type: 'task_handoff', taskId: 'task-worker-1', ...window,
      content: { objective: 'Complete the bounded work.', acceptanceCriteria: ['Return a result.'] },
    })
    const result = await worker.handle({
      envelope, senderGrant: f.ceoGrant,
      sender: { agentId: 'ceo', publicIdentity: createEd25519SigningProvider(f.ceo).publicIdentity() },
    })
    assert.equal(result.status, 'completed')
    assert.equal(f.modelRuns(), 1)
    assert.deepEqual(f.mailbox.pending('ace'), [])
    assert.equal(f.mailbox.pending('ceo')[0].payload.type, 'structured_result')
  } finally {
    await removeTree(directory)
  }
})

test('every worker tool call goes through DSH and a denied call never reaches its body', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-harness-dsh-'))
  try {
    const f = await fixture(directory)
    const worker = await f.AgentHarnessWorker.open(f.options)
    await worker.start()
    assert.equal((await worker.executeTool({ name: 'read', arguments: { path: 'mounts/memory/MEMORY.md' } })).status, 'completed')
    assert.equal((await worker.executeTool({ name: 'bash', arguments: { command: 'id' } })).reason, 'OUTSIDE_GRANT_SCOPE')
    assert.deepEqual(f.toolRuns, { read: 1, bash: 0 })
  } finally {
    await removeTree(directory)
  }
})

test('an executor exception after tool entry remains an unknown effect, not an ordinary failed result', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-harness-tool-unknown-'))
  try {
    const f = await fixture(directory)
    f.options.toolExecutors.read = async () => {
      f.toolRuns.read += 1
      throw Object.assign(new Error('response lost after mutation'), { code: 'FIXTURE_RESPONSE_LOST', dispatchState: 'not_sent' })
    }
    const worker = await f.AgentHarnessWorker.open(f.options)
    await worker.start()
    const result = await worker.executeTool({ name: 'read', arguments: { path: 'mounts/memory/MEMORY.md' }, callId: 'unknown-tool-call' })
    assert.equal(result.status, 'unknown')
    assert.equal(result.reason, 'WORKER_TOOL_OUTCOME_UNKNOWN')
    assert.equal(f.toolRuns.read, 1)
  } finally { await removeTree(directory) }
})

test('an entered executor cannot forge a pre-entry lease denial code to permit retry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-harness-forged-lease-code-'))
  try {
    const f = await fixture(directory)
    f.options.toolExecutors.read = async () => {
      f.toolRuns.read += 1
      throw Object.assign(new Error('effect may already have happened'), { code: 'PROJECT_ACCESS_LEASE_INACTIVE' })
    }
    const worker = await f.AgentHarnessWorker.open(f.options)
    await worker.start()
    const result = await worker.executeTool({ name: 'read', arguments: { path: 'mounts/memory/MEMORY.md' }, callId: 'forged-lease-call' })
    assert.equal(result.status, 'unknown')
    assert.equal(result.reason, 'WORKER_TOOL_OUTCOME_UNKNOWN')
    assert.equal(f.toolRuns.read, 1)
  } finally { await removeTree(directory) }
})

test('trusted task context can bind a shared project workspace and narrower access lease', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-harness-project-context-'))
  try {
    const f = await fixture(directory)
    let observed
    f.options.toolExecutors.read = async (_args, context) => {
      observed = context
      return { content: 'project file' }
    }
    const worker = await f.AgentHarnessWorker.open(f.options)
    await worker.start()
    const projectWorkspace = { path: join(directory, 'project-session'), state: () => ({ path: join(directory, 'project-session') }) }
    const result = await worker.executeTool(
      { name: 'read', arguments: { path: 'scratch/repo/README.md' } },
      { workspace: projectWorkspace, accessProfileId: 'sandbox', networkHosts: [] },
    )
    assert.equal(result.status, 'completed')
    assert.equal(observed.workspace.path, projectWorkspace.path)
    assert.equal(observed.accessProfileId, 'sandbox')
    assert.deepEqual(observed.networkHosts, [])
  } finally {
    await removeTree(directory)
  }
})

test('identity receipts cannot escape a revoked access lease while the root task remains active', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-harness-receipt-lease-'))
  try {
    const f = await fixture(directory)
    let active = true
    let reads = 0
    f.options.toolExecutors = createHarnessExecutors({ accessProfileFor: () => 'sandbox' })
    const worker = await f.AgentHarnessWorker.open(f.options)
    await worker.start()
    const workspace = {
      path: directory, state: () => ({ path: directory }),
      async readProjectIdentity() { reads += 1; active = false; return { checkoutCommit: 'must-not-be-returned' } },
    }
    const result = await worker.executeTool(
      { name: 'read', arguments: { path: 'mounts/project/identity.json' } },
      { workspace, taskScoped: true, assertActive: () => active, assertTaskActive: () => true },
    )
    assert.equal(result.status, 'unknown')
    assert.equal(result.reason, 'WORKER_TOOL_OUTCOME_UNKNOWN')
    assert.equal(reads, 1)
  } finally { await removeTree(directory) }
})

test('a task lease is revalidated after a delayed human approval before tool execution', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-harness-lease-recheck-'))
  let f
  try {
    f = await fixture(directory, {
      readTier: 'confirm',
      approvalBroker: {
        async request(request) {
          return signDecision({
            actionId: request.actionId,
            challengeHash: request.challengeHash,
            outcome: 'approve',
            issuedAt: '2026-08-29T21:59:59.000Z',
            expiresAt: '2026-08-29T22:05:00.000Z',
          }, f.human)
        },
      },
    })
    const worker = await f.AgentHarnessWorker.open(f.options)
    await worker.start()
    const result = await worker.executeTool(
      { name: 'read', arguments: { path: 'scratch/repo/README.md' } },
      { accessProfileId: 'sandbox', networkHosts: [], taskScoped: true, assertActive: () => false },
    )
    assert.deepEqual(result, { status: 'denied', reason: 'PROJECT_ACCESS_LEASE_INACTIVE' })
    assert.equal(f.toolRuns.read, 0)
  } finally {
    await removeTree(directory)
  }
})

test('a running worker is marked interrupted after process restart and can recover explicitly', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-harness-recovery-'))
  try {
    const f = await fixture(directory)
    const first = await f.AgentHarnessWorker.open(f.options)
    await first.start()
    const reopened = await f.AgentHarnessWorker.open(f.options)
    assert.equal(reopened.status().state, 'interrupted')
    assert.equal(reopened.health().healthy, false)
    await reopened.recover()
    assert.equal(reopened.status().state, 'running')
    assert.equal(reopened.status().restartCount, 1)
    await reopened.stop()
    assert.equal(reopened.status().state, 'stopped')
  } finally {
    await removeTree(directory)
  }
})

function workerInput(f) {
  return { envelope: createAgentMessageEnvelope({
    signingProvider: createEd25519SigningProvider(f.ceo), senderAgentId: 'ceo', recipientAgentId: 'ace',
    messageId: 'handoff-worker-atomic', type: 'task_handoff', taskId: 'task-worker-atomic', ...window,
    content: { objective: 'Complete the bounded work.', acceptanceCriteria: ['Return a result.'] },
  }), senderGrant: f.ceoGrant,
  sender: { agentId: 'ceo', publicIdentity: createEd25519SigningProvider(f.ceo).publicIdentity() } }
}

test('worker rejection of a forged result preserves the unacknowledged input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-worker-result-rejected-'))
  try {
    const f = await fixture(directory)
    const worker = await f.AgentHarnessWorker.open(f.options)
    await worker.start()
    const original = worker.specialist.handle.bind(worker.specialist)
    worker.specialist.handle = async (input) => {
      const result = await original(input)
      result.envelope.payload.content.summary = 'Tampered result'
      return result
    }
    const result = await worker.handle(workerInput(f))
    assert.equal(result.status, 'rejected')
    assert.equal(f.mailbox.pending('ace').length, 1)
    assert.deepEqual(f.mailbox.pending('ceo'), [])
    assert.equal(f.mailbox.list({ agentId: 'ace' })[0].status, 'failed')
    const reopened = await DurableAgentMailbox.open({ filePath: join(directory, 'mailbox.jsonl'), audit: f.options.audit, now: () => clock })
    assert.equal(reopened.pending('ace').length, 1)
  } finally { await removeTree(directory) }
})

test('worker disk failure during result delivery never acknowledges input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-worker-result-disk-failure-'))
  try {
    const f = await fixture(directory)
    const journalPath = join(directory, 'mailbox.jsonl')
    f.options.executeModel = async () => {
      await rename(journalPath, `${journalPath}.saved`)
      await mkdir(journalPath)
      return { summary: 'External execution finished.' }
    }
    const worker = await f.AgentHarnessWorker.open(f.options)
    await worker.start()
    await assert.rejects(worker.handle(workerInput(f)))
    assert.equal(f.mailbox.pending('ace').length, 1)
    assert.deepEqual(f.mailbox.pending('ceo'), [])
    await rm(journalPath, { recursive: true })
    await rename(`${journalPath}.saved`, journalPath)
    const reopened = await DurableAgentMailbox.open({ filePath: journalPath, audit: f.options.audit, now: () => clock })
    assert.equal(reopened.pending('ace').length, 1)
    assert.equal(reopened.list({ agentId: 'ace' })[0].status, 'interrupted')
  } finally { await removeTree(directory) }
})

test('dispatcher can process one verified stored claim without redelivery or duplicate execution', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-worker-claimed-input-'))
  try {
    const f = await fixture(directory)
    const worker = await f.AgentHarnessWorker.open(f.options)
    await worker.start()
    const input = workerInput(f)
    await f.mailbox.deliver({ envelope: input.envelope, senderGrant: f.ceoGrant, recipientGrant: f.workerGrant,
      recipient: { agentId: 'ace', publicIdentity: createEd25519SigningProvider(f.ace).publicIdentity() }, humanKeys: f.humanKeys })
    const claim = await f.mailbox.claim({ agentId: 'ace', messageId: input.envelope.payload.messageId, ownerId: 'dispatcher-1', leaseMs: 60_000 })
    const outcomes = await Promise.allSettled([
      worker.processClaim({ ...input, claimToken: claim.claimToken }),
      worker.processClaim({ ...input, claimToken: claim.claimToken }),
    ])
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled' && outcome.value.status === 'completed').length, 1)
    assert.equal(f.modelRuns(), 1)
    const events = (await readFile(join(directory, 'mailbox.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
    assert.deepEqual(events.map((event) => event.kind), ['delivered', 'claimed', 'completed'])
  } finally { await removeTree(directory) }
})

test('processClaim rejects a changed envelope or sender identity before model execution', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-worker-claim-mismatch-'))
  try {
    const f = await fixture(directory)
    const worker = await f.AgentHarnessWorker.open(f.options)
    await worker.start()
    const input = workerInput(f)
    await f.mailbox.deliver({ envelope: input.envelope, senderGrant: f.ceoGrant, recipientGrant: f.workerGrant,
      recipient: { agentId: 'ace', publicIdentity: createEd25519SigningProvider(f.ace).publicIdentity() }, humanKeys: f.humanKeys })
    const claim = await f.mailbox.claim({ agentId: 'ace', messageId: input.envelope.payload.messageId, ownerId: 'dispatcher-1', leaseMs: 60_000 })
    const changed = structuredClone(input.envelope)
    changed.payload.content.objective = 'Changed objective'
    await assert.rejects(worker.processClaim({ ...input, envelope: changed, claimToken: claim.claimToken }), { code: 'AGENT_MAILBOX_ENVELOPE_MISMATCH' })
    assert.equal((await worker.processClaim({ ...input, sender: { ...input.sender, agentId: 'imposter' }, claimToken: claim.claimToken })).status, 'rejected')
    assert.equal(f.modelRuns(), 0)
    assert.equal(f.mailbox.pending('ace').length, 1)
  } finally { await removeTree(directory) }
})
