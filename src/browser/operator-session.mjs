import crypto from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export const OPERATOR_SESSION_SCHEMA = 'chimera.operator-session.v1'
export const OPERATOR_COOKIE_NAME = 'chimera_operator'
const SESSION_LIFETIME_MS = 12 * 60 * 60_000
const BOOTSTRAP_LIFETIME_MS = 5 * 60_000
const CSRF_LIFETIME_MS = 60 * 60_000
export const MAX_OPERATOR_CSRF_TOKENS = 64
const HASH = /^[a-f0-9]{64}$/

function fail(code) {
  return Object.assign(new Error(code), { code })
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function equalHash(expected, value) {
  if (!HASH.test(expected ?? '') || typeof value !== 'string' || value.length < 32 || value.length > 256) return false
  const actual = digest(value)
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'))
}

function readCookie(cookieHeader, name) {
  if (typeof cookieHeader !== 'string' || cookieHeader.length > 8192) return null
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 1) continue
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim()
  }
  return null
}

function validateDocument(document) {
  if (!document || typeof document !== 'object' || document.schema !== OPERATOR_SESSION_SCHEMA) throw fail('OPERATOR_SESSION_INVALID')
  for (const key of ['bootstrapHash', 'sessionHash', 'csrfHash']) {
    if (document[key] !== null && !HASH.test(document[key] ?? '')) throw fail('OPERATOR_SESSION_INVALID')
  }
  for (const key of ['bootstrapExpiresAt', 'expiresAt']) {
    if (document[key] !== null && document[key] !== undefined && !Number.isFinite(Date.parse(document[key]))) {
      throw fail('OPERATOR_SESSION_INVALID')
    }
  }
  const csrfTokens = document.csrfTokens ?? (document.csrfHash && document.expiresAt
    ? [{ hash: document.csrfHash, expiresAt: document.expiresAt }]
    : [])
  if (!Array.isArray(csrfTokens) || csrfTokens.length > MAX_OPERATOR_CSRF_TOKENS
    || csrfTokens.some((entry) => !entry || !HASH.test(entry.hash ?? '')
      || !Number.isFinite(Date.parse(entry.expiresAt))
      || !Number.isFinite(Date.parse(document.expiresAt))
      || Date.parse(entry.expiresAt) > Date.parse(document.expiresAt))) {
    throw fail('OPERATOR_SESSION_INVALID')
  }
  return { ...document, bootstrapExpiresAt: document.bootstrapExpiresAt ?? null, csrfTokens }
}

export class OperatorSessionManager {
  constructor({
    filePath,
    now = () => Date.now(),
    bootstrapLifetimeMs = BOOTSTRAP_LIFETIME_MS,
    sessionLifetimeMs = SESSION_LIFETIME_MS,
    csrfLifetimeMs = CSRF_LIFETIME_MS,
  }) {
    if (typeof filePath !== 'string' || filePath.length === 0 || filePath.length > 4096
      || !Number.isInteger(bootstrapLifetimeMs) || bootstrapLifetimeMs < 30_000 || bootstrapLifetimeMs > 15 * 60_000
      || !Number.isInteger(sessionLifetimeMs) || sessionLifetimeMs < 60_000 || sessionLifetimeMs > 7 * 24 * 60 * 60_000
      || !Number.isInteger(csrfLifetimeMs) || csrfLifetimeMs < 30_000 || csrfLifetimeMs > 7 * 24 * 60 * 60_000) {
      throw new TypeError('OPERATOR_SESSION_CONFIG_INVALID')
    }
    this.filePath = resolve(filePath)
    this.now = now
    this.bootstrapLifetimeMs = bootstrapLifetimeMs
    this.sessionLifetimeMs = sessionLifetimeMs
    this.csrfLifetimeMs = csrfLifetimeMs
    this.document = {
      schema: OPERATOR_SESSION_SCHEMA,
      bootstrapHash: null,
      bootstrapExpiresAt: null,
      sessionHash: null,
      csrfHash: null,
      csrfTokens: [],
      expiresAt: null,
    }
  }

