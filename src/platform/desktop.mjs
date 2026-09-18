import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'

// Only desktop/session variables reach native applications, not model credentials.
export function desktopEnvironment(env = process.env) {
  return Object.fromEntries(['HOME', 'USER', 'LOGNAME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL',
    'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'XDG_CURRENT_DESKTOP',
    'XDG_SESSION_TYPE', 'DBUS_SESSION_BUS_ADDRESS', 'XAUTHORITY']
    .filter(key => typeof env[key] === 'string').map(key => [key, env[key]]))
}

export const hasDesktopSession = env => Boolean(env.DISPLAY || env.WAYLAND_DISPLAY)

export async function installedExecutable(candidates, accessImpl = access) {
  for (const candidate of candidates) {
    try { await accessImpl(candidate, constants.X_OK); return candidate }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  throw Object.assign(new Error('DESKTOP_APP_NOT_INSTALLED'), { code: 'ENOENT' })
}

// Long-lived GUI processes must not be killed by an execFile timeout or a closed
// SSH terminal. This confirms process dispatch only, not login/app readiness.
export function launchDesktopProcess(file, args, { env = desktopEnvironment(), cwd, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(file, args, { env, cwd, detached: true, stdio: 'ignore' })
    child.once('error', () => reject(new Error('DESKTOP_LAUNCH_FAILED')))
    child.once('spawn', () => { child.unref(); resolve() })
  })
}
