import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoryAuditLog } from '../src/audit-log.mjs'
import { DurableWorkerSessionLedger } from '../src/agents/worker-session-ledger.mjs'
import { WorkerArtifactStore } from '../src/agents/worker-artifact-store.mjs'
import { WorkerRuntimeManager } from '../src/agents/worker-runtime-manager.mjs'

async function fixture({ now = () => Date.parse('2026-08-30T12:00:00Z') } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-worker-manager-'))
  const audit = new MemoryAuditLog()
  const calls = []
  const provider = {
    async start(input) { calls.push(['start', input]); return { providerSessionId: `p-${input.kind}-${input.agentId}`, providerResourceId: input.kind === 'computer' ? 'aws.browser.v1' : 'aws.codeinterpreter.v1' } },
    async stop(record) { calls.push(['stop', record.providerSessionId]) },
    async status(record) { calls.push(['status', record.providerSessionId]); return { status: 'READY' } },
    async liveView(record, input) { calls.push(['live', record.providerSessionId, input]); return 'https://signed.example/view?secret=1' },
    async setAutomation(record, enabled) { calls.push(['automation', record.providerSessionId, enabled]) },
    async action(record, input) {
      calls.push(['action', record.providerSessionId, input])
      if (input.operation === 'screenshot') return Buffer.from('png')
      if (input.operation === 'read-files') return 'exported contents'
      return { ok: true }
    },
  }
  const ledger = await DurableWorkerSessionLedger.open({ filePath: join(directory, 'sessions.json'), audit, now })
  const artifacts = await WorkerArtifactStore.open({ rootDir: join(directory, 'artifacts'), audit, now })
  const profiles = new Map([['ace', 'sandbox'], ['researcher', 'connected']])
  const manager = new WorkerRuntimeManager({
    ledger, artifacts, provider, audit, now,
    agentExists: (agentId) => ['ace', 'researcher'].includes(agentId),
    accessProfileFor: (agentId) => profiles.get(agentId),
  })
  return { directory, audit, calls, manager, profiles, provider, ledger }
}

test('worker manager enforces access and projects sessions without provider credentials', async () => {
  const f = await fixture()
  try {
    await assert.rejects(f.manager.start({ agentId: 'ace', kind: 'computer', ttlSeconds: 900 }), /WORKER_COMPUTER_ACCESS_REQUIRED/)
    const session = await f.manager.start({ agentId: 'ace', kind: 'code', ttlSeconds: 900 })
    assert.equal(session.agentId, 'ace')
    assert.equal(session.providerSessionId, undefined)
    assert.equal(JSON.stringify(f.manager.state()).includes('p-code-ace'), false)
    await assert.rejects(f.manager.action(session.workerSessionId, { operation: 'execute-code', code: '1' }, { agentId: 'researcher' }), /WORKER_SESSION_OWNER_MISMATCH/)
    assert.equal((await f.manager.action(session.workerSessionId, { operation: 'execute-code', code: '1' }, { agentId: 'ace' })).ok, true)
  } finally {
    await rm(f.directory, { recursive: true, force: true })
  }
})

test('worker manager enforces task-scoped AgentCore host policy and fails closed for project code egress', async () => {
  const f = await fixture()
  try {
    const computer = await f.manager.start({
      agentId: 'researcher',
      kind: 'computer',
      ttlSeconds: 900,
      accessProfileId: 'connected',
      networkHosts: ['docs.example.com'],
      taskScoped: true,
    })
    assert.deepEqual(f.calls.find(([name]) => name === 'start')[1].networkHosts, ['docs.example.com'])
    assert.deepEqual(f.manager.state().sessions.find((entry) => entry.workerSessionId === computer.workerSessionId).networkHosts, ['docs.example.com'])
    await assert.rejects(
      f.manager.action(computer.workerSessionId, { operation: 'navigate', url: 'https://docs.example.com/guide' }, { agentId: 'researcher' }),
      /WORKER_TASK_ACCESS_EXCEEDS_CEILING/,
    )
    await f.manager.action(computer.workerSessionId, { operation: 'navigate', url: 'https://docs.example.com/guide' }, {
      agentId: 'researcher', accessProfileId: 'connected', networkHosts: ['docs.example.com'], taskScoped: true,
    })
    await assert.rejects(
      f.manager.action(computer.workerSessionId, { operation: 'navigate', url: 'https://example.com' }, {
        agentId: 'researcher', accessProfileId: 'connected', networkHosts: ['docs.example.com'], taskScoped: true,
      }),
      /WORKER_NETWORK_HOST_NOT_LEASED/,
    )
    await assert.rejects(
      f.manager.start({ agentId: 'researcher', kind: 'code', ttlSeconds: 900, accessProfileId: 'connected', networkHosts: ['docs.example.com'], taskScoped: true }),
      /WORKER_PROJECT_CODE_EXECUTOR_UNAVAILABLE/,
    )
  } finally {
    await rm(f.directory, { recursive: true, force: true })
  }
})

