import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoryAuditLog } from '../src/audit-log.mjs'
import { DurableWorkerSessionLedger } from '../src/agents/worker-session-ledger.mjs'

const NOW = Date.parse('2026-08-30T12:00:00.000Z')

test('worker sessions persist ownership and permit only one active session per agent and kind', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-worker-ledger-'))
  const filePath = join(directory, 'sessions.json')
  try {
    const ledger = await DurableWorkerSessionLedger.open({ filePath, audit: new MemoryAuditLog(), now: () => NOW })
    const created = await ledger.create({
      agentId: 'ace', kind: 'computer', providerSessionId: 'provider-1', ttlSeconds: 900,
      viewport: { width: 1280, height: 800 },
    })
    assert.equal(created.agentId, 'ace')
    assert.equal(created.status, 'ready')
    assert.equal(created.controller.type, 'agent')
    assert.equal(created.expiresAt, '2026-08-30T12:15:00.000Z')
    await assert.rejects(ledger.create({
      agentId: 'ace', kind: 'computer', providerSessionId: 'provider-2', ttlSeconds: 900,
    }), /WORKER_SESSION_ALREADY_ACTIVE/)

    await ledger.update(created.workerSessionId, { status: 'stopped' })
    const reopened = await DurableWorkerSessionLedger.open({ filePath, audit: new MemoryAuditLog(), now: () => NOW })
    assert.equal(reopened.get(created.workerSessionId).status, 'stopped')
    assert.equal((await stat(filePath)).mode & 0o777, 0o600)
    assert.equal(JSON.parse(await readFile(filePath, 'utf8')).schema, 'chimera.worker-sessions.v1')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
test('worker ledger validates records and enforces the global active limit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-worker-limit-'))
  try {
    const ledger = await DurableWorkerSessionLedger.open({ filePath: join(directory, 'sessions.json'), audit: new MemoryAuditLog(), now: () => NOW, activeLimit: 2 })
    await ledger.create({ agentId: 'ace', kind: 'code', providerSessionId: 'p-1', ttlSeconds: 300 })
    await ledger.create({ agentId: 'researcher', kind: 'code', providerSessionId: 'p-2', ttlSeconds: 300 })
    await assert.rejects(ledger.create({ agentId: 'analyst', kind: 'code', providerSessionId: 'p-3', ttlSeconds: 300 }), /WORKER_SESSION_LIMIT_REACHED/)
    await assert.rejects(ledger.create({ agentId: '../ace', kind: 'code', providerSessionId: 'p-4', ttlSeconds: 300 }), /WORKER_AGENT_ID_INVALID/)
    await assert.rejects(ledger.create({ agentId: 'ace', kind: 'desktop', providerSessionId: 'p-5', ttlSeconds: 300 }), /WORKER_KIND_INVALID/)
    await assert.rejects(ledger.create({ agentId: 'ace', kind: 'computer', providerSessionId: 'p-6', ttlSeconds: 3 }), /WORKER_TTL_INVALID/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
