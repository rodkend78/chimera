import assert from 'node:assert/strict'
import { chmod, lstat, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoryAuditLog } from '../src/audit-log.mjs'
import { agentManifestFromHermesCandidate } from '../src/agents/registry.mjs'

function manifest() {
  return agentManifestFromHermesCandidate({
    schema: 'chimera.hermes-agent-candidate.v1',
    candidateId: 'hermes-aws:ace',
    profileId: 'ace',
    displayName: 'Ace',
    sourceRef: 'hermes://configured-hermes/profiles/ace',
  })
}

async function removeReadonlyTree(path) {
  try {
    const info = await lstat(path)
    if (info.isDirectory()) {
      await chmod(path, 0o700)
      for (const entry of await readdir(path)) await removeReadonlyTree(join(path, entry))
    } else {
      await chmod(path, 0o600)
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  await rm(path, { recursive: true, force: true })
}

test('a worker gets a read-only continuity capsule with persona, memory, skills, and a stable digest', async () => {
  const { AgentWorkerWorkspace } = await import('../src/agents/worker-workspace.mjs')
  const directory = await mkdtemp(join(tmpdir(), 'chimera-worker-workspace-'))
  try {
    const workspace = await AgentWorkerWorkspace.open({
      rootDir: directory,
      manifest: manifest(),
      audit: new MemoryAuditLog(),
      referenceProvider: {
        async materialize(ref) {
          if (ref.endsWith('/persona')) return [
            { path: 'SOUL.md', content: 'Be direct, evidence-led, and loyal to the operator.' },
            { path: 'IDENTITY.md', content: 'Ace is an engineering specialist.' },
          ]
          if (ref.endsWith('/memory')) return [{ path: 'MEMORY.md', content: 'Remember the customer boundary.' }]
          return [{ path: 'research/SKILL.md', content: '# Research\nUse primary sources.' }]
        },
      },
    })

    assert.equal(await readFile(join(workspace.path, 'mounts/persona/SOUL.md'), 'utf8'), 'Be direct, evidence-led, and loyal to the operator.')
    assert.equal(await readFile(join(workspace.path, 'mounts/memory/MEMORY.md'), 'utf8'), 'Remember the customer boundary.')
    assert.equal(await readFile(join(workspace.path, 'mounts/skills/research/SKILL.md'), 'utf8'), '# Research\nUse primary sources.')
    assert.equal((await stat(join(workspace.path, 'mounts/memory/MEMORY.md'))).mode & 0o777, 0o400)
    assert.equal((await stat(join(workspace.path, 'mounts/skills/research/SKILL.md'))).mode & 0o777, 0o400)
    assert.equal((await stat(join(workspace.path, 'scratch'))).mode & 0o777, 0o700)
    await assert.rejects(writeFile(join(workspace.path, 'mounts/memory/MEMORY.md'), 'tampered'), /EACCES|EPERM/)
    assert.equal(workspace.state().isolation, 'per-agent-workspace')
    assert.equal(workspace.state().mounts.every((mount) => mount.mode === 'read-only'), true)
    const context = workspace.context()
    assert.equal(context.schema, 'chimera.agent-continuity-context.v1')
    assert.match(context.digest, /^[a-f0-9]{64}$/)
    assert.deepEqual(context.persona.map((entry) => entry.path), ['IDENTITY.md', 'SOUL.md'])
    assert.equal(context.persona.find((entry) => entry.path === 'SOUL.md').content, 'Be direct, evidence-led, and loyal to the operator.')
    assert.deepEqual(context.memory, [{ path: 'MEMORY.md', content: 'Remember the customer boundary.' }])
    assert.deepEqual(context.skills, [{ path: 'research/SKILL.md' }])
    assert.deepEqual(context.report, {
      persona: { files: 2, bytes: 84 },
      memory: { files: 1, bytes: 31 },
      skills: { files: 1, bytes: 31 },
      excluded: ['credentials', 'provider-sessions', 'private-keys', 'authority-grants', 'transient-runtime-state', 'skill-assets'],
    })
  } finally {
    await removeReadonlyTree(directory)
  }
})

test('workspace materialization rejects traversal before creating a usable worker', async () => {
  const { AgentWorkerWorkspace } = await import('../src/agents/worker-workspace.mjs')
  const directory = await mkdtemp(join(tmpdir(), 'chimera-worker-traversal-'))
  try {
    await assert.rejects(AgentWorkerWorkspace.open({
      rootDir: directory,
      manifest: manifest(),
      audit: new MemoryAuditLog(),
      referenceProvider: { async materialize() { return [{ path: '../credential.txt', content: 'nope' }] } },
    }), /WORKER_REFERENCE_PATH_INVALID/)
    await assert.rejects(stat(join(directory, 'ace')), /ENOENT/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('workspace can be safely rematerialized after a runtime restart', async () => {
  const { AgentWorkerWorkspace } = await import('../src/agents/worker-workspace.mjs')
  const directory = await mkdtemp(join(tmpdir(), 'chimera-worker-rematerialize-'))
  try {
    const workerManifest = manifest()
    const options = {
      rootDir: directory,
      manifest: workerManifest,
      audit: new MemoryAuditLog(),
      referenceProvider: { async materialize() { return [{ path: 'CURRENT.md', content: 'current' }] } },
    }
    await AgentWorkerWorkspace.open(options)
    const reopened = await AgentWorkerWorkspace.open(options)
    assert.equal((await readFile(join(reopened.path, 'mounts/memory/CURRENT.md'), 'utf8')), 'current')
  } finally {
    await removeReadonlyTree(directory)
  }
})
