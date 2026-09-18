import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, lstat, writeFile, symlink, rm, realpath, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { prepareCompanion, uninstallCompanion, EXPECTED_ORIGIN } from '../src/account-browser/installer.mjs'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { FrameDecoder, writeFrame } from '../src/account-browser/framing.mjs'
import fsPromises from 'node:fs/promises'
import { constants } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'companion-'))); t.after(() => rm(root, { recursive: true, force: true }))
  return { root, destination: join(root, "installed ' space"), hostManifestDir: join(root, 'native hosts'), nodePath: process.execPath, socketPath: join(root, 'bridge.sock') }
}
test('setup CLI describes fixed repository discovery rather than suggesting unsupported config override', async t => {
  const args = await fixture(t)
  const { stdout } = await promisify(execFile)(process.execPath, [new URL('../scripts/account-browser/setup.mjs', import.meta.url).pathname, 'prepare', '--destination', args.destination, '--host-manifest-dir', args.hostManifestDir, '--node-path', args.nodePath, '--socket-path', args.socketPath])
  const result = JSON.parse(stdout)
  assert.match(result.instructions, /<repo>\/\.chimera\/account-browser\/install/)
  assert.match(result.instructions, /not auto-discovered/)
  assert.match(result.instructions, /restart/i)
  assert.doesNotMatch(result.instructions, /Configure Chimera with runtimeConfigPath/)
})
test('explicit prepare makes independent private package with stable exact origin and idempotent receipt', async t => {
  const args = await fixture(t); const prepared = await prepareCompanion(args)
  assert.equal(prepared.runtimeConfigPath, join(args.destination, 'runtime.json'))
  const config = JSON.parse(await readFile(prepared.runtimeConfigPath)); assert.equal(config.allowedOrigin, EXPECTED_ORIGIN)
  const manifest = JSON.parse(await readFile(join(config.extensionPath, 'manifest.json')))
  assert.deepEqual(manifest.permissions.sort(), ['activeTab', 'nativeMessaging', 'scripting'])
  const id = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, x => String.fromCharCode(97 + parseInt(x,16)))
  assert.equal(EXPECTED_ORIGIN, `chrome-extension://${id}/`)
  const host = JSON.parse(await readFile(config.hostManifestPath)); assert.deepEqual(host.allowed_origins, [EXPECTED_ORIGIN]); assert.equal((await lstat(host.path)).mode & 0o777, 0o700)
  const receipt = JSON.parse(await readFile(prepared.receiptPath))
  for (const file of receipt.files) assert.equal((await lstat(file.path)).mode & 0o777, file.mode)
  assert.ok(receipt.files.some(f => f.path.endsWith('/host.mjs')))
  assert.ok(receipt.files.some(f => f.path.endsWith('/socket.mjs')))
  assert.deepEqual(await prepareCompanion(args), prepared)
  await uninstallCompanion({ receiptPath: prepared.receiptPath })
  await assert.rejects(lstat(config.hostManifestPath), { code: 'ENOENT' })
})
test('prepare refuses symlinks and foreign existing files; uninstall preserves edited files', async t => {
  const args = await fixture(t); await mkdir(args.destination); await writeFile(join(args.destination, 'runtime.json'), 'foreign')
  await assert.rejects(prepareCompanion(args)); assert.equal(await readFile(join(args.destination, 'runtime.json'), 'utf8'), 'foreign')
  const next = { ...args, destination: join(args.root, 'second') }; const prepared = await prepareCompanion(next)
  await writeFile(prepared.runtimeConfigPath, 'edited')
  await assert.rejects(uninstallCompanion({ receiptPath: prepared.receiptPath }))
  assert.equal(await readFile(prepared.runtimeConfigPath, 'utf8'), 'edited')
  const other = { ...args, destination: join(args.root, 'linked') }; await symlink(next.destination, other.destination)
  await assert.rejects(prepareCompanion(other))
})

