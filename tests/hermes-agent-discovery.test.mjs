import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createRjAwsRequest } from '../src/rj-aws/protocol.mjs'
import { generateIdentity } from '../src/identity.mjs'
import {
  createHermesAgentDiscoveryFromEnv,
  HermesSsmAgentDiscovery,
  parseHermesProfileInventory,
  resolveHermesDiscoveryTarget,
} from '../src/agents/hermes-discovery.mjs'

const SRC_ROOT = fileURLToPath(new URL('../src', import.meta.url))
const DEFAULT_INSTANCE_SENTINEL = 'i-0bbbbbbbbbbbbbbbb'
const DEFAULT_BUCKET_SENTINEL = 'example-hermes-vault'
const SYNTHETIC_INSTANCE_ID = 'i-0aaaaaaaaaaaaaaaa'
const DEFAULT_ASSIGNMENT = new RegExp(
  String.raw`(?:\?\?|\|\|)\s*['"\`](?:${DEFAULT_INSTANCE_SENTINEL}|${DEFAULT_BUCKET_SENTINEL})['"\`]`,
)

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await sourceFiles(path))
    else if (['.mjs', '.js'].includes(extname(entry.name))) files.push(path)
  }
  return files
}

test('Hermes inventory exposes only safe profile identifiers and import references', () => {
  const candidates = parseHermesProfileInventory('ace\ngenie\npaul-blart\nace\n../escape\n.hidden\n', {
    sourceId: 'hermes-aws',
    host: 'configured-hermes',
  })

  assert.deepEqual(candidates.map((candidate) => candidate.profileId), ['ace', 'genie', 'paul-blart'])
  assert.deepEqual(candidates[0], {
    schema: 'chimera.hermes-agent-candidate.v1',
    candidateId: 'hermes-aws:ace',
    profileId: 'ace',
    displayName: 'Ace',
    sourceRef: 'hermes://configured-hermes/profiles/ace',
    defaultRole: 'General specialist',
    defaultCapabilities: ['general'],
  })
})

test('SSM discovery runs a fixed read-only listing and returns a preview', async () => {
  const requests = []
  const discovery = new HermesSsmAgentDiscovery({
    sourceId: 'hermes-aws',
    host: 'configured-hermes',
    instanceId: SYNTHETIC_INSTANCE_ID,
    region: 'us-west-2',
    send: async (request) => {
      requests.push(request)
      if (request.kind === 'send-command') return { commandId: 'command-1' }
      return { status: 'Success', standardOutput: 'ace\ngenie\n', standardError: '' }
    },
    sleep: async () => {},
  })

  const preview = await discovery.discover()
  assert.equal(preview.schema, 'chimera.agent-discovery.v1')
  assert.equal(preview.source.type, 'hermes-ssm')
  assert.deepEqual(preview.candidates.map((candidate) => candidate.profileId), ['ace', 'genie'])
  assert.equal(requests[0].kind, 'send-command')
  assert.equal(requests[0].instanceId, SYNTHETIC_INSTANCE_ID)
  assert.equal(requests[0].commands.length, 1)
  assert.match(requests[0].commands[0], /^\/usr\/bin\/find \/var\/lib\/chimera\/hermes\/profiles /)
  assert.equal(requests[0].commands[0].includes('cat '), false)
  assert.equal(requests[0].commands[0].includes('config.yaml'), false)
})

test('SSM discovery normalizes provider failures instead of exposing AWS diagnostics', async () => {
  const discovery = new HermesSsmAgentDiscovery({
    sourceId: 'hermes-aws',
    host: 'configured-hermes',
    instanceId: SYNTHETIC_INSTANCE_ID,
    region: 'us-west-2',
    send: async () => { throw new Error('User arn:aws:iam::123456789012:user/example is denied') },
    sleep: async () => {},
  })

  await assert.rejects(discovery.discover(), (error) => {
    assert.equal(error.code, 'HERMES_DISCOVERY_FAILED')
    assert.equal(error.message, 'HERMES_DISCOVERY_FAILED')
    return true
  })
})

