import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { desktopEnvironment } from '../platform/desktop.mjs'

const MARKER = '# Chimera managed user service v1\n'
const options = { timeout: 10000, maxBuffer: 64000 }
export function linuxServiceName(label) {
  if (typeof label !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,127}$/.test(label)) throw new TypeError('invalid pilot service label')
  return `${label}.service`
}
const quote = value => {
  if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) throw new TypeError('invalid service value')
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%') + '"'
}
// Path directives do not use ExecStart's word parser: quotes become literal
// filename characters. Escape specifiers but keep spaces as part of the path.
const pathValue = value => {
  if (typeof value !== 'string' || value.trim() !== value || /[\x00-\x1f\x7f\\]/.test(value)) throw new TypeError('invalid service path')
  return value.replaceAll('%','%%')
}

export function linuxServiceUnit({ program, args = [], outputPath, workingDirectory, env = process.env }) {
  if (![program, outputPath, workingDirectory].every(p => typeof p === 'string' && isAbsolute(p))) throw new TypeError('invalid absolute service path')
  const environment = Object.entries(desktopEnvironment(env)).map(([key,value]) => `Environment=${quote(`${key}=${value}`)}`).join('\n')
  return `${MARKER}[Unit]\nDescription=Chimera personal workspace\nAfter=graphical-session.target\nPartOf=graphical-session.target\n\n[Service]\nType=exec\nWorkingDirectory=${pathValue(workingDirectory)}\nExecStart=:${[program,...args].map(quote).join(' ')}\n${environment}\nUMask=0077\nRestart=on-failure\nRestartSec=3\nTimeoutStopSec=30\nKillMode=control-group\nStandardOutput=append:${pathValue(outputPath)}\nStandardError=append:${pathValue(outputPath)}\n\n[Install]\nWantedBy=graphical-session.target\n`
}

async function privateFile(path, { managed = false } = {}) {
  const file = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1) throw new Error('Unsafe service file')
    if (managed && stat.size && !(await file.readFile('utf8')).startsWith(MARKER)) throw new Error('Foreign service file')
    await file.chmod(0o600)
    return file
  } catch (error) { await file.close(); throw error }
}

export async function submitLinuxService(config) {
  const name = linuxServiceName(config.label), unit = linuxServiceUnit(config)
  const unitPath = join(dirname(config.outputPath), name)
  const file = await privateFile(unitPath, { managed: true })
  try { await file.truncate(0); await file.write(Buffer.from(unit),0,Buffer.byteLength(unit),0); await file.sync() }
  finally { await file.close() }
  const log = await privateFile(config.outputPath); await log.close()
  await config.execFileImpl('systemctl', ['--user', 'daemon-reload'], options)
  await config.execFileImpl('systemctl', ['--user', 'enable', '--now', unitPath], options)
}

export async function removeLinuxService({ label, execFileImpl }) {
  const name = linuxServiceName(label)
  const { stdout } = await execFileImpl('systemctl', ['--user', 'show', '--property=LoadState', '--value', name], options)
  if (stdout.trim() === 'not-found') return false
  await execFileImpl('systemctl', ['--user', 'disable', '--now', name], options)
  return true
}

export async function linuxServiceActive({ label, execFileImpl }) {
  const name = linuxServiceName(label)
  try {
    const { stdout } = await execFileImpl('systemctl', ['--user', 'show', '--property=ActiveState', '--value', name], options)
    return ['active', 'activating', 'reloading'].includes(stdout.trim())
  } catch { return false }
}
