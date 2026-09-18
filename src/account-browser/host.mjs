import { connect } from 'node:net'
import { FrameDecoder, writeFrame } from './framing.mjs'
import { extensionOrigin } from './protocol.mjs'
import { validateSocketPath } from './socket.mjs'

// Origin is defense in depth; a compromised process with the same OS user can
// impersonate the bridge. Pair approval remains a separate broker boundary.
export async function runNativeHost({ input, output, socketPath, origin, allowedOrigin }) {
  if (!extensionOrigin(allowedOrigin) || origin !== allowedOrigin) throw new Error('Native host origin denied')
  await validateSocketPath(socketPath, { existing: true })
  const socket = connect(socketPath)
  await new Promise((yes, no) => { socket.once('connect', yes); socket.once('error', no) })
  let closed = false
  const close = () => {
    if (closed) return
    closed = true; clearTimeout(timer); input.removeListener('data', onInput); input.pause(); socket.destroy()
  }
  const timer = setTimeout(close, 120000); timer.unref()
  const outgoing = new FrameDecoder({ onError: close, onMessage: message => {
    if (!closed) { try { writeFrame(socket, message) } catch { close() } }
  } })
  const incoming = new FrameDecoder({ onError: close, onMessage: message => {
    if (!closed) { try { if (message.type === 'paired') clearTimeout(timer); writeFrame(output, message) } catch { close() } }
  } })
  const onInput = chunk => outgoing.push(chunk)
  input.on('data', onInput)
  input.on('end', () => { outgoing.end(); close() })
  input.on('error', close); output.on('error', close)
  socket.on('data', chunk => incoming.push(chunk))
  socket.on('end', () => { incoming.end(); close() })
  socket.on('error', close); socket.on('close', close)
  writeFrame(socket, { type: 'connect', origin })
  return { close }
}
