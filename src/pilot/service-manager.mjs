import { execFile as execFileCallback } from 'node:child_process'
import { chmod, open, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { promisify } from 'node:util'
import { submitLinuxService, removeLinuxService, linuxServiceActive } from './linux-service.mjs'

const execFile = promisify(execFileCallback)

export function evaluatePilotServiceStatus({ jobLoaded, portListening }) {
  const status = jobLoaded
    ? (portListening ? 'running' : 'starting')
    : (portListening ? 'unmanaged' : 'stopped')
  return Object.freeze({ status, jobLoaded, portListening })
}

export async function submitPilotService({
  label,
  program,
  args = [],
  outputPath,
  workingDirectory,
  uid = process.getuid?.(),
  execFileImpl = execFile,
  platform = process.platform,
  env = process.env,
} = {}) {
  if (platform === 'linux') return submitLinuxService({ label, program, args, outputPath, workingDirectory, env, execFileImpl })
  if (platform !== 'darwin') throw new Error('PILOT_PLATFORM_UNSUPPORTED')
  if (![label, program, outputPath].every((value) => typeof value === 'string' && value.length > 0)) {
    throw new TypeError('pilot service requires a label, program, and output path')
  }
  const log = await open(outputPath, 'a', 0o600)
  await log.close()
  await chmod(outputPath, 0o600)
  const plistPath = `${outputPath}.plist`
  await writeFile(plistPath, pilotServicePlist({
    label,
    program,
    args,
    outputPath,
    workingDirectory,
  }), { mode: 0o600 })
  await chmod(plistPath, 0o600)
  await execFileImpl('launchctl', ['bootstrap', `gui/${uid}`, plistPath], {
    timeout: 10_000,
    maxBuffer: 64_000,
  })
}

export async function removePilotService({ label, uid = process.getuid?.(), execFileImpl = execFile, platform = process.platform } = {}) {
  if (platform === 'linux') return removeLinuxService({ label, execFileImpl })
  if (platform !== 'darwin') throw new Error('PILOT_PLATFORM_UNSUPPORTED')
  if (typeof label !== 'string' || label.length === 0) throw new TypeError('pilot service label is required')
  try {
    await execFileImpl('launchctl', ['bootout', `gui/${uid}/${label}`], { timeout: 10_000, maxBuffer: 64_000 })
    await new Promise((resolve) => setTimeout(resolve, 50))
    return true
  } catch (error) {
    if (isMissingService(error)) {
      try {
        await execFileImpl('launchctl', ['remove', label], { timeout: 10_000, maxBuffer: 64_000 })
        await new Promise((resolve) => setTimeout(resolve, 50))
        return true
      } catch (legacyError) {
        if (isMissingService(legacyError)) return false
        throw legacyError
      }
    }
    throw error
  }
}

export function pilotServicePlist({ label, program, args = [], outputPath, workingDirectory } = {}) {
  const values = [label, program, outputPath, ...args]
  if (!values.every((value) => typeof value === 'string')) throw new TypeError('pilot service plist values must be strings')
  const directory = workingDirectory
    ? `\n  <key>WorkingDirectory</key>\n  <string>${escapePlist(workingDirectory)}</string>`
    : ''
  const argumentsXml = [program, ...args]
    .map((argument) => `    <string>${escapePlist(argument)}</string>`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapePlist(label)}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsXml}
  </array>${directory}
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>1</integer>
  <key>StandardOutPath</key>
  <string>${escapePlist(outputPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapePlist(outputPath)}</string>
</dict>
</plist>
`
}

export async function inspectPilotService({
  label,
  host = '127.0.0.1',
  port = 4174,
  uid = process.getuid?.(),
  execFileImpl = execFile,
  platform = process.platform,
} = {}) {
  if (typeof label !== 'string' || label.length === 0) throw new TypeError('pilot service label is required')
  let jobLoaded = false
  try {
    if (platform === 'linux') jobLoaded = await linuxServiceActive({ label, execFileImpl })
    else if (platform === 'darwin') {
      await execFileImpl('launchctl', ['print', `gui/${uid}/${label}`], { timeout: 5_000, maxBuffer: 64_000 })
      jobLoaded = true
    }
  } catch {
    jobLoaded = false
  }
  return evaluatePilotServiceStatus({
    jobLoaded,
    portListening: await isPortListening({ host, port }),
  })
}

export async function waitForPilotService({
  label,
  host = '127.0.0.1',
  port = 4174,
  timeoutMs = 180_000,
  intervalMs = 100,
} = {}) {
  const deadline = Date.now() + timeoutMs
  let current
  do {
    current = await inspectPilotService({ label, host, port })
    if (current.status === 'running') return current
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  } while (Date.now() < deadline)
  const error = new Error('PILOT_SERVICE_START_TIMEOUT')
  error.status = current
  throw error
}

async function isPortListening({ host, port }) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port })
    const finish = (value) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(250)
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.once('timeout', () => finish(false))
  })
}

function isMissingService(error) {
  return error?.code === 3 || /Could not find service|No such process|service not found/i.test(`${error?.stderr ?? ''} ${error?.message ?? ''}`)
}

function escapePlist(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}
