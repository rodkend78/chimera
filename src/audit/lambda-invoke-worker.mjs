import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda'
import { workerData } from 'node:worker_threads'

const control = new Int32Array(workerData.control)
const requestBytes = new Uint8Array(workerData.request)
const responseBytes = new Uint8Array(workerData.response)
const decoder = new TextDecoder()
const encoder = new TextEncoder()
const client = new LambdaClient({ region: workerData.region })

function respond(state, value) {
  const response = encoder.encode(JSON.stringify(value))
  if (response.length > responseBytes.length) {
    return respond(4, { code: 'AUDIT_WRITER_RESPONSE_TOO_LARGE' })
  }
  responseBytes.set(response)
  Atomics.store(control, 2, response.length)
  Atomics.store(control, 0, state)
  Atomics.notify(control, 0)
}

Atomics.store(control, 0, 1)
Atomics.notify(control, 0)

try {
  while (true) {
    Atomics.wait(control, 0, 1)
    const state = Atomics.load(control, 0)
    if (state === -1) break
    if (state !== 2) continue
    try {
      const request = JSON.parse(decoder.decode(requestBytes.subarray(0, Atomics.load(control, 1))))
      const result = await client.send(new InvokeCommand({
        FunctionName: workerData.functionName,
        InvocationType: 'RequestResponse',
        Payload: Buffer.from(JSON.stringify(request)),
      }))
      if (result.FunctionError) {
        respond(4, { code: 'AUDIT_WRITER_FUNCTION_ERROR' })
        continue
      }
      let response
      try {
        response = JSON.parse(Buffer.from(result.Payload ?? []).toString('utf8'))
      } catch {
        respond(4, { code: 'AUDIT_WRITER_RESPONSE_INVALID' })
        continue
      }
      if (response?.error) {
        respond(4, { code: typeof response.error.code === 'string' ? response.error.code : 'AUDIT_WRITER_FAILED' })
        continue
      }
      respond(3, response)
    } catch (error) {
      respond(4, { code: typeof error?.code === 'string' ? error.code : 'AUDIT_WRITER_UNAVAILABLE' })
    }
  }
} finally {
  client.destroy()
}
