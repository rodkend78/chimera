import { spawn } from 'node:child_process'
import { lookup as dnsLookup } from 'node:dns/promises'
import { existsSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { resolve } from 'node:path'
import { workspaceFilesystem } from './workspace-filesystem.mjs'
import { toolsForAccessProfile } from './access-policy.mjs'
import { PROJECT_IDENTITY_PATH } from '../projects/project-session-manager.mjs'

const MAX_FILE_BYTES = 1024 * 1024
const MAX_WEB_BYTES = 2 * 1024 * 1024
const MAX_OUTPUT_BYTES = 1024 * 1024

function coded(code) {
  return Object.assign(new Error(code), { code })
}

function profileAllows(accessProfileFor, agentId, toolName, context) {
  const ceilingProfileId = accessProfileFor(agentId)
  const profileId = context?.accessProfileId ?? ceilingProfileId
  const rank = { sandbox: 0, connected: 1, live: 2 }
  if (!(profileId in rank) || !(ceilingProfileId in rank) || rank[profileId] > rank[ceilingProfileId]) {
    throw coded('TOOL_ACCESS_LEASE_EXCEEDS_CEILING')
  }
  if (!toolsForAccessProfile(profileId).includes(toolName)) throw coded('TOOL_NOT_ALLOWED_FOR_ACCESS_PROFILE')
  return profileId
}

function publicIp(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19)))
  }
  if (net.isIPv6(address)) {
    const value = address.toLowerCase().split('%')[0]
    return /^[23][0-9a-f]{0,3}:/.test(value) && !value.startsWith('2001:db8:')
  }
  return false
}

async function inspectPublicUrl(value, lookup) {
  let url
  try { url = new URL(value) } catch { throw coded('NETWORK_DESTINATION_BLOCKED') }
  if (!['http:', 'https:'].includes(url.protocol)
    || url.username
    || url.password
    || url.hostname === 'localhost'
    || url.hostname.endsWith('.localhost')
    || url.hostname.toLowerCase() === 'metadata.google.internal'
    || url.hostname.toLowerCase().endsWith('.internal')) {
    throw coded('NETWORK_DESTINATION_BLOCKED')
  }
  const addresses = net.isIP(url.hostname)
    ? [{ address: url.hostname, family: net.isIPv4(url.hostname) ? 4 : 6 }]
    : await lookup(url.hostname, { all: true, verbatim: true })
  if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some(({ address }) => !publicIp(address))) {
    throw coded('NETWORK_DESTINATION_BLOCKED')
  }
  return { url, address: addresses[0] }
}

