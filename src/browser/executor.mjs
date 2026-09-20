import { EventEmitter } from 'node:events'
import net from 'node:net'
import { createPublicEgressProxy, isPublicAddress } from './public-egress-proxy.mjs'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { developmentsPageHtml, researchPageHtml } from './demo-page.mjs'
import {
  isSensitiveBrowserUrl,
  redactSensitiveBrowserUrl,
  TemporaryCallbackPolicy,
} from './auth-navigation.mjs'

const DEFAULT_BROWSER_STREAM_PROFILE = Object.freeze({
  viewport: Object.freeze({ width: 1600, height: 900 }),
  quality: 85,
})
const BROWSER_STREAM_LIMITS = Object.freeze({
  width: Object.freeze({ min: 1280, max: 1920 }),
  height: Object.freeze({ min: 720, max: 1080 }),
  quality: Object.freeze({ min: 60, max: 92 }),
})
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])
const PRIVATE_HOSTS = new Set(['localhost', '0.0.0.0', '127.0.0.1', '::1', '169.254.169.254'])
const ASSET_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../app/public/research-mountain.svg')

function boundedInteger(value, bounds, fallback) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return fallback
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= bounds.min && parsed <= bounds.max ? parsed : fallback
}

export function browserStreamProfile(env = process.env) {
  const source = env && typeof env === 'object' ? env : {}
  return {
    viewport: {
      width: boundedInteger(source.CHIMERA_BROWSER_VIEWPORT_WIDTH, BROWSER_STREAM_LIMITS.width, DEFAULT_BROWSER_STREAM_PROFILE.viewport.width),
      height: boundedInteger(source.CHIMERA_BROWSER_VIEWPORT_HEIGHT, BROWSER_STREAM_LIMITS.height, DEFAULT_BROWSER_STREAM_PROFILE.viewport.height),
    },
    quality: boundedInteger(source.CHIMERA_BROWSER_STREAM_QUALITY, BROWSER_STREAM_LIMITS.quality, DEFAULT_BROWSER_STREAM_PROFILE.quality),
  }
}

export function createLatestFrameSender(socket, {
  maximumBufferedBytes = 512_000,
  minimumFrameIntervalMs = 0,
  now = () => Date.now(),
  schedule = (callback, delay) => setTimeout(callback, delay),
  cancelSchedule = (handle) => clearTimeout(handle),
} = {}) {
  if (!socket || typeof socket.send !== 'function'
    || !Number.isSafeInteger(maximumBufferedBytes) || maximumBufferedBytes < 0
    || !Number.isSafeInteger(minimumFrameIntervalMs) || minimumFrameIntervalMs < 0
    || typeof now !== 'function' || typeof schedule !== 'function' || typeof cancelSchedule !== 'function') {
    throw new TypeError('browser frame sender configuration is invalid')
  }
  let closed = false
  let inFlight = false
  let pending = null
  let timer = null
  let lastSentAt = Number.NEGATIVE_INFINITY

  const pump = () => {
    if (closed || inFlight || timer !== null || !pending) return false
    if (socket.readyState !== 1 || socket.bufferedAmount > maximumBufferedBytes) {
      pending = null
      return false
    }
    const delay = Math.max(0, minimumFrameIntervalMs - (now() - lastSentAt))
    if (delay > 0) {
      timer = schedule(() => {
        timer = null
        pump()
      }, delay)
      return false
    }
    const frame = pending
    pending = null
    inFlight = true
    lastSentAt = now()
    try {
      socket.send(JSON.stringify(frame), (error) => {
        inFlight = false
        if (error) {
          closed = true
          pending = null
          return
        }
        pump()
      })
      return true
    } catch {
      closed = true
      inFlight = false
      pending = null
      return false
    }
  }

  return {
    push(frame) {
      if (closed || socket.readyState !== 1 || socket.bufferedAmount > maximumBufferedBytes) {
        pending = null
        return false
      }
      pending = frame
      return pump()
    },
    close() {
      closed = true
      pending = null
      if (timer !== null) cancelSchedule(timer)
      timer = null
    },
  }
}

const STREAM_PROFILE = browserStreamProfile()
const VIEWPORT = Object.freeze(STREAM_PROFILE.viewport)

function isPrivateIpv4(hostname) {
  const parts = hostname.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
}

function isPrivateIpv6(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return host === '::1'
    || host === '::'
    || host.startsWith('fc')
    || host.startsWith('fd')
    || /^fe[89ab]/.test(host)
}

