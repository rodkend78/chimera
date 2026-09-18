import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MAX_OPERATOR_CSRF_TOKENS, OperatorSessionManager } from '../src/browser/operator-session.mjs'
import { authorizeOperatorRequest } from '../src/browser/operator-http-auth.mjs'

test('two tabs retain independent CSRF tokens across reads and a server restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-operator-'))
  const filePath = join(directory, 'session.json')
  let now = Date.parse('2026-08-30T18:00:00.000Z')
  try {
    const manager = await OperatorSessionManager.open({ filePath, now: () => now })
    const bootstrap = manager.issueBootstrap()
    const session = manager.exchangeBootstrap(bootstrap)
    assert.equal(manager.authenticate(`other=x; ${session.cookieName}=${session.cookieToken}`), true)
    assert.equal(manager.verifyCsrf(session.csrfToken), true)
    assert.equal((await stat(filePath)).mode & 0o777, 0o600)
    assert.throws(() => manager.exchangeBootstrap(bootstrap), /OPERATOR_BOOTSTRAP_INVALID/)

    const reopened = await OperatorSessionManager.open({ filePath, now: () => now })
    assert.equal(reopened.authenticate(`${session.cookieName}=${session.cookieToken}`), true)
    const rotated = reopened.rotateCsrf()
    assert.notEqual(rotated, session.csrfToken)
    assert.equal(reopened.verifyCsrf(session.csrfToken), true)
    assert.equal(reopened.verifyCsrf(rotated), true)

    const restarted = await OperatorSessionManager.open({ filePath, now: () => now })
    for (const token of [session.csrfToken, rotated]) {
      assert.deepEqual(authorizeOperatorRequest({
        pathname: '/api/browser/human', method: 'POST',
        headers: { cookie: `${session.cookieName}=${session.cookieToken}`, 'x-chimera-csrf': token },
      }, restarted), { allowed: true })
    }
    assert.equal(restarted.verifyCsrf('x'.repeat(43)), false)
    assert.equal(authorizeOperatorRequest({ pathname: '/api/browser/human', method: 'POST',
      headers: { 'x-chimera-csrf': rotated },
    }, restarted).status, 401)

    now += 13 * 60 * 60_000
    assert.equal(reopened.authenticate(`${session.cookieName}=${session.cookieToken}`), false)
    assert.equal(reopened.verifyCsrf(rotated), false)
  } finally {
    await chmod(directory, 0o700).catch(() => {})
    await rm(directory, { recursive: true, force: true })
  }
})

test('expired CSRF tokens are rejected while the cookie can issue a fresh token, capped at session expiry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-csrf-expiry-'))
  let now = Date.parse('2026-08-30T18:00:00.000Z')
  try {
    const manager = await OperatorSessionManager.open({ filePath: join(directory, 'session.json'),
      now: () => now, sessionLifetimeMs: 90_000, csrfLifetimeMs: 60_000 })
    const session = manager.exchangeBootstrap(manager.issueBootstrap())
    now += 60_000
    assert.equal(manager.verifyCsrf(session.csrfToken), false)
    assert.equal(manager.authenticate(`${session.cookieName}=${session.cookieToken}`), true)
    const renewed = manager.issueCsrf()
    assert.equal(renewed.expiresAt, session.sessionExpiresAt)
    assert.equal(manager.verifyCsrf(renewed.csrfToken), true)
    now += 30_000
    assert.equal(manager.verifyCsrf(renewed.csrfToken), false)
    assert.equal(manager.authenticate(`${session.cookieName}=${session.cookieToken}`), false)
    assert.throws(() => manager.issueCsrf(), /OPERATOR_SESSION_EXPIRED/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('legacy persisted sessions migrate without revoking the existing tab and new bootstrap revokes all old tokens', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-csrf-migrate-'))
  const filePath = join(directory, 'session.json')
  try {
    const manager = await OperatorSessionManager.open({ filePath })
    const session = manager.exchangeBootstrap(manager.issueBootstrap())
    const legacy = JSON.parse(await readFile(filePath, 'utf8'))
    delete legacy.csrfTokens
    await writeFile(filePath, JSON.stringify(legacy), { mode: 0o600 })
    const migrated = await OperatorSessionManager.open({ filePath })
    const secondTab = migrated.issueCsrf()
    assert.equal(migrated.verifyCsrf(session.csrfToken), true)
    assert.equal(migrated.verifyCsrf(secondTab.csrfToken), true)
    const replacement = migrated.exchangeBootstrap(migrated.issueBootstrap())
    assert.equal(migrated.verifyCsrf(session.csrfToken), false)
    assert.equal(migrated.verifyCsrf(secondTab.csrfToken), false)
    assert.equal(migrated.authenticate(`${session.cookieName}=${session.cookieToken}`), false)
    assert.equal(migrated.verifyCsrf(replacement.csrfToken), true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('per-session token storage is bounded and evicts the oldest token only', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-csrf-bound-'))
  const filePath = join(directory, 'session.json')
  try {
    const manager = await OperatorSessionManager.open({ filePath })
    const session = manager.exchangeBootstrap(manager.issueBootstrap())
    const tokens = Array.from({ length: MAX_OPERATOR_CSRF_TOKENS }, () => manager.rotateCsrf())
    assert.equal(manager.verifyCsrf(session.csrfToken), false)
    assert.equal(tokens.every((token) => manager.verifyCsrf(token)), true)
    const persisted = JSON.parse(await readFile(filePath, 'utf8'))
    assert.equal(persisted.csrfTokens.length, MAX_OPERATOR_CSRF_TOKENS)
    assert.equal(JSON.stringify(persisted).includes(tokens[0]), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('bootstrap material expires before it can create an operator session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-operator-expiry-'))
  const filePath = join(directory, 'session.json')
  let now = Date.parse('2026-08-30T18:00:00.000Z')
  try {
    const manager = await OperatorSessionManager.open({
      filePath,
      now: () => now,
      bootstrapLifetimeMs: 60_000,
    })
    const bootstrap = manager.issueBootstrap()
    now += 60_001
    assert.throws(() => manager.exchangeBootstrap(bootstrap), /OPERATOR_BOOTSTRAP_INVALID/)
    assert.throws(() => manager.exchangeBootstrap(bootstrap), /OPERATOR_BOOTSTRAP_INVALID/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
