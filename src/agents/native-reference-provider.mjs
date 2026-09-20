import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, lstat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const MAX_PERSONA_BYTES = 64 * 1024
const CREDENTIAL_ASSIGNMENT = /(?:^|\n)\s*(?:export\s+)?(?:AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)|OPENAI_API_KEY|ANTHROPIC_API_KEY|GOOGLE_API_KEY|GEMINI_API_KEY|(?:API_?)?(?:TOKEN|SECRET|PASSWORD)|PRIVATE_KEY)\s*[:=]\s*\S+/i
const PRIVATE_KEY_BLOCK = /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/
const FILESYSTEM_HELPER = fileURLToPath(new URL('./native-persona-filesystem.py', import.meta.url))

function codedError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function validAgentId(agentId) {
  if (typeof agentId !== 'string' || !AGENT_ID.test(agentId)) throw codedError('NATIVE_AGENT_ID_INVALID')
}

export function validateNativePersonaContent(content) {
  const bytes = typeof content === 'string'
    ? Buffer.from(content, 'utf8')
    : content instanceof Uint8Array ? Buffer.from(content) : null
  if (!bytes || bytes.byteLength === 0 || bytes.includes(0)) {
    throw codedError('NATIVE_PERSONA_CONTENT_INVALID')
  }
  if (bytes.byteLength > MAX_PERSONA_BYTES) throw codedError('NATIVE_PERSONA_TOO_LARGE')
  const text = bytes.toString('utf8')
  if (!text || Buffer.from(text, 'utf8').compare(bytes) !== 0
    || CREDENTIAL_ASSIGNMENT.test(text) || PRIVATE_KEY_BLOCK.test(text)) {
    throw codedError('NATIVE_PERSONA_CONTENT_INVALID')
  }
  return bytes
}

async function ensureDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw codedError('NATIVE_REFERENCE_ROOT_INVALID')
}

function parseReference(reference, { agentId, kind } = {}) {
  validAgentId(agentId)
  if (!['persona', 'memory', 'skills'].includes(kind)) throw codedError('NATIVE_REFERENCE_KIND_INVALID')
  const expected = `chimera://local/agents/${agentId}/${kind}`
  if (reference !== expected) throw codedError('NATIVE_REFERENCE_MISMATCH')
  return expected
}

async function runFilesystem(request) {
  return new Promise((resolveResult, reject) => {
    const child = execFile('/usr/bin/python3', ['-I', '-B', FILESYSTEM_HELPER], {
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      timeout: 30_000,
      maxBuffer: 256 * 1024,
    }, (error, stdout) => {
      if (error) return reject(codedError('NATIVE_REFERENCE_FILESYSTEM_UNAVAILABLE'))
      try {
        const result = JSON.parse(stdout)
        if (result.error) return reject(codedError(result.error))
        resolveResult(result.result)
      } catch {
        reject(codedError('NATIVE_REFERENCE_FILESYSTEM_UNAVAILABLE'))
      }
    })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(request))
  })
}

export class NativeAgentReferenceProvider {
  #writes = new Map()

  constructor({ root, audit }) {
    if (typeof root !== 'string' || !isAbsolute(root) || root.length > 4096
      || !audit || typeof audit.append !== 'function') {
      throw new TypeError('NATIVE_REFERENCE_CONFIG_INVALID')
    }
    this.root = resolve(root)
    this.audit = audit
  }

  static async open({ root, audit } = {}) {
    const provider = new NativeAgentReferenceProvider({ root, audit })
    await ensureDirectory(provider.root)
    return provider
  }

  async savePersona({ agentId, content, changedBy } = {}) {
    validAgentId(agentId)
    if (typeof changedBy !== 'string' || changedBy.length === 0 || changedBy.length > 128) {
      throw codedError('NATIVE_PERSONA_ACTOR_INVALID')
    }
    const bytes = validateNativePersonaContent(content)
    return this.#serialize(agentId, async () => {
      await ensureDirectory(this.root)
      await runFilesystem({ root: this.root, operation: 'save', agentId, content: bytes.toString('base64') })
      const digest = createHash('sha256').update(bytes).digest('hex')
      await this.audit.append({
        kind: 'agent.native-persona.saved',
        agentId,
        path: 'SOUL.md',
        bytes: bytes.byteLength,
        digest,
        changedBy,
      })
      return { agentId, path: 'SOUL.md', bytes: bytes.byteLength, digest }
    })
  }

  async materialize(reference, { agentId, kind } = {}) {
    parseReference(reference, { agentId, kind })
    if (kind !== 'persona') return []
    await ensureDirectory(this.root)
    const result = await runFilesystem({ root: this.root, operation: 'read', agentId })
    if (result.status === 'missing') return []
    if (result.status === 'excluded') {
      await this.audit.append({
        kind: 'agent.native-persona.excluded',
        agentId,
        path: 'SOUL.md',
        reason: 'sensitive-or-invalid-content',
      })
      return []
    }
    const bytes = Buffer.from(result.content, 'base64')
    validateNativePersonaContent(bytes)
    return [{ path: 'SOUL.md', content: bytes.toString('utf8') }]
  }

  #serialize(agentId, operation) {
    const previous = this.#writes.get(agentId) ?? Promise.resolve()
    const run = previous.then(operation)
    this.#writes.set(agentId, run.then(() => undefined, () => undefined))
    return run
  }
}
