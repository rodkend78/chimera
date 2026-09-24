import assert from 'node:assert/strict'
import { chmod, lstat, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { JevSettings } from '../src/ceo/jev-settings.mjs'
import { createJevModelRouter } from '../src/ceo/jev-decision.mjs'

test('each checkout starts keyless and saves, replaces, and removes only its own Jev key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chimera-jev-settings-'))
  try {
    const first = join(root, 'first', 'jev', 'key.json')
    const second = join(root, 'second', 'jev', 'key.json')
    const store = await JevSettings.open({ filePath: first })
    const other = await JevSettings.open({ filePath: second })
    assert.deepEqual(store.status(), { configured: false, provider: 'typesafe', model: 'jev-latest' })
    assert.equal(other.apiKey(), null)
    const key = 'test_personal_key_123'
    assert.deepEqual(await store.save(key), { configured: true, provider: 'typesafe', model: 'jev-latest' })
    assert.equal((await lstat(first)).mode & 0o777, 0o600)
    assert.equal((await lstat(join(root, 'first', 'jev'))).mode & 0o777, 0o700)
    assert.equal(JSON.stringify(store.status()).includes(key), false)
    assert.equal((await readFile(first, 'utf8')).includes(key), true)
    assert.equal((await JevSettings.open({ filePath: first })).apiKey(), key)
    await store.save('test_replacement_key_456')
    assert.equal(store.apiKey(), 'test_replacement_key_456')
    assert.equal(other.status().configured, false)
    await store.disconnect()
    assert.equal(store.apiKey(), null)
    assert.equal((await JevSettings.open({ filePath: first })).status().configured, false)
    await assert.rejects(readFile(first), { code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Jev settings reject unsafe keys and unsafe saved files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chimera-jev-settings-unsafe-'))
  try {
    const file = join(root, 'jev', 'key.json')
    const store = await JevSettings.open({ filePath: file })
    await assert.rejects(store.save('Bearer a secret\n'), { code: 'JEV_KEY_INVALID' })
    await store.save('test_personal_key_123')
    await chmod(file, 0o644)
    await assert.rejects(JevSettings.open({ filePath: file }), { code: 'JEV_SETTINGS_PERMISSIONS_INVALID' })
    await rm(file)
    await symlink(join(root, 'target'), file)
    await assert.rejects(JevSettings.open({ filePath: file }), { code: 'JEV_SETTINGS_PERMISSIONS_INVALID' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('disconnect stops an existing Jev provider before another network call', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chimera-jev-revoke-'))
  try {
    const store = await JevSettings.open({ filePath: join(root, 'jev', 'key.json') })
    let calls = 0
    const provider = createJevModelRouter({ apiKeyForCall: () => store.apiKey(), fetchImpl: async () => {
      calls += 1
      return { ok: true, async json() { return { answers: { ready: { type: 'noul', noul: 1 } } } } }
    } })
    const prompt = JSON.stringify({ state: 'A bounded state', questions: { ready: { type: 'noul', instructions: 'Ready?' } } })
    await assert.rejects(provider.route(prompt), { code: 'JEV_NOT_CONFIGURED' })
    await store.save('test_personal_key_123')
    assert.equal((await provider.route(prompt)).ready.noul, 1)
    await store.disconnect()
    await assert.rejects(provider.route(prompt), { code: 'JEV_NOT_CONFIGURED' })
    assert.equal(calls, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})
