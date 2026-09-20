import crypto from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

export const AGENT_MANIFEST_SCHEMA = 'chimera.agent-manifest.v1'
export const AGENT_NATIVE_MANIFEST_SCHEMA = 'chimera.agent-manifest.v2'
export const AGENT_REGISTRY_SCHEMA = 'chimera.agent-registry.v1'
export const NATIVE_RESERVED_AGENT_IDS = Object.freeze(['ceo', 'operator', 'rj', 'researcher'])

const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const CAPABILITY = /^[a-z0-9][a-z0-9-]{0,63}$/

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function boundedString(value, maximum = 256) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function safeHermesRef(value, profileId) {
  if (!boundedString(value, 512)) throw new TypeError('AGENT_SOURCE_REF_INVALID')
  let url
  try {
    url = new URL(value)
  } catch {
    throw new TypeError('AGENT_SOURCE_REF_INVALID')
  }
  if (url.protocol !== 'hermes:' || url.username || url.password || url.search || url.hash) {
    throw new TypeError('AGENT_SOURCE_REF_INVALID')
  }
  const expectedSuffix = `/profiles/${profileId}`
  if (!url.pathname.endsWith(expectedSuffix)) throw new TypeError('AGENT_SOURCE_REF_INVALID')
  return value
}

function normalizeCapabilities(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new TypeError('AGENT_CAPABILITIES_INVALID')
  }
  const capabilities = [...new Set(value)]
  if (capabilities.some((item) => !boundedString(item, 64) || !CAPABILITY.test(item))) {
    throw new TypeError('AGENT_CAPABILITIES_INVALID')
  }
  return capabilities
}

export function validateAgentManifest(value) {
  if (!isRecord(value)
    || ![AGENT_MANIFEST_SCHEMA, AGENT_NATIVE_MANIFEST_SCHEMA].includes(value.schema)
    || !boundedString(value.agentId, 64)
    || !AGENT_ID.test(value.agentId)
    || !boundedString(value.displayName, 128)
    || !boundedString(value.role, 512)
    || value.enabled !== true
    || value.modelPreference?.mode !== 'chimera-auto'
    || value.execution?.adapter !== 'model-fabric'
    || value.execution?.isolation !== 'per-agent-workspace'
    || value.execution?.sideEffects !== 'dsh-required'
    || !boundedString(value.importedAt, 64)
    || Number.isNaN(Date.parse(value.importedAt))) {
    throw new TypeError('AGENT_MANIFEST_INVALID')
  }
  const capabilities = normalizeCapabilities(value.capabilities)
  if (value.schema === AGENT_NATIVE_MANIFEST_SCHEMA) return validateNativeManifest(value, capabilities)
  return validateHermesManifest(value, capabilities)
}

