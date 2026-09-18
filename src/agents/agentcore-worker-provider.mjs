import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import {
  BedrockAgentCoreClient,
  GetBrowserSessionCommand,
  GetCodeInterpreterSessionCommand,
  StopBrowserSessionCommand,
  StopCodeInterpreterSessionCommand,
} from '@aws-sdk/client-bedrock-agentcore'
import { PlaywrightBrowser } from 'bedrock-agentcore/browser/playwright'
import { CodeInterpreter } from 'bedrock-agentcore/code-interpreter'

export const AGENTCORE_BROWSER_ID = 'aws.browser.v1'
export const AGENTCORE_CODE_ID = 'aws.codeinterpreter.v1'

const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

function normalizeAllowedHosts(values) {
  if (values === undefined || values === null) return null
  if (!Array.isArray(values) || values.length > 32) throw new TypeError('WORKER_TASK_HOSTS_INVALID')
  const normalized = values.map((value) => {
    if (typeof value !== 'string') throw new TypeError('WORKER_TASK_HOSTS_INVALID')
    const host = value.trim().toLowerCase().replace(/\.$/, '')
    if (!HOST.test(host)) throw new TypeError('WORKER_TASK_HOSTS_INVALID')
    return host
  })
  return new Set(normalized)
}

function ipv4FromMappedIpv6(address) {
  const normalized = address.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (!normalized.startsWith('::ffff:')) return null
  const suffix = normalized.slice('::ffff:'.length)
  if (isIP(suffix) === 4) return suffix
  const parts = suffix.split(':')
  if (parts.length !== 2 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null
  const high = Number.parseInt(parts[0], 16)
  const low = Number.parseInt(parts[1], 16)
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
}

function blockedIp(value) {
  const address = value.replace(/^\[/, '').replace(/\]$/, '')
  const mapped = ipv4FromMappedIpv6(address)
  if (mapped) return blockedIp(mapped)
  if (isIP(address) === 4) {
    const parts = address.split('.').map(Number)
    return parts[0] === 10 || parts[0] === 127 || parts[0] === 0
      || (parts[0] === 169 && parts[1] === 254)
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168)
      || (parts[0] === 192 && parts[1] === 0)
      || (parts[0] === 198 && [18, 19].includes(parts[1]))
      || (parts[0] === 198 && parts[1] === 51 && parts[2] === 100)
      || (parts[0] === 203 && parts[1] === 0 && parts[2] === 113)
      || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
      || parts[0] >= 224
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase()
    return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') || normalized.startsWith('fd')
      || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')
      || normalized.startsWith('ff') || normalized.startsWith('fec') || normalized.startsWith('fed') || normalized.startsWith('fee') || normalized.startsWith('fef')
      || normalized.startsWith('100:') || normalized.startsWith('2001:db8:') || normalized.startsWith('3fff:')
      || normalized.startsWith('64:ff9b:1:')
  }
  return true
}

export async function assertPublicWorkerUrl(value, { resolveHost = (hostname) => lookup(hostname, { all: true, verbatim: true }) } = {}) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw Object.assign(new Error('WORKER_URL_INVALID'), { code: 'WORKER_URL_INVALID' })
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname
    || ['localhost', 'metadata.google.internal'].includes(url.hostname.toLowerCase())
    || url.hostname.toLowerCase().endsWith('.localhost')) {
    throw Object.assign(new Error('WORKER_URL_BLOCKED'), { code: 'WORKER_URL_BLOCKED' })
  }
  const hostname = url.hostname.replace(/^\[/, '').replace(/\]$/, '')
  const addresses = isIP(hostname) ? [{ address: hostname }] : await resolveHost(hostname)
  if (!addresses.length || addresses.some(({ address }) => blockedIp(address))) {
    throw Object.assign(new Error('WORKER_URL_BLOCKED'), { code: 'WORKER_URL_BLOCKED' })
  }
  return url
}

export function createPublicRequestGuard({ resolveHost = (hostname) => lookup(hostname, { all: true, verbatim: true }), allowedHosts } = {}) {
  const allowed = normalizeAllowedHosts(allowedHosts)
  return async (route) => {
    try {
      const url = await assertPublicWorkerUrl(route.request().url(), { resolveHost })
      if (allowed && !allowed.has(url.hostname.toLowerCase().replace(/\.$/, ''))) {
        throw Object.assign(new Error('WORKER_NETWORK_HOST_NOT_LEASED'), { code: 'WORKER_NETWORK_HOST_NOT_LEASED' })
      }
      await route.continue()
    } catch {
      await route.abort('blockedbyclient')
    }
  }
}

