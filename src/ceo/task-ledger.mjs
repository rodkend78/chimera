import { appendFile, mkdir, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

export const TASK_LEDGER_SCHEMA = 'chimera.task-ledger.v1'
const MAX_RESULT_BYTES = 2 * 1024 * 1024
const OPEN_TOKEN = Symbol('chimera-task-ledger-open')
const OPEN_LEDGER_OWNERS = new Map()
const MAX_QUEUED_PROJECT_TASKS = 32

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

export class DurableTaskLedger {
  #records = new Map()
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

  submit({ taskId, objective, model, context = {}, queue = false }) {
    return this.#mutate(async () => {
      if (!boundedString(taskId, 256) || !boundedString(objective)) {
        throw new TypeError('invalid task submission')
      }
      if (this.#records.has(taskId)) throw new Error('TASK_ALREADY_EXISTS')
      if (typeof queue !== 'boolean') throw new TypeError('TASK_QUEUE_INVALID')
      if (queue && (!isRecord(context) || !boundedString(context.projectId, 256))) throw taskError('TASK_QUEUE_PROJECT_REQUIRED')
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
        ...(queue ? { queuedForExecution: true, recoveryRequired: false } : {}),
        retryable: false,
        submittedAt,
      }
      await this.#append({ schema: TASK_LEDGER_SCHEMA, event: 'submitted', at: submittedAt, task: record })
      this.#records.set(taskId, record)
      this.audit.append({ kind: 'ceo.task.submitted', taskId, model: record.model, at: submittedAt })
      return structuredClone(record)
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
      const normalized = {
        code: boundedString(failure?.code, 256) ? failure.code : 'TASK_FAILED',
        message: boundedString(failure?.message) ? failure.message : 'The task failed.',
      }
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

  steer(taskId, content) {
    return this.#mutate(async () => {
      const current = this.#records.get(taskId)
      if (!current || !['queued', 'running'].includes(current.status)) throw Object.assign(new Error('TASK_NOT_ACTIVE'), { code: 'TASK_NOT_ACTIVE' })
      if (!boundedString(content, 4096)) throw new TypeError('TASK_STEERING_INVALID')
      const steering = { sequence: (current.steering?.at(-1)?.sequence ?? 0) + 1, content, at: new Date(this.now()).toISOString() }
      await this.#append({ schema: TASK_LEDGER_SCHEMA, event: 'steered', taskId, at: steering.at, steering })
      const next = { ...current, steering: [...(current.steering ?? []), steering].slice(-16) }
      this.#records.set(taskId, next)
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

  resumeQueued(taskId) {
    return this.#mutate(async () => {
      const current = this.#records.get(taskId)
      if (!current || current.status !== 'queued' || !current.queuedForExecution) throw taskError('TASK_NOT_QUEUED')
      const at = new Date(this.now()).toISOString()
      await this.#append({ schema: TASK_LEDGER_SCHEMA, event: 'queue-resumed', taskId, at })
      const next = { ...current, recoveryRequired: false }
      this.#records.set(taskId, next)
      this.audit.append({ kind: 'ceo.task.queue-resumed', taskId, at })
      return structuredClone(next)
    })
  }

  async #pauseQueued(taskId) {
    const current = this.#records.get(taskId)
    if (current.recoveryRequired) return
    const at = new Date(this.now()).toISOString()
    await this.#append({ schema: TASK_LEDGER_SCHEMA, event: 'queue-paused', taskId, at })
    this.#records.set(taskId, { ...current, recoveryRequired: true })
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
      validateModel(task.model)
      if (task.queuedForExecution !== undefined && (task.queuedForExecution !== true
        || !isRecord(task.context) || !boundedString(task.context.projectId, 256)
        || task.recoveryRequired !== false)) throw new TypeError('invalid queued project task event')
      if (!task.queuedForExecution && hasActiveTask(this.#records.values())) throw new TypeError('invalid concurrent task submission event')
      if (task.queuedForExecution && this.active().filter(row => row.status === 'queued' && row.queuedForExecution).length >= MAX_QUEUED_PROJECT_TASKS) throw new TypeError('invalid task queue capacity')
      this.#records.set(task.taskId, structuredClone(task))
      return
    }
    const current = this.#records.get(event.taskId)
    if (!current) throw new TypeError('task event precedes submission')
    if (event.event === 'queue-paused' || event.event === 'queue-resumed') {
      if (current.status !== 'queued' || !current.queuedForExecution) throw new TypeError('invalid task queue transition')
      this.#records.set(event.taskId, { ...current, recoveryRequired: event.event === 'queue-paused' })
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
    if (event.event === 'steered') {
      if (!['queued', 'running'].includes(current.status) || !boundedString(event.steering?.content, 4096)) throw new TypeError('invalid task steering event')
      this.#records.set(event.taskId, { ...current, steering: [...(current.steering ?? []), structuredClone(event.steering)].slice(-16) })
      return
    }
    if (event.event === 'cancelled') {
      if (!['queued', 'running'].includes(current.status) || !boundedString(event.summary)) throw new TypeError('invalid task cancellation event')
      this.#records.set(event.taskId, { ...current, status: 'cancelled', cancelledAt: event.at, summary: event.summary, retryable: false })
      return
    }
    if (event.event === 'started') {
      if (current.status !== 'queued' || current.recoveryRequired
        || [...this.#records.values()].some(row => row.status === 'running')) throw new TypeError('invalid task start event')
      this.#records.set(event.taskId, { ...current, status: 'running', startedAt: event.at })
      return
    }
    if (event.event === 'completed') {
      if (current.status !== 'running' || !boundedString(event.summary)) {
        throw new TypeError('invalid task completion event')
      }
      this.#records.set(event.taskId, {
        ...current,
        status: 'completed',
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
        failure: structuredClone(event.failure),
        retryable: false,
        [`${event.event}At`]: event.at,
      })
      return
    }
    throw new TypeError('unknown task ledger event')
  }
}
