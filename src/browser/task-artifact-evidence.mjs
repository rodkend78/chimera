const ARTIFACT_EXECUTOR_NAMES = Object.freeze([
  'mcp__chimera_worker__code',
  'mcp__chimera_worker__computer',
])

const ARTIFACT_FIELDS = Object.freeze([
  'artifactId',
  'workerSessionId',
  'agentId',
  'sha256',
  'bytes',
])

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function taskContext(context) {
  if (!isRecord(context)
    || context.taskScoped !== true
    || typeof context.taskId !== 'string'
    || context.taskId.length === 0
    || typeof context.agentId !== 'string'
    || context.agentId.length === 0) return null
  return context
}

function matchesMaterializedArtifact(returned, stored, context, args) {
  if (!isRecord(returned) || !isRecord(stored)) return false
  if (stored.agentId !== context.agentId) return false
  if (typeof args?.workerSessionId === 'string' && stored.workerSessionId !== args.workerSessionId) return false
  return ARTIFACT_FIELDS.every((field) => returned[field] === stored[field])
}

function receiptForArtifact(taskId, artifact) {
  return {
    kind: 'artifact',
    source: 'worker-artifact-store',
    operationId: `artifact:${artifact.artifactId}`,
    revision: { artifactId: artifact.artifactId, hash: artifact.sha256 },
    outcome: {
      status: 'materialized',
      artifactId: artifact.artifactId,
      sessionId: artifact.workerSessionId,
      agentId: artifact.agentId,
      hash: artifact.sha256,
      size: artifact.bytes,
      scope: `task:${taskId}/worker:${artifact.workerSessionId}`,
    },
    evidenceRef: `artifact:${artifact.artifactId}`,
  }
}

export function wrapTaskArtifactExecutors({ executors, artifactStore, recordEvidence } = {}) {
  if (!isRecord(executors)
    || typeof artifactStore?.list !== 'function'
    || typeof recordEvidence !== 'function') {
    throw new TypeError('TASK_ARTIFACT_EVIDENCE_CONFIG_INVALID')
  }
  const wrapped = { ...executors }
  for (const name of ARTIFACT_EXECUTOR_NAMES) {
    const original = executors[name]
    if (typeof original !== 'function') continue
    wrapped[name] = async (args, context) => {
      let priorIds
      try {
        priorIds = new Set(artifactStore.list().map((artifact) => artifact?.artifactId).filter(Boolean))
      } catch {
        return original(args, context)
      }
      const result = await original(args, context)
      const scoped = taskContext(context)
      if (!scoped) return result
      try {
        const returned = result?.artifact
        if (!isRecord(returned) || priorIds.has(returned.artifactId)) return result
        const materialized = artifactStore.list().find((artifact) => (
          artifact?.artifactId === returned.artifactId && !priorIds.has(artifact.artifactId)
        ))
        if (!matchesMaterializedArtifact(returned, materialized, scoped, args)) return result
        await Promise.resolve(recordEvidence(scoped.taskId, receiptForArtifact(scoped.taskId, materialized))).catch(() => {})
      } catch {
        // Evidence recording is observational. Never re-run an executor to
        // compensate for a missing ledger receipt after an effect succeeded.
      }
      return result
    }
  }
  return wrapped
}
