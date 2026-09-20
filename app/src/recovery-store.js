// Small, browser-safe persistence primitives for direct task/project controls.
// A recovery record is never silently dropped: existing over-limit records stay
// visible in memory with a warning, while new records are refused at the bound.

export const MAX_RECOVERY_ENTRIES = 50

export function safeSessionStorage() {
  try { return globalThis?.sessionStorage ?? null } catch { return null }
}

function warn(onWarning, code) {
  try { onWarning?.(code) } catch { /* a warning must not break recovery */ }
}

function matchingKeys(storage, prefix, onWarning) {
  if (!storage) return []
  let length = 0
  try {
    length = Number.isSafeInteger(storage.length) && storage.length >= 0 ? storage.length : null
  } catch {
    warn(onWarning, 'LOCAL_RECOVERY_UNAVAILABLE')
    return null
  }
  if (length === null) {
    warn(onWarning, 'LOCAL_RECOVERY_UNAVAILABLE')
    return null
  }
  const keys = []
  for (let index = 0; index < length; index += 1) {
    try {
      const key = storage.key(index)
      if (typeof key === 'string' && key.startsWith(prefix)) keys.push(key)
    } catch {
      warn(onWarning, 'LOCAL_RECOVERY_UNAVAILABLE')
      return null
    }
  }
  return keys
}

export function readScopedEntries({ storage = safeSessionStorage(), prefix, maxEntries = MAX_RECOVERY_ENTRIES, parse, onWarning } = {}) {
  const rows = {}
  if (!storage) {
    warn(onWarning, 'LOCAL_RECOVERY_UNAVAILABLE')
    return { rows, warning: 'LOCAL_RECOVERY_UNAVAILABLE' }
  }
  let warningCode = null
  const keys = matchingKeys(storage, prefix, code => { warningCode ??= code; warn(onWarning, code) })
  if (keys === null) return { rows, warning: warningCode ?? 'LOCAL_RECOVERY_UNAVAILABLE' }
  for (const key of keys) {
    let raw
    try { raw = storage.getItem(key) } catch {
      warningCode ??= 'LOCAL_RECOVERY_UNAVAILABLE'
      warn(onWarning, 'LOCAL_RECOVERY_UNAVAILABLE')
      continue
    }
    try {
      const value = parse(raw)
      if (value !== null && value !== undefined) rows[key] = value
    } catch {
      warningCode ??= 'LOCAL_RECOVERY_CORRUPT'
      warn(onWarning, 'LOCAL_RECOVERY_CORRUPT')
    }
  }
  if (Object.keys(rows).length > maxEntries) {
    warningCode ??= 'LOCAL_RECOVERY_LIMIT'
    warn(onWarning, 'LOCAL_RECOVERY_LIMIT')
  }
  return { rows, ...(warningCode ? { warning: warningCode } : {}) }
}

export function writeScopedEntry({ storage = safeSessionStorage(), prefix, key, value, maxEntries = MAX_RECOVERY_ENTRIES, onWarning } = {}) {
  if (!storage) {
    warn(onWarning, 'LOCAL_RECOVERY_UNAVAILABLE')
    return { ok: false, warning: 'LOCAL_RECOVERY_UNAVAILABLE' }
  }
  if (typeof key !== 'string' || !key.startsWith(prefix)) {
    warn(onWarning, 'LOCAL_RECOVERY_INVALID_KEY')
    return { ok: false, warning: 'LOCAL_RECOVERY_INVALID_KEY' }
  }
  let existing
  try { existing = storage.getItem(key) } catch {
    warn(onWarning, 'LOCAL_RECOVERY_UNAVAILABLE')
    return { ok: false, warning: 'LOCAL_RECOVERY_UNAVAILABLE' }
  }
  const keys = matchingKeys(storage, prefix, onWarning)
  if (keys === null) return { ok: false, warning: 'LOCAL_RECOVERY_UNAVAILABLE' }
  if (existing === null && keys.length >= maxEntries) {
    warn(onWarning, 'LOCAL_RECOVERY_LIMIT')
    return { ok: false, warning: 'LOCAL_RECOVERY_LIMIT' }
  }
  try {
    storage.setItem(key, JSON.stringify(value))
    return { ok: true }
  } catch {
    warn(onWarning, 'LOCAL_RECOVERY_WRITE_FAILED')
    return { ok: false, warning: 'LOCAL_RECOVERY_WRITE_FAILED' }
  }
}

export function removeScopedEntry({ storage = safeSessionStorage(), key, onWarning } = {}) {
  if (!storage) {
    warn(onWarning, 'LOCAL_RECOVERY_UNAVAILABLE')
    return { ok: false, warning: 'LOCAL_RECOVERY_UNAVAILABLE' }
  }
  try {
    storage.removeItem(key)
    return { ok: true }
  } catch {
    warn(onWarning, 'LOCAL_RECOVERY_WRITE_FAILED')
    return { ok: false, warning: 'LOCAL_RECOVERY_WRITE_FAILED' }
  }
}

export function recoveryWarningMessage(code) {
  if (code === 'LOCAL_RECOVERY_LIMIT') return 'Local recovery storage has reached its 50-entry limit. New recovery records are blocked; existing evidence is retained until you clear an acknowledged record.'
  if (code === 'LOCAL_RECOVERY_CORRUPT') return 'A local recovery record could not be read. Inspect the task history before taking another action.'
  if (code === 'LOCAL_RECOVERY_WRITE_FAILED') return 'Local recovery storage rejected an update. Recovery state may be stale; your editable draft remains on this page.'
  if (code === 'LOCAL_RECOVERY_INVALID_KEY') return 'This recovery record has an invalid destination.'
  return 'Local recovery storage is unavailable. Recovery state may not survive reload; your editable draft remains on this page.'
}
