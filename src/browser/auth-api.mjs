export async function handleCodexAuthRequest({ pathname, method, runtime } = {}) {
  if (!runtime) throw new TypeError('Codex auth API requires a runtime')
  if (pathname === '/api/auth/codex' && method === 'GET') {
    return { status: 200, body: runtime.codexAuthState() }
  }
  if (pathname === '/api/auth/codex/login' && method === 'POST') {
    return { status: 200, body: await runtime.startCodexLogin() }
  }
  if (pathname === '/api/auth/codex/refresh' && method === 'POST') {
    return { status: 200, body: await runtime.refreshCodexAuth() }
  }
  return null
}
