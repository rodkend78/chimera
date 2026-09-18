function header(headers, name) {
  if (!headers || typeof headers !== 'object') return undefined
  if (headers[name] !== undefined) return headers[name]
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name)
  return key ? headers[key] : undefined
}

export function authorizeOperatorRequest({ pathname, method, headers }, manager) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/api/')) return { allowed: true }
  const verb = String(method ?? 'GET').toUpperCase()
  if (verb === 'OPTIONS') return { allowed: true }
  if (pathname === '/api/operator/bootstrap' && verb === 'POST') return { allowed: true }
  if (!manager.authenticate(header(headers, 'cookie'))) {
    return { allowed: false, status: 401, error: 'OPERATOR_AUTH_REQUIRED' }
  }
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(verb)
    && !manager.verifyCsrf(header(headers, 'x-chimera-csrf'))) {
    return { allowed: false, status: 403, error: 'OPERATOR_CSRF_INVALID' }
  }
  return { allowed: true }
}

export function authorizeOperatorWebSocket({ headers }, manager) {
  if (!manager.authenticate(header(headers, 'cookie'))) {
    return { allowed: false, status: 401, error: 'OPERATOR_AUTH_REQUIRED' }
  }
  return { allowed: true }
}
