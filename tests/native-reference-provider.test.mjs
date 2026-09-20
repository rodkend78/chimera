import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { MemoryAuditLog } from '../src/audit-log.mjs'
import { NativeAgentReferenceProvider } from '../src/agents/native-reference-provider.mjs'

const FILESYSTEM_HELPER = fileURLToPath(new URL('../src/agents/native-persona-filesystem.py', import.meta.url))

function runFilesystem(request) {
  return new Promise((resolve, reject) => {
    const child = execFile('/usr/bin/python3', ['-I', '-B', FILESYSTEM_HELPER], {
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    }, (error, stdout) => {
      if (error) return reject(error)
      resolve(JSON.parse(stdout))
    })
    child.stdin.end(JSON.stringify(request))
  })
}

test('native provider stores one bounded persona and explicitly reports empty memory and skills', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-native-provider-'))
  const audit = new MemoryAuditLog()
  try {
    const provider = await NativeAgentReferenceProvider.open({ root: directory, audit })
    const saved = await provider.savePersona({
      agentId: 'native-agent',
      content: 'Be evidence-led and direct.',
      changedBy: 'rod',
    })
    assert.equal(saved.agentId, 'native-agent')
    assert.equal(saved.path, 'SOUL.md')
    assert.match(saved.digest, /^[a-f0-9]{64}$/)
    assert.equal(await readFile(join(directory, 'native-agent', 'persona', 'SOUL.md'), 'utf8'), 'Be evidence-led and direct.')
    assert.deepEqual(await provider.materialize('chimera://local/agents/native-agent/persona', {
      agentId: 'native-agent', kind: 'persona',
    }), [{ path: 'SOUL.md', content: 'Be evidence-led and direct.' }])
    assert.deepEqual(await provider.materialize('chimera://local/agents/native-agent/memory', {
      agentId: 'native-agent', kind: 'memory',
    }), [])
    assert.deepEqual(await provider.materialize('chimera://local/agents/native-agent/skills', {
      agentId: 'native-agent', kind: 'skills',
    }), [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('native provider rejects credential and private-key persona material without logging it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-native-provider-secrets-'))
  const audit = new MemoryAuditLog()
  try {
    const provider = await NativeAgentReferenceProvider.open({ root: directory, audit })
    await assert.rejects(provider.savePersona({
      agentId: 'native-agent', content: 'OPENAI_API_KEY=not-a-real-key', changedBy: 'rod',
    }), /NATIVE_PERSONA_CONTENT_INVALID/)
    const privateKeyHeader = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ')
    await assert.rejects(provider.savePersona({
      agentId: 'native-agent', content: `${privateKeyHeader}\nsecret`, changedBy: 'rod',
    }), /NATIVE_PERSONA_CONTENT_INVALID/)
    assert.equal(audit.entries().some((entry) => JSON.stringify(entry).includes('not-a-real-key')), false)
    assert.equal(audit.entries().some((entry) => JSON.stringify(entry).includes('PRIVATE KEY')), false)
    await assert.rejects(provider.savePersona({
      agentId: '../escape', content: 'nope', changedBy: 'rod',
    }), /NATIVE_AGENT_ID_INVALID/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('native provider and descriptor helper reject DSA and encrypted PEM headers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-native-provider-pem-'))
  const audit = new MemoryAuditLog()
  try {
    const provider = await NativeAgentReferenceProvider.open({ root: directory, audit })
    const headers = [
      ['-----BEGIN', 'DSA PRIVATE KEY-----'].join(' '),
      ['-----BEGIN', 'ENCRYPTED PRIVATE KEY-----'].join(' '),
    ]
    for (const header of headers) {
      const content = `${header}\nsecret\n-----END PRIVATE KEY-----`
      await assert.rejects(provider.savePersona({ agentId: 'native-agent', content, changedBy: 'rod' }), /NATIVE_PERSONA_CONTENT_INVALID/)
      const helperResult = await runFilesystem({
        root: directory,
        operation: 'save',
        agentId: 'native-agent',
        content: Buffer.from(content, 'utf8').toString('base64'),
      })
      assert.equal(helperResult.error, 'NATIVE_PERSONA_CONTENT_INVALID')
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('native persona save awaits audit failure without reporting a durable success', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-native-provider-audit-'))
  try {
    const provider = await NativeAgentReferenceProvider.open({
      root: directory,
      audit: { async append() { throw new Error('AUDIT_UNAVAILABLE') } },
    })
    await assert.rejects(provider.savePersona({ agentId: 'native-agent', content: 'Audit must be available.', changedBy: 'rod' }), /AUDIT_UNAVAILABLE/)
    assert.equal(await readFile(join(directory, 'native-agent', 'persona', 'SOUL.md'), 'utf8'), 'Audit must be available.')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('native provider rejects URI and materialization identity mismatches', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-native-provider-refs-'))
  try {
    const provider = await NativeAgentReferenceProvider.open({ root: directory, audit: new MemoryAuditLog() })
    await assert.rejects(provider.materialize('hermes://configured-hermes/profiles/native-agent/persona', {
      agentId: 'native-agent', kind: 'persona',
    }), /NATIVE_REFERENCE_MISMATCH/)
    await assert.rejects(provider.materialize('chimera://local/agents/other/persona', {
      agentId: 'native-agent', kind: 'persona',
    }), /NATIVE_REFERENCE_MISMATCH/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('native provider refuses root and persona ancestor symlinks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-native-provider-symlink-'))
  try {
    const realRoot = join(directory, 'real-root')
    await mkdir(realRoot)
    await symlink(realRoot, join(directory, 'root-link'))
    await assert.rejects(NativeAgentReferenceProvider.open({
      root: join(directory, 'root-link'), audit: new MemoryAuditLog(),
    }), /NATIVE_REFERENCE_ROOT_INVALID/)

    const provider = await NativeAgentReferenceProvider.open({ root: realRoot, audit: new MemoryAuditLog() })
    await mkdir(join(realRoot, 'native-agent'))
    await mkdir(join(directory, 'outside'))
    await symlink(join(directory, 'outside'), join(realRoot, 'native-agent', 'persona'))
    await assert.rejects(provider.savePersona({
      agentId: 'native-agent', content: 'No path escape.', changedBy: 'rod',
    }), /NATIVE_REFERENCE_SYMLINK_BLOCKED/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
