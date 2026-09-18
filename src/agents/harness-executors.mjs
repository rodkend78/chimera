import { spawn } from 'node:child_process'
import { lookup as dnsLookup } from 'node:dns/promises'
import { existsSync } from 'node:fs'
import { lstat, mkdir, opendir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { dirname, relative, resolve, sep } from 'node:path'
import { toolsForAccessProfile } from './access-policy.mjs'
import { PROJECT_IDENTITY_PATH } from '../projects/project-session-manager.mjs'

const MAX_FILE_BYTES = 1024 * 1024
const MAX_WEB_BYTES = 2 * 1024 * 1024
const MAX_OUTPUT_BYTES = 1024 * 1024
const MAX_RESULTS = 500
const MAX_SEARCH_ENTRIES = 10_000
const MAX_SEARCH_DEPTH = 64

function coded(code) {
  return Object.assign(new Error(code), { code })
}

function within(root, target) {
  const base = resolve(root)
  const candidate = resolve(target)
  return candidate === base || candidate.startsWith(`${base}${sep}`)
}

function validateRelativePath(value) {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > 2048
    || value.includes('\0')
    || value.includes('\\')
    || value.startsWith('/')
    || value.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw coded('WORKER_PATH_INVALID')
  }
  return value
}

async function readableTarget(workspace, path) {
  const relativePath = validateRelativePath(path)
  if (!relativePath.startsWith('mounts/') && !relativePath.startsWith('scratch/')) {
    throw coded('WORKER_READ_OUTSIDE_WORKSPACE')
  }
  const root = await realpath(resolve(workspace.path))
  const target = resolve(root, relativePath)
  if (!within(root, target)) throw coded('WORKER_PATH_INVALID')
  let actual
  try {
    actual = await realpath(target)
  } catch (error) {
    if (error?.code === 'ENOENT') throw coded('WORKER_FILE_NOT_FOUND')
    throw error
  }
  if (!within(root, actual)) throw coded('WORKER_SYMLINK_ESCAPE_BLOCKED')
  return actual
}

