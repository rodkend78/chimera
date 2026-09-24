import { spawn as nodeSpawn, execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { validateModelRouter } from './model-router.mjs'
import { composeStructuredModelPrompt, modelOutputSchema, parseStructuredModelResponse } from './structured-model-output.mjs'

const execFile = promisify(execFileCallback)
const MODELS = Object.freeze(['sonnet', 'opus', 'haiku'].map(id => Object.freeze({ id, name: `Claude ${id[0].toUpperCase()}${id.slice(1)}` })))
const MAX_OUTPUT = 2 * 1024 * 1024
const fail = code => Object.assign(new Error(code), { code })

function cliEnvironment(env) {
  // Claude Code uses its own local account. Never silently switch to API billing
  // through a caller's ANTHROPIC_API_KEY or a custom endpoint.
  const allowed = ['HOME', 'USER', 'LOGNAME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'CLAUDE_CONFIG_DIR']
  return Object.fromEntries(allowed.filter(key => typeof env[key] === 'string').map(key => [key, env[key]]))
}

function supportedVersion(value) {
  const match = String(value).match(/(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$)/)
  if (!match) return false
  const parts = match.slice(1).map(Number)
  return parts[0] > 2 || parts[0] === 2 && (parts[1] > 1 || parts[1] === 1 && parts[2] >= 248)
}

function strictToolArguments(response, stage) {
  if (stage !== 'specialist-loop' || response.toolCall === null) return response
  const encoded = response.toolCall?.arguments
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded, 'utf8') > 64 * 1024) throw fail('MODEL_RESPONSE_TOOL_ARGUMENTS_INVALID')
  let args
  try { args = JSON.parse(encoded) } catch { throw fail('MODEL_RESPONSE_TOOL_ARGUMENTS_INVALID') }
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw fail('MODEL_RESPONSE_TOOL_ARGUMENTS_INVALID')
  return { ...response, toolCall: { ...response.toolCall, arguments: args } }
}

async function runPrint({ binary, model, input, schema, signal, spawnImpl, env, directory }) {
  const args = ['--restricted', '--safe-mode', '--strict-mcp-config', '--tools', '',
    '--no-session-persistence', '--permission-mode', 'plan', '--max-turns', '1',
    '--output-format', 'json', '--json-schema', JSON.stringify(schema), '--model', model,
    '-p', 'Answer the structured Chimera task supplied on standard input.']
  return new Promise((resolve, reject) => {
    const child = spawnImpl(binary, args, { cwd: directory, env, stdio: ['pipe', 'pipe', 'pipe'], signal })
    let stdout = '', bytes = 0, finished = false
    const timeout = setTimeout(() => { child.kill('SIGKILL') }, 120_000)
    const settle = (error, result) => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      if (error) reject(error)
      else resolve(result)
    }
    child.on('error', error => settle(error?.name === 'AbortError' ? error : fail('CLAUDE_CODE_CLI_FAILED')))
    child.stdout.on('data', chunk => {
      bytes += chunk.length
      if (bytes > MAX_OUTPUT) { child.kill('SIGKILL'); settle(fail('CLAUDE_CODE_RESPONSE_LIMIT')); return }
      stdout += chunk.toString('utf8')
    })
    // Never place stderr in errors, logs, or connection state: it can contain task text.
    child.stderr.on('data', () => {})
    child.on('close', code => settle(code === 0 ? null : fail('CLAUDE_CODE_TURN_FAILED'), stdout))
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

export function createClaudeCodeConnection({ binary = 'claude', execFileImpl = execFile,
  spawnImpl = nodeSpawn, env = process.env } = {}) {
  if (typeof binary !== 'string' || !/^[A-Za-z0-9_./-]{1,4096}$/.test(binary)
    || typeof execFileImpl !== 'function' || typeof spawnImpl !== 'function') throw new TypeError('invalid Claude Code connection')
  const environment = cliEnvironment(env)
  let status = { available: false, configured: false, status: 'cli-not-found', models: MODELS }
  return Object.freeze({
    state: () => ({ ...status, models: MODELS.map(model => ({ ...model })) }),
    async refresh() {
      let version
      try {
        version = await execFileImpl(binary, ['--version'], { env: environment, timeout: 10_000, maxBuffer: 4096 })
      } catch {
        status = { available: false, configured: false, status: 'cli-not-found', models: MODELS }
        return this.state()
      }
      if (!supportedVersion(version.stdout)) {
        status = { available: true, configured: false, status: 'cli-update-required', models: MODELS }
        return this.state()
      }
      let auth
      try {
        auth = await execFileImpl(binary, ['auth', 'status'], { env: environment, timeout: 10_000, maxBuffer: 16_384 })
      } catch (error) { auth = { stdout: error?.stdout ?? '' } }
      let loggedIn = false
      try { loggedIn = JSON.parse(auth.stdout)?.loggedIn === true } catch { /* signed out or unexpected CLI output */ }
      status = { available: true, configured: loggedIn, status: loggedIn ? 'connected' : 'sign-in-required', models: MODELS }
      return this.state()
    },
    router(model) {
      if (!MODELS.some(entry => entry.id === model) || !status.configured) throw fail('CLAUDE_CODE_MODEL_UNAVAILABLE')
      return validateModelRouter(Object.freeze({
        routerId: `claude-code:${model}`,
        descriptor: Object.freeze({ providerId: 'claude-code', model, protocol: 'claude-code-cli', authentication: 'claude-code-account', execution: 'inference-only' }),
        async route(prompt, context = {}, { signal, onProgress } = {}) {
          signal?.throwIfAborted()
          if (!status.configured) throw fail('CLAUDE_CODE_AUTH_REQUIRED')
          const input = composeStructuredModelPrompt(prompt, context, { strictToolArguments: true })
          await onProgress?.({ providerId: 'claude-code', phase: 'started' })
          const directory = await mkdtemp(join(tmpdir(), 'chimera-claude-'))
          try {
            const output = await runPrint({ binary, model, input, schema: modelOutputSchema(context?.stage),
              signal, spawnImpl, env: environment, directory })
            signal?.throwIfAborted()
            let result
            try { result = JSON.parse(output) } catch { throw fail('CLAUDE_CODE_RESPONSE_INVALID') }
            if (result?.is_error === true || !result?.structured_output || typeof result.structured_output !== 'object'
              || Array.isArray(result.structured_output)) throw fail('CLAUDE_CODE_RESPONSE_INVALID')
            const response = strictToolArguments(parseStructuredModelResponse(JSON.stringify(result.structured_output)), context?.stage)
            await onProgress?.({ providerId: 'claude-code', phase: 'completed' })
            signal?.throwIfAborted()
            return response
          } finally {
            await rm(directory, { recursive: true, force: true })
          }
        },
      }))
    },
  })
}
