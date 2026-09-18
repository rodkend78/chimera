import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assertLinuxSandboxStarted, createHarnessExecutors, linuxSandboxArgs } from '../src/agents/harness-executors.mjs'

test('Linux Bubblewrap arguments isolate network and make only scratch writable', () => {
  const args = linuxSandboxArgs({
    command: 'printf safe',
    cwd: '/work/ace/scratch',
    readableRoot: '/work/ace',
    writableRoot: '/work/ace/scratch',
    timeoutMs: 1_000,
  }, { systemPaths: ['/usr', '/bin', '/lib', '/etc'] })
  assert.ok(args.includes('--unshare-all'))
  assert.ok(args.includes('--unshare-net'))
  assert.deepEqual(args.slice(args.indexOf('--ro-bind', args.indexOf('/etc') - 1), args.indexOf('--ro-bind', args.indexOf('/etc') - 1) + 3), ['--ro-bind', '/etc', '/etc'])
  assert.ok(args.some((value, index) => value === '--ro-bind' && args[index + 1] === '/work/ace' && args[index + 2] === '/work/ace'))
  assert.ok(args.some((value, index) => value === '--bind' && args[index + 1] === '/work/ace/scratch' && args[index + 2] === '/work/ace/scratch'))
  assert.deepEqual(args.slice(-3), ['/bin/sh', '-c', 'printf safe'])
})

test('Linux Bubblewrap remounts task Git metadata read-only', () => {
  const args = linuxSandboxArgs({
    command: 'printf safe',
    cwd: '/work/ace/scratch',
    readableRoot: '/work/ace',
    writableRoot: '/work/ace/scratch',
    protectedWriteRoots: ['/etc'],
    timeoutMs: 1_000,
  }, { systemPaths: [] })
  const protectedIndex = args.findIndex((value, index) => value === '--ro-bind' && args[index + 1] === '/etc' && args[index + 2] === '/etc')
  const writableIndex = args.findIndex((value, index) => value === '--bind' && args[index + 1] === '/work/ace/scratch' && args[index + 2] === '/work/ace/scratch')
  assert.ok(protectedIndex > writableIndex)
  assert.deepEqual(args.slice(-3), ['/bin/sh', '-c', 'printf safe'])
})

test('Linux CI has the required Bubblewrap isolation binary', { skip: process.platform !== 'linux' }, () => {
  if (process.env.CI) assert.equal(existsSync('/usr/bin/bwrap'), true)
})

test('a Bubblewrap namespace setup failure is fail-closed instead of becoming a tool result', () => {
  assert.throws(
    () => assertLinuxSandboxStarted({ exitCode: 1, stdout: '', stderr: 'bwrap: Creating new namespace failed: Operation not permitted' }),
    /SANDBOX_EXECUTOR_UNAVAILABLE/,
  )
})

async function fixture() {
  const path = await mkdtemp(join(tmpdir(), 'chimera-executors-'))
  await mkdir(join(path, 'mounts/memory'), { recursive: true })
  await mkdir(join(path, 'scratch'), { recursive: true })
  await writeFile(join(path, 'mounts/memory/MEMORY.md'), 'bounded memory')
  return { path, state: () => ({ path }) }
}

test('globstar includes direct children and bounded brace alternatives select source extensions', async () => {
  const workspace = await fixture()
  const tools = createHarnessExecutors({ accessProfileFor: () => 'sandbox' })
  const context = { workspace, agentId: 'ace' }
  try {
    await mkdir(join(workspace.path, 'scratch/repo/server/nested'), { recursive: true })
    for (const file of ['exports.ts', 'view.tsx', 'ignored.jsx', 'nested/deep.ts']) {
      await writeFile(join(workspace.path, 'scratch/repo/server', file), 'source')
    }
    const result = await tools.glob({ pattern: 'scratch/repo/server/**/*.{ts,tsx}' }, context)
    assert.deepEqual(result.paths, ['scratch/repo/server/exports.ts', 'scratch/repo/server/nested/deep.ts', 'scratch/repo/server/view.tsx'])
    assert.equal(result.truncated, false)
    assert.deepEqual((await tools.glob({ pattern: 'scratch/repo/server/*.ts' }, context)).paths, ['scratch/repo/server/exports.ts'])
    assert.deepEqual((await tools.glob({ pattern: 'scratch/repo/server/**/deep.t?' }, context)).paths, ['scratch/repo/server/nested/deep.ts'])
  } finally { await rm(workspace.path, { recursive: true, force: true }) }
})

