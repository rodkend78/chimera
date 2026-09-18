import assert from 'node:assert/strict'
import test from 'node:test'
import { GitHubCliProvider, createGitHubToolExecutors } from '../src/github/cli-provider.mjs'

function fixture() {
  const calls = []
  const runner = async (args, options = {}) => {
    calls.push({ args, options })
    const endpoint = args.find((value) => value.startsWith('repos/')) ?? ''
    if (args[0] === 'api' && args[1] === 'user') return { stdout: '{"login":"example-operator"}\n' }
    if (endpoint.endsWith('/pulls') && args.includes('POST')) return { stdout: '{"number":8,"html_url":"https://github.com/example-org/example-repo/pull/8","state":"open","head":{"sha":"a"}}' }
    if (endpoint.includes('/issues/') && endpoint.endsWith('/comments')) return { stdout: '{"id":22,"html_url":"https://github.com/comment/22"}' }
    if (endpoint.endsWith('/check-runs')) return { stdout: '{"total_count":1,"check_runs":[{"name":"CI","status":"completed","conclusion":"success","html_url":"https://github.com/check/1"}]}' }
    if (endpoint.endsWith('/merge')) return { stdout: '{"merged":true,"message":"Pull Request successfully merged","sha":"b"}' }
    return { stdout: '{"number":8,"html_url":"https://github.com/example-org/example-repo/pull/8","state":"open","title":"Updated"}' }
  }
  return {
    calls,
    provider: new GitHubCliProvider({ runner, repositories: ['example-org/example-repo'] }),
  }
}

test('GitHub provider uses the server OAuth keychain and never returns a token', async () => {
  const { provider, calls } = fixture()
  const state = await provider.refreshState()
  assert.deepEqual(state, {
    schema: 'chimera.github-connector.v1',
    connected: true,
    login: 'example-operator',
    authentication: 'oauth-keychain',
    repositories: ['example-org/example-repo'],
  })
  assert.deepEqual(calls[0].args, ['api', 'user', '--jq', '{"login":.login}'])
  assert.doesNotMatch(JSON.stringify(state), /token|gho_/i)
})

test('GitHub provider exposes only bounded allowlisted PR lifecycle operations', async () => {
  const { provider, calls } = fixture()
  const created = await provider.createPullRequest({
    repository: 'example-org/example-repo', title: 'Gate 2', head: 'codex/gate2', base: 'main', body: 'Evidence.',
  })
  const updated = await provider.updatePullRequest({ repository: 'example-org/example-repo', number: 8, title: 'Gate 2 ready' })
  const commented = await provider.commentPullRequest({ repository: 'example-org/example-repo', number: 8, body: 'Verified.' })
  const checks = await provider.checkPullRequest({ repository: 'example-org/example-repo', ref: 'a'.repeat(40) })
  const merged = await provider.mergePullRequest({ repository: 'example-org/example-repo', number: 8, expectedHeadSha: 'a'.repeat(40), method: 'squash' })

  assert.equal(created.number, 8)
  assert.equal(updated.title, 'Updated')
  assert.equal(commented.id, 22)
  assert.equal(checks.checks[0].conclusion, 'success')
  assert.equal(merged.merged, true)
  assert.equal(calls.filter(({ options }) => options.input).length, 4)
  assert.ok(calls.every(({ args }) => args[0] === 'api'))
  await assert.rejects(() => provider.createPullRequest({ repository: 'evil/repo', title: 'x', head: 'x', base: 'main' }), /GITHUB_REPOSITORY_NOT_ALLOWED/)
  await assert.rejects(() => provider.mergePullRequest({ repository: 'example-org/example-repo', number: 8, expectedHeadSha: 'not-a-sha' }), /GITHUB_HEAD_SHA_INVALID/)
})

test('GitHub tool executors preserve the DSH-facing operation boundary', async () => {
  const { provider } = fixture()
  const tools = createGitHubToolExecutors({ provider })
  assert.deepEqual(Object.keys(tools).sort(), [
    'mcp__chimera_github__pr_checks',
    'mcp__chimera_github__pr_comment',
    'mcp__chimera_github__pr_create',
    'mcp__chimera_github__pr_merge',
    'mcp__chimera_github__pr_update',
  ])
  const result = await tools.mcp__chimera_github__pr_checks({ repository: 'example-org/example-repo', ref: 'a'.repeat(40) })
  assert.equal(result.checks[0].name, 'CI')
})
