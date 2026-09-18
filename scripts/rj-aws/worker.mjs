#!/usr/bin/env node
import { createPrivateKey, createPublicKey } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { RjAwsWorker, checkPath, readOwnerFile } from '../../src/rj-aws/worker.mjs'
import { createAwsReader, rjImdsConfig } from '../../src/rj-aws/aws-reader.mjs'
import { exactFields, normalizeRjAwsSecurity, RJ_REQUEST_LIMIT, RJ_RECEIPT_LIMIT } from '../../src/rj-aws/protocol.mjs'
import { signAction } from '../../src/identity.mjs'

const CONFIG_DIR = '/etc/chimera/rj-aws'
const CONFIG_PATH = CONFIG_DIR + '/config.json'
const STATE_DIR = '/var/lib/chimera/rj-aws'

export async function readRequestLine(stream) {
  let size = 0
  const chunks = []
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > RJ_REQUEST_LIMIT) throw new Error('RJ_REQUEST_INVALID')
    chunks.push(bytes)
  }
  const line = Buffer.concat(chunks).toString('utf8')
  if (!line.endsWith('\n') || line.slice(0, -1).includes('\n')) throw new Error('RJ_REQUEST_INVALID')
  try { return JSON.parse(line) } catch { throw new Error('RJ_REQUEST_INVALID') }
}

async function main() {
  let worker, identity
  const timeout = setTimeout(() => { process.stdin.destroy(); }, 10000)
  try {
    if (process.platform !== 'linux' || process.argv.length !== 2) throw new Error('RJ_WORKER_UNAVAILABLE')
    await checkPath(CONFIG_DIR, { directory: true })
    const config = JSON.parse(await readOwnerFile(CONFIG_PATH, 32 * 1024))
    if (!exactFields(config, ['assumedRolePrefix', 'awsConfigPath', 'humanKeys', 'privateKey', 'roleArn', 'schema', 'target']) || config.schema !== 'chimera.rj-aws.worker-config.v1' ||
      !Array.isArray(config.humanKeys) || config.humanKeys.length < 1 || config.humanKeys.length > 32 ||
      !config.humanKeys.every(pair => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' && typeof pair[1] === 'string') ||
      new Set(config.humanKeys.map(p => p[0])).size !== config.humanKeys.length) throw new Error('RJ_WORKER_UNAVAILABLE')
    const security = normalizeRjAwsSecurity({ target: config.target, roleArn: config.roleArn, assumedRolePrefix: config.assumedRolePrefix })
    if (typeof config.awsConfigPath !== 'string' || !config.awsConfigPath.startsWith('/') || config.awsConfigPath.split('/').includes('..')) throw new Error('RJ_WORKER_UNAVAILABLE')
    for (const [, key] of config.humanKeys) if (createPublicKey(key).asymmetricKeyType !== 'ed25519') throw new Error('RJ_WORKER_UNAVAILABLE')
    const privateKey = createPrivateKey(config.privateKey)
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('RJ_WORKER_UNAVAILABLE')
    identity = { id: 'rj-aws-worker', privateKey, publicKey: createPublicKey(privateKey) }
    delete config.privateKey
    if (await readOwnerFile(config.awsConfigPath, 1024) !== rjImdsConfig(security.target.region)) throw new Error('RJ_WORKER_UNAVAILABLE')
    // Own the journal before waiting for input. Concurrent CLI invocations fail closed.
    worker = await RjAwsWorker.open({ stateDir: STATE_DIR, humanKeys: config.humanKeys, identity,
      target: security.target, roleArn: security.roleArn, assumedRolePrefix: security.assumedRolePrefix,
      execute: createAwsReader({ target: security.target, roleArn: security.roleArn, assumedRolePrefix: security.assumedRolePrefix, configPath: config.awsConfigPath }) })
    const request = await readRequestLine(process.stdin)
    clearTimeout(timeout)
    const receipt = JSON.stringify(await worker.handle(request))
    if (Buffer.byteLength(receipt) > RJ_RECEIPT_LIMIT) throw new Error('RJ_WORKER_UNAVAILABLE')
    process.stdout.write(receipt + '\n')
  } catch (e) {
    const code = ['RJ_REQUEST_INVALID', 'RJ_REQUEST_CONFLICT', 'RJ_WORKER_BUSY', 'RJ_STATE_UNAVAILABLE'].includes(e.message) ? e.message : 'RJ_WORKER_UNAVAILABLE'
    const error = identity ? signAction({ schema: 'chimera.rj-aws.error.v1', workerId: 'rj-aws-worker', code }, identity) : { error: 'RJ_WORKER_UNAVAILABLE' }
    process.stdout.write(JSON.stringify(error) + '\n')
    process.exitCode = 1
  } finally {
    clearTimeout(timeout)
    await worker?.close()
    process.stdin.destroy()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