test('wildcards still match when a filename itself contains a star', async () => {
  const workspace = await fixture()
  const tools = createHarnessExecutors({ accessProfileFor: () => 'sandbox' })
  try {
    await writeFile(join(workspace.path, 'scratch/*notes'), 'literal filename')
    assert.deepEqual((await tools.glob({ pattern: 'scratch/*' }, { workspace, agentId: 'ace' })).paths, ['scratch/*notes'])
  } finally { await rm(workspace.path, { recursive: true, force: true }) }
})

test('glob limits matching results rather than dropping a target behind unrelated files and Git metadata', async () => {
  const workspace = await fixture()
  const tools = createHarnessExecutors({ accessProfileFor: () => 'sandbox' })
  try {
    await mkdir(join(workspace.path, 'scratch/repo/a-noise'), { recursive: true })
    await mkdir(join(workspace.path, 'scratch/repo/.git'), { recursive: true })
    await mkdir(join(workspace.path, 'scratch/repo/z-server'), { recursive: true })
    for (let batch = 0; batch < 6; batch++) {
      await Promise.all(Array.from({ length: 100 }, (_, index) => writeFile(join(workspace.path, `scratch/repo/a-noise/${batch}-${index}.txt`), 'noise')))
    }
    await writeFile(join(workspace.path, 'scratch/repo/.git/private'), 'metadata')
    await writeFile(join(workspace.path, 'scratch/repo/z-server/exports.ts'), 'target')
    const context = { workspace, agentId: 'ace' }
    const result = await tools.glob({ pattern: 'scratch/repo/z-server/**' }, context)
    assert.deepEqual(result.paths, ['scratch/repo/z-server/exports.ts'])
    assert.equal(result.truncated, false)
    const limited = await tools.glob({ pattern: '**/*' }, context)
    assert.equal(limited.paths.length, 500)
    assert.equal(limited.truncated, true)
    assert.equal(limited.limitReason, 'result-limit')
    assert.equal(limited.paths.some(path => path.includes('/.git/')), false)
    const grep = await tools.grep({ pattern: 'not present', path: 'scratch/repo' }, context)
    assert.equal(grep.truncated, true, 'a capped directory scan must not claim complete negative grep results')
  } finally { await rm(workspace.path, { recursive: true, force: true }) }
})

test('scoped discovery respects workspace bounds, excludes metadata and does not follow symlinks', async () => {
  const workspace = await fixture()
  const tools = createHarnessExecutors({ accessProfileFor: () => 'sandbox' })
  const context = { workspace, agentId: 'ace' }
  try {
    await mkdir(join(workspace.path, 'scratch/repo/.git'), { recursive: true })
    await writeFile(join(workspace.path, 'scratch/repo/visible.ts'), 'public source')
    await writeFile(join(workspace.path, 'scratch/repo/.git/private'), 'metadata')
    await writeFile(join(workspace.path, 'private-state.txt'), 'outside readable namespace')
    await symlink('/etc', join(workspace.path, 'scratch/repo/escape'))
    const scoped = await tools.glob({ pattern: '**/*', path: 'scratch/repo' }, context)
    assert.deepEqual(scoped.paths, ['scratch/repo/visible.ts'])
    await symlink(workspace.path, join(workspace.path, 'workspace-alias'))
    const viaAlias = { ...context, workspace: { path: join(workspace.path, 'workspace-alias') } }
    const found = await tools.grep({ pattern: 'public source', path: 'scratch/repo' }, viaAlias)
    assert.deepEqual(found.matches.map(match => match.path), ['scratch/repo/visible.ts'])
    await assert.rejects(tools.glob({ path: 'scratch/repo/escape', pattern: '**' }, context), /WORKER_SYMLINK_ESCAPE_BLOCKED/)
    await assert.rejects(tools.glob({ path: '../../etc', pattern: '**' }, context), /WORKER_PATH_INVALID/)
    assert.equal((await tools.glob({ pattern: '**' }, context)).paths.includes('private-state.txt'), false)
    await assert.rejects(tools.glob({ pattern: 'scratch/{a,{b,c}}/*' }, context), /WORKER_GLOB_UNSUPPORTED_SYNTAX/)
  } finally { await rm(workspace.path, { recursive: true, force: true }) }
})

