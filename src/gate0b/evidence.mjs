import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export async function readJson(path, fallback = undefined) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (fallback !== undefined && error?.code === 'ENOENT') return fallback
    throw error
  }
}

export async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

export async function appendJsonl(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 })
}

export function validateSoakConfig(config) {
  const hex40 = /^[a-f0-9]{40}$/
  const hex64 = /^[a-f0-9]{64}$/
  if (config?.schemaVersion !== 1) throw new Error('unsupported Gate 0B config schema')
  if (!Number.isInteger(config.durationHours) || config.durationHours < 1) throw new Error('durationHours must be a positive integer')
  if (!Number.isInteger(config.iterationSeconds) || config.iterationSeconds < 30) throw new Error('iterationSeconds must be at least 30')
  if (!hex40.test(config.source?.commit ?? '')) throw new Error('source commit must be a full SHA-1')
  if (!hex40.test(config.source?.tree ?? '')) throw new Error('source tree must be a full SHA-1')
  if (!hex64.test(config.source?.archiveSha256 ?? '')) throw new Error('source archiveSha256 must be SHA-256')
  for (const required of ['web', 'headless']) {
    if (!config.profiles?.includes(required)) throw new Error(`missing profile ${required}`)
  }
  for (const required of ['standard', 'code', 'minimal', 'cordis']) {
    if (!config.presets?.includes(required)) throw new Error(`missing preset ${required}`)
  }
  return config
}

export function summarizeMatrix(records, expectedNames) {
  const byName = new Map(expectedNames.map(name => [name, { name, runs: 0, passes: 0, failures: 0, last: null }]))
  for (const record of records) {
    if (record.type !== 'task' || !byName.has(record.name)) continue
    const row = byName.get(record.name)
    row.runs += 1
    if (record.ok) row.passes += 1
    else row.failures += 1
    row.last = record.at
  }
  return [...byName.values()]
}
