import { projectConnection, CONNECTION_OPERATIONS, PROVIDER_PATTERN } from './state.mjs'
import { sha256 } from '../canonical.mjs'

const OPERATION_SET = new Set(CONNECTION_OPERATIONS)
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,511}$/
const UNKNOWN_CODES = new Set([
  'CONNECTION_RESPONSE_LOST',
  'RESPONSE_LOST_AFTER_COMMIT',
  'CONNECTION_OPERATION_UNKNOWN',
  'MODEL_CALL_OUTCOME_UNKNOWN',
])
const ACTION_FIELDS = new Set(['providerId', 'operation', 'model', 'requestId', 'expectedRevision', 'allowQuotaUse'])

function serviceError(code, message = code) {
  const error = new Error(message)
  error.code = code
  return error
}

function providerIdOf(value) {
  if (typeof value !== 'string' || !PROVIDER_PATTERN.test(value)) throw serviceError('CONNECTION_PROVIDER_INVALID')
  return value
}

function requestIdOf(value) {
  if (typeof value !== 'string' || !REQUEST_ID.test(value)) throw serviceError('CONNECTION_REQUEST_ID_INVALID')
  return value
}

function modelOf(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !MODEL_ID.test(value)) throw serviceError('CONNECTION_MODEL_INVALID')
  return value
}

function clone(value) {
  return structuredClone(value)
}

function fingerprint({ providerId, operation, model, allowQuotaUse, expectedRevision }) {
  return JSON.stringify({ providerId, operation, model, allowQuotaUse: allowQuotaUse === true, expectedRevision })
}

function actionOf(adapter, operation) {
  const action = adapter.operations?.[operation]
  if (typeof action !== 'function') throw serviceError('CONNECTION_OPERATION_UNSUPPORTED')
  return action
}

function safeReceiptResult(result = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return {}
  return {
    ...(result.costClass === 'free' || result.costClass === 'quota' || result.costClass === 'unknown' ? { costClass: result.costClass } : {}),
    ...(typeof result.modelCallSent === 'boolean' ? { modelCallSent: result.modelCallSent } : {}),
  }
}

function isModelDeclared(raw, model) {
  const catalog = Array.isArray(raw?.models) ? raw.models : []
  const ids = catalog.map(item => typeof item === 'string' ? item : item?.id).filter(id => typeof id === 'string')
  const selected = raw?.selectedModel ?? raw?.model
  if (typeof selected === 'string' && selected !== model) throw serviceError('CONNECTION_MODEL_MISMATCH')
  if (ids.length && !ids.includes(model)) throw serviceError('CONNECTION_MODEL_MISMATCH')
  if (!selected && !ids.length && raw?.modelIdentityRequired !== false) {
    throw serviceError('CONNECTION_MODEL_IDENTITY_UNAVAILABLE')
  }
}

/**
 * The connection service is deliberately adapter-driven. A provider can only
 * appear when the server supplies an entry in this fixed registry; no provider
 * names or operations are inferred from arbitrary state returned by a CLI.
 */
export class ConnectionService {
  #policy
  #adapters
  #machineRef
  #now
  #overrides = new Map()
  #requests = new Map()
  #receipts = new Map()
  #receiptStore

