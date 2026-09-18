import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { sha256 } from '../canonical.mjs'
import { isTrustedModelCallNotSentError } from './model-call-errors.mjs'
import { validateModelRouter } from './model-router.mjs'

export const MODEL_CALL_LEDGER_SCHEMA = 'chimera.model-call-ledger.v1'

function isRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
}

function isBoundedString(value, maximum = 4096) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function failureRecord(error) {
  return {
    message: error instanceof Error ? error.message : String(error),
    code: isBoundedString(error?.code, 256) ? error.code : 'MODEL_PROVIDER_FAILURE',
    dispatchState: isTrustedModelCallNotSentError(error) ? 'not_sent' : 'unknown',
  }
}

function errorFromFailure(failure) {
  const error = new Error(failure?.message ?? 'model provider outcome is unknown')
  error.code = failure?.code ?? 'MODEL_PROVIDER_FAILURE'
  error.dispatchState = failure?.dispatchState ?? 'unknown'
  return error
}

export class ModelCallOutcomeUnknownError extends Error {
  constructor(callId, cause) {
    super(`model call ${callId} may have been dispatched; automatic retry is blocked`, { cause })
    this.name = 'ModelCallOutcomeUnknownError'
    this.code = 'MODEL_CALL_OUTCOME_UNKNOWN'
    this.callId = callId
  }
}

export class DurableModelCallLedger {
  #records = new Map()
  #writeTail = Promise.resolve()

  constructor({ filePath, audit, now = () => Date.now() }) {
    if (!isBoundedString(filePath)) throw new TypeError('model call ledger file path is required')
    this.filePath = filePath
    this.audit = audit
    this.now = now
  }

  static async open(options) {
    const ledger = new DurableModelCallLedger(options)
    await mkdir(dirname(ledger.filePath), { recursive: true, mode: 0o700 })
    try {
      const content = await readFile(ledger.filePath, 'utf8')
      for (const line of content.split('\n')) {
        if (!line.trim()) continue
        ledger.#restore(JSON.parse(line))
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    return ledger
  }

  async lookup(callId) {
    await this.#writeTail
    const record = this.#records.get(callId)
    return record ? structuredClone(record) : null
  }

  async begin({ callId, requestHash, providerRouterId, scopeId }) {
    return this.#write(async () => {
      if (!isBoundedString(callId, 256)
        || !isBoundedString(requestHash, 128)
        || !isBoundedString(providerRouterId, 256)
        || !isBoundedString(scopeId, 256)) {
        throw new TypeError('invalid model call identity')
      }
      const prior = this.#records.get(callId)
      if (prior?.status === 'succeeded') return structuredClone(prior)
      if (prior?.status === 'started' || prior?.status === 'ambiguous') {
        throw new ModelCallOutcomeUnknownError(callId, errorFromFailure(prior.failure))
      }
      if (prior && (prior.requestHash !== requestHash || prior.scopeId !== scopeId)) {
        throw new Error('MODEL_CALL_ID_COLLISION')
      }

      const at = new Date(this.now()).toISOString()
      const record = {
        callId,
        requestHash,
        providerRouterId,
        scopeId,
        attempt: (prior?.attempt ?? 0) + 1,
        status: 'started',
        startedAt: at,
      }
      await this.#append({ event: 'started', at, record })
      this.#records.set(callId, record)
      this.audit?.append({
        kind: 'model.call.started',
        callId,
        requestHash,
        providerRouterId,
        scopeId,
        attempt: record.attempt,
        at,
      })
      return structuredClone(record)
    })
  }

