const PROFILE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const TERMINAL = new Set(['Success', 'Failed', 'Cancelled', 'TimedOut'])
const DEFAULT_PROFILE_ROOT = '/var/lib/chimera/hermes/profiles'

function profileRoot(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096
    && value.startsWith('/') && /^\/[A-Za-z0-9._/-]+$/.test(value)
    && !value.split('/').includes('..')
}

function profileListCommand(root) {
  // The root is validated above and contains only literal path characters, so
  // this command remains a fixed read-only inventory.
  return `/usr/bin/find ${root} -mindepth 1 -maxdepth 1 -type d -printf '%f\\n' | /usr/bin/sort`
}

function boundedString(value, maximum = 256) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function displayName(profileId) {
  return profileId.split('-').map((word) => `${word[0].toUpperCase()}${word.slice(1)}`).join(' ')
}

export function parseHermesProfileInventory(output, { sourceId, host }) {
  if (typeof output !== 'string' || Buffer.byteLength(output, 'utf8') > 64 * 1024
    || !boundedString(sourceId, 64) || !boundedString(host, 128)) {
    throw new TypeError('HERMES_PROFILE_INVENTORY_INVALID')
  }
  const profileIds = [...new Set(output.split(/\r?\n/).map((line) => line.trim()).filter((line) => PROFILE_ID.test(line)))].sort()
  if (profileIds.length > 128) throw new TypeError('HERMES_PROFILE_INVENTORY_INVALID')
  return profileIds.map((profileId) => Object.freeze({
    schema: 'chimera.hermes-agent-candidate.v1',
    candidateId: `${sourceId}:${profileId}`,
    profileId,
    displayName: displayName(profileId),
    sourceRef: `hermes://${host}/profiles/${profileId}`,
    defaultRole: 'General specialist',
    defaultCapabilities: ['general'],
  }))
}

async function defaultSend(request) {
  const { GetCommandInvocationCommand, SendCommandCommand, SSMClient } = await import('@aws-sdk/client-ssm')
  const client = new SSMClient({ region: request.region })
  try {
    if (request.kind === 'send-command') {
      const result = await client.send(new SendCommandCommand({
        InstanceIds: [request.instanceId],
        DocumentName: 'AWS-RunShellScript',
        Comment: 'Chimera read-only Hermes profile discovery',
        Parameters: { commands: request.commands },
        TimeoutSeconds: 30,
      }))
      return { commandId: result.Command?.CommandId }
    }
    const result = await client.send(new GetCommandInvocationCommand({
      CommandId: request.commandId,
      InstanceId: request.instanceId,
    }))
    return {
      status: result.Status,
      standardOutput: result.StandardOutputContent ?? '',
      standardError: result.StandardErrorContent ?? '',
    }
  } finally {
    client.destroy()
  }
}

function codedError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function discoveryFailure() {
  return codedError('HERMES_DISCOVERY_FAILED')
}

export function hermesDiscoveryNotConfigured() {
  return codedError('HERMES_DISCOVERY_NOT_CONFIGURED')
}

export function resolveHermesDiscoveryTarget(env = process.env) {
  const instanceId = typeof env.CHIMERA_HERMES_INSTANCE_ID === 'string'
    ? env.CHIMERA_HERMES_INSTANCE_ID.trim()
    : ''
  if (!instanceId) return null
  const host = typeof env.CHIMERA_HERMES_HOST === 'string' && env.CHIMERA_HERMES_HOST.trim()
    ? env.CHIMERA_HERMES_HOST.trim()
    : 'configured-hermes'
  const sourceId = typeof env.CHIMERA_HERMES_SOURCE_ID === 'string' && env.CHIMERA_HERMES_SOURCE_ID.trim()
    ? env.CHIMERA_HERMES_SOURCE_ID.trim()
    : 'hermes-aws'
  const region = typeof env.CHIMERA_AWS_REGION === 'string' && env.CHIMERA_AWS_REGION.trim()
    ? env.CHIMERA_AWS_REGION.trim()
    : 'us-west-2'
  const profileRootValue = typeof env.CHIMERA_HERMES_PROFILE_ROOT === 'string' && env.CHIMERA_HERMES_PROFILE_ROOT.trim()
    ? env.CHIMERA_HERMES_PROFILE_ROOT.trim()
    : DEFAULT_PROFILE_ROOT
  if (!profileRoot(profileRootValue)) throw new TypeError('HERMES_DISCOVERY_CONFIG_INVALID')
  return { sourceId, host, instanceId, region, profileRoot: profileRootValue }
}

export class UnconfiguredHermesDiscovery {
  async discover() {
    throw hermesDiscoveryNotConfigured()
  }
}

export function createHermesAgentDiscoveryFromEnv(env = process.env) {
  return new EnvHermesAgentDiscovery(env)
}

class EnvHermesAgentDiscovery {
  constructor(env = process.env) {
    this.env = env
  }

  async discover() {
    const target = resolveHermesDiscoveryTarget(this.env)
    if (!target) throw hermesDiscoveryNotConfigured()
    return new HermesSsmAgentDiscovery(target).discover()
  }
}

export class HermesSsmAgentDiscovery {
  constructor({
    sourceId,
    host,
    instanceId,
    region,
    profileRoot: root = DEFAULT_PROFILE_ROOT,
    send = defaultSend,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  }) {
    if (!boundedString(sourceId, 64)
      || !boundedString(host, 128)
      || !/^i-[a-f0-9]{8,32}$/.test(instanceId)
      || !/^[a-z]{2}-[a-z]+-\d$/.test(region)
      || !profileRoot(root)
      || typeof send !== 'function'
      || typeof sleep !== 'function') {
      throw new TypeError('HERMES_DISCOVERY_CONFIG_INVALID')
    }
    this.sourceId = sourceId
    this.host = host
    this.instanceId = instanceId
    this.region = region
    this.profileRoot = root
    this.send = send
    this.sleep = sleep
  }

  async discover() {
    try {
      const started = await this.send({
        kind: 'send-command',
        region: this.region,
        instanceId: this.instanceId,
        commands: [profileListCommand(this.profileRoot)],
      })
      if (!boundedString(started?.commandId, 128)) throw discoveryFailure()
      let invocation
      for (let attempt = 0; attempt < 15; attempt += 1) {
        try {
          invocation = await this.send({
            kind: 'get-command-invocation',
            region: this.region,
            instanceId: this.instanceId,
            commandId: started.commandId,
          })
        } catch (error) {
          if (error?.name !== 'InvocationDoesNotExist') throw error
          invocation = null
        }
        if (TERMINAL.has(invocation?.status)) break
        await this.sleep(500)
      }
      if (invocation?.status !== 'Success') throw discoveryFailure()
      return {
        schema: 'chimera.agent-discovery.v1',
        source: {
          id: this.sourceId,
          type: 'hermes-ssm',
          host: this.host,
          instanceId: this.instanceId,
          region: this.region,
        },
        candidates: parseHermesProfileInventory(invocation.standardOutput ?? '', {
          sourceId: this.sourceId,
          host: this.host,
        }),
      }
    } catch (error) {
      if (error?.code === 'HERMES_DISCOVERY_FAILED') throw error
      throw discoveryFailure()
    }
  }
}
