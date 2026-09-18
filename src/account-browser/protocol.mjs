// Browser-safe validation shared by the native transport and packaged companion.
export const MAX_MESSAGE_BYTES = 256 * 1024
export const MAX_TEXT_BYTES = 32 * 1024
export const INVALIDATION_REASONS = ['navigation', 'closed', 'replaced', 'authentication', 'human']
export const READ_ERRORS = ['stale', 'expired', 'authentication', 'human-action-required', 'extraction-failed', 'disconnected']
const encoder = new TextEncoder()
export const byteLength = value => encoder.encode(value).length
export const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
export function exactOrigin(value) {
  if (typeof value !== 'string' || value.length > 512) return false
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && url.origin === value && !url.username && !url.password } catch { return false }
}
export function extensionOrigin(value) { return typeof value === 'string' && /^chrome-extension:\/\/[a-p]{32}\/$/.test(value) }
export function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)) }
function fail() { throw new Error('Invalid companion message') }
export function validateMessage(value) {
  if (!record(value) || byteLength(JSON.stringify(value)) > MAX_MESSAGE_BYTES || !safeId(value.id)) fail()
  const shapes = {
    hello: ['profileId'], authenticate: ['pairingId', 'challenge'],
    share: ['tabId', 'documentId', 'origin', 'urlDigest', 'taskId', 'agentId', 'ttlSeconds'],
    ready: ['leaseId', 'revision', 'documentId', 'origin', 'urlDigest'],
    invalidate: ['leaseId', 'reason'], targets: [],
    'read-result': ['leaseId', 'revision', 'documentId', 'origin', 'urlDigest', 'text'],
    'read-error': ['leaseId', 'error'],
  }
  const fields = shapes[value.type]
  if (!fields || Object.keys(value).some(k => !['id', 'type', ...fields].includes(k))) fail()
  for (const field of fields) {
    const v = value[field]
    if (field === 'ttlSeconds' && v === undefined) continue
    if (['profileId', 'pairingId', 'challenge', 'documentId', 'taskId', 'agentId', 'leaseId'].includes(field) && !safeId(v)) fail()
    if (field === 'tabId' && (!Number.isSafeInteger(v) || v < 0)) fail()
    if (field === 'revision' && (!Number.isSafeInteger(v) || v < 1)) fail()
    if (field === 'ttlSeconds' && (!Number.isFinite(v) || v <= 0)) fail()
    if (field === 'origin' && !exactOrigin(v)) fail()
    if (field === 'urlDigest' && (typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v))) fail()
    if (field === 'text' && (typeof v !== 'string' || byteLength(v) > MAX_TEXT_BYTES)) fail()
    if (field === 'reason' && !INVALIDATION_REASONS.includes(v)) fail()
    if (field === 'error' && !READ_ERRORS.includes(v)) fail()
  }
  return value
}