  async succeed(callId, result) {
    return this.#write(async () => {
      const current = this.#requiredStarted(callId)
      const at = new Date(this.now()).toISOString()
      const durableResult = structuredClone(result)
      const resultHash = sha256(durableResult)
      const record = { ...current, status: 'succeeded', completedAt: at, result: durableResult }
      await this.#append({ event: 'succeeded', at, callId, result: record.result })
      this.#records.set(callId, record)
      this.audit?.append({
        kind: 'model.call.succeeded',
        callId,
        requestHash: record.requestHash,
        providerRouterId: record.providerRouterId,
        scopeId: record.scopeId,
        attempt: record.attempt,
        resultHash,
        at,
      })
      return structuredClone(record.result)
    })
  }

  async fail(callId, error) {
    return this.#write(async () => {
      const current = this.#requiredStarted(callId)
      const failure = failureRecord(error)
      const at = new Date(this.now()).toISOString()
      const status = failure.dispatchState === 'not_sent' ? 'failed-not-sent' : 'ambiguous'
      const record = { ...current, status, failedAt: at, failure }
      await this.#append({ event: status, at, callId, failure })
      this.#records.set(callId, record)
      this.audit?.append({
        kind: status === 'ambiguous' ? 'model.call.ambiguous' : 'model.call.not-sent',
        callId,
        requestHash: record.requestHash,
        providerRouterId: record.providerRouterId,
        scopeId: record.scopeId,
        attempt: record.attempt,
        failure,
        at,
      })
      return structuredClone(record)
    })
  }

  #requiredStarted(callId) {
    const current = this.#records.get(callId)
    if (current?.status !== 'started') throw new Error('MODEL_CALL_NOT_STARTED')
    return current
  }

  #write(operation) {
    const result = this.#writeTail.then(operation)
    this.#writeTail = result.then(() => undefined, () => undefined)
    return result
  }

  async #append(event) {
    await appendFile(
      this.filePath,
      `${JSON.stringify({ schema: MODEL_CALL_LEDGER_SCHEMA, ...event })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    )
  }

  #restore(event) {
    if (!isRecord(event) || event.schema !== MODEL_CALL_LEDGER_SCHEMA || !isBoundedString(event.event, 64)) {
      throw new TypeError('invalid model call ledger event')
    }
    if (event.event === 'started') {
      const record = event.record
      if (!isRecord(record)
        || !isBoundedString(record.callId, 256)
        || !isBoundedString(record.requestHash, 128)
        || !isBoundedString(record.providerRouterId, 256)
        || !isBoundedString(record.scopeId, 256)
        || !Number.isSafeInteger(record.attempt)
        || record.attempt < 1) {
        throw new TypeError('invalid model call start event')
      }
      const prior = this.#records.get(record.callId)
      if (prior && prior.status !== 'failed-not-sent') {
        throw new TypeError('model call start does not follow a retryable failure')
      }
      this.#records.set(record.callId, structuredClone(record))
      return
    }
    const current = this.#records.get(event.callId)
    if (current?.status !== 'started') throw new TypeError('model call terminal event precedes start')
    if (event.event === 'succeeded') {
      this.#records.set(event.callId, {
        ...current,
        status: 'succeeded',
        completedAt: event.at,
        result: structuredClone(event.result),
      })
      return
    }
    if (event.event === 'failed-not-sent' || event.event === 'ambiguous') {
      if (!isRecord(event.failure) || !isBoundedString(event.failure.message)) {
        throw new TypeError('invalid model call failure event')
      }
      this.#records.set(event.callId, {
        ...current,
        status: event.event,
        failedAt: event.at,
        failure: structuredClone(event.failure),
      })
      return
    }
    throw new TypeError('unknown model call ledger event')
  }
}

export function createReliableModelRouter({
  provider,
  ledger,
  audit,
  now = () => Date.now(),
}) {
  const routed = validateModelRouter(provider)
  if (!ledger || typeof ledger.lookup !== 'function' || typeof ledger.begin !== 'function') {
    throw new TypeError('reliable model router requires a durable ledger')
  }
  const scopeId = routed.authorizationScope
  if (!isBoundedString(scopeId, 256) || typeof routed.authorize !== 'function') {
    throw new TypeError('reliable model router requires an authorizing gateway model router')
  }
  const inFlight = new Map()

  async function execute(callId, requestHash, prompt, context) {
    const authorized = await routed.authorize(prompt, structuredClone(context))
    if (!authorized
      || authorized.authorizationScope !== scopeId
      || authorized.requestHash !== requestHash
      || typeof authorized.dispatch !== 'function') {
      throw new TypeError('invalid model call authorization')
    }
    const prior = await ledger.lookup(callId)
    if (prior && (prior.requestHash !== requestHash || prior.scopeId !== scopeId)) {
      throw new Error('MODEL_CALL_ID_COLLISION')
    }
    if (prior?.status === 'succeeded') {
      audit?.append({
        kind: 'model.call.replayed',
        callId,
        requestHash,
        providerRouterId: routed.routerId,
        scopeId,
        at: new Date(now()).toISOString(),
      })
      return structuredClone(prior.result)
    }
    if (prior?.status === 'started' || prior?.status === 'ambiguous') {
      throw new ModelCallOutcomeUnknownError(callId, errorFromFailure(prior.failure))
    }

    await ledger.begin({ callId, requestHash, providerRouterId: routed.routerId, scopeId })
    try {
      const result = await authorized.dispatch()
      return await ledger.succeed(callId, result)
    } catch (error) {
      const failure = await ledger.fail(callId, error)
      if (failure.status === 'failed-not-sent') throw error
      throw new ModelCallOutcomeUnknownError(callId, error)
    }
  }

  return validateModelRouter(Object.freeze({
    routerId: `reliable:${routed.routerId}`,
    authorizationScope: scopeId,
    route(prompt, context = {}) {
      const requestHash = sha256({ prompt, context })
      const callId = `model-${sha256({
        providerRouterId: routed.routerId,
        requestHash,
        scopeId,
      }).slice(0, 32)}`
      const active = inFlight.get(callId)
      if (active) return active
      const operation = execute(callId, requestHash, prompt, context)
        .finally(() => inFlight.delete(callId))
      inFlight.set(callId, operation)
      return operation
    },
  }))
}
