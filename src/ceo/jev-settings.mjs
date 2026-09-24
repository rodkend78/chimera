import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const SCHEMA = 'chimera.jev-settings.v1'
const KEY = /^[A-Za-z0-9._~+/-]{8,16384}={0,2}$/
const fail = code => Object.assign(new Error(code), { code })

function validKey(value) {
  return typeof value === 'string' && KEY.test(value)
}

export class JevSettings {
  #key = null
  #writeTail = Promise.resolve()

  constructor({ filePath }) {
    if (typeof filePath !== 'string' || filePath.length < 1 || filePath.length > 4096) throw fail('JEV_SETTINGS_INVALID')
    this.filePath = resolve(filePath)
  }

  static async open(options) {
    const store = new JevSettings(options)
    const directory = dirname(store.filePath)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const parent = await lstat(directory)
    if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0) throw fail('JEV_SETTINGS_PERMISSIONS_INVALID')
    try {
      const info = await lstat(store.filePath)
      if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw fail('JEV_SETTINGS_PERMISSIONS_INVALID')
      const data = JSON.parse(await readFile(store.filePath, 'utf8'))
      if (data?.schema !== SCHEMA || !validKey(data.apiKey) || Object.keys(data).toSorted().join(',') !== 'apiKey,schema') {
        throw fail('JEV_SETTINGS_INVALID')
      }
      store.#key = data.apiKey
    } catch (error) {
      if (error?.code !== 'ENOENT') throw ['JEV_SETTINGS_INVALID', 'JEV_SETTINGS_PERMISSIONS_INVALID'].includes(error?.code)
        ? error : fail('JEV_SETTINGS_INVALID')
    }
    return store
  }

  status() { return { configured: this.#key !== null, provider: 'typesafe', model: 'jev-latest' } }
  apiKey() { return this.#key }

  async save(apiKey) {
    if (!validKey(apiKey)) throw fail('JEV_KEY_INVALID')
    return this.#write(async () => {
      const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, `${JSON.stringify({ schema: SCHEMA, apiKey })}\n`, { mode: 0o600, flag: 'wx' })
        await rename(temporary, this.filePath)
        await chmod(this.filePath, 0o600)
        this.#key = apiKey
        return this.status()
      } finally {
        await rm(temporary, { force: true })
      }
    })
  }

  async disconnect() {
    return this.#write(async () => {
      await rm(this.filePath, { force: true })
      this.#key = null
      return this.status()
    })
  }

  #write(operation) {
    const result = this.#writeTail.then(operation)
    this.#writeTail = result.catch(() => {})
    return result
  }
}
