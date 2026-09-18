import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import { mkdtemp, realpath, rm, mkdir, lstat, writeFile, readFile, symlink, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { MemoryAuditLog } from '../src/audit-log.mjs'
import { createAccountBrowserLauncher } from '../src/browser/account-browser-launcher.mjs'

const CHROME_EXECUTABLE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const CHROME_APP = '/Applications/Google Chrome.app'
const available = { browser: 'chrome', surface: 'native-window', status: 'available', companion: 'not-installed', agentAccess: 'unavailable' }
const root = await realpath(await mkdtemp(join(tmpdir(), 'account-launch-')))
after(() => rm(root, { recursive: true, force: true }))

function fixture(overrides = {}) {
  const audit = new MemoryAuditLog()
  const accesses = []
  const launches = []
  const userDataDir = join(root, randomUUID(), 'Chimera Work')
  const launcher = createAccountBrowserLauncher({
    platform: 'darwin',
    userDataDir,
    accessImpl: async (...args) => { accesses.push(args) },
    execFileImpl: async (...args) => { launches.push(args) },
    appendAudit: fact => audit.append(fact),
    ...overrides,
  })
  return { launcher, audit, accesses, launches, userDataDir }
}

test('state reports native Chrome availability only after checking its fixed executable', async () => {
  const { launcher, accesses } = fixture()
  assert.deepEqual(await launcher.state(), available)
  assert.deepEqual(accesses, [[CHROME_EXECUTABLE, constants.X_OK]])
})

test('state distinguishes unsupported, missing, and otherwise unavailable platforms', async () => {
  const unsupported = fixture({ platform: 'win32' })
  assert.deepEqual(await unsupported.launcher.state(), { ...available, status: 'unsupported-platform' })
  assert.equal(unsupported.accesses.length, 0)

  for (const [code, status] of [['ENOENT', 'missing-browser'], ['EACCES', 'unavailable']]) {
    const current = fixture({ accessImpl: async () => { throw Object.assign(new Error('private detail'), { code }) } })
    assert.deepEqual(await current.launcher.state(), { ...available, status })
  }
})

test('open records ordered sanitized intent and acceptance around one exact OS launch', async () => {
  const { launcher, audit, launches, userDataDir } = fixture()
  assert.deepEqual(await launcher.open(), { status: 'launch-requested', browser: 'chrome', surface: 'native-window', agentAccess: 'unavailable' })
  assert.deepEqual(launches, [['/usr/bin/open', ['-n', '-a', CHROME_APP, '--args', `--user-data-dir=${userDataDir}`, '--no-first-run', '--no-default-browser-check', 'https://www.google.com/'], { timeout: 10000 }]])
  const facts = audit.entries().map(entry => entry.fact)
  assert.deepEqual(facts.map(fact => fact.kind), ['account-browser.launch.requested', 'account-browser.launch.accepted'])
  assert.equal(facts[0].requestId, facts[1].requestId)
  for (const fact of facts) {
    assert.equal(fact.actor, 'human')
    assert.equal(fact.origin, 'https://www.google.com')
    assert.match(fact.at, /^\d{4}-\d{2}-\d{2}T/)
    assert.deepEqual(Object.keys(fact).sort(), ['actor', 'at', 'kind', 'origin', 'requestId'])
  }
})

test('open permits only the three independently specified exact destinations', async () => {
  for (const url of ['https://www.google.com/', 'https://accounts.google.com/', 'https://support.google.com/chrome/answer/2364824']) {
    const { launcher, launches } = fixture()
    await launcher.open({ url })
    assert.equal(launches[0][1].at(-1), url)
  }
})

test('open rejects invalid and lookalike destinations before probing, audit, or OS launch', async () => {
  const invalid = [
    null, 1, {}, '', 'x'.repeat(2049), 'https://www.google.com/\n',
    'https://user:secret@www.google.com/', 'https://www.google.com/?secret=1',
    'https://www.google.com/#fragment', 'file:///etc/passwd', 'javascript:alert(1)',
    'http://localhost/', 'http://127.0.0.1/', 'http://192.168.1.5/',
    'https://chimera.local/', 'https://www.google.com.evil.test/',
    'https://evil.test/www.google.com/', 'https://accounts.google.com/signin',
    'https://support.google.com/', 'https://support.google.com/chrome/answer/2364824/',
  ]
  for (const url of invalid) {
    const { launcher, audit, accesses, launches } = fixture()
    await assert.rejects(launcher.open({ url }), error => error.code === 'ACCOUNT_BROWSER_URL_INVALID')
    assert.equal(accesses.length, 0)
    assert.equal(launches.length, 0)
    assert.equal(audit.entries().length, 0)
  }
})

test('open refuses unsupported, missing, and inaccessible Chrome before audit or launch', async () => {
  const cases = [
    [{ platform: 'win32' }, 'ACCOUNT_BROWSER_UNSUPPORTED_PLATFORM'],
    [{ accessImpl: async () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }) } }, 'ACCOUNT_BROWSER_NOT_INSTALLED'],
    [{ accessImpl: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) } }, 'ACCOUNT_BROWSER_UNAVAILABLE'],
  ]
  for (const [overrides, code] of cases) {
    const { launcher, audit, launches } = fixture(overrides)
    await assert.rejects(launcher.open(), error => error.code === code)
    assert.equal(audit.entries().length, 0)
    assert.equal(launches.length, 0)
  }
})

test('open never dispatches when intent audit is unavailable', async () => {
  const { launcher, launches } = fixture({ appendAudit: async () => { throw new Error('disk details') } })
  await assert.rejects(launcher.open(), error => error.code === 'ACCOUNT_BROWSER_AUDIT_UNAVAILABLE' && !error.message.includes('disk'))
  assert.equal(launches.length, 0)
})