function validateHermesManifest(value, capabilities) {
  if (['ceo', 'operator'].includes(value.agentId)
    || value.source?.type !== 'hermes'
    || !boundedString(value.source?.sourceId, 64)
    || !boundedString(value.source?.profileId, 64)
    || value.source.profileId !== value.agentId
    || !AGENT_ID.test(value.source.profileId)) {
    throw new TypeError('AGENT_MANIFEST_INVALID')
  }
  const ref = safeHermesRef(value.source.ref, value.agentId)
  const expectedMemoryRef = `${ref}/memory`
  const expectedSkillRef = `${ref}/skills`
  const expectedPersonaRef = `${ref}/persona`
  if (!Array.isArray(value.personaRefs)
    || value.personaRefs.length !== 1
    || value.personaRefs[0]?.type !== 'hermes-profile'
    || value.personaRefs[0]?.ref !== expectedPersonaRef) {
    throw new TypeError('AGENT_PERSONA_REFS_INVALID')
  }
  if (!Array.isArray(value.memoryRefs)
    || value.memoryRefs.length !== 1
    || value.memoryRefs[0]?.type !== 'hermes-profile'
    || value.memoryRefs[0]?.ref !== expectedMemoryRef) {
    throw new TypeError('AGENT_MEMORY_REFS_INVALID')
  }
  if (value.skillRefs !== undefined && (!Array.isArray(value.skillRefs)
    || value.skillRefs.length !== 1
    || value.skillRefs[0]?.type !== 'hermes-profile'
    || value.skillRefs[0]?.ref !== expectedSkillRef)) {
    throw new TypeError('AGENT_SKILL_REFS_INVALID')
  }
  return Object.freeze(structuredClone({
    schema: AGENT_MANIFEST_SCHEMA,
    agentId: value.agentId,
    displayName: value.displayName,
    role: value.role,
    capabilities,
    modelPreference: { mode: 'chimera-auto' },
    source: {
      type: 'hermes',
      sourceId: value.source.sourceId,
      profileId: value.source.profileId,
      ref,
    },
    personaRefs: [{ type: 'hermes-profile', ref: expectedPersonaRef }],
    memoryRefs: [{ type: 'hermes-profile', ref: expectedMemoryRef }],
    skillRefs: [{ type: 'hermes-profile', ref: expectedSkillRef }],
    execution: {
      adapter: 'model-fabric',
      isolation: 'per-agent-workspace',
      sideEffects: 'dsh-required',
    },
    enabled: true,
    importedAt: new Date(value.importedAt).toISOString(),
  }))
}

function validateNativeManifest(value, capabilities) {
  if (NATIVE_RESERVED_AGENT_IDS.includes(value.agentId)
    || value.source?.type !== 'chimera'
    || value.source?.sourceId !== 'local'
    || value.source?.ref !== `chimera://local/agents/${value.agentId}`) {
    throw new TypeError('AGENT_MANIFEST_INVALID')
  }
  const ref = value.source.ref
  const expectedRefs = {
    persona: `${ref}/persona`,
    memory: `${ref}/memory`,
    skills: `${ref}/skills`,
  }
  for (const [kind, expected] of Object.entries(expectedRefs)) {
    const key = `${kind === 'persona' ? 'persona' : kind === 'memory' ? 'memory' : 'skill'}Refs`
    if (!Array.isArray(value[key])
      || value[key].length !== 1
      || value[key][0]?.type !== 'chimera-profile'
      || value[key][0]?.ref !== expected) {
      throw new TypeError(`AGENT_${kind.toUpperCase()}_REFS_INVALID`)
    }
  }
  return Object.freeze(structuredClone({
    schema: AGENT_NATIVE_MANIFEST_SCHEMA,
    agentId: value.agentId,
    displayName: value.displayName,
    role: value.role,
    capabilities,
    modelPreference: { mode: 'chimera-auto' },
    source: { type: 'chimera', sourceId: 'local', ref },
    personaRefs: [{ type: 'chimera-profile', ref: expectedRefs.persona }],
    memoryRefs: [{ type: 'chimera-profile', ref: expectedRefs.memory }],
    skillRefs: [{ type: 'chimera-profile', ref: expectedRefs.skills }],
    execution: {
      adapter: 'model-fabric',
      isolation: 'per-agent-workspace',
      sideEffects: 'dsh-required',
    },
    enabled: true,
    importedAt: new Date(value.importedAt).toISOString(),
  }))
}

export function agentManifestFromNativeInput(input, { now = () => Date.now() } = {}) {
  if (!isRecord(input)) throw new TypeError('NATIVE_AGENT_INPUT_INVALID')
  return validateAgentManifest({
    schema: AGENT_NATIVE_MANIFEST_SCHEMA,
    agentId: input.agentId,
    displayName: input.displayName,
    role: input.role,
    capabilities: input.capabilities,
    modelPreference: { mode: 'chimera-auto' },
    source: {
      type: 'chimera',
      sourceId: 'local',
      ref: `chimera://local/agents/${input.agentId}`,
    },
    personaRefs: [{ type: 'chimera-profile', ref: `chimera://local/agents/${input.agentId}/persona` }],
    memoryRefs: [{ type: 'chimera-profile', ref: `chimera://local/agents/${input.agentId}/memory` }],
    skillRefs: [{ type: 'chimera-profile', ref: `chimera://local/agents/${input.agentId}/skills` }],
    execution: {
      adapter: 'model-fabric',
      isolation: 'per-agent-workspace',
      sideEffects: 'dsh-required',
    },
    enabled: true,
    importedAt: new Date(now()).toISOString(),
  })
}

