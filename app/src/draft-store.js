import { draftKey } from './conversation-target.js'
import { routingRequirementsOf } from './conversation-composer-contract.js'

const STORAGE_PREFIX = 'chimera.conversation-drafts.v1:'
const STATUSES = new Set(['draft', 'sending', 'accepted', 'unconfirmed'])
const MAX_DRAFTS = 50
const MAX_CONTENT_BYTES = 16 * 1024
const ENTRY_PREFIX = STORAGE_PREFIX

function utf8Bytes(value) {
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(value).byteLength
  return encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, 'x').length
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function warning(onWarning, code) {
  try { onWarning?.(code) } catch { /* persistence warnings must not break composing */ }
}

function normalizeDraft(draft = {}) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) throw new TypeError('DRAFT_INVALID')
  const content = typeof draft.content === 'string' ? draft.content : ''
  if (utf8Bytes(content) > MAX_CONTENT_BYTES) throw Object.assign(new TypeError('DRAFT_TOO_LARGE'), { code: 'DRAFT_TOO_LARGE' })
  const budget = draft.budget === undefined ? 'standard' : draft.budget
  if (typeof budget !== 'string' || budget.length > 64) throw Object.assign(new TypeError('DRAFT_INVALID'), { code: 'DRAFT_INVALID' })
  const destinationRevision = draft.destinationRevision === null || draft.destinationRevision === undefined
    ? null : Number.isSafeInteger(draft.destinationRevision) && draft.destinationRevision >= 0 ? draft.destinationRevision : null
  if (draft.destinationRevision !== undefined && draft.destinationRevision !== null && destinationRevision === null) throw Object.assign(new TypeError('DRAFT_INVALID'), { code: 'DRAFT_INVALID' })
  const requestId = draft.requestId === null || draft.requestId === undefined ? null : draft.requestId
  if (requestId !== null && (typeof requestId !== 'string' || requestId.length < 1 || requestId.length > 256)) throw Object.assign(new TypeError('DRAFT_INVALID'), { code: 'DRAFT_INVALID' })
  const pendingRequestId = draft.pendingRequestId === null || draft.pendingRequestId === undefined ? null : draft.pendingRequestId
  if (pendingRequestId !== null && (typeof pendingRequestId !== 'string' || pendingRequestId.length < 1 || pendingRequestId.length > 256)) throw Object.assign(new TypeError('DRAFT_INVALID'), { code: 'DRAFT_INVALID' })
  const pendingContent = draft.pendingContent === null || draft.pendingContent === undefined ? null : draft.pendingContent
  if (pendingContent !== null && (typeof pendingContent !== 'string' || utf8Bytes(pendingContent) > MAX_CONTENT_BYTES)) throw Object.assign(new TypeError('DRAFT_INVALID'), { code: 'DRAFT_INVALID' })
  const pendingBudget = draft.pendingBudget === null || draft.pendingBudget === undefined ? null : draft.pendingBudget
  if (pendingBudget !== null && (typeof pendingBudget !== 'string' || pendingBudget.length > 64)) throw Object.assign(new TypeError('DRAFT_INVALID'), { code: 'DRAFT_INVALID' })
  const failureCode = draft.failureCode === null || draft.failureCode === undefined ? null : draft.failureCode
  if (failureCode !== null && (typeof failureCode !== 'string' || !/^[A-Z][A-Z0-9_]{2,127}$/.test(failureCode))) throw Object.assign(new TypeError('DRAFT_INVALID'), { code: 'DRAFT_INVALID' })
  const status = draft.status ?? 'draft'
  if (!STATUSES.has(status)) throw Object.assign(new TypeError('DRAFT_STATUS_INVALID'), { code: 'DRAFT_STATUS_INVALID' })
  const routingRequirements = routingRequirementsOf(draft.routingRequirements)
  const hasPendingRoutingRequirements = Object.hasOwn(draft, 'pendingRoutingRequirements')
  const pendingRoutingRequirements = hasPendingRoutingRequirements ? routingRequirementsOf(draft.pendingRoutingRequirements) : null
  return {
    content, budget, destinationRevision, requestId, status,
    ...(routingRequirements ? { routingRequirements } : {}),
    ...(pendingRequestId === null ? {} : { pendingRequestId }),
    ...(pendingContent === null ? {} : { pendingContent }),
    ...(pendingBudget === null ? {} : { pendingBudget }),
    ...(hasPendingRoutingRequirements ? { pendingRoutingRequirements } : {}),
    ...(failureCode === null ? {} : { failureCode }),
  }
}

