import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { inspectCodexLoginUrl } from '../browser/auth-navigation.mjs'

function boundedString(value, maximum = 2048) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function codedError(code, message = code) {
  const error = new Error(message)
  error.code = code
  return error
}

function safePlanType(value) {
  return boundedString(value, 64) && /^[a-z0-9_-]+$/i.test(value) ? value : null
}

function safeAccountState(result, login) {
  const connected = result?.account?.type === 'chatgpt'
  const planType = connected ? safePlanType(result.account.planType) : null
  return {
    provider: 'codex',
    available: true,
    connected,
    status: connected ? 'connected' : 'disconnected',
    ...(connected ? { authentication: 'chatgpt-subscription' } : {}),
    ...(planType ? { planType } : {}),
    ...(login ? { login: structuredClone(login) } : {}),
  }
}

function safeUpdatedState(params, login) {
  const connected = params?.authMode === 'chatgpt'
  const planType = connected ? safePlanType(params?.planType) : null
  return {
    provider: 'codex',
    available: true,
    connected,
    status: connected ? 'connected' : 'disconnected',
    ...(connected ? { authentication: 'chatgpt-subscription' } : {}),
    ...(planType ? { planType } : {}),
    ...(login ? { login: structuredClone(login) } : {}),
  }
}

export class CodexAppServerAuth {
  constructor({
    spawnImpl = spawn,
    requestTimeoutMs = 10_000,
  } = {}) {
    if (typeof spawnImpl !== 'function'
      || !Number.isSafeInteger(requestTimeoutMs)
      || requestTimeoutMs < 100
      || requestTimeoutMs > 60_000) {
      throw new TypeError('invalid Codex App Server auth configuration')
    }
    this.spawnImpl = spawnImpl
    this.requestTimeoutMs = requestTimeoutMs
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Set()
    this.current = {
      provider: 'codex',
      available: false,
      connected: false,
      status: 'unavailable',
      error: 'CODEX_APP_SERVER_NOT_STARTED',
    }
    this.child = null
    this.reader = null
    this.starting = null
    this.closing = false
    this.loginUrl = null
    this.callbackUrl = null
  }

  state() {
    return structuredClone(this.current)
  }

  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('Codex auth listener is required')
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async start() {
    if (this.starting) return this.starting
    if (this.child) return this.state()
    this.starting = this.#startProcess()
    try {
      return await this.starting
    } finally {
      this.starting = null
    }
  }

  async #startProcess() {
    this.closing = false
    let child
    try {
      child = this.spawnImpl('codex', ['app-server'], {
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      })
    } catch {
      this.#setUnavailable('CODEX_APP_SERVER_UNAVAILABLE')
      throw codedError('CODEX_APP_SERVER_UNAVAILABLE')
    }
    if (!child?.stdin || !child?.stdout || typeof child.kill !== 'function') {
      this.#setUnavailable('CODEX_APP_SERVER_UNAVAILABLE')
      throw codedError('CODEX_APP_SERVER_UNAVAILABLE')
    }
    this.child = child
    this.reader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
    this.reader.on('line', (line) => this.#receiveLine(line))
    child.once('error', () => this.#processEnded('CODEX_APP_SERVER_UNAVAILABLE'))
    child.once('exit', () => this.#processEnded('CODEX_APP_SERVER_EXITED'))
    try {
      await this.#request('initialize', {
        clientInfo: {
          name: 'chimera',
          title: 'Chimera',
          version: '0.0.1',
        },
      })
      this.#notify('initialized', {})
      this.current = {
        provider: 'codex',
        available: true,
        connected: false,
        status: 'disconnected',
      }
      this.#emit()
      return this.state()
    } catch (error) {
      await this.close()
      throw error
    }
  }

  async read({ refreshToken = false } = {}) {
    if (typeof refreshToken !== 'boolean') throw new TypeError('refreshToken must be boolean')
    await this.start()
    const result = await this.#request('account/read', { refreshToken })
    this.current = safeAccountState(result, this.current.login)
    this.#emit()
    return this.state()
  }

