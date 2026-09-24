let csrfToken = null
let operatorInitialization = null
let operatorExpiresAt = 0
let initializationBootstrap = null
const attemptedBootstraps = new Set()

function invalidateOperatorSession(expectedToken = csrfToken) {
  if (csrfToken !== expectedToken) return
  csrfToken = null
  operatorInitialization = null
  operatorExpiresAt = 0
}

function safeRecovery(value) {
  const receipt = value && typeof value === 'object' && !Array.isArray(value) ? value : null
  if (!receipt || typeof receipt.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(receipt.requestId)) return null
  return {
    requestId: receipt.requestId,
    ...(typeof receipt.providerId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(receipt.providerId) ? { providerId: receipt.providerId } : {}),
    ...(typeof receipt.operation === 'string' && /^[a-z-]{3,32}$/.test(receipt.operation) ? { operation: receipt.operation } : {}),
    ...(typeof receipt.model === 'string' && /^~?[A-Za-z0-9][A-Za-z0-9._~:/@+-]{0,511}$/.test(receipt.model) ? { model: receipt.model } : {}),
    ...(typeof receipt.status === 'string' && ['pending', 'succeeded', 'failed', 'unknown'].includes(receipt.status) ? { status: receipt.status } : {}),
  }
}

function typedApiError(message, { status = null, body = null, ambiguous = false } = {}) {
  const error = new Error(message)
  error.name = 'ChimeraApiError'
  error.code = typeof body?.error === 'string' ? body.error : message
  error.status = status
  error.ambiguous = ambiguous
  error.reconciliationRequired = body?.reconciliationRequired === true
  error.retryAllowed = body?.retryAllowed === true
  const receipt = safeRecovery(body?.receipt)
  if (receipt) error.receipt = receipt
  return error
}

async function sessionResponse(response) {
  const body = await response.json()
  if (!response.ok || typeof body.csrfToken !== 'string' || !body.csrfToken) {
    throw new Error(body.error ?? 'OPERATOR_AUTH_REQUIRED')
  }
  return body
}

export function browserCommandFailureMessage(error) {
  const message = error instanceof Error ? error.message : String(error ?? 'BROWSER_COMMAND_FAILED')
  if (/failed to fetch/i.test(message)) {
    return 'Chimera service is offline. Restart it with npm run pilot:up.'
  }
  return message.replaceAll('_', ' ').toLowerCase()
}

export function initializeOperatorSession() {
  const parameters = new URLSearchParams(location.hash.replace(/^#/, ''))
  const bootstrap = parameters.get('operator')
  if (operatorInitialization && bootstrap === initializationBootstrap
    && (!csrfToken || Date.now() < operatorExpiresAt)) return operatorInitialization
  initializationBootstrap = bootstrap
  operatorExpiresAt = Infinity
  const initialization = (async () => {
    let body
    if (bootstrap && !attemptedBootstraps.has(bootstrap)) {
      // A lost or rejected one-time exchange must not be replayed by a later
      // poll or recovery click. A genuinely new trusted launch still works.
      attemptedBootstraps.add(bootstrap)
      try {
        body = await sessionResponse(await fetch('/api/operator/bootstrap', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: bootstrap }),
        }))
      } catch (error) {
        // The one-time exchange may have succeeded even if its response was lost.
        // Read the cookie session to recover; never replay the exchange here.
        try {
          body = await sessionResponse(await fetch('/api/operator/session', { credentials: 'include', cache: 'no-store' }))
        } catch {
          throw error
        }
      }
    } else {
      body = await sessionResponse(await fetch('/api/operator/session', { credentials: 'include', cache: 'no-store' }))
    }
    csrfToken = body.csrfToken
    const expiresAt = Date.parse(body.expiresAt)
    // Older servers do not return expiry; periodically renew those sessions too.
    operatorExpiresAt = Number.isFinite(expiresAt) ? expiresAt : Date.now() + 60_000
    if (bootstrap) {
      history.replaceState(null, '', `${location.pathname}${location.search}`)
      initializationBootstrap = null
    }
    return { expiresAt: body.expiresAt ?? null }
  })()
  operatorInitialization = initialization.catch((error) => {
    if (operatorInitialization === cached) invalidateOperatorSession()
    throw error
  })
  const cached = operatorInitialization
  return operatorInitialization
}

export async function api(path, options = {}) {
  const safeRead = ['GET', 'HEAD'].includes(String(options.method ?? 'GET').toUpperCase())
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await initializeOperatorSession()
    const requestToken = csrfToken
    let response
    let body
    try {
      response = await fetch(path, {
        ...options,
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          ...(requestToken ? { 'x-chimera-csrf': requestToken } : {}),
          ...options.headers,
        },
      })
      body = String(options.method ?? 'GET').toUpperCase() === 'HEAD' ? {} : await response.json()
    } catch (error) {
      invalidateOperatorSession(requestToken)
      if (error?.name === 'ChimeraApiError') throw error
      throw typedApiError(error?.message ?? 'API_RESPONSE_UNAVAILABLE', { status: response?.status ?? null, ambiguous: !safeRead })
    }
    if (response.ok) return body
    const authRejected = (response.status === 401 && body.error === 'OPERATOR_AUTH_REQUIRED')
      || (response.status === 403 && body.error === 'OPERATOR_CSRF_INVALID')
    if (authRejected) {
      invalidateOperatorSession(requestToken)
      if (safeRead && attempt === 0) continue
    }
    throw typedApiError(body.error ?? `Request failed with ${response.status}`, {
      status: response.status,
      body,
      ambiguous: body?.reconciliationRequired === true || (!safeRead && response.status >= 500),
    })
  }
}

export function post(path, body = {}) {
  return api(path, { method: 'POST', body: JSON.stringify(body) })
}

export async function startCodexBrowserLogin({ humanControl, postImpl = post } = {}) {
  if (typeof humanControl !== 'boolean' || typeof postImpl !== 'function') {
    throw new TypeError('Codex browser login requires control state and an API client')
  }
  const login = await postImpl('/api/auth/codex/login')
  if (!humanControl) await postImpl('/api/control/take')
  const opened = await postImpl('/api/browser/human', {
    command: 'open-tab',
    url: login.authUrl,
  })
  if (opened?.status === 'denied') throw new Error(opened.reason ?? 'CODEX_AUTH_BROWSER_OPEN_DENIED')
  return login
}