test('discovery reports its depth ceiling and rejects excessive brace expansion', async () => {
  const workspace = await fixture()
  const tools = createHarnessExecutors({ accessProfileFor: () => 'sandbox' })
  const context = { workspace, agentId: 'ace' }
  try {
    const deep = `scratch/${Array(66).fill('d').join('/')}`
    await mkdir(join(workspace.path, deep), { recursive: true })
    await writeFile(join(workspace.path, deep, 'target.ts'), 'target')
    const result = await tools.glob({ pattern: '**/target.ts' }, context)
    assert.deepEqual(result.paths, [])
    assert.equal(result.truncated, true)
    assert.equal(result.limitReason, 'depth-limit')
    assert.deepEqual((await tools.glob({ pattern: '**/target.ts', path: deep }, context)).paths, [`${deep}/target.ts`])
    await assert.rejects(tools.glob({ pattern: `scratch/${'{a,b}'.repeat(6)}` }, context), /WORKER_GLOB_TOO_COMPLEX/)
  } finally { await rm(workspace.path, { recursive: true, force: true }) }
})

test('discovery stops at the independent scan ceiling even when no paths match', async () => {
  const workspace = await fixture()
  const tools = createHarnessExecutors({ accessProfileFor: () => 'sandbox' })
  try {
    for (let batch = 0; batch < 101; batch++) {
      await Promise.all(Array.from({ length: 100 }, (_, index) => writeFile(join(workspace.path, `scratch/${batch}-${index}.txt`), '')))
    }
    const result = await tools.glob({ pattern: '**/*.ts' }, { workspace, agentId: 'ace' })
    assert.deepEqual(result.paths, [])
    assert.equal(result.truncated, true)
    assert.equal(result.limitReason, 'scan-limit')
    assert.equal(result.scannedEntries, 10_000)
  } finally { await rm(workspace.path, { recursive: true, force: true }) }
})

test('reserved project identity reads cannot trust a forged disk file or run without active task authority', async () => {
  const workspace = await fixture()
  const executors = createHarnessExecutors({ accessProfileFor: () => 'sandbox' })
  const path = 'mounts/project/identity.json'
  try {
    await mkdir(join(workspace.path, 'mounts/project'), { recursive: true })
    await writeFile(join(workspace.path, path), '{"baseCommit":"forged"}')
    await assert.rejects(executors.read({ path }, { workspace, agentId: 'ace' }), /PROJECT_IDENTITY_UNAVAILABLE/)
    let observed = false
    workspace.readProjectIdentity = async () => { observed = true; return { baseCommit: 'runtime' } }
    await assert.rejects(executors.read({ path }, { workspace, agentId: 'ace', taskScoped: true,
      assertActive: () => { throw Object.assign(new Error('revoked'), { code: 'PROJECT_ACCESS_LEASE_INACTIVE' }) },
    }), { code: 'PROJECT_ACCESS_LEASE_INACTIVE' })
    assert.equal(observed, false, 'revoked authority must prevent observation')
    let active = true
    workspace.readProjectIdentity = async () => { active = false; return { baseCommit: 'late result' } }
    await assert.rejects(executors.read({ path }, { workspace, agentId: 'ace', taskScoped: true,
      assertActive: () => active,
    }), { code: 'PROJECT_ACCESS_LEASE_INACTIVE' })
    await assert.rejects(executors.write({ path, content: 'override' }, { workspace, agentId: 'ace' }), /WORKER_WRITE_OUTSIDE_SCRATCH/)
  } finally { await rm(workspace.path, { recursive: true, force: true }) }
})

test('filesystem executors read mounts, write scratch, and reject paths outside the worker workspace', async () => {
  const workspace = await fixture()
  const executors = createHarnessExecutors({ accessProfileFor: () => 'sandbox' })
  try {
    assert.equal((await executors.read({ path: 'mounts/memory/MEMORY.md' }, { workspace, agentId: 'ace' })).content, 'bounded memory')
    await executors.write({ path: 'scratch/result.txt', content: 'safe result' }, { workspace, agentId: 'ace' })
    assert.equal((await executors.read({ path: 'scratch/result.txt' }, { workspace, agentId: 'ace' })).content, 'safe result')
    await assert.rejects(
      executors.write({ path: 'mounts/memory/MEMORY.md', content: 'overwrite' }, { workspace, agentId: 'ace' }),
      /WORKER_WRITE_OUTSIDE_SCRATCH/,
    )
    await assert.rejects(
      executors.read({ path: '../../etc/passwd' }, { workspace, agentId: 'ace' }),
      /WORKER_PATH_INVALID/,
    )
  } finally {
    await rm(workspace.path, { recursive: true, force: true })
  }
})