async function writableTarget(workspace, path) {
  const relativePath = validateRelativePath(path)
  if (!relativePath.startsWith('scratch/')) throw coded('WORKER_WRITE_OUTSIDE_SCRATCH')
  const root = await realpath(resolve(workspace.path))
  const scratch = await realpath(resolve(root, 'scratch'))
  const target = resolve(root, relativePath)
  if (!within(scratch, target) || target === scratch) throw coded('WORKER_WRITE_OUTSIDE_SCRATCH')
  const pathSegments = relativePath.split('/')
  if (pathSegments.some((segment) => segment.toLowerCase() === '.git')) throw coded('WORKER_WRITE_PROTECTED')
  const protectedRoots = Array.isArray(workspace.protectedWriteRoots) ? workspace.protectedWriteRoots : []
  if (protectedRoots.some((protectedRoot) => within(resolve(protectedRoot), target))) throw coded('WORKER_WRITE_PROTECTED')
  const segments = relative(scratch, dirname(target)).split(sep).filter(Boolean)
  let current = await realpath(scratch)
  for (const segment of segments) {
    const next = resolve(current, segment)
    try {
      const info = await lstat(next)
      if (info.isSymbolicLink() || !info.isDirectory()) throw coded('WORKER_SYMLINK_ESCAPE_BLOCKED')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      await mkdir(next, { mode: 0o700 })
    }
    current = await realpath(next)
    if (!within(scratch, current)) throw coded('WORKER_SYMLINK_ESCAPE_BLOCKED')
  }
  try {
    const info = await lstat(target)
    if (info.isSymbolicLink() || info.isDirectory()) throw coded('WORKER_SYMLINK_ESCAPE_BLOCKED')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return target
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
  await mkdir(resolve(plan.writableRoot, '.tmp'), { recursive: true, mode: 0o700 })
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

async function searchRoots(workspace, path) {
  const root = await realpath(workspace.path)
  if (path !== undefined) {
    validateRelativePath(path)
    const target = await readableTarget(workspace, path)
    if (relative(root, target).split(sep).some(part => part.toLowerCase() === '.git')) throw coded('WORKER_SEARCH_PROTECTED')
    return { root, roots: [target] }
  }
  const roots = []
  for (const name of ['mounts', 'scratch']) {
    const target = resolve(root, name)
    try {
      const info = await lstat(target)
      if (info.isDirectory() && !info.isSymbolicLink()) roots.push(target)
    } catch (error) { if (error?.code !== 'ENOENT') throw error }
  }
  return { root, roots }
}

async function listFiles(roots, accept = () => true) {
  const files = []
  let scannedEntries = 0
  let limitReason = null
  const collect = (path) => {
    if (!accept(path)) return
    if (files.length === MAX_RESULTS) limitReason = 'result-limit'
    else files.push(path)
  }
  const walk = async (directory, depth = 0) => {
    if (depth > MAX_SEARCH_DEPTH) { limitReason = 'depth-limit'; return }
    // Stream directory entries: a single huge directory must not be loaded
    // fully merely to return a bounded result.
    for await (const entry of await opendir(directory)) {
      if (scannedEntries === MAX_SEARCH_ENTRIES) { limitReason = 'scan-limit'; return }
      scannedEntries += 1
      if (entry.isSymbolicLink() || entry.name.toLowerCase() === '.git') continue
      const target = resolve(directory, entry.name)
      if (entry.isDirectory()) await walk(target, depth + 1)
      else if (entry.isFile()) collect(target)
      if (limitReason) return
    }
  }
  for (const root of roots) {
    const info = await lstat(root)
    if (info.isDirectory()) await walk(root)
    else if (info.isFile()) { scannedEntries += 1; collect(root) }
    if (limitReason) break
  }
  return { files: files.sort(), truncated: limitReason !== null, limitReason, scannedEntries }
}

function segmentMatches(pattern, value) {
  let p = 0; let v = 0; let star = -1; let retry = 0
  while (v < value.length) {
    if (pattern[p] === '?' || (pattern[p] !== '*' && pattern[p] === value[v])) { p++; v++ }
    else if (pattern[p] === '*') { star = p++; retry = v }
    else if (star >= 0) { p = star + 1; v = ++retry }
    else return false
  }
  while (pattern[p] === '*') p++
  return p === pattern.length
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
  return (path) => {
    const segments = path.split('/')
    return patterns.some(parts => {
      const memo = new Map()
      const match = (p, s) => {
        const key = `${p}:${s}`
        if (memo.has(key)) return memo.get(key)
        const result = p === parts.length ? s === segments.length
          : parts[p] === '**' ? match(p + 1, s) || (s < segments.length && match(p, s + 1))
            : s < segments.length && segmentMatches(parts[p], segments[s]) && match(p + 1, s + 1)
        memo.set(key, result)
        return result
      }
      return match(0, 0)
    })
  }
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
      const target = await readableTarget(context.workspace, args?.path)
      const content = await readFile(target)
      if (content.byteLength > MAX_FILE_BYTES) throw coded('WORKER_FILE_TOO_LARGE')
      return { path: args.path, content: content.toString('utf8') }
    },
    async write(args, context) {
      guard('write', context)
      if (typeof args?.content !== 'string' || Buffer.byteLength(args.content) > MAX_FILE_BYTES) throw coded('WORKER_CONTENT_INVALID')
      const target = await writableTarget(context.workspace, args?.path)
      const temporary = `${target}.${process.pid}.tmp`
      try {
        await writeFile(temporary, args.content, { mode: 0o600 })
        await rename(temporary, target)
      } finally {
        await rm(temporary, { force: true })
      }
      return { path: args.path, bytes: Buffer.byteLength(args.content) }
    },
    async glob(args, context) {
      guard('glob', context)
      const matches = globMatcher(args?.pattern ?? '**/*')
      const { root, roots } = await searchRoots(context.workspace, args?.path)
      const relativePath = path => relative(root, path).split(sep).join('/')
      const { files, ...coverage } = await listFiles(roots, path => matches(relativePath(path)))
      return { paths: files.map(relativePath), ...coverage }
    },
    async grep(args, context) {
      guard('grep', context)
      if (typeof args?.pattern !== 'string' || args.pattern.length === 0 || args.pattern.length > 512) throw coded('WORKER_GREP_INVALID')
      const { root, roots } = await searchRoots(context.workspace, args.path)
      const { files, ...coverage } = await listFiles(roots)
      const matches = []
      for (const file of files) {
        const content = await readFile(file)
        if (content.byteLength > MAX_FILE_BYTES || content.includes(0)) continue
        for (const [index, line] of content.toString('utf8').split('\n').entries()) {
          if (line.includes(args.pattern)) matches.push({ path: relative(root, file).split(sep).join('/'), line: index + 1, text: line.slice(0, 2048) })
          if (matches.length >= MAX_RESULTS) return { matches, ...coverage, truncated: true, limitReason: 'result-limit' }
        }
      }
      return { matches, ...coverage }
    },
    async edit(args, context) {
      guard('edit', context)
      if (typeof args?.oldText !== 'string' || typeof args?.newText !== 'string' || args.oldText.length === 0) throw coded('WORKER_EDIT_INVALID')
      const target = await writableTarget(context.workspace, args?.path)
      let content
      try { content = await readFile(target, 'utf8') } catch (error) { if (error?.code === 'ENOENT') throw coded('WORKER_FILE_NOT_FOUND'); throw error }
      const first = content.indexOf(args.oldText)
      if (first < 0 || content.indexOf(args.oldText, first + 1) >= 0) throw coded('WORKER_EDIT_MATCH_NOT_UNIQUE')
      const next = `${content.slice(0, first)}${args.newText}${content.slice(first + args.oldText.length)}`
      if (Buffer.byteLength(next) > MAX_FILE_BYTES) throw coded('WORKER_FILE_TOO_LARGE')
      await writeFile(target, next, { mode: 0o600 })
      return { path: args.path, replacements: 1 }
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
