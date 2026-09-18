const REDACTED = '[REDACTED]'
const SENSITIVE_KEY = /(?:^|[_-])(authorization|cookie|credential|password|passwd|private[_-]?key|secret|session|token|api[_-]?key)(?:$|[_-])/i
const STRING_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:sk|pk|ghp|gho|github_pat|xox[baprs])[-_A-Za-z0-9]{10,}\b/g,
  /\b(?:api[_-]?key|authorization|cookie|password|passwd|private[_-]?key|secret|session|token)\s*[:=]\s*[^\s,;]+/gi,
]

function redactString(value) {
  return STRING_PATTERNS.reduce((current, pattern) => current.replace(pattern, REDACTED), value)
}

function redactValue(value, depth = 0) {
  if (depth > 12) return '[TRUNCATED]'
  if (typeof value === 'string') return redactString(value)
  if (Array.isArray(value)) return value.slice(0, 256).map((entry) => redactValue(entry, depth + 1))
  if (!value || typeof value !== 'object') return value
  const projected = {}
  for (const [key, entry] of Object.entries(value).slice(0, 256)) {
    projected[key] = SENSITIVE_KEY.test(`_${key}_`) ? REDACTED : redactValue(entry, depth + 1)
  }
  return projected
}

export function redactSensitiveData(value) {
  return redactValue(structuredClone(value))
}

export function redactSensitiveText(value) {
  return typeof value === 'string' ? redactString(value) : value
}
