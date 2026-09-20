import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { sha256 } from '../canonical.mjs'
import { createTaskFailureFromError, isTrustedTaskFailure } from './model-call-errors.mjs'
import { TASK_PLAN_SCHEMA, normalizeTaskPlan } from './task-plan.mjs'

export const TASK_LEDGER_SCHEMA = 'chimera.task-ledger.v1'
const MAX_RESULT_BYTES = 2 * 1024 * 1024
const MAX_ROUTING_BYTES = 64 * 1024
const OPEN_TOKEN = Symbol('chimera-task-ledger-open')
const OPEN_LEDGER_OWNERS = new Map()
const MAX_QUEUED_PROJECT_TASKS = 32
const ADMISSION_SCHEMA = 'chimera.task-admission.v1'
const ADMISSION_OPERATIONS = new Set(['new-task', 'project-task', 'task-message', 'task-steer', 'continuation', 'rj-aws-verify', 'send-message', 'resume-queued'])
const TASK_PLAN_MAX_NODES = 8
const TASK_PLAN_MAX_HISTORY = 32
const TASK_STEP_STATUSES = new Set(['queued', 'running', 'waiting-for-approval', 'completed', 'blocked', 'failed', 'cancelled', 'unknown'])
const TASK_STEP_TERMINAL_STATUSES = new Set(['completed', 'blocked', 'failed', 'cancelled', 'unknown'])
const TASK_TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'unknown'])
const TASK_EVIDENCE_KINDS = new Set(['artifact', 'check', 'review', 'publication'])
const TASK_EVIDENCE_SOURCES = new Set([
  'worker-artifact-store',
  'bounded-check',
  'project-review',
  'publishing-adapter',
  'current-path-verifier',
  'signed-delivery',
  'runtime',
])
const MAX_EVIDENCE = 256
const TRUSTED_TASK_EVIDENCE = new WeakSet()

export { TASK_EVIDENCE_KINDS, TASK_EVIDENCE_SOURCES }

function taskError(code) {
  return Object.assign(new Error(code), { code })
}

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function boundedString(value, maximum = 16_384) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function validateAdmissionBinding(requestId, requestHash) {
  const hasRequestId = requestId !== null && requestId !== undefined
  const hasRequestHash = requestHash !== null && requestHash !== undefined
  if (!hasRequestId && !hasRequestHash) return null
  if (!boundedString(requestId, 256) || !/^[0-9a-f]{64}$/.test(requestHash ?? '')) {
    throw taskError('TASK_ADMISSION_INVALID')
  }
  return { requestId, requestHash }
}

function hasActiveTask(records) {
  return [...records].some((record) => ['queued', 'running'].includes(record.status))
}

function validateModel(model) {
  if (model === null) return null
  if (!isRecord(model)
    || !boundedString(model.providerId, 64)
    || !boundedString(model.model, 256)) {
    throw new TypeError('invalid task model selection')
  }
  return { providerId: model.providerId, model: model.model }
}

function cloneBoundedResult(result) {
  let encoded
  try {
    encoded = JSON.stringify(result)
  } catch {
    throw new TypeError('task result is invalid')
  }
  if (!encoded || Buffer.byteLength(encoded, 'utf8') > MAX_RESULT_BYTES) {
    throw new TypeError('task result is invalid')
  }
  return JSON.parse(encoded)
}

function cloneBoundedEvidence(value, maximum = 64 * 1024) {
  let encoded
  try { encoded = JSON.stringify(value) } catch { throw taskError('TASK_EVIDENCE_INVALID') }
  if (!encoded || Buffer.byteLength(encoded, 'utf8') > maximum) throw taskError('TASK_EVIDENCE_INVALID')
  try { return JSON.parse(encoded) } catch { throw taskError('TASK_EVIDENCE_INVALID') }
}

function normalizeTaskFailure(failure) {
  const trusted = failure instanceof Error
    ? createTaskFailureFromError(failure)
    : isTrustedTaskFailure(failure) ? failure : null
  const source = trusted ?? failure
  return {
    code: boundedString(source?.code, 256) ? source.code : 'TASK_FAILED',
    message: boundedString(source?.message) ? source.message : 'The task failed.',
    // Legacy and provider-shaped failures are retained as unknown. Only the
    // opaque runtime-issued failure object can authorize a not-sent retry.
    dispatchState: trusted?.dispatchState === 'not_sent' ? 'not_sent' : 'unknown',
  }
}

function validateEvidenceReceipt(receipt, taskId = null) {
  if (!isRecord(receipt)
    || !boundedString(receipt.receiptId, 256)
    || !TASK_EVIDENCE_KINDS.has(receipt.kind)
    || !boundedString(receipt.taskId, 256)
    || (taskId !== null && receipt.taskId !== taskId)
    || !TASK_EVIDENCE_SOURCES.has(receipt.source)
    || !boundedString(receipt.operationId, 256)
    || !boundedString(receipt.observedAt, 128)
    || Number.isNaN(Date.parse(receipt.observedAt))
    || (typeof receipt.revision !== 'string' && !Number.isSafeInteger(receipt.revision) && !isRecord(receipt.revision))
    || receipt.revision === null
    || !isRecord(receipt.outcome)
    || (typeof receipt.evidenceRef !== 'string' && !isRecord(receipt.evidenceRef))) {
    throw taskError('TASK_EVIDENCE_INVALID')
  }
  const normalized = cloneBoundedEvidence(receipt)
  if (!isRecord(normalized.evidenceRef)) {
    if (!boundedString(normalized.evidenceRef, 1024)) throw taskError('TASK_EVIDENCE_INVALID')
  }
  return normalized
}

export function createTaskEvidenceReceiptIssuer({ taskId, source, now = () => Date.now() } = {}) {
  if (!boundedString(taskId, 256) || !TASK_EVIDENCE_SOURCES.has(source) || typeof now !== 'function') {
    throw taskError('TASK_EVIDENCE_SOURCE_INVALID')
  }
  return Object.freeze({
    issue(input = {}) {
      if (!isRecord(input)) throw taskError('TASK_EVIDENCE_INVALID')
      const receipt = validateEvidenceReceipt({
        ...input,
        receiptId: input.receiptId ?? `receipt-${randomUUID()}`,
        taskId,
        source,
        observedAt: input.observedAt ?? new Date(now()).toISOString(),
      }, taskId)
      TRUSTED_TASK_EVIDENCE.add(receipt)
      return Object.freeze(receipt)
    },
  })
}

function validatePlanInput({ revision, planHash, nodes } = {}) {
  if (!Number.isSafeInteger(revision) || revision < 1
    || typeof planHash !== 'string' || !/^[0-9a-f]{64}$/.test(planHash)
    || !Array.isArray(nodes) || nodes.length < 1 || nodes.length > TASK_PLAN_MAX_NODES) {
    throw taskError('TASK_PLAN_INVALID')
  }
  let normalized
  try {
    normalized = normalizeTaskPlan({ schema: TASK_PLAN_SCHEMA, tasks: nodes }).tasks
  } catch (error) {
    throw taskError(error.code ?? 'TASK_PLAN_INVALID')
  }
  const expectedHash = sha256({ schema: TASK_PLAN_SCHEMA, tasks: normalized })
  if (planHash !== expectedHash) throw taskError('TASK_PLAN_HASH_MISMATCH')
  return { revision, planHash: expectedHash, nodes: normalized }
}

