import { DurableFileAuditLog } from './durable-file-log.mjs'
import { LambdaAuditClient } from './lambda-client.mjs'
import { RemoteAuditLog } from './remote-log.mjs'

function invalid(code) {
  return Object.assign(new Error(code), { code })
}

export async function openRuntimeAudit({
  filePath,
  env = process.env,
  clientFactory = (configuration) => LambdaAuditClient.open(configuration),
} = {}) {
  const functionName = env.CHIMERA_AUDIT_WRITER_FUNCTION
  const streamId = env.CHIMERA_AUDIT_STREAM_ID
  const configured = Boolean(functionName || streamId)
  if (!configured) return DurableFileAuditLog.open({ filePath })
  if (typeof functionName !== 'string' || functionName.length === 0
    || typeof streamId !== 'string' || streamId.length === 0) {
    throw invalid('GATE2_AUDIT_CONFIG_INCOMPLETE')
  }
  const client = await clientFactory({
    functionName,
    region: env.AWS_REGION ?? 'us-west-2',
  })
  try {
    return await RemoteAuditLog.open({ client, streamId })
  } catch (error) {
    await client.close?.()
    throw error
  }
}
