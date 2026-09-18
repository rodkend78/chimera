import crypto from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

export const AGENT_ACCESS_POLICY_SCHEMA = 'chimera.agent-access-policy.v1'

const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

const GITHUB_PR_TOOLS = Object.freeze([
  'mcp__chimera_github__pr_create',
  'mcp__chimera_github__pr_update',
  'mcp__chimera_github__pr_comment',
  'mcp__chimera_github__pr_checks',
  'mcp__chimera_github__pr_merge',
])

const GITHUB_PR_READ_TOOLS = Object.freeze([
  'mcp__chimera_github__pr_checks',
])

const ACCOUNT_READ_TOOLS = Object.freeze([
  'mcp__chimera_account__read',
  'mcp__chimera_account__await_share',
])

const RJ_AWS_READ_TOOLS = Object.freeze([
  'mcp__chimera_rj_aws__identity',
  'mcp__chimera_rj_aws__instance_status',
])

export const AGENT_ACCESS_PROFILES = Object.freeze({
  sandbox: Object.freeze({
    profileId: 'sandbox',
    label: 'Sandbox',
    description: 'Private workspace only. No network access.',
    network: 'none',
    execution: 'isolated-workspace',
    warning: null,
    tools: Object.freeze(['read', 'glob', 'grep', 'write', 'edit', 'str_replace_editor', 'bash', 'mcp__chimera_worker__code']),
  }),
  connected: Object.freeze({
    profileId: 'connected',
    label: 'Connected sandbox',
    description: 'Private workspace plus guarded public-web requests.',
    network: 'guarded-public-web',
    execution: 'isolated-workspace',
    warning: 'Public data can leave the workspace through approved requests.',
    tools: Object.freeze(['read', 'glob', 'grep', 'write', 'edit', 'str_replace_editor', 'bash', 'web_fetch', 'mcp__chimera_worker__code', 'mcp__chimera_worker__computer', ...GITHUB_PR_READ_TOOLS, ...ACCOUNT_READ_TOOLS, ...RJ_AWS_READ_TOOLS]),
  }),
  live: Object.freeze({
    profileId: 'live',
    label: 'Live workflow',
    description: 'Real public services and connectors, with signed confirmation for consequential actions.',
    network: 'brokered-public-only',
    execution: 'isolated-workspace',
    warning: 'This agent can act on live external systems after human confirmation.',
    tools: Object.freeze(['read', 'glob', 'grep', 'write', 'edit', 'str_replace_editor', 'bash', 'web_fetch', 'mcp__chimera_worker__code', 'mcp__chimera_worker__computer', ...GITHUB_PR_TOOLS, ...ACCOUNT_READ_TOOLS, ...RJ_AWS_READ_TOOLS]),
  }),
})

function validateAgentId(agentId) {
  if (typeof agentId !== 'string' || !AGENT_ID.test(agentId)) throw new TypeError('AGENT_ID_INVALID')
  return agentId
}

function profile(profileId) {
  const value = AGENT_ACCESS_PROFILES[profileId]
  if (!value) throw new TypeError('AGENT_ACCESS_PROFILE_INVALID')
  return value
}

export function toolsForAccessProfile(profileId) {
  return [...profile(profileId).tools]
}

function projection(agentId, assignment) {
  const selected = profile(assignment?.profileId ?? 'sandbox')
  return structuredClone({
    agentId,
    ...selected,
    changedBy: assignment?.changedBy ?? null,
    changedAt: assignment?.changedAt ?? null,
  })
}

export class DurableAgentAccessPolicy {
  #assignments = new Map()
  #writes = Promise.resolve()

  constructor({ filePath, audit, now = () => Date.now() }) {
    if (typeof filePath !== 'string' || filePath.length === 0 || filePath.length > 4096 || !audit?.append) {
      throw new TypeError('AGENT_ACCESS_POLICY_CONFIG_INVALID')
    }
    this.filePath = resolve(filePath)
    this.audit = audit
    this.now = now
  }

  static async open(options) {
    const store = new DurableAgentAccessPolicy(options)
    await mkdir(dirname(store.filePath), { recursive: true, mode: 0o700 })
    try {
      const document = JSON.parse(await readFile(store.filePath, 'utf8'))
      if (document?.schema !== AGENT_ACCESS_POLICY_SCHEMA
        || !document.assignments
        || typeof document.assignments !== 'object'
        || Array.isArray(document.assignments)) {
        throw new TypeError('AGENT_ACCESS_POLICY_INVALID')
      }
      for (const [agentId, assignment] of Object.entries(document.assignments)) {
        validateAgentId(agentId)
        profile(assignment?.profileId)
        if (typeof assignment.changedBy !== 'string'
          || typeof assignment.changedAt !== 'string'
          || Number.isNaN(Date.parse(assignment.changedAt))) {
          throw new TypeError('AGENT_ACCESS_POLICY_INVALID')
        }
        store.#assignments.set(agentId, structuredClone(assignment))
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    return store
  }

  get(agentId) {
    validateAgentId(agentId)
    return projection(agentId, this.#assignments.get(agentId))
  }

  list() {
    return [...this.#assignments].map(([agentId, assignment]) => projection(agentId, assignment))
  }

  async set(agentId, profileId, { changedBy } = {}) {
    validateAgentId(agentId)
    profile(profileId)
    if (typeof changedBy !== 'string' || changedBy.length === 0 || changedBy.length > 128) {
      throw new TypeError('AGENT_ACCESS_ACTOR_INVALID')
    }
    const operation = this.#writes.then(async () => {
      const previousAssignment = this.#assignments.get(agentId)
      const previous = this.get(agentId)
      const assignment = {
        profileId,
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
        kind: 'agent.access.changed',
        agentId,
        changedBy,
        previousProfileId: previous.profileId,
        profileId,
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
      throw new TypeError('AGENT_ACCESS_REMOVAL_ACTOR_INVALID')
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
        kind: 'agent.access.removed',
        agentId,
        removedBy,
        previousProfileId: previousAssignment.profileId,
        at: new Date(this.now()).toISOString(),
      })
      return true
    })
    this.#writes = operation.then(() => undefined, () => undefined)
    return operation
  }

  async #persist() {
    const temporary = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
    const document = {
      schema: AGENT_ACCESS_POLICY_SCHEMA,
      assignments: Object.fromEntries(this.#assignments),
    }
    try {
      await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
      await rename(temporary, this.filePath)
      await chmod(this.filePath, 0o600)
    } finally {
      await rm(temporary, { force: true })
    }
  }
}
