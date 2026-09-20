import { sha256 } from '../canonical.mjs'

export const AGENT_READINESS_SCHEMA = 'chimera.agent-readiness.v1'

const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const STATUS = new Set(['blocked', 'configured', 'verified'])
const CHECK_STATUS = new Set(['pass', 'blocked', 'unknown'])

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function check(status, reason = null, details = null) {
  if (!CHECK_STATUS.has(status)) throw new TypeError('AGENT_READINESS_CHECK_INVALID')
  return {
    status,
    ...(typeof reason === 'string' && reason.length > 0 ? { reason } : {}),
    ...(record(details) ? { details: structuredClone(details) } : {}),
  }
}

function layerFiles(continuity, kind) {
  const files = continuity?.report?.[kind]?.files
  return Number.isSafeInteger(files) && files >= 0 ? files : null
}

function requiredContinuityCheck(manifest, continuity) {
  if (!manifest || !record(manifest)) return check('blocked', 'AGENT_MANIFEST_INVALID')
  if (!continuity || !record(continuity)) return check('blocked', 'AGENT_CONTINUITY_UNAVAILABLE')
  if (continuity.status !== 'materialized' && continuity.status !== 'built-in') {
    return check('blocked', continuity.failureCode ?? 'AGENT_CONTINUITY_UNAVAILABLE')
  }
  const sourceType = manifest.source?.type
  const required = sourceType === 'hermes' ? ['persona', 'memory'] : sourceType === 'chimera' ? ['persona'] : []
  for (const kind of required) {
    const referenceKey = kind === 'persona' ? 'personaRefs' : kind === 'memory' ? 'memoryRefs' : 'skillRefs'
    if (Array.isArray(manifest[referenceKey]) && manifest[referenceKey].length > 0 && layerFiles(continuity, kind) !== null && layerFiles(continuity, kind) === 0) {
      return check('blocked', 'AGENT_CONTINUITY_INCOMPLETE', { kind })
    }
    if (Array.isArray(manifest[referenceKey]) && manifest[referenceKey].length > 0 && layerFiles(continuity, kind) === null) {
      return check('blocked', 'AGENT_CONTINUITY_REPORT_INVALID', { kind })
    }
  }
  return check('pass', null, {
    status: continuity.status,
    personaFiles: layerFiles(continuity, 'persona'),
    memoryFiles: layerFiles(continuity, 'memory'),
    skillsFiles: layerFiles(continuity, 'skills'),
  })
}

function identityCheck(manifest) {
  return manifest && record(manifest) && manifest.enabled !== false && AGENT_ID.test(manifest.agentId ?? '') && typeof manifest.displayName === 'string' && manifest.displayName.length > 0
    ? check('pass')
    : check('blocked', 'AGENT_MANIFEST_INVALID')
}

function modelCheck(selection) {
  if (!selection || !record(selection)) return check('blocked', 'AGENT_MODEL_UNAVAILABLE')
  if (selection.connectionEnabled === false) return check('blocked', 'AGENT_CONNECTION_DISABLED', {
    providerId: typeof selection.providerId === 'string' ? selection.providerId : null,
  })
  if (selection.eligible === false) return check('blocked', selection.reason ?? 'AGENT_MODEL_UNAVAILABLE')
  if (selection.mode === 'auto') {
    return selection.eligible === true || selection.status === 'eligible'
      ? check('pass', null, {
          mode: 'auto',
          providerId: typeof selection.providerId === 'string' ? selection.providerId : null,
          model: typeof selection.model === 'string' ? selection.model : null,
          availability: selection.availability ?? 'unknown',
          connectionRevision: Number.isSafeInteger(selection.connectionRevision) ? selection.connectionRevision : null,
        })
      : check('blocked', 'AGENT_MODEL_UNAVAILABLE')
  }
  if (typeof selection.providerId !== 'string' || typeof selection.model !== 'string') return check('blocked', 'AGENT_MODEL_SELECTION_INVALID')
  return check('pass', null, {
    mode: selection.mode,
    providerId: selection.providerId,
    model: selection.model,
    availability: selection.availability ?? 'unknown',
    connectionRevision: Number.isSafeInteger(selection.connectionRevision) ? selection.connectionRevision : null,
  })
}

function accessCheck(access) {
  if (!access || !record(access) || typeof access.profileId !== 'string') return check('blocked', 'AGENT_ACCESS_UNAVAILABLE')
  return check('pass', null, { profileId: access.profileId, network: access.network ?? null })
}

