import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { execFile, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { privateJson, intakeError } from './intake-store.mjs'
import { boundedJson } from './google-intake.mjs'
import { googleConfigFromEnv, validGoogleAccount } from './google-config.mjs'
import { LinuxSecretStore } from './linux-secret-store.mjs'
import { desktopEnvironment } from '../platform/desktop.mjs'

export const GOOGLE_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/forms.body.readonly', 'https://www.googleapis.com/auth/forms.responses.readonly', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/drive.metadata.readonly']
export { GOOGLE_ACCOUNT_ENV, GOOGLE_FORM_ID_ENV, googleConfigFromEnv } from './google-config.mjs'
// Google is an optional connector. A public checkout must not inherit an
// operator identity; configure one explicitly before enabling intake.
export const GOOGLE_ACCOUNT = null
export const validOAuthState = (candidate, expected) => typeof candidate === 'string' && /^[A-Za-z0-9_-]+$/.test(candidate) && Buffer.byteLength(candidate) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(candidate), Buffer.from(expected))
// Static helper source uses Security.framework. Secrets travel over pipes, never argv.
export class MacKeychain {
  constructor({ service = 'com.team-rsi.chimera.client-intake', account = 'chimera-google' } = {}) { Object.assign(this, { service, account }) }
  async available() { return process.platform === 'darwin' }
  command(action, value) {
    if (process.platform !== 'darwin') return Promise.reject(intakeError('KEYCHAIN_UNAVAILABLE'))
    return new Promise((resolvePromise, reject) => {
      const child = spawn('/usr/bin/swift', [fileURLToPath(new URL('./keychain.swift', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'] })
      let output = ''; let length = 0
      const timer = setTimeout(() => { child.kill(); reject(intakeError('KEYCHAIN_UNAVAILABLE')) }, 30000)
      child.stdout.on('data', chunk => { length += chunk.length; if (length > 65536) child.kill(); else output += chunk })
      child.stderr.resume() // Native errors must never escape into logs or API errors.
      child.on('error', () => { clearTimeout(timer); reject(intakeError('KEYCHAIN_UNAVAILABLE')) })
      child.on('close', code => { clearTimeout(timer); if (code !== 0 || length > 65536) reject(intakeError('KEYCHAIN_UNAVAILABLE')); else { try { resolvePromise(JSON.parse(output)) } catch { reject(intakeError('KEYCHAIN_UNAVAILABLE')) } } })
      child.stdin.on('error', () => {})
      child.stdin.end(JSON.stringify({ action, service: this.service, account: this.account, value }))
    })
  }
  get() { return this.command('get') }
  set(value) { return this.command('set', value) }
  delete() { return this.command('delete') }
}
export function openGoogleConsent(url, { platform = process.platform, execFileImpl = execFile } = {}) {
  if (!['linux','darwin'].includes(platform)) return Promise.reject(intakeError('BROWSER_UNAVAILABLE'))
  return new Promise((resolvePromise,reject)=>execFileImpl(platform==='linux'?'/usr/bin/xdg-open':'/usr/bin/open',[url],
    {env:desktopEnvironment(),timeout:10000,maxBuffer:65536},error=>error?reject(intakeError('BROWSER_UNAVAILABLE')):resolvePromise()))
}
export class GoogleConnection {
  constructor({ clientFile = process.env.CHIMERA_GOOGLE_CLIENT_FILE ?? '.chimera/google/client.json', account, keychain, fetch = globalThis.fetch, openBrowser = openGoogleConsent, now = () => Date.now(), authorizationTtlMs = 300000 } = {}) {
    let expectedAccount = null, configError = null
    try {
      expectedAccount = account === undefined ? googleConfigFromEnv()?.account ?? null : account === null ? null : String(account).trim().toLowerCase()
      if (expectedAccount !== null && !validGoogleAccount(expectedAccount)) throw intakeError('GOOGLE_CONFIG_INVALID')
    } catch (error) { configError = error?.code ?? 'CLIENT_INTAKE_GOOGLE_CONFIG_INVALID'; expectedAccount = null }
    const secretStore = keychain ?? (process.platform === 'linux'
      ? new LinuxSecretStore({ account: expectedAccount ?? 'chimera-google' })
      : new MacKeychain({ account: expectedAccount ?? 'chimera-google' }))
    Object.assign(this, { clientFile: resolve(clientFile), keychain: secretStore, fetch, openBrowser, now, authorizationTtlMs,
      expectedAccount, configError }); this.state = 'disconnected'; this.account = null; this.generation = 0
  }
  registration() {
    const client = privateJson(this.clientFile, 16384)?.installed
    if (!client || typeof client.client_id !== 'string' || !client.client_id.endsWith('.apps.googleusercontent.com') || typeof client.client_secret !== 'string' || !client.client_secret || !Array.isArray(client.redirect_uris) || !client.redirect_uris.some(u => /^http:\/\/localhost\/?$/.test(u))) throw intakeError('GOOGLE_SETUP_REQUIRED')
    return client
  }
  async status() {
    try {
      if (this.configError || !this.expectedAccount) throw intakeError(this.configError ? 'GOOGLE_CONFIG_INVALID' : 'GOOGLE_SETUP_REQUIRED')
      this.registration(); if (!await this.keychain.available()) throw Error()
    } catch { return { state: 'setup_required', account: null, setupMessage: 'Configure CHIMERA_GOOGLE_ACCOUNT and, for intake polling, CHIMERA_GOOGLE_FORM_ID. Provide a private (0600) installed-app JSON at CHIMERA_GOOGLE_CLIENT_FILE (default .chimera/google/client.json), and enable the OS credential store (macOS Keychain or Linux Secret Service with secret-tool).' } }
    return { state: this.state, account: this.account, setupMessage: this.state === 'setup_required' ? 'The OS credential store is unavailable or locked. Unlock the desktop keyring (Linux needs secret-tool; macOS needs Swift), then restart Chimera.' : this.state === 'error' ? this.error ?? 'CLIENT_INTAKE_GOOGLE_AUTH_FAILED' : null }
  }
  async requestToken(parameters, signal) {
    const client = this.registration()
    return boundedJson(this.fetch, 'https://oauth2.googleapis.com/token', { method: 'POST', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : undefined, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...parameters, client_id: client.client_id, client_secret: client.client_secret }) }, 65536)
  }
  async verify(token, signal) {
    if (!this.expectedAccount) throw intakeError(this.configError ? 'GOOGLE_CONFIG_INVALID' : 'GOOGLE_SETUP_REQUIRED')
    if (typeof token.access_token !== 'string' || !token.access_token || !Number.isFinite(token.expires_in) || token.expires_in <= 0) throw intakeError('GOOGLE_AUTH_FAILED')
    const scopes = new Set(String(token.scope ?? '').split(' '))
    if (GOOGLE_SCOPES.some(scope => !scopes.has(scope) && !(scope === 'email' && scopes.has('https://www.googleapis.com/auth/userinfo.email')))) throw intakeError('GOOGLE_SCOPE_REQUIRED')
    const identity = await boundedJson(this.fetch, 'https://openidconnect.googleapis.com/v1/userinfo', { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : undefined, headers: { authorization: `Bearer ${token.access_token}` } }, 65536)
    if (identity.email_verified !== true || identity.email?.toLowerCase() !== this.expectedAccount || !identity.sub) throw intakeError('GOOGLE_ACCOUNT_MISMATCH')
    return { accessToken: token.access_token, expiresAt: this.now() + token.expires_in * 1000, email: this.expectedAccount }
  }
  authError(error) { this.token = null; this.account = null; this.state = error?.code === 'CLIENT_INTAKE_KEYCHAIN_UNAVAILABLE' ? 'setup_required' : 'error'; this.error = /^CLIENT_INTAKE_GOOGLE_[A-Z_]+$/.test(error?.code) ? error.code : 'CLIENT_INTAKE_GOOGLE_AUTH_FAILED' }
  restore() {
    if (this.closing || this.state === 'authorizing') return Promise.reject(intakeError('GOOGLE_AUTH_CANCELLED'))
    if (this.restoration?.generation === this.generation && !this.restoration.controller.signal.aborted) return this.restoration.promise
    // Startup restores and token refreshes share one operation. Capture ownership
    // before status/keychain/network can yield, and retire promptly on disconnect.
    const generation = this.generation
    const controller = new AbortController(), operation = { generation, controller, promise: null }
    this.restoration = operation
    let onAbort
    const cancelled = new Promise((_, reject) => { onAbort = () => reject(intakeError('GOOGLE_AUTH_CANCELLED')); controller.signal.addEventListener('abort', onAbort, { once: true }) })
    operation.promise = Promise.race([this.runRestore(generation, controller.signal), cancelled]).finally(() => {
      controller.signal.removeEventListener('abort', onAbort)
      if (this.restoration === operation) this.restoration = null
    })
    return operation.promise
  }
  async runRestore(generation, signal) {
    const current = () => !this.closing && !signal.aborted && generation === this.generation
    const assertCurrent = () => { if (!current()) throw intakeError('GOOGLE_AUTH_CANCELLED') }
    try {
      const status = await this.status()
      assertCurrent()
      if (status.state === 'setup_required') return
      const saved = await this.keychain.get()
      assertCurrent()
      if (!saved?.refreshToken) { this.token = null; this.account = null; this.state = 'disconnected'; return }
      const token = await this.requestToken({ grant_type: 'refresh_token', refresh_token: saved.refreshToken }, signal)
      assertCurrent()
      const verified = await this.verify(token, signal)
      assertCurrent()
      this.token = verified; this.account = this.expectedAccount; this.state = 'connected'; this.error = null
    } catch (error) { if (current()) this.authError(error); throw intakeError('GOOGLE_AUTH_FAILED') }
  }
  async accessToken() {
    if (this.state !== 'connected') throw intakeError('DISCONNECTED')
    if (!this.token || this.token.expiresAt <= this.now() + 60000) {
      await this.restore()
    }
    if (!this.token) throw intakeError('DISCONNECTED')
    return this.token.accessToken
  }
  async connect() {
    if (this.closing || this.state === 'authorizing' || this.pending) return this.status()
    // Reserve this attempt before status can yield to disconnect or another connect.
    const generation = ++this.generation
    this.restoration?.controller.abort()
    const status = await this.status()
    if (this.closing || generation !== this.generation || status.state === 'setup_required' || this.pending) return this.status()
    const client = this.registration()
    this.state = 'authorizing'; this.account = null; this.token = null
    const pending = { state: randomBytes(32).toString('base64url'), verifier: randomBytes(48).toString('base64url'), expiresAt: this.now() + this.authorizationTtlMs }
    this.pending = pending
    const server = createServer(async (request, response) => {
      const reply = (status, message) => { response.writeHead(status, { 'content-type': 'text/plain', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'" }); response.end(message) }
      let url
      try { url = new URL(request.url, pending.redirectUri) } catch { reply(400, 'Invalid callback.'); return }
      const state = url.searchParams.get('state') ?? ''
      if (request.method !== 'GET' || url.pathname !== '/' || request.headers.host !== new URL(pending.redirectUri).host || this.pending !== pending || !validOAuthState(state, pending.state)) { reply(400, 'Invalid callback.'); return }
      this.pending = null; clearTimeout(this.expiryTimer)
      this.callbackWork = (async () => {
      try {
        if (this.now() >= pending.expiresAt || url.searchParams.has('error') || !url.searchParams.get('code')) throw intakeError('GOOGLE_AUTH_DENIED')
        const token = await this.requestToken({ grant_type: 'authorization_code', code: url.searchParams.get('code'), redirect_uri: pending.redirectUri, code_verifier: pending.verifier })
        const verified = await this.verify(token)
        if (!token.refresh_token || generation !== this.generation) throw intakeError('GOOGLE_AUTH_CANCELLED')
        await this.keychain.set({ refreshToken: token.refresh_token })
        if (generation !== this.generation) throw intakeError('GOOGLE_AUTH_CANCELLED')
        this.token = verified; this.account = this.expectedAccount; this.state = 'connected'; this.error = null
        reply(200, 'Google connected. Return to Chimera.')
      } catch (error) { if (generation === this.generation) this.authError(error); reply(400, 'Google authorization failed. Return to Chimera.') }
      finally { server.close() }
      })()
      await this.callbackWork
    })
    this.server = server
    await new Promise((resolvePromise, reject) => { server.once('error', reject); server.once('close', resolvePromise); server.listen(0, '127.0.0.1', resolvePromise) })
    if (this.closing || generation !== this.generation || this.pending !== pending || !server.address()) { server.close(); return this.status() }
    pending.redirectUri = `http://127.0.0.1:${server.address().port}/`
    this.expiryTimer = setTimeout(() => { if (this.pending === pending && generation === this.generation) { this.pending = null; this.authError(intakeError('GOOGLE_AUTH_EXPIRED')); server.close() } }, this.authorizationTtlMs); this.expiryTimer.unref?.()
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    url.search = new URLSearchParams({ client_id: client.client_id, redirect_uri: pending.redirectUri, response_type: 'code', scope: GOOGLE_SCOPES.join(' '), access_type: 'offline', prompt: 'consent', login_hint: this.expectedAccount, state: pending.state, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(pending.verifier).digest('base64url') })
    try { await this.openBrowser(url.href) } catch (error) { server.close(); if (generation === this.generation) { this.pending = null; clearTimeout(this.expiryTimer); this.authError(error) } }
    return this.status()
  }
  async disconnect() {
    this.closing = true
    try { await this.close(); if (this.expectedAccount && !this.configError) await this.keychain.delete(); this.state = 'disconnected'; this.error = null }
    finally { this.closing = false }
  }
  async close() {
    this.closing = true; this.generation++; this.pending = null; this.token = null; this.account = null
    const restoration = this.restoration
    restoration?.controller.abort()
    clearTimeout(this.expiryTimer); this.server?.close(); this.server?.closeAllConnections(); this.state = 'disconnected'
    await Promise.allSettled([this.callbackWork, restoration?.promise])
  }
}