test('filesystem executors never write task Git metadata', async () => {
  const workspace = await fixture()
  await mkdir(join(workspace.path, 'scratch/repo/.git/hooks'), { recursive: true })
  const executors = createHarnessExecutors({ accessProfileFor: () => 'sandbox' })
  try {
    await assert.rejects(
      executors.write({ path: 'scratch/repo/.git/hooks/pre-commit', content: '#!/bin/sh\n' }, { workspace, agentId: 'ace' }),
      /WORKER_WRITE_PROTECTED/,
    )
  } finally {
    await rm(workspace.path, { recursive: true, force: true })
  }
})

test('public web executor is profile-gated and blocks private or credential-bearing URLs before fetch', async () => {
  const workspace = await fixture()
  let profileId = 'sandbox'
  let fetches = 0
  const executors = createHarnessExecutors({
    accessProfileFor: () => profileId,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchImpl: async () => {
      fetches += 1
      return new Response('public result', { status: 200, headers: { 'content-type': 'text/plain' } })
    },
  })
  try {
    await assert.rejects(executors.web_fetch({ url: 'https://example.com' }, { workspace, agentId: 'ace' }), /TOOL_NOT_ALLOWED_FOR_ACCESS_PROFILE/)
    profileId = 'connected'
    assert.equal((await executors.web_fetch({ url: 'https://example.com' }, { workspace, agentId: 'ace' })).content, 'public result')
    await assert.rejects(executors.web_fetch({ url: 'http://127.0.0.1:3000' }, { workspace, agentId: 'ace' }), /NETWORK_DESTINATION_BLOCKED/)
    await assert.rejects(executors.web_fetch({ url: 'https://user:secret@example.com' }, { workspace, agentId: 'ace' }), /NETWORK_DESTINATION_BLOCKED/)
    assert.equal(fetches, 1)
  } finally {
    await rm(workspace.path, { recursive: true, force: true })
  }
})

test('task execution context narrows the agent ceiling to its leased profile and exact public hosts', async () => {
  const workspace = await fixture()
  let fetches = 0
  const executors = createHarnessExecutors({
    accessProfileFor: () => 'live',
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchImpl: async () => {
      fetches += 1
      return new Response('leased result', { status: 200, headers: { 'content-type': 'text/plain' } })
    },
  })
  const context = {
    workspace,
    agentId: 'ace',
    accessProfileId: 'connected',
    networkHosts: ['docs.example.com'],
  }
  try {
    assert.equal((await executors.web_fetch({ url: 'https://docs.example.com/guide' }, context)).content, 'leased result')
    await assert.rejects(
      executors.web_fetch({ url: 'https://example.com' }, context),
      /NETWORK_HOST_NOT_LEASED/,
    )
    assert.equal(fetches, 1)
  } finally {
    await rm(workspace.path, { recursive: true, force: true })
  }
})

test('public web executor rejects mapped and special-use IPv6 results before fetch', async () => {
  const workspace = await fixture()
  let fetches = 0
  try {
    for (const address of ['::ffff:127.0.0.1', 'ff02::1', 'fec0::1']) {
      const executors = createHarnessExecutors({
        accessProfileFor: () => 'connected',
        lookup: async () => [{ address, family: 6 }],
        fetchImpl: async () => {
          fetches += 1
          return new Response('should not run')
        },
      })
      await assert.rejects(
        executors.web_fetch({ url: 'https://attacker-controlled.example' }, { workspace, agentId: 'ace' }),
        /NETWORK_DESTINATION_BLOCKED/,
      )
    }
    assert.equal(fetches, 0)
  } finally {
    await rm(workspace.path, { recursive: true, force: true })
  }
})

