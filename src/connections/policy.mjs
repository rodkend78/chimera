import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { PROVIDER_PATTERN } from './state.mjs'

const SCHEMA = 'chimera.connection-policy.v1'
const ACTOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

function policyError(code, message = code) {
  const error = new Error(message)
  error.code = code
  return error
}

function providerIdOf(providerId) {
  if (typeof providerId !== 'string' || !PROVIDER_PATTERN.test(providerId)) {
    throw policyError('CONNECTION_PROVIDER_INVALID')
  }
  return providerId
}

function actorOf(changedBy) {
  if (typeof changedBy !== 'string' || !ACTOR_PATTERN.test(changedBy)) {
    throw policyError('CONNECTION_POLICY_ACTOR_INVALID')
  }
  return changedBy
}

function validateRecord(providerId, record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || !Object.keys(record).every(key => ['enabled', 'revision', 'changedBy', 'changedAt'].includes(key))
    || typeof record.enabled !== 'boolean'
    || !Number.isSafeInteger(record.revision) || record.revision < 0
    || (record.changedBy !== undefined && (typeof record.changedBy !== 'string' || !ACTOR_PATTERN.test(record.changedBy)))
    || (record.changedAt !== undefined && (typeof record.changedAt !== 'string' || record.changedAt.length > 128 || /[\r\n]/.test(record.changedAt)))) {
    throw policyError('CONNECTION_POLICY_CORRUPT')
  }
  return {
    providerId,
    enabled: record.enabled,
    revision: record.revision,
    ...(typeof record.changedBy === 'string' ? { changedBy: record.changedBy } : {}),
    ...(typeof record.changedAt === 'string' ? { changedAt: record.changedAt } : {}),
  }
}

function validateDocument(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)
    || document.schema !== SCHEMA
    || !Object.keys(document).every(key => key === 'schema' || key === 'providers')
    || !Object.hasOwn(document, 'providers')) {
    throw policyError('CONNECTION_POLICY_CORRUPT')
  }
  const source = document.providers
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw policyError('CONNECTION_POLICY_CORRUPT')
  }
  const providers = new Map()
  for (const [providerId, record] of Object.entries(source)) {
    providers.set(providerIdOf(providerId), validateRecord(providerId, record))
  }
  return providers
}

function cloneRecord(record) {
  return { providerId: record.providerId, enabled: record.enabled, revision: record.revision, changedBy: record.changedBy }
}

function temporaryPath(filePath) {
  return `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

async function writeAtomic(filePath, content) {
  const temporary = temporaryPath(filePath)
  try {
    await writeFile(temporary, content, { mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, filePath)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

export class DurableConnectionPolicy {
  #filePath
  #audit
  #now
  #providers
  #writeQueue = Promise.resolve()

  static async open({ filePath, audit, now = () => new Date().toISOString() } = {}) {
    if (typeof filePath !== 'string' || !filePath) throw policyError('CONNECTION_POLICY_PATH_INVALID')
    if (!audit || typeof audit.append !== 'function') throw policyError('CONNECTION_AUDIT_REQUIRED')
    if (typeof now !== 'function') throw policyError('CONNECTION_CLOCK_INVALID')
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
    let providers
    try {
      providers = validateDocument(JSON.parse(await readFile(filePath, 'utf8')))
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        if (error?.code?.startsWith('CONNECTION_')) throw error
        throw policyError('CONNECTION_POLICY_CORRUPT')
      }
      providers = new Map()
      await writeAtomic(filePath, JSON.stringify({ schema: SCHEMA, providers: {} }) + '\n')
    }
    await chmod(filePath, 0o600)
    return new DurableConnectionPolicy({ filePath, audit, now, providers })
  }

  constructor({ filePath, audit, now, providers }) {
    this.#filePath = filePath
    this.#audit = audit
    this.#now = now
    this.#providers = providers
  }

  get(providerId) {
    providerId = providerIdOf(providerId)
    const record = this.#providers.get(providerId)
    return record ? { enabled: record.enabled, revision: record.revision } : { enabled: true, revision: 0 }
  }

  async setEnabled(providerId, enabled, { changedBy, expectedRevision } = {}) {
    providerId = providerIdOf(providerId)
    if (typeof enabled !== 'boolean') throw policyError('CONNECTION_ENABLED_INVALID')
    changedBy = actorOf(changedBy)
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) throw policyError('CONNECTION_REVISION_INVALID')
    return this.#enqueue(async () => {
      const current = this.#providers.get(providerId) ?? { providerId, enabled: true, revision: 0 }
      if (expectedRevision !== undefined && current.revision !== expectedRevision) throw policyError('CONNECTION_REVISION_STALE')
      const record = {
        providerId,
        enabled,
        revision: current.revision + 1,
        changedBy,
        changedAt: String(this.#now()),
      }
      const next = new Map(this.#providers)
      next.set(providerId, record)
      const temporary = await this.#stage(next)
      try {
        // Audit is part of the mutation transaction. Keep the old in-memory
        // and durable policy until the fact has been accepted; a down audit
        // sink must never turn a failed mutation into an enabled binding.
        await this.#audit.append({
          kind: 'connection.policy.changed',
          providerId,
          enabled,
          revision: record.revision,
          changedBy,
        })
        await rename(temporary, this.#filePath)
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => {})
        throw error
      }
      this.#providers = next
      return cloneRecord(record)
    })
  }

  assertEnabled(providerId) {
    providerId = providerIdOf(providerId)
    if (!this.get(providerId).enabled) throw policyError('CONNECTION_DISABLED')
    return true
  }

  async #stage(providers) {
    const document = {
      schema: SCHEMA,
      providers: Object.fromEntries([...providers.entries()].map(([providerId, record]) => [providerId, {
        enabled: record.enabled,
        revision: record.revision,
        changedBy: record.changedBy,
        changedAt: record.changedAt,
      }])),
    }
    const temporary = temporaryPath(this.#filePath)
    try {
      await writeFile(temporary, JSON.stringify(document) + '\n', { mode: 0o600 })
      await chmod(temporary, 0o600)
      return temporary
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {})
      throw error
    }
  }

  #enqueue(operation) {
    const result = this.#writeQueue.then(operation, operation)
    this.#writeQueue = result.catch(() => {})
    return result
  }
}

export const CONNECTION_POLICY_SCHEMA = SCHEMA
