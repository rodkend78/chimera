import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const ROUTING_EVIDENCE_SCHEMA = 'chimera.routing-evidence.v1'
export const ROUTING_EVIDENCE_SNAPSHOT_SCHEMA = 'chimera.routing-evidence-snapshot.v1'

// Keep evidence identity bounds aligned with task requirements and model
// policy identifiers. Evidence must not reject a valid configured 512-byte
// model id merely because it is being restored or measured.
const MAX_ID = 512
const MAX_BUCKETS = 256
const MAX_SAMPLES_PER_BUCKET = 64
const MAX_DURATION_MS = 24 * 60 * 60 * 1000
const MAX_COST = 1_000_000
const OUTCOMES = new Set(['succeeded', 'failed-not-sent', 'unknown'])
const COST_SOURCES = new Set(['measured', 'operator-estimate'])

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function bounded(value, maximum = MAX_ID) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/.test(value)
}

function fail(code) {
  return Object.assign(new TypeError(code), { code })
}

function keyFor({ providerId, model, capability }) {
  return `${providerId}\u0000${model}\u0000${capability}`
}

function median(values) {
  if (!values.length) return null
  const ordered = [...values].sort((left, right) => left - right)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2
}

function validateIdentity(input) {
  if (!record(input) || !bounded(input.providerId) || !bounded(input.model) || !bounded(input.capability)) {
    throw fail('ROUTING_EVIDENCE_INPUT_INVALID')
  }
}

function validateCost(cost) {
  if (cost === null) return null
  if (!record(cost) || Object.keys(cost).some(key => !['usd', 'source', 'evidenceRef'].includes(key))
    || typeof cost.usd !== 'number' || !Number.isFinite(cost.usd) || cost.usd < 0 || cost.usd > MAX_COST
    || !COST_SOURCES.has(cost.source) || typeof cost.evidenceRef !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(cost.evidenceRef)) {
    throw fail('ROUTING_EVIDENCE_VALUE_INVALID')
  }
  return { usd: cost.usd, source: cost.source, evidenceRef: cost.evidenceRef }
}

function validateInvocation(input) {
  if (!record(input) || Object.keys(input).some(key => !['providerId', 'model', 'capability', 'outcome', 'durationMs', 'cost'].includes(key))) {
    throw fail('ROUTING_EVIDENCE_INPUT_INVALID')
  }
  validateIdentity(input)
  if (!OUTCOMES.has(input.outcome)) throw fail('ROUTING_EVIDENCE_VALUE_INVALID')
  if (input.durationMs !== null && (!Number.isFinite(input.durationMs) || input.durationMs < 0 || input.durationMs > MAX_DURATION_MS)) {
    throw fail('ROUTING_EVIDENCE_VALUE_INVALID')
  }
  if (input.outcome === 'failed-not-sent' && input.durationMs !== null) throw fail('ROUTING_EVIDENCE_VALUE_INVALID')
  const cost = validateCost(input.cost)
  return {
    providerId: input.providerId,
    model: input.model,
    capability: input.capability,
    outcome: input.outcome,
    durationMs: input.durationMs,
    cost,
  }
}

function emptyDocument() {
  return { schema: ROUTING_EVIDENCE_SCHEMA, buckets: {} }
}

export class RoutingEvidenceStore {
  #document
  #writeTail = Promise.resolve()

  constructor({ filePath, audit, now = () => Date.now() } = {}) {
    if (!bounded(filePath, 4096)) throw fail('ROUTING_EVIDENCE_PATH_INVALID')
    this.filePath = filePath
    this.audit = audit ?? null
    this.now = now
    this.#document = emptyDocument()
  }

  static async open(options = {}) {
    const store = new RoutingEvidenceStore(options)
    await mkdir(dirname(store.filePath), { recursive: true, mode: 0o700 })
    try {
      const parsed = JSON.parse(await readFile(store.filePath, 'utf8'))
      store.#restore(parsed)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    return store
  }

  async recordInvocation(input) {
    const sample = validateInvocation(input)
    return this.#write(async () => {
      const observedAt = new Date(this.now()).toISOString()
      const identity = { providerId: sample.providerId, model: sample.model, capability: sample.capability }
      const key = keyFor(identity)
      const previous = this.#document.buckets[key]
      const samples = [...(previous?.samples ?? []), { ...sample, observedAt }].slice(-MAX_SAMPLES_PER_BUCKET)
      const buckets = { ...this.#document.buckets, [key]: { ...identity, samples } }
      const keys = Object.keys(buckets)
      if (keys.length > MAX_BUCKETS) delete buckets[keys.toSorted()[0]]
      const next = { schema: ROUTING_EVIDENCE_SCHEMA, buckets }
      await this.#persist(next)
      this.#document = next
      await Promise.resolve().then(() => this.audit?.append({
        kind: 'routing.evidence.recorded',
        ...identity,
        outcome: sample.outcome,
        durationMs: sample.durationMs,
        hasCost: sample.cost !== null,
        at: observedAt,
      })).catch(() => {})
      return structuredClone({ ...sample, observedAt })
    })
  }

