import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { createPublicKey } from 'node:crypto'
import { dirname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const execFile = promisify(execFileCallback)
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))

function normalizeConfiguredScanner(value) {
  // Preserve bare executable names so the caller's PATH remains authoritative.
  return /[\\/]/.test(value) ? resolve(repositoryRoot, value) : value
}

export async function findGitleaks({ env = process.env, execFileImpl = execFile } = {}) {
  const configured = env.GITLEAKS_BIN?.trim()
  if (configured) {
    const candidate = normalizeConfiguredScanner(configured)
    try {
      await execFileImpl(candidate, ['version'], { cwd: repositoryRoot })
      return candidate
    } catch (error) {
      throw new Error(`GITLEAKS_BIN_FAILED: ${configured}`, { cause: error })
    }
  }
  try {
    await execFileImpl('gitleaks', ['version'], { cwd: repositoryRoot })
    return 'gitleaks'
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw new Error(`GITLEAKS_PATH_BINARY_FAILED: ${error?.message ?? String(error)}`, { cause: error })
  }
}

const gitleaks = await findGitleaks()

async function scan(source, reportPath) {
  const sourceRoot = resolve(source)
  let exitCode = 0
  try {
    await execFile(gitleaks, [
      'detect',
      '--source', '.',
      '--no-git',
      '--no-banner',
      '--redact',
      '--report-format', 'json',
      '--report-path', reportPath,
      '--config', join(repositoryRoot, '.gitleaks.toml'),
    ], { cwd: sourceRoot })
  } catch (error) {
    exitCode = Number.isInteger(error.code) ? error.code : 1
  }
  return {
    exitCode,
    findings: JSON.parse(await readFile(reportPath, 'utf8')),
  }
}

test('source-beta metadata and public labels are release-safe', async () => {
  const packageJson = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8'))
  assert.equal(packageJson.version, '0.1.0-beta.1')
  assert.equal(packageJson.private, true)
  assert.equal(packageJson.license, 'Apache-2.0')

  const [app, workers, workspace, runtime, readme, contributing, security] = await Promise.all([
    readFile(join(repositoryRoot, 'app/src/App.jsx'), 'utf8'),
    readFile(join(repositoryRoot, 'app/src/AgentWorkers.jsx'), 'utf8'),
    readFile(join(repositoryRoot, 'app/src/ProjectWorkspace.jsx'), 'utf8'),
    readFile(join(repositoryRoot, 'src/browser/runtime.mjs'), 'utf8'),
    readFile(join(repositoryRoot, 'README.md'), 'utf8'),
    readFile(join(repositoryRoot, 'CONTRIBUTING.md'), 'utf8'),
    readFile(join(repositoryRoot, 'SECURITY.md'), 'utf8'),
  ])

  assert.match(app, /Human operator/)
  assert.match(app, /\['rod', 'You'\]/)
  assert.match(app, /\['operator', 'You'\]/)
  assert.match(runtime, /this\.humanId\s*=\s*['"]rod['"]/) // protocol identity remains stable
  assert.match(workers, /You are controlling this machine/)
  assert.match(workspace, /\/absolute\/path\/to\/project/)
  assert.match(runtime, /You and RJ/)
  assert.doesNotMatch(app, /Controller\s*\/\s*Rod/)
  assert.match(readme, /Work → ChatGPT \/ Codex/)
  assert.doesNotMatch(readme, /Agents → Connections/)
  assert.match(readme, /chromium firefox/)
  assert.match(readme, /\/usr\/bin\/bwrap/)
  assert.match(contributing, /chromium firefox/)
  assert.match(security, /rodkend78\/chimera\/security\/advisories\/new/)
  assert.doesNotMatch(security, /@[^\s)]+\.[^\s)]+/)
})

test('Gitleaks exception is exact key plus exact manifest path', { skip: !gitleaks }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'chimera-public-gitleaks-'))
  t.after(() => rm(root, { recursive: true, force: true }))

  const manifestPath = join(repositoryRoot, 'extensions/account-browser/manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const parsed = createPublicKey({
    key: Buffer.from(manifest.key, 'base64'),
    format: 'der',
    type: 'spki',
  })
  assert.equal(parsed.asymmetricKeyType, 'rsa')
  assert.equal(parsed.asymmetricKeyDetails?.modulusLength, 2048)

  async function makeCase(name, relativePath, key) {
    const source = join(root, name)
    const target = join(source, relativePath)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, JSON.stringify({ key }, null, 2) + '\n')
    return source
  }

  const knownSource = join(root, 'known')
  const knownTarget = join(knownSource, 'extensions/account-browser/manifest.json')
  await mkdir(dirname(knownTarget), { recursive: true })
  await copyFile(manifestPath, knownTarget)
  const known = await scan(knownSource, join(root, 'known-report.json'))
  assert.equal(known.exitCode, 0)
  assert.equal(known.findings.length, 0)

  // Change one modulus byte so scanner expectations do not depend on random key material.
  const differentDer = Buffer.from(manifest.key, 'base64')
  differentDer[100] ^= 1
  const differentKey = differentDer.toString('base64')
  assert.equal(createPublicKey({ key: differentDer, format: 'der', type: 'spki' }).asymmetricKeyDetails?.modulusLength, 2048)
  assert.notEqual(differentKey, manifest.key)
  const different = await scan(
    await makeCase('different', 'extensions/account-browser/manifest.json', differentKey),
    join(root, 'different-report.json'),
  )
  assert.equal(different.exitCode, 1)
  assert.ok(different.findings.some(finding => finding.RuleID === 'generic-api-key'))

  const wrongPath = await scan(
    await makeCase('wrong-path', 'other/manifest.json', manifest.key),
    join(root, 'wrong-path-report.json'),
  )
  assert.equal(wrongPath.exitCode, 1)
  assert.ok(wrongPath.findings.some(finding => finding.RuleID === 'generic-api-key'))

  const nestedPath = await scan(
    await makeCase('nested-path', 'other/extensions/account-browser/manifest.json', manifest.key),
    join(root, 'nested-path-report.json'),
  )
  assert.equal(nestedPath.exitCode, 1)
  assert.ok(nestedPath.findings.some(finding => finding.RuleID === 'generic-api-key'))

  const config = await readFile(join(repositoryRoot, '.gitleaks.toml'), 'utf8')
  assert.match(config, /useDefault\s*=\s*true/)
  assert.match(config, /condition\s*=\s*["']AND["']/)
  assert.match(config, /regexTarget\s*=\s*["']line["']/)
  assert.match(config, /\^extensions\/account-browser\/manifest\\\.json\$/)
})

test('a relative configured scanner path remains executable from a temporary source root', async t => {
  const root = await mkdtemp(join(tmpdir(), 'chimera-public-gitleaks-relative-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const wrapper = join(root, 'gitleaks-wrapper')
  await writeFile(wrapper, '#!/bin/sh\nprintf "%s\\n" "gitleaks version fixture"\n', { mode: 0o755 })
  const configured = relative(repositoryRoot, wrapper)
  const candidate = await findGitleaks({ env: { GITLEAKS_BIN: configured } })
  assert.equal(candidate, resolve(repositoryRoot, configured))
  const result = await execFile(candidate, ['version'], { cwd: root })
  assert.match(result.stdout, /gitleaks version fixture/)
})

test('an explicitly configured broken scanner fails the packaging test', async () => {
  await assert.rejects(
    findGitleaks({ env: { GITLEAKS_BIN: '/usr/bin/false' } }),
    /GITLEAKS_BIN_FAILED/,
  )
})
