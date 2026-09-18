import assert from 'node:assert/strict'
import { chmod, lstat, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoryAuditLog } from '../src/audit-log.mjs'
import { DurableTaskAccessLeases } from '../src/projects/task-access-lease.mjs'

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

test('RJ can issue only a short task lease inside Rods agent ceiling and project host allowlist', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chimera-task-lease-'))
  let clock = Date.parse('2026-08-31T22:00:00.000Z')
  try {
    const audit = new MemoryAuditLog()
    const filePath = join(root, 'leases.json')
    let leases = await DurableTaskAccessLeases.open({ filePath, audit, now: () => clock })
    const lease = await leases.issue({
      taskId: 'task-ade-1',
      agentId: 'ace',
      ceilingProfileId: 'connected',
      requestedProfileId: 'connected',
      approvedHosts: ['docs.github.com', 'github.com'],
      requestedHosts: ['GitHub.com'],
      ttlSeconds: 900,
      issuedBy: 'rj',
    })
    assert.equal(lease.profileId, 'connected')
    assert.deepEqual(lease.networkHosts, ['github.com'])
    assert.equal(lease.status, 'active')
    assert.equal(leases.activeFor('ace', 'task-ade-1').leaseId, lease.leaseId)
    assert.equal(audit.entries().some((entry) => entry.fact.kind === 'project.access-lease.issued'), true)

    await assert.rejects(leases.issue({
      taskId: 'task-ade-2', agentId: 'ace', ceilingProfileId: 'connected', requestedProfileId: 'live',
      approvedHosts: ['github.com'], requestedHosts: ['github.com'], ttlSeconds: 900, issuedBy: 'rj',
    }), { code: 'PROJECT_ACCESS_LEASE_EXCEEDS_CEILING' })
    await assert.rejects(leases.issue({
      taskId: 'task-ade-2', agentId: 'ace', ceilingProfileId: 'connected', requestedProfileId: 'connected',
      approvedHosts: ['github.com'], requestedHosts: ['evil.example'], ttlSeconds: 900, issuedBy: 'rj',
    }), { code: 'PROJECT_ACCESS_HOST_NOT_APPROVED' })

    await leases.close()
    leases = await DurableTaskAccessLeases.open({ filePath, audit, now: () => clock })
    assert.equal(leases.activeFor('ace', 'task-ade-1').profileId, 'connected')
    const revoked = await leases.revokeTask('task-ade-1', { reason: 'task-completed', revokedBy: 'chimera' })
    assert.equal(revoked[0].status, 'revoked')
    assert.equal(leases.activeFor('ace', 'task-ade-1'), null)
    await leases.close()
  } finally {
    await removeTree(root)
  }
})

test('expired task authority fails closed after time advances', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chimera-task-lease-expiry-'))
  let clock = Date.parse('2026-08-31T22:00:00.000Z')
  try {
    const leases = await DurableTaskAccessLeases.open({ filePath: join(root, 'leases.json'), audit: new MemoryAuditLog(), now: () => clock })
    await leases.issue({
      taskId: 'task-expiry', agentId: 'ace', ceilingProfileId: 'live', requestedProfileId: 'connected',
      approvedHosts: ['example.com'], requestedHosts: ['example.com'], ttlSeconds: 300, issuedBy: 'rj',
    })
    clock += 301_000
    assert.equal(leases.activeFor('ace', 'task-expiry'), null)
    const expired = await leases.reapExpired()
    assert.equal(expired[0].status, 'expired')
    await leases.close()
  } finally {
    await removeTree(root)
  }
})