test('open records one sanitized unconfirmed result and never retries a failed OS launch', async () => {
  const audit = new MemoryAuditLog()
  let attempts = 0
  const launcher = fixture({
    appendAudit: fact => audit.append(fact),
    execFileImpl: async () => { attempts += 1; throw new Error('stderr has private path') },
  }).launcher
  await assert.rejects(launcher.open(), error => error.code === 'ACCOUNT_BROWSER_LAUNCH_UNCONFIRMED' && !error.message.includes('private'))
  assert.equal(attempts, 1)
  assert.deepEqual(audit.entries().map(entry => entry.fact.kind), ['account-browser.launch.requested', 'account-browser.launch.unconfirmed'])
})

test('open reports an unrecorded result only after successful dispatch when acceptance audit fails', async () => {
  const facts = []
  let dispatches = 0
  const launcher = fixture({
    appendAudit: async fact => { facts.push(fact); if (fact.kind === 'account-browser.launch.accepted') throw new Error('audit detail') },
    execFileImpl: async () => { dispatches += 1 },
  }).launcher
  await assert.rejects(launcher.open(), error => error.code === 'ACCOUNT_BROWSER_RESULT_UNRECORDED' && !error.message.includes('detail'))
  assert.equal(dispatches, 1)
  assert.deepEqual(facts.map(fact => fact.kind), ['account-browser.launch.requested', 'account-browser.launch.accepted'])
})

test('open retains launch-unconfirmed when its terminal audit also fails', async () => {
  let audits = 0
  const launcher = fixture({
    appendAudit: async () => { audits += 1; if (audits > 1) throw new Error('terminal audit failed') },
    execFileImpl: async () => { throw new Error('launch failed') },
  }).launcher
  await assert.rejects(launcher.open(), error => error.code === 'ACCOUNT_BROWSER_LAUNCH_UNCONFIRMED')
  assert.equal(audits, 2)
})

// Catches reuse of an automation/default profile and accidental deletion on relaunch.
test('dedicated browser storage is private and persistent across explicit launches', async () => {
  const f = fixture()
  await f.launcher.open()
  assert.equal((await lstat(f.userDataDir)).mode & 0o777, 0o700)
  const sentinel = join(f.userDataDir, 'fixture-session')
  await writeFile(sentinel, 'keep this session')
  await f.launcher.open()
  assert.equal(await readFile(sentinel, 'utf8'), 'keep this session')
  assert.equal(f.launches.length, 2)
  assert.deepEqual(f.launches[0][1], f.launches[1][1])
  assert.ok(f.launches[0][1].includes(`--user-data-dir=${f.userDataDir}`))
  assert.ok(!f.launches[0][1].some(arg => /remote-debugging|enable-automation|load-extension/.test(arg)))
})

// Catches following a redirected/shared profile instead of failing before OS dispatch.
test('unsafe profile paths fail closed without launching or modifying foreign data', async () => {
  const foreign = join(root, 'foreign'); await mkdir(foreign)
  await writeFile(join(foreign, 'sentinel'), 'untouched')
  const link = join(root, 'redirect'); await symlink(foreign, link)
  const shared = join(root, 'shared'); await mkdir(shared); await chmod(shared, 0o755)
  const file = join(root, 'not-a-directory'); await writeFile(file, 'untouched')
  for (const userDataDir of [link, join(link, 'child'), shared, file, 'relative-profile']) {
    const f = fixture({ userDataDir })
    await assert.rejects(f.launcher.open(), { code: 'ACCOUNT_BROWSER_PROFILE_UNAVAILABLE' })
    assert.equal(f.launches.length, 0)
    assert.equal(f.audit.entries().at(-1).fact.kind, 'account-browser.launch.preparation-failed')
  }
  assert.equal(await readFile(join(foreign, 'sentinel'), 'utf8'), 'untouched')
  await assert.rejects(lstat(join(foreign, 'child')), { code: 'ENOENT' })
})

test('failed intent audit does not create the dedicated profile', async () => {
  const f = fixture({ appendAudit: async () => { throw new Error('audit unavailable') } })
  await assert.rejects(f.launcher.open(), { code: 'ACCOUNT_BROWSER_AUDIT_UNAVAILABLE' })
  await assert.rejects(lstat(f.userDataDir), { code: 'ENOENT' })
})

test('Linux launches a discovered regular browser with dedicated storage and no automation flags', async () => {
  const launches = []
  const f = fixture({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-1', AWS_SECRET_ACCESS_KEY: 'do-not-inherit' },
    accessImpl: async file => { if (file !== '/usr/bin/chromium') throw Object.assign(Error(), { code: 'ENOENT' }) },
    launchProcessImpl: async (...args) => launches.push(args),
  })
  assert.equal((await f.launcher.state()).status, 'available')
  assert.equal((await f.launcher.open()).status, 'launch-requested')
  assert.equal(launches.length, 1)
  assert.equal(launches[0][0], '/usr/bin/chromium')
  assert.deepEqual(launches[0][1], [`--user-data-dir=${f.userDataDir}`, '--no-first-run', '--no-default-browser-check', 'https://www.google.com/'])
  assert.equal(launches[0][2].env.WAYLAND_DISPLAY, 'wayland-1')
  assert.equal(launches[0][2].env.AWS_SECRET_ACCESS_KEY, undefined)
  assert.equal(f.launches.length, 0, 'Linux must not invoke macOS open')
})

test('Linux without a desktop session fails before creating profile or dispatching', async () => {
  const f = fixture({ platform: 'linux', env: {} })
  assert.equal((await f.launcher.state()).status, 'unavailable')
  await assert.rejects(f.launcher.open(), { code: 'ACCOUNT_BROWSER_UNAVAILABLE' })
  assert.equal(f.launches.length, 0)
})