test('shell executor always uses an isolated workspace and keeps subprocess networking brokered', async () => {
  const workspace = await fixture()
  const plans = []
  const executors = createHarnessExecutors({
    accessProfileFor: () => 'live',
    runProcess: async (plan) => {
      plans.push(plan)
      return { exitCode: 0, stdout: `${plan.cwd}\n`, stderr: '' }
    },
  })
  try {
    const result = await executors.bash({ command: 'pwd' }, { workspace, agentId: 'ace' })
    const actualRoot = await realpath(workspace.path)
    assert.equal(result.exitCode, 0, result.stderr)
    assert.equal(plans[0].cwd, join(actualRoot, 'scratch'))
    assert.equal(plans[0].network, 'brokered-public-only')
    assert.equal(plans[0].writableRoot, join(actualRoot, 'scratch'))
    assert.equal(plans[0].readableRoot, actualRoot)
    assert.deepEqual(plans[0].protectedWriteRoots, [])
  } finally {
    await rm(workspace.path, { recursive: true, force: true })
  }
})

test('macOS shell sandbox can write scratch but cannot open a raw network connection', { skip: process.platform !== 'darwin' }, async () => {
  const workspace = await fixture()
  const executors = createHarnessExecutors({ accessProfileFor: () => 'sandbox' })
  try {
    const result = await executors.bash({
      command: 'printf isolated > result.txt; /usr/bin/curl -Is --max-time 1 https://example.com >/dev/null 2>&1; printf "network=%s" "$?"',
    }, { workspace, agentId: 'ace' })
    assert.equal(result.exitCode, 0)
    assert.equal(result.stdout, 'network=1')
    assert.equal(await readFile(join(workspace.path, 'scratch/result.txt'), 'utf8'), 'isolated')
  } finally {
    await rm(workspace.path, { recursive: true, force: true })
  }
})

test('macOS shell timeout terminates the complete sandboxed process group', { skip: process.platform !== 'darwin', timeout: 5_000 }, async () => {
  const workspace = await fixture()
  const executors = createHarnessExecutors({ accessProfileFor: () => 'sandbox' })
  const startedAt = Date.now()
  try {
    await assert.rejects(
      executors.bash({ command: '/bin/sleep 4 & wait', timeoutMs: 1_000 }, { workspace, agentId: 'ace' }),
      /PROCESS_TIMEOUT/,
    )
    assert.ok(Date.now() - startedAt < 3_000)
  } finally {
    await rm(workspace.path, { recursive: true, force: true })
  }
})

test('Linux shell sandbox writes scratch but denies workspace mutation and raw networking', {
  skip: process.platform !== 'linux' || !existsSync('/usr/bin/bwrap'),
}, async () => {
  const workspace = await fixture()
  const executors = createHarnessExecutors({ accessProfileFor: () => 'sandbox' })
  try {
    const result = await executors.bash({
      command: 'printf isolated > result.txt; printf blocked > ../mounts/memory/MEMORY.md 2>/dev/null || true; if /usr/bin/curl -Is --max-time 1 https://example.com >/dev/null 2>&1; then printf network=unexpected; else printf network=blocked; fi',
    }, { workspace, agentId: 'ace' })
    assert.equal(result.exitCode, 0, result.stderr)
    assert.equal(result.stdout, 'network=blocked')
    assert.equal(await readFile(join(workspace.path, 'scratch/result.txt'), 'utf8'), 'isolated')
    assert.equal(await readFile(join(workspace.path, 'mounts/memory/MEMORY.md'), 'utf8'), 'bounded memory')
  } finally {
    await rm(workspace.path, { recursive: true, force: true })
  }
})

test('Linux shell timeout terminates the complete Bubblewrap process group', {
  skip: process.platform !== 'linux' || !existsSync('/usr/bin/bwrap'), timeout: 5_000,
}, async () => {
  const workspace = await fixture()
  const executors = createHarnessExecutors({ accessProfileFor: () => 'sandbox' })
  const startedAt = Date.now()
  try {
    await assert.rejects(
      executors.bash({ command: '/bin/sleep 4 & wait', timeoutMs: 1_000 }, { workspace, agentId: 'ace' }),
      /PROCESS_TIMEOUT/,
    )
    assert.ok(Date.now() - startedAt < 3_000)
  } finally {
    await rm(workspace.path, { recursive: true, force: true })
  }
})