test('Hermes discovery fails closed when the instance id env is unset', async () => {
  assert.equal(resolveHermesDiscoveryTarget({}), null)
  assert.equal(resolveHermesDiscoveryTarget({ CHIMERA_HERMES_INSTANCE_ID: '  ' }), null)
  const discovery = createHermesAgentDiscoveryFromEnv({})
  await assert.rejects(discovery.discover(), (error) => {
    assert.equal(error.code, 'HERMES_DISCOVERY_NOT_CONFIGURED')
    assert.equal(error.message, 'HERMES_DISCOVERY_NOT_CONFIGURED')
    return true
  })
})

test('Hermes discovery uses an explicit env instance id and never a live default', async () => {
  const env = {
    CHIMERA_HERMES_INSTANCE_ID: SYNTHETIC_INSTANCE_ID,
    CHIMERA_HERMES_HOST: 'hermes-staging',
    CHIMERA_AWS_REGION: 'us-west-2',
  }
  const target = resolveHermesDiscoveryTarget(env)
  assert.equal(target.instanceId, SYNTHETIC_INSTANCE_ID)
  assert.notEqual(target.instanceId, DEFAULT_INSTANCE_SENTINEL)
  assert.equal(target.host, 'hermes-staging')

  const requests = []
  const discovery = new HermesSsmAgentDiscovery({
    ...target,
    send: async (request) => {
      requests.push(request)
      if (request.kind === 'send-command') return { commandId: 'command-1' }
      return { status: 'Success', standardOutput: 'ace\n', standardError: '' }
    },
    sleep: async () => {},
  })
  await discovery.discover()
  assert.equal(requests[0].instanceId, SYNTHETIC_INSTANCE_ID)
})

test('Hermes profile roots reject shell metacharacters before SSM command construction', () => {
  for (const profileRoot of ['/tmp/hermes profiles', '/tmp/hermes;id', '/tmp/hermes/$(id)', '/tmp/hermes\nid']) {
    assert.throws(() => resolveHermesDiscoveryTarget({
      CHIMERA_HERMES_INSTANCE_ID: SYNTHETIC_INSTANCE_ID,
      CHIMERA_HERMES_PROFILE_ROOT: profileRoot,
    }), /HERMES_DISCOVERY_CONFIG_INVALID/)
  }
})

test('runtime source does not default Hermes discovery to the live Team RSI host or vault', async () => {
  const runtimeSource = await readFile(new URL('../src/browser/runtime.mjs', import.meta.url), 'utf8')
  assert.equal(runtimeSource.includes(DEFAULT_INSTANCE_SENTINEL), false)
  assert.equal(runtimeSource.includes(DEFAULT_BUCKET_SENTINEL), false)
  assert.match(runtimeSource, /Never fall back to a live host/)
  assert.match(runtimeSource, /Never fall back to a production vault bucket/)

  for (const file of await sourceFiles(SRC_ROOT)) {
    const source = await readFile(file, 'utf8')
    // The separately authorized signed read-only bridge has one fixed target, not a discovery default.
    if (file !== join(SRC_ROOT, 'rj-aws', 'protocol.mjs')) {
      assert.equal(source.includes(DEFAULT_INSTANCE_SENTINEL), false, `${file} must not embed the disallowed instance id`)
    }
    assert.equal(source.includes(DEFAULT_BUCKET_SENTINEL), false, `${file} must not embed the disallowed vault bucket`)
    assert.equal(DEFAULT_ASSIGNMENT.test(source), false, `${file} must not default to the live Hermes instance or vault`)
  }
})

test('signed RJ bridge target cannot silently configure Hermes discovery', async () => {
  const request = createRjAwsRequest({ operation: 'rj.aws.instance_status', taskId: 'fixed-read',
    agentIdentity: generateIdentity('rj'), humanIdentity: generateIdentity('operator'), now: Date.now() })
  assert.deepEqual(request.target, { account: '000000000000', region: 'example-region-1', instanceId: 'i-example00000000000' })
  assert.equal(resolveHermesDiscoveryTarget({}), null)
  await assert.rejects(createHermesAgentDiscoveryFromEnv({}).discover(), { code: 'HERMES_DISCOVERY_NOT_CONFIGURED' })
})