  constructor({ policy, adapters, machineRef, now = () => new Date().toISOString(), receiptStore = null } = {}) {
    if (!policy || typeof policy.get !== 'function' || typeof policy.setEnabled !== 'function') throw new TypeError('ConnectionService requires a durable policy')
    if (!adapters || typeof adapters !== 'object' || Array.isArray(adapters)) throw new TypeError('ConnectionService requires a fixed adapter registry')
    if (typeof machineRef !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(machineRef)) throw serviceError('CONNECTION_MACHINE_INVALID')
    this.#policy = policy
    this.#adapters = new Map(Object.entries(adapters).map(([providerId, adapter]) => {
      providerIdOf(providerId)
      if (!adapter || typeof adapter !== 'object' || typeof adapter.state !== 'function') throw new TypeError(`Connection adapter ${providerId} requires state()`)
      return [providerId, adapter]
    }))
    this.#machineRef = machineRef
    this.#now = now
    if (receiptStore !== null && (typeof receiptStore.getRequest !== 'function' || typeof receiptStore.record !== 'function')) throw new TypeError('ConnectionService requires a durable receipt store')
    this.#receiptStore = receiptStore
  }

  list() {
    return [...this.#adapters.keys()].map(providerId => this.#project(providerId))
  }

  state(providerId) {
    providerId = providerIdOf(providerId)
    if (!this.#adapters.has(providerId)) throw serviceError('CONNECTION_PROVIDER_UNSUPPORTED')
    return this.#project(providerId)
  }

  /**
   * Return a dispatch wrapper that rechecks the durable binding immediately
   * before invoking the captured provider operation. Existing in-flight work
   * is not cancelled, but its next provider call is fenced after disconnect.
   */
  guard(providerId, dispatch) {
    providerId = providerIdOf(providerId)
    if (typeof dispatch !== 'function') throw new TypeError('Connection guard requires a dispatch function')
    return async (...args) => {
      this.#policy.assertEnabled(providerId)
      return dispatch(...args)
    }
  }

  async act(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !ACTION_FIELDS.has(key))) throw serviceError('CONNECTION_ACTION_INVALID')
    const providerId = providerIdOf(input.providerId)
    const operation = input.operation
    if (typeof operation !== 'string' || !OPERATION_SET.has(operation)) throw serviceError('CONNECTION_OPERATION_INVALID')
    const requestId = requestIdOf(input.requestId)
    const model = modelOf(input.model)
    if (input.expectedRevision !== undefined && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)) throw serviceError('CONNECTION_REVISION_INVALID')
    if (input.allowQuotaUse !== undefined && typeof input.allowQuotaUse !== 'boolean') throw serviceError('CONNECTION_QUOTA_CONFIRMATION_INVALID')
    if (!this.#adapters.has(providerId)) throw serviceError('CONNECTION_PROVIDER_UNSUPPORTED')
    const request = { providerId, operation, model, requestId, expectedRevision: input.expectedRevision, allowQuotaUse: input.allowQuotaUse === true }
    const key = `${providerId}:${requestId}`
    const signature = fingerprint(request)
    const previous = this.#receipts.get(key)
    if (previous) {
      if (previous.signature !== signature) throw serviceError('CONNECTION_REQUEST_CONFLICT')
      if (previous.receipt.status === 'unknown') throw Object.assign(serviceError('CONNECTION_OPERATION_UNKNOWN'), { receipt: clone(previous.receipt) })
      return Promise.resolve(clone(previous.result))
    }
    const pending = this.#requests.get(key)
    if (pending) {
      if (pending.signature !== signature) throw serviceError('CONNECTION_REQUEST_CONFLICT')
      return pending.promise.then(clone, error => { throw error })
    }
    const persisted = await this.#receiptStore?.getRequest({ agentId: 'connection', requestScope: providerId, requestId })
    const liveAfterLookup = this.#requests.get(key)
    if (liveAfterLookup) {
      if (liveAfterLookup.signature !== signature) throw serviceError('CONNECTION_REQUEST_CONFLICT')
      return liveAfterLookup.promise.then(clone, error => { throw error })
    }
    if (persisted) {
      if (persisted.intentFingerprint !== sha256({ signature })) throw serviceError('CONNECTION_REQUEST_CONFLICT')
      if (persisted.status === 'pending' || persisted.status === 'unknown') throw Object.assign(serviceError('CONNECTION_OPERATION_UNKNOWN'), { receipt: this.#receiptFromPersisted(request, persisted) })
      return this.#resultFromPersisted(request, persisted)
    }
    const promise = this.#perform(request, signature)
    this.#requests.set(key, { signature, promise })
    promise.finally(() => {
      const current = this.#requests.get(key)
      if (current?.promise === promise) this.#requests.delete(key)
    }).catch(() => {})
    return promise.then(clone, error => { throw error })
  }

  async receipt(providerId, requestId) {
    providerId = providerIdOf(providerId)
    requestId = requestIdOf(requestId)
    if (!this.#adapters.has(providerId)) throw serviceError('CONNECTION_PROVIDER_UNSUPPORTED')
    const current = this.#receipts.get(`${providerId}:${requestId}`)
    if (current) return clone(current.result ?? { receipt: current.receipt })
    const persisted = await this.#receiptStore?.getRequest({ agentId: 'connection', requestScope: providerId, requestId })
    return persisted ? this.#resultFromPersisted({ providerId, requestId, operation: persisted.result?.operation ?? 'test-model', model: persisted.result?.model }, persisted) : null
  }

  #raw(providerId) {
    const adapter = this.#adapters.get(providerId)
    const raw = adapter.state()
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.then === 'function') throw serviceError('CONNECTION_STATE_UNAVAILABLE')
    const override = this.#overrides.get(providerId)
    if (!override) return raw
    const merged = { ...raw, ...override }
    for (const field of ['error', 'lastVerification', 'accountRef', 'signedIn', 'catalogAvailable', 'machineRef', 'sessionStatus', 'selectedModel', 'model', 'executor']) {
      if (Object.hasOwn(raw, field)) merged[field] = raw[field]
    }
    return merged
  }

  #project(providerId, raw = this.#raw(providerId)) {
    const policy = this.#policy.get(providerId)
    const adapter = this.#adapters.get(providerId)
    const durable = this.#receiptStore?.latest?.('connection', providerId)
    let projectedRaw = raw
    if (durable && (durable.status === 'unknown' || durable.status === 'failed'
      || ['test-model', 'test-safe'].includes(durable.result?.operation))) {
      const durableVerification = {
        ...(durable.result ?? {}),
        status: durable.status === 'passed' ? 'passed' : durable.status,
        at: durable.observedAt,
        requestId: durable.requestId,
        bindingFingerprint: durable.fingerprint,
        machineRef: durable.result?.machineRef ?? this.#machineRef,
      }
      const rawVerification = raw.lastVerification
      const rawAt = typeof rawVerification?.at === 'string' ? Date.parse(rawVerification.at) : -Infinity
      const durableAt = Date.parse(durable.observedAt)
      if (!rawVerification || !Number.isFinite(rawAt) || durableAt >= rawAt) {
        projectedRaw = { ...raw, lastVerification: durableVerification }
      }
    }
    return projectConnection({
      providerId,
      enabled: policy.enabled,
      revision: policy.revision,
      machineRef: this.#machineRef,
      accountRef: projectedRaw.accountRef,
      signedIn: projectedRaw.signedIn,
      sessionStatus: projectedRaw.sessionStatus,
      selectedModel: projectedRaw.selectedModel ?? projectedRaw.model,
      executor: projectedRaw.executor,
      models: projectedRaw.models,
      catalogAvailable: projectedRaw.catalogAvailable,
      lastVerification: projectedRaw.lastVerification,
      error: projectedRaw.error,
      operations: adapter.operations,
    })
  }

  async #perform(request, signature) {
    const { providerId, operation, model, requestId, expectedRevision, allowQuotaUse } = request
    const adapter = this.#adapters.get(providerId)
    const beforeRaw = this.#raw(providerId)
    const before = this.#project(providerId, beforeRaw)
    const bindingFingerprint = sha256({
      providerId,
      revision: before.revision,
      machineRef: before.provenance.machineRef,
      accountRef: before.provenance.accountRef,
      signedIn: before.provenance.signedIn,
      sessionStatus: before.provenance.sessionStatus ?? beforeRaw.sessionStatus ?? null,
      model: model ?? before.provenance.selectedModel ?? beforeRaw.selectedModel ?? beforeRaw.model ?? null,
      executor: before.provenance.executor ?? beforeRaw.executor ?? null,
      operation,
    })
    if (expectedRevision !== undefined && before.revision !== expectedRevision) throw serviceError('CONNECTION_REVISION_STALE')

    if (operation === 'disconnect') {
      if (adapter.operations?.disconnect !== true && typeof adapter.operations?.disconnect !== 'function') throw serviceError('CONNECTION_OPERATION_UNSUPPORTED')
      const changed = await this.#policy.setEnabled(providerId, false, {
        changedBy: 'operator',
        expectedRevision: before.revision,
      })
      const result = this.#result(providerId, request, 'succeeded', { revision: changed.revision, costClass: 'free', modelCallSent: false })
      this.#remember(providerId, signature, result)
      return result
    }
    if (operation === 'test-model') {
      if (allowQuotaUse !== true) throw serviceError('CONNECTION_QUOTA_CONFIRMATION_REQUIRED')
      if (!model) throw serviceError('CONNECTION_MODEL_REQUIRED')
      isModelDeclared(this.#raw(providerId), model)
    }
    if (!['connect', 'reconnect', 'refresh'].includes(operation)) this.#policy.assertEnabled(providerId)
    const action = actionOf(adapter, operation)
    try {
      await this.#recordDurable(request, signature, 'pending', {
        revision: before.revision,
        bindingFingerprint,
        machineRef: before.provenance.machineRef,
        accountRef: before.provenance.accountRef,
        signedIn: before.provenance.signedIn,
        sessionStatus: before.provenance.sessionStatus ?? beforeRaw.sessionStatus,
      })
    } catch (error) {
      if (error?.code === 'CONNECTION_UNRESOLVED_BINDING' && error.record) {
        const receipt = this.#receiptFromPersisted(request, error.record)
        this.#receipts.set(`${providerId}:${requestId}`, { signature, receipt })
        throw Object.assign(serviceError('CONNECTION_OPERATION_UNKNOWN'), { receipt: clone(receipt) })
      }
      throw error
    }
    let actionResult
    try {
      actionResult = await action({ providerId, operation, model, requestId, expectedRevision, allowQuotaUse, state: before })
    } catch (error) {
      if (UNKNOWN_CODES.has(error?.code) || error?.unknown === true) {
        const receipt = this.#receipt(request, 'unknown', {
          revision: before.revision, bindingFingerprint,
          machineRef: before.provenance.machineRef, accountRef: before.provenance.accountRef,
          signedIn: before.provenance.signedIn, sessionStatus: before.provenance.sessionStatus ?? beforeRaw.sessionStatus,
          ...safeReceiptResult(error),
        })
        this.#receipts.set(`${providerId}:${requestId}`, { signature, receipt })
        await this.#recordDurable(request, signature, 'unknown', {
          revision: before.revision,
          bindingFingerprint,
          machineRef: before.provenance.machineRef,
          accountRef: before.provenance.accountRef,
          signedIn: before.provenance.signedIn,
          sessionStatus: before.provenance.sessionStatus ?? beforeRaw.sessionStatus,
          ...safeReceiptResult(error),
        }).catch(() => {})
        throw Object.assign(error, { code: 'CONNECTION_OPERATION_UNKNOWN', receipt: clone(receipt) })
      }
      await this.#recordDurable(request, signature, 'failed', {
        revision: before.revision,
        bindingFingerprint,
        machineRef: before.provenance.machineRef,
        accountRef: before.provenance.accountRef,
        signedIn: before.provenance.signedIn,
        sessionStatus: before.provenance.sessionStatus ?? beforeRaw.sessionStatus,
        ...safeReceiptResult(error),
      }).catch(() => {})
      throw error
    }
    if (actionResult?.outcome === 'unknown' || actionResult?.status === 'unknown') {
      const receipt = this.#receipt(request, 'unknown', {
        revision: before.revision, bindingFingerprint,
        machineRef: before.provenance.machineRef, accountRef: before.provenance.accountRef,
        signedIn: before.provenance.signedIn, sessionStatus: before.provenance.sessionStatus ?? beforeRaw.sessionStatus,
        ...safeReceiptResult(actionResult),
      })
      this.#receipts.set(`${providerId}:${requestId}`, { signature, receipt })
      await this.#recordDurable(request, signature, 'unknown', {
        revision: before.revision,
        bindingFingerprint,
        machineRef: before.provenance.machineRef,
        accountRef: before.provenance.accountRef,
        signedIn: before.provenance.signedIn,
        sessionStatus: before.provenance.sessionStatus ?? beforeRaw.sessionStatus,
        ...safeReceiptResult(actionResult),
      }).catch(() => {})
      throw Object.assign(serviceError('CONNECTION_OPERATION_UNKNOWN'), { receipt: clone(receipt) })
    }
    if (operation === 'connect' || operation === 'reconnect') {
      await this.#policy.setEnabled(providerId, true, { changedBy: 'operator', expectedRevision: before.revision })
    }
    const observedRaw = this.#raw(providerId)
    const observed = this.#project(providerId, observedRaw)
    // Verification evidence belongs to the binding captured before dispatch.
    // A provider/session change while the call was in flight is a new current
    // binding, not permission to stamp the post-call state onto the result.
    const verificationOperation = operation === 'test-model' || operation === 'test-safe'
    const evidenceRaw = verificationOperation ? beforeRaw : observedRaw
    const evidence = verificationOperation ? before : observed
    if (operation !== 'connect' && operation !== 'reconnect'
      && (observed.provenance.accountRef !== before.provenance.accountRef
        || observed.provenance.signedIn !== before.provenance.signedIn
        || observedRaw.sessionStatus !== beforeRaw.sessionStatus)) {
      await this.#policy.setEnabled(providerId, before.enabled, {
        changedBy: 'adapter-refresh',
        expectedRevision: before.revision,
      })
    }
    if (actionResult?.state && typeof actionResult.state === 'object' && !Array.isArray(actionResult.state)) this.#overrides.set(providerId, actionResult.state)
    const verification = actionResult?.verification && typeof actionResult.verification === 'object'
      ? {
          ...actionResult.verification,
          revision: before.revision,
          machineRef: this.#machineRef,
          requestId,
          bindingFingerprint,
        }
      : null
    const projectedRaw = verification ? {
      ...(this.#overrides.get(providerId) ?? {}),
      lastVerification: verification,
    } : this.#overrides.get(providerId)
    const after = this.#project(providerId, projectedRaw ? { ...this.#raw(providerId), ...projectedRaw } : this.#raw(providerId))
    const result = this.#result(providerId, request, 'succeeded', {
      revision: verificationOperation ? before.revision : after.revision, bindingFingerprint,
      machineRef: evidence.provenance.machineRef, accountRef: evidenceRaw.accountRef,
      signedIn: evidenceRaw.signedIn, sessionStatus: evidenceRaw.sessionStatus,
      executor: evidence.provenance.executor ?? evidenceRaw.executor,
      ...safeReceiptResult(actionResult),
    }, after)
    try {
      await this.#recordDurable(request, signature, 'passed', {
        revision: verificationOperation ? before.revision : after.revision,
        bindingFingerprint,
        machineRef: evidence.provenance.machineRef,
        accountRef: evidenceRaw.accountRef,
        signedIn: evidenceRaw.signedIn,
        sessionStatus: evidenceRaw.sessionStatus,
        executor: evidence.provenance.executor ?? evidenceRaw.executor,
        ...safeReceiptResult(actionResult),
      })
    } catch (error) {
      const receipt = this.#receipt(request, 'unknown', {
        revision: before.revision, bindingFingerprint,
        machineRef: before.provenance.machineRef, accountRef: before.provenance.accountRef,
        signedIn: before.provenance.signedIn, sessionStatus: before.provenance.sessionStatus ?? beforeRaw.sessionStatus,
        costClass: actionResult?.costClass ?? 'unknown', modelCallSent: actionResult?.modelCallSent === true,
      })
      this.#receipts.set(`${providerId}:${requestId}`, { signature, receipt })
      throw Object.assign(serviceError('CONNECTION_OPERATION_UNKNOWN'), { receipt: clone(receipt), cause: error })
    }
    if (verification) this.#overrides.set(providerId, projectedRaw)
    const durableState = this.#project(providerId)
    const durableResult = { ...result, state: durableState }
    this.#remember(providerId, signature, durableResult)
    return durableResult
  }

  async #recordDurable(request, signature, status, metadata = {}) {
    if (!this.#receiptStore) return
    const record = {
      agentId: 'connection',
      requestScope: request.providerId,
      requestId: request.requestId,
      intentFingerprint: sha256({ signature }),
      fingerprint: metadata.bindingFingerprint ?? sha256({ providerId: request.providerId, operation: request.operation, model: request.model, revision: metadata.revision }),
      scope: 'connection-operation',
      status,
      observedAt: String(this.#now()),
      result: {
        status,
        operation: request.operation,
        model: request.model,
        revision: metadata.revision,
        machineRef: metadata.machineRef,
        accountRef: metadata.accountRef,
        signedIn: metadata.signedIn,
        sessionStatus: metadata.sessionStatus,
        executor: metadata.executor,
        costClass: metadata.costClass,
        modelCallSent: metadata.modelCallSent,
      },
    }
    await this.#receiptStore.record(record, status === 'pending' ? {
      unresolvedGuard: { fingerprint: record.fingerprint, code: 'CONNECTION_UNRESOLVED_BINDING' },
    } : undefined)
  }

  #receiptFromPersisted(request, persisted) {
    const status = persisted.status === 'passed' ? 'succeeded' : persisted.status
    return {
      schema: 'chimera.connection-operation-receipt.v1',
      requestId: persisted.requestId ?? request.requestId,
      providerId: request.providerId,
      operation: persisted.result?.operation ?? request.operation,
      ...((persisted.result?.model ?? request.model) ? { model: persisted.result?.model ?? request.model } : {}),
      status,
      revision: Number.isSafeInteger(persisted.result?.revision) ? persisted.result.revision : this.#policy.get(request.providerId).revision,
      at: persisted.observedAt,
      ...(persisted.fingerprint ? { bindingFingerprint: persisted.fingerprint } : {}),
      ...(persisted.result?.machineRef ? { machineRef: persisted.result.machineRef } : {}),
      ...(persisted.result?.accountRef ? { accountRef: persisted.result.accountRef } : {}),
      ...(typeof persisted.result?.signedIn === 'boolean' ? { signedIn: persisted.result.signedIn } : {}),
      ...(persisted.result?.sessionStatus ? { sessionStatus: persisted.result.sessionStatus } : {}),
      ...(persisted.result?.executor ? { executor: persisted.result.executor } : {}),
      ...(persisted.result?.costClass ? { costClass: persisted.result.costClass } : {}),
      ...(typeof persisted.result?.modelCallSent === 'boolean' ? { modelCallSent: persisted.result.modelCallSent } : {}),
    }
  }

  #resultFromPersisted(request, persisted) {
    return {
      state: this.#project(request.providerId),
      receipt: this.#receiptFromPersisted(request, persisted),
    }
  }

  #result(providerId, request, status, metadata, state = this.#project(providerId)) {
    const receipt = this.#receipt(request, status, metadata)
    return { state, receipt }
  }

  #receipt(request, status, metadata = {}) {
    return {
      schema: 'chimera.connection-operation-receipt.v1',
      requestId: request.requestId,
      providerId: request.providerId,
      operation: request.operation,
      ...(request.model ? { model: request.model } : {}),
      status,
      revision: Number.isSafeInteger(metadata.revision) ? metadata.revision : this.#policy.get(request.providerId).revision,
      at: String(this.#now()),
      ...(metadata.bindingFingerprint ? { bindingFingerprint: metadata.bindingFingerprint } : {}),
      ...(metadata.machineRef ? { machineRef: metadata.machineRef } : {}),
      ...(metadata.accountRef ? { accountRef: metadata.accountRef } : {}),
      ...(typeof metadata.signedIn === 'boolean' ? { signedIn: metadata.signedIn } : {}),
      ...(metadata.sessionStatus ? { sessionStatus: metadata.sessionStatus } : {}),
      ...(metadata.executor ? { executor: metadata.executor } : {}),
      ...(metadata.costClass ? { costClass: metadata.costClass } : {}),
      ...(typeof metadata.modelCallSent === 'boolean' ? { modelCallSent: metadata.modelCallSent } : {}),
    }
  }

  #remember(providerId, signature, result) {
    this.#receipts.set(`${providerId}:${result.receipt.requestId}`, { signature, receipt: result.receipt, result })
  }
}

export const CONNECTION_OPERATION_SET = Object.freeze([...OPERATION_SET])
