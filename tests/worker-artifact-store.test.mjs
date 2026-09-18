import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoryAuditLog } from '../src/audit-log.mjs'
import { WorkerArtifactStore } from '../src/agents/worker-artifact-store.mjs'

test('worker artifacts are immutable, hashed, private, and bound to their owner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-worker-artifacts-'))
  try {
    const store = await WorkerArtifactStore.open({ rootDir: directory, audit: new MemoryAuditLog(), now: () => Date.parse('2026-08-30T12:00:00Z') })
    const saved = await store.save({
      workerSessionId: 'worker-12345678', agentId: 'ace', name: 'screen.png', mimeType: 'image/png', content: Buffer.from('image bytes'),
    })
    assert.equal(saved.name, 'screen.png')
    assert.equal(saved.agentId, 'ace')
    assert.match(saved.sha256, /^[a-f0-9]{64}$/)
    assert.equal((await stat(saved.path)).mode & 0o777, 0o600)
    assert.deepEqual(store.list({ agentId: 'ace' }).map(({ path: _path, ...item }) => item), [{
      artifactId: saved.artifactId,
      workerSessionId: 'worker-12345678',
      agentId: 'ace',
      name: 'screen.png',
      mimeType: 'image/png',
      bytes: 11,
      sha256: saved.sha256,
      createdAt: '2026-08-30T12:00:00.000Z',
    }])
    assert.equal((await readFile(saved.path)).toString(), 'image bytes')
    await assert.rejects(store.save({ workerSessionId: 'worker-12345678', agentId: 'ace', name: '../secret', mimeType: 'text/plain', content: 'x' }), /WORKER_ARTIFACT_NAME_INVALID/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('worker artifacts enforce per-file and per-session quotas', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-worker-artifact-quota-'))
  try {
    const store = await WorkerArtifactStore.open({ rootDir: directory, audit: new MemoryAuditLog(), maxFileBytes: 4, maxSessionBytes: 6 })
    await store.save({ workerSessionId: 'worker-12345678', agentId: 'ace', name: 'one.txt', mimeType: 'text/plain', content: '1234' })
    await assert.rejects(store.save({ workerSessionId: 'worker-12345678', agentId: 'ace', name: 'large.txt', mimeType: 'text/plain', content: '12345' }), /WORKER_ARTIFACT_TOO_LARGE/)
    await assert.rejects(store.save({ workerSessionId: 'worker-12345678', agentId: 'ace', name: 'two.txt', mimeType: 'text/plain', content: '789' }), /WORKER_ARTIFACT_SESSION_QUOTA/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('worker artifact session quota is atomic across concurrent saves', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-worker-artifact-atomic-'))
  try {
    const store = await WorkerArtifactStore.open({ rootDir: directory, audit: new MemoryAuditLog(), maxFileBytes: 8, maxSessionBytes: 10 })
    const results = await Promise.allSettled([
      store.save({ workerSessionId: 'worker-atomic', agentId: 'ace', name: 'one.txt', mimeType: 'text/plain', content: '123456' }),
      store.save({ workerSessionId: 'worker-atomic', agentId: 'ace', name: 'two.txt', mimeType: 'text/plain', content: '123456' }),
    ])
    assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1)
    const rejected = results.find(({ status }) => status === 'rejected')
    assert.match(rejected.reason.message, /WORKER_ARTIFACT_SESSION_QUOTA/)
    assert.equal(store.list({ workerSessionId: 'worker-atomic' }).length, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
