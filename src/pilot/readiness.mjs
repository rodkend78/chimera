import { constants } from 'node:fs'
import { access, readFile, stat } from 'node:fs/promises'
import { execFile as execFileCallback } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { chromium } from 'playwright'
import { detectCodexSubscription } from '../ceo/local-model-fabric.mjs'
import { createClaudeCodeConnection } from '../ceo/claude-code-provider.mjs'
import { OpenRouterSettings } from '../ceo/openrouter-settings.mjs'

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
    ...(modelAccess.claudeCode?.configured === true ? ['claude-code'] : []),
    ...(modelAccess.openrouter?.configured === true ? ['openrouter'] : []),
    ...(modelAccess.bedrock.configured === true ? ['aws-bedrock'] : []),
  ]
  const executionConfigured = modelAccess.codex.configured === true
    || modelAccess.claudeCode?.configured === true || modelAccess.openrouter?.configured === true

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
    ...(modelAccess.openrouter?.settingsError ? [check(
      'openrouter-settings',
      false,
      'OpenRouter settings cannot be read safely.',
      'Repair or remove .chimera/openrouter/settings.json before starting Chimera. The directory must be private (0700), and the file must be a regular owner-only file (0600).',
    )] : []),
    check(
      'model-provider',
      modelAccess.codex.available === true || modelAccess.claudeCode?.available === true || modelAccess.openrouter?.available === true,
      executionConfigured
        ? `Configured model providers: ${configuredProviders.join(', ')}.`
        : modelAccess.codex.available === true
          ? 'Codex is installed. Connect ChatGPT from the Chimera workspace to enable CEO orchestration.'
          : modelAccess.claudeCode?.available === true
            ? 'Claude Code is installed. Sign in locally, then check the connection in Settings.'
            : modelAccess.openrouter?.available === true
          ? 'Connect ChatGPT, Claude Code, or your OpenRouter key in Settings to enable model tasks.'
          : 'A model provider is required for orchestration.',
      'Install the Codex CLI, install Claude Code, or use Settings to add your own OpenRouter API key.',
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
  const [codex, bedrock, claudeCode] = await Promise.all([
    detectCodexSubscription(),
    inspectAwsIdentity({ region: routing.region }),
    createClaudeCodeConnection().refresh(),
  ])
  const openRouterFile = join(root, '.chimera/openrouter/settings.json')
  const openrouter = await inspectOpenRouterSettings({ filePath: openRouterFile })
  return evaluatePilotReadiness({
    nodeVersion,
    host: env.CHIMERA_HOST ?? '127.0.0.1',
    chromiumAvailable: await inspectChromium(),
    filesystemBrokerAvailable: await inspectFilesystemBroker(),
    envFile: await inspectEnvFile(join(root, '.env')),
    modelAccess: { codex, bedrock, claudeCode, openrouter },
  })
}

export async function inspectOpenRouterSettings({ filePath }) {
  try {
    const settings = await OpenRouterSettings.open({ filePath })
    return { available: true, configured: settings.status().configured }
  } catch (error) {
    return { available: true, configured: false,
      settingsError: error?.code === 'OPENROUTER_SETTINGS_PERMISSIONS_INVALID'
        ? 'permissions' : 'invalid' }
  }
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