  async startLogin() {
    await this.start()
    if (this.current.login?.status === 'pending' && this.loginUrl) {
      return { loginId: this.current.login.loginId, authUrl: this.loginUrl, callbackUrl: this.callbackUrl }
    }
    const result = await this.#request('account/login/start', {
      type: 'chatgpt',
      useHostedLoginSuccessPage: true,
      appBrand: 'chatgpt',
    })
    if (result?.type !== 'chatgpt' || !boundedString(result?.loginId, 256)) {
      throw codedError('CODEX_AUTH_RESPONSE_INVALID')
    }
    const { authUrl, callbackUrl } = inspectCodexLoginUrl(result.authUrl)
    const login = { loginId: result.loginId, status: 'pending' }
    this.loginUrl = authUrl
    this.callbackUrl = callbackUrl
    this.current = {
      ...this.current,
      available: true,
      connected: false,
      status: 'connecting',
      login,
    }
    delete this.current.authentication
    delete this.current.planType
    delete this.current.error
    this.#emit()
    return { loginId: result.loginId, authUrl, callbackUrl }
  }

  async cancelLogin() {
    const loginId = this.current.login?.status === 'pending' ? this.current.login.loginId : null
    if (!loginId) throw codedError('CODEX_AUTH_LOGIN_NOT_PENDING')
    await this.#request('account/login/cancel', { loginId })
    return this.state()
  }

  #request(method, params = {}) {
    if (!this.child?.stdin?.writable) return Promise.reject(codedError('CODEX_APP_SERVER_UNAVAILABLE'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(codedError('CODEX_APP_SERVER_TIMEOUT'))
      }, this.requestTimeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.child.stdin.write(`${JSON.stringify({ method, id, params })}\n`)
      } catch {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(codedError('CODEX_APP_SERVER_UNAVAILABLE'))
      }
    })
  }

  #notify(method, params = {}) {
    if (!this.child?.stdin?.writable) throw codedError('CODEX_APP_SERVER_UNAVAILABLE')
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`)
  }

  #receiveLine(line) {
    if (!boundedString(line, 1_048_576)) return
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (Number.isSafeInteger(message?.id) && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)
      clearTimeout(pending.timer)
      this.pending.delete(message.id)
      if (message.error) pending.reject(codedError('CODEX_APP_SERVER_REQUEST_FAILED'))
      else pending.resolve(message.result)
      return
    }
    if (message?.method === 'account/login/completed') this.#loginCompleted(message.params)
    if (message?.method === 'account/updated') {
      this.current = safeUpdatedState(message.params, this.current.login)
      this.#emit()
    }
  }

  #loginCompleted(params) {
    const currentLogin = this.current.login
    if (!currentLogin || params?.loginId !== currentLogin.loginId) return
    const success = params?.success === true
    this.loginUrl = null
    this.callbackUrl = null
    this.current = {
      ...this.current,
      status: success ? 'connecting' : 'disconnected',
      login: {
        loginId: currentLogin.loginId,
        status: success ? 'succeeded' : 'failed',
        ...(!success ? { error: 'CODEX_AUTH_LOGIN_FAILED' } : {}),
      },
    }
    this.#emit()
  }

  #emit() {
    const snapshot = this.state()
    for (const listener of this.listeners) listener(snapshot)
  }

  #setUnavailable(error) {
    this.current = {
      provider: 'codex',
      available: false,
      connected: false,
      status: 'unavailable',
      error,
    }
    this.#emit()
  }

  #processEnded(code) {
    const wasClosing = this.closing
    this.child = null
    this.reader?.close()
    this.reader = null
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(codedError(wasClosing ? 'CODEX_APP_SERVER_CLOSED' : code))
    }
    this.pending.clear()
    if (!wasClosing) this.#setUnavailable(code)
  }

  async close() {
    this.closing = true
    const child = this.child
    this.child = null
    this.reader?.close()
    this.reader = null
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(codedError('CODEX_APP_SERVER_CLOSED'))
    }
    this.pending.clear()
    if (child) {
      child.stdin?.end()
      child.kill('SIGTERM')
    }
  }
}