export function assertSafeBrowserUrl(value) {
  if (value === 'about:blank') return value
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new TypeError('Browser URL is invalid')
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) throw new TypeError('Browser URL protocol is blocked')
  if (parsed.username || parsed.password) throw new TypeError('Credentials in browser URLs are blocked')
  const host = parsed.hostname.toLowerCase()
  if (host === 'chimera.local') return parsed.href
  if (PRIVATE_HOSTS.has(host) || isPrivateIpv4(host) || isPrivateIpv6(host) || host.endsWith('.local')) {
    throw new TypeError('Private-network browser destinations are blocked')
  }
  const address = host.replace(/^\[|\]$/g, '')
  if (net.isIP(address) && !isPublicAddress(address)) throw new TypeError('Private-network browser destinations are blocked')
  return parsed.href
}

const heldInput = new WeakMap()
export const BROWSER_FILE_LIMITS = Object.freeze({ uploadBytes: 8 * 1024 * 1024, uploadCount: 8, downloadBytes: 25 * 1024 * 1024, downloadCount: 5 })

export function decodeBrowserUpload(files) {
  if (!Array.isArray(files) || files.length < 1 || files.length > BROWSER_FILE_LIMITS.uploadCount) throw new TypeError('INVALID_BROWSER_UPLOAD')
  let total = 0
  return files.map((file) => {
    if (!file || typeof file.name !== 'string' || file.name.length < 1 || file.name.length > 255 || /[\\/\x00-\x1f]/.test(file.name)
      || typeof file.mimeType !== 'string' || file.mimeType.length > 128 || /[\r\n]/.test(file.mimeType)
      || typeof file.base64 !== 'string' || file.base64.length > Math.ceil(BROWSER_FILE_LIMITS.uploadBytes / 3) * 4
      || file.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.base64)) {
      throw new TypeError('INVALID_BROWSER_UPLOAD')
    }
    const buffer = Buffer.from(file.base64, 'base64')
    if (buffer.toString('base64') !== file.base64) throw new TypeError('INVALID_BROWSER_UPLOAD')
    total += buffer.length
    if (total > BROWSER_FILE_LIMITS.uploadBytes) throw new TypeError('BROWSER_UPLOAD_TOO_LARGE')
    return { name: file.name, mimeType: file.mimeType || 'application/octet-stream', buffer }
  })
}

export function validateHumanInput(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) throw new TypeError('INVALID_BROWSER_INPUT')
  const coordinate = (value) => Number.isFinite(value) && value >= 0 && value <= 16_384
  const positioned = () => coordinate(message.x) && coordinate(message.y)
  const button = () => message.button === undefined || ['left', 'middle', 'right'].includes(message.button)
  let valid = false
  if (message.type === 'reset') valid = true
  if (message.type === 'click') valid = positioned() && button() && (message.clickCount === undefined || Number.isInteger(message.clickCount) && message.clickCount >= 1 && message.clickCount <= 3)
  if (message.type === 'mouse') valid = positioned() && button() && ['pressed', 'released', 'moved'].includes(message.event)
  if (message.type === 'wheel') valid = (message.x === undefined && message.y === undefined || positioned())
    && Number.isFinite(message.deltaX) && Number.isFinite(message.deltaY)
    && Math.abs(message.deltaX) <= 100_000 && Math.abs(message.deltaY) <= 100_000
  if (message.type === 'text') valid = typeof message.text === 'string' && message.text.length <= 65_536
  if (message.type === 'key') valid = ['down', 'up'].includes(message.event) && typeof message.key === 'string' && message.key.length >= 1 && message.key.length <= 64
  if (!valid) throw new TypeError('INVALID_BROWSER_INPUT')
  return message
}

export async function releaseHumanInput(page) {
  const held = heldInput.get(page)
  if (!held) return
  heldInput.delete(page)
  // Releasing buttons before modifiers preserves the drag's modifier semantics.
  for (const button of held.buttons) await page.mouse.up({ button }).catch(() => undefined)
  for (const key of [...held.keys].reverse()) await page.keyboard.up(key).catch(() => undefined)
}

