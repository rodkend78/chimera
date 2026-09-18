const TRUSTED_AUTH_HOSTS = new Set(['chatgpt.com', 'auth.openai.com'])
const CALLBACK_HOSTS = new Set(['localhost', '127.0.0.1'])
const CALLBACK_PATH = '/auth/callback'

function codedTypeError(code) {
  const error = new TypeError(code)
  error.code = code
  return error
}

function boundedString(value, maximum = 16_384) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function parseUrl(value, code) {
  if (!boundedString(value)) throw codedTypeError(code)
  try {
    return new URL(value)
  } catch {
    throw codedTypeError(code)
  }
}

function inspectCallbackUrl(value) {
  const parsed = parseUrl(value, 'CODEX_AUTH_CALLBACK_UNTRUSTED')
  const port = Number(parsed.port)
  if (parsed.protocol !== 'http:'
    || !CALLBACK_HOSTS.has(parsed.hostname)
    || !Number.isSafeInteger(port)
    || port < 1024
    || port > 65_535
    || parsed.pathname !== CALLBACK_PATH
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash) {
    throw codedTypeError('CODEX_AUTH_CALLBACK_UNTRUSTED')
  }
  return parsed.toString()
}

export function inspectCodexLoginUrl(value) {
  const parsed = parseUrl(value, 'CODEX_AUTH_URL_UNTRUSTED')
  if (parsed.protocol !== 'https:' || !TRUSTED_AUTH_HOSTS.has(parsed.hostname)) {
    throw codedTypeError('CODEX_AUTH_URL_UNTRUSTED')
  }
  const redirect = parsed.searchParams.get('redirect_uri')
  return {
    authUrl: parsed.toString(),
    callbackUrl: inspectCallbackUrl(redirect),
  }
}

export function isSensitiveBrowserUrl(value) {
  if (!boundedString(value)) return false
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  return (parsed.protocol === 'https:' && TRUSTED_AUTH_HOSTS.has(parsed.hostname))
    || (parsed.protocol === 'http:' && CALLBACK_HOSTS.has(parsed.hostname) && parsed.pathname === CALLBACK_PATH)
}

export function redactSensitiveBrowserUrl(value) {
  if (!isSensitiveBrowserUrl(value)) return value
  const parsed = new URL(value)
  parsed.search = ''
  parsed.hash = ''
  return parsed.toString()
}

export class TemporaryCallbackPolicy {
  constructor({ now = () => Date.now() } = {}) {
    if (typeof now !== 'function') throw new TypeError('temporary callback policy requires a clock')
    this.now = now
    this.destinations = new Map()
  }

  allow(value, { lifetimeMs = 15 * 60_000 } = {}) {
    if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1_000 || lifetimeMs > 15 * 60_000) {
      throw new TypeError('temporary callback lifetime is invalid')
    }
    const callbackUrl = inspectCallbackUrl(value)
    const parsed = new URL(callbackUrl)
    this.destinations.set(`${parsed.origin}${parsed.pathname}`, this.now() + lifetimeMs)
    return callbackUrl
  }

  allows(value) {
    let parsed
    try {
      parsed = new URL(value)
    } catch {
      return false
    }
    if (parsed.protocol !== 'http:'
      || !CALLBACK_HOSTS.has(parsed.hostname)
      || parsed.pathname !== CALLBACK_PATH
      || parsed.username
      || parsed.password
      || parsed.hash) return false
    const key = `${parsed.origin}${parsed.pathname}`
    const expiresAt = this.destinations.get(key)
    if (!expiresAt || expiresAt < this.now()) {
      this.destinations.delete(key)
      return false
    }
    return true
  }
}