function unresolvedDraft(draft) {
  return draft.status === 'sending' || draft.status === 'unconfirmed'
    || (draft.status !== 'accepted' && (draft.pendingRequestId !== undefined || draft.requestId !== null))
}

function normalizeStorage(storage) {
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function' || typeof storage.removeItem !== 'function') return null
  return storage
}

function defaultStorage() {
  try { return globalThis?.sessionStorage ?? null } catch { return null }
}

function ownedEntryKey(key, entryPrefix, indexKey) {
  if (typeof key !== 'string' || !key.startsWith(entryPrefix) || key === indexKey) return false
  const encoded = key.slice(entryPrefix.length)
  if (!encoded) return false
  try { return decodeURIComponent(encoded).startsWith('chimera-draft-v1:') } catch { return false }
}

export function createDraftStore({ storage = defaultStorage(), scope, now = () => Date.now(), maxDrafts = MAX_DRAFTS, onWarning } = {}) {
  const safeStorage = normalizeStorage(storage)
  const memory = new Map()
  const memoryRows = new Map()
  const scopeName = typeof scope === 'string' && scope ? scope : 'unscoped'
  const entryPrefix = `${ENTRY_PREFIX}${scopeName}:`
  const indexKey = `${entryPrefix}index`
  const keyFor = target => `${entryPrefix}${encodeURIComponent(draftKey(target))}`
  const draftLimit = Number.isSafeInteger(maxDrafts) ? Math.max(1, Math.min(MAX_DRAFTS, maxDrafts)) : MAX_DRAFTS
  if (!safeStorage && scope) warning(onWarning, 'DRAFT_PERSISTENCE_UNAVAILABLE')
  const ownedStorageKeys = () => {
    if (!safeStorage) return []
    const keys = []
    let length = 0
    try { length = Number.isSafeInteger(safeStorage.length) ? safeStorage.length : 0 } catch { warning(onWarning, 'DRAFT_PERSISTENCE_UNAVAILABLE') }
    for (let index = 0; index < length; index += 1) {
      let key
      try { key = safeStorage.key(index) } catch { key = null }
      if (ownedEntryKey(key, entryPrefix, indexKey)) keys.push(key)
    }
    return keys
  }
  const readIndex = () => {
    const rows = new Map(memoryRows)
    if (!safeStorage) return [...rows.values()]
    let parsed = []
    try {
      const raw = safeStorage.getItem(indexKey)
      if (raw) {
        const candidate = JSON.parse(raw)
        if (Array.isArray(candidate)) parsed = candidate
      }
    } catch { warning(onWarning, 'DRAFT_PERSISTENCE_UNAVAILABLE') }
    const keys = new Set([
      ...parsed.filter(row => ownedEntryKey(row?.key, entryPrefix, indexKey)).map(row => row.key),
      ...ownedStorageKeys(),
    ])
    for (const key of keys) {
      const inMemory = memoryRows.get(key)
      if (inMemory && memory.has(key)) {
        rows.set(key, { ...inMemory, authoritative: true })
        continue
      }
      // The index is only a locator. Always validate the current entry before
      // using status/content for pruning; a partial index write must never
      // turn a newer unsent draft into removable stale metadata.
      try {
        const raw = safeStorage.getItem(key)
        const entry = raw ? JSON.parse(raw) : null
        const draft = normalizeDraft(entry?.draft)
        const updatedAt = Number(entry?.updatedAt)
        if (!Number.isFinite(updatedAt)) throw new Error('invalid draft timestamp')
        if (draft.status === 'sending') draft.status = 'unconfirmed'
        memory.set(key, clone(draft))
        const row = { key, status: draft.status, contentBytes: utf8Bytes(draft.content), updatedAt, unresolved: unresolvedDraft(draft), authoritative: true }
        memoryRows.set(key, { ...row })
        rows.set(key, row)
      } catch {
        // Retain a locator with non-removable metadata when its entry cannot
        // be read. This may conservatively block a new draft, but cannot lose
        // an unsent request through a corrupt/partial index.
        const indexed = parsed.find(candidate => candidate?.key === key && Number.isFinite(candidate.updatedAt))
        const prior = rows.get(key)
        if (indexed || prior) rows.set(key, { ...(prior ?? indexed), key, authoritative: false })
        warning(onWarning, 'DRAFT_PERSISTENCE_UNAVAILABLE')
      }
    }
    return [...rows.values()]
  }
  const writeIndex = rows => {
    if (!safeStorage) return false
    try { safeStorage.setItem(indexKey, JSON.stringify(rows)); return true } catch { warning(onWarning, 'DRAFT_PERSISTENCE_UNAVAILABLE'); return false }
  }
  const readEntry = key => {
    if (memory.has(key)) return clone(memory.get(key))
    if (!safeStorage) return null
    try {
      const raw = safeStorage.getItem(key)
      if (!raw) return null
      const entry = JSON.parse(raw)
      if (!entry || typeof entry !== 'object') throw new Error('invalid')
      const result = normalizeDraft(entry.draft)
      if (result.status === 'sending') result.status = 'unconfirmed'
      memory.set(key, result)
      return clone(result)
    } catch {
      warning(onWarning, 'DRAFT_PERSISTENCE_UNAVAILABLE')
      return null
    }
  }
  const persistEntry = (key, result, updatedAt) => {
    memory.set(key, clone(result))
    memoryRows.set(key, { key, status: result.status, contentBytes: utf8Bytes(result.content), updatedAt, unresolved: unresolvedDraft(result), authoritative: true })
    if (!safeStorage) return
    try {
      safeStorage.setItem(key, JSON.stringify({ draft: result, updatedAt }))
    } catch {
      warning(onWarning, 'DRAFT_PERSISTENCE_UNAVAILABLE')
      return
    }
  }
  const prune = rows => {
    if (rows.length <= draftLimit) return rows
    const ordered = [...rows].toSorted((left, right) => left.updatedAt - right.updatedAt)
    const removable = ordered.filter(row => row.authoritative !== false && row.unresolved !== true
      && (row.status === 'accepted' || row.contentBytes === 0))
    const removeCount = Math.min(removable.length, rows.length - draftLimit)
    if (removeCount < rows.length - draftLimit) throw Object.assign(new Error('DRAFT_STORAGE_LIMIT_REACHED'), { code: 'DRAFT_STORAGE_LIMIT_REACHED' })
    const removeKeys = new Set(removable.slice(0, removeCount).map(row => row.key))
    for (const key of removeKeys) {
      memory.delete(key)
      memoryRows.delete(key)
      try { safeStorage?.removeItem(key) } catch { warning(onWarning, 'DRAFT_PERSISTENCE_UNAVAILABLE') }
    }
    return rows.filter(row => !removeKeys.has(row.key))
  }
  return {
    get(target) {
      const result = readEntry(keyFor(target))
      return result
    },
    save(target, draft) {
      const key = keyFor(target)
      const result = normalizeDraft(draft)
      const updatedAt = Number(now())
      if (!Number.isFinite(updatedAt)) throw new TypeError('DRAFT_CLOCK_INVALID')
      let rows = readIndex().filter(row => row.key !== key)
      rows.push({ key, status: result.status, contentBytes: utf8Bytes(result.content), updatedAt, unresolved: unresolvedDraft(result) })
      rows = prune(rows)
      if (rows.some(row => row.key === key)) persistEntry(key, result, updatedAt)
      else {
        memory.delete(key)
        memoryRows.delete(key)
        try { safeStorage?.removeItem(key) } catch { warning(onWarning, 'DRAFT_PERSISTENCE_UNAVAILABLE') }
      }
      writeIndex(rows)
      return clone(result)
    },
    remove(target) {
      const key = keyFor(target)
      // Read the authoritative index while the entry still exists. Removing
      // the value first leaves a stale locator that readIndex() must treat as
      // uncertain, producing a spurious persistence warning during ordinary
      // accepted-request cleanup.
      const rows = readIndex().filter(row => row.key !== key)
      memory.delete(key)
      memoryRows.delete(key)
      try { safeStorage?.removeItem(key) } catch { warning(onWarning, 'DRAFT_PERSISTENCE_UNAVAILABLE') }
      writeIndex(rows)
    },
    clearScope() {
      const keys = new Set([...memoryRows.keys(), ...readIndex().map(row => row.key), ...ownedStorageKeys()])
      for (const key of keys) {
        memory.delete(key)
        try { safeStorage?.removeItem(key) } catch { warning(onWarning, 'DRAFT_PERSISTENCE_UNAVAILABLE') }
      }
      try { safeStorage?.removeItem(indexKey) } catch { warning(onWarning, 'DRAFT_PERSISTENCE_UNAVAILABLE') }
      memory.clear()
      memoryRows.clear()
    },
  }
}

export { MAX_CONTENT_BYTES, MAX_DRAFTS }
