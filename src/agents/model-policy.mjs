import crypto from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

export const AGENT_MODEL_POLICY_SCHEMA = 'chimera.agent-model-policy.v1'

const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const MODES = new Set(['auto', 'preferred', 'pinned'])
const PREFERENCE_KEYS = new Set(['mode', 'providerId', 'model'])

function validateAgentId(agentId) {
  if (typeof agentId !== 'string' || !AGENT_ID.test(agentId)) throw new TypeError('AGENT_ID_INVALID')
  return agentId
}

function validatePreference(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !PREFERENCE_KEYS.has(key))
    || !MODES.has(value.mode)) {
    throw new TypeError('AGENT_MODEL_PREFERENCE_INVALID')
  }
  if (value.mode === 'auto') {
    if (value.providerId !== undefined || value.model !== undefined) throw new TypeError('AGENT_MODEL_PREFERENCE_INVALID')
    return { mode: 'auto', providerId: null, model: null }
  }
  if (typeof value.providerId !== 'string' || !PROVIDER_ID.test(value.providerId)
    || typeof value.model !== 'string' || value.model.length === 0 || value.model.length > 512) {
    throw new TypeError('AGENT_MODEL_PREFERENCE_INVALID')
  }
  return { mode: value.mode, providerId: value.providerId, model: value.model }
}

function projection(agentId, assignment) {
  return structuredClone({
    agentId,
    mode: assignment?.mode ?? 'auto',
    providerId: assignment?.providerId ?? null,
    model: assignment?.model ?? null,
    changedBy: assignment?.changedBy ?? null,
    changedAt: assignment?.changedAt ?? null,
  })
}

export class DurableAgentModelPolicy {
  #assignments = new Map()
  #writes = Promise.resolve()

  constructor({ filePath, audit, now = () => Date.now() }) {
    if (typeof filePath !== 'string' || filePath.length === 0 || filePath.length > 4096 || !audit?.append) {
      throw new TypeError('AGENT_MODEL_POLICY_CONFIG_INVALID')
    }
    this.filePath = resolve(filePath)
    this.audit = audit
    this.now = now
  }

  static async open(options) {
    const policy = new DurableAgentModelPolicy(options)
    await mkdir(dirname(policy.filePath), { recursive: true, mode: 0o700 })
    try {
      const document = JSON.parse(await readFile(policy.filePath, 'utf8'))
      if (document?.schema !== AGENT_MODEL_POLICY_SCHEMA
        || !document.assignments || typeof document.assignments !== 'object' || Array.isArray(document.assignments)) {
        throw new TypeError('AGENT_MODEL_POLICY_INVALID')
      }
      for (const [agentId, assignment] of Object.entries(document.assignments)) {
        validateAgentId(agentId)
        const preference = validatePreference({
          mode: assignment?.mode,
          ...(assignment?.providerId ? { providerId: assignment.providerId } : {}),
          ...(assignment?.model ? { model: assignment.model } : {}),
        })
        if (typeof assignment.changedBy !== 'string' || assignment.changedBy.length === 0 || assignment.changedBy.length > 128
          || typeof assignment.changedAt !== 'string' || Number.isNaN(Date.parse(assignment.changedAt))) {
          throw new TypeError('AGENT_MODEL_POLICY_INVALID')
        }
        policy.#assignments.set(agentId, { ...preference, changedBy: assignment.changedBy, changedAt: assignment.changedAt })
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    return policy
  }

  get(agentId) {
    validateAgentId(agentId)
    return projection(agentId, this.#assignments.get(agentId))
  }

  list() {
    return [...this.#assignments].map(([agentId, assignment]) => projection(agentId, assignment))
  }

  async set(agentId, value, { changedBy } = {}) {
    validateAgentId(agentId)
    const preference = validatePreference(value)
    if (typeof changedBy !== 'string' || changedBy.length === 0 || changedBy.length > 128) {
      throw new TypeError('AGENT_MODEL_ACTOR_INVALID')
    }
    const operation = this.#writes.then(async () => {
      const previousAssignment = this.#assignments.get(agentId)
      const previous = this.get(agentId)
      const assignment = {
        ...preference,
        changedBy,
        changedAt: new Date(this.now()).toISOString(),
      }
      this.#assignments.set(agentId, assignment)
      try {
        await this.#persist()
      } catch (error) {
        if (previousAssignment) this.#assignments.set(agentId, previousAssignment)
        else this.#assignments.delete(agentId)
        throw error
      }
      this.audit.append({
        kind: 'agent.model.changed',
        agentId,
        changedBy,
        previousMode: previous.mode,
        mode: preference.mode,
        providerId: preference.providerId,
        model: preference.model,
        at: assignment.changedAt,
      })
      return this.get(agentId)
    })
    this.#writes = operation.then(() => undefined, () => undefined)
    return operation
  }

  async remove(agentId, { removedBy } = {}) {
    validateAgentId(agentId)
    if (typeof removedBy !== 'string' || removedBy.length === 0 || removedBy.length > 128) {
      throw new TypeError('AGENT_MODEL_REMOVAL_ACTOR_INVALID')
    }
    const operation = this.#writes.then(async () => {
      const previousAssignment = this.#assignments.get(agentId)
      if (!previousAssignment) return false
      this.#assignments.delete(agentId)
      try {
        await this.#persist()
      } catch (error) {
        this.#assignments.set(agentId, previousAssignment)
        throw error
      }
      this.audit.append({
        kind: 'agent.model.removed',
        agentId,
        removedBy,
        previousMode: previousAssignment.mode,
        providerId: previousAssignment.providerId,
        model: previousAssignment.model,
        at: new Date(this.now()).toISOString(),
      })
      return true
    })
    this.#writes = operation.then(() => undefined, () => undefined)
    return operation
  }

  async #persist() {
    const temporary = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify({
        schema: AGENT_MODEL_POLICY_SCHEMA,
        assignments: Object.fromEntries(this.#assignments),
      }, null, 2)}\n`, { mode: 0o600 })
      await rename(temporary, this.filePath)
      await chmod(this.filePath, 0o600)
    } finally {
      await rm(temporary, { force: true })
    }
  }
}
