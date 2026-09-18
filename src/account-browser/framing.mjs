import { endianness } from 'node:os'
import { MAX_MESSAGE_BYTES, record } from './protocol.mjs'
const little = endianness() === 'LE'
export function encodeFrame(value) {
  if (!record(value)) throw new Error('Frame must be a record')
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  if (body.length === 0 || body.length > MAX_MESSAGE_BYTES) throw new Error('Frame size exceeded')
  const header = Buffer.alloc(4)
  if (little) header.writeUInt32LE(body.length); else header.writeUInt32BE(body.length)
  return Buffer.concat([header, body])
}

export class FrameDecoder {
  #onMessage; #onError; #header = Buffer.alloc(4); #headerUsed = 0; #body = null; #bodyUsed = 0; #failed = false; #ended = false
  constructor({ onMessage, onError }) { this.#onMessage = onMessage; this.#onError = onError }
  #fail() { if (!this.#failed) { this.#failed = true; this.#body = null; this.#onError(new Error('Invalid native frame')) } }
  push(chunk) {
    if (this.#failed || this.#ended) return
    if (!(chunk instanceof Uint8Array)) { this.#fail(); return }
    let offset = 0
    while (offset < chunk.length && !this.#failed) {
      if (!this.#body) {
        const count = Math.min(4 - this.#headerUsed, chunk.length - offset)
        this.#header.set(chunk.subarray(offset, offset + count), this.#headerUsed); offset += count; this.#headerUsed += count
        if (this.#headerUsed < 4) continue
        const length = little ? this.#header.readUInt32LE() : this.#header.readUInt32BE()
        if (length === 0 || length > MAX_MESSAGE_BYTES) { this.#fail(); return }
        this.#body = Buffer.alloc(length); this.#bodyUsed = 0
      }
      const count = Math.min(this.#body.length - this.#bodyUsed, chunk.length - offset)
      this.#body.set(chunk.subarray(offset, offset + count), this.#bodyUsed); offset += count; this.#bodyUsed += count
      if (this.#bodyUsed === this.#body.length) {
        let value
        try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(this.#body)); if (!record(value)) throw new Error() } catch { this.#fail(); return }
        this.#body = null; this.#headerUsed = 0; this.#bodyUsed = 0
        try { this.#onMessage(value) } catch { this.#fail(); return }
      }
    }
  }
  end() { if (this.#headerUsed || this.#body) this.#fail(); this.#ended = true }
}

// A blocked destination may buffer at most one application frame.
export function writeFrame(stream, value) {
  const frame = encodeFrame(value)
  if (stream.destroyed || stream.writableEnded || stream.writableLength + frame.length > MAX_MESSAGE_BYTES + 4) throw new Error('Transport backpressure limit')
  stream.write(frame)
}
