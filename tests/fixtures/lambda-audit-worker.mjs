import { workerData } from 'node:worker_threads'
import { sha256 } from '../../src/canonical.mjs'

const control = new Int32Array(workerData.control)
const requestBytes = new Uint8Array(workerData.request)
const responseBytes = new Uint8Array(workerData.response)
const decoder = new TextDecoder()
const encoder = new TextEncoder()

const startupDelayMs = Number.parseInt(new URL(import.meta.url).searchParams.get('startupDelayMs') ?? '0', 10)
if (Number.isSafeInteger(startupDelayMs) && startupDelayMs > 0 && startupDelayMs <= 1_000) {
  await new Promise((resolve) => setTimeout(resolve, startupDelayMs))
}

Atomics.store(control, 0, 1)
Atomics.notify(control, 0)

while (true) {
  Atomics.wait(control, 0, 1)
  const state = Atomics.load(control, 0)
  if (state === -1) break
  if (state !== 2) continue
  const request = JSON.parse(decoder.decode(requestBytes.subarray(0, Atomics.load(control, 1))))
  if (request.fact?.kind === 'fixture.stall') {
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  const unsigned = {
    seq: request.expected.nextSeq,
    prevHash: request.expected.headHash,
    fact: request.fact,
  }
  const response = encoder.encode(JSON.stringify({
    ...unsigned,
    entryHash: sha256(unsigned),
  }))
  responseBytes.set(response)
  Atomics.store(control, 2, response.length)
  Atomics.store(control, 0, 3)
  Atomics.notify(control, 0)
}
