import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoryAuditLog } from '../src/audit-log.mjs'
import {
  AGENT_ACCESS_PROFILES,
  DurableAgentAccessPolicy,
  toolsForAccessProfile,
} from '../src/agents/access-policy.mjs'

test('agent access defaults to Sandbox and persists an operator-selected profile', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-agent-access-'))
  const filePath = join(directory, 'access.json')
  const audit = new MemoryAuditLog()
  try {
    const access = await DurableAgentAccessPolicy.open({ filePath, audit, now: () => Date.parse('2026-08-30T03:00:00.000Z') })
    assert.equal(access.get('ace').profileId, 'sandbox')
    assert.equal(access.get('ace').network, 'none')

    const selected = await access.set('ace', 'connected', { changedBy: 'rod' })
    assert.equal(selected.profileId, 'connected')
    assert.equal(selected.network, 'guarded-public-web')

    const reopened = await DurableAgentAccessPolicy.open({ filePath, audit })
    assert.equal(reopened.get('ace').profileId, 'connected')
    assert.equal(JSON.parse(await readFile(filePath, 'utf8')).assignments.ace.profileId, 'connected')
    assert.equal(audit.entries().some((entry) => entry.fact.kind === 'agent.access.changed'), true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('profiles expose bounded tools and reject unknown access levels', async () => {
  assert.deepEqual(Object.keys(AGENT_ACCESS_PROFILES), ['sandbox', 'connected', 'live'])
  assert.equal(toolsForAccessProfile('sandbox').includes('web_fetch'), false)
  assert.equal(toolsForAccessProfile('sandbox').includes('mcp__chimera_worker__code'), true)
  assert.equal(toolsForAccessProfile('sandbox').includes('mcp__chimera_worker__computer'), false)
  assert.equal(toolsForAccessProfile('connected').includes('web_fetch'), true)
  assert.equal(toolsForAccessProfile('connected').includes('mcp__chimera_worker__computer'), true)
  assert.equal(toolsForAccessProfile('connected').includes('mcp__chimera_github__pr_checks'), true)
  assert.equal(toolsForAccessProfile('connected').includes('mcp__chimera_github__pr_create'), false)
  assert.equal(toolsForAccessProfile('connected').includes('mcp__chimera_github__pr_merge'), false)
  assert.equal(toolsForAccessProfile('sandbox').includes('mcp__chimera_github__pr_merge'), false)
  assert.equal(toolsForAccessProfile('live').includes('mcp__chimera_github__pr_merge'), true)
  assert.equal(toolsForAccessProfile('live').includes('bash'), true)

  const directory = await mkdtemp(join(tmpdir(), 'chimera-agent-access-invalid-'))
  try {
    const access = await DurableAgentAccessPolicy.open({ filePath: join(directory, 'access.json'), audit: new MemoryAuditLog() })
    await assert.rejects(access.set('ace', 'unrestricted', { changedBy: 'rod' }), /AGENT_ACCESS_PROFILE_INVALID/)
    await assert.rejects(access.set('../ace', 'sandbox', { changedBy: 'rod' }), /AGENT_ID_INVALID/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a failed durable write cannot leave a more privileged profile active in memory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-agent-access-failure-'))
  const filePath = join(directory, 'access.json')
  const access = await DurableAgentAccessPolicy.open({ filePath, audit: new MemoryAuditLog() })
  await rm(directory, { recursive: true, force: true })
  await writeFile(directory, 'blocks the policy directory')
  try {
    await assert.rejects(access.set('ace', 'live', { changedBy: 'rod' }))
    assert.equal(access.get('ace').profileId, 'sandbox')
  } finally {
    await rm(directory, { force: true })
  }
})