export async function dispatchHumanInput(page, message) {
  validateHumanInput(message)
  let held = heldInput.get(page)
  if (!held) { held = { keys: new Set(), buttons: new Set() }; heldInput.set(page, held) }
  if (message.type === 'reset') return releaseHumanInput(page)
  if (message.type === 'click') {
    await page.mouse.click(message.x, message.y, { button: message.button ?? 'left', ...(message.clickCount ? { clickCount: message.clickCount } : {}) })
    return
  }
  if (message.type === 'mouse') {
    await page.mouse.move(message.x, message.y)
    const button = message.button ?? 'left'
    if (message.event === 'pressed') {
      held.buttons.add(button)
      await page.mouse.down({ button })
    } else if (message.event === 'released') {
      await page.mouse.up({ button })
      held.buttons.delete(button)
    }
    return
  }
  if (message.type === 'wheel') {
    if (message.x !== undefined) await page.mouse.move(message.x, message.y)
    await page.mouse.wheel(message.deltaX, message.deltaY)
    return
  }
  if (message.type === 'text') {
    await page.keyboard.insertText(String(message.text ?? ''))
    return
  }
  if (message.type === 'key') {
    if (message.event === 'down') {
      held.keys.add(message.key)
      await page.keyboard.down(message.key)
    } else {
      await page.keyboard.up(message.key)
      held.keys.delete(message.key)
    }
    return
  }
  throw new TypeError('Unsupported human browser input')
}

function tabTitle(page) {
  return page.title().catch(() => 'Untitled')
}

export class ChromiumBrowserExecutor extends EventEmitter {
  #context
  #activePage
  #ids = new Map()
  #counter = 0
  #snapshotId = 0
  #starting
  #temporaryCallbacks
  #fileChooser
  #downloads = new Map()
  #egress

  constructor({
    profileDir,
    headless = process.env.CHIMERA_HEADLESS === 'false' ? false : (process.env.CHIMERA_HEADED === 'true' ? false : true),
    launchArgs = [],
    egressLookup,
  } = {}) {
    super()
    if (!profileDir) throw new TypeError('profileDir is required')
    if (!Array.isArray(launchArgs) || launchArgs.some((argument) => typeof argument !== 'string')) {
      throw new TypeError('launchArgs must be an array of strings')
    }
    // Chromium's user arguments override Playwright's proxy flags. Only these
    // presentation flags are supported; do not permit network/sandbox overrides.
    if (launchArgs.some(argument => !/^--(?:disable-dev-shm-usage|start-maximized|window-size=\d{1,5},\d{1,5})$/.test(argument))) {
      throw new TypeError('BROWSER_LAUNCH_ARGUMENT_BLOCKED')
    }
    this.profileDir = profileDir
    this.sessionFile = join(profileDir, 'chimera-tabs.json')
    this.headless = headless
    this.launchArgs = [...launchArgs]
    this.egressLookup = egressLookup
    this.#temporaryCallbacks = new TemporaryCallbackPolicy()
  }

