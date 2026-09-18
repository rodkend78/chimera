import { lstat, realpath, mkdir, readFile, open, unlink, rmdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { resolve, dirname, join, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { EXPECTED_ORIGIN, EXPECTED_EXTENSION_ID, HOST_NAME } from './identity.mjs'
export { EXPECTED_ORIGIN, EXPECTED_EXTENSION_ID }

const sourceRoot = fileURLToPath(new URL('../../', import.meta.url))
const packageFiles = ['extensions/account-browser/manifest.json', 'extensions/account-browser/background.js', 'extensions/account-browser/document.js', 'extensions/account-browser/popup.html', 'extensions/account-browser/popup.js', 'extensions/account-browser/popup.css', 'src/account-browser/host.mjs', 'src/account-browser/socket.mjs', 'src/account-browser/framing.mjs', 'src/account-browser/protocol.mjs', 'src/account-browser/identity.mjs', 'scripts/account-browser/native-host.mjs']
const hash = data => createHash('sha256').update(data).digest('hex')
const json = value => JSON.stringify(value, null, 2) + '\n'
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
function absolute(path) { if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') || path.includes('\n') || path.includes('\r') || resolve(path) !== path) throw new Error('Explicit canonical absolute path required'); return path }
async function exists(path) { try { return await lstat(path) } catch (e) { if (e.code === 'ENOENT') return null; throw e } }
async function ancestors(path) {
  let current = path
  while (true) { const info = await exists(current); if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error('Unsafe directory'); const parent = dirname(current); if (parent === current) break; current = parent }
}
async function privateDirectory(path, created) {
  await ancestors(path)
  const info = await exists(path)
  if (info) { if (info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error('Directory must be owner-only'); return }
  const parent = dirname(path)
  if (!(await exists(parent))) await privateDirectory(parent, created)
  await mkdir(path, { mode: 0o700 }); created.push(path)
}
async function checkedFile(path, mode) {
  await ancestors(dirname(path))
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { const stat = await file.stat(); if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== mode || stat.nlink !== 1 || stat.size > 1024 * 1024) throw new Error('Unsafe installed file'); return { data: await file.readFile(), stat } } finally { await file.close() }
}
function resultFor(destination, hostManifestDir) { return { runtimeConfigPath: join(destination, 'runtime.json'), receiptPath: join(destination, 'receipt.json'), extensionPath: join(destination, 'extensions/account-browser'), hostManifestPath: join(hostManifestDir, HOST_NAME + '.json'), allowedOrigin: EXPECTED_ORIGIN } }
async function receiptAt(receiptPath) {
  absolute(receiptPath)
  const { data } = await checkedFile(receiptPath, 0o600); const receipt = JSON.parse(data)
  if (receipt.schema !== 1 || receipt.uid !== process.getuid() || receipt.destination !== dirname(receiptPath) || receiptPath !== join(receipt.destination, 'receipt.json') || !Array.isArray(receipt.files) || !Array.isArray(receipt.directories)) throw new Error('Invalid receipt')
  absolute(receipt.destination); absolute(receipt.hostManifestDir)
  const allowed = new Set([...packageFiles.map(p => join(receipt.destination, p)), join(receipt.destination, 'runtime.json'), join(receipt.destination, 'native-host'), join(receipt.hostManifestDir, HOST_NAME + '.json')])
  if (receipt.files.length !== allowed.size) throw new Error('Invalid receipt files')
  for (const file of receipt.files) {
    if (!allowed.delete(file.path) || file.mode !== (file.path === join(receipt.destination, 'native-host') ? 0o700 : 0o600) || !/^[a-f0-9]{64}$/.test(file.digest)) throw new Error('Invalid receipt entry')
    const actual = await checkedFile(file.path, file.mode); if (hash(actual.data) !== file.digest) throw new Error('Installed file changed; refusing removal or overwrite')
  }
  for (const directory of receipt.directories) {
    absolute(directory)
    if (!(directory === receipt.destination || directory.startsWith(receipt.destination + '/') || directory === receipt.hostManifestDir)) throw new Error('Invalid receipt directory')
    const stat = await lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) throw new Error('Unsafe installed directory')
  }
  return receipt
}
export async function prepareCompanion({ destination, hostManifestDir, nodePath, socketPath }) {
  for (const path of [destination, hostManifestDir, nodePath, socketPath]) absolute(path)
  if (destination === hostManifestDir || hostManifestDir.startsWith(destination + '/') || destination.startsWith(hostManifestDir + '/')) throw new Error('Separate installation and manifest directories required')
  await ancestors(destination); await ancestors(hostManifestDir)
  // Only create the two explicit roots and their package descendants. Ancestors
  // outside these roots must already exist so the receipt cannot claim them.
  for (const root of [destination, hostManifestDir]) if (!(await exists(dirname(root)))) throw new Error('Explicit root parent must already exist')
  nodePath = await realpath(nodePath)
  const nodeInfo = await lstat(nodePath); if (!nodeInfo.isFile() || !(nodeInfo.mode & 0o111)) throw new Error('Node executable required')
  if (Buffer.byteLength(socketPath) > 103) throw new Error('Socket path too long for macOS')
  const result = resultFor(destination, hostManifestDir)
  if (await exists(result.receiptPath)) {
    const receipt = await receiptAt(result.receiptPath)
    if (receipt.hostManifestDir !== hostManifestDir || receipt.nodePath !== nodePath || receipt.socketPath !== socketPath) throw new Error('Existing installation options differ')
    return result
  }
  const config = { schema: 1, allowedOrigin: EXPECTED_ORIGIN, socketPath, extensionPath: result.extensionPath, hostManifestPath: result.hostManifestPath, receiptPath: result.receiptPath, installationId: randomUUID() }
  const content = new Map(await Promise.all(packageFiles.map(async path => [join(destination, path), await readFile(join(sourceRoot, path))])))
  content.set(result.runtimeConfigPath, Buffer.from(json(config)))
  content.set(join(destination, 'native-host'), Buffer.from(`#!/bin/sh\nunset NODE_OPTIONS NODE_PATH\nexec ${quote(nodePath)} ${quote(join(destination, 'scripts/account-browser/native-host.mjs'))} "$@"\n`))
  content.set(result.hostManifestPath, Buffer.from(json({ name: HOST_NAME, description: 'Chimera selected-document read-only companion', path: join(destination, 'native-host'), type: 'stdio', allowed_origins: [EXPECTED_ORIGIN] })))
  for (const path of content.keys()) { await ancestors(dirname(path)); if (await exists(path)) throw new Error('Foreign existing file; refusing overwrite') }
  const directories = []; const written = []; const creations = []
  async function writeOwned(path, data, mode) {
    const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode)
    const creation = { path, identity: null }; creations.push(creation)
    try {
      creation.identity = await file.stat()
      await file.writeFile(data); await file.sync()
    } finally { await file.close() }
  }
  try {
    await privateDirectory(destination, directories); await privateDirectory(hostManifestDir, directories)
    for (const [path, data] of content) {
      await privateDirectory(dirname(path), directories)
      const mode = path === join(destination, 'native-host') ? 0o700 : 0o600
      await writeOwned(path, data, mode)
      written.push({ path, digest: hash(data), mode })
    }
    const receipt = { schema: 1, uid: process.getuid(), destination, hostManifestDir, nodePath, socketPath, files: written, directories }
    await writeOwned(result.receiptPath, json(receipt), 0o600)
    return result
  } catch (error) {
    // An interrupted write has no complete digest. Its exclusively created
    // inode is still ours; preserve any foreign file substituted at that path.
    // Receipt creation participates in the same rollback as package files.
    for (const creation of creations.reverse()) {
      try {
        await ancestors(dirname(creation.path))
        const current = await lstat(creation.path); const owned = creation.identity
        if (owned && current.isFile() && !current.isSymbolicLink() && current.uid === process.getuid() && current.nlink === 1 && current.dev === owned.dev && current.ino === owned.ino) await unlink(creation.path)
      } catch {}
    }
    for (const directory of directories.reverse()) { try { await rmdir(directory) } catch {} }
    throw error
  }
}
export async function uninstallCompanion({ receiptPath }) {
  const receipt = await receiptAt(receiptPath)
  for (const file of receipt.files) { const actual = await checkedFile(file.path, file.mode); if (hash(actual.data) !== file.digest) throw new Error('Installed file changed'); await unlink(file.path) }
  await unlink(receiptPath)
  for (const directory of [...receipt.directories].reverse()) { try { await rmdir(directory) } catch (e) { if (!['ENOTEMPTY', 'EEXIST'].includes(e.code)) throw e } }
  return { status: 'uninstalled' }
}
