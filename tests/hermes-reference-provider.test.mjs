import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  createHermesReferenceProviderFromEnv,
  HermesS3ReferenceProvider,
  resolveHermesBackupTarget,
} from '../src/agents/hermes-reference-provider.mjs'

const DEFAULT_BUCKET_SENTINEL = 'example-hermes-vault'

test('explicit local snapshot materializes continuity without cloud credentials and filters secrets', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'chimera-hermes-snapshot-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'snapshot.json')
  const entry = (key, value) => ({ key, content: Buffer.from(value).toString('base64'),
    sha256: createHash('sha256').update(value).digest('hex') })
  const document = { schema: 'chimera.hermes-snapshot.v1', entries: [
    entry('ace/SOUL.md', 'Current Ace persona'),
    entry('ace/memories/MEMORY.md', 'Current memory'),
    entry('ace/skills/review/SKILL.md', 'Review the evidence'),
    entry('ace/memories/notes.md', 'OPENAI_API_KEY=never-import'),
  ] }
  await writeFile(file, JSON.stringify(document), { mode: 0o600 })
  const load = () => createHermesReferenceProviderFromEnv({ CHIMERA_HERMES_SNAPSHOT_FILE: file })
  assert.deepEqual(await load().materialize('hermes://configured-hermes/profiles/ace/memory', { agentId: 'ace', kind: 'memory' }),
    [{ path: 'MEMORY.md', content: Buffer.from('Current memory') }])
  assert.deepEqual((await load().materialize('hermes://configured-hermes/profiles/ace/skills', { agentId: 'ace', kind: 'skills' })).map(e => e.path), ['review/SKILL.md'])
  await assert.rejects(load().materialize('hermes://configured-hermes/profiles/rj/persona', { agentId: 'ace', kind: 'persona' }), /MISMATCH/)
  document.entries[0].content = Buffer.from('Tampered').toString('base64')
  await writeFile(file, JSON.stringify(document))
  await assert.rejects(load().materialize('hermes://configured-hermes/profiles/ace/persona', { agentId: 'ace', kind: 'persona' }), /SNAPSHOT_INVALID/)
  const link = join(dir, 'link.json')
  await symlink(file, link)
  await assert.rejects(createHermesReferenceProviderFromEnv({ CHIMERA_HERMES_SNAPSHOT_FILE: link })
    .materialize('hermes://configured-hermes/profiles/ace/persona', { agentId: 'ace', kind: 'persona' }))
})

test('Hermes S3 references expose only approved persona, bounded memory, and skill definitions', async () => {
  const objects = new Map([
    ['server/agent-state/hermes-profiles/ace/SOUL.md', 'Be unmistakably Ace.'],
    ['server/agent-state/hermes-profiles/ace/IDENTITY.md', 'Ace identity'],
    ['server/agent-state/hermes-profiles/ace/AGENTS.md', 'Ace operating rules'],
    ['server/agent-state/hermes-profiles/ace/USER.md', 'Works for operator'],
    ['server/agent-state/hermes-profiles/ace/TOOLS.md', 'Tool guidance'],
    ['server/agent-state/hermes-profiles/ace/.env', 'TOKEN=secret'],
    ['server/agent-state/hermes-profiles/ace/auth.json', '{"token":"secret"}'],
    ['server/agent-state/hermes-profiles/ace/config.yaml', 'provider: secret'],
    ['server/agent-state/hermes-profiles/ace/memories/MEMORY.md', 'safe memory'],
    ['server/agent-state/hermes-profiles/ace/memories/.lock', ''],
    ['server/agent-state/hermes-profiles/ace/skills/reviewer/SKILL.md', 'safe skill'],
    ['server/agent-state/hermes-profiles/ace/skills/reviewer/run.sh', 'unsafe implicit executable'],
    ['server/agent-state/hermes-profiles/ace/skills/reviewer/node_modules/pkg/index.js', 'dependency'],
    ['server/agent-state/hermes-profiles/ace/skills/.cache/token.json', 'secret'],
    ['server/agent-state/hermes-profiles/ace/sessions/session.json', 'credential-adjacent'],
  ])
  const provider = new HermesS3ReferenceProvider({
    bucket: 'safe-bucket',
    prefix: 'server/agent-state/hermes-profiles/',
    listObjects: async (prefix) => [...objects].filter(([key]) => key.startsWith(prefix)).map(([Key, value]) => ({ Key, Size: Buffer.byteLength(value) })),
    getObject: async (key) => Buffer.from(objects.get(key)),
  })
  assert.deepEqual(await provider.materialize('hermes://configured-hermes/profiles/ace/persona', { agentId: 'ace', kind: 'persona' }), [
    { path: 'AGENTS.md', content: Buffer.from('Ace operating rules') },
    { path: 'IDENTITY.md', content: Buffer.from('Ace identity') },
    { path: 'SOUL.md', content: Buffer.from('Be unmistakably Ace.') },
    { path: 'TOOLS.md', content: Buffer.from('Tool guidance') },
    { path: 'USER.md', content: Buffer.from('Works for operator') },
  ])
  assert.deepEqual(await provider.materialize('hermes://configured-hermes/profiles/ace/memory', { agentId: 'ace', kind: 'memory' }), [
    { path: 'MEMORY.md', content: Buffer.from('safe memory') },
  ])
  assert.deepEqual(await provider.materialize('hermes://configured-hermes/profiles/ace/skills', { agentId: 'ace', kind: 'skills' }), [
    { path: 'reviewer/SKILL.md', content: Buffer.from('safe skill') },
  ])
})