async function requestPublic({ url, address }, { timeoutMs }) {
  const transport = url.protocol === 'https:' ? https : http
  return new Promise((resolvePromise, rejectPromise) => {
    const request = transport.request(url, {
      method: 'GET',
      headers: { accept: 'text/*, application/json;q=0.9, */*;q=0.1', 'user-agent': 'Chimera-Harness/1.0' },
      lookup(_hostname, _options, callback) { callback(null, address.address, address.family) },
    }, (response) => {
      if ((response.statusCode ?? 500) >= 300 && (response.statusCode ?? 500) < 400) {
        response.resume()
        rejectPromise(coded('NETWORK_REDIRECT_BLOCKED'))
        return
      }
      const chunks = []
      let bytes = 0
      response.on('data', (chunk) => {
        bytes += chunk.length
        if (bytes > MAX_WEB_BYTES) request.destroy(coded('NETWORK_RESPONSE_TOO_LARGE'))
        else chunks.push(chunk)
      })
      response.on('end', () => resolvePromise({
        status: response.statusCode ?? 0,
        contentType: response.headers['content-type'] ?? 'application/octet-stream',
        content: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    request.setTimeout(timeoutMs, () => request.destroy(coded('NETWORK_REQUEST_TIMEOUT')))
    request.on('error', rejectPromise)
    request.end()
  })
}

function seatbeltEscape(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

function sandboxProfile(plan) {
  const readable = seatbeltEscape(plan.readableRoot)
  const writable = seatbeltEscape(plan.writableRoot)
  const protectedWrites = (plan.protectedWriteRoots ?? [])
    .map((path) => `(deny file-write* (subpath "${seatbeltEscape(path)}"))`)
    .join('\n')
  return `(version 1)
(deny default)
(import "system.sb")
(import "bsd.sb")
(allow process*)
(allow file-read* file-test-existence (subpath "${readable}"))
(allow file-write* (subpath "${writable}"))
${protectedWrites}
(deny network*)`
}

const LINUX_SYSTEM_PATHS = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc']

export function linuxSandboxArgs(plan, { systemPaths = LINUX_SYSTEM_PATHS.filter(existsSync) } = {}) {
  const args = [
    '--die-with-parent',
    '--new-session',
    '--unshare-all',
    '--unshare-net',
    '--clearenv',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
  ]
  for (const path of systemPaths) args.push('--ro-bind', path, path)
  args.push(
    '--ro-bind', plan.readableRoot, plan.readableRoot,
    '--bind', plan.writableRoot, plan.writableRoot,
  )
  for (const protectedRoot of plan.protectedWriteRoots ?? []) {
    if (existsSync(protectedRoot)) args.push('--ro-bind', protectedRoot, protectedRoot)
  }
  args.push(
    '--chdir', plan.cwd,
    '--setenv', 'HOME', plan.writableRoot,
    '--setenv', 'TMPDIR', '/tmp',
    '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    '--setenv', 'LANG', 'C.UTF-8',
    '/bin/sh', '-c', plan.command,
  )
  return args
}

function runBoundedProcess(executable, args, plan, env = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, {
      cwd: plan.cwd,
      detached: true,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    let bytes = 0
    let forcedFailure = null
    const terminateGroup = (code) => {
      forcedFailure ??= coded(code)
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
    const collect = (destination) => (chunk) => {
      bytes += chunk.length
      if (bytes > MAX_OUTPUT_BYTES) terminateGroup('PROCESS_OUTPUT_TOO_LARGE')
      else destination.push(chunk)
    }
    child.stdout.on('data', collect(stdout))
    child.stderr.on('data', collect(stderr))
    const timer = setTimeout(() => terminateGroup('PROCESS_TIMEOUT'), plan.timeoutMs)
    child.on('error', rejectPromise)
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer)
      if (forcedFailure) return rejectPromise(forcedFailure)
      resolvePromise({ exitCode: exitCode ?? -1, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') })
    })
  })
}

async function defaultRunProcess(plan) {
  await workspaceFilesystem({ path: plan.readableRoot }, { operation: 'prepare', path: 'scratch/.tmp' })
  if (process.platform === 'darwin') {
    return runBoundedProcess(
      '/usr/bin/sandbox-exec',
      ['-p', sandboxProfile(plan), '/bin/zsh', '-f', '-c', plan.command],
      plan,
      {
        HOME: plan.writableRoot,
        TMPDIR: resolve(plan.writableRoot, '.tmp'),
        PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
        LANG: 'en_US.UTF-8',
      },
    )
  }
  if (process.platform === 'linux' && existsSync('/usr/bin/bwrap')) {
    const result = await runBoundedProcess('/usr/bin/bwrap', linuxSandboxArgs(plan), plan)
    return assertLinuxSandboxStarted(result)
  }
  throw coded('SANDBOX_EXECUTOR_UNAVAILABLE')
}

export function assertLinuxSandboxStarted(result) {
  if (result?.exitCode !== 0 && /^bwrap:/m.test(result?.stderr ?? '')) {
    throw coded('SANDBOX_EXECUTOR_UNAVAILABLE')
  }
  return result
}

function globMatcher(pattern) {
  if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > 512
    || /[\x00-\x1f\\]/.test(pattern) || pattern.startsWith('/')
    || pattern.split('/').some(part => ['', '.', '..'].includes(part))) throw coded('WORKER_GLOB_INVALID')
  if (/[\[\]]/.test(pattern) || /\{[^}]*\{/.test(pattern)) throw coded('WORKER_GLOB_UNSUPPORTED_SYNTAX')
  let variants = [pattern]
  while (variants.some(value => value.includes('{'))) {
    const expanded = []
    for (const value of variants) {
      const match = /\{([^{}]*)\}/.exec(value)
      if (!match) {
        if (value.includes('{')) throw coded('WORKER_GLOB_UNSUPPORTED_SYNTAX')
        expanded.push(value); continue
      }
      const choices = match[1].split(',')
      if (choices.length < 2 || choices.some(choice => !/^[A-Za-z0-9_.-]+$/.test(choice))) throw coded('WORKER_GLOB_UNSUPPORTED_SYNTAX')
      for (const choice of choices) expanded.push(value.slice(0, match.index) + choice + value.slice(match.index + match[0].length))
      if (expanded.length > 32) throw coded('WORKER_GLOB_TOO_COMPLEX')
    }
    variants = expanded
  }
  const patterns = variants.map(value => value.split('/'))
  if (variants.some(value => value.includes('}')) || patterns.some(parts => parts.some(part => part !== '**' && part.includes('**')))) {
    throw coded('WORKER_GLOB_UNSUPPORTED_SYNTAX')
  }
  return patterns
}

export function createHarnessExecutors({
  accessProfileFor,
  fetchImpl,
  lookup = dnsLookup,
  runProcess = defaultRunProcess,
} = {}) {
  if (typeof accessProfileFor !== 'function') throw new TypeError('HARNESS_EXECUTOR_ACCESS_REQUIRED')
  const guard = (toolName, context) => profileAllows(accessProfileFor, context?.agentId, toolName, context)

  const executors = {
    async read(args, context) {
      guard('read', context)
      if (args?.path === PROJECT_IDENTITY_PATH) {
        const checkAccess = context?.assertAccessActive ?? context?.assertActive
        if (context?.taskScoped !== true || typeof checkAccess !== 'function'
          || typeof context?.workspace?.readProjectIdentity !== 'function') throw coded('PROJECT_IDENTITY_UNAVAILABLE')
        const assertActive = async () => {
          if (await checkAccess() === false) throw coded('PROJECT_ACCESS_LEASE_INACTIVE')
        }
        await assertActive()
        const receipt = await context.workspace.readProjectIdentity()
        await assertActive()
        return { path: PROJECT_IDENTITY_PATH, source: 'chimera-runtime', content: JSON.stringify(receipt, null, 2) }
      }
      return workspaceFilesystem(context.workspace, { operation: 'read', path: args?.path })
    },
    async write(args, context) {
      guard('write', context)
      if (typeof args?.content !== 'string' || Buffer.byteLength(args.content) > MAX_FILE_BYTES) throw coded('WORKER_CONTENT_INVALID')
      return workspaceFilesystem(context.workspace, { operation: 'write', path: args.path, content: args.content })
    },
    async glob(args, context) {
      guard('glob', context)
      const patterns = globMatcher(args?.pattern ?? '**/*')
      return workspaceFilesystem(context.workspace, { operation: 'glob', path: args?.path, patterns })
    },
    async grep(args, context) {
      guard('grep', context)
      if (typeof args?.pattern !== 'string' || args.pattern.length === 0 || args.pattern.length > 512) throw coded('WORKER_GREP_INVALID')
      return workspaceFilesystem(context.workspace, { operation: 'grep', path: args.path, pattern: args.pattern })
    },
    async edit(args, context) {
      guard('edit', context)
      if (typeof args?.oldText !== 'string' || typeof args?.newText !== 'string' || args.oldText.length === 0) throw coded('WORKER_EDIT_INVALID')
      return workspaceFilesystem(context.workspace, { operation: 'edit', path: args.path, oldText: args.oldText, newText: args.newText })
    },
    async bash(args, context) {
      const profileId = guard('bash', context)
      if (typeof args?.command !== 'string' || args.command.length === 0 || args.command.length > 32_768) throw coded('WORKER_COMMAND_INVALID')
      const timeoutMs = Math.min(Math.max(Number(args.timeoutMs ?? 30_000), 1_000), 60_000)
      const root = await realpath(resolve(context.workspace.path))
      const plan = {
        command: args.command,
        cwd: resolve(root, 'scratch'),
        readableRoot: root,
        writableRoot: resolve(root, 'scratch'),
        protectedWriteRoots: (context.workspace.protectedWriteRoots ?? []).map((path) => resolve(path)),
        network: profileId === 'sandbox' ? 'none' : 'brokered-public-only',
        timeoutMs,
      }
      return runProcess(plan)
    },
    async web_fetch(args, context) {
      guard('web_fetch', context)
      const inspected = await inspectPublicUrl(args?.url, lookup)
      if (Array.isArray(context?.networkHosts)) {
        const hostname = inspected.url.hostname.toLowerCase().replace(/\.$/, '')
        if (!context.networkHosts.includes(hostname)) throw coded('NETWORK_HOST_NOT_LEASED')
      }
      const timeoutMs = Math.min(Math.max(Number(args?.timeoutMs ?? 15_000), 1_000), 30_000)
      if (fetchImpl) {
        const response = await fetchImpl(inspected.url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
        if (response.status >= 300 && response.status < 400) throw coded('NETWORK_REDIRECT_BLOCKED')
        const content = await response.text()
        if (Buffer.byteLength(content) > MAX_WEB_BYTES) throw coded('NETWORK_RESPONSE_TOO_LARGE')
        return { url: inspected.url.toString(), status: response.status, contentType: response.headers.get('content-type') ?? 'application/octet-stream', content }
      }
      return { url: inspected.url.toString(), ...await requestPublic(inspected, { timeoutMs }) }
    },
  }
  executors.str_replace_editor = executors.edit
  return Object.freeze(executors)
}
