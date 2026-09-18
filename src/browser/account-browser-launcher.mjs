import { constants } from 'node:fs'
import { access, lstat, mkdir, realpath } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { desktopEnvironment, hasDesktopSession, installedExecutable, launchDesktopProcess } from '../platform/desktop.mjs'

const CHROME_EXECUTABLE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const CHROME_APP = '/Applications/Google Chrome.app'
const USER_DATA_DIR = fileURLToPath(new URL('../../.chimera/account-browser/chrome', import.meta.url))
const DEFAULT_DESTINATION = 'https://www.google.com/'
const DESTINATIONS = new Set([
  DEFAULT_DESTINATION,
  'https://accounts.google.com/',
  'https://support.google.com/chrome/answer/2364824',
])

function codedError(code) {
  return Object.assign(new Error(code), { code })
}

function baseState(status) {
  return {
    browser: 'chrome',
    surface: 'native-window',
    status,
    companion: 'not-installed',
    agentAccess: 'unavailable',
  }
}

function destination(value) {
  if (typeof value !== 'string' || value.length > 2048 || !DESTINATIONS.has(value)) {
    throw codedError('ACCOUNT_BROWSER_URL_INVALID')
  }
  return value
}

async function prepareProfile(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || /[\0\r\n]/.test(path)) throw new Error('Invalid profile path')
  // Reject redirected ancestors before creating anything. Never chmod or repair
  // existing profile data, and leave Chrome's own singleton/session files alone.
  for (let current = path; ; current = dirname(current)) {
    try {
      const info = await lstat(current)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe profile path')
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (dirname(current) === current) break
  }
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) || await realpath(path) !== path) throw new Error('Unsafe profile directory')
}

export function createAccountBrowserLauncher({
  appendAudit,
  platform = process.platform,
  accessImpl = access,
  execFileImpl = promisify(execFile),
  launchProcessImpl = launchDesktopProcess,
  env = process.env,
  // Trusted construction only: the HTTP API accepts no profile or flag override.
  userDataDir = USER_DATA_DIR,
}) {
  async function state() {
    if (!['darwin', 'linux'].includes(platform)) return baseState('unsupported-platform')
    if (platform === 'linux' && !hasDesktopSession(env)) return baseState('unavailable')
    try {
      if (platform === 'linux') await linuxBrowser()
      else await accessImpl(CHROME_EXECUTABLE, constants.X_OK)
      return baseState('available')
    } catch (error) {
      return baseState(error?.code === 'ENOENT' ? 'missing-browser' : 'unavailable')
    }
  }

  const linuxBrowser = () => installedExecutable(['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium'], accessImpl)

  async function open({ url = DEFAULT_DESTINATION } = {}) {
    url = destination(url)
    const current = await state()
    if (current.status === 'unsupported-platform') throw codedError('ACCOUNT_BROWSER_UNSUPPORTED_PLATFORM')
    if (current.status === 'missing-browser') throw codedError('ACCOUNT_BROWSER_NOT_INSTALLED')
    if (current.status !== 'available') throw codedError('ACCOUNT_BROWSER_UNAVAILABLE')

    const requestId = randomUUID()
    const common = { requestId, actor: 'human', origin: new URL(url).origin }
    try {
      await appendAudit({ kind: 'account-browser.launch.requested', ...common, at: new Date().toISOString() })
    } catch {
      throw codedError('ACCOUNT_BROWSER_AUDIT_UNAVAILABLE')
    }

    try {
      await prepareProfile(userDataDir)
    } catch {
      try { await appendAudit({ kind: 'account-browser.launch.preparation-failed', ...common, at: new Date().toISOString() }) } catch {}
      throw codedError('ACCOUNT_BROWSER_PROFILE_UNAVAILABLE')
    }

    try {
      // -n prevents LaunchServices from routing into RJ's already-running Chrome.
      // Chrome may reuse only the process owning this dedicated user-data root.
      const browserArgs = [`--user-data-dir=${userDataDir}`, '--no-first-run', '--no-default-browser-check', url]
      if (platform === 'linux') await launchProcessImpl(await linuxBrowser(), browserArgs, { env: desktopEnvironment(env) })
      else await execFileImpl('/usr/bin/open', ['-n', '-a', CHROME_APP, '--args', ...browserArgs], { timeout: 10000 })
    } catch {
      try {
        await appendAudit({ kind: 'account-browser.launch.unconfirmed', ...common, at: new Date().toISOString() })
      } catch {}
      throw codedError('ACCOUNT_BROWSER_LAUNCH_UNCONFIRMED')
    }

    try {
      await appendAudit({ kind: 'account-browser.launch.accepted', ...common, at: new Date().toISOString() })
    } catch {
      throw codedError('ACCOUNT_BROWSER_RESULT_UNRECORDED')
    }
    return { status: 'launch-requested', browser: 'chrome', surface: 'native-window', agentAccess: 'unavailable' }
  }

  return { state, open }
}
