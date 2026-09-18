import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { userInfo } from 'node:os'
import { RJ_TARGET, RJ_OPERATIONS, normalizeRjAwsSecurity, sanitizeRjAwsResult } from './protocol.mjs'

export const RJ_AWS_CONFIG_PATH = '/etc/chimera/rj-aws/imds-config'
export function rjImdsConfig(region = RJ_TARGET.region) {
  if (typeof region !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(region)) throw new Error('RJ_AWS_CONFIG_INVALID')
  return `[default]\nregion = ${region}\ncredential_source = Ec2InstanceMetadata\n`
}
export const RJ_IMDS_CONFIG = rjImdsConfig()
const baseEnvironment = ({ target, configPath }) => ({ PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C', HOME: userInfo().homedir,
  AWS_CONFIG_FILE: configPath, AWS_SHARED_CREDENTIALS_FILE: '/dev/null', AWS_REGION: target.region,
  AWS_DEFAULT_REGION: target.region, AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true', AWS_EC2_METADATA_SERVICE_ENDPOINT: 'http://169.254.169.254',
  AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE: 'IPv4', AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off', AWS_METADATA_SERVICE_TIMEOUT: '2', AWS_METADATA_SERVICE_NUM_ATTEMPTS: '1' })
const options = env => ({ env, timeout: 20000, maxBuffer: 64 * 1024, encoding: 'utf8', windowsHide: true })

export function createAwsReader({ execFileImpl = promisify(execFile), target = RJ_TARGET, roleArn, assumedRolePrefix, configPath = RJ_AWS_CONFIG_PATH } = {}) {
  let security
  try {
    if (typeof configPath !== 'string' || !configPath.startsWith('/') || configPath.split('/').includes('..')) throw new Error()
    security = normalizeRjAwsSecurity({ target, roleArn, assumedRolePrefix })
  } catch { throw new Error('RJ_AWS_CONFIG_INVALID') }
  return async (operation, { requestId }) => {
    let credentials
    try {
      if (!RJ_OPERATIONS.includes(operation) || typeof requestId !== 'string' || requestId.length > 128) throw new Error()
      const actions = operation === 'rj.aws.identity' ? ['sts:GetCallerIdentity'] : ['sts:GetCallerIdentity', 'ec2:DescribeInstances']
      const policy = { Version: '2012-10-17', Statement: [
        { Effect: 'Allow', Action: actions, Resource: '*' }, { Effect: 'Deny', NotAction: actions, Resource: '*' },
      ] }
      const session = 'chimera-' + createHash('sha256').update(requestId).digest('hex').slice(0, 32)
      const common = ['--region', security.target.region, '--output', 'json', '--no-cli-pager', '--cli-connect-timeout', '5', '--cli-read-timeout', '10']
      const assumed = JSON.parse((await execFileImpl('/usr/local/bin/aws', ['sts', 'assume-role', '--role-arn', security.roleArn,
        '--role-session-name', session, '--duration-seconds', '900', '--policy', JSON.stringify(policy), ...common], options(baseEnvironment({ target: security.target, configPath })))).stdout)
      credentials = assumed.Credentials
      if (!credentials || !['AccessKeyId', 'SecretAccessKey', 'SessionToken'].every(k => typeof credentials[k] === 'string' && credentials[k].length > 0 && credentials[k].length < 16384) ||
        !Number.isFinite(Date.parse(credentials.Expiration)) || !assumed.AssumedRoleUser?.Arn?.startsWith(security.assumedRolePrefix)) throw new Error()
      const env = { ...baseEnvironment({ target: security.target, configPath }), AWS_CONFIG_FILE: '/dev/null', AWS_EC2_METADATA_DISABLED: 'true',
        AWS_ACCESS_KEY_ID: credentials.AccessKeyId, AWS_SECRET_ACCESS_KEY: credentials.SecretAccessKey, AWS_SESSION_TOKEN: credentials.SessionToken }
      const call = async args => JSON.parse((await execFileImpl('/usr/local/bin/aws', [...args, ...common], options(env))).stdout)
      try {
        const who = await call(['sts', 'get-caller-identity'])
        const checked = sanitizeRjAwsResult('rj.aws.identity', { account: who.Account, arn: who.Arn, userId: who.UserId }, security)
        if (operation === 'rj.aws.identity') return checked
        const response = await call(['ec2', 'describe-instances', '--instance-ids', security.target.instanceId])
        if (response.Reservations?.length !== 1 || response.Reservations[0].OwnerId !== security.target.account || response.Reservations[0].Instances?.length !== 1) throw new Error()
        const instance = response.Reservations[0].Instances[0]
        return sanitizeRjAwsResult(operation, { ...security.target, instanceId: instance.InstanceId, state: instance.State?.Name }, security)
      } finally { delete env.AWS_ACCESS_KEY_ID; delete env.AWS_SECRET_ACCESS_KEY; delete env.AWS_SESSION_TOKEN }
    } catch { throw new Error('RJ_AWS_UNAVAILABLE') }
    finally { credentials = undefined }
  }
}