export function agentManifestFromHermesCandidate(candidate, overrides = {}, { now = () => Date.now() } = {}) {
  if (!isRecord(candidate)
    || candidate.schema !== 'chimera.hermes-agent-candidate.v1'
    || !boundedString(candidate.candidateId, 160)
    || !boundedString(candidate.profileId, 64)
    || !AGENT_ID.test(candidate.profileId)
    || !boundedString(candidate.displayName, 128)) {
    throw new TypeError('HERMES_AGENT_CANDIDATE_INVALID')
  }
  const sourceId = candidate.candidateId.slice(0, candidate.candidateId.lastIndexOf(':'))
  if (!boundedString(sourceId, 64)) throw new TypeError('HERMES_AGENT_CANDIDATE_INVALID')
  const ref = safeHermesRef(candidate.sourceRef, candidate.profileId)
  const displayName = overrides.displayName ?? candidate.displayName
  if (!boundedString(displayName, 128)) throw new TypeError('AGENT_DISPLAY_NAME_INVALID')
  return validateAgentManifest({
    schema: AGENT_MANIFEST_SCHEMA,
    agentId: candidate.profileId,
    displayName,
    role: overrides.role ?? candidate.defaultRole ?? 'General specialist',
    capabilities: overrides.capabilities ?? candidate.defaultCapabilities ?? ['general'],
    modelPreference: { mode: 'chimera-auto' },
    source: {
      type: 'hermes',
      sourceId,
      profileId: candidate.profileId,
      ref,
    },
    personaRefs: [{ type: 'hermes-profile', ref: `${ref}/persona` }],
    memoryRefs: [{ type: 'hermes-profile', ref: `${ref}/memory` }],
    skillRefs: [{ type: 'hermes-profile', ref: `${ref}/skills` }],
    execution: {
      adapter: 'model-fabric',
      isolation: 'per-agent-workspace',
      sideEffects: 'dsh-required',
    },
    enabled: true,
    importedAt: new Date(now()).toISOString(),
  })
}

export class DurableAgentRegistry {
  #agents = new Map()
  #mutations = Promise.resolve()

  constructor({ filePath, audit, now = () => Date.now() }) {
    if (!boundedString(filePath, 4096) || !audit || typeof audit.append !== 'function') {
      throw new TypeError('agent registry requires file path and audit log')
    }
    this.filePath = resolve(filePath)
    this.audit = audit
    this.now = now
  }

