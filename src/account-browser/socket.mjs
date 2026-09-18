import { createServer } from 'node:net'
import { lstat, realpath, chmod, unlink, mkdtemp, link, rmdir } from 'node:fs/promises'
import { dirname, resolve, isAbsolute, join } from 'node:path'
import { FrameDecoder, writeFrame } from './framing.mjs'
import { extensionOrigin, MAX_MESSAGE_BYTES } from './protocol.mjs'

export async function validateSocketPath(socketPath, { existing = false } = {}) {
  // sockaddr_un.sun_path is 104 bytes on macOS, including its terminating NUL.
  if (typeof socketPath !== 'string' || !isAbsolute(socketPath) || socketPath.includes('\0') || Buffer.byteLength(socketPath) > (process.platform === 'darwin' ? 103 : 107)) throw new Error('Invalid Unix socket path')
  const directory = dirname(socketPath)
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) || await realpath(directory) !== resolve(directory)) throw new Error('Unsafe socket directory')
  let socketInfo
  try { socketInfo = await lstat(socketPath) } catch (e) { if (e.code !== 'ENOENT') throw e }
  if (existing) {
    if (!socketInfo?.isSocket() || socketInfo.isSymbolicLink() || socketInfo.uid !== process.getuid() || (socketInfo.mode & 0o077)) throw new Error('Unsafe socket')
  } else if (socketInfo) throw new Error('Socket path already exists')
}

export async function startCompanionSocket({ socketPath, broker }) {
  await validateSocketPath(socketPath)
  const stagingDir = await mkdtemp(join(dirname(socketPath), '.ac-'))
  const bindPath = join(stagingDir, 's')
  try { await validateSocketPath(bindPath) } catch (e) { await rmdir(stagingDir); throw e }
  const clients = new Set(); let identity; let closing
  const server = createServer(socket => {
    if (clients.size >= 32) { socket.destroy(); return }
    clients.add(socket)
    let peer; let terminated = false; let pending = 0; let queuedBytes = 0
    const timer = setTimeout(() => stop(), 120000); timer.unref()
    const stop = () => {
      if (terminated) return
      terminated = true; clearTimeout(timer); clients.delete(socket)
      // disconnect fences synchronously, although durable metadata cleanup is async.
      peer?.disconnect().catch(() => {}); socket.destroy()
    }
    const send = value => { try { writeFrame(socket, value) } catch (e) { stop(); throw e } }
    const decoder = new FrameDecoder({ onError: stop, onMessage: message => {
      if (terminated) return
      if (!peer) {
        // Native bridge prelude, NOT an application pairing request. Origin is
        // checked by broker.connect; it does not defeat same-user compromise.
        if (Object.keys(message).sort().join(',') !== 'origin,type' || message.type !== 'connect' || !extensionOrigin(message.origin)) { stop(); return }
        try { peer = broker.connect({ origin: message.origin, send }) } catch { stop() }
        return
      }
      const bytes = Buffer.byteLength(JSON.stringify(message))
      if (++pending > 32 || (queuedBytes += bytes) > MAX_MESSAGE_BYTES) { stop(); return }
      // Do not serialize behind result receipt: invalidation must overtake I/O.
      Promise.resolve(peer.receive(message)).then(reply => {
        if (terminated) return
        if (reply?.type === 'paired') clearTimeout(timer)
        if (reply !== undefined) send(reply)
      }).catch(stop).finally(() => { pending--; queuedBytes -= bytes })
    } })
    socket.on('data', chunk => decoder.push(chunk))
    socket.on('end', () => { decoder.end(); stop() })
    socket.on('error', stop); socket.on('close', stop)
  })
  try {
    await new Promise((yes, no) => { server.once('error', no); server.listen(bindPath, () => { server.removeListener('error', no); yes() }) })
    await chmod(bindPath, 0o600)
    identity = await lstat(bindPath)
    // Hard-link publication is atomic and refuses ANY existing destination.
    // libuv retains only the private bind path, never the advertised pathname.
    await link(bindPath, socketPath)
    await unlink(bindPath)
  } catch (e) { await new Promise(resolve => server.close(resolve)); await rmdir(stagingDir); throw e }
  server.on('error', () => { for (const client of clients) client.destroy() })
  return { close() {
    if (!closing) closing = (async () => {
      // libuv unlinks only the now-absent private bind path on close.
      for (const client of clients) client.destroy()
      await new Promise(resolve => server.close(resolve))
      try {
        const remaining = await lstat(socketPath)
        if (remaining.isSocket() && remaining.dev === identity.dev && remaining.ino === identity.ino) await unlink(socketPath)
      } catch (e) { if (e.code !== 'ENOENT') throw e }
      await rmdir(stagingDir)
    })()
    return closing
  } }
}
