import { spawn } from 'node:child_process'

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/
const BRANCH = /^(?!\/)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,255}(?<!\/)$/
const SHA = /^[a-f0-9]{40}$/

function coded(code) {
  return Object.assign(new Error(code), { code })
}

function bounded(value, maximum = 16_384) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= maximum
}

function parseJson(stdout) {
  try {
    const parsed = JSON.parse(stdout)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError()
    return parsed
  } catch {
    throw coded('GITHUB_RESPONSE_INVALID')
  }
}

function publicPull(value) {
  return {
    number: value.number,
    url: value.html_url,
    state: value.state,
    ...(bounded(value.title, 4096) ? { title: value.title } : {}),
    ...(SHA.test(value.head?.sha ?? '') ? { headSha: value.head.sha } : {}),
  }
}

function safeEnvironment(env = process.env) {
  const selected = ['HOME', 'PATH', 'XDG_CONFIG_HOME', 'LANG', 'LC_ALL', 'TMPDIR']
  return Object.fromEntries(selected.filter((key) => typeof env[key] === 'string').map((key) => [key, env[key]]))
}

export function runGitHubCli(args, { input = '', timeoutMs = 120_000, spawnImpl = spawn, env = process.env } = {}) {
  if (!Array.isArray(args) || args.length === 0 || args.some((value) => !bounded(value, 8192))
    || typeof input !== 'string' || Buffer.byteLength(input, 'utf8') > 256_000
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 10 * 60_000) {
    throw new TypeError('GITHUB_CLI_REQUEST_INVALID')
  }
  return new Promise((resolve, reject) => {
    const child = spawnImpl('gh', args, {
      env: safeEnvironment(env),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdout = []
    let outputBytes = 0
    let failure = null
    const collect = (destination) => (chunk) => {
      outputBytes += chunk.length
      if (outputBytes > MAX_OUTPUT_BYTES) {
        failure = coded('GITHUB_CLI_OUTPUT_TOO_LARGE')
        child.kill('SIGKILL')
      } else destination.push(chunk)
    }
    child.stdout.on('data', collect(stdout))
    child.stderr.on('data', collect([]))
    const timer = setTimeout(() => {
      failure = coded('GITHUB_CLI_TIMEOUT')
      child.kill('SIGKILL')
    }, timeoutMs)
    child.once('error', () => {
      clearTimeout(timer)
      reject(coded('GITHUB_CLI_UNAVAILABLE'))
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (failure) return reject(failure)
      if (code !== 0) return reject(coded('GITHUB_CLI_FAILED'))
      resolve({ stdout: Buffer.concat(stdout).toString('utf8') })
    })
    child.stdin.end(input)
  })
}

export function resolveGitHubRepositories(env = process.env) {
  const raw = env.CHIMERA_GITHUB_REPOSITORIES
  if (typeof raw !== 'string' || raw.trim().length === 0) return []
  const repositories = [...new Set(raw.split(',').map((value) => value.trim()).filter(Boolean))]
  if (repositories.length > 32 || repositories.some((value) => !REPOSITORY.test(value))) {
    throw new TypeError('GITHUB_REPOSITORY_ALLOWLIST_INVALID')
  }
  return repositories.sort()
}

export class GitHubCliProvider {
  constructor({ runner = runGitHubCli, repositories = [] } = {}) {
    if (typeof runner !== 'function' || !Array.isArray(repositories)
      || repositories.length === 0 || repositories.length > 32
      || repositories.some((value) => !REPOSITORY.test(value))) {
      throw new TypeError('GITHUB_PROVIDER_CONFIG_INVALID')
    }
    this.runner = runner
    this.repositories = Object.freeze([...new Set(repositories)].sort())
    this.lastState = Object.freeze({
      schema: 'chimera.github-connector.v1', connected: false, authentication: 'oauth-keychain', repositories: [...this.repositories],
    })
  }

  state() {
    return structuredClone(this.lastState)
  }

  async refreshState() {
    try {
      const response = parseJson((await this.runner(['api', 'user', '--jq', '{"login":.login}'])).stdout)
      if (!bounded(response.login, 128)) throw coded('GITHUB_AUTH_STATE_INVALID')
      this.lastState = Object.freeze({
        schema: 'chimera.github-connector.v1', connected: true, login: response.login,
        authentication: 'oauth-keychain', repositories: [...this.repositories],
      })
    } catch {
      this.lastState = Object.freeze({
        schema: 'chimera.github-connector.v1', connected: false,
        authentication: 'oauth-keychain', repositories: [...this.repositories],
      })
    }
    return this.state()
  }

  async beginLogin() {
    await this.runner(['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--scopes', 'repo,workflow'], { timeoutMs: 10 * 60_000 })
    return this.refreshState()
  }

  #repository(value) {
    if (!REPOSITORY.test(value ?? '')) throw coded('GITHUB_REPOSITORY_INVALID')
    if (!this.repositories.includes(value)) throw coded('GITHUB_REPOSITORY_NOT_ALLOWED')
    return value
  }

  async #jsonRequest(method, endpoint, body) {
    const response = await this.runner(['api', '--method', method, endpoint, '--input', '-'], { input: JSON.stringify(body) })
    return parseJson(response.stdout)
  }

  async createPullRequest({ repository, title, head, base, body = '' } = {}) {
    const repo = this.#repository(repository)
    if (!bounded(title, 256) || !BRANCH.test(head ?? '') || !BRANCH.test(base ?? '')
      || typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > 64 * 1024) throw coded('GITHUB_PULL_REQUEST_INVALID')
    return publicPull(await this.#jsonRequest('POST', `repos/${repo}/pulls`, { title, head, base, body }))
  }

  async updatePullRequest({ repository, number, title, body, state } = {}) {
    const repo = this.#repository(repository)
    if (!Number.isSafeInteger(number) || number < 1
      || (title !== undefined && !bounded(title, 256))
      || (body !== undefined && (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > 64 * 1024))
      || (state !== undefined && !['open', 'closed'].includes(state))
      || (title === undefined && body === undefined && state === undefined)) throw coded('GITHUB_PULL_REQUEST_UPDATE_INVALID')
    return publicPull(await this.#jsonRequest('PATCH', `repos/${repo}/pulls/${number}`, {
      ...(title !== undefined ? { title } : {}), ...(body !== undefined ? { body } : {}), ...(state !== undefined ? { state } : {}),
    }))
  }

  async commentPullRequest({ repository, number, body } = {}) {
    const repo = this.#repository(repository)
    if (!Number.isSafeInteger(number) || number < 1 || !bounded(body, 64 * 1024)) throw coded('GITHUB_PULL_REQUEST_COMMENT_INVALID')
    const value = await this.#jsonRequest('POST', `repos/${repo}/issues/${number}/comments`, { body })
    if (!Number.isSafeInteger(value.id) || !bounded(value.html_url, 4096)) throw coded('GITHUB_RESPONSE_INVALID')
    return { id: value.id, url: value.html_url }
  }

  async checkPullRequest({ repository, ref } = {}) {
    const repo = this.#repository(repository)
    if (!SHA.test(ref ?? '') && !BRANCH.test(ref ?? '')) throw coded('GITHUB_REF_INVALID')
    const response = await this.runner(['api', `repos/${repo}/commits/${encodeURIComponent(ref)}/check-runs`])
    const value = parseJson(response.stdout)
    if (!Array.isArray(value.check_runs)) throw coded('GITHUB_RESPONSE_INVALID')
    return {
      total: Number.isSafeInteger(value.total_count) ? value.total_count : value.check_runs.length,
      checks: value.check_runs.slice(0, 100).map((check) => ({
        name: bounded(check.name, 512) ? check.name : 'Unnamed check',
        status: bounded(check.status, 64) ? check.status : 'unknown',
        conclusion: bounded(check.conclusion, 64) ? check.conclusion : null,
        url: bounded(check.html_url, 4096) ? check.html_url : null,
      })),
    }
  }

  async mergePullRequest({ repository, number, expectedHeadSha, method = 'squash' } = {}) {
    const repo = this.#repository(repository)
    if (!Number.isSafeInteger(number) || number < 1) throw coded('GITHUB_PULL_REQUEST_INVALID')
    if (!SHA.test(expectedHeadSha ?? '')) throw coded('GITHUB_HEAD_SHA_INVALID')
    if (!['merge', 'squash', 'rebase'].includes(method)) throw coded('GITHUB_MERGE_METHOD_INVALID')
    const value = await this.#jsonRequest('PUT', `repos/${repo}/pulls/${number}/merge`, { sha: expectedHeadSha, merge_method: method })
    return {
      merged: value.merged === true,
      message: bounded(value.message, 4096) ? value.message : 'GitHub did not return a merge message.',
      ...(SHA.test(value.sha ?? '') ? { sha: value.sha } : {}),
    }
  }
}

export function createGitHubToolExecutors({ provider } = {}) {
  if (!(provider instanceof GitHubCliProvider)) throw new TypeError('GITHUB_TOOL_PROVIDER_REQUIRED')
  return Object.freeze({
    mcp__chimera_github__pr_create: (args) => provider.createPullRequest(args),
    mcp__chimera_github__pr_update: (args) => provider.updatePullRequest(args),
    mcp__chimera_github__pr_comment: (args) => provider.commentPullRequest(args),
    mcp__chimera_github__pr_checks: (args) => provider.checkPullRequest(args),
    mcp__chimera_github__pr_merge: (args) => provider.mergePullRequest(args),
  })
}
