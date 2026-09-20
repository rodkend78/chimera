import { sha256 } from '../canonical.mjs'

export const TASK_REQUIREMENTS_SCHEMA = 'chimera.task-requirements.v1'

const MAX_LIST = 32
const MAX_TOKEN = 128
const MAX_CONTEXT_TOKENS = 4_000_000
const MAX_ESTIMATED_USD = 1_000_000
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,511}$/
const MODALITY = /^[A-Z][A-Z0-9._:-]{0,31}$/
const ALLOWED_FIELDS = new Set([
  'schema', 'capabilities', 'inputModalities', 'outputModalities', 'requiredTools',
  'minContextTokens', 'privacy', 'priorityPreset', 'modelPreference', 'maxEstimatedUsd',
])
const PRESETS = new Set(['balanced', 'quality', 'latency', 'economy'])
const PRIVACY = new Set(['approved-providers', 'local-only'])
const MODEL_MODES = new Set(['auto', 'preferred', 'pinned'])

function failure(code, message = code) {
  return Object.assign(new TypeError(message), { code })
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function listOf(value, field, { modality = false } = {}) {
  if (!Array.isArray(value) || value.length > MAX_LIST || (value.length === 0 && field !== 'requiredTools')) {
    throw failure('TASK_REQUIREMENTS_VALUE_INVALID', `${field} must be a bounded non-empty list`)
  }
  const seen = new Set()
  for (const item of value) {
    const valid = typeof item === 'string' && item.length > 0 && item.length <= MAX_TOKEN
      && (modality ? MODALITY.test(item) : TOKEN.test(item))
    if (!valid) throw failure('TASK_REQUIREMENTS_VALUE_INVALID', `${field} contains an invalid value`)
    seen.add(item)
  }
  return [...seen].toSorted()
}

function modelPreferenceOf(value) {
  if (!record(value) || Object.keys(value).some(key => !['mode', 'providerId', 'model'].includes(key))) {
    throw failure('TASK_REQUIREMENTS_VALUE_INVALID', 'modelPreference is invalid')
  }
  const mode = value.mode
  if (!MODEL_MODES.has(mode)) throw failure('TASK_REQUIREMENTS_VALUE_INVALID', 'modelPreference mode is invalid')
  const providerId = value.providerId
  const model = value.model
  if (providerId !== undefined && (typeof providerId !== 'string' || !TOKEN.test(providerId) || providerId.length > MAX_TOKEN)) {
    throw failure('TASK_REQUIREMENTS_VALUE_INVALID', 'modelPreference providerId is invalid')
  }
  if (model !== undefined && (typeof model !== 'string' || !MODEL_ID.test(model) || model.length > 512)) {
    throw failure('TASK_REQUIREMENTS_VALUE_INVALID', 'modelPreference model is invalid')
  }
  if (['preferred', 'pinned'].includes(mode) && (providerId === undefined || model === undefined)) {
    throw failure('TASK_REQUIREMENTS_VALUE_INVALID', `${mode} modelPreference requires providerId and model`)
  }
  if (mode === 'auto' && (providerId !== undefined || model !== undefined)) {
    throw failure('TASK_REQUIREMENTS_VALUE_INVALID', 'auto modelPreference cannot pin a model')
  }
  return {
    mode,
    ...(providerId !== undefined ? { providerId } : {}),
    ...(model !== undefined ? { model } : {}),
  }
}

function legacyPreset(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.length > MAX_TOKEN) throw failure('TASK_REQUIREMENTS_VALUE_INVALID')
  if (PRESETS.has(value)) return value
  if (['low-cost', 'low', 'cheap'].includes(value)) return 'economy'
  if (['fast', 'speed'].includes(value)) return 'latency'
  if (['reliable', 'high-quality'].includes(value)) return 'quality'
  throw failure('TASK_REQUIREMENTS_VALUE_INVALID', 'legacy cost preference is invalid')
}