  snapshot(identity) {
    validateIdentity(identity)
    const bucket = this.#document.buckets[keyFor(identity)]
    const samples = bucket?.samples ?? []
    const resolved = samples.filter(sample => sample.outcome !== 'unknown')
    const successes = samples.filter(sample => sample.outcome === 'succeeded')
    const failures = samples.filter(sample => sample.outcome === 'failed-not-sent')
    const durations = successes.map(sample => sample.durationMs).filter(value => Number.isFinite(value))
    const costs = samples.map(sample => sample.cost).filter(Boolean)
    const reliability = resolved.length >= 5
      ? { status: 'measured', resolvedSamples: resolved.length, successRatio: successes.length / resolved.length }
      : { status: 'insufficient-evidence', resolvedSamples: resolved.length, requiredSamples: 5 }
    const latency = durations.length >= 3
      ? { status: 'measured', successSamples: durations.length, medianMs: median(durations) }
      : { status: 'insufficient-evidence', successSamples: durations.length, requiredSamples: 3 }
    const costSources = new Set(costs.map(value => value.source))
    const cost = costs.length === 0
      ? { status: 'unknown' }
      : {
          // Operator estimates can be compared for the Economy preset, but
          // they are never promoted to measured billing evidence. A mixed
          // bucket remains explicitly estimated for the same reason.
          status: costSources.size === 1 && costSources.has('measured') ? 'measured' : 'estimated',
          samples: costs.length,
          medianUsd: median(costs.map(value => value.usd)),
          source: costSources.size === 1 ? costs[0].source : 'mixed',
        }
    return {
      schema: ROUTING_EVIDENCE_SNAPSHOT_SCHEMA,
      providerId: identity.providerId,
      model: identity.model,
      capability: identity.capability,
      sampleCount: samples.length,
      resolvedSamples: resolved.length,
      successSamples: successes.length,
      failedNotSentSamples: failures.length,
      unknownSamples: samples.length - resolved.length,
      reliability,
      latency,
      quality: { status: 'declared-unknown' },
      cost,
      eligible: reliability.status === 'measured' && latency.status === 'measured',
      observedAt: samples.at(-1)?.observedAt ?? null,
    }
  }

  async close() {
    await this.#writeTail
  }

  async #persist(document) {
    const temporary = `${this.filePath}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`
    try {
      await writeFile(temporary, `${JSON.stringify(document)}\n`, { encoding: 'utf8', mode: 0o600 })
      await chmod(temporary, 0o600)
      await rename(temporary, this.filePath)
      await chmod(this.filePath, 0o600)
    } catch (error) {
      await import('node:fs/promises').then(fs => fs.rm(temporary, { force: true })).catch(() => {})
      throw Object.assign(new Error('ROUTING_EVIDENCE_PERSIST_FAILED', { cause: error }), { code: 'ROUTING_EVIDENCE_PERSIST_FAILED', cause: error })
    }
  }

  #restore(document) {
    if (!record(document) || document.schema !== ROUTING_EVIDENCE_SCHEMA || !record(document.buckets)) {
      throw fail('ROUTING_EVIDENCE_CORRUPT')
    }
    const keys = Object.keys(document.buckets)
    if (keys.length > MAX_BUCKETS) throw fail('ROUTING_EVIDENCE_CORRUPT')
    const buckets = {}
    for (const key of keys) {
      const bucket = document.buckets[key]
      if (!record(bucket) || !Array.isArray(bucket.samples) || bucket.samples.length > MAX_SAMPLES_PER_BUCKET) throw fail('ROUTING_EVIDENCE_CORRUPT')
      const identity = { providerId: bucket.providerId, model: bucket.model, capability: bucket.capability }
      validateIdentity(identity)
      if (key !== keyFor(identity)) throw fail('ROUTING_EVIDENCE_CORRUPT')
      const samples = bucket.samples.map(sample => {
        const { observedAt, ...invocation } = sample
        const checked = validateInvocation(invocation)
        if (checked.providerId !== identity.providerId
          || checked.model !== identity.model
          || checked.capability !== identity.capability) {
          throw fail('ROUTING_EVIDENCE_CORRUPT')
        }
        if (!bounded(sample.observedAt, 64)) throw fail('ROUTING_EVIDENCE_CORRUPT')
        return { ...checked, observedAt: sample.observedAt }
      })
      buckets[key] = { ...identity, samples }
    }
    this.#document = { schema: ROUTING_EVIDENCE_SCHEMA, buckets }
  }

  #write(operation) {
    const result = this.#writeTail.then(operation)
    this.#writeTail = result.then(() => undefined, () => undefined)
    return result
  }
}