function executorCheck(executor) {
  if (!executor || !record(executor)) return check('unknown', 'AGENT_EXECUTOR_UNAVAILABLE')
  if (executor.status === 'blocked') return check('blocked', executor.reason ?? 'AGENT_EXECUTOR_UNAVAILABLE')
  if (executor.status === 'unsupported') return check('unknown', executor.reason ?? 'AGENT_EXECUTOR_NOT_PURE')
  if (executor.status === 'task-bound' && executor.requiresTask === true && executor.binding !== 'bound') {
    return check('unknown', 'AGENT_EXECUTOR_UNBOUND', {
      kind: executor.kind ?? 'harness',
      status: executor.status,
      identity: executor.identity ?? null,
      binding: executor.binding ?? 'unbound',
      requiresTask: true,
    })
  }
  if (executor.status === 'task-bound' || executor.status === 'ready') return check('pass', null, {
    kind: executor.kind ?? 'harness',
    status: executor.status,
    ...(typeof executor.identity === 'string' ? { identity: executor.identity } : {}),
    ...(typeof executor.binding === 'string' ? { binding: executor.binding } : {}),
    ...(typeof executor.requiresTask === 'boolean' ? { requiresTask: executor.requiresTask } : {}),
  })
  return check('unknown', 'AGENT_EXECUTOR_UNAVAILABLE')
}

function safeLastTest(verification, fingerprint) {
  if (!verification || !record(verification)) return null
  // Binding identity and outcome are separate. A failed/unknown receipt for
  // the current binding is still current evidence, but it never becomes a
  // verified execution check and must remain actionable in the UI.
  const current = verification.fingerprint === fingerprint
  return {
    requestId: typeof verification.requestId === 'string' ? verification.requestId : null,
    scope: typeof verification.scope === 'string' ? verification.scope : 'inference-only',
    status: verification.status === 'passed' ? 'passed' : verification.status === 'unknown' ? 'unknown' : 'failed',
    observedAt: typeof verification.observedAt === 'string' ? verification.observedAt : null,
    current,
    historical: !current,
  }
}

export function fingerprintAgentReadiness({ manifest, continuity, selection, access, executor } = {}) {
  return sha256({
    schema: AGENT_READINESS_SCHEMA,
    agent: manifest ? {
      agentId: manifest.agentId,
      schema: manifest.schema,
      displayName: manifest.displayName,
      role: manifest.role,
      capabilities: manifest.capabilities ?? [],
      enabled: manifest.enabled !== false,
      source: manifest.source,
      personaRefs: manifest.personaRefs ?? [],
      memoryRefs: manifest.memoryRefs ?? [],
      skillRefs: manifest.skillRefs ?? [],
    } : null,
    continuity: continuity ? {
      status: continuity.status,
      digest: continuity.digest,
      report: continuity.report,
      failureCode: continuity.failureCode ?? null,
    } : null,
    selection: selection ?? null,
    access: access ?? null,
    executor: executor ?? null,
  })
}

export function buildAgentReadiness({ manifest, continuity, selection, access, executor, verification = null } = {}) {
  const fingerprint = fingerprintAgentReadiness({ manifest, continuity, selection, access, executor })
  const checks = [
    { name: 'identity', ...identityCheck(manifest) },
    { name: 'continuity', ...requiredContinuityCheck(manifest, continuity) },
    { name: 'model', ...modelCheck(selection) },
    { name: 'access', ...accessCheck(access) },
    { name: 'executor', ...executorCheck(executor) },
  ]
  const matchingVerification = verification?.fingerprint === fingerprint && verification?.status === 'passed'
  checks.push({ name: 'execution', ...(matchingVerification ? check('pass', null, { scope: verification.scope ?? 'inference-only' }) : check('unknown', verification?.status === 'unknown' ? 'AGENT_TEST_OUTCOME_UNKNOWN' : 'AGENT_TEST_REQUIRED')) })
  const blocked = checks.some(item => item.status === 'blocked')
  const status = blocked ? 'blocked' : matchingVerification ? 'verified' : 'configured'
  return {
    schema: AGENT_READINESS_SCHEMA,
    agentId: typeof manifest?.agentId === 'string' ? manifest.agentId : null,
    status: STATUS.has(status) ? status : 'blocked',
    fingerprint,
    checks,
    lastTest: safeLastTest(verification, fingerprint),
  }
}