  static async open(options) {
    const manager = new OperatorSessionManager(options)
    mkdirSync(dirname(manager.filePath), { recursive: true, mode: 0o700 })
    try {
      const info = lstatSync(manager.filePath)
      if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw fail('OPERATOR_SESSION_PERMISSIONS_INVALID')
      manager.document = structuredClone(validateDocument(JSON.parse(readFileSync(manager.filePath, 'utf8'))))
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        if (['OPERATOR_SESSION_INVALID', 'OPERATOR_SESSION_PERMISSIONS_INVALID'].includes(error?.code)) throw error
        throw fail('OPERATOR_SESSION_INVALID')
      }
    }
    return manager
  }

  issueBootstrap() {
    const token = crypto.randomBytes(32).toString('base64url')
    this.document.bootstrapHash = digest(token)
    this.document.bootstrapExpiresAt = new Date(this.now() + this.bootstrapLifetimeMs).toISOString()
    this.#persist()
    return token
  }

  exchangeBootstrap(token) {
    const expiresAt = Date.parse(this.document.bootstrapExpiresAt)
    if (!equalHash(this.document.bootstrapHash, token)
      || !Number.isFinite(expiresAt)
      || this.now() >= expiresAt) {
      if (Number.isFinite(expiresAt) && this.now() >= expiresAt) {
        this.document.bootstrapHash = null
        this.document.bootstrapExpiresAt = null
        this.#persist()
      }
      throw fail('OPERATOR_BOOTSTRAP_INVALID')
    }
    const cookieToken = crypto.randomBytes(32).toString('base64url')
    this.document = {
      schema: OPERATOR_SESSION_SCHEMA,
      bootstrapHash: null,
      bootstrapExpiresAt: null,
      sessionHash: digest(cookieToken),
      csrfHash: null,
      csrfTokens: [],
      expiresAt: new Date(this.now() + this.sessionLifetimeMs).toISOString(),
    }
    const csrf = this.issueCsrf()
    return {
      cookieName: OPERATOR_COOKIE_NAME,
      cookieToken,
      ...csrf,
    }
  }

  authenticate(cookieHeader) {
    if (!this.#active()) return false
    return equalHash(this.document.sessionHash, readCookie(cookieHeader, OPERATOR_COOKIE_NAME))
  }

  verifyCsrf(token) {
    return this.#active() && this.document.csrfTokens.some((entry) =>
      this.now() < Date.parse(entry.expiresAt) && equalHash(entry.hash, token))
  }

  rotateCsrf() {
    return this.issueCsrf().csrfToken
  }

  issueCsrf() {
    if (!this.#active()) throw fail('OPERATOR_SESSION_EXPIRED')
    const token = crypto.randomBytes(32).toString('base64url')
    const expiresAt = new Date(Math.min(this.now() + this.csrfLifetimeMs, Date.parse(this.document.expiresAt))).toISOString()
    const hash = digest(token)
    // Each tab keeps its own token. Bound storage and discard expired/oldest tokens.
    this.document.csrfTokens = this.document.csrfTokens
      .filter((entry) => this.now() < Date.parse(entry.expiresAt))
      .slice(-(MAX_OPERATOR_CSRF_TOKENS - 1))
    this.document.csrfTokens.push({ hash, expiresAt })
    this.document.csrfHash = hash
    this.#persist()
    return { csrfToken: token, expiresAt, sessionExpiresAt: this.document.expiresAt }
  }

  cookieHeader(cookieToken) {
    const seconds = Math.max(0, Math.floor((Date.parse(this.document.expiresAt) - this.now()) / 1000))
    return `${OPERATOR_COOKIE_NAME}=${cookieToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${seconds}`
  }

  #active() {
    return HASH.test(this.document.sessionHash ?? '')
      && Number.isFinite(Date.parse(this.document.expiresAt))
      && this.now() < Date.parse(this.document.expiresAt)
  }

  #persist() {
    const temporary = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
    try {
      writeFileSync(temporary, `${JSON.stringify(this.document, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
      renameSync(temporary, this.filePath)
      chmodSync(this.filePath, 0o600)
    } finally {
      rmSync(temporary, { force: true })
    }
  }
}