test('Hermes continuity drops a text document whose body contains credential material', async () => {
  const provider = new HermesS3ReferenceProvider({
    bucket: 'fixture',
    listObjects: async () => [
      { Key: 'server/agent-state/hermes-profiles/rj/memories/safe.md', Size: 12 },
      { Key: 'server/agent-state/hermes-profiles/rj/memories/notes.md', Size: 42 },
    ],
    getObject: async (key) => key.endsWith('safe.md')
      ? Buffer.from('Safe memory.')
      : Buffer.from('OPENAI_API_KEY=sk-do-not-import-this-value'),
  })
  const memory = await provider.materialize('hermes://configured-hermes/profiles/rj/memory', {
    agentId: 'rj',
    kind: 'memory',
  })
  assert.deepEqual(memory.map((entry) => entry.path), ['safe.md'])
})

test('Hermes references reject cross-agent, wrong-kind, and oversized materialization', async () => {
  const provider = new HermesS3ReferenceProvider({
    bucket: 'safe-bucket',
    listObjects: async () => [{ Key: 'server/agent-state/hermes-profiles/ace/memories/MEMORY.md', Size: 2_000_000 }],
    getObject: async () => Buffer.alloc(2_000_000),
  })
  await assert.rejects(provider.materialize('hermes://configured-hermes/profiles/dev/memory', { agentId: 'ace', kind: 'memory' }), /HERMES_REFERENCE_MISMATCH/)
  await assert.rejects(provider.materialize('hermes://configured-hermes/profiles/ace/skills', { agentId: 'ace', kind: 'memory' }), /HERMES_REFERENCE_MISMATCH/)
  await assert.rejects(provider.materialize('hermes://configured-hermes/profiles/ace/memory', { agentId: 'ace', kind: 'memory' }), /HERMES_REFERENCE_FILE_TOO_LARGE/)
})

test('Hermes backup target fails closed when the bucket env is unset', async () => {
  assert.equal(resolveHermesBackupTarget({}), null)
  assert.equal(resolveHermesBackupTarget({ CHIMERA_HERMES_BACKUP_BUCKET: '  ' }), null)
  const provider = createHermesReferenceProviderFromEnv({})
  await assert.rejects(
    provider.materialize('hermes://configured-hermes/profiles/ace/persona', { agentId: 'ace', kind: 'persona' }),
    (error) => {
      assert.equal(error.code, 'HERMES_REFERENCE_NOT_CONFIGURED')
      assert.equal(error.message, 'HERMES_REFERENCE_NOT_CONFIGURED')
      return true
    },
  )
})

test('Hermes backup target uses an explicit env bucket and never a production vault default', () => {
  const target = resolveHermesBackupTarget({
    CHIMERA_HERMES_BACKUP_BUCKET: 'chimera-hermes-staging',
    CHIMERA_HERMES_BACKUP_PREFIX: 'staging/hermes-profiles/',
  })
  assert.equal(target.bucket, 'chimera-hermes-staging')
  assert.equal(target.prefix, 'staging/hermes-profiles/')
  assert.notEqual(target.bucket, DEFAULT_BUCKET_SENTINEL)
})
