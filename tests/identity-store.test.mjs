import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DurableIdentityStore } from '../src/identity-store.mjs'
import { fingerprint, signPayload, verifyPayload } from '../src/identity.mjs'

test('identity vault persists stable signing identities with owner-only permissions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-identities-'))
  const filePath = join(directory, 'actors.json')
  try {
    const first = await DurableIdentityStore.open({ filePath })
    const rod = first.getOrCreate('rod')
    const signature = signPayload({ proof: 'stable' }, rod.privateKey)

    const reopened = await DurableIdentityStore.open({ filePath })
    const restored = reopened.getOrCreate('rod')
    assert.equal(restored.keyId, rod.keyId)
    assert.equal(fingerprint(restored.publicKey), fingerprint(rod.publicKey))
    assert.equal(verifyPayload({ proof: 'stable' }, signature, restored.publicKey), true)
    assert.equal((await stat(filePath)).mode & 0o777, 0o600)
    assert.match(await readFile(filePath, 'utf8'), /PRIVATE KEY/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('identity vault rejects corruption and permissive restored files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-identities-invalid-'))
  const filePath = join(directory, 'actors.json')
  try {
    await writeFile(filePath, '{"schema":"chimera.identity-vault.v1","identities":[]}', { mode: 0o644 })
    await assert.rejects(DurableIdentityStore.open({ filePath }), /IDENTITY_VAULT_PERMISSIONS_INVALID/)
    await chmod(filePath, 0o600)
    await writeFile(filePath, '{not-json', { mode: 0o600 })
    await assert.rejects(DurableIdentityStore.open({ filePath }), /IDENTITY_VAULT_INVALID/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
