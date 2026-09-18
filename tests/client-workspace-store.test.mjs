import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm, symlink, mkdir, stat, truncate } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ClientWorkspaceStore } from '../src/clients/workspace-store.mjs'

export function catalog() {
  return { schemaVersion: 1, importedAt: '2026-09-07T00:00:00.000Z', clients: [
    { id: 'FLL-C0001', name: 'Example Client', summary: 'Pilot', status: 'pilot', documents: [{ id: 'doc-1', title: 'Plan', category: 'Planning', kind: 'document', status: 'imported', origin: { label: 'Git', ref: 'https://github.com/example-org/example-repo/blob/main/README.md' }, sha256: null, bytes: 4, content: 'test' }], coverage: [{ source: 'Local', status: 'unavailable', details: 'Offline' }] },
    { id: 'other', name: 'Other', summary: '', status: 'pilot', documents: [], coverage: [] },
  ] }
}
async function fixture(t, data = catalog()) {
  const directory = await mkdtemp(join(resolve('.'), '.client-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  if (data) await writeFile(join(directory, 'catalog.json'), JSON.stringify(data), { mode: 0o600 })
  return { directory, store: await ClientWorkspaceStore.open({ directory }) }
}
test('lists metadata, details without content, exact document and missing import', async t => {
  const { store } = await fixture(t)
  assert.equal((await store.list()).clients[0].documentCount, 1)
  assert.equal((await store.list()).state, 'ready')
  const detail = await store.detail('FLL-C0001')
  assert.equal('content' in detail.documents[0], false)
  assert.deepEqual(detail.notes, [])
  assert.deepEqual(await store.document('FLL-C0001', 'doc-1'), catalog().clients[0].documents[0])
  assert.deepEqual(await (await fixture(t, null)).store.list(), { clients: [], state: 'not_imported' })
})
test('unknown and cross-client documents fail; traversal identifiers fail', async t => {
  const { store } = await fixture(t)
  await assert.rejects(store.document('other', 'doc-1'), { code: 'CLIENT_WORKSPACE_NOT_FOUND' })
  await assert.rejects(store.detail('missing'), { code: 'CLIENT_WORKSPACE_NOT_FOUND' })
  for (const id of ['../catalog.json', '%2e%2e', '/etc/passwd', '', 'x'.repeat(129)]) await assert.rejects(store.detail(id), { code: 'CLIENT_WORKSPACE_INVALID' })
})
test('notes persist concurrently across instances, stay unreviewed, private, and audit is redacted', async t => {
  const { directory, store } = await fixture(t)
  const facts = []
  const second = await ClientWorkspaceStore.open({ directory, appendAudit: async fact => facts.push(fact) })
  const notes = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? store : second).addNote('FLL-C0001', { title: `Note ${i}`, body: 'Private note body', sourceType: 'email' })))
  assert.equal(new Set(notes.map(n => n.id)).size, 12)
  assert.ok(notes.every(n => n.status === 'unreviewed' && n.clientId === 'FLL-C0001' && Number.isFinite(Date.parse(n.createdAt))))
  assert.equal((await (await ClientWorkspaceStore.open({ directory })).detail('FLL-C0001')).notes.length, 12)
  assert.equal((await stat(join(directory, 'notes.json'))).mode & 0o777, 0o600)
  assert.ok(facts.length)
  assert.ok(!JSON.stringify(facts).includes('Private note body'))
})
test('invalid note types, limits, credentials and unknown clients never write', async t => {
  const { directory, store } = await fixture(t)
  const valid = { title: 'Note', body: 'Body', sourceType: 'note' }
  for (const invalid of [null, [], { ...valid, title: '' }, { ...valid, title: 'x'.repeat(161) }, { ...valid, body: 3 }, { ...valid, body: 'x'.repeat(32001) }, { ...valid, sourceType: 'approved' }, { ...valid, body: 'password=supersecret' }, { ...valid, body: '-----BEGIN PRIVATE KEY-----' }, { ...valid, body: 'sk-abcdefghijklmnopqrstuvwxyz123456' }]) await assert.rejects(store.addNote('FLL-C0001', invalid), { code: 'CLIENT_WORKSPACE_INVALID' })
  await assert.rejects(store.addNote('missing', valid), { code: 'CLIENT_WORKSPACE_NOT_FOUND' })
  await assert.rejects(readFile(join(directory, 'notes.json')), { code: 'ENOENT' })
})
test('malformed, duplicate, oversized catalog and malformed notes fail closed', async t => {
  const { directory } = await fixture(t)
  for (const data of ['{', JSON.stringify({ ...catalog(), schemaVersion: 2 }), JSON.stringify({ ...catalog(), clients: [catalog().clients[0], catalog().clients[0]] }), JSON.stringify({ ...catalog(), clients: [{ ...catalog().clients[0], documents: [catalog().clients[0].documents[0], catalog().clients[0].documents[0]] }] })]) {
    await writeFile(join(directory, 'catalog.json'), data)
    await assert.rejects(ClientWorkspaceStore.open({ directory }), { code: 'CLIENT_WORKSPACE_CORRUPT' })
  }
  await truncate(join(directory, 'catalog.json'), 64 * 1024 * 1024 + 1)
  await assert.rejects(ClientWorkspaceStore.open({ directory }), { code: 'CLIENT_WORKSPACE_CORRUPT' })
  await writeFile(join(directory, 'catalog.json'), JSON.stringify(catalog()))
  await writeFile(join(directory, 'notes.json'), '{}')
  await assert.rejects(ClientWorkspaceStore.open({ directory }), { code: 'CLIENT_WORKSPACE_CORRUPT' })
})
test('JSON null files, duplicate/orphan notes and oversized notes fail closed', async t => {
  const { directory } = await fixture(t)
  await writeFile(join(directory, 'catalog.json'), 'null')
  await assert.rejects(ClientWorkspaceStore.open({ directory }), { code: 'CLIENT_WORKSPACE_CORRUPT' })
  await writeFile(join(directory, 'catalog.json'), JSON.stringify(catalog()))
  const note = { id: 'n', clientId: 'FLL-C0001', title: 'N', body: 'B', sourceType: 'note', createdAt: '2026-09-07T00:00:00Z', status: 'unreviewed' }
  for (const value of [null, [note, note], [{ ...note, clientId: 'absent' }], [{ ...note, status: 'approved' }]]) {
    await writeFile(join(directory, 'notes.json'), JSON.stringify(value))
    await assert.rejects(ClientWorkspaceStore.open({ directory }), { code: 'CLIENT_WORKSPACE_CORRUPT' })
  }
  await truncate(join(directory, 'notes.json'), 8 * 1024 * 1024 + 1)
  await assert.rejects(ClientWorkspaceStore.open({ directory }), { code: 'CLIENT_WORKSPACE_CORRUPT' })
})
test('rejects catalog, notes, directory and ancestor symlinks, including after open', async t => {
  const { directory, store } = await fixture(t)
  await mkdir(join(directory, 'real'))
  await symlink(join(directory, 'real'), join(directory, 'alias'))
  await assert.rejects(ClientWorkspaceStore.open({ directory: join(directory, 'alias', 'nested') }), { code: 'CLIENT_WORKSPACE_CORRUPT' })
  await assert.rejects(ClientWorkspaceStore.open({ directory: join(directory, 'alias') }), { code: 'CLIENT_WORKSPACE_CORRUPT' })
  await symlink(join(directory, 'catalog.json'), join(directory, 'notes.json'))
  await assert.rejects(store.addNote('FLL-C0001', { title: 'N', body: 'B', sourceType: 'call' }), { code: 'CLIENT_WORKSPACE_CORRUPT' })
  await rm(join(directory, 'notes.json'))
  await rm(join(directory, 'catalog.json'))
  await symlink(join(directory, 'absent'), join(directory, 'catalog.json'))
  await assert.rejects(store.list(), { code: 'CLIENT_WORKSPACE_CORRUPT' })
})
