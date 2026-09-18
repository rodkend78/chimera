import crypto, { createPrivateKey, createPublicKey } from 'node:crypto'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fingerprint } from './identity.mjs'

export const IDENTITY_VAULT_SCHEMA = 'chimera.identity-vault.v1'
const ACTOR_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

function fail(code) {
  return Object.assign(new Error(code), { code })
}

function assertOwnerOnlyFile(filePath) {
  const info = lstatSync(filePath)
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw fail('IDENTITY_VAULT_PERMISSIONS_INVALID')
  }
}

function identityFromRecord(record) {
  if (!record || typeof record !== 'object' || !ACTOR_ID.test(record.id ?? '')
    || typeof record.keyId !== 'string' || typeof record.privateKey !== 'string') {
    throw fail('IDENTITY_VAULT_INVALID')
  }
  try {
    const privateKey = createPrivateKey(record.privateKey)
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('wrong key type')
    const publicKey = createPublicKey(privateKey)
    const expectedKeyId = `${record.id}:${fingerprint(publicKey).slice(0, 16)}`
    if (record.keyId !== expectedKeyId) throw new Error('key id mismatch')
    return { id: record.id, keyId: record.keyId, privateKey, publicKey }
  } catch {
    throw fail('IDENTITY_VAULT_INVALID')
  }
}

export class DurableIdentityStore {
  #records = new Map()

  constructor({ filePath }) {
    if (typeof filePath !== 'string' || filePath.length === 0 || filePath.length > 4096) {
      throw new TypeError('IDENTITY_VAULT_CONFIG_INVALID')
    }
    this.filePath = resolve(filePath)
  }

  static async open(options) {
    const store = new DurableIdentityStore(options)
    mkdirSync(dirname(store.filePath), { recursive: true, mode: 0o700 })
    try {
      assertOwnerOnlyFile(store.filePath)
      const document = JSON.parse(readFileSync(store.filePath, 'utf8'))
      if (document?.schema !== IDENTITY_VAULT_SCHEMA || !Array.isArray(document.identities)) {
        throw fail('IDENTITY_VAULT_INVALID')
      }
      for (const record of document.identities) {
        const identity = identityFromRecord(record)
        if (store.#records.has(identity.id)) throw fail('IDENTITY_VAULT_INVALID')
        store.#records.set(identity.id, identity)
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        if (['IDENTITY_VAULT_INVALID', 'IDENTITY_VAULT_PERMISSIONS_INVALID'].includes(error?.code)) throw error
        throw fail('IDENTITY_VAULT_INVALID')
      }
    }
    return store
  }

  getOrCreate(actorId) {
    if (!ACTOR_ID.test(actorId ?? '')) throw new TypeError('IDENTITY_ACTOR_ID_INVALID')
    const existing = this.#records.get(actorId)
    if (existing) return { ...existing }
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
    const identity = {
      id: actorId,
      privateKey,
      publicKey,
      keyId: `${actorId}:${fingerprint(publicKey).slice(0, 16)}`,
    }
    this.#records.set(actorId, identity)
    try {
      this.#persist()
    } catch (error) {
      this.#records.delete(actorId)
      throw error
    }
    return { ...identity }
  }

  #persist() {
    const identities = [...this.#records.values()]
      .toSorted((left, right) => left.id.localeCompare(right.id))
      .map((identity) => ({
        id: identity.id,
        keyId: identity.keyId,
        privateKey: identity.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      }))
    const temporary = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
    try {
      writeFileSync(temporary, `${JSON.stringify({ schema: IDENTITY_VAULT_SCHEMA, identities }, null, 2)}\n`, {
        mode: 0o600,
        flag: 'wx',
      })
      renameSync(temporary, this.filePath)
      chmodSync(this.filePath, 0o600)
    } finally {
      rmSync(temporary, { force: true })
    }
  }
}
