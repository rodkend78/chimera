import http from 'node:http'
import net from 'node:net'
import { lookup as dnsLookup } from 'node:dns/promises'
import { randomBytes } from 'node:crypto'

export function isPublicAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b, c] = address.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168))
      || (a === 198 && (b === 18 || b === 19 || b === 51 && c === 100))
      || (a === 203 && b === 0 && c === 113))
  }
  if (!net.isIPv6(address)) return false
  // Only global unicast. Reject mapped, translation, tunneling and documentation
  // ranges rather than allowing an alternative encoding to smuggle private IPv4.
  const value = new URL(`http://[${address}]/`).hostname.slice(1, -1)
  const [first, second = '0'] = value.split(':').map(part => parseInt(part || '0', 16))
  return /^[23][0-9a-f]{0,3}:/.test(value)
    && first !== 0x2002
    && !(first === 0x2001 && (second < 0x200 || second === 0xdb8))
    && !(first === 0x3fff && second < 0x1000)
}

function destination(value) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('BROWSER_EGRESS_BLOCKED')
  return url
}

export async function resolvePublicDestination(value, { lookup = dnsLookup } = {}) {
  const url = destination(value)
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (hostname === 'localhost' || /\.(localhost|local|internal)\.?$/.test(hostname)) throw new Error('BROWSER_EGRESS_BLOCKED')
  let timer
  const rows = net.isIP(hostname) ? [{ address: hostname }] : await Promise.race([
    lookup(hostname, { all: true, verbatim: true }),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('BROWSER_EGRESS_TIMEOUT')), 5000) }),
  ]).finally(() => clearTimeout(timer))
  if (!Array.isArray(rows) || rows.length === 0 || rows.some(row => !isPublicAddress(row.address))) throw new Error('BROWSER_EGRESS_BLOCKED')
  // The numeric address, not the hostname, is passed to the actual socket open.
  return { url, address: rows[0].address, family: net.isIP(rows[0].address) }
}

export async function createPublicEgressProxy({ lookup = dnsLookup, allowsCallback = () => false } = {}) {
  const password = randomBytes(32).toString('hex')
  const authorization = `Basic ${Buffer.from(`chimera:${password}`).toString('base64')}`
  const sockets = new Set()
  let closed = false
  const track = socket => {
    sockets.add(socket)
    socket.setTimeout(120_000, () => socket.destroy())
    socket.on('error', () => socket.destroy())
    socket.once('close', () => sockets.delete(socket))
    return socket
  }
  const authorized = req => req.headers['proxy-authorization'] === authorization
  const deny = (socket, status = 403) => socket.end(`HTTP/1.1 ${status} Blocked\r\nConnection: close\r\nContent-Length: 0\r\n${status === 407 ? 'Proxy-Authenticate: Basic realm="Chimera"\r\n' : ''}\r\n`)
  const inspect = async (value, method) => {
    const url = destination(value)
    // Only the exact short-lived HTTP callback path is exempt. Never grant a
    // CONNECT tunnel or WebSocket to an entire loopback service.
    if (method === 'GET' && url.protocol === 'http:' && allowsCallback(url.href)) {
      return { url, address: '127.0.0.1', family: 4 }
    }
    return resolvePublicDestination(url.href, { lookup })
  }
  const headersFor = (req, url, upgrade) => {
    const headers = { ...req.headers, host: url.host }
    for (const key of ['proxy-authorization', 'proxy-connection', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade']) delete headers[key]
    for (const key of (req.headers.connection ?? '').split(',').map(x => x.trim().toLowerCase())) {
      if (key) delete headers[key]
    }
    headers.host = url.host
    if (upgrade) { headers.connection = 'Upgrade'; headers.upgrade = 'websocket' }
    return headers
  }
  const server = http.createServer(async (req, res) => {
    if (!authorized(req)) { res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="Chimera"' }); res.end(); return }
    let target
    try { target = await inspect(req.url, req.method) } catch { res.writeHead(403); res.end(); return }
    if (closed || res.destroyed) return
    if (target.url.protocol !== 'http:') { res.writeHead(403); res.end(); return }
    const upstream = http.request({ hostname: target.address, family: target.family, port: target.url.port || 80,
      path: target.url.pathname + target.url.search, method: req.method, headers: headersFor(req, target.url), agent: false }, response => {
      res.writeHead(response.statusCode, response.headers)
      response.pipe(res)
    })
    upstream.on('socket', track)
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
    res.on('close', () => upstream.destroy())
    req.pipe(upstream)
  })
  server.on('connection', socket => {
    if (sockets.size >= 256) { socket.destroy(); return }
    track(socket)
  })
  server.on('clientError', (_error, socket) => socket.destroy())
  server.on('connect', async (req, client, head) => {
    if (!authorized(req)) return deny(client, 407)
    let target
    try {
      if (!/^(\[[0-9a-fA-F:]+\]|[^:/?#@\s]+):[0-9]{1,5}$/.test(req.url)) throw new Error('invalid authority')
      target = await resolvePublicDestination(`https://${req.url}/`, { lookup })
    } catch { return deny(client) }
    if (closed || client.destroyed) return
    const upstream = track(net.connect({ host: target.address, family: target.family, port: Number(target.url.port || 443) }))
    upstream.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      client.pipe(upstream).pipe(client)
    })
    client.once('close', () => upstream.destroy())
    upstream.once('close', () => client.destroy())
  })
  server.on('upgrade', async (req, client, head) => {
    if (!authorized(req)) return deny(client, 407)
    let target
    try {
      target = await resolvePublicDestination(req.url.replace(/^ws:/, 'http:'), { lookup })
      if (target.url.protocol !== 'http:' || req.headers.upgrade?.toLowerCase() !== 'websocket') throw new Error('invalid upgrade')
    } catch { return deny(client) }
    if (closed || client.destroyed) return
    const upstream = http.request({ hostname: target.address, family: target.family, port: target.url.port || 80,
      path: target.url.pathname + target.url.search, headers: headersFor(req, target.url, true), agent: false })
    upstream.on('socket', track)
    upstream.once('upgrade', (response, socket, upstreamHead) => {
      client.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`)
      if (head.length) socket.write(head)
      if (upstreamHead.length) client.write(upstreamHead)
      client.pipe(socket).pipe(client)
      client.once('close', () => socket.destroy())
      socket.once('close', () => client.destroy())
    })
    upstream.on('response', response => { response.resume(); deny(client) })
    upstream.on('error', () => client.destroy())
    client.once('close', () => upstream.destroy())
    upstream.end()
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return {
    settings: { server: `http://127.0.0.1:${server.address().port}`, username: 'chimera', password, bypass: '<-loopback>' },
    async close() { closed = true; for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)) },
  }
}
