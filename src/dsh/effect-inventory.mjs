import { readFile } from 'node:fs/promises'

const INVENTORY_SCHEMA = 'chimera.dsh-side-effects.v1'
const DEFAULT_INVENTORY_URL = new URL('../../config/dsh-side-effects.json', import.meta.url)
const REQUIRED_NON_TOOL_PATHS = [
  'credential-broker',
  'filesystem-provider',
  'human-command',
  'llm-provider',
  'mcp-provider',
  'network-egress',
  'subprocess-provider',
]

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function boundedString(value, maximum = 2048) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function uniqueStrings(values, label) {
  if (!Array.isArray(values) || values.some((value) => !boundedString(value, 256))) {
    throw new TypeError(`${label} must contain bounded strings`)
  }
  const unique = new Set(values)
  if (unique.size !== values.length) throw new TypeError(`${label} must be unique`)
  return unique
}

export class DshEffectInventory {
  #exactRoutes = new Map()
  #patternRoutes = []

  constructor(document) {
    if (!isRecord(document) || document.schema !== INVENTORY_SCHEMA) {
      throw new TypeError('invalid DSH side-effect inventory schema')
    }
    if (!/^[a-f0-9]{40}$/.test(document.upstreamCommit)) {
      throw new TypeError('invalid DSH upstream commit')
    }
    const catalog = uniqueStrings(document.catalog, 'inventory catalog')
    if (!Array.isArray(document.routes) || document.routes.length === 0) {
      throw new TypeError('inventory routes are required')
    }
    const routeIds = new Set()
    const duplicateTools = new Set()
    for (const candidate of document.routes) {
      if (!isRecord(candidate)
        || !boundedString(candidate.id, 128)
        || !boundedString(candidate.capability, 128)
        || routeIds.has(candidate.id)) {
        throw new TypeError('invalid or duplicate inventory route')
      }
      routeIds.add(candidate.id)
      const route = Object.freeze({
        id: candidate.id,
        capability: candidate.capability,
      })
      if (candidate.tools !== undefined) {
        const tools = uniqueStrings(candidate.tools, `route ${candidate.id} tools`)
        for (const toolName of tools) {
          if (this.#exactRoutes.has(toolName)) duplicateTools.add(toolName)
          else this.#exactRoutes.set(toolName, route)
        }
      }
      if (candidate.namePattern !== undefined) {
        if (!boundedString(candidate.namePattern, 256)) throw new TypeError('invalid route name pattern')
        this.#patternRoutes.push({ pattern: new RegExp(candidate.namePattern), route })
      }
      if (candidate.tools === undefined && candidate.namePattern === undefined) {
        throw new TypeError(`route ${candidate.id} has no matcher`)
      }
    }
    if (!Array.isArray(document.nonToolPaths)) throw new TypeError('non-tool paths are required')
    const nonToolIds = uniqueStrings(document.nonToolPaths.map((entry) => entry?.id), 'non-tool path ids')
    for (const path of document.nonToolPaths) {
      if (!isRecord(path) || !boundedString(path.owner) || !boundedString(path.control)) {
        throw new TypeError('invalid non-tool path ownership')
      }
    }

    this.schema = document.schema
    this.upstreamCommit = document.upstreamCommit
    this.catalog = Object.freeze([...catalog].sort())
    this.nonToolPaths = Object.freeze(document.nonToolPaths.map((path) => Object.freeze({ ...path })))
    this.coverage = Object.freeze({
      catalogTools: catalog.size,
      coveredTools: [...catalog].filter((tool) => this.#exactRoutes.has(tool)).length,
      duplicateTools: Object.freeze([...duplicateTools].sort()),
      uncoveredTools: Object.freeze([...catalog].filter((tool) => !this.#exactRoutes.has(tool)).sort()),
      requiredNonToolPaths: REQUIRED_NON_TOOL_PATHS.length,
      ownedNonToolPaths: REQUIRED_NON_TOOL_PATHS.filter((id) => nonToolIds.has(id)).length,
    })
    if (this.coverage.duplicateTools.length > 0
      || this.coverage.uncoveredTools.length > 0
      || this.coverage.ownedNonToolPaths !== this.coverage.requiredNonToolPaths) {
      throw new TypeError('incomplete DSH side-effect inventory')
    }
    Object.freeze(this)
  }

  catalogTools() {
    return [...this.catalog]
  }

  auditCoverage() {
    return structuredClone(this.coverage)
  }

  classify(toolName) {
    if (!boundedString(toolName, 256)) throw new TypeError('DSH tool name is required')
    const exact = this.#exactRoutes.get(toolName)
    if (exact) return exact
    const matches = this.#patternRoutes.filter(({ pattern }) => pattern.test(toolName))
    if (matches.length !== 1) {
      const error = new Error(matches.length === 0 ? 'UNOWNED_DSH_TOOL' : 'AMBIGUOUS_DSH_TOOL_OWNER')
      error.code = error.message
      throw error
    }
    return matches[0].route
  }
}

export function extractDshToolCatalog(markdown) {
  if (typeof markdown !== 'string') throw new TypeError('DSH tool catalog markdown is required')
  const tools = new Set()
  for (const match of markdown.matchAll(/^### `([a-z0-9_]+)`$/gm)) tools.add(match[1])
  return [...tools].sort()
}

export async function loadDshEffectInventory(url = DEFAULT_INVENTORY_URL) {
  const content = await readFile(url, 'utf8')
  return new DshEffectInventory(JSON.parse(content))
}