  static async open(options) {
    const registry = new DurableAgentRegistry(options)
    await mkdir(dirname(registry.filePath), { recursive: true, mode: 0o700 })
    try {
      const document = JSON.parse(await readFile(registry.filePath, 'utf8'))
      if (document?.schema !== AGENT_REGISTRY_SCHEMA || !Array.isArray(document.agents)) {
        throw new TypeError('AGENT_REGISTRY_INVALID')
      }
      for (const value of document.agents) {
        const manifest = validateAgentManifest(value)
        if (registry.#agents.has(manifest.agentId)) throw new TypeError('AGENT_REGISTRY_INVALID')
        registry.#agents.set(manifest.agentId, manifest)
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    return registry
  }

  list() {
    return structuredClone([...this.#agents.values()])
  }

  get(agentId) {
    const value = this.#agents.get(agentId)
    return value ? structuredClone(value) : null
  }

  async register(value) {
    return (await this.registerMany([value]))[0]
  }

  async registerMany(values) {
    if (!Array.isArray(values) || values.length === 0 || values.length > 16) {
      throw new TypeError('AGENT_IMPORT_BATCH_INVALID')
    }
    return this.#mutate(async () => {
      const manifests = values.map(validateAgentManifest)
      if (new Set(manifests.map((manifest) => manifest.agentId)).size !== manifests.length
        || manifests.some((manifest) => this.#agents.has(manifest.agentId))) {
        const error = new Error('AGENT_ALREADY_REGISTERED')
        error.code = 'AGENT_ALREADY_REGISTERED'
        throw error
      }
      const next = new Map(this.#agents)
      for (const manifest of manifests) next.set(manifest.agentId, manifest)
      for (const manifest of manifests) {
        await this.audit.append({
          kind: 'agent.registry.registered',
          agentId: manifest.agentId,
          sourceType: manifest.source.type,
          sourceId: manifest.source.sourceId,
          sourceRef: manifest.source.ref,
          at: new Date(this.now()).toISOString(),
        })
      }
      await this.#persist(next)
      this.#agents = next
      return structuredClone(manifests)
    })
  }

  async unregister(agentId, { removedBy, reason = 'operator-request' } = {}) {
    if (typeof agentId !== 'string' || !AGENT_ID.test(agentId)) throw new TypeError('AGENT_ID_INVALID')
    if (!boundedString(removedBy, 128)) throw new TypeError('AGENT_REMOVAL_ACTOR_INVALID')
    if (!boundedString(reason, 256)) throw new TypeError('AGENT_REMOVAL_REASON_INVALID')
    return this.#mutate(async () => {
      const previous = this.#agents.get(agentId)
      if (!previous) {
        const error = new Error('AGENT_NOT_REGISTERED')
        error.code = 'AGENT_NOT_REGISTERED'
        throw error
      }
      const next = new Map(this.#agents)
      next.delete(agentId)
      await this.audit.append({
        kind: 'agent.registry.unregistered',
        agentId,
        displayName: previous.displayName,
        sourceType: previous.source.type,
        sourceId: previous.source.sourceId,
        sourceRef: previous.source.ref,
        removedBy,
        reason,
        at: new Date(this.now()).toISOString(),
      })
      await this.#persist(next)
      this.#agents = next
      return structuredClone(previous)
    })
  }

  async updateMetadata(agentId, { displayName, role, capabilities } = {}, { changedBy } = {}) {
    if (typeof agentId !== 'string' || !AGENT_ID.test(agentId)) throw new TypeError('AGENT_ID_INVALID')
    if (!boundedString(changedBy, 128)) throw new TypeError('AGENT_METADATA_ACTOR_INVALID')
    return this.#mutate(async () => {
      const previous = this.#agents.get(agentId)
      if (!previous) {
        const error = new Error('AGENT_NOT_REGISTERED')
        error.code = 'AGENT_NOT_REGISTERED'
        throw error
      }
      const next = validateAgentManifest({
        ...previous,
        displayName,
        role,
        capabilities,
      })
      const changedFields = ['capabilities', 'displayName', 'role']
        .filter((field) => JSON.stringify(previous[field]) !== JSON.stringify(next[field]))
        .sort()
      const nextAgents = new Map(this.#agents)
      nextAgents.set(agentId, next)
      await this.audit.append({
        kind: 'agent.registry.metadata-updated',
        agentId,
        changedBy,
        changedFields,
        at: new Date(this.now()).toISOString(),
      })
      await this.#persist(nextAgents)
      this.#agents = nextAgents
      return structuredClone(next)
    })
  }

  async #persist(agents = this.#agents) {
    const document = {
      schema: AGENT_REGISTRY_SCHEMA,
      agents: [...agents.values()],
    }
    const temporary = `${this.filePath}.${crypto.randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
      await rename(temporary, this.filePath)
    } finally {
      await rm(temporary, { force: true })
    }
  }

  #mutate(operation) {
    const run = this.#mutations.then(operation)
    this.#mutations = run.then(() => undefined, () => undefined)
    return run
  }
}
