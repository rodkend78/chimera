import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, chmod, lstat, rm, writeFile, readFile, symlink, unlink, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { connect } from 'node:net'
import { PassThrough } from 'node:stream'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { encodeFrame, FrameDecoder, writeFrame } from '../src/account-browser/framing.mjs'
import { startCompanionSocket } from '../src/account-browser/socket.mjs'
import { runNativeHost } from '../src/account-browser/host.mjs'
import { AccountCompanionBroker } from '../src/account-browser/broker.mjs'
import { MemoryAuditLog } from '../src/audit-log.mjs'
const allowedOrigin = `chrome-extension://${'a'.repeat(32)}/`
const tick = () => new Promise(resolve => setImmediate(resolve))
async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'ac-'))); const socketPath = join(dir, 's')
  const broker = await AccountCompanionBroker.open({ stateFile: join(dir, 'state'), audit: new MemoryAuditLog(), allowedOrigin, eligibleFor: () => ({ expiresAt: Date.now() + 600000 }) })
  const server = await startCompanionSocket({ socketPath, broker })
  t.after(async () => { await server.close(); await broker.close(); await rm(dir, { recursive: true, force: true }) })
  return { dir, socketPath, broker, server }
}
function decoded(stream) {
  const messages = []; const waiters = []
  const decoder = new FrameDecoder({ onMessage: message => { messages.push(message); waiters.shift()?.(message) }, onError: () => {} })
  stream.on('data', chunk => decoder.push(chunk))
  return { messages, next: () => new Promise(resolve => waiters.push(resolve)) }
}
test('framing accepts partial headers/bodies and concatenated records', () => {
  const values = [], errors = []
  const decoder = new FrameDecoder({ onMessage: v => values.push(v), onError: e => errors.push(e) })
  const bytes = Buffer.concat([encodeFrame({ text: 'héllo' }), encodeFrame({ ok: true })])
  for (const byte of bytes) decoder.push(Buffer.from([byte]))
  decoder.end(); assert.deepEqual(values, [{ text: 'héllo' }, { ok: true }]); assert.equal(errors.length, 0)
})
test('framing fails closed on zero/excessive lengths, UTF8/JSON/non-record and incomplete EOF', () => {
  for (const bytes of [Buffer.alloc(4), Buffer.from([255,255,255,255]), Buffer.concat([encodeFrame({}).subarray(0,4), Buffer.from([0xc0,0xc0])]), Buffer.from([1,0,0,0,123]), Buffer.from([2,0,0,0,91,93]), Buffer.from([2]), encodeFrame({a:1}).subarray(0,6)]) {
    const errors = [], values = []; const decoder = new FrameDecoder({ onMessage: v => values.push(v), onError: e => errors.push(e) })
    decoder.push(bytes); decoder.end(); decoder.push(encodeFrame({ late: true }))
    assert.equal(errors.length, 1); assert.equal(values.length, 0)
  }
  assert.throws(() => encodeFrame({ text: 'x'.repeat(256 * 1024) }))
  assert.throws(() => encodeFrame([]))
})
test('socket is private and a second owner cannot replace it', async t => {
  const f = await fixture(t)
  assert.equal((await lstat(f.socketPath)).mode & 0o777, 0o600)
  assert.equal((await lstat(f.dir)).mode & 0o777, 0o700)
  await assert.rejects(startCompanionSocket({ socketPath: f.socketPath, broker: f.broker }))
  assert.ok((await lstat(f.socketPath)).isSocket())
})
test('simultaneous socket owners publish exactly one live listener', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'ac-'))); const socketPath = join(dir, 's')
  t.after(() => rm(dir, { recursive: true, force: true }))
  const results = await Promise.allSettled([startCompanionSocket({ socketPath, broker: {} }), startCompanionSocket({ socketPath, broker: {} })])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(results.filter(r => r.status === 'rejected').length, 1)
  const winner = results.find(r => r.status === 'fulfilled').value
  assert.ok((await lstat(socketPath)).isSocket())
  await winner.close()
})
test('frame writes reject blocked destinations before buffering beyond one message', () => {
  const stream = new PassThrough({ highWaterMark: 1 })
  writeFrame(stream, { text: 'x'.repeat(200000) })
  assert.throws(() => writeFrame(stream, { text: 'x'.repeat(100000) }), /backpressure/)
  assert.ok(stream.writableLength < 256 * 1024 + 4)
  stream.destroy()
})
test('socket refuses unsafe directories, symlinks, existing files and overlong paths', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'ac-'))); t.after(() => rm(dir, { recursive: true, force: true }))
  const broker = { connect() { throw new Error('unexpected') } }
  await writeFile(join(dir, 'file'), 'keep')
  await assert.rejects(startCompanionSocket({ socketPath: join(dir, 'file'), broker }))
  assert.equal(await readFile(join(dir, 'file'), 'utf8'), 'keep')
  await symlink(join(dir, 'file'), join(dir, 'link'))
  await assert.rejects(startCompanionSocket({ socketPath: join(dir, 'link'), broker }))
  await chmod(dir, 0o755)
  await assert.rejects(startCompanionSocket({ socketPath: join(dir, 's'), broker }))
  await chmod(dir, 0o700)
  await assert.rejects(startCompanionSocket({ socketPath: join(dir, 'x'.repeat(110)), broker }))
  await symlink(dir, `${dir}-link`)
  t.after(() => unlink(`${dir}-link`))
  await assert.rejects(startCompanionSocket({ socketPath: join(`${dir}-link`, 's'), broker }))
})
test('socket close does not remove a replacement file', async t => {
  const f = await fixture(t)
  await unlink(f.socketPath); await writeFile(f.socketPath, 'replacement')
  await f.server.close()
  assert.equal(await readFile(f.socketPath, 'utf8'), 'replacement')
})
test('wire origin gate and malformed frames disconnect peers', async t => {
  const f = await fixture(t)
  for (const frame of [encodeFrame({ type: 'connect', origin: 'chrome-extension://evil/' }), Buffer.alloc(4), encodeFrame({ id: 'h', type: 'hello', profileId: 'profile-a' })]) {
    const socket = connect(f.socketPath); await once(socket, 'connect'); const closed = once(socket, 'close'); socket.write(frame); await closed
  }
  assert.equal(f.broker.state().pendingPairs.length, 0)
})
test('native host bridges pairing/share and peer close revokes leases', async t => {
  const f = await fixture(t); const input = new PassThrough(); const output = new PassThrough(); const received = decoded(output)
  const host = await runNativeHost({ input, output, socketPath: f.socketPath, origin: allowedOrigin, allowedOrigin })
  t.after(() => host.close())
  let next = received.next(); input.write(encodeFrame({ id: 'h', type: 'hello', profileId: 'profile-a' })); const challenge = await next
  await f.broker.approvePair({ pairingId: challenge.pairingId })
  next = received.next(); input.write(encodeFrame({ id: 'a', type: 'authenticate', pairingId: challenge.pairingId, challenge: challenge.challenge })); assert.equal((await next).type, 'paired')
  next = received.next(); input.write(encodeFrame({ id: 's', type: 'share', tabId: 2, documentId: 'doc', origin: 'https://example.com', urlDigest: 'a'.repeat(64), taskId: 'task', agentId: 'agent' })); const shared = await next
  assert.equal(shared.type, 'shared'); await host.close()
  for (let i = 0; i < 20 && f.broker.state().leases[0].status === 'active'; i++) await tick()
  assert.equal(f.broker.state().leases[0].status, 'disconnected')
  await assert.rejects(runNativeHost({ input: new PassThrough(), output: new PassThrough(), socketPath: f.socketPath, origin: 'wrong', allowedOrigin }))
})
test('a real child host writes only decodable native frames to stdout', async t => {
  const f = await fixture(t)
  const moduleUrl = new URL('../src/account-browser/host.mjs', import.meta.url).href
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {runNativeHost} from ${JSON.stringify(moduleUrl)}; await runNativeHost({input:process.stdin,output:process.stdout,socketPath:process.argv[1],origin:process.argv[2],allowedOrigin:process.argv[2]});`, f.socketPath, allowedOrigin], { stdio: ['pipe','pipe','pipe'] })
  t.after(() => child.kill())
  const chunks = []; child.stdout.on('data', chunk => chunks.push(chunk))
  const received = decoded(child.stdout); const next = received.next()
  child.stdin.write(encodeFrame({ id: 'hello-child', type: 'hello', profileId: 'profile-child' }))
  assert.equal((await next).type, 'challenge')
  const exited = once(child, 'exit'); child.stdin.end(); await exited
  const values = [], errors = []; const decoder = new FrameDecoder({ onMessage: m => values.push(m), onError: e => errors.push(e) })
  decoder.push(Buffer.concat(chunks)); decoder.end()
  assert.equal(errors.length, 0); assert.equal(values.length, 1); assert.equal(values[0].id, 'hello-child')
})

test('unauthenticated native host inactivity closes the paired broker transport', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await fixture(t); const input = new PassThrough(); const output = new PassThrough(); const received = decoded(output)
  const host = await runNativeHost({ input, output, socketPath: f.socketPath, origin: allowedOrigin, allowedOrigin }); t.after(() => host.close())
  const next = received.next(); input.write(encodeFrame({ id: 'h', type: 'hello', profileId: 'idle-profile' })); await next
  assert.equal(f.broker.state().pendingPairs.length, 1)
  t.mock.timers.tick(120001)
  for (let i = 0; i < 20 && f.broker.state().pendingPairs.length; i++) await tick()
  assert.equal(f.broker.state().pendingPairs.length, 0)
})
