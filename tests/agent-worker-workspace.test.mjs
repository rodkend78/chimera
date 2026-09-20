import assert from 'node:assert/strict'
import { chmod, lstat, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoryAuditLog } from '../src/audit-log.mjs'
import { agentManifestFromHermesCandidate, agentManifestFromNativeInput } from '../src/agents/registry.mjs'

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
      dependencyStatus: 'unverified',
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

test('native workspace requires persona and retains an empty memory file while allowing optional skills', async () => {
  const { AgentWorkerWorkspace } = await import('../src/agents/worker-workspace.mjs')
  const directory = await mkdtemp(join(tmpdir(), 'chimera-worker-native-persona-'))
  try {
    await assert.rejects(AgentWorkerWorkspace.open({
      rootDir: directory,
      manifest: agentManifestFromNativeInput({
        agentId: 'native-agent', displayName: 'Native', role: 'Testing', capabilities: ['testing'],
      }),
      audit: new MemoryAuditLog(),
      referenceProvider: {
        async materialize(_reference, { kind }) {
          if (kind === 'persona') return []
          if (kind === 'memory') return [{ path: 'MEMORY.md', content: '' }]
          return []
        },
      },
    }), /NATIVE_PERSONA_UNAVAILABLE/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('Hermes workspace rejects a declared zero-file persona or memory layer before publication', async () => {
  const { AgentWorkerWorkspace } = await import('../src/agents/worker-workspace.mjs')
  const directory = await mkdtemp(join(tmpdir(), 'chimera-worker-required-layers-'))
  try {
    for (const missingLayer of ['persona', 'memory']) {
      let calls = 0
      await assert.rejects(AgentWorkerWorkspace.open({
        rootDir: directory,
        manifest: manifest(),
        audit: new MemoryAuditLog(),
        referenceProvider: {
          async materialize(_reference, { kind }) {
            calls += 1
            if (kind === 'persona') return missingLayer === 'persona' ? [] : [{ path: 'SOUL.md', content: 'Required persona.' }]
            if (kind === 'memory') return missingLayer === 'memory' ? [] : [{ path: 'MEMORY.md', content: '' }]
            return []
          },
        },
      }), /WORKER_CONTINUITY_INCOMPLETE/)
      assert.equal(calls, 3)
      await assert.rejects(lstat(join(directory, 'ace')), { code: 'ENOENT' })
    }
  } finally {
    await removeReadonlyTree(directory)
  }
})

test('native workspace keeps a retained empty memory file valid across local reopen', async () => {
  const { AgentWorkerWorkspace } = await import('../src/agents/worker-workspace.mjs')
  const directory = await mkdtemp(join(tmpdir(), 'chimera-worker-empty-memory-'))
  const nativeManifest = agentManifestFromNativeInput({
    agentId: 'native-empty-memory', displayName: 'Native Empty Memory', role: 'Testing', capabilities: ['testing'],
  })
  try {
    const original = await AgentWorkerWorkspace.open({
      rootDir: directory,
      manifest: nativeManifest,
      audit: new MemoryAuditLog(),
      referenceProvider: {
        async materialize(_reference, { kind }) {
          if (kind === 'persona') return [{ path: 'SOUL.md', content: 'Native persona.' }]
          if (kind === 'memory') return [{ path: 'MEMORY.md', content: '' }]
          return []
        },
      },
    })
    assert.deepEqual(original.context().report.memory, { files: 1, bytes: 0 })
    const reopened = await AgentWorkerWorkspace.openLocal({
      workspacePath: original.path,
      manifest: nativeManifest,
      audit: new MemoryAuditLog(),
    })
    assert.deepEqual(reopened.context().report.memory, { files: 1, bytes: 0 })
    assert.deepEqual(reopened.context().skills, [])
  } finally {
    await removeReadonlyTree(directory)
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

test('workspace can reopen the existing local continuity capsule without a reference provider', async () => {
  const { AgentWorkerWorkspace } = await import('../src/agents/worker-workspace.mjs')
  const directory = await mkdtemp(join(tmpdir(), 'chimera-worker-local-reopen-'))
  try {
    const workerManifest = manifest()
    const original = await AgentWorkerWorkspace.open({
      rootDir: directory,
      manifest: workerManifest,
      audit: new MemoryAuditLog(),
      referenceProvider: { async materialize() { return [{ path: 'LOCAL.md', content: 'local-only' }] } },
    })
    const reopened = await AgentWorkerWorkspace.openLocal({
      workspacePath: original.path,
      manifest: workerManifest,
      audit: new MemoryAuditLog(),
    })
    assert.deepEqual(reopened.context(), original.context())
    assert.deepEqual(reopened.state().mounts, original.state().mounts)
    await assert.rejects(AgentWorkerWorkspace.openLocal({
      workspacePath: original.path,
      manifest: { ...workerManifest, source: { ...workerManifest.source, ref: 'chimera://other-agent' } },
      audit: new MemoryAuditLog(),
    }), /WORKER_CONTINUITY_MANIFEST_MISMATCH/)
  } finally {
    await removeReadonlyTree(directory)
  }
})

test('local continuity reopen rejects a manifest-only capsule when declared layers are missing', async () => {
  const { AgentWorkerWorkspace } = await import('../src/agents/worker-workspace.mjs')
  const directory = await mkdtemp(join(tmpdir(), 'chimera-worker-local-missing-layers-'))
  try {
    const workerManifest = manifest()
    const original = await AgentWorkerWorkspace.open({
      rootDir: directory,
      manifest: workerManifest,
      audit: new MemoryAuditLog(),
      referenceProvider: {
        async materialize(_reference, { kind }) {
          if (kind === 'persona') return [{ path: 'SOUL.md', content: 'Required persona.' }]
          if (kind === 'memory') return [{ path: 'MEMORY.md', content: '' }]
          return [{ path: 'SKILL.md', content: 'Optional skill.' }]
        },
      },
    })
    await removeReadonlyTree(join(original.path, 'mounts'))
    await assert.rejects(AgentWorkerWorkspace.openLocal({
      workspacePath: original.path,
      manifest: workerManifest,
      audit: new MemoryAuditLog(),
    }), /WORKER_CONTINUITY_INCOMPLETE/)
  } finally {
    await removeReadonlyTree(directory)
  }
})

test('local continuity reopen preserves the bounded maximum skill catalog without rematerialization', async () => {
  const { AgentWorkerWorkspace } = await import('../src/agents/worker-workspace.mjs')
  const directory = await mkdtemp(join(tmpdir(), 'chimera-worker-local-skills-'))
  try {
    const workerManifest = manifest()
    const original = await AgentWorkerWorkspace.open({
      rootDir: directory,
      manifest: workerManifest,
      audit: new MemoryAuditLog(),
      referenceProvider: {
        async materialize(_reference, { kind }) {
          if (kind === 'persona') return [{ path: 'SOUL.md', content: 'Local persona.' }]
          if (kind === 'memory') return [{ path: 'MEMORY.md', content: 'Local memory.' }]
          return Array.from({ length: 512 }, (_, index) => ({ path: `skill-${String(index).padStart(3, '0')}.md`, content: `Skill ${index}` }))
        },
      },
    })
    const reopened = await AgentWorkerWorkspace.openLocal({
      workspacePath: original.path,
      manifest: workerManifest,
      audit: new MemoryAuditLog(),
    })
    assert.equal(reopened.context().skills.length, 512)
    assert.equal(reopened.context().report.skills.files, 512)
  } finally {
    await removeReadonlyTree(directory)
  }
})

test('workspace continuity refresh preserves scratch and task artifacts and retains old mounts on failure', async () => {
  const { AgentWorkerWorkspace } = await import('../src/agents/worker-workspace.mjs')
  const directory = await mkdtemp(join(tmpdir(), 'chimera-worker-refresh-'))
  const audit = new MemoryAuditLog()
  const workerManifest = manifest()
  try {
    const current = { value: 'current' }
    const options = {
      rootDir: directory,
      manifest: workerManifest,
      audit,
      referenceProvider: { async materialize() { return [{ path: 'CURRENT.md', content: current.value }] } },
    }
    const workspace = await AgentWorkerWorkspace.open(options)
    await writeFile(join(workspace.path, 'scratch/notes.txt'), 'keep me')
    await writeFile(join(workspace.path, 'task-artifact.json'), '{"result":"keep me"}')
    current.value = 'updated'
    const refreshed = await AgentWorkerWorkspace.refresh(options)
    assert.equal(await readFile(join(refreshed.path, 'mounts/persona/CURRENT.md'), 'utf8'), 'updated')
    assert.equal(await readFile(join(refreshed.path, 'scratch/notes.txt'), 'utf8'), 'keep me')
    assert.equal(await readFile(join(refreshed.path, 'task-artifact.json'), 'utf8'), '{"result":"keep me"}')

    await assert.rejects(AgentWorkerWorkspace.refresh({
      ...options,
      referenceProvider: { async materialize() { throw new Error('REFERENCE_UNAVAILABLE') } },
    }), /REFERENCE_UNAVAILABLE/)
    assert.equal(await readFile(join(refreshed.path, 'mounts/persona/CURRENT.md'), 'utf8'), 'updated')
    assert.equal(await readFile(join(refreshed.path, 'scratch/notes.txt'), 'utf8'), 'keep me')
  } finally {
    await removeReadonlyTree(directory)
  }
})

test('workspace refresh restores old mounts when publishing the refresh audit fails', async () => {
  const { AgentWorkerWorkspace } = await import('../src/agents/worker-workspace.mjs')
  const directory = await mkdtemp(join(tmpdir(), 'chimera-worker-refresh-audit-'))
  const audit = {
    append(fact) {
      if (fact.kind === 'worker.workspace.refreshed') throw new Error('AUDIT_UNAVAILABLE')
    },
  }
  const workerManifest = manifest()
  try {
    const options = {
      rootDir: directory,
      manifest: workerManifest,
      audit,
      referenceProvider: { async materialize() { return [{ path: 'CURRENT.md', content: 'old' }] } },
    }
    const workspace = await AgentWorkerWorkspace.open(options)
    await assert.rejects(AgentWorkerWorkspace.refresh({
      ...options,
      referenceProvider: { async materialize() { return [{ path: 'CURRENT.md', content: 'new' }] } },
    }), /AUDIT_UNAVAILABLE/)
    assert.equal(await readFile(join(workspace.path, 'mounts/persona/CURRENT.md'), 'utf8'), 'old')
    assert.equal(await readFile(join(workspace.path, 'mounts/memory/CURRENT.md'), 'utf8'), 'old')
    assert.equal(await readFile(join(workspace.path, 'mounts/skills/CURRENT.md'), 'utf8'), 'old')
  } finally {
    await removeReadonlyTree(directory)
  }
})

test('workspace refresh awaits an asynchronous audit failure before cleaning rollback backups', async () => {
  const { AgentWorkerWorkspace } = await import('../src/agents/worker-workspace.mjs')
  const directory = await mkdtemp(join(tmpdir(), 'chimera-worker-refresh-async-audit-'))
  const audit = {
    async append(fact) {
      if (fact.kind === 'worker.workspace.refreshed') throw new Error('ASYNC_AUDIT_UNAVAILABLE')
    },
  }
  try {
    const options = {
      rootDir: directory,
      manifest: manifest(),
      audit,
      referenceProvider: { async materialize() { return [{ path: 'CURRENT.md', content: 'old' }] } },
    }
    const workspace = await AgentWorkerWorkspace.open(options)
    await assert.rejects(AgentWorkerWorkspace.refresh({
      ...options,
      referenceProvider: { async materialize() { return [{ path: 'CURRENT.md', content: 'new' }] } },
    }), /ASYNC_AUDIT_UNAVAILABLE/)
    assert.equal(await readFile(join(workspace.path, 'mounts/persona/CURRENT.md'), 'utf8'), 'old')
  } finally {
    await removeReadonlyTree(directory)
  }
})

test('workspace refresh reconciles an interrupted old-mount move and preserves scratch artifacts', async () => {
  const { AgentWorkerWorkspace } = await import('../src/agents/worker-workspace.mjs')
  const directory = await mkdtemp(join(tmpdir(), 'chimera-worker-refresh-interrupted-'))
  try {
    const options = {
      rootDir: directory,
      manifest: manifest(),
      audit: new MemoryAuditLog(),
      referenceProvider: { async materialize() { return [{ path: 'CURRENT.md', content: 'old' }] } },
    }
    const workspace = await AgentWorkerWorkspace.open(options)
    await writeFile(join(workspace.path, 'scratch/keep.txt'), 'scratch survives')
    await writeFile(join(workspace.path, 'task-artifact.json'), 'artifact survives')
    await rename(join(workspace.path, 'mounts'), join(directory, '.ace.mounts.tmp'))

    const refreshed = await AgentWorkerWorkspace.refresh({
      ...options,
      referenceProvider: { async materialize() { return [{ path: 'CURRENT.md', content: 'new' }] } },
    })
    assert.equal(await readFile(join(refreshed.path, 'mounts/persona/CURRENT.md'), 'utf8'), 'new')
    assert.equal(await readFile(join(refreshed.path, 'scratch/keep.txt'), 'utf8'), 'scratch survives')
    assert.equal(await readFile(join(refreshed.path, 'task-artifact.json'), 'utf8'), 'artifact survives')
    await assert.rejects(lstat(join(directory, '.ace.mounts.tmp')), { code: 'ENOENT' })
  } finally {
    await removeReadonlyTree(directory)
  }
})
