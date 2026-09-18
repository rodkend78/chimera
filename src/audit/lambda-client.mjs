import { Worker } from 'node:worker_threads'
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda'

const BUFFER_BYTES = 512 * 1024
const DEFAULT_TIMEOUT_MS = 15_000

function invalid(code) {
  return Object.assign(new Error(code), { code })
}

function bounded(value, maximum = 256) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function parsePayload(payload) {
  let parsed
  try {
    parsed = JSON.parse(Buffer.from(payload ?? []).toString('utf8'))
  } catch {
    throw invalid('AUDIT_WRITER_RESPONSE_INVALID')
  }
  if (parsed?.error) throw invalid(bounded(parsed.error.code, 128) ? parsed.error.code : 'AUDIT_WRITER_FAILED')
  return parsed
}

async function invokeLambda({ functionName, region }, request) {
  const client = new LambdaClient({ region })
  try {
    const response = await client.send(new InvokeCommand({
      FunctionName: functionName,
      InvocationType: 'RequestResponse',
      Payload: Buffer.from(JSON.stringify(request)),
    }))
    if (response.FunctionError) throw invalid('AUDIT_WRITER_FUNCTION_ERROR')
    return parsePayload(response.Payload)
  } finally {
    client.destroy()
  }
}

export class LambdaAuditClient {
  #closed = false
  #uncertain = false
  #pending = 0
  #tail = Promise.resolve()

  constructor({ functionName, region, worker, control, requestBytes, responseBytes, timeoutMs, snapshotInvoker }) {
    this.functionName = functionName
    this.region = region
    this.worker = worker
    this.control = control
    this.requestBytes = requestBytes
    this.responseBytes = responseBytes
    this.timeoutMs = timeoutMs
    this.snapshotInvoker = snapshotInvoker
  }

  static async open({
    functionName,
    region,
    workerUrl = new URL('./lambda-invoke-worker.mjs', import.meta.url),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    startupTimeoutMs = DEFAULT_TIMEOUT_MS,
    snapshotInvoker,
  } = {}) {
    if (!bounded(functionName) || !bounded(region, 64)
      || !(workerUrl instanceof URL)
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000
      || !Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs < 1 || startupTimeoutMs > 60_000
      || (snapshotInvoker !== undefined && typeof snapshotInvoker !== 'function')) {
      throw new TypeError('LAMBDA_AUDIT_CLIENT_INVALID')
    }
    const controlBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3)
    const requestBuffer = new SharedArrayBuffer(BUFFER_BYTES)
    const responseBuffer = new SharedArrayBuffer(BUFFER_BYTES)
    const control = new Int32Array(controlBuffer)
    const worker = new Worker(workerUrl, {
      workerData: {
        functionName,
        region,
        control: controlBuffer,
        request: requestBuffer,
        response: responseBuffer,
      },
    })
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + startupTimeoutMs
      const inspect = () => {
        if (Atomics.load(control, 0) === 1) return resolve()
        if (Date.now() >= deadline) return reject(invalid('AUDIT_WRITER_START_TIMEOUT'))
        setTimeout(inspect, 2)
      }
      worker.once('error', reject)
      worker.once('exit', (code) => {
        if (Atomics.load(control, 0) !== 1) reject(invalid(code === 0 ? 'AUDIT_WRITER_STOPPED' : 'AUDIT_WRITER_CRASHED'))
      })
      inspect()
    }).catch(async (error) => {
      await worker.terminate()
      throw error
    })
    return new LambdaAuditClient({
      functionName,
      region,
      worker,
      control,
      requestBytes: new Uint8Array(requestBuffer),
      responseBytes: new Uint8Array(responseBuffer),
      timeoutMs,
      snapshotInvoker: snapshotInvoker ?? ((request) => invokeLambda({ functionName, region }, request)),
    })
  }

  async snapshot(streamId) {
    if (this.#closed) throw invalid('AUDIT_WRITER_CLOSED')
    return this.snapshotInvoker({ operation: 'snapshot', streamId })
  }

  appendSync(request) {
    if (this.#pending) throw invalid('AUDIT_WRITER_ASYNC_PENDING')
    this.#dispatch(this.#payload(request))
    return this.#acknowledge(Atomics.wait(this.control, 0, 2, this.timeoutMs))
  }

  async appendAsync(request) {
    // Capture the caller's data before it can change while waiting in the queue.
    const payload = this.#payload(request)
    this.#pending += 1
    const operation = this.#tail.then(async () => {
      this.#dispatch(payload)
      const waiting = Atomics.waitAsync(this.control, 0, 2, this.timeoutMs)
      const result = waiting.async ? await waiting.value : waiting.value
      return this.#acknowledge(result)
    })
    this.#tail = operation.catch(() => {})
    try {
      return await operation
    } finally {
      this.#pending -= 1
    }
  }

  #payload(request) {
    const payload = new TextEncoder().encode(JSON.stringify({ operation: 'append', ...request }))
    if (payload.length > this.requestBytes.length) throw new TypeError('AUDIT_WRITER_REQUEST_TOO_LARGE')
    return payload
  }

  #dispatch(payload) {
    if (this.#closed) throw invalid('AUDIT_WRITER_CLOSED')
    if (this.#uncertain) throw invalid('AUDIT_WRITER_UNCERTAIN')
    if (Atomics.load(this.control, 0) !== 1) throw invalid('AUDIT_WRITER_NOT_READY')
    this.requestBytes.set(payload)
    Atomics.store(this.control, 1, payload.length)
    Atomics.store(this.control, 0, 2)
    Atomics.notify(this.control, 0)
  }

  #acknowledge(wait) {
    if (this.#closed) throw invalid('AUDIT_WRITER_CLOSED')
    const state = Atomics.load(this.control, 0)
    if (wait === 'timed-out' || state === 2) {
      this.#uncertain = true
      Atomics.store(this.control, 0, -1)
      Atomics.notify(this.control, 0)
      void this.worker.terminate()
      throw invalid('AUDIT_WRITER_TIMEOUT')
    }
    const length = Atomics.load(this.control, 2)
    if (!Number.isSafeInteger(length) || length < 1 || length > this.responseBytes.length) {
      this.#uncertain = true
      throw invalid('AUDIT_WRITER_RESPONSE_INVALID')
    }
    let response
    try {
      response = JSON.parse(new TextDecoder().decode(this.responseBytes.subarray(0, length)))
    } catch {
      this.#uncertain = true
      throw invalid('AUDIT_WRITER_RESPONSE_INVALID')
    } finally {
      if (!this.#uncertain) Atomics.store(this.control, 0, 1)
    }
    if (state === 4) {
      this.#uncertain = true
      throw invalid(bounded(response?.code, 128) ? response.code : 'AUDIT_WRITER_FAILED')
    }
    if (state !== 3) {
      this.#uncertain = true
      throw invalid('AUDIT_WRITER_RESPONSE_INVALID')
    }
    return response
  }

  async close() {
    if (this.#closed) return
    this.#closed = true
    Atomics.store(this.control, 0, -1)
    Atomics.notify(this.control, 0)
    await this.worker.terminate()
  }
}
