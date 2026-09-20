import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluatePilotReadiness } from '../src/pilot/readiness.mjs'

test('missing POSIX filesystem broker blocks readiness', () => {
  const result = evaluatePilotReadiness({ nodeVersion: '22.19.0', host: '127.0.0.1', chromiumAvailable: true,
    filesystemBrokerAvailable: false, envFile: { exists: false },
    modelAccess: { codex: { available: true }, bedrock: { configured: false } },
  })
  assert.equal(result.ready, false)
  assert.equal(result.checks.find(check => check.id === 'filesystem-broker').status, 'blocked')
})

test('pilot readiness passes with an authenticated Codex subscription', () => {
  const result = evaluatePilotReadiness({
    nodeVersion: '22.19.0',
    host: '127.0.0.1',
    chromiumAvailable: true,
    filesystemBrokerAvailable: true,
    envFile: { exists: true, mode: 0o600 },
    modelAccess: {
      codex: { available: true, configured: true, authentication: 'chatgpt-subscription' },
      bedrock: { configured: false, region: 'us-west-2' },
    },
  })

  assert.equal(result.ready, true)
  assert.equal(result.checks.every((check) => check.status !== 'blocked'), true)
  assert.deepEqual(result.configuredProviders, ['codex'])
  assert.equal(JSON.stringify(result).includes('access_token'), false)
})

test('pilot readiness returns actionable blockers without exposing credentials', () => {
  const result = evaluatePilotReadiness({
    nodeVersion: '20.18.0',
    host: '0.0.0.0',
    chromiumAvailable: false,
    filesystemBrokerAvailable: true,
    envFile: { exists: true, mode: 0o644 },
    modelAccess: {
      codex: { available: false, configured: false, authentication: null },
      bedrock: { configured: false, region: 'us-west-2' },
    },
  })

  assert.equal(result.ready, false)
  assert.deepEqual(
    result.checks.filter((check) => check.status === 'blocked').map((check) => check.id),
    ['node', 'bind', 'chromium', 'env-permissions', 'model-provider'],
  )
  assert.match(result.checks.find((check) => check.id === 'model-provider').remediation, /Install the Codex CLI/)
})

test('AWS Bedrock identity alone does not satisfy CEO orchestration readiness', () => {
  const result = evaluatePilotReadiness({
    nodeVersion: '24.1.0',
    host: 'localhost',
    chromiumAvailable: true,
    filesystemBrokerAvailable: true,
    envFile: { exists: false },
    modelAccess: {
      codex: { available: false, configured: false, authentication: null },
      bedrock: { configured: true, region: 'us-west-2' },
    },
  })

  assert.equal(result.ready, false)
  assert.equal(result.checks.find((check) => check.id === 'env-permissions').status, 'passed')
  assert.deepEqual(result.configuredProviders, ['aws-bedrock'])
  assert.equal(result.checks.find((check) => check.id === 'model-provider').status, 'blocked')
})

test('pilot readiness starts with an installed signed-out Codex CLI so the UI can connect it', () => {
  const result = evaluatePilotReadiness({
    nodeVersion: '22.19.0',
    host: '127.0.0.1',
    chromiumAvailable: true,
    filesystemBrokerAvailable: true,
    envFile: { exists: false },
    modelAccess: {
      codex: { available: true, configured: false, authentication: null },
      bedrock: { configured: false, region: 'us-west-2' },
    },
  })

  assert.equal(result.ready, true)
  assert.equal(result.checks.find((check) => check.id === 'model-provider').status, 'passed')
  assert.match(result.checks.find((check) => check.id === 'model-provider').message, /Connect ChatGPT/)
  assert.deepEqual(result.configuredProviders, [])
})
