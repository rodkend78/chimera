import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  inspectPilotService,
  removePilotService,
  submitPilotService,
  waitForPilotService,
} from '../../src/pilot/service-manager.mjs'

const LABEL = 'com.teamrsi.chimera.pilot'
const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const CHIMERA_DIR = join(ROOT, '.chimera')
const LOG_PATH = join(CHIMERA_DIR, 'pilot.log')
const DAEMON_PATH = join(ROOT, 'scripts/pilot/daemon.mjs')
const command = process.argv[2]

if (!['darwin', 'linux'].includes(process.platform)) {
  console.error('Chimera managed service supports macOS and Linux. Use npm run pilot on other platforms.')
  process.exitCode = 1
} else if (command === 'up') {
  await up()
} else if (command === 'status') {
  await status()
} else if (command === 'down') {
  await down()
} else if (command === 'restart') {
  await down()
  await up()
} else {
  console.error('Usage: node scripts/pilot/service.mjs <up|status|down|restart>')
  process.exitCode = 1
}

async function up() {
  await mkdir(CHIMERA_DIR, { recursive: true, mode: 0o700 })
  const current = await inspectPilotService({ label: LABEL })
  if (current.status === 'running') {
    console.log('Chimera pilot is already running at http://127.0.0.1:4174/')
    return
  }
  if (current.status === 'unmanaged') {
    throw new Error('CHIMERA_PORT_4174_ALREADY_IN_USE')
  }
  if (current.jobLoaded) await removePilotService({ label: LABEL })
  await submitPilotService({
    label: LABEL,
    program: process.platform === 'linux' ? process.execPath : '/bin/zsh',
    args: process.platform === 'linux' ? ['--env-file-if-exists=.env', DAEMON_PATH] : [
      '-l', '-c', 'exec "$1" "$2" "$3"', 'chimera-pilot',
      process.execPath, '--env-file-if-exists=.env', DAEMON_PATH,
    ],
    outputPath: LOG_PATH,
    workingDirectory: ROOT,
  })
  await waitForPilotService({ label: LABEL })
  const launchUrl = await latestLaunchUrl()
  console.log(`Chimera pilot is running.\n${launchUrl ?? 'Open http://127.0.0.1:4174/'}`)
}

async function status() {
  const current = await inspectPilotService({ label: LABEL })
  console.log(`Chimera pilot: ${current.status}`)
  if (current.status === 'running') console.log('http://127.0.0.1:4174/')
  if (current.status !== 'running') process.exitCode = 1
}

async function down() {
  const removed = await removePilotService({ label: LABEL })
  console.log(removed ? 'Chimera pilot stopped.' : 'Chimera pilot was not running.')
}

async function latestLaunchUrl() {
  try {
    const log = await readFile(LOG_PATH, 'utf8')
    return [...log.matchAll(/Chimera secure launch: (http:\/\/127\.0\.0\.1:4174\/#operator=[A-Za-z0-9_-]+)/g)].at(-1)?.[1] ?? null
  } catch {
    return null
  }
}
