import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const SCHEMA = 'chimera.openrouter-settings.v1'
const DEFAULT_MODELS = Object.freeze(['openrouter/free'])
const KEY = /^[A-Za-z0-9._~+/-]{8,16384}={0,2}$/
const MODEL = /^~?[A-Za-z0-9][A-Za-z0-9._~-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._~:/-]{0,254}$/
const fail = code => Object.assign(new Error(code), { code })

function validModels(value) {
  return Array.isArray(value) && value.length >= 1 && value.length <= 16
    && value.every(model => typeof model === 'string' && model.length <= 200 && MODEL.test(model))
    && new Set(value).size === value.length
}

export class OpenRouterSettings {
  #key = null
  #models = [...DEFAULT_MODELS]
  #writeTail = Promise.resolve()

  constructor({ filePath }) {
    if (typeof filePath !== 'string' || filePath.length < 1 || filePath.length > 4096) throw fail('OPENROUTER_SETTINGS_INVALID')
    this.filePath = resolve(filePath)
  }

  static async open(options) {
    const store = new OpenRouterSettings(options)
    const directory = dirname(store.filePath)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const parent = await lstat(directory)
    if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0) throw fail('OPENROUTER_SETTINGS_PERMISSIONS_INVALID')
    try {
      const info = await lstat(store.filePath)
      if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw fail('OPENROUTER_SETTINGS_PERMISSIONS_INVALID')
      const data = JSON.parse(await readFile(store.filePath, 'utf8'))
      if (data?.schema !== SCHEMA || typeof data.apiKey !== 'string' || !KEY.test(data.apiKey)
        || !validModels(data.models) || Object.keys(data).toSorted().join(',') !== 'apiKey,models,schema') {
        throw fail('OPENROUTER_SETTINGS_INVALID')
      }
      store.#key = data.apiKey
      store.#models = [...data.models]
    } catch (error) {
      if (error?.code !== 'ENOENT') throw ['OPENROUTER_SETTINGS_INVALID', 'OPENROUTER_SETTINGS_PERMISSIONS_INVALID'].includes(error?.code)
        ? error : fail('OPENROUTER_SETTINGS_INVALID')
    }
    return store
  }

  status() { return { configured: this.#key !== null, provider: 'openrouter', models: [...this.#models] } }
  apiKey() { return this.#key }
  models() { return [...this.#models] }

  async save({ apiKey, models } = {}) {
    if (apiKey !== undefined && (typeof apiKey !== 'string' || !KEY.test(apiKey))) throw fail('OPENROUTER_KEY_INVALID')
    if (models !== undefined && !validModels(models)) throw fail('OPENROUTER_MODELS_INVALID')
    return this.#write(async () => {
      const nextKey = apiKey ?? this.#key
      const nextModels = models ?? this.#models
      if (!nextKey) throw fail('OPENROUTER_KEY_REQUIRED')
      const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, `${JSON.stringify({ schema: SCHEMA, apiKey: nextKey, models: nextModels })}\n`, { mode: 0o600, flag: 'wx' })
        await rename(temporary, this.filePath)
        await chmod(this.filePath, 0o600)
        this.#key = nextKey
        this.#models = [...nextModels]
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
      this.#models = [...DEFAULT_MODELS]
      return this.status()
    })
  }

  #write(operation) {
    const result = this.#writeTail.then(operation)
    this.#writeTail = result.catch(() => {})
    return result
  }
}
