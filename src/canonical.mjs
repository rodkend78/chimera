import { createHash } from 'node:crypto'

function normalize(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical values require finite numbers')
    return value
  }

  if (Array.isArray(value)) return value.map(normalize)

  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('canonical objects must be plain records')
    }
    const output = Object.create(null)
    for (const key of Object.keys(value).sort()) {
      const member = value[key]
      if (member === undefined) throw new TypeError(`canonical values cannot contain undefined at ${key}`)
      output[key] = normalize(member)
    }
    return output
  }

  throw new TypeError(`unsupported canonical value type: ${typeof value}`)
}

export function canonicalJson(value) {
  return JSON.stringify(normalize(value))
}

export function sha256(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}