class PublicOnlyPlaywrightBrowser extends PlaywrightBrowser {
  #guardedContexts = new WeakSet()

  constructor(config, { resolveHost, allowedHosts } = {}) {
    super(config)
    this.requestGuard = createPublicRequestGuard({ resolveHost, allowedHosts })
  }

  async _connectPlaywright() {
    await super._connectPlaywright()
    const context = this._playwrightPage.context()
    if (!this.#guardedContexts.has(context)) {
      await context.route('**/*', this.requestGuard)
      this.#guardedContexts.add(context)
    }
  }
}

function boundedString(value, code, max = 20_000, { optional = false } = {}) {
  if (optional && value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new TypeError(code)
  return value
}

function sessionKey(record) {
  return `${record.kind}:${record.providerSessionId}`
}

export class AgentCoreWorkerProvider {
  #clients = new Map()

  constructor({
    region = process.env.CHIMERA_AWS_REGION ?? 'us-west-2',
    browserFactory,
    codeFactory,
    sdkClient,
    resolveHost,
  } = {}) {
    this.region = region
    this.resolveHost = resolveHost ?? ((hostname) => lookup(hostname, { all: true, verbatim: true }))
    this.browserFactory = browserFactory ?? (({ allowedHosts } = {}) => new PublicOnlyPlaywrightBrowser(
      { region, identifier: AGENTCORE_BROWSER_ID },
      { resolveHost: this.resolveHost, allowedHosts },
    ))
    this.codeFactory = codeFactory ?? (() => new CodeInterpreter({ region, identifier: AGENTCORE_CODE_ID }))
    this.sdkClient = sdkClient ?? new BedrockAgentCoreClient({ region })
  }

  async start({ kind, agentId, ttlSeconds, viewport, networkHosts }) {
    if (!['code', 'computer'].includes(kind)) throw new TypeError('WORKER_KIND_INVALID')
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 300 || ttlSeconds > 3600) throw new TypeError('WORKER_TTL_INVALID')
    const safeAgent = boundedString(agentId, 'WORKER_AGENT_ID_INVALID', 64)
    const allowedHosts = normalizeAllowedHosts(networkHosts)
    if (kind === 'computer') {
      const client = this.browserFactory({ allowedHosts: allowedHosts ? [...allowedHosts] : undefined })
      const session = await client.startSession({ sessionName: `chimera-${safeAgent}-computer`, timeout: ttlSeconds, viewport: viewport ?? { width: 1280, height: 800 } })
      this.#clients.set(`computer:${session.sessionId}`, client)
      return { providerSessionId: session.sessionId, providerResourceId: AGENTCORE_BROWSER_ID }
    }
    const client = this.codeFactory()
    const session = await client.startSession({ sessionName: `chimera-${safeAgent}-code`, description: `Chimera isolated code worker for ${safeAgent}`, timeout: ttlSeconds })
    this.#clients.set(`code:${session.sessionId}`, client)
    return { providerSessionId: session.sessionId, providerResourceId: AGENTCORE_CODE_ID }
  }

  #browser(record) {
    let client = this.#clients.get(sessionKey(record))
    if (!client) {
      client = this.browserFactory({ allowedHosts: record.networkHosts ?? undefined })
      client.attachSession(record.providerSessionId)
      this.#clients.set(sessionKey(record), client)
    }
    return client
  }

  #code(record) {
    const client = this.#clients.get(sessionKey(record))
    if (!client) throw Object.assign(new Error('WORKER_SESSION_REATTACH_REQUIRED'), { code: 'WORKER_SESSION_REATTACH_REQUIRED' })
    return client
  }

  async status(record) {
    if (record.kind === 'computer') {
      const client = this.#clients.get(sessionKey(record))
      if (client) return client.getSession({ sessionId: record.providerSessionId })
      return this.sdkClient.send(new GetBrowserSessionCommand({ browserIdentifier: record.providerResourceId, sessionId: record.providerSessionId }))
    }
    const client = this.#clients.get(sessionKey(record))
    if (client) return client.getSession({ sessionId: record.providerSessionId })
    return this.sdkClient.send(new GetCodeInterpreterSessionCommand({ codeInterpreterIdentifier: record.providerResourceId, sessionId: record.providerSessionId }))
  }

  async stop(record) {
    const key = sessionKey(record)
    const client = this.#clients.get(key)
    try {
      if (client) return await client.stopSession()
      if (record.kind === 'computer') {
        return await this.sdkClient.send(new StopBrowserSessionCommand({ browserIdentifier: record.providerResourceId, sessionId: record.providerSessionId }))
      }
      return await this.sdkClient.send(new StopCodeInterpreterSessionCommand({ codeInterpreterIdentifier: record.providerResourceId, sessionId: record.providerSessionId }))
    } finally {
      this.#clients.delete(key)
    }
  }

  async liveView(record, { expiresIn = 45 } = {}) {
    if (record.kind !== 'computer') throw new TypeError('WORKER_COMPUTER_REQUIRED')
    if (!Number.isInteger(expiresIn) || expiresIn < 15 || expiresIn > 60) throw new TypeError('WORKER_LIVE_VIEW_TTL_INVALID')
    return this.#browser(record).generateLiveViewUrl(expiresIn)
  }

  async setAutomation(record, enabled) {
    if (record.kind !== 'computer') throw new TypeError('WORKER_COMPUTER_REQUIRED')
    return this.#browser(record).updateBrowserStream({ streamStatus: enabled ? 'ENABLED' : 'DISABLED' })
  }

  async action(record, input = {}) {
    const operation = boundedString(input.operation, 'WORKER_OPERATION_INVALID', 64)
    if (record.kind === 'code') {
      const client = this.#code(record)
      if (operation === 'execute-code') {
        const code = boundedString(input.code, 'WORKER_CODE_INVALID', 100_000)
        if (input.language !== undefined && !['python', 'javascript', 'typescript'].includes(input.language)) throw new TypeError('WORKER_LANGUAGE_INVALID')
        return client.executeCode({ code, ...(input.language ? { language: input.language } : {}) })
      }
      if (operation === 'execute-command') return client.executeCommand({ command: boundedString(input.command, 'WORKER_COMMAND_INVALID') })
      if (operation === 'read-files') {
        if (!Array.isArray(input.paths) || input.paths.length < 1 || input.paths.length > 16 || input.paths.some((path) => typeof path !== 'string' || path.length > 1024)) throw new TypeError('WORKER_PATHS_INVALID')
        return client.readFiles({ paths: input.paths })
      }
      if (operation === 'list-files') return client.listFiles(input.path ? { path: boundedString(input.path, 'WORKER_PATH_INVALID', 1024) } : {})
      if (operation === 'write-files') {
        if (!Array.isArray(input.files) || input.files.length < 1 || input.files.length > 16) throw new TypeError('WORKER_FILES_INVALID')
        return client.writeFiles({ files: input.files.map((file) => ({ path: boundedString(file?.path, 'WORKER_PATH_INVALID', 1024), content: boundedString(file?.content, 'WORKER_FILE_CONTENT_INVALID', 1_000_000, { optional: true }) ?? '' })) })
      }
      throw new TypeError('WORKER_CODE_OPERATION_UNSUPPORTED')
    }
    const browser = this.#browser(record)
    if (operation === 'navigate') {
      const url = await assertPublicWorkerUrl(input.url, { resolveHost: this.resolveHost })
      await browser.navigate({ url: url.href, waitUntil: 'domcontentloaded', timeout: 30_000 })
      return { url: url.href }
    }
    if (operation === 'get-text') return browser.getText(input.selector ? { selector: boundedString(input.selector, 'WORKER_SELECTOR_INVALID', 2048) } : {})
    if (operation === 'click') return browser.click({ selector: boundedString(input.selector, 'WORKER_SELECTOR_INVALID', 2048), timeout: 15_000 })
    if (operation === 'type') return browser.type({ selector: boundedString(input.selector, 'WORKER_SELECTOR_INVALID', 2048), text: boundedString(input.text, 'WORKER_TEXT_INVALID', 20_000), timeout: 15_000 })
    if (operation === 'screenshot') return browser.screenshot({ type: 'png', encoding: 'binary', fullPage: input.fullPage === true })
    if (operation === 'back') return browser.back()
    if (operation === 'forward') return browser.forward()
    if (operation === 'refresh') return browser.refresh()
    throw new TypeError('WORKER_COMPUTER_OPERATION_UNSUPPORTED')
  }
}
