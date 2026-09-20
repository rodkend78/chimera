import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoryAuditLog } from '../src/audit-log.mjs'
import { WorkerArtifactStore } from '../src/agents/worker-artifact-store.mjs'
import { wrapTaskArtifactExecutors } from '../src/browser/task-artifact-evidence.mjs'

async function fixture({ executor, recordEvidence = async () => {} } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-task-artifact-evidence-'))
  const artifactStore = await WorkerArtifactStore.open({ rootDir: join(directory, 'artifacts'), audit: new MemoryAuditLog() })
  const calls = []
  const executors = {
    mcp__chimera_worker__code: executor ?? (async (args, context) => {
      calls.push({ args, context })
      const artifact = await artifactStore.save({
        workerSessionId: 'worker-artifact-session',
        agentId: context.agentId,
        name: 'result.txt',
        mimeType: 'text/plain',
        content: 'fixture result',
      })
      return { status: 'provider-claimed', source: 'untrusted-result-marker', artifact }
    }),
    mcp__chimera_worker__computer: async (args, context) => {
      calls.push({ args, context })
      return { status: 'completed', artifact: { artifactId: 'artifact-computer-forged' } }
    },
    passthrough: async () => ({ status: 'completed', value: 'unchanged' }),
  }
  const evidence = []
  const wrapped = wrapTaskArtifactExecutors({
    executors,
    artifactStore,
    recordEvidence: async (...input) => {
      evidence.push(input)
      return recordEvidence(...input)
    },
  })
  return { directory, artifactStore, calls, executors, wrapped, evidence }
}

const taskContext = Object.freeze({
  taskId: 'task-artifact-positive',
  agentId: 'ace',
  taskScoped: true,
})

test('records evidence only for a newly materialized context-owned artifact', async () => {
  const f = await fixture()
  try {
    const result = await f.wrapped.mcp__chimera_worker__code({ taskId: 'forged-argument-task', workerSessionId: 'worker-artifact-session' }, taskContext)
    assert.equal(result.status, 'provider-claimed')
    assert.equal(f.calls.length, 1)
    assert.equal(f.evidence.length, 1)
    const [taskId, receipt] = f.evidence[0]
    const stored = f.artifactStore.list({ agentId: taskContext.agentId })[0]
    assert.equal(taskId, taskContext.taskId)
    assert.deepEqual(receipt, {
      kind: 'artifact',
      source: 'worker-artifact-store',
      operationId: `artifact:${stored.artifactId}`,
      revision: { artifactId: stored.artifactId, hash: stored.sha256 },
      outcome: {
        status: 'materialized',
        artifactId: stored.artifactId,
        sessionId: stored.workerSessionId,
        agentId: taskContext.agentId,
        hash: stored.sha256,
        size: stored.bytes,
        scope: `task:${taskContext.taskId}/worker:${stored.workerSessionId}`,
      },
      evidenceRef: `artifact:${stored.artifactId}`,
    })
  } finally {
    await rm(f.directory, { recursive: true, force: true })
  }
})

test('does not record an old, forged, or foreign artifact result', async (t) => {
  await t.test('old artifact', async () => {
    let artifactStore
    const f = await fixture({ executor: async () => ({ status: 'materialized', source: 'worker-artifact-store', artifact: artifactStore.list()[0] }) })
    try {
      artifactStore = f.artifactStore
      const old = await artifactStore.save({ workerSessionId: 'worker-old', agentId: 'ace', name: 'old.txt', mimeType: 'text/plain', content: 'old' })
      const result = await f.wrapped.mcp__chimera_worker__code({ operation: 'export-files' }, taskContext)
      assert.equal(result.artifact.artifactId, old.artifactId)
      assert.equal(f.evidence.length, 0)
    } finally {
      await rm(f.directory, { recursive: true, force: true })
    }
  })

  await t.test('forged artifact', async () => {
    const f = await fixture({ executor: async () => ({ status: 'materialized', source: 'worker-artifact-store', artifact: {
      artifactId: 'artifact-forged', workerSessionId: 'worker-ace', agentId: 'ace', sha256: 'a'.repeat(64), bytes: 14,
    } }) })
    try {
      await f.wrapped.mcp__chimera_worker__code({ operation: 'export-files' }, taskContext)
      assert.equal(f.evidence.length, 0)
      assert.equal(f.artifactStore.list().length, 0)
    } finally {
      await rm(f.directory, { recursive: true, force: true })
    }
  })

  await t.test('foreign artifact', async () => {
    const f = await fixture({ executor: async () => {
      const artifact = await f.artifactStore.save({ workerSessionId: 'worker-foreign', agentId: 'rj', name: 'foreign.txt', mimeType: 'text/plain', content: 'foreign' })
      return { status: 'materialized', source: 'worker-artifact-store', artifact }
    } })
    try {
      await f.wrapped.mcp__chimera_worker__code({ operation: 'export-files' }, taskContext)
      assert.equal(f.evidence.length, 0)
      assert.equal(f.artifactStore.list({ agentId: 'rj' }).length, 1)
    } finally {
      await rm(f.directory, { recursive: true, force: true })
    }
  })

  await t.test('foreign worker session', async () => {
    const f = await fixture({ executor: async () => {
      const artifact = await f.artifactStore.save({ workerSessionId: 'worker-foreign', agentId: 'ace', name: 'foreign-session.txt', mimeType: 'text/plain', content: 'foreign session' })
      return { status: 'materialized', artifact }
    } })
    try {
      await f.wrapped.mcp__chimera_worker__code({ operation: 'export-files', workerSessionId: 'worker-expected' }, taskContext)
      assert.equal(f.evidence.length, 0)
      assert.equal(f.artifactStore.list({ agentId: 'ace' }).length, 1)
    } finally {
      await rm(f.directory, { recursive: true, force: true })
    }
  })
})

test('untasked calls stay unchanged and unattributed', async () => {
  const f = await fixture()
  try {
    const result = await f.wrapped.mcp__chimera_worker__code({ taskId: 'argument-only-task' }, {
      agentId: 'ace', taskScoped: false,
    })
    assert.equal(result.status, 'provider-claimed')
    assert.equal(f.calls.length, 1)
    assert.equal(f.evidence.length, 0)
    assert.equal(f.artifactStore.list().length, 1)
    assert.notEqual(f.wrapped.mcp__chimera_worker__computer, f.executors.mcp__chimera_worker__computer)
    assert.equal(f.wrapped.passthrough, f.executors.passthrough)
  } finally {
    await rm(f.directory, { recursive: true, force: true })
  }
})

test('a recording failure preserves the result and never re-executes the effect', async () => {
  let effects = 0
  let originalResult
  const f = await fixture({
    executor: async (args, context) => {
      effects += 1
      const artifact = await f.artifactStore.save({ workerSessionId: 'worker-artifact-session', agentId: context.agentId, name: 'once.txt', mimeType: 'text/plain', content: 'once' })
      originalResult = { status: 'completed', artifact, args }
      return originalResult
    },
    recordEvidence: async () => { throw new Error('recording unavailable') },
  })
  try {
    const result = await f.wrapped.mcp__chimera_worker__code({ operation: 'export-files' }, taskContext)
    assert.equal(effects, 1)
    assert.equal(f.evidence.length, 1)
    assert.equal(result, originalResult)
    assert.equal(result.status, 'completed')
    assert.equal(result.artifact.name, 'once.txt')
  } finally {
    await rm(f.directory, { recursive: true, force: true })
  }
})