test('human takeover disables agent automation and returns control explicitly', async () => {
  const f = await fixture()
  try {
    const session = await f.manager.start({ agentId: 'researcher', kind: 'computer', ttlSeconds: 900 })
    const taken = await f.manager.takeControl(session.workerSessionId, { humanId: 'rod' })
    assert.equal(taken.controller.type, 'human')
    assert.equal(await f.manager.liveView(session.workerSessionId, { humanId: 'rod' }), 'https://signed.example/view?secret=1')
    await assert.rejects(f.manager.action(session.workerSessionId, { operation: 'navigate', url: 'https://example.com' }, { agentId: 'researcher' }), /WORKER_CONTROLLED_BY_HUMAN/)
    const returned = await f.manager.returnControl(session.workerSessionId, { humanId: 'rod' })
    assert.equal(returned.controller.type, 'agent')
    assert.deepEqual(f.calls.filter(([name]) => name === 'automation').map((call) => call.slice(1)), [
      ['p-computer-researcher', false], ['p-computer-researcher', true],
    ])
  } finally {
    await rm(f.directory, { recursive: true, force: true })
  }
})

test('screenshots and explicit code exports are retained as safe artifact metadata', async () => {
  const f = await fixture()
  try {
    const computer = await f.manager.start({ agentId: 'researcher', kind: 'computer', ttlSeconds: 900 })
    const captured = await f.manager.action(computer.workerSessionId, { operation: 'screenshot', name: 'proof.png' }, { agentId: 'researcher' })
    assert.equal(captured.artifact.name, 'proof.png')
    assert.equal(captured.artifact.path, undefined)
    const code = await f.manager.start({ agentId: 'researcher', kind: 'code', ttlSeconds: 900 })
    const exported = await f.manager.action(code.workerSessionId, { operation: 'export-files', paths: ['result.txt'], name: 'results.json' }, { agentId: 'researcher' })
    assert.equal(exported.artifact.name, 'results.json')
    assert.equal(f.manager.state().artifacts.length, 2)
  } finally {
    await rm(f.directory, { recursive: true, force: true })
  }
})

test('expiry reaper stops provider sessions and marks them expired', async () => {
  let clock = Date.parse('2026-08-30T12:00:00Z')
  const f = await fixture({ now: () => clock })
  try {
    const session = await f.manager.start({ agentId: 'ace', kind: 'code', ttlSeconds: 300 })
    clock += 301_000
    assert.deepEqual(await f.manager.reapExpired(), [session.workerSessionId])
    assert.equal(f.manager.state().sessions[0].status, 'expired')
    assert.equal(f.calls.some(([name]) => name === 'stop'), true)
  } finally {
    await rm(f.directory, { recursive: true, force: true })
  }
})

test('human takeover serializes against agent actions', async () => {
  const f = await fixture()
  try {
    const session = await f.manager.start({ agentId: 'researcher', kind: 'computer', ttlSeconds: 900 })
    let releaseAutomation
    let automationEntered
    const entered = new Promise((resolve) => { automationEntered = resolve })
    const release = new Promise((resolve) => { releaseAutomation = resolve })
    f.provider.setAutomation = async () => {
      automationEntered()
      await release
    }

    const takeover = f.manager.takeControl(session.workerSessionId, { humanId: 'rod' })
    await entered
    const action = f.manager.action(session.workerSessionId, { operation: 'navigate', url: 'https://example.com' }, { agentId: 'researcher' })
    releaseAutomation()
    await takeover
    await assert.rejects(action, /WORKER_CONTROLLED_BY_HUMAN/)
    assert.equal(f.calls.some(([name]) => name === 'action'), false)
  } finally {
    await rm(f.directory, { recursive: true, force: true })
  }
})

test('provider diagnostics are normalized at the manager boundary', async () => {
  const f = await fixture()
  try {
    f.provider.start = async () => { throw new Error('request-id secret-internal-detail') }
    await assert.rejects(
      f.manager.start({ agentId: 'ace', kind: 'code', ttlSeconds: 900 }),
      (error) => error.code === 'WORKER_PROVIDER_START_FAILED' && !error.message.includes('secret-internal-detail'),
    )
  } finally {
    await rm(f.directory, { recursive: true, force: true })
  }
})

test('startup reconciliation stops durable sessions left by an earlier process', async () => {
  const f = await fixture()
  try {
    const session = await f.manager.start({ agentId: 'ace', kind: 'code', ttlSeconds: 900 })
    assert.deepEqual(await f.manager.reconcile(), [session.workerSessionId])
    assert.equal(f.manager.state().sessions[0].status, 'stopped')
    assert.equal(f.manager.state().sessions[0].failureCode, 'PROCESS_RESTARTED')
  } finally {
    await rm(f.directory, { recursive: true, force: true })
  }
})