function normalizeSource(input, legacyContext) {
  if (input === undefined || input === null) {
    const legacy = record(legacyContext) ? legacyContext : {}
    const result = {}
    if (legacy.taskKind !== undefined) {
      if (typeof legacy.taskKind !== 'string' || !TOKEN.test(legacy.taskKind)) throw failure('TASK_REQUIREMENTS_VALUE_INVALID')
      result.capabilities = [legacy.taskKind]
    }
    const preset = legacyPreset(legacy.costPreference ?? legacy.priorityPreset)
    if (preset) result.priorityPreset = preset
    if (legacy.modelPreference !== undefined) result.modelPreference = legacy.modelPreference
    return result
  }
  if (!record(input)) throw failure('TASK_REQUIREMENTS_INPUT_INVALID')
  if (input.schema !== undefined && input.schema !== TASK_REQUIREMENTS_SCHEMA) {
    throw failure('TASK_REQUIREMENTS_SCHEMA_INVALID')
  }
  if (Object.keys(input).some(key => !ALLOWED_FIELDS.has(key))) {
    throw failure('TASK_REQUIREMENTS_FIELD_INVALID')
  }
  return input
}

export function normalizeTaskRequirements(input = undefined, legacyContext = undefined) {
  const source = normalizeSource(input, legacyContext)
  const result = { schema: TASK_REQUIREMENTS_SCHEMA }
  if (source.capabilities !== undefined) result.capabilities = listOf(source.capabilities, 'capabilities')
  if (source.inputModalities !== undefined) result.inputModalities = listOf(source.inputModalities, 'inputModalities', { modality: true })
  if (source.outputModalities !== undefined) result.outputModalities = listOf(source.outputModalities, 'outputModalities', { modality: true })
  if (source.requiredTools !== undefined) result.requiredTools = listOf(source.requiredTools, 'requiredTools')
  if (source.minContextTokens !== undefined) {
    if (!Number.isSafeInteger(source.minContextTokens) || source.minContextTokens < 1 || source.minContextTokens > MAX_CONTEXT_TOKENS) {
      throw failure('TASK_REQUIREMENTS_VALUE_INVALID', 'minContextTokens is invalid')
    }
    result.minContextTokens = source.minContextTokens
  }
  if (source.privacy !== undefined) {
    if (typeof source.privacy !== 'string' || !PRIVACY.has(source.privacy)) throw failure('TASK_REQUIREMENTS_VALUE_INVALID', 'privacy is invalid')
    result.privacy = source.privacy
  }
  if (source.priorityPreset !== undefined) {
    if (typeof source.priorityPreset !== 'string' || !PRESETS.has(source.priorityPreset)) throw failure('TASK_REQUIREMENTS_VALUE_INVALID', 'priorityPreset is invalid')
    result.priorityPreset = source.priorityPreset
  }
  if (source.modelPreference !== undefined) result.modelPreference = modelPreferenceOf(source.modelPreference)
  if (source.maxEstimatedUsd !== undefined) {
    if (typeof source.maxEstimatedUsd !== 'number' || !Number.isFinite(source.maxEstimatedUsd)
      || source.maxEstimatedUsd < 0 || source.maxEstimatedUsd > MAX_ESTIMATED_USD) {
      throw failure('TASK_REQUIREMENTS_VALUE_INVALID', 'maxEstimatedUsd is invalid')
    }
    result.maxEstimatedUsd = source.maxEstimatedUsd
  }
  return Object.freeze(result)
}

export function requirementsEqual(left, right) {
  return JSON.stringify(normalizeTaskRequirements(left)) === JSON.stringify(normalizeTaskRequirements(right))
}

export function taskRequirementsHash(value) {
  return sha256(normalizeTaskRequirements(value))
}

export function hasTaskRequirements(value) {
  return record(value) && value.schema === TASK_REQUIREMENTS_SCHEMA
}
