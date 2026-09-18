import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, symlink, writeFile, readFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir as systemTmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const backend = await import('../src/clients/intake-service.mjs').catch(() => ({}))
const storage = await import('../src/clients/intake-store.mjs').catch(() => ({}))
const manual = { requestId: 'manual-1', name: 'Example', email: 'owner@example.test', services: ['website'], summary: '' }
const tmpdir = () => realpathSync(systemTmpdir())
async function fixture(t, extra = {}) {
  assert.equal(typeof backend.ClientIntakeService, 'function', 'intake service is implemented')
  const directory = await mkdtemp(join(tmpdir(), 'chimera-intake-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = await storage.IntakeStore.open({ directory })
  const service = new backend.ClientIntakeService({ store, ...extra })
  t.after(() => service.close())
  return { service, store, directory }
}
test('manual retries and restart retain one client and never submit work during capture', async t => {
  const { service, directory } = await fixture(t, { runtime: { submitIntakeTask() { assert.fail('automatic spend') } } })
  const first = await service.createClient(manual)
  assert.equal((await service.createClient(manual)).client.id, first.client.id)
  assert.equal((await service.list()).clients.length, 1)
  assert.equal((await service.status()).queue[0].status, 'ready')
  assert.equal((await stat(join(directory, 'intake.json'))).mode & 0o777, 0o600)
  await service.close()
  const reopened = await storage.IntakeStore.open({ directory })
  assert.equal(reopened.read().clients.length, 1)
  await reopened.close()
})
test('rejects conflicting request replay and unsafe inputs without persisting credentials', async t => {
  const { service, directory } = await fixture(t)
  await service.createClient(manual)
  await assert.rejects(service.createClient({ ...manual, name: 'Changed' }), { code: 'CLIENT_INTAKE_CONFLICT' })
  for (const input of [{ ...manual, requestId: 'x', email: 'bad' }, { ...manual, requestId: 'y', summary: 'password=secret' }, { ...manual, requestId: '../x' }]) await assert.rejects(service.createClient(input), { code: 'CLIENT_INTAKE_INVALID' })
  assert.doesNotMatch(await readFile(join(directory, 'intake.json'), 'utf8'), /password/)
})
test('profile rejects second writer and unsafe ledger symlinks', async t => {
  const { directory } = await fixture(t)
  await assert.rejects(storage.IntakeStore.open({ directory }), { code: 'CLIENT_INTAKE_LOCKED' })
  const unsafe = await mkdtemp(join(tmpdir(), 'chimera-unsafe-'))
  t.after(() => rm(unsafe, { recursive: true, force: true }))
  await writeFile(join(unsafe, 'target'), '{}')
  await symlink(join(unsafe, 'target'), join(unsafe, 'intake.json'))
  await assert.rejects(storage.IntakeStore.open({ directory: unsafe }), { code: 'CLIENT_INTAKE_CORRUPT' })
})
test('handoff reconciles a lost reply against a stable runtime task id', async t => {
  const tasks = new Map(); let launches = 0; let loseReply = true
  const runtime = { async submitIntakeTask({ taskId, objective }) {
    if (!tasks.has(taskId)) { launches++; tasks.set(taskId, { taskId, objective }) }
    if (loseReply) { loseReply = false; throw new Error('lost reply') }
    return tasks.get(taskId)
  } }
  const { service } = await fixture(t, { runtime })
  await service.createClient(manual)
  const row = (await service.status()).queue[0]
  await assert.rejects(service.handoff(row.id))
  const second = await service.handoff(row.id)
  assert.equal(second.status, 'handed_off')
  assert.equal((await service.handoff(row.id)).taskId, second.taskId)
  assert.equal(launches, 1)
})
test('merged imported records and document reads preserve authoritative catalog', async t => {
  const catalog = { async list() { return { clients: [{ id: 'old', name: 'Imported' }], state: 'ready' } }, async detail() { return { client: { id: 'old' }, notes: ['retained'] } }, async document() { return { content: 'original' } } }
  const { service } = await fixture(t, { catalog })
  await service.createClient(manual)
  assert.equal((await service.list()).clients.length, 2)
  assert.deepEqual((await service.detail('old')).notes, ['retained'])
  assert.equal((await service.document('old', 'doc')).content, 'original')
})
test('sync coalesces, retains partial records without success checkpoint, retries and reviews edits', async t => {
  let fail = true; let scanCount = 0
  const item = { sourceId: 'form:r1', version: 'v1', name: 'Form client', email: 'form@example.test', services: ['website'], issues: [], evidence: [], references: [] }
  const google = { async scan({ capture }) { scanCount++; await capture(item); if (fail) throw new Error('secret response'); await capture({ ...item, sourceId: 'form:r2' }); return { complete: true } } }
  const connection = { async close() {}, async status() { return { state: 'connected', account: 'owner@example.test', setupMessage: null } } }
  const { service, store } = await fixture(t, { google, connection })
  await Promise.all([service.sync(), service.sync()])
  assert.equal(scanCount, 1)
  assert.equal((await service.status()).sync.lastSuccessAt, null)
  assert.doesNotMatch(JSON.stringify(await service.status()), /secret response/)
  fail = false; await service.sync()
  assert.equal((await service.list()).clients.length, 2)
  assert.ok((await service.status()).sync.lastSuccessAt)
  await service.capture({ ...item, version: 'v2', name: 'Edited' })
  assert.equal(store.read().clients[0].name, 'Form client')
  assert.equal((await service.status()).queue[0].status, 'review_required')
  await assert.rejects(service.handoff((await service.status()).queue[0].id), { code: 'CLIENT_INTAKE_REVIEW_REQUIRED' })
})
test('Pacific schedule tracks daylight saving and startup catchup is once', async t => {
  assert.equal(typeof backend.nextCheckAt, 'function')
  assert.equal(backend.nextCheckAt(new Date('2026-09-08T13:59:00Z')), '2026-09-08T14:00:00.000Z')
  assert.equal(backend.nextCheckAt(new Date('2026-12-08T14:59:00Z')), '2026-12-08T15:00:00.000Z')
  let scans = 0
  const { service } = await fixture(t, { connection: { async close() {}, async status() { return { state: 'connected' } } }, google: { async scan() { scans++; return { complete: true } } } })
  await service.start(); await service.start()
  assert.equal(scans, 1)
})
test('dead writer lock is recovered on restart without discarding captured clients', async t => {
  const { service, directory } = await fixture(t)
  await service.createClient(manual); await service.close()
  const { stdout } = await promisify(execFile)(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'])
  await writeFile(join(directory, 'writer.lock'), JSON.stringify({ pid: Number(stdout), token: 'old-owner' }), { mode: 0o600 })
  const restarted = await storage.IntakeStore.open({ directory })
  assert.equal(restarted.read().clients.length, 1)
  await restarted.close()
})
test('malformed persisted client and queue objects reject rather than become trusted ready work', async t => {
  const { service, directory } = await fixture(t)
  await service.createClient(manual); await service.close()
  const state = JSON.parse(await readFile(join(directory, 'intake.json')))
  state.queue[0].status = 'unknown'; state.clients[0].name = { instruction: 'not facts' }
  await writeFile(join(directory, 'intake.json'), JSON.stringify(state))
  await assert.rejects(storage.IntakeStore.open({ directory }), { code: 'CLIENT_INTAKE_CORRUPT' })
})
test('new client notes validate credentials and survive restart with imported notes delegated', async t => {
  const { service, directory } = await fixture(t)
  assert.equal(typeof service.addNote, 'function')
  const { client } = await service.createClient(manual)
  const note = await service.addNote(client.id, { title: 'Call', body: 'Owner approved discovery', sourceType: 'call' })
  await assert.rejects(service.addNote(client.id, { title: 'Secret', body: 'password=never-store', sourceType: 'note' }), { code: 'CLIENT_INTAKE_INVALID' })
  await service.close()
  const reopened = new backend.ClientIntakeService({ store: await storage.IntakeStore.open({ directory }) })
  assert.equal((await reopened.detail(client.id)).notes[0].id, note.id)
  await reopened.close()
})
test('unavailable intake reports corruption and rejects operations without discarding state', async t => {
  const { service, directory } = await fixture(t); await service.createClient(manual); await service.close()
  await writeFile(join(directory, 'intake.json'), '{')
  assert.equal(typeof backend.ClientIntakeService.open, 'function')
  const isolated = await backend.ClientIntakeService.open({ directory })
  assert.equal((await isolated.status()).sync.error, 'CLIENT_INTAKE_CORRUPT')
  await assert.rejects(isolated.list(), { code: 'CLIENT_INTAKE_CORRUPT' })
  await assert.rejects(isolated.createClient(manual), { code: 'CLIENT_INTAKE_CORRUPT' })
  assert.equal(await readFile(join(directory, 'intake.json'), 'utf8'), '{')
  await isolated.close()
})
test('form questionnaire and asset references are readable and included in bounded handoff objective', async t => {
  let objective
  const { service } = await fixture(t, { runtime: { async submitIntakeTask(input) { objective = input.objective; return { taskId: input.taskId } } } })
  await service.capture({ sourceId: 'form:details', version: 'v1', name: 'Detailed client', email: 'owner@example.test', services: ['Website'], issues: [], evidence: [{ questionId: 'goals', label: 'Business goals', answers: ['Book three jobs per week'], trust: 'untrusted' }], references: [{ kind: 'drive', id: 'asset' }] })
  const row = (await service.status()).queue[0]
  const detail = await service.detail(row.clientId)
  assert.equal(detail.documents.length, 1)
  assert.equal((await service.list()).clients[0].documentCount, 1)
  const doc = await service.document(row.clientId, detail.documents[0].id)
  assert.match(doc.content, /Book three jobs per week/)
  await service.handoff(row.id)
  assert.match(objective, /Book three jobs per week/)
  assert.match(objective, /asset/)
})
test('oversized briefs and imported name matches remain reviewable without launching', async t => {
  const { service } = await fixture(t, { catalog: { async list() { return { clients: [{ id: 'imported', name: 'Existing Business' }], state: 'ready' } } } })
  const item = { sourceId: 'form:large', version: 'v1', name: ' existing business ', email: 'new@example.test', services: ['Website'], issues: [], evidence: [{ questionId: 'details', label: 'Details', answers: ['x'.repeat(17000)] }], references: [] }
  await service.capture(item)
  const row = (await service.status()).queue[0]
  assert.equal(row.status, 'review_required')
  assert.ok(row.issues.includes('BRIEF_REVIEW_REQUIRED'))
  assert.ok(row.issues.includes('EXISTING_CLIENT_REVIEW_REQUIRED'))
  const detail = await service.detail(row.clientId)
  assert.match((await service.document(row.clientId, detail.documents[0].id)).content, /x{17000}/)
})