  get running() {
    return Boolean(this.#context)
  }

  async start() {
    if (this.#context) return this.#stateNow()
    if (this.#starting) return this.#starting
    this.#starting = this.#start()
    try {
      return await this.#starting
    } catch (error) {
      await this.#context?.close().catch(() => {})
      this.#context = undefined
      this.#activePage = undefined
      this.#ids.clear()
      await this.#egress?.close().catch(() => {})
      this.#egress = undefined
      throw error
    } finally {
      this.#starting = undefined
    }
  }

  async #start() {
    await mkdir(this.profileDir, { recursive: true })
    for (const lockFile of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      try {
        await rm(join(this.profileDir, lockFile), { force: true })
      } catch {}
    }
    this.#egress = await createPublicEgressProxy({ lookup: this.egressLookup,
      allowsCallback: url => this.#temporaryCallbacks.allows(url) })
    try {
      this.#context = await chromium.launchPersistentContext(this.profileDir, {
      headless: this.headless,
      viewport: VIEWPORT,
      serviceWorkers: 'block',
      proxy: this.#egress.settings,
      args: ['--disable-dev-shm-usage', '--password-store=basic', ...this.launchArgs,
        '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
      })
    } catch (error) {
      await this.#egress.close(); this.#egress = undefined
      throw error
    }
    await this.#context.route('**/*', async (route) => {
      try {
        this.#assertAllowedNavigation(route.request().url())
        return route.fallback()
      } catch {
        return route.abort('blockedbyclient')
      }
    })
    await this.#context.route('http://chimera.local/**', async (route) => {
      const requestUrl = new URL(route.request().url())
      if (requestUrl.pathname === '/assets/research-mountain.svg') {
        return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: await readFile(ASSET_PATH) })
      }
      if (requestUrl.pathname === '/developments') {
        return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: developmentsPageHtml() })
      }
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: researchPageHtml() })
    })

    const initialPages = this.#context.pages()
    const primary = initialPages[0] ?? await this.#context.newPage()
    this.#register(primary)
    for (const page of initialPages.slice(1)) this.#register(page)

    const saved = await this.#loadSession()
    const destinations = saved?.tabs?.length
      ? saved.tabs.map((tab) => tab.url)
      : ['http://chimera.local/research', 'http://chimera.local/developments']

    const pages = [...this.#ids.keys()]
    for (let index = 0; index < destinations.length; index += 1) {
      const page = pages[index] ?? await this.#context.newPage()
      this.#register(page)
      try {
        await page.goto(this.#assertAllowedNavigation(destinations[index]), { waitUntil: 'domcontentloaded', timeout: 6000 })
      } catch {}
    }
    for (const page of [...this.#ids.keys()].slice(destinations.length)) await page.close()

    const activeIndex = Math.max(0, Math.min(saved?.activeIndex ?? 0, destinations.length - 1))
    this.#activePage = [...this.#ids.keys()][activeIndex] ?? primary
    this.#context.on('page', (page) => this.#register(page))
    this.emit('active-page-changed', this.#id(this.#activePage))
    return this.#stateNow()
  }

  #register(page) {
    if (this.#ids.has(page)) return page
    this.#ids.set(page, `tab-${++this.#counter}`)
    page.on('filechooser', (chooser) => {
      this.#fileChooser = { page, chooser }
      this.emit('browser-files-changed')
    })
    page.on('download', (download) => { void this.#captureDownload(download) })
    page.on('close', () => {
      const wasActive = page === this.#activePage
      if (this.#fileChooser?.page === page) this.#fileChooser = undefined
      this.#ids.delete(page)
      if (wasActive) {
        this.#activePage = [...this.#ids.keys()][0]
        this.emit('active-page-changed', this.#activePage ? this.#id(this.#activePage) : null)
      }
    })
    return page
  }

  #id(page) {
    return this.#ids.get(page)
  }

  #page(tabId) {
    const match = [...this.#ids.entries()].find(([, id]) => id === tabId)?.[0]
    if (!match) throw new Error('TAB_NOT_FOUND')
    return match
  }

  async #active() {
    await this.start()
    if (!this.#activePage || this.#activePage.isClosed()) this.#activePage = [...this.#ids.keys()][0]
    if (!this.#activePage) this.#activePage = this.#register(await this.#context.newPage())
    return this.#activePage
  }

  async listTabs() {
    if (!this.#context) await this.start()
    return this.#listTabsNow()
  }

  async #listTabsNow() {
    return Promise.all([...this.#ids.entries()].map(async ([page, tabId]) => ({
      tabId,
      title: (await tabTitle(page)) || 'New tab',
      url: redactSensitiveBrowserUrl(page.url()),
      active: page === this.#activePage,
    })))
  }

  allowTemporaryNavigation(url) {
    return this.#temporaryCallbacks.allow(url)
  }

  #assertAllowedNavigation(value) {
    try {
      return assertSafeBrowserUrl(value)
    } catch (error) {
      if (this.#temporaryCallbacks.allows(value)) return new URL(value).toString()
      throw error
    }
  }

  async state() {
    if (!this.#context) await this.start()
    return this.#stateNow()
  }

  async #stateNow() {
    return { running: this.running, viewport: VIEWPORT, tabs: await this.#listTabsNow(), files: this.browserFiles() }
  }

  async openTab(url = 'about:blank') {
    await this.start()
    await this.releaseHumanInput()
    const page = this.#register(await this.#context.newPage())
    await page.goto(this.#assertAllowedNavigation(url), { waitUntil: 'domcontentloaded' })
    this.#activePage = page
    this.#snapshotId += 1
    this.emit('active-page-changed', this.#id(page))
    return { tabId: this.#id(page), tabs: await this.listTabs() }
  }

  async activateTab(tabId) {
    const page = this.#page(tabId)
    await this.releaseHumanInput()
    this.#activePage = page
    await page.bringToFront()
    this.emit('active-page-changed', tabId)
    return { tabId, tabs: await this.listTabs() }
  }

  async closeTab(tabId) {
    await this.start()
    const page = this.#page(tabId)
    if (this.#ids.size === 1) {
      await page.goto('about:blank')
      return { tabId, tabs: await this.listTabs() }
    }
    await page.close()
    if (!this.#activePage) this.#activePage = [...this.#ids.keys()][0]
    this.emit('active-page-changed', this.#activePage ? this.#id(this.#activePage) : null)
    return { tabId, tabs: await this.listTabs() }
  }

  async navigate(url, tabId) {
    const page = tabId ? this.#page(tabId) : await this.#active()
    const destination = this.#assertAllowedNavigation(url)
    await page.goto(destination, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    this.#snapshotId += 1
    return { tabId: this.#id(page), url: page.url(), title: await tabTitle(page) }
  }

  async goBack() {
    const page = await this.#active()
    await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => null)
    this.#snapshotId += 1
    return { url: page.url(), title: await tabTitle(page) }
  }

  async goForward() {
    const page = await this.#active()
    await page.goForward({ waitUntil: 'domcontentloaded' }).catch(() => null)
    this.#snapshotId += 1
    return { url: page.url(), title: await tabTitle(page) }
  }

  async reload() {
    const page = await this.#active()
    await page.reload({ waitUntil: 'domcontentloaded' })
    this.#snapshotId += 1
    return { url: page.url(), title: await tabTitle(page) }
  }

  async read() {
    const page = await this.#active()
    const text = await page.locator('body').innerText()
    return { url: page.url(), title: await tabTitle(page), text: text.slice(0, 8_000), truncated: text.length > 8_000 }
  }

  async snapshot() {
    const page = await this.#active()
    this.#snapshotId += 1
    const yaml = await page.ariaSnapshot({ mode: 'ai' })
    return { snapshotId: this.#snapshotId, url: page.url(), title: await tabTitle(page), yaml }
  }

  async click({ ref, snapshotId }) {
    if (!ref) throw new TypeError('Element ref is required')
    if (snapshotId !== undefined && snapshotId !== this.#snapshotId) throw new Error('STALE_SNAPSHOT')
    const page = await this.#active()
    await page.locator(`aria-ref=${ref}`).click({ timeout: 10_000 })
    return { action: 'click', ref, url: page.url() }
  }

  async type({ ref, text, snapshotId, submit = false }) {
    if (!ref || typeof text !== 'string') throw new TypeError('Element ref and text are required')
    if (snapshotId !== undefined && snapshotId !== this.#snapshotId) throw new Error('STALE_SNAPSHOT')
    const page = await this.#active()
    const field = page.locator(`aria-ref=${ref}`)
    await field.fill(text, { timeout: 10_000 })
    if (submit) await field.press('Enter')
    return { action: 'type', ref, characters: text.length, submitted: submit, url: page.url() }
  }

  async key(key) {
    if (!key) throw new TypeError('Key is required')
    const page = await this.#active()
    await page.keyboard.press(key)
    return { action: 'key', key, url: page.url() }
  }

  async scroll(deltaY = 600) {
    const page = await this.#active()
    await page.mouse.wheel(0, Number(deltaY) || 600)
    return { action: 'scroll', deltaY, url: page.url() }
  }

  async humanInput(message) {
    const page = await this.#active()
    await dispatchHumanInput(page, message)
  }

  async releaseHumanInput() {
    if (this.#activePage && !this.#activePage.isClosed()) await releaseHumanInput(this.#activePage)
  }

  browserFiles() {
    const pending = Boolean(this.#fileChooser && this.#fileChooser.page === this.#activePage && !this.#fileChooser.page.isClosed())
    return {
      upload: { pending, multiple: pending ? this.#fileChooser.chooser.isMultiple() : false },
      downloads: [...this.#downloads.values()].map(({ id, name, status, bytes, reason }) => ({ id, name, status, ...(bytes !== undefined ? { bytes } : {}), ...(reason ? { reason } : {}) })),
    }
  }

  async uploadFiles(files) {
    const decoded = decodeBrowserUpload(files)
    const pending = this.#fileChooser
    if (!pending || pending.page !== this.#activePage || pending.page.isClosed()) throw new Error('BROWSER_FILE_CHOOSER_REQUIRED')
    if (!pending.chooser.isMultiple() && decoded.length > 1) throw new Error('BROWSER_FILE_CHOOSER_SINGLE_ONLY')
    await pending.chooser.setFiles(decoded, { timeout: 10_000 })
    if (this.#fileChooser === pending) this.#fileChooser = undefined
    this.emit('browser-files-changed')
    return { uploaded: true, count: decoded.length }
  }

  async #captureDownload(download) {
    const record = { id: randomUUID(), name: download.suggestedFilename().replace(/[\\/\x00-\x1f]/g, '_').slice(0, 255) || 'download', status: 'pending', download }
    while (this.#downloads.size >= BROWSER_FILE_LIMITS.downloadCount) {
      const oldest = this.#downloads.values().next().value
      this.#downloads.delete(oldest.id)
      await oldest.download.cancel().catch(() => undefined)
      await oldest.download.delete().catch(() => undefined)
    }
    this.#downloads.set(record.id, record)
    this.emit('browser-files-changed')
    try {
      const stream = await download.createReadStream()
      if (!stream) throw new Error('BROWSER_DOWNLOAD_FAILED')
      const chunks = []
      let bytes = 0
      for await (const chunk of stream) {
        bytes += chunk.length
        if (bytes > BROWSER_FILE_LIMITS.downloadBytes) {
          await download.cancel().catch(() => undefined)
          throw new Error('BROWSER_DOWNLOAD_TOO_LARGE')
        }
        chunks.push(chunk)
      }
      if (await download.failure()) throw new Error('BROWSER_DOWNLOAD_FAILED')
      if (!this.#downloads.has(record.id)) return
      record.buffer = Buffer.concat(chunks)
      record.bytes = bytes
      record.status = 'ready'
    } catch (error) {
      record.status = 'failed'
      record.reason = error.message === 'BROWSER_DOWNLOAD_TOO_LARGE' ? error.message : 'BROWSER_DOWNLOAD_FAILED'
    } finally {
      await download.delete().catch(() => undefined)
      this.emit('browser-files-changed')
    }
  }

  downloadFile(downloadId) {
    if (typeof downloadId !== 'string' || downloadId.length > 64) throw new TypeError('INVALID_BROWSER_DOWNLOAD')
    const record = this.#downloads.get(downloadId)
    if (!record) throw new Error('BROWSER_DOWNLOAD_NOT_FOUND')
    if (record.status !== 'ready') throw new Error('BROWSER_DOWNLOAD_NOT_READY')
    return { name: record.name, bytes: record.bytes, base64: record.buffer.toString('base64') }
  }

  async subscribeScreencast(onFrame) {
    await this.start()
    let stopped = false
    let current

    const attach = async () => {
      if (stopped) return
      await current?.stop()
      const page = await this.#active()
      const client = await page.context().newCDPSession(page)
      const listener = (event) => {
        void client.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => undefined)
        if (!stopped) onFrame({ type: 'frame', data: event.data, width: event.metadata.deviceWidth, height: event.metadata.deviceHeight, url: page.url() })
      }
      client.on('Page.screencastFrame', listener)
      await client.send('Page.startScreencast', { format: 'jpeg', quality: STREAM_PROFILE.quality, maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height, everyNthFrame: 1 })
      current = {
        async stop() {
          client.off('Page.screencastFrame', listener)
          await client.send('Page.stopScreencast').catch(() => undefined)
          await client.detach().catch(() => undefined)
        },
      }
    }

    const changed = () => void attach().catch(() => undefined)
    this.on('active-page-changed', changed)
    await attach()
    return async () => {
      stopped = true
      this.off('active-page-changed', changed)
      await current?.stop()
    }
  }

  async suspend() {
    if (!this.#context) return { suspended: true, wasRunning: false }
    const tabs = await this.listTabs()
    const activeIndex = Math.max(0, tabs.findIndex((tab) => tab.active))
    await writeFile(this.sessionFile, JSON.stringify({
      tabs: tabs.map(({ url }) => ({ url: isSensitiveBrowserUrl(url) ? 'about:blank' : url })),
      activeIndex,
    }, null, 2))
    const context = this.#context
    this.#context = undefined
    this.#fileChooser = undefined
    this.#downloads.clear()
    this.#activePage = undefined
    this.#ids.clear()
    try { await context.close() } finally {
      await this.#egress?.close()
      this.#egress = undefined
    }
    return { suspended: true, wasRunning: true }
  }

  async #loadSession() {
    try {
      return JSON.parse(await readFile(this.sessionFile, 'utf8'))
    } catch {
      return null
    }
  }
}
