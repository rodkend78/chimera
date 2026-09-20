import { constants } from 'node:fs'
import { access, readFile, stat } from 'node:fs/promises'
import { execFile as execFileCallback } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { chromium } from 'playwright'
import { detectCodexSubscription } from '../ceo/local-model-fabric.mjs'

const MINIMUM_NODE_VERSION = [22, 19, 0]
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const execFile = promisify(execFileCallback)

function parseVersion(value) {
  const match = String(value).replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/)
  return match ? match.slice(1).map(Number) : [0, 0, 0]
}

function versionAtLeast(value, minimum) {
  const actual = parseVersion(value)
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] > minimum[index]) return true
    if (actual[index] < minimum[index]) return false
  }
  return true
}

function check(id, passed, message, remediation) {
  return Object.freeze({
    id,
    status: passed ? 'passed' : 'blocked',
    message,
    ...(passed ? {} : { remediation }),
  })
}

export function evaluatePilotReadiness({
  nodeVersion,
  host,
  chromiumAvailable,
  filesystemBrokerAvailable,
  envFile,
  modelAccess,
}) {
  if (!modelAccess?.codex || !modelAccess?.bedrock) {
    throw new TypeError('pilot readiness requires model access state')
  }

  const configuredProviders = [
    ...(modelAccess.codex.configured === true ? ['codex'] : []),
    ...(modelAccess.bedrock.configured === true ? ['aws-bedrock'] : []),
  ]

  const supportedNode = versionAtLeast(nodeVersion, MINIMUM_NODE_VERSION)
  const localBind = LOOPBACK_HOSTS.has(host)
  const safeEnvFile = envFile?.exists !== true || ((envFile.mode ?? 0) & 0o077) === 0
  const checks = [
    check('filesystem-broker', filesystemBrokerAvailable === true,
      filesystemBrokerAvailable ? 'POSIX filesystem broker is available.' : 'POSIX filesystem broker is unavailable.',
      'Install Python 3.9 or newer at /usr/bin/python3 on macOS or Linux.'),
    check(
      'node',
      supportedNode,
      supportedNode ? `Node ${nodeVersion} is supported.` : `Node ${nodeVersion} is below the supported pilot version.`,
      'Install or select Node.js 22.19.0 or newer.',
    ),
    check(
      'bind',
      localBind,
      localBind ? `Workspace will bind to loopback host ${host}.` : `Workspace host ${host} is not loopback-only.`,
      'Unset CHIMERA_HOST or set CHIMERA_HOST=127.0.0.1.',
    ),
    check(
      'chromium',
      chromiumAvailable === true,
      chromiumAvailable ? 'Playwright Chromium is installed and executable.' : 'Playwright Chromium is unavailable.',
      'Run: npx playwright install chromium',
    ),
    check(
      'env-permissions',
      safeEnvFile,
      envFile?.exists === true
        ? (safeEnvFile ? '.env is restricted to the current user.' : '.env is readable or writable by other users.')
        : 'No .env file is present; process-injected credentials remain supported.',
      'Run: chmod 600 .env',
    ),
    check(
      'model-provider',
      modelAccess.codex.available === true,
      modelAccess.codex.configured === true
        ? `Configured model providers: ${configuredProviders.join(', ')}.`
        : modelAccess.codex.available === true
          ? 'Codex is installed. Connect ChatGPT from the Chimera workspace to enable CEO orchestration.'
          : 'Codex is required for CEO orchestration; AWS Bedrock is an optional specialist lane.',
      'Install the Codex CLI. Then connect ChatGPT from Chimera; configure AWS separately to enable Bedrock specialists.',
    ),
  ]

  return Object.freeze({
    schema: 'chimera.pilot-readiness.v1',
    ready: checks.every((item) => item.status === 'passed'),
    configuredProviders: Object.freeze(configuredProviders),
    checks: Object.freeze(checks),
  })
}

async function inspectEnvFile(filePath) {
  try {
    const details = await stat(filePath)
    return { exists: true, mode: details.mode }
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false }
    throw error
  }
}

async function inspectChromium() {
  try {
    await access(chromium.executablePath(), constants.X_OK)
    return true
  } catch {
    return false
  }
}

export async function inspectAwsIdentity({
  region = 'us-west-2',
  execFileImpl = execFile,
} = {}) {
  try {
    await execFileImpl('aws', [
      'sts', 'get-caller-identity',
      '--region', region,
      '--output', 'json',
      '--no-cli-pager',
    ], {
      timeout: 10_000,
      maxBuffer: 16_384,
      encoding: 'utf8',
    })
    return { configured: true, region }
  } catch {
    return { configured: false, region }
  }
}

export async function inspectPilotReadiness({
  root = process.cwd(),
  env = process.env,
  nodeVersion = process.versions.node,
} = {}) {
  const routing = JSON.parse(await readFile(join(root, 'config/model-routing.json'), 'utf8'))
  const [codex, bedrock] = await Promise.all([
    detectCodexSubscription(),
    inspectAwsIdentity({ region: routing.region }),
  ])
  return evaluatePilotReadiness({
    nodeVersion,
    host: env.CHIMERA_HOST ?? '127.0.0.1',
    chromiumAvailable: await inspectChromium(),
    filesystemBrokerAvailable: await inspectFilesystemBroker(),
    envFile: await inspectEnvFile(join(root, '.env')),
    modelAccess: { codex, bedrock },
  })
}

export async function inspectFilesystemBroker({ execFileImpl = execFile } = {}) {
  try {
    await execFileImpl('/usr/bin/python3', ['-I', '-B', '-c',
      'import os,sys; assert sys.version_info >= (3,9); assert os.open in os.supports_dir_fd; assert os.rename in os.supports_dir_fd; assert os.scandir in os.supports_fd; assert os.O_NOFOLLOW and os.O_DIRECTORY'],
    { timeout: 5000, maxBuffer: 4096 })
    return true
  } catch { return false }
}

export function formatPilotReadiness(result) {
  const lines = [result.ready ? 'Chimera V1 pilot is ready to start.' : 'Chimera V1 pilot is blocked.']
  for (const item of result.checks) {
    lines.push(`${item.status === 'passed' ? 'PASS' : 'BLOCK'} ${item.id}: ${item.message}`)
    if (item.remediation) lines.push(`  Fix: ${item.remediation}`)
  }
  return lines.join('\n')
}
