import { join, resolve, sep } from 'node:path'

export const ALLOWED_APP_ORIGINS = new Set([
  'http://127.0.0.1:4174',
  'http://localhost:4174',
  'http://127.0.0.1:5173',
  'http://localhost:5173',
])

export function isAllowedRequestOrigin(origin) {
  return !origin || ALLOWED_APP_ORIGINS.has(origin)
}

export function corsAllowOrigin(origin) {
  return origin && ALLOWED_APP_ORIGINS.has(origin) ? origin : 'http://127.0.0.1:5173'
}

export function assertLoopbackHost(host) {
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) {
    throw Object.assign(new Error('CHIMERA_HOST_MUST_BE_LOOPBACK'), { code: 'CHIMERA_HOST_MUST_BE_LOOPBACK' })
  }
  return host
}

export function resolveAppAsset(appDist, pathname) {
  const root = resolve(appDist)
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const candidate = resolve(root, requested)
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return join(root, 'index.html')
  return candidate
}