test('prepared executable bridges from independent cwd, rejects foreign origin, ignores Node environment flags', async t => {
  const args = await fixture(t); const prepared = await prepareCompanion(args)
  const server = createServer(socket => {
    const decoder = new FrameDecoder({ onError: () => socket.destroy(), onMessage: m => {
      if (m.type === 'connect') assert.equal(m.origin, EXPECTED_ORIGIN)
      else writeFrame(socket, { type: 'challenge', id: m.id, pairingId: 'fixture', challenge: 'local', expiresAt: Date.now() + 10000 })
    } }); socket.on('data', chunk => decoder.push(chunk))
  })
  server.listen(args.socketPath); await once(server, 'listening'); await chmod(args.socketPath, 0o600)
  t.after(() => new Promise(resolve => server.close(resolve)))
  const host = JSON.parse(await readFile(prepared.hostManifestPath))
  const child = spawn(host.path, [EXPECTED_ORIGIN], { cwd: args.root, env: { ...process.env, NODE_OPTIONS: '--require=/not-real-file', NODE_PATH: '/not-real' }, stdio: ['pipe', 'pipe', 'pipe'] })
  t.after(() => child.kill())
  const message = new Promise((resolve, reject) => { const decoder = new FrameDecoder({ onError: reject, onMessage: resolve }); child.stdout.on('data', chunk => decoder.push(chunk)); child.on('error', reject) })
  writeFrame(child.stdin, { type: 'hello', id: 'fixture-request', profileId: 'profile' })
  assert.equal((await message).type, 'challenge'); child.stdin.end(); await once(child, 'exit')
  const bad = spawn(host.path, ['chrome-extension://' + 'a'.repeat(32) + '/'], { cwd: args.root }); let stdout = ''; bad.stdout.on('data', b => { stdout += b }); const [code] = await once(bad, 'exit')
  assert.equal(code, 1); assert.equal(stdout, '')
})

test('tampered receipt cannot select outside files; symlinked installed files are never removed', async t => {
  const args = await fixture(t); const prepared = await prepareCompanion(args)
  const original = await readFile(prepared.receiptPath, 'utf8'); const receipt = JSON.parse(original)
  const foreign = join(args.root, 'foreign'); await writeFile(foreign, 'preserve', { mode: 0o600 })
  receipt.files[0] = { path: foreign, mode: 0o600, digest: createHash('sha256').update('preserve').digest('hex') }
  await writeFile(prepared.receiptPath, JSON.stringify(receipt)); await assert.rejects(uninstallCompanion({ receiptPath: prepared.receiptPath }))
  assert.equal(await readFile(foreign, 'utf8'), 'preserve')
  await writeFile(prepared.receiptPath, original); await rm(prepared.runtimeConfigPath); await symlink(foreign, prepared.runtimeConfigPath)
  await assert.rejects(uninstallCompanion({ receiptPath: prepared.receiptPath })); assert.equal(await readFile(foreign, 'utf8'), 'preserve')
})

for (const scenario of ['package-write', 'receipt-write', 'package-sync', 'receipt-sync', 'replacement']) {
  test(`failed prepare rolls back owned creations after ${scenario}`, async t => {
    const args = await fixture(t)
    const target = join(args.destination, scenario.startsWith('receipt') ? 'receipt.json' : 'extensions/account-browser/background.js')
    const originalOpen = fsPromises.open; let injected = false
    fsPromises.open = async (...values) => {
      const handle = await originalOpen(...values)
      if (values[0] === target && (values[1] & constants.O_EXCL)) {
        injected = true
        if (scenario.endsWith('sync')) handle.sync = async () => { throw Object.assign(new Error('Injected sync failure'), { code: 'EIO' }) }
        else {
          const actualWrite = handle.writeFile.bind(handle)
          handle.writeFile = async () => {
            await actualWrite('partial bytes')
            if (scenario === 'replacement') { await rm(target); await writeFile(target, 'foreign replacement', { mode: 0o600 }) }
            throw Object.assign(new Error('Injected disk failure'), { code: 'ENOSPC' })
          }
        }
      }
      return handle
    }
    syncBuiltinESMExports()
    try { await assert.rejects(prepareCompanion(args), { code: scenario.endsWith('sync') ? 'EIO' : 'ENOSPC' }) }
    finally { fsPromises.open = originalOpen; syncBuiltinESMExports() }
    assert.equal(injected, true)
    await assert.rejects(lstat(args.hostManifestDir), { code: 'ENOENT' })
    if (scenario === 'replacement') {
      assert.equal(await readFile(target, 'utf8'), 'foreign replacement')
      await assert.rejects(lstat(join(args.destination, 'extensions/account-browser/manifest.json')), { code: 'ENOENT' })
    } else {
      await assert.rejects(lstat(args.destination), { code: 'ENOENT' })
      const retry = await prepareCompanion(args)
      await uninstallCompanion({ receiptPath: retry.receiptPath })
    }
  })
}

test('missing explicit-root parent is refused before creating unrecordable ancestors', async t => {
  const args = await fixture(t); const missing = join(args.root, 'missing')
  await assert.rejects(prepareCompanion({ ...args, destination: join(missing, 'install') }), /parent must already exist/)
  await assert.rejects(lstat(missing), { code: 'ENOENT' })
  await assert.rejects(lstat(args.hostManifestDir), { code: 'ENOENT' })
})
