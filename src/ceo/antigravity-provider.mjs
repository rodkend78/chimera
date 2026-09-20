import { spawn, execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { createInterface } from 'node:readline'
import { composeStructuredModelPrompt, modelOutputSchema, parseStructuredModelResponse } from './structured-model-output.mjs'
import { desktopEnvironment, hasDesktopSession, installedExecutable, launchDesktopProcess } from '../platform/desktop.mjs'

const execFile = promisify(execFileCallback)
const fail = code => Object.assign(new Error(code), { code })
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)
const APP = '/Applications/Antigravity.app'
function parseNativeResponse(output) {
  try { return parseStructuredModelResponse(output) } catch (error) {
    // Some CLI versions concatenate schema-repair drafts in one terminal result.
    // Accept only an entirely JSON-object sequence and validate its final revision.
    if (typeof output !== 'string' || Buffer.byteLength(output) > 2 * 1024 * 1024) throw error
    let index = 0, last, count = 0
    while (index < output.length) {
      while (/\s/.test(output[index] ?? '') && index < output.length) index++
      if (index === output.length) break
      if (output[index] !== '{' || ++count > 8) throw error
      const start = index
      let depth = 0, quoted = false, escaped = false
      for (; index < output.length; index++) {
        const character = output[index]
        if (quoted) {
          if (escaped) escaped = false
          else if (character === '\\') escaped = true
          else if (character === '"') quoted = false
        } else if (character === '"') quoted = true
        else if (character === '{') depth++
        else if (character === '}' && --depth === 0) { index++; break }
      }
      if (depth !== 0 || quoted) throw error
      last = parseStructuredModelResponse(output.slice(start, index))
    }
    if (count < 2) throw error
    return last
  }
}
// Validate the small schema vocabulary emitted by modelOutputSchema locally;
// a native CLI success flag is not proof of a usable Harness response.
function matchesSchema(value, schema) {
  if (schema.anyOf) return schema.anyOf.some(candidate => matchesSchema(value, candidate))
  if (schema.enum && !schema.enum.includes(value)) return false
  if (schema.type === 'null') return value === null
  if (schema.type === 'number') return typeof value === 'number'
    && Number.isFinite(value)
    && (schema.minimum === undefined || value >= schema.minimum)
    && (schema.maximum === undefined || value <= schema.maximum)
  if (schema.type === 'integer') return Number.isSafeInteger(value)
    && (schema.minimum === undefined || value >= schema.minimum)
    && (schema.maximum === undefined || value <= schema.maximum)
  if (schema.type === 'string') return typeof value === 'string'
    && value.length >= (schema.minLength ?? 0) && value.length <= (schema.maxLength ?? Infinity)
  if (schema.type === 'array') return Array.isArray(value)
    && value.length >= (schema.minItems ?? 0) && value.length <= (schema.maxItems ?? Infinity)
    && value.every(item => matchesSchema(item, schema.items))
  if (schema.type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (schema.required ?? []).every(key => Object.hasOwn(value, key))
    && Object.entries(value).every(([key, item]) => {
      if (Object.hasOwn(schema.properties ?? {}, key)) return matchesSchema(item, schema.properties[key])
      const pattern = Object.entries(schema.patternProperties ?? {}).find(([expression]) => new RegExp(expression).test(key))
      if (pattern) return matchesSchema(item, pattern[1])
      return schema.additionalProperties !== false
    })
  return false
}
const AGENT = `---
name: chimera-router
description: Native Antigravity executor for Chimera using operator-managed permissions.
mainAgent: true
subagent: false
---
Complete the supplied Chimera assignment using your normal Antigravity permissions.
Never change permissions, authentication, billing, or purchase credits as part of a task.
Return the requested JSON. Use a supplied Chimera tool schema when requesting a
Chimera-specific action; otherwise native tools are allowed within this assignment.
Do not repeat actions already completed. Describe real outcomes, not assumed success.
`

// Preserve account/keyring access, but never inherit API, AWS, injection or endpoint overrides.
function accountEnvironment(env) {
  return Object.fromEntries(['HOME', 'USER', 'LOGNAME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']
    .filter(key => typeof env[key] === 'string').map(key => [key, env[key]]))
}

export function createAntigravityConnection({
  binary = join(homedir(), '.local/bin/agy'),
  settingsPath = join(homedir(), '.gemini/antigravity-cli/settings.json'),
  scratchRoot = tmpdir(), platform = process.platform, env = process.env,
  execFileImpl = execFile, spawnImpl = spawn, accessImpl = access, launchProcessImpl = launchDesktopProcess,
  appendAudit, timeoutMs = 180_000,
} = {}) {
  if (!isAbsolute(binary) || !isAbsolute(settingsPath) || !isAbsolute(scratchRoot)
    || typeof appendAudit !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600_000) {
    throw new TypeError('invalid Antigravity connection')
  }
  let status = { available: false, configured: false, authenticated: false, handshakeVerified: false, status: 'not-checked', models: [] }
  let refreshing = null
  let generation = 0
  const state = () => structuredClone({ providerId: 'antigravity', authentication: 'antigravity-account', execution: 'antigravity-managed', ...status })
  const options = () => ({ env: accountEnvironment(env), cwd: tmpdir(), timeout: 10_000, maxBuffer: 128 * 1024, encoding: 'utf8' })
  async function checkAccountMode() {
    let settings
    try { settings = JSON.parse(await readFile(settingsPath, 'utf8')) }
    catch (error) {
      if (error.code === 'ENOENT') return
      throw fail('ANTIGRAVITY_SETTINGS_UNREADABLE')
    }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw fail('ANTIGRAVITY_SETTINGS_UNREADABLE')
    if (settings.modelProvider !== undefined && settings.modelProvider !== '') throw fail('ANTIGRAVITY_ACCOUNT_MODE_REQUIRED')
    // Do not execute the user's global startup hooks as a side effect of connecting.
    if (settings.hooks && Object.keys(settings.hooks).length) throw fail('ANTIGRAVITY_HOOKS_REQUIRE_REVIEW')
  }
  async function refresh() {
    if (refreshing) return refreshing
    refreshing = (async () => {
      generation += 1
      status = { available: status.available, configured: false, authenticated: false, handshakeVerified: false, status: 'checking', models: [] }
      try {
        await checkAccountMode()
        await accessImpl(binary, constants.X_OK)
        const help = await execFileImpl(binary, ['--help'], options())
        const text = `${help.stdout ?? ''}\n${help.stderr ?? ''}`
        if (!['--input-format', '--output-format', '--agent', '--model', '--disable-slash-commands'].every(flag => text.includes(flag))) throw fail('ANTIGRAVITY_CLI_UPDATE_REQUIRED')
        const result = await execFileImpl(binary, ['models'], options())
        const models = (result.stdout ?? '').split(/\r?\n/).flatMap(line => {
          const match = line.trim().match(/^([a-z][a-z0-9._-]+)(?:\t+| {2,})(.{1,160})$/)
          return match && validId(match[1]) ? [{ id: match[1], name: match[2] }] : []
        })
        if (!models.length || models.length > 200 || new Set(models.map(x => x.id)).size !== models.length) throw fail('ANTIGRAVITY_CATALOG_UNAVAILABLE')
        status = { available: true, configured: false, authenticated: false, handshakeVerified: false, status: 'checking-handshake', models }
        await verifyHandshake(models[0].id)
        status = { ...status, configured: true, handshakeVerified: true, status: 'ready-to-test' }
      } catch (error) {
        status = { available: error.code !== 'ENOENT', configured: false, authenticated: false, handshakeVerified: false, status: 'unavailable', models: status.models,
          error: /^ANTIGRAVITY_[A-Z_]+$/.test(error.code) ? error.code : 'ANTIGRAVITY_DISCOVERY_FAILED' }
      }
      return state()
    })().finally(() => { refreshing = null })
    return refreshing
  }
  function router(model) {
    if (!status.configured || !validId(model) || !status.models.some(x => x.id === model)) throw fail('ANTIGRAVITY_MODEL_UNAVAILABLE')
    return {
      routerId: `antigravity:${model}`,
      nativeExecution: true,
      descriptor: { providerId: 'antigravity', model, protocol: 'agy-stream-json', authentication: 'antigravity-account' },
      async route(prompt, context = {}, { signal, onProgress, nativeWorkingDirectory, sessionScope } = {}) {
        signal?.throwIfAborted()
        if (!status.configured || !status.models.some(entry => entry.id === model)) throw fail('ANTIGRAVITY_MODEL_UNAVAILABLE')
        const startedGeneration = generation
        if (nativeWorkingDirectory !== undefined && (!isAbsolute(nativeWorkingDirectory) || nativeWorkingDirectory.length > 4096)) throw fail('ANTIGRAVITY_WORKSPACE_INVALID')
        composeStructuredModelPrompt(prompt, context, { strictToolArguments: true })
        await checkAccountMode()
        signal?.throwIfAborted()
        await mkdir(scratchRoot, { recursive: true, mode: 0o700 })
        const directory = await mkdtemp(join(scratchRoot, 'chimera-antigravity-'))
        try {
          const message = `Required response schema:\n${JSON.stringify(modelOutputSchema(context.stage))}\n\n` + composeStructuredModelPrompt(prompt, { ...context, nativeTaskWorkspace: directory,
            nativeWorkspaceInstructions: 'Use nativeProjectWorkspace for project files, otherwise nativeTaskWorkspace. Do not substitute the default Antigravity scratch directory.',
            ...(nativeWorkingDirectory ? { nativeProjectWorkspace: nativeWorkingDirectory } : {}) }, { strictToolArguments: true })
          const agentDirectory = join(directory, '.agents/agents/chimera-router')
          await mkdir(agentDirectory, { recursive: true, mode: 0o700 })
          await writeFile(join(agentDirectory, 'agent.md'), AGENT, { mode: 0o600 })
          const output = await run({ directory, model, message, stage: context.stage, signal, onProgress, nativeWorkingDirectory,
            attribution: { taskId: String(sessionScope?.rootTaskId ?? context.taskId ?? 'unknown').slice(0, 256),
              agentId: String(sessionScope?.agentId ?? context.specialistAgent?.agentId ?? 'unknown').slice(0, 256) } })
          const response = parseNativeResponse(output)
          if (!matchesSchema(response, modelOutputSchema(context.stage))) throw fail('ANTIGRAVITY_RESPONSE_INVALID')
          if (context.stage === 'specialist-loop'
            && ((response.status === 'completed') !== (response.toolCall === null))) throw fail('ANTIGRAVITY_RESPONSE_INVALID')
          if (context.stage === 'specialist-loop' && response.toolCall !== null) {
            const encoded = response.toolCall?.arguments
            if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > 64 * 1024) throw fail('MODEL_RESPONSE_TOOL_ARGUMENTS_INVALID')
            let value
            try { value = JSON.parse(encoded) } catch { throw fail('MODEL_RESPONSE_TOOL_ARGUMENTS_INVALID') }
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('MODEL_RESPONSE_TOOL_ARGUMENTS_INVALID')
            response.toolCall.arguments = value
          }
          signal?.throwIfAborted()
          if (generation === startedGeneration) status = { ...status, authenticated: true, status: 'connected' }
          await onProgress?.({ providerId: 'antigravity', phase: 'completed' })
          signal?.throwIfAborted()
          return response
        } catch (error) {
          // Preserve partial native artifacts; uncertain outcomes must not be auto-retried.
          try { await appendAudit({ kind: 'antigravity.native.failed', model, workspace: directory,
            outcome: 'review-required', code: /^[A-Z_]{3,128}$/.test(error.code) ? error.code : 'ANTIGRAVITY_TURN_FAILED' }) } catch {}
          throw error
        }
      },
    }
  }
  async function verifyHandshake(model) {
    if (!validId(model) || !status.models.some(entry => entry.id === model)) throw fail('ANTIGRAVITY_MODEL_UNAVAILABLE')
    await checkAccountMode()
    await mkdir(scratchRoot, { recursive: true, mode: 0o700 })
    const directory = await mkdtemp(join(scratchRoot, 'chimera-antigravity-'))
    try {
      const agentDirectory = join(directory, '.agents/agents/chimera-router')
      await mkdir(agentDirectory, { recursive: true, mode: 0o700 })
      await writeFile(join(agentDirectory, 'agent.md'), AGENT, { mode: 0o600 })
      await run({ directory, model })
      return { verified: true, modelCallSent: false }
    } finally { await rm(directory, { recursive: true, force: true }) }
  }
  async function run({ directory, model, message, stage, signal, onProgress, nativeWorkingDirectory, attribution = {} }) {
    signal?.throwIfAborted()
    const child = spawnImpl(binary, ['--agent', 'chimera-router', '--disable-slash-commands',
      '--add-dir', directory, ...(nativeWorkingDirectory ? ['--add-dir', nativeWorkingDirectory] : []),
      // CLI 1.2.4 forced-schema generation can loop on repair tools with Flash High.
      // Supply the schema in the prompt and enforce it locally after completion.
      '--model', model, '--input-format', 'stream-json', '--output-format', 'stream-json'],
    { cwd: directory, env: accountEnvironment(env), stdio: ['pipe', 'pipe', 'pipe'], detached: platform !== 'win32' })
    let failure, killTimer, bytes = 0, initialized = false, result, responding = false
    const kill = force => {
      try { if (platform !== 'win32' && child.pid) process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); else child.kill(force ? 'SIGKILL' : 'SIGTERM') } catch {}
    }
    const stop = error => {
      failure ??= error
      kill(false)
      killTimer ??= setTimeout(() => kill(true), 300)
    }
    const closed = new Promise(resolve => {
      child.on('error', () => { stop(fail('ANTIGRAVITY_LAUNCH_FAILED')); resolve(null) })
      child.on('close', code => resolve(code))
    })
    const abort = () => stop(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => stop(fail('ANTIGRAVITY_TIMEOUT')), timeoutMs)
    const count = chunk => { if ((bytes += chunk.length) > 4 * 1024 * 1024) stop(fail('ANTIGRAVITY_OUTPUT_LIMIT')) }
    child.stdout.on('data', count)
    child.stderr.on('data', count) // Never relay native stderr, prompts, or private reasoning.
    child.stdin.on('error', () => stop(fail('ANTIGRAVITY_LAUNCH_FAILED')))
    try {
      if (signal?.aborted) abort()
      for await (const line of createInterface({ input: child.stdout })) {
        if (failure) break
        let event
        try { event = JSON.parse(line) } catch { throw fail('ANTIGRAVITY_PROTOCOL_INVALID') }
        if (!event || typeof event !== 'object' || result) throw fail('ANTIGRAVITY_PROTOCOL_INVALID')
        if (!initialized) {
          if (event.event !== 'init' || event.init?.agent !== 'chimera-router'
            || event.init?.permission_mode !== 'request-review' || !Array.isArray(event.init?.tools)) {
            throw fail('ANTIGRAVITY_HANDSHAKE_INVALID')
          }
          if (event.init.model !== model) throw fail('ANTIGRAVITY_MODEL_MISMATCH')
          initialized = true
          await onProgress?.({ providerId: 'antigravity', phase: 'started' })
          signal?.throwIfAborted()
          if (message !== undefined) {
            try { await appendAudit({ kind: 'antigravity.native.started', ...attribution, model, execution: 'antigravity-managed', workspace: directory }) }
            catch { throw fail('ANTIGRAVITY_AUDIT_UNAVAILABLE') }
          }
          // Native tools are operator-managed in Antigravity, not Chimera sandbox tools.
          child.stdin.end(message === undefined ? undefined : JSON.stringify({ event: 'user', message: { content: message } }) + '\n')
        } else if (event.event === 'step_update') {
          if (event.step_update?.step_type === 'tool' || event.step_update?.subagent_info) {
            const name = event.step_update.tool_name
            try { await appendAudit({ kind: 'antigravity.native.tool', ...attribution, model,
              toolName: typeof name === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(name) ? name : 'native',
              phase: event.step_update.state === 'DONE' ? 'completed' : 'running',
              enforcement: 'antigravity' }) } catch { throw fail('ANTIGRAVITY_AUDIT_UNAVAILABLE') }
          }
          if (event.step_update?.step_type === 'agent_response' && !responding) {
            responding = true
            await onProgress?.({ providerId: 'antigravity', phase: 'responding' })
          }
        } else if (event.event === 'result') {
          if (Array.isArray(event.result?.denied_actions) && event.result.denied_actions.length) throw fail('ANTIGRAVITY_PERMISSION_REQUIRED')
          if (event.result?.status !== 'SUCCESS') throw fail('ANTIGRAVITY_TURN_FAILED')
          result = event.result
        } else { throw fail('ANTIGRAVITY_PROTOCOL_INVALID') }
      }
    } catch (error) { stop(error) }
    const code = await closed
    clearTimeout(timer)
    clearTimeout(killTimer)
    signal?.removeEventListener('abort', abort)
    if (failure) { kill(true); throw failure }
    signal?.throwIfAborted()
    if (code !== 0) throw fail('ANTIGRAVITY_TURN_FAILED')
    if (message === undefined && initialized && !result) return null
    if (!result) throw fail('ANTIGRAVITY_TURN_INCOMPLETE')
    const output = result.structured_output ?? result.response
    return typeof output === 'string' ? output : JSON.stringify(output)
  }
  async function openDesktop() {
    if (!['darwin', 'linux'].includes(platform)) throw fail('ANTIGRAVITY_DESKTOP_UNSUPPORTED')
    if (platform === 'linux' && !hasDesktopSession(env)) throw fail('ANTIGRAVITY_DESKTOP_SESSION_REQUIRED')
    let executable
    try {
      if (platform === 'linux') executable = await installedExecutable(['/usr/bin/antigravity', '/opt/Antigravity/bin/antigravity'], accessImpl)
      else await accessImpl(APP)
    } catch { throw fail('ANTIGRAVITY_DESKTOP_NOT_INSTALLED') }
    try { await appendAudit({ kind: 'antigravity.desktop.requested', actorId: 'human:rod' }) }
    catch { throw fail('ANTIGRAVITY_AUDIT_UNAVAILABLE') }
    try {
      if (platform === 'linux') await launchProcessImpl(executable, [], { env: desktopEnvironment(env), cwd: tmpdir() })
      else await execFileImpl('/usr/bin/open', ['-a', APP], options())
    }
    catch { throw fail('ANTIGRAVITY_DESKTOP_LAUNCH_FAILED') }
    try { await appendAudit({ kind: 'antigravity.desktop.launched', actorId: 'human:rod' }) }
    catch { throw fail('ANTIGRAVITY_DESKTOP_RESULT_UNRECORDED') }
    return { status: 'launch-requested', taskStarted: false }
  }
  return { state, refresh, router, openDesktop, verifyHandshake }
}