function planEqual(left, right) {
  return left?.revision === right?.revision
    && left?.planHash === right?.planHash
    && JSON.stringify(left?.nodes ?? null) === JSON.stringify(right?.nodes ?? null)
}

function validateStepInput({ revision, nodeId, status, messageId = null, resultId = null, reason = null } = {}) {
  if (!Number.isSafeInteger(revision) || revision < 1
    || typeof nodeId !== 'string' || nodeId.length === 0 || nodeId.length > 128
    || !TASK_STEP_STATUSES.has(status)
    || (messageId !== null && (typeof messageId !== 'string' || messageId.length === 0 || messageId.length > 256))
    || (resultId !== null && (typeof resultId !== 'string' || resultId.length === 0 || resultId.length > 256))
    || (reason !== null && (typeof reason !== 'string' || reason.length === 0 || reason.length > 4_096))) {
    throw taskError('TASK_STEP_INVALID')
  }
  return { revision, nodeId, status, messageId, resultId, reason }
}

function allowedStepTransition(from, to) {
  if (from === to) return true
  if (TASK_STEP_TERMINAL_STATUSES.has(from)) return false
  if (from === 'queued') return true
  if (from === 'running') return to !== 'queued'
  if (from === 'waiting-for-approval') return to !== 'queued'
  return false
}

export class DurableTaskLedger {
  #records = new Map()
  #admissions = new Map()
  #writes = Promise.resolve()

  constructor({ filePath, audit, now = () => Date.now() }, token) {
    if (token !== OPEN_TOKEN) throw new TypeError('use DurableTaskLedger.open()')
    if (!boundedString(filePath, 4096) || !audit || typeof audit.append !== 'function') {
      throw new TypeError('task ledger requires file path and audit log')
    }
    this.filePath = resolve(filePath)
    this.audit = audit
    this.now = now
    this.closed = false
  }

  static async open(options) {
    const ledger = new DurableTaskLedger(options, OPEN_TOKEN)
    try {
      await mkdir(dirname(ledger.filePath), { recursive: true, mode: 0o700 })
      try {
        ledger.filePath = await realpath(ledger.filePath)
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
        ledger.filePath = join(await realpath(dirname(ledger.filePath)), basename(ledger.filePath))
      }
      if (OPEN_LEDGER_OWNERS.has(ledger.filePath)) {
        const error = new Error('TASK_LEDGER_ALREADY_OPEN')
        error.code = 'TASK_LEDGER_ALREADY_OPEN'
        throw error
      }
      OPEN_LEDGER_OWNERS.set(ledger.filePath, ledger)
      try {
        const content = await readFile(ledger.filePath, 'utf8')
        for (const line of content.split('\n')) {
          if (line.trim()) ledger.#restore(JSON.parse(line))
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      for (const record of ledger.#records.values()) {
        if (record.status === 'queued' && record.queuedForExecution) {
          await ledger.#pauseQueued(record.taskId)
        } else if (record.status === 'queued' || record.status === 'running') {
          await ledger.#interrupt(record.taskId)
        }
      }
      return ledger
    } catch (error) {
      await ledger.close()
      throw error
    }
  }

  async close() {
    if (this.closed) return
    await this.#writes
    this.closed = true
    if (OPEN_LEDGER_OWNERS.get(this.filePath) === this) OPEN_LEDGER_OWNERS.delete(this.filePath)
  }

  submit({ taskId, objective, model, context = {}, queue = false, admissionRequestId = null, admissionRequestHash = null }) {
    return this.#mutate(async () => {
      if (!boundedString(taskId, 256) || !boundedString(objective)) {
        throw new TypeError('invalid task submission')
      }
      const admissionBinding = validateAdmissionBinding(admissionRequestId, admissionRequestHash)
      if (this.#records.has(taskId)) throw new Error('TASK_ALREADY_EXISTS')
      if (typeof queue !== 'boolean') throw new TypeError('TASK_QUEUE_INVALID')
      if (queue && (!isRecord(context) || (!boundedString(context.projectId, 256) && context.queueScope !== 'root'))) throw taskError('TASK_QUEUE_PROJECT_REQUIRED')
      if (queue && this.active().filter(row => row.status === 'queued' && row.queuedForExecution).length >= MAX_QUEUED_PROJECT_TASKS) throw taskError('TASK_QUEUE_FULL')
      if (!queue && hasActiveTask(this.#records.values())) {
        const error = new Error('TASK_ALREADY_RUNNING')
        error.code = 'TASK_ALREADY_RUNNING'
        throw error
      }
      const submittedAt = new Date(this.now()).toISOString()
      const record = {
        schema: TASK_LEDGER_SCHEMA,
        taskId,
        objective,
        model: validateModel(model),
        context: cloneBoundedResult(context),
        status: 'queued',
        destinationRevision: 0,
        ...(queue ? { queuedForExecution: true, recoveryRequired: false } : {}),
        ...(admissionBinding ? {
          admissionRequestId: admissionBinding.requestId,
          admissionRequestHash: admissionBinding.requestHash,
        } : {}),
        retryable: false,
        submittedAt,
      }
      await this.#append({ schema: TASK_LEDGER_SCHEMA, event: 'submitted', at: submittedAt, task: record })
      this.#records.set(taskId, record)
      this.audit.append({ kind: 'ceo.task.submitted', taskId, model: record.model, at: submittedAt })
      return structuredClone(record)
    })
  }

  recordPlan(taskId, { revision, planHash, nodes } = {}) {
    return this.#mutate(async () => {
      const current = this.#records.get(taskId)
      if (!current) throw taskError('TASK_NOT_FOUND')
      if (TASK_TERMINAL_STATUSES.has(current.status)) throw taskError('TASK_PLAN_TERMINAL')
      if (current.plan && Number.isSafeInteger(revision) && revision < current.plan.revision) {
        throw taskError('TASK_PLAN_STALE_REVISION')
      }
      const requested = validatePlanInput({ revision, planHash, nodes })
      if (current.plan) {
        if (requested.revision < current.plan.revision) throw taskError('TASK_PLAN_STALE_REVISION')
        if (requested.revision === current.plan.revision) {
          if (!planEqual(current.plan, requested)) throw taskError('TASK_PLAN_REVISION_CONFLICT')
          return structuredClone(current)
        }
        if ((current.steps ?? []).some((step) => step.status !== 'queued')) throw taskError('TASK_PLAN_ACTIVE')
      }
      const at = new Date(this.now()).toISOString()
      const plan = {
        schema: TASK_PLAN_SCHEMA,
        revision: requested.revision,
        planHash: requested.planHash,
        nodes: structuredClone(requested.nodes),
      }
      await this.#append({ schema: TASK_LEDGER_SCHEMA, event: 'plan-recorded', taskId, at, plan })
      const next = {
        ...current,
        plan,
        // A plan is itself a durable admission barrier: every node is queued
        // before any handoff can be attempted. recordStep can then enrich each
        // node with the exact signed assignment and result identifiers.
        steps: plan.nodes.map((node) => ({ nodeId: node.nodeId, status: 'queued', history: [] })),
      }
      this.#records.set(taskId, next)
      this.audit.append({ kind: 'ceo.task.plan.recorded', taskId, revision: plan.revision, nodeCount: plan.nodes.length, at })
      return structuredClone(next)
    })
  }

