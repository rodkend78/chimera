import { inspectDocument } from './document.js'

const id = () => crypto.randomUUID()
const safeId = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v)
const digest = async url => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url))), x => x.toString(16).padStart(2, '0')).join('')
const bindings = ['leaseId', 'profileId', 'generation', 'tabId', 'documentId', 'origin', 'urlDigest', 'revision', 'taskId', 'agentId', 'expiresAt']

// Pre-injection copy of the fixed document URL guard; document.js repeats this
// inside the isolated world because scripts are serialized without imports.
function safeSelectedUrl(value) {
  try {
    const url = new URL(value); const host = url.hostname.toLowerCase()
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && host.includes('.') && !host.endsWith('.') && !/[:\[\]]/.test(host) && !/^[\d.]+$/.test(host) && !/(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/.test(host)
      && !/(^|\.)(accounts\.google\.com|login\.microsoftonline\.com|login\.live\.com|appleid\.apple\.com|auth0\.com|okta\.com)$/.test(host)
      && !/(?:^|\/)(?:login|log-in|signin|sign-in|signup|sign-up|auth|oauth|oauth2|sso|recover\w*|reset\w*|consent|authorize|verify|mfa|payment|checkout)(?:\/|$|[._-])/i.test(decodeURIComponent(url.pathname))
  } catch { return false }
}

export async function installationProfileId(dbFactory = indexedDB) {
  const db = await new Promise((resolve, reject) => {
    const request = dbFactory.open('chimera-companion', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('installation')
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
  })
  try { return await new Promise((resolve, reject) => {
    const tx = db.transaction('installation', 'readwrite'); const store = tx.objectStore('installation'); let value
    const request = store.get('profileId')
    request.onsuccess = () => { value = safeId(request.result) ? request.result : id(); if (value !== request.result) store.put(value, 'profileId') }
    tx.oncomplete = () => resolve(value); tx.onerror = tx.onabort = () => reject(new Error('Profile storage unavailable'))
  }) } finally { db.close() }
}

export function createCoordinator({ chrome, profileId = installationProfileId, now = Date.now }) {
  let port = null; let epoch = 0; let pairing = null; let paired = null; let busy = false; let retainedReads = 0
  const leases = new Map(); const pending = new Map(); const reading = new Set(); const seenReads = new Set(); const versions = new Map(); const revoked = new Set()
  function prune() {
    for (const [leaseId, lease] of leases) if (lease.expiresAt <= now()) leases.delete(leaseId)
    if (!busy) for (const tabId of versions.keys()) if (![...leases.values()].some(l => l.tabId === tabId)) versions.delete(tabId)
  }
  const state = () => { prune(); return { status: paired ? 'Paired' : port ? 'Pairing' : 'Disconnected', pairing, leases: [...leases.values()].filter(l => l.ready).map(({ ready, ...lease }) => lease) } }
  function disconnect() {
    epoch++; const old = port; port = null; paired = null; pairing = null; leases.clear(); seenReads.clear(); versions.clear(); revoked.clear()
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('disconnected')) } pending.clear()
    old?.disconnect()
  }
  function request(type, fields = {}) {
    if (!port || pending.size >= 32) return Promise.reject(new Error('disconnected'))
    const requestId = id()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('disconnected')); disconnect() }, 10000)
      pending.set(requestId, { resolve, reject, timer }); port.postMessage({ type, id: requestId, ...fields })
    })
  }
  function invalidate(tabId, reason) {
    if (versions.has(tabId)) versions.set(tabId, versions.get(tabId) + 1)
    for (const [leaseId, lease] of leases) if (lease.tabId === tabId) {
      leases.delete(leaseId); if (port) request('invalidate', { leaseId, reason }).catch(() => {})
    }
  }
  chrome.tabs.onUpdated.addListener((tabId, change) => { if (change.url !== undefined || change.status === 'loading') invalidate(tabId, 'navigation') })
  chrome.tabs.onRemoved.addListener(tabId => invalidate(tabId, 'closed'))
  chrome.tabs.onReplaced.addListener((_added, removed) => invalidate(removed, 'replaced'))
  async function inspect(tabId, documentId, mode, expectedUrl, expiresAt) {
    const results = await chrome.scripting.executeScript({ target: documentId ? { tabId, documentIds: [documentId] } : { tabId, frameIds: [0] }, func: inspectDocument, args: expectedUrl ? [mode, expectedUrl, expiresAt] : [mode] })
    if (results.length !== 1 || results[0].frameId !== 0 || !safeId(results[0].documentId) || (documentId && results[0].documentId !== documentId)) throw new Error('stale')
    const result = results[0].result
    if (!result || result.error) { if (result?.error === 'authentication') invalidate(tabId, 'authentication'); throw new Error(result?.error || 'extraction-failed') }
    return { ...result, documentId: results[0].documentId, urlDigest: await digest(result.url) }
  }
  async function handleRead(command) {
    const lease = leases.get(command?.leaseId); const start = epoch
    const fence = () => { if (!port || !paired || epoch !== start || !lease || leases.get(lease.leaseId) !== lease || lease.expiresAt <= now() || bindings.some(k => command[k] !== lease[k])) throw new Error('stale') }
    fence()
    if (command.type !== 'read' || !safeId(command.id) || Object.keys(command).some(k => !['type', 'id', ...bindings].includes(k)) || retainedReads >= 128 || reading.has(lease.leaseId) || seenReads.has(command.id) || seenReads.size >= 4096) throw new Error('stale')
    seenReads.add(command.id); reading.add(lease.leaseId); retainedReads++
    try {
      const preflight = await inspect(lease.tabId, lease.documentId, 'inspect'); fence()
      if (preflight.origin !== lease.origin || preflight.urlDigest !== lease.urlDigest) { invalidate(lease.tabId, 'navigation'); throw new Error('stale') }
      const result = await inspect(lease.tabId, lease.documentId, 'read', preflight.url, lease.expiresAt); fence()
      if (result.origin !== lease.origin || result.urlDigest !== lease.urlDigest) { invalidate(lease.tabId, 'navigation'); throw new Error('stale') }
      if (typeof result.text !== 'string' || new TextEncoder().encode(result.text).length > 32768) throw new Error('extraction-failed')
      return { type: 'read-result', id: command.id, leaseId: lease.leaseId, revision: lease.revision, documentId: lease.documentId, origin: lease.origin, urlDigest: lease.urlDigest, text: result.text }
    } finally { reading.delete(lease.leaseId); retainedReads-- }
  }
  function receive(message, source) {
    if (source !== port) return
    if (!message || new TextEncoder().encode(JSON.stringify(message)).length > 262144) return disconnect()
    if (message.type === 'revoke') {
      if (!safeId(message.leaseId) || !Number.isSafeInteger(message.revision) || message.revision < 1 || revoked.size >= 4096) return disconnect()
      revoked.add(message.leaseId); leases.delete(message.leaseId); return
    }
    if (message.type === 'read') {
      const start = epoch
      handleRead(message).then(result => { if (source === port && start === epoch && leases.get(message.leaseId)?.revision === result.revision && leases.get(message.leaseId).expiresAt > now()) source.postMessage(result) }).catch(error => {
        if (source === port && start === epoch && safeId(message.id) && safeId(message.leaseId)) source.postMessage({ type: 'read-error', id: message.id, leaseId: message.leaseId, error: ['stale', 'expired', 'authentication', 'human-action-required', 'disconnected'].includes(error.message) ? error.message : 'extraction-failed' })
      }); return
    }
    const p = pending.get(message.id); if (!p) return disconnect()
    pending.delete(message.id); clearTimeout(p.timer)
    if (message.type === 'error') p.reject(new Error('Request refused')); else p.resolve(message)
  }
  async function handlePopup(message, sender) {
    if (sender?.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html') || sender.tab || !message || typeof message.type !== 'string') throw new Error('Popup required')
    const shape = { state: [], pair: [], 'finish-pairing': [], targets: [], share: ['acknowledged', 'taskId', 'agentId'], stop: ['leaseId'], disconnect: [] }[message.type]
    if (!shape || Object.keys(message).some(key => !['type', ...shape].includes(key))) throw new Error('Invalid popup request')
    prune()
    if (message.type === 'state') return state()
    if (message.type === 'stop') { const l = leases.get(message.leaseId); if (l) invalidate(l.tabId, 'human'); return state() }
    if (message.type === 'disconnect') { disconnect(); return state() }
    if (busy) throw new Error('Request in progress')
    busy = true
    try {
      if (message.type === 'pair') {
        disconnect(); const start = epoch; const profile = await profileId(); if (epoch !== start) throw new Error('disconnected')
        port = chrome.runtime.connectNative('com.teamrsi.chimera_account'); const source = port
        port.onDisconnect.addListener(() => { if (source === port) disconnect() }); port.onMessage.addListener(m => receive(m, source))
        const result = await request('hello', { profileId: profile })
        if (result.type !== 'challenge' || !safeId(result.pairingId) || !safeId(result.challenge) || !Number.isFinite(result.expiresAt) || result.expiresAt <= now()) throw new Error('Invalid pairing')
        pairing = { pairingId: result.pairingId, challenge: result.challenge, expiresAt: result.expiresAt, profileId: profile }
      } else if (message.type === 'finish-pairing') {
        if (!pairing || pairing.expiresAt <= now()) throw new Error('Pairing expired')
        const result = await request('authenticate', { pairingId: pairing.pairingId, challenge: pairing.challenge })
        if (result.type !== 'paired' || result.profileId !== pairing?.profileId || !safeId(result.profileId) || !safeId(result.generation)) throw new Error('Invalid pairing')
        paired = { profileId: result.profileId, generation: result.generation }; pairing = null
      } else if (message.type === 'targets') {
        if (!paired) throw new Error('Pair first')
        const result = await request('targets')
        if (result.type !== 'targets' || !Array.isArray(result.targets) || result.targets.length > 128 || result.targets.some(t => !safeId(t.taskId) || !safeId(t.agentId))) throw new Error('Invalid targets')
        return { targets: result.targets }
      } else if (message.type === 'share') {
        if (!paired || message.acknowledged !== true || !safeId(message.taskId) || !safeId(message.agentId) || leases.size >= 128) throw new Error('Explicit consent required')
        const start = epoch; const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
        if (start !== epoch || !paired || !Number.isSafeInteger(tab?.id) || tab.id < 0 || !safeSelectedUrl(tab.url)) throw new Error('stale')
        versions.set(tab.id, (versions.get(tab.id) || 0) + 1); const version = versions.get(tab.id)
        const fence = () => { if (start !== epoch || !paired || versions.get(tab.id) !== version) throw new Error('stale') }
        const doc = await inspect(tab.id, null, 'inspect'); fence()
        const fields = { tabId: tab.id, documentId: doc.documentId, origin: doc.origin, urlDigest: doc.urlDigest, taskId: message.taskId, agentId: message.agentId, ttlSeconds: 300 }
        const result = await request('share', fields); const lease = result.lease
        try {
          fence()
          if (result.type !== 'shared' || !lease || revoked.has(lease.leaseId) || !safeId(lease.leaseId) || !Number.isSafeInteger(lease.revision) || lease.revision < 1 || !Number.isFinite(lease.expiresAt) || lease.expiresAt <= now() || lease.expiresAt > now() + 900000 || lease.profileId !== paired.profileId || lease.generation !== paired.generation || Object.keys(fields).filter(k => k !== 'ttlSeconds').some(k => lease[k] !== fields[k])) throw new Error('Invalid lease')
          const current = await inspect(tab.id, doc.documentId, 'inspect'); fence()
          if (current.origin !== doc.origin || current.urlDigest !== doc.urlDigest || revoked.has(lease.leaseId) || lease.expiresAt <= now()) throw new Error('stale')
          const cached = { ...Object.fromEntries(bindings.map(k => [k, lease[k]])), ready: false }
          leases.set(lease.leaseId, cached)
          // Cache is inspected and usable before the broker can release a waiting
          // worker. The popup stays pending until its ready commit is confirmed.
          const acknowledgement = await request('ready', Object.fromEntries(['leaseId', 'revision', 'documentId', 'origin', 'urlDigest'].map(k => [k, cached[k]])))
          fence()
          if (acknowledgement.type !== 'ready' || acknowledgement.leaseId !== lease.leaseId || acknowledgement.revision !== lease.revision || leases.get(lease.leaseId) !== cached || revoked.has(lease.leaseId) || lease.expiresAt <= now()) throw new Error('stale')
          cached.ready = true
        } catch (error) { leases.delete(lease?.leaseId); if (safeId(lease?.leaseId) && port) request('invalidate', { leaseId: lease.leaseId, reason: 'navigation' }).catch(() => {}); throw error }
      } else throw new Error('Unknown popup request')
      return state()
    } finally { busy = false; prune() }
  }
  return { state, handlePopup, handleRead }
}

if (globalThis.chrome?.runtime?.onMessage) {
  const coordinator = createCoordinator({ chrome: globalThis.chrome })
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    coordinator.handlePopup(message, sender).then(respond, () => respond({ error: 'Request refused. Check pairing, selected page and consent.' })); return true
  })
}