  recordStep(taskId, input = {}) {
    return this.#mutate(async () => {
      const current = this.#records.get(taskId)
      if (!current) throw taskError('TASK_NOT_FOUND')
      if (current.plan && Number.isSafeInteger(input?.revision) && input.revision < current.plan.revision) {
        throw taskError('TASK_PLAN_STALE_REVISION')
      }
      const step = validateStepInput(input)
      if (!current.plan) throw taskError('TASK_PLAN_NOT_FOUND')
      if (step.revision !== current.plan.revision) throw taskError('TASK_PLAN_STALE_REVISION')
      if (!current.plan.nodes.some((node) => node.nodeId === step.nodeId)) throw taskError('TASK_STEP_NODE_NOT_FOUND')
      const steps = [...(current.steps ?? [])]
      const index = steps.findIndex((candidate) => candidate.nodeId === step.nodeId)
      if (index < 0) throw taskError('TASK_STEP_NODE_NOT_FOUND')
      const prior = steps[index]
      if (!allowedStepTransition(prior.status, step.status)) throw taskError('TASK_STEP_TERMINAL')
      if (prior.status === step.status) {
        // Retries of the same non-terminal notification are harmless. The
        // initial queued row is intentionally metadata-free, so the later
        // signed assignment notification may enrich it with its message id
        // without looking like a conflicting transition. Terminal rows stay
        // immutable: they may only be replayed with identical metadata.
        const priorMessageId = prior.messageId ?? null
        const priorResultId = prior.resultId ?? null
        const priorReason = prior.reason ?? null
        const sameMetadata = (step.messageId === null || priorMessageId === null || step.messageId === priorMessageId)
          && (step.resultId === null || priorResultId === null || step.resultId === priorResultId)
          && (step.reason === null || priorReason === null || step.reason === priorReason)
        if (!sameMetadata) throw taskError('TASK_STEP_TERMINAL')
        const hasNewMetadata = (step.messageId !== null && step.messageId !== priorMessageId)
          || (step.resultId !== null && step.resultId !== priorResultId)
          || (step.reason !== null && step.reason !== priorReason)
        if (!hasNewMetadata || TASK_STEP_TERMINAL_STATUSES.has(prior.status)) {
          return structuredClone(current)
        }
        const at = new Date(this.now()).toISOString()
        const transition = {
          status: step.status,
          at,
          ...(step.messageId !== null ? { messageId: step.messageId } : {}),
          ...(step.resultId !== null ? { resultId: step.resultId } : {}),
          ...(step.reason !== null ? { reason: step.reason } : {}),
        }
        await this.#append({ schema: TASK_LEDGER_SCHEMA, event: 'step-recorded', taskId, at, step: { ...step, at } })
        const nextStep = {
          ...prior,
          messageId: step.messageId !== null ? step.messageId : (prior.messageId ?? null),
          resultId: step.resultId !== null ? step.resultId : (prior.resultId ?? null),
          reason: step.reason !== null ? step.reason : (prior.reason ?? null),
          updatedAt: at,
          history: [...(prior.history ?? []), transition].slice(-TASK_PLAN_MAX_HISTORY),
        }
        steps[index] = nextStep
        const next = { ...current, steps }
        this.#records.set(taskId, next)
        this.audit.append({ kind: 'ceo.task.step.recorded', taskId, nodeId: step.nodeId, status: step.status, revision: step.revision, at })
        return structuredClone(next)
      }
      const at = new Date(this.now()).toISOString()
      const transition = {
        status: step.status,
        at,
        ...(step.messageId !== null ? { messageId: step.messageId } : {}),
        ...(step.resultId !== null ? { resultId: step.resultId } : {}),
        ...(step.reason !== null ? { reason: step.reason } : {}),
      }
      await this.#append({ schema: TASK_LEDGER_SCHEMA, event: 'step-recorded', taskId, at, step: { ...step, at } })
      const nextStep = {
        ...prior,
        status: step.status,
        messageId: step.messageId !== null ? step.messageId : (prior.messageId ?? null),
        resultId: step.resultId !== null ? step.resultId : (prior.resultId ?? null),
        reason: step.reason !== null ? step.reason : (prior.reason ?? null),
        updatedAt: at,
        history: [...(prior.history ?? []), transition].slice(-TASK_PLAN_MAX_HISTORY),
      }
      steps[index] = nextStep
      const next = { ...current, steps }
      this.#records.set(taskId, next)
      this.audit.append({ kind: 'ceo.task.step.recorded', taskId, nodeId: step.nodeId, status: step.status, revision: step.revision, at })
      return structuredClone(next)
    })
  }

  start(taskId) {
    return this.#mutate(async () => {
      const current = this.#records.get(taskId)
      if (!current) throw new Error('TASK_NOT_FOUND')
      if (current.status !== 'queued') throw new Error('TASK_NOT_QUEUED')
      if (current.recoveryRequired) throw taskError('TASK_QUEUE_RESUME_REQUIRED')
      if ([...this.#records.values()].some(row => row.status === 'running')) throw taskError('TASK_EXECUTION_BUSY')
      const startedAt = new Date(this.now()).toISOString()
      await this.#append({ schema: TASK_LEDGER_SCHEMA, event: 'started', at: startedAt, taskId })
      const next = { ...current, status: 'running', startedAt }
      next.destinationRevision = (current.destinationRevision ?? 0) + 1
      this.#records.set(taskId, next)
      this.audit.append({ kind: 'ceo.task.started', taskId, at: startedAt })
      return structuredClone(next)
    })
  }

  complete(taskId, { summary, result }) {
    return this.#mutate(async () => {
      const current = this.#records.get(taskId)
      if (!current) throw new Error('TASK_NOT_FOUND')
      if (current.status !== 'running') throw new Error('TASK_NOT_RUNNING')
      if (!boundedString(summary)) throw new TypeError('task summary is invalid')
      const durableResult = cloneBoundedResult(result)
      const completedAt = new Date(this.now()).toISOString()
      const event = {
        schema: TASK_LEDGER_SCHEMA,
        event: 'completed',
        at: completedAt,
        taskId,
        summary,
        result: durableResult,
      }
      await this.#append(event)
      const next = {
        ...current,
        status: 'completed',
        destinationRevision: (current.destinationRevision ?? 0) + 1,
        summary,
        result: durableResult,
        completedAt,
      }
      this.#records.set(taskId, next)
      this.audit.append({ kind: 'ceo.task.completed', taskId, summary, at: completedAt })
      return structuredClone(next)
    })
  }

  fail(taskId, failure) {
    return this.#mutate(async () => {
      const current = this.#records.get(taskId)
      if (!current) throw new Error('TASK_NOT_FOUND')
      if (!['queued', 'running'].includes(current.status)) throw new Error('TASK_NOT_ACTIVE')
      const normalized = normalizeTaskFailure(failure)
      const failedAt = new Date(this.now()).toISOString()
      await this.#append({
        schema: TASK_LEDGER_SCHEMA,
        event: 'failed',
        at: failedAt,
        taskId,
        failure: normalized,
        retryable: false,
      })
      const next = {
        ...current,
        status: 'failed',
        destinationRevision: (current.destinationRevision ?? 0) + 1,
        failure: normalized,
        retryable: false,
        failedAt,
      }
      this.#records.set(taskId, next)
      this.audit.append({ kind: 'ceo.task.failed', taskId, ...normalized, at: failedAt })
      return structuredClone(next)
    })
  }

  checkpoint(taskId, checkpoint) {
    return this.#mutate(async () => {
      const current = this.#records.get(taskId)
      if (!current) throw new Error('TASK_NOT_FOUND')
      const durable = cloneBoundedResult(checkpoint)
      if (!isRecord(durable) || !boundedString(durable.stage, 64)
        || Buffer.byteLength(JSON.stringify(durable)) > 64 * 1024) throw new TypeError('TASK_CHECKPOINT_INVALID')
      const at = new Date(this.now()).toISOString()
      await this.#append({ schema: TASK_LEDGER_SCHEMA, event: 'checkpoint', taskId, at, checkpoint: durable })
      const next = { ...current, checkpoint: { ...durable, at } }
      if (['tool-completed', 'specialist-completed'].includes(durable.stage)
        && [undefined, 'completed', 'succeeded'].includes(durable.effectOutcome)) next.lastCompletedWork = { ...durable, at }
      this.#records.set(taskId, next)
      return structuredClone(next)
    })
  }

  recordEvidence(taskId, receipt) {
    return this.#mutate(async () => {
      const current = this.#records.get(taskId)
      if (!current) throw taskError('TASK_NOT_FOUND')
      if (!TRUSTED_TASK_EVIDENCE.has(receipt)) throw taskError('TASK_EVIDENCE_UNTRUSTED')
      if (!isRecord(receipt) || receipt.taskId !== taskId) throw taskError('TASK_EVIDENCE_TASK_MISMATCH')
      const normalized = validateEvidenceReceipt(receipt, taskId)
      const existing = (current.evidence ?? []).find(item => item.receiptId === normalized.receiptId)
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(normalized)) throw taskError('TASK_EVIDENCE_CONFLICT')
        return structuredClone(existing)
      }
      const at = new Date(this.now()).toISOString()
      const wasAtCapacity = (current.evidence ?? []).length >= MAX_EVIDENCE
      const evidenceTruncated = current.evidenceTruncated === true || wasAtCapacity
      await this.#append({ schema: TASK_LEDGER_SCHEMA, event: 'evidence-recorded', taskId, at, receipt: normalized,
        ...(evidenceTruncated ? { evidenceTruncated: true } : {}),
      })
      const evidence = [...(current.evidence ?? []), normalized].slice(-MAX_EVIDENCE)
      this.#records.set(taskId, { ...current, evidence, ...(evidenceTruncated ? { evidenceTruncated: true } : {}) })
      this.audit.append({ kind: 'ceo.task.evidence.recorded', taskId, receiptId: normalized.receiptId, evidenceKind: normalized.kind, source: normalized.source, at })
      return structuredClone(normalized)
    })
  }

  listEvidence(taskId) {
    const current = this.#records.get(taskId)
    return current ? (current.evidence ?? []).map(receipt => structuredClone(receipt)) : []
  }

  setRouting(taskId, routing) {
    return this.#mutate(async () => {
      const current = this.#records.get(taskId)
      if (!current) throw new Error('TASK_NOT_FOUND')
      const durable = cloneBoundedResult(routing)
      if (!isRecord(durable) || durable.schema !== 'chimera.routing-explanation.v1'
        || !Array.isArray(durable.candidates) || durable.candidates.length > 64
        || (durable.selected !== null && !isRecord(durable.selected))
        || Buffer.byteLength(JSON.stringify(durable), 'utf8') > MAX_ROUTING_BYTES) {
        throw taskError('TASK_ROUTING_EXPLANATION_INVALID')
      }
      const at = new Date(this.now()).toISOString()
      await this.#append({ schema: TASK_LEDGER_SCHEMA, event: 'routing', taskId, at, routing: durable })
      const next = { ...current, routing: durable }
      this.#records.set(taskId, next)
      await Promise.resolve(this.audit.append({ kind: 'ceo.task.routing.explained', taskId,
        routeId: durable.selected?.routeId ?? null, at }))
      return structuredClone(next)
    })
  }

  steer(taskId, content, expectedDestinationRevision = null, { requestId = null, requestHash = null } = {}) {
    return this.#mutate(async () => {
      const current = this.#records.get(taskId)
      if (!current || !['queued', 'running'].includes(current.status)) throw Object.assign(new Error('TASK_NOT_ACTIVE'), { code: 'TASK_NOT_ACTIVE' })
      if (!boundedString(content, 4096)) throw new TypeError('TASK_STEERING_INVALID')
      if (expectedDestinationRevision !== null && expectedDestinationRevision !== undefined
        && current.destinationRevision !== expectedDestinationRevision) throw taskError('TASK_DESTINATION_STALE')
      if (requestId !== null && (!boundedString(requestId, 256) || !/^[0-9a-f]{64}$/.test(requestHash ?? ''))) throw taskError('TASK_ADMISSION_INVALID')
      const admission = requestId === null ? null : this.#admissions.get(requestId)
      if (requestId !== null && (!admission || admission.operation !== 'task-steer' || admission.status !== 'reserved'
        || admission.destination?.taskId !== taskId || admission.requestHash !== requestHash)) throw taskError('TASK_ADMISSION_CONFLICT')
      const steering = {
        sequence: (current.steering?.at(-1)?.sequence ?? 0) + 1,
        content,
        at: new Date(this.now()).toISOString(),
        ...(requestId ? { requestId, requestHash } : {}),
      }
      const completedAdmission = admission ? {
        ...admission,
        status: 'accepted',
        taskId,
        completedAt: steering.at,
      } : null
      await this.#append({ schema: TASK_LEDGER_SCHEMA, event: 'steered', taskId, at: steering.at, steering, ...(completedAdmission ? { admission: completedAdmission } : {}) })
      const next = { ...current, destinationRevision: (current.destinationRevision ?? 0) + 1, steering: [...(current.steering ?? []), steering].slice(-16) }
      this.#records.set(taskId, next)
      if (completedAdmission) this.#admissions.set(requestId, completedAdmission)
      this.audit.append({ kind: 'ceo.task.steered', taskId, sequence: steering.sequence, at: steering.at })
      return structuredClone(next)
    })
  }

  cancel(taskId) {
    return this.#mutate(async () => {
      const current = this.#records.get(taskId)
      if (!current) throw Object.assign(new Error('TASK_NOT_FOUND'), { code: 'TASK_NOT_FOUND' })
      if (current.status === 'cancelled') return structuredClone(current)
      if (!['queued', 'running'].includes(current.status)) throw Object.assign(new Error('TASK_NOT_ACTIVE'), { code: 'TASK_NOT_ACTIVE' })
      const cancelledAt = new Date(this.now()).toISOString()
      const summary = 'Cancelled. Future work is stopped; external effects already in flight may still complete. Inspect the checkpoint before continuing.'
      await this.#append({ schema: TASK_LEDGER_SCHEMA, event: 'cancelled', taskId, at: cancelledAt, summary })
      const next = { ...current, status: 'cancelled', cancelledAt, summary, retryable: false }
      next.destinationRevision = (current.destinationRevision ?? 0) + 1
      this.#records.set(taskId, next)
      this.audit.append({ kind: 'ceo.task.cancelled', taskId, at: cancelledAt })
      return structuredClone(next)
    })
  }

  get(taskId) {
    const record = this.#records.get(taskId)
    return record ? structuredClone(record) : null
  }

  list({ limit = Infinity, before = null } = {}) {
    if (limit !== Infinity && (!Number.isSafeInteger(limit) || limit < 1)) throw Object.assign(new TypeError('TASK_LIST_LIMIT_INVALID'), { code: 'TASK_LIST_LIMIT_INVALID' })
    const records = [...this.#records.values()].toSorted((left, right) => Date.parse(right.submittedAt) - Date.parse(left.submittedAt))
    const start = before === null ? 0 : records.findIndex((record) => record.taskId === before) + 1
    if (before !== null && start === 0) throw Object.assign(new TypeError('TASK_LIST_CURSOR_INVALID'), { code: 'TASK_LIST_CURSOR_INVALID' })
    return records.slice(start, limit === Infinity ? undefined : start + limit).map((record) => structuredClone(record))
  }

  active() {
    return [...this.#records.values()].filter((record) => ['queued', 'running'].includes(record.status)).map((record) => structuredClone(record))
  }

  reserveAdmission({ requestId, requestHash, operation, destination = {}, taskId = null, messageId = null, capturedDefaults = null } = {}) {
    return this.#mutate(async () => {
      if (!boundedString(requestId, 256) || !/^[0-9a-f]{64}$/.test(requestHash ?? '') || !ADMISSION_OPERATIONS.has(operation)
        || !isRecord(destination) || (taskId !== null && !boundedString(taskId, 256))
        || (messageId !== null && !boundedString(messageId, 256))) {
        throw taskError('TASK_ADMISSION_INVALID')
      }
      let comparableDestination
      let comparableDefaults = null
      try {
        comparableDestination = cloneBoundedResult(destination)
        comparableDefaults = capturedDefaults === null || capturedDefaults === undefined ? null : cloneBoundedResult(capturedDefaults)
      } catch {
        throw taskError('TASK_ADMISSION_INVALID')
      }
      const existing = this.#admissions.get(requestId)
      if (existing) {
        if (existing.requestHash !== requestHash
          || existing.operation !== operation
          || JSON.stringify(existing.destination) !== JSON.stringify(comparableDestination)
          || (capturedDefaults !== null && capturedDefaults !== undefined
            && JSON.stringify(existing.capturedDefaults ?? null) !== JSON.stringify(comparableDefaults))
          || (taskId !== null && existing.taskId && existing.taskId !== taskId)
          || (messageId !== null && existing.messageId && existing.messageId !== messageId)) throw taskError('TASK_ADMISSION_CONFLICT')
        return { ...structuredClone(existing), replayed: true }
      }
      const at = new Date(this.now()).toISOString()
      const admission = {
        schema: ADMISSION_SCHEMA,
        requestId,
        requestHash,
        operation,
        status: 'reserved',
        destination: comparableDestination,
        ...(taskId ? { taskId } : {}),
        ...(messageId ? { messageId } : {}),
        ...(comparableDefaults === null ? {} : { capturedDefaults: comparableDefaults }),
        reservedAt: at,
      }
      await this.#append({ schema: TASK_LEDGER_SCHEMA, event: 'admission-reserved', at, admission })
      this.#admissions.set(requestId, admission)
      await Promise.resolve(this.audit.append({ kind: 'ceo.task.admission.reserved', requestId, operation, at }))
      return structuredClone(admission)
    })
  }

  completeAdmission({ requestId, status = 'accepted', taskId = null, messageId = null, reason = null } = {}) {
    return this.#mutate(async () => {
      if (!boundedString(requestId, 256) || !['accepted', 'unknown', 'failed'].includes(status)
        || (taskId !== null && !boundedString(taskId, 256)) || (messageId !== null && !boundedString(messageId, 256))
        || (reason !== null && !boundedString(reason, 256))) throw taskError('TASK_ADMISSION_INVALID')
      const current = this.#admissions.get(requestId)
      if (!current) throw taskError('TASK_ADMISSION_NOT_FOUND')
      if ((current.taskId && taskId && current.taskId !== taskId)
        || (current.messageId && messageId && current.messageId !== messageId)) throw taskError('TASK_ADMISSION_CONFLICT')
      if (current.status === 'accepted' && status === 'unknown' && reason !== 'ADMISSION_RECEIPT_UNCERTAIN') {
        throw taskError('TASK_ADMISSION_TERMINAL')
      }
      if (current.status === 'failed' || current.status === 'accepted') {
        if (status === current.status && (taskId === null || taskId === current.taskId) && (messageId === null || messageId === current.messageId)) return structuredClone(current)
        if (!(current.status === 'accepted' && status === 'unknown' && reason === 'ADMISSION_RECEIPT_UNCERTAIN')) throw taskError('TASK_ADMISSION_TERMINAL')
      }
      if (current.status === 'unknown') throw taskError('TASK_ADMISSION_TERMINAL')
      const at = new Date(this.now()).toISOString()
      const next = {
        ...current,
        status,
        ...(taskId ? { taskId } : {}),
        ...(messageId ? { messageId } : {}),
        ...(reason ? { reason } : {}),
        completedAt: at,
      }
      await this.#append({ schema: TASK_LEDGER_SCHEMA, event: 'admission-completed', at, admission: next })
      this.#admissions.set(requestId, next)
      await Promise.resolve(this.audit.append({ kind: 'ceo.task.admission.completed', requestId, operation: current.operation, status, at }))
      return structuredClone(next)
    })
  }

  getAdmission(requestId) {
    const admission = this.#admissions.get(requestId)
    return admission ? structuredClone(admission) : null
  }

  getAdmissionByTask(taskId) {
    if (!boundedString(taskId, 256)) return null
    const admission = [...this.#admissions.values()].find((candidate) => candidate.taskId === taskId)
    return admission ? structuredClone(admission) : null
  }

  listAdmissions() {
    return [...this.#admissions.values()].map((admission) => structuredClone(admission))
  }

  resumeQueued(taskId, { requestId = null, requestHash = null, expectedDestinationRevision = null } = {}) {
    return this.#mutate(async () => {
      const current = this.#records.get(taskId)
      if (!current || current.status !== 'queued' || !current.queuedForExecution) throw taskError('TASK_NOT_QUEUED')
      const admissionBinding = validateAdmissionBinding(requestId, requestHash)
      if (expectedDestinationRevision !== null && expectedDestinationRevision !== undefined
        && (!Number.isSafeInteger(expectedDestinationRevision) || expectedDestinationRevision < 0)) {
        throw taskError('TASK_DESTINATION_REVISION_INVALID')
      }
      if (expectedDestinationRevision !== null && expectedDestinationRevision !== undefined
        && current.destinationRevision !== expectedDestinationRevision) throw taskError('TASK_DESTINATION_STALE')
      const admission = admissionBinding ? this.#admissions.get(admissionBinding.requestId) : null
      if (admissionBinding && (!admission || admission.status !== 'reserved' || admission.operation !== 'resume-queued'
        || admission.requestHash !== admissionBinding.requestHash || admission.taskId !== taskId
        || admission.destination?.taskId !== taskId
        || !Number.isSafeInteger(admission.destination?.expectedDestinationRevision)
        || admission.destination.expectedDestinationRevision !== current.destinationRevision
        || (expectedDestinationRevision !== null && expectedDestinationRevision !== undefined
          && admission.destination.expectedDestinationRevision !== expectedDestinationRevision))) {
        throw taskError('TASK_ADMISSION_CONFLICT')
      }
      const at = new Date(this.now()).toISOString()
      const destinationRevision = (current.destinationRevision ?? 0) + 1
      const completedAdmission = admission ? {
        ...admission,
        status: 'accepted',
        taskId,
        completedAt: at,
      } : null
      const queueResume = admissionBinding ? {
        requestId: admissionBinding.requestId,
        requestHash: admissionBinding.requestHash,
        expectedDestinationRevision: current.destinationRevision,
        destinationRevision,
        at,
      } : null
      await this.#append({ schema: TASK_LEDGER_SCHEMA, event: 'queue-resumed', taskId, at, destinationRevision,
        ...(completedAdmission ? { admission: completedAdmission } : {}), ...(queueResume ? { queueResume } : {}) })
      const next = { ...current, recoveryRequired: false, destinationRevision, ...(queueResume ? { queueResume } : {}) }
      this.#records.set(taskId, next)
      if (completedAdmission) this.#admissions.set(admissionBinding.requestId, completedAdmission)
      this.audit.append({ kind: 'ceo.task.queue-resumed', taskId, at })
      return structuredClone(next)
    })
  }

  reviseDestination(taskId, expectedDestinationRevision = null) {
    return this.#mutate(async () => {
      const current = this.#records.get(taskId)
      if (!current) throw Object.assign(new Error('TASK_NOT_FOUND'), { code: 'TASK_NOT_FOUND' })
      if (expectedDestinationRevision !== null && expectedDestinationRevision !== undefined
        && current.destinationRevision !== expectedDestinationRevision) throw taskError('TASK_DESTINATION_STALE')
      const at = new Date(this.now()).toISOString()
      const destinationRevision = (current.destinationRevision ?? 0) + 1
      await this.#append({ schema: TASK_LEDGER_SCHEMA, event: 'destination-revised', taskId, at, destinationRevision })
      const next = { ...current, destinationRevision }
      this.#records.set(taskId, next)
      return structuredClone(next)
    })
  }

  async #pauseQueued(taskId) {
    const current = this.#records.get(taskId)
    if (current.recoveryRequired) return
    const at = new Date(this.now()).toISOString()
    await this.#append({ schema: TASK_LEDGER_SCHEMA, event: 'queue-paused', taskId, at })
    this.#records.set(taskId, { ...current, recoveryRequired: true, destinationRevision: (current.destinationRevision ?? 0) + 1 })
    this.audit.append({ kind: 'ceo.task.queue-paused', taskId, at, reason: 'PROCESS_RESTARTED' })
  }

  async #interrupt(taskId) {
    const current = this.#records.get(taskId)
    const interruptedAt = new Date(this.now()).toISOString()
    const failure = {
      code: 'TASK_INTERRUPTED_BY_RESTART',
      message: 'The prior process ended before the task reached a durable terminal state.',
    }
    await this.#append({
      schema: TASK_LEDGER_SCHEMA,
      event: 'interrupted',
      at: interruptedAt,
      taskId,
      failure,
      retryable: false,
    })
    this.#records.set(taskId, {
      ...current,
      status: 'interrupted',
      destinationRevision: (current.destinationRevision ?? 0) + 1,
      failure,
      retryable: false,
      interruptedAt,
    })
    this.audit.append({ kind: 'ceo.task.interrupted', taskId, ...failure, at: interruptedAt })
  }

  #mutate(operation) {
    const guarded = () => {
      if (this.closed) throw new Error('TASK_LEDGER_CLOSED')
      return operation()
    }
    const result = this.#writes.then(guarded, guarded)
    this.#writes = result.catch(() => {})
    return result
  }

  async #append(event) {
    await appendFile(this.filePath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600, flush: true })
  }

  #restore(event) {
    if (!isRecord(event) || event.schema !== TASK_LEDGER_SCHEMA || !boundedString(event.event, 64)) {
      throw new TypeError('invalid task ledger event')
    }
    if (event.event === 'submitted') {
      const task = event.task
      if (!isRecord(task)
        || task.schema !== TASK_LEDGER_SCHEMA
        || !boundedString(task.taskId, 256)
        || !boundedString(task.objective)
        || task.status !== 'queued'
        || this.#records.has(task.taskId)) {
        throw new TypeError('invalid task submission event')
      }
      const hasAdmissionBindingField = Object.prototype.hasOwnProperty.call(task, 'admissionRequestId')
        || Object.prototype.hasOwnProperty.call(task, 'admissionRequestHash')
      if (hasAdmissionBindingField && (!boundedString(task.admissionRequestId, 256) || !/^[0-9a-f]{64}$/.test(task.admissionRequestHash ?? ''))) {
        throw new TypeError('invalid task admission binding')
      }
      const admissionBinding = validateAdmissionBinding(task.admissionRequestId, task.admissionRequestHash)
      if (admissionBinding
        && (task.admissionRequestId !== admissionBinding.requestId || task.admissionRequestHash !== admissionBinding.requestHash)) {
        throw new TypeError('invalid task admission binding')
      }
      validateModel(task.model)
      if (task.queuedForExecution !== undefined && (task.queuedForExecution !== true
        || !isRecord(task.context)
        || (!boundedString(task.context.projectId, 256) && task.context.queueScope !== 'root')
        || task.recoveryRequired !== false)) throw new TypeError('invalid queued task event')
      if (!task.queuedForExecution && hasActiveTask(this.#records.values())) throw new TypeError('invalid concurrent task submission event')
      if (task.queuedForExecution && this.active().filter(row => row.status === 'queued' && row.queuedForExecution).length >= MAX_QUEUED_PROJECT_TASKS) throw new TypeError('invalid task queue capacity')
      this.#records.set(task.taskId, structuredClone(task))
      return
    }
    if (event.event === 'admission-reserved' || event.event === 'admission-completed') {
      const admission = event.admission
      if (!isRecord(admission) || admission.schema !== ADMISSION_SCHEMA
        || !boundedString(admission.requestId, 256) || !/^[0-9a-f]{64}$/.test(admission.requestHash ?? '')
        || !ADMISSION_OPERATIONS.has(admission.operation) || !['reserved', 'accepted', 'unknown', 'failed'].includes(admission.status)
        || !isRecord(admission.destination)) throw new TypeError('invalid task admission event')
      const prior = this.#admissions.get(admission.requestId)
      if (event.event === 'admission-reserved') {
        if (admission.status !== 'reserved' || prior) throw new TypeError('invalid task admission reservation')
        this.#admissions.set(admission.requestId, structuredClone(admission))
        return
      }
      if (!prior || prior.requestHash !== admission.requestHash || prior.operation !== admission.operation
        || JSON.stringify(prior.destination) !== JSON.stringify(admission.destination)
        || JSON.stringify(prior.capturedDefaults ?? null) !== JSON.stringify(admission.capturedDefaults ?? null)
        || (prior.taskId && admission.taskId && prior.taskId !== admission.taskId)
        || (prior.messageId && admission.messageId && prior.messageId !== admission.messageId)) throw new TypeError('invalid task admission completion')
      const allowed = (prior.status === 'reserved' && ['accepted', 'unknown', 'failed'].includes(admission.status))
        || (prior.status === 'accepted' && admission.status === 'unknown' && admission.reason === 'ADMISSION_RECEIPT_UNCERTAIN')
        || (prior.status === admission.status && ['accepted', 'unknown', 'failed'].includes(admission.status))
      if (!allowed) throw new TypeError('invalid task admission transition')
      this.#admissions.set(admission.requestId, structuredClone(admission))
      return
    }
    const current = this.#records.get(event.taskId)
    if (!current) throw new TypeError('task event precedes submission')
    if (event.event === 'plan-recorded') {
      if (!boundedString(event.at, 128) || !isRecord(event.plan) || event.plan.schema !== TASK_PLAN_SCHEMA) {
        throw new TypeError('invalid task plan event')
      }
      const requested = validatePlanInput(event.plan)
      if (TASK_TERMINAL_STATUSES.has(current.status)) throw new TypeError('invalid task plan transition')
      if (current.plan) {
        if (requested.revision < current.plan.revision) throw new TypeError('invalid stale task plan event')
        if (requested.revision === current.plan.revision && !planEqual(current.plan, requested)) throw new TypeError('invalid conflicting task plan event')
        if (requested.revision === current.plan.revision) return
        if ((current.steps ?? []).some((step) => step.status !== 'queued')) throw new TypeError('invalid active task plan event')
      }
      const plan = {
        schema: TASK_PLAN_SCHEMA,
        revision: requested.revision,
        planHash: requested.planHash,
        nodes: structuredClone(requested.nodes),
      }
      this.#records.set(event.taskId, {
        ...current,
        plan,
        steps: plan.nodes.map((node) => ({ nodeId: node.nodeId, status: 'queued', history: [] })),
      })
      return
    }
    if (event.event === 'step-recorded') {
      if (!boundedString(event.at, 128) || !isRecord(event.step)) throw new TypeError('invalid task step event')
      const step = validateStepInput(event.step)
      if (event.step.at !== undefined && event.step.at !== event.at) throw new TypeError('invalid task step timestamp')
      if (!current.plan || step.revision !== current.plan.revision) throw new TypeError('invalid stale task step event')
      if (!current.plan.nodes.some((node) => node.nodeId === step.nodeId)) throw new TypeError('invalid task step node')
      const steps = [...(current.steps ?? [])]
      const index = steps.findIndex((candidate) => candidate.nodeId === step.nodeId)
      if (index < 0) throw new TypeError('invalid task step node')
      const prior = steps[index]
      if (!allowedStepTransition(prior.status, step.status)) throw new TypeError('invalid task step transition')
      if (prior.status === step.status) {
        const priorMessageId = prior.messageId ?? null
        const priorResultId = prior.resultId ?? null
        const priorReason = prior.reason ?? null
        const sameMetadata = (step.messageId === null || priorMessageId === null || step.messageId === priorMessageId)
          && (step.resultId === null || priorResultId === null || step.resultId === priorResultId)
          && (step.reason === null || priorReason === null || step.reason === priorReason)
        if (!sameMetadata || (TASK_STEP_TERMINAL_STATUSES.has(prior.status)
          && ((step.messageId !== null && step.messageId !== priorMessageId)
            || (step.resultId !== null && step.resultId !== priorResultId)
            || (step.reason !== null && step.reason !== priorReason)))) {
          throw new TypeError('invalid task step transition')
        }
        if (TASK_STEP_TERMINAL_STATUSES.has(prior.status)
          || ((step.messageId === null || step.messageId === priorMessageId)
            && (step.resultId === null || step.resultId === priorResultId)
            && (step.reason === null || step.reason === priorReason))) return
        const transition = {
          status: step.status,
          at: event.at,
          ...(step.messageId !== null ? { messageId: step.messageId } : {}),
          ...(step.resultId !== null ? { resultId: step.resultId } : {}),
          ...(step.reason !== null ? { reason: step.reason } : {}),
        }
        steps[index] = {
          ...prior,
          messageId: step.messageId !== null ? step.messageId : (prior.messageId ?? null),
          resultId: step.resultId !== null ? step.resultId : (prior.resultId ?? null),
          reason: step.reason !== null ? step.reason : (prior.reason ?? null),
          updatedAt: event.at,
          history: [...(prior.history ?? []), transition].slice(-TASK_PLAN_MAX_HISTORY),
        }
        this.#records.set(event.taskId, { ...current, steps })
        return
      }
      const transition = {
        status: step.status,
        at: event.at,
        ...(step.messageId !== null ? { messageId: step.messageId } : {}),
        ...(step.resultId !== null ? { resultId: step.resultId } : {}),
        ...(step.reason !== null ? { reason: step.reason } : {}),
      }
      steps[index] = {
        ...prior,
        status: step.status,
        messageId: step.messageId !== null ? step.messageId : (prior.messageId ?? null),
        resultId: step.resultId !== null ? step.resultId : (prior.resultId ?? null),
        reason: step.reason !== null ? step.reason : (prior.reason ?? null),
        updatedAt: event.at,
        history: [...(prior.history ?? []), transition].slice(-TASK_PLAN_MAX_HISTORY),
      }
      this.#records.set(event.taskId, { ...current, steps })
      return
    }
    if (event.event === 'queue-paused' || event.event === 'queue-resumed') {
      if (current.status !== 'queued' || !current.queuedForExecution) throw new TypeError('invalid task queue transition')
      if (event.event === 'queue-resumed' && event.admission !== undefined) {
        const admission = event.admission
        const prior = admission?.requestId ? this.#admissions.get(admission.requestId) : null
        const expectedDestinationRevision = event.queueResume?.expectedDestinationRevision
        if (!isRecord(admission) || admission.schema !== ADMISSION_SCHEMA || admission.status !== 'accepted'
          || admission.operation !== 'resume-queued' || admission.taskId !== event.taskId
          || admission.destination?.taskId !== event.taskId || !prior || prior.status !== 'reserved'
          || prior.requestHash !== admission.requestHash || prior.operation !== admission.operation
          || JSON.stringify(prior.destination) !== JSON.stringify(admission.destination)
          || JSON.stringify(prior.capturedDefaults ?? null) !== JSON.stringify(admission.capturedDefaults ?? null)
          || !isRecord(event.queueResume)
          || event.queueResume.requestId !== admission.requestId
          || event.queueResume.requestHash !== admission.requestHash
          || !Number.isSafeInteger(expectedDestinationRevision)
          || expectedDestinationRevision !== (current.destinationRevision ?? 0)
          || !Number.isSafeInteger(event.destinationRevision)
          || event.destinationRevision !== expectedDestinationRevision + 1) throw new TypeError('invalid queued resume admission')
        this.#admissions.set(admission.requestId, structuredClone(admission))
      } else if (event.event === 'queue-resumed' && event.queueResume !== undefined) {
        throw new TypeError('invalid queued resume admission')
      }
      const destinationRevision = Number.isSafeInteger(event.destinationRevision)
        ? event.destinationRevision : (current.destinationRevision ?? 0) + 1
      if (destinationRevision <= (current.destinationRevision ?? 0)) throw new TypeError('invalid task queue revision')
      this.#records.set(event.taskId, { ...current, recoveryRequired: event.event === 'queue-paused', destinationRevision,
        ...(event.event === 'queue-resumed' && event.queueResume ? { queueResume: structuredClone(event.queueResume) } : {}) })
      return
    }
    if (event.event === 'destination-revised') {
      if (!Number.isSafeInteger(event.destinationRevision) || event.destinationRevision <= (current.destinationRevision ?? 0)) throw new TypeError('invalid destination revision event')
      this.#records.set(event.taskId, { ...current, destinationRevision: event.destinationRevision })
      return
    }
    if (event.event === 'checkpoint') {
      if (!isRecord(event.checkpoint) || !boundedString(event.checkpoint.stage, 64)) throw new TypeError('invalid task checkpoint event')
      const checkpoint = { ...cloneBoundedResult(event.checkpoint), at: event.at }
      this.#records.set(event.taskId, { ...current, checkpoint,
        ...(['tool-completed', 'specialist-completed'].includes(checkpoint.stage)
          && [undefined, 'completed', 'succeeded'].includes(checkpoint.effectOutcome) ? { lastCompletedWork: checkpoint } : {}),
      })
      return
    }
    if (event.event === 'evidence-recorded') {
      if (!boundedString(event.at, 128)) throw new TypeError('invalid task evidence timestamp')
      const receipt = validateEvidenceReceipt(event.receipt, event.taskId)
      const existing = (current.evidence ?? []).find(item => item.receiptId === receipt.receiptId)
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(receipt)) throw new TypeError('conflicting task evidence event')
        return
      }
      const wasAtCapacity = (current.evidence ?? []).length >= MAX_EVIDENCE
      const evidenceTruncated = current.evidenceTruncated === true || event.evidenceTruncated === true || wasAtCapacity
      this.#records.set(event.taskId, { ...current,
        evidence: [...(current.evidence ?? []), receipt].slice(-MAX_EVIDENCE),
        ...(evidenceTruncated ? { evidenceTruncated: true } : {}),
      })
      return
    }
    if (event.event === 'routing') {
      const routing = cloneBoundedResult(event.routing)
      if (!isRecord(routing) || routing.schema !== 'chimera.routing-explanation.v1'
        || !Array.isArray(routing.candidates) || routing.candidates.length > 64
        || (routing.selected !== null && !isRecord(routing.selected))
        || Buffer.byteLength(JSON.stringify(routing), 'utf8') > MAX_ROUTING_BYTES) {
        throw new TypeError('invalid task routing event')
      }
      this.#records.set(event.taskId, { ...current, routing })
      return
    }
    if (event.event === 'steered') {
      if (!['queued', 'running'].includes(current.status) || !boundedString(event.steering?.content, 4096)) throw new TypeError('invalid task steering event')
      if (event.steering.requestId !== undefined && (!boundedString(event.steering.requestId, 256) || !/^[0-9a-f]{64}$/.test(event.steering.requestHash ?? ''))) throw new TypeError('invalid task steering request')
      if (event.steering.sequence !== (current.steering?.at(-1)?.sequence ?? 0) + 1) throw new TypeError('invalid task steering sequence')
      if (event.admission !== undefined) {
        const admission = event.admission
        const prior = admission?.requestId ? this.#admissions.get(admission.requestId) : null
        if (!isRecord(admission) || admission.schema !== ADMISSION_SCHEMA || admission.status !== 'accepted'
          || admission.operation !== 'task-steer' || admission.taskId !== event.taskId
          || admission.destination?.taskId !== event.taskId || !prior || prior.status !== 'reserved'
          || prior.requestHash !== admission.requestHash || prior.operation !== admission.operation
          || JSON.stringify(prior.destination) !== JSON.stringify(admission.destination)
          || JSON.stringify(prior.capturedDefaults ?? null) !== JSON.stringify(admission.capturedDefaults ?? null)
          || event.steering.requestId !== admission.requestId || event.steering.requestHash !== admission.requestHash) throw new TypeError('invalid task steering admission')
        this.#admissions.set(admission.requestId, structuredClone(admission))
      }
      this.#records.set(event.taskId, { ...current, destinationRevision: (current.destinationRevision ?? 0) + 1, steering: [...(current.steering ?? []), structuredClone(event.steering)].slice(-16) })
      return
    }
    if (event.event === 'cancelled') {
      if (!['queued', 'running'].includes(current.status) || !boundedString(event.summary)) throw new TypeError('invalid task cancellation event')
      this.#records.set(event.taskId, { ...current, status: 'cancelled', destinationRevision: (current.destinationRevision ?? 0) + 1, cancelledAt: event.at, summary: event.summary, retryable: false })
      return
    }
    if (event.event === 'started') {
      if (current.status !== 'queued' || current.recoveryRequired
        || [...this.#records.values()].some(row => row.status === 'running')) throw new TypeError('invalid task start event')
      this.#records.set(event.taskId, { ...current, status: 'running', destinationRevision: Number.isSafeInteger(event.destinationRevision) ? event.destinationRevision : (current.destinationRevision ?? 0) + 1, startedAt: event.at })
      return
    }
    if (event.event === 'completed') {
      if (current.status !== 'running' || !boundedString(event.summary)) {
        throw new TypeError('invalid task completion event')
      }
      this.#records.set(event.taskId, {
        ...current,
        status: 'completed',
        destinationRevision: Number.isSafeInteger(event.destinationRevision) ? event.destinationRevision : (current.destinationRevision ?? 0) + 1,
        summary: event.summary,
        result: cloneBoundedResult(event.result),
        completedAt: event.at,
      })
      return
    }
    if (event.event === 'failed' || event.event === 'interrupted') {
      if (!['queued', 'running'].includes(current.status)
        || !isRecord(event.failure)
        || !boundedString(event.failure.code, 256)
        || !boundedString(event.failure.message)) {
        throw new TypeError('invalid task failure event')
      }
      this.#records.set(event.taskId, {
        ...current,
        status: event.event,
        destinationRevision: Number.isSafeInteger(event.destinationRevision) ? event.destinationRevision : (current.destinationRevision ?? 0) + 1,
        failure: structuredClone(event.failure),
        retryable: false,
        [`${event.event}At`]: event.at,
      })
      return
    }
    throw new TypeError('unknown task ledger event')
  }
}
