import crypto from 'node:crypto'
import { createAntigravityConnection } from '../ceo/antigravity-provider.mjs'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openRuntimeAudit } from '../audit/runtime-audit.mjs'
import { DurableFileAuditLog } from '../audit/durable-file-log.mjs'
import { createAgentMessageEnvelope } from '../agent-message.mjs'
import { sha256 } from '../canonical.mjs'
import { createActivityProjection } from '../ceo/activity-projection.mjs'
import {
  DurableAgentRegistry,
  NATIVE_RESERVED_AGENT_IDS,
  agentManifestFromHermesCandidate,
  agentManifestFromNativeInput,
} from '../agents/registry.mjs'
import { AGENT_ACCESS_PROFILES, DurableAgentAccessPolicy, toolsForAccessProfile } from '../agents/access-policy.mjs'
import { runBoundedAgentLoop, normalizeTaskBudget } from '../agents/bounded-work-loop.mjs'
import { AccountCompanionRuntime } from '../account-browser/runtime-integration.mjs'
import { DurableAgentModelPolicy } from '../agents/model-policy.mjs'
import { createHarnessExecutors } from '../agents/harness-executors.mjs'
import { wrapTaskArtifactExecutors } from './task-artifact-evidence.mjs'
import { createHermesAgentDiscoveryFromEnv, resolveHermesDiscoveryTarget } from '../agents/hermes-discovery.mjs'
import { createHermesReferenceProviderFromEnv } from '../agents/hermes-reference-provider.mjs'
import { NativeAgentReferenceProvider, validateNativePersonaContent } from '../agents/native-reference-provider.mjs'
import { DurableAgentCreationReceipts } from '../agents/creation-receipts.mjs'
import { DurableAgentContinuityRecords } from '../agents/continuity-records.mjs'
import { buildAgentReadiness, fingerprintAgentReadiness } from '../agents/readiness.mjs'
import { DurableAgentReadinessStore, DurableVerificationReceiptStore } from '../agents/readiness-store.mjs'
import { AgentHarnessWorker, removeAgentWorkerState } from '../agents/harness-worker.mjs'
import { validateRequiredContinuityLayers } from '../agents/worker-workspace.mjs'
import { DurableAgentMailbox } from '../agents/mailbox.mjs'
import { TeamDispatcher, PEER_TOOLS, teamMessagingProjection } from '../agents/team-dispatcher.mjs'
import { AgentWorkerWorkspace, removeAgentWorkerWorkspace } from '../agents/worker-workspace.mjs'
import { WorkerToolApprovalBroker } from '../agents/tool-approval-broker.mjs'
import { AgentCoreWorkerProvider } from '../agents/agentcore-worker-provider.mjs'
import { WorkerArtifactStore } from '../agents/worker-artifact-store.mjs'
import { WorkerRuntimeManager } from '../agents/worker-runtime-manager.mjs'
import { DurableWorkerSessionLedger } from '../agents/worker-session-ledger.mjs'
import { CodexAppServerAuth } from '../ceo/codex-app-server-auth.mjs'
import { CodexSessionBindings } from '../ceo/codex-session-bindings.mjs'
import { DurableDecisionQueue, HumanDecisionHandler } from '../ceo/decisions.mjs'
import { DurableConversationLedger } from '../ceo/conversation-ledger.mjs'
import { AskService, createAskModelProvider } from '../ceo/ask-service.mjs'
import { createGatewayModelRouter } from '../ceo/gateway-model-router.mjs'
import { createJevDecisionService, createJevModelRouter } from '../ceo/jev-decision.mjs'
import { JevSettings } from '../ceo/jev-settings.mjs'
import { OpenRouterSettings } from '../ceo/openrouter-settings.mjs'
import { createClaudeCodeConnection } from '../ceo/claude-code-provider.mjs'
import { DurableModelCallLedger, createReliableModelRouter } from '../ceo/reliable-model-router.mjs'
import { createTaskFailureFromError, createTrustedModelCallNotSentError, isTrustedModelCallNotSentError } from '../ceo/model-call-errors.mjs'
import { RoutingEvidenceStore } from '../ceo/routing-evidence.mjs'
import { TASK_PLAN_SCHEMA, combineTaskRequirements } from '../ceo/task-plan.mjs'
import { normalizeTaskRequirements } from '../ceo/task-requirements.mjs'
import { validateModelRouter } from '../ceo/model-router.mjs'
import { SignedSpecialistStub } from '../ceo/specialist-stub.mjs'
import { isInferenceOnlyRouter } from '../ceo/inference-proof.mjs'
import { DurableTaskLedger } from '../ceo/task-ledger.mjs'
import { CeoWorkspace } from '../ceo/workspace.mjs'
import { ChimeraGateway } from '../gateway.mjs'
import { GatewayReplayLedger } from '../gateway-replay-ledger.mjs'
import { loadDshEffectInventory } from '../dsh/effect-inventory.mjs'
import {
  exportPublicKey,
  fingerprint,
  signAction,
  signGrant,
} from '../identity.mjs'
import { DurableIdentityStore } from '../identity-store.mjs'
import { evaluatePolicy } from '../policy.mjs'
import { createEd25519SigningProvider } from '../signing-provider.mjs'
import { OpenBotBrowserComputerAdapter } from './adapter.mjs'
import { redactSensitiveData, redactSensitiveText } from '../security/redaction.mjs'
import { DurableProjectRegistry } from '../projects/project-registry.mjs'
import { ProjectSessionManager, PROJECT_IDENTITY_PATH } from '../projects/project-session-manager.mjs'
import { DurableTaskAccessLeases } from '../projects/task-access-lease.mjs'
import { GitHubCliProvider, createGitHubToolExecutors, resolveGitHubRepositories } from '../github/cli-provider.mjs'
import { createRjAwsConnector, rjAwsConfigFromEnv, RJ_AWS_TOOLS } from '../rj-aws/connector.mjs'
import { RjAwsEvidence } from '../rj-aws/evidence.mjs'
import { RemoteTeamTransport } from '../agents/remote-team-transport.mjs'
import { DurableConnectionPolicy } from '../connections/policy.mjs'
import { ConnectionService } from '../connections/service.mjs'
import { buildTaskWorkspace } from '../ceo/task-workspace-projection.mjs'

const POLICY_URL = new URL('../../config/policy.json', import.meta.url)
const MODEL_ROUTING_URL = new URL('../../config/model-routing.json', import.meta.url)
const WORKSPACE_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const MEDIA_RATE_WINDOW_MS = 60 * 60_000
const MEDIA_RATE_LIMIT = 12
const MEDIA_CONCURRENCY_LIMIT = 2
const AGENT_DISCOVERY_LIFETIME_MS = 15 * 60_000
const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const CONTINUITY_EXCLUDED = Object.freeze([
  'credentials',
  'provider-sessions',
  'private-keys',
  'authority-grants',
  'transient-runtime-state',
  'skill-assets',
])
const ASK_CONTEXT_MAX_BYTES = 240 * 1024

const DEFAULT_RESEARCHER_MANIFEST = Object.freeze({
  schema: 'chimera.agent-manifest.v1',
  agentId: 'researcher',
  displayName: 'Researcher',
  role: 'General research specialist',
  capabilities: ['research'],
  modelPreference: { mode: 'chimera-auto' },
  source: { type: 'chimera', sourceId: 'built-in', profileId: 'researcher', ref: 'chimera://built-in/researcher' },
  memoryRefs: [],
  execution: { adapter: 'model-fabric', isolation: 'per-agent-workspace', sideEffects: 'dsh-required' },
  enabled: true,
  importedAt: null,
})

function isoWindow(now, lifetimeMs = 8 * 60 * 60_000) {
  return {
    issuedAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + lifetimeMs).toISOString(),
  }
}

function taskProjection(record) {
  return {
    taskId: record.taskId,
    objective: record.objective,
    model: record.model,
    status: record.status,
    destinationRevision: record.destinationRevision ?? 0,
    retryable: record.retryable,
    submittedAt: record.submittedAt,
    ...(record.startedAt ? { startedAt: record.startedAt } : {}),
    ...(record.completedAt ? { completedAt: record.completedAt } : {}),
    ...(record.failedAt ? { failedAt: record.failedAt } : {}),
    ...(record.interruptedAt ? { interruptedAt: record.interruptedAt } : {}),
    ...(record.summary ? { summary: record.summary } : {}),
    ...(record.failure ? { failure: record.failure } : {}),
    ...(record.cancelledAt ? { cancelledAt: record.cancelledAt } : {}),
    ...(record.routing ? { routing: structuredClone(record.routing) } : {}),
    ...(record.plan ? { plan: structuredClone(record.plan) } : {}),
    ...(record.steps ? { steps: structuredClone(record.steps) } : {}),
    budget: record.context?.budget ?? null,
    ...(record.context?.requirements ? { requirements: structuredClone(record.context.requirements) } : {}),
    budgetUsage: record.checkpoint?.budgetUsage ?? null,
    priorTaskId: record.context?.priorTaskId ?? null,
    projectId: record.context?.projectId ?? null,
    projectSessionTaskId: record.context?.projectSessionTaskId ?? null,
    checkpoint: record.checkpoint ?? null,
    lastCompletedWork: record.lastCompletedWork ?? null,
    steering: record.steering ?? [],
    queuedForExecution: record.queuedForExecution === true,
    queueScope: record.queuedForExecution === true ? (record.context?.projectId ? 'project' : 'root') : null,
    recoveryRequired: record.recoveryRequired === true,
    ...(record.evidenceTruncated === true ? { evidenceTruncated: true } : {}),
  }
}

function projectTaskPermissions(leases, routing, agentAccessPolicy) {
  const selected = routing?.selected
  return (Array.isArray(leases) ? leases : []).map(lease => {
    const projected = structuredClone(lease)
    try {
      const agentProfileId = agentAccessPolicy?.get?.(lease.agentId)?.profileId
      if (typeof agentProfileId === 'string') projected.agentProfileId = agentProfileId
    } catch {
      // A missing current assignment is an explicit unknown, not a reason to
      // infer access from a provider or globally active worker.
    }
    try {
      projected.tools = toolsForAccessProfile(lease.profileId)
    } catch {
      // The durable lease validator already bounds profile IDs. Preserve the
      // lease and let the projection render the tool ceiling as unknown if a
      // legacy record does not map to a current profile.
    }
    if (selected?.agentId === lease.agentId && typeof selected?.executor === 'string') projected.executor = selected.executor
    return projected
  })
}

function safeTaskFailure(error) {
  return createTaskFailureFromError(error)
}

function boundedRouteText(value, maximum = 512) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum ? value : null
}

function safeRouteCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
  const result = {}
  for (const field of ['routeId', 'providerId', 'model', 'agentId', 'executor', 'reason']) {
    const value = boundedRouteText(candidate[field])
    if (value) result[field] = value
  }
  if (['eligible', 'rejected', 'unknown'].includes(candidate.status)) result.status = candidate.status
  if (typeof candidate.trustedEligible === 'boolean') result.trustedEligible = candidate.trustedEligible
  if (candidate.nativeExecution === true) result.nativeExecution = true
  for (const field of ['reasons', 'details']) {
    if (Array.isArray(candidate[field])) {
      result[field] = candidate[field].filter(value => boundedRouteText(value, 512)).slice(0, 16)
    }
  }
  return result
}

function safeRoutingEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return { status: 'unknown' }
  const result = { status: boundedRouteText(evidence.status, 32) ?? 'unknown' }
  for (const field of ['latency', 'reliability', 'cost']) {
    const value = evidence[field]
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const safe = {}
    if (boundedRouteText(value.status, 32)) safe.status = value.status
    for (const metric of ['medianMs', 'successRatio', 'medianUsd']) {
      if (Number.isFinite(value[metric]) && value[metric] >= 0) safe[metric] = value[metric]
    }
    if (boundedRouteText(value.source, 64)) safe.source = value.source
    if (Object.keys(safe).length) result[field] = safe
  }
  return result
}

function taskRoutingProjection(explanation, { taskId, agentId, now }) {
  if (!explanation || typeof explanation !== 'object' || Array.isArray(explanation)
    || explanation.schema !== 'chimera.routing-explanation.v1') return null
  const selected = safeRouteCandidate(explanation.selected)
  if (selected) {
    selected.agentId = boundedRouteText(agentId, 256) ?? 'unknown'
    // The provider/fabric may aggregate native capability across all of its
    // routes. Only the selected route can establish this task's executor;
    // an unresolved selection intentionally remains executor-null.
    selected.executor = selected.executor
      ?? (selected.nativeExecution ? 'native-task-bound' : 'inference-only')
  }
  const candidates = Array.isArray(explanation.candidates)
    ? explanation.candidates.map(safeRouteCandidate).filter(Boolean).slice(0, 64)
    : []
  const reasons = Array.isArray(explanation.reasons)
    ? explanation.reasons.filter(value => boundedRouteText(value, 512)).slice(0, 16)
    : []
  return {
    schema: 'chimera.routing-explanation.v1',
    taskId: boundedRouteText(taskId, 256) ?? null,
    selected,
    ...(explanation.selectionPending === true ? { selectionPending: true } : {}),
    candidates,
    reasons,
    evidence: safeRoutingEvidence(explanation.evidence),
    observedAt: boundedRouteText(explanation.observedAt, 64) ?? new Date(now()).toISOString(),
  }
}

function preferredExplanationProvesIneligible(explanation) {
  const candidates = Array.isArray(explanation?.candidates) ? explanation.candidates : []
  return explanation?.selected === null
    && candidates.length > 0
    && candidates.every(candidate => candidate?.status === 'rejected'
      || (candidate?.status === 'unknown' && candidate?.trustedEligible === true))
}

function trustedPreferredFallbackConstructionFailure(error) {
  if (isTrustedModelCallNotSentError(error)) return error
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,127}$/.test(error.code)
    ? error.code
    : 'PREFERRED_FALLBACK_UNAVAILABLE'
  const message = error instanceof Error && typeof error.message === 'string' && error.message.length > 0 && error.message.length <= 1_024
    ? error.message
    : code
  // This boundary is reached before either the Preferred or captured fallback
  // router has entered a provider. Never copy an ordinary error's claimed
  // dispatch state; mint the runtime-owned trust marker here.
  return createTrustedModelCallNotSentError(message, { code, reason: code })
}

function createInvocationPreferredFallbackRouter({
  preferredRouter,
  fallbackRouter,
  fallbackError = null,
  audit,
  agentId,
  providerId,
  model,
  now,
}) {
  const preferredExplain = typeof preferredRouter?.explain === 'function'
    ? preferredRouter.explain.bind(preferredRouter)
    : null
  const fallbackExplain = typeof fallbackRouter?.explain === 'function'
    ? fallbackRouter.explain.bind(fallbackRouter)
    : null
  const fallbackRouterError = fallbackError ?? Object.assign(new Error('PREFERRED_FALLBACK_UNAVAILABLE'), {
    code: 'PREFERRED_FALLBACK_UNAVAILABLE',
  })

  function explanationInput({ prompt = '', context = {}, requirements = undefined } = {}) {
    return {
      prompt,
      context,
      ...(requirements === undefined ? {} : { requirements }),
    }
  }

  function preferredExplanationFor(input) {
    if (!preferredExplain) return null
    return preferredExplain(input)
  }

  function fallbackExplanationFor(input) {
    if (!fallbackExplain) return null
    return fallbackExplain(input)
  }

  function recordFallback() {
    audit?.append({
      kind: 'agent.model.fallback',
      agentId,
      providerId,
      model,
      reason: 'PREFERRED_ROUTE_INELIGIBLE_BEFORE_DISPATCH',
      at: new Date(now()).toISOString(),
    })
  }

  // Keep the underlying router identity as the authorization/ledger resource
  // so existing gateway policy prefixes continue to apply. The selected
  // fallback provider/model remains in its task-aware explanation and route
  // audit; this wrapper is only a pre-dispatch decision boundary.
  const routerId = preferredRouter.routerId
  return validateModelRouter(Object.freeze({
    routerId,
    descriptor: preferredRouter.descriptor,
    nativeExecution: preferredRouter.nativeExecution === true || fallbackRouter?.nativeExecution === true,
    explain(input = {}) {
      const normalized = explanationInput(input)
      const preferredExplanation = preferredExplanationFor(normalized)
      if (!preferredExplanationProvesIneligible(preferredExplanation)) return preferredExplanation
      const fallbackExplanation = fallbackExplanationFor(normalized)
      return fallbackExplanation ?? preferredExplanation
    },
    async route(prompt, context = {}, controls = undefined) {
      const input = explanationInput({ prompt, context })
      let preferredExplanation
      try {
        preferredExplanation = preferredExplanationFor(input)
      } catch {
        // Explanation failure is not trusted proof that Preferred is
        // ineligible. Keep the original route and preserve its own error
        // semantics; fallback is only selected from a successful explanation.
        return preferredRouter.route(prompt, context, controls)
      }
      if (!preferredExplanationProvesIneligible(preferredExplanation)) {
        // Deliberately do not catch provider/SDK errors here. Once this
        // trusted pre-dispatch explanation selected Preferred, an uncertain
        // dispatch outcome must remain unknown and must never try another
        // model.
        return preferredRouter.route(prompt, context, controls)
      }
      recordFallback()
      if (!fallbackRouter) throw trustedPreferredFallbackConstructionFailure(fallbackRouterError)
      // The fallback router is admission-scoped and receives the original
      // prompt, context, and opaque execution controls. Its own explanation,
      // hard filters, evidence, and route audit establish the selected model.
      return fallbackRouter.route(prompt, context, controls)
    },
  }))
}

function modelCodexStatus(authState) {
  return {
    configured: authState?.connected === true,
    authentication: authState?.connected === true ? 'chatgpt-subscription' : null,
  }
}

function hermesSourceState(injectedDiscovery) {
  if (injectedDiscovery) {
    return Object.freeze({
      id: 'hermes-aws',
      host: 'configured-hermes',
      mode: 'read-only-discovery',
      configured: true,
    })
  }
  const target = resolveHermesDiscoveryTarget()
  if (!target) {
    return Object.freeze({
      id: 'hermes-aws',
      mode: 'not-configured',
      configured: false,
    })
  }
  return Object.freeze({
    id: target.sourceId,
    host: target.host,
    mode: 'read-only-discovery',
    configured: true,
  })
}

function isHermesTargetNotConfigured(error) {
  return error?.code === 'HERMES_DISCOVERY_NOT_CONFIGURED'
    || error?.code === 'HERMES_REFERENCE_NOT_CONFIGURED'
}

function emptyContinuityReport() {
  return {
    persona: { files: 0, bytes: 0 },
    memory: { files: 0, bytes: 0 },
    skills: { files: 0, bytes: 0 },
    excluded: [...CONTINUITY_EXCLUDED],
    dependencyStatus: 'unverified',
  }
}

function discoveryCandidateProjection(candidate, source) {
  const projected = structuredClone(candidate)
  const isHermes = source?.type === 'hermes-ssm'
    || projected.schema === 'chimera.hermes-agent-candidate.v1'
  if (!isHermes) return projected
  // Inventory is names-only. Keep the import boundary explicit: these layers
  // are never imported as credentials/authority, and dependency contents were
  // not inspected by the read-only discovery command.
  if (!Array.isArray(projected.exclusions)) projected.exclusions = [...CONTINUITY_EXCLUDED]
  if (typeof projected.dependencyStatus !== 'string' || projected.dependencyStatus.length === 0) {
    projected.dependencyStatus = 'unverified / not inspected'
  }
  return projected
}

function unavailableContinuity(agentId, failureCode) {
  return {
    agentId,
    status: 'unavailable',
    digest: null,
    report: emptyContinuityReport(),
    failureCode: failureCode ?? 'AGENT_CONTINUITY_UNAVAILABLE',
  }
}

function materializedContinuity(workspace) {
  const continuity = workspace.state().continuity
  return {
    agentId: workspace.agentId,
    status: 'materialized',
    digest: continuity.digest,
    report: structuredClone(continuity.report),
    failureCode: null,
  }
}

function builtInAskContinuity(agentId) {
  return {
    schema: 'chimera.agent-continuity-context.v1',
    agentId,
    status: 'built-in',
    digest: null,
    dependencyStatus: 'unverified',
    persona: [],
    memory: [],
    skills: [],
    report: emptyContinuityReport(),
    askProjection: { skillsIncluded: 0, skillsOmitted: 0 },
  }
}

function contextBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function boundedAskContinuity(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    throw Object.assign(new Error('ASK_CONTINUITY_INVALID'), { code: 'ASK_CONTINUITY_INVALID' })
  }
  const projected = structuredClone(context)
  const requiredKinds = ['persona', 'memory']
  for (const kind of requiredKinds) {
    const entries = Array.isArray(projected[kind]) ? projected[kind] : []
    const report = projected.report?.[kind]
    const retainedBytes = entries.reduce((total, entry) => total + Buffer.byteLength(entry?.content ?? '', 'utf8'), 0)
    if (!report || report.files !== entries.length || report.bytes !== retainedBytes) {
      throw Object.assign(new Error('ASK_CONTINUITY_INCOMPLETE'), { code: 'ASK_CONTINUITY_INCOMPLETE' })
    }
  }
  const skills = Array.isArray(projected.skills) ? projected.skills : []
  const reportedSkills = projected.report?.skills?.files ?? skills.length
  const base = { ...projected, skills: [], askProjection: { skillsIncluded: 0, skillsOmitted: reportedSkills } }
  if (contextBytes(base) > ASK_CONTEXT_MAX_BYTES) {
    throw Object.assign(new Error('ASK_CONTINUITY_TOO_LARGE'), { code: 'ASK_CONTINUITY_TOO_LARGE' })
  }
  const retained = []
  for (const entry of skills) {
    const candidate = {
      ...base,
      skills: [...retained, entry],
      askProjection: { skillsIncluded: retained.length + 1, skillsOmitted: Math.max(0, reportedSkills - retained.length - 1) },
    }
    if (contextBytes(candidate) > ASK_CONTEXT_MAX_BYTES) break
    retained.push(entry)
  }
  const result = {
    ...base,
    skills: retained,
    askProjection: { skillsIncluded: retained.length, skillsOmitted: Math.max(0, reportedSkills - retained.length) },
  }
  if (contextBytes(result) > ASK_CONTEXT_MAX_BYTES) {
    throw Object.assign(new Error('ASK_CONTINUITY_TOO_LARGE'), { code: 'ASK_CONTINUITY_TOO_LARGE' })
  }
  return result
}

function assertExactRecord(value, fields, code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).some((key) => !fields.includes(key))) {
    throw Object.assign(new TypeError(code), { code })
  }
}

function hasTaskHarness(manifest) {
  return manifest?.source?.type === 'hermes' || manifest?.schema === 'chimera.agent-manifest.v2'
}

export class ChimeraBrowserRuntime {
  constructor({
    profileDir,
    decisionFile,
    taskFile,
    conversationFile,
    modelCallFile,
    modelSessionFile,
    routingEvidenceFile,
    modelRegistry,
    modelRegistryFactory,
    agentFile,
    agentRegistry,
    mainAgentFile,
    mainAgentRegistry,
    agentDiscovery,
    workerRoot,
    nativeAgentRoot,
    nativeReferenceProvider,
    agentCreationReceiptFile,
    agentContinuityFile,
    agentReadinessFile,
    connectionReceiptFile,
    workerStateDir,
    mailboxFile,
    teamWaitMs = 300_000,
    agentReferenceProvider,
    agentAccessFile,
    agentAccessPolicy,
    agentModelFile,
    agentModelPolicy,
    workerToolExecutors,
    workerRuntimeManager,
    workerProvider,
    githubProvider,
    workerSessionFile,
    workerArtifactRoot,
    projectFile,
    projectRegistry,
    projectManagedRoot,
    projectAllowedRoots,
    projectSessionFile,
    projectSessions,
    projectSessionRoot,
    projectLeaseFile,
    taskAccessLeases,
    rjAwsConnector,
    rjAwsConfig,
    rjAwsTransport,
    audit,
    auditFile,
    browserInputAudit,
    browserInputAuditFile,
    identityStore,
    identityFile,
    replayLedger,
    replayFile,
    connectionFile,
    connectionPolicy,
    connectionService,
    jevSettings = null,
    jevSettingsFile,
    jevFetch = globalThis.fetch,
    openRouterSettings = null,
    openRouterSettingsFile,
    claudeCode = null,
    connectionMachineRef = process.env.CHIMERA_MACHINE_REF ?? null,
    connectionMachineRefFile,
    codexAuth,
    browserExecutor,
    teamTransport = null,
    teamRemoteWorkspaceRoot = process.env.CHIMERA_TEAM_WORKSPACE_ROOT ?? '/var/lib/chimera/team-tasks',
    now = () => Date.now(),
  }) {
    this.now = now
    this.teamWaitMs = teamWaitMs
    this.teamDispatchers = new Map()
    this.taskGuidanceWrites = new Map()
    this.agentId = 'ceo'
    this.humanId = 'rod'
    this.audit = audit ?? null
    this.profileDir = profileDir
    this.decisionFile = decisionFile ?? resolve(profileDir, '../../decisions/queue.jsonl')
    this.taskFile = taskFile ?? resolve(profileDir, '../../tasks/events.jsonl')
    this.conversationFile = conversationFile ?? resolve(profileDir, '../../conversations/messages.jsonl')
    this.modelCallFile = modelCallFile ?? resolve(profileDir, '../../model-calls/events.jsonl')
    this.modelSessionFile = modelSessionFile ?? resolve(profileDir, '../../model-calls/codex-sessions.jsonl')
    this.routingEvidenceFile = routingEvidenceFile ?? resolve(profileDir, '../../model-calls/routing-evidence.json')
    this.auditFile = auditFile ?? resolve(profileDir, '../../audit/events.jsonl')
    this.browserInputAuditFile = browserInputAuditFile ?? resolve(profileDir, '../../audit/browser-input.jsonl')
    this.browserInputAudit = browserInputAudit ?? null
    this.identityFile = identityFile ?? resolve(profileDir, '../../identity/actors.json')
    this.replayFile = replayFile ?? resolve(profileDir, '../../gateway/replay.jsonl')
    this.connectionFile = connectionFile ?? resolve(profileDir, '../../connections/policy.json')
    this.connectionMachineRefFile = connectionMachineRefFile ?? resolve(profileDir, '../../connections/machine-ref.json')
    this.connectionPolicy = connectionPolicy ?? null
    this.connectionService = connectionService ?? null
    this.jevSettings = jevSettings
    this.jevSettingsFile = jevSettingsFile ?? resolve(profileDir, '../../jev/key.json')
    this.jevFetch = jevFetch
    this.openRouterSettings = openRouterSettings
    this.openRouterSettingsFile = openRouterSettingsFile ?? resolve(profileDir, '../../openrouter/settings.json')
    this.claudeCode = claudeCode ?? createClaudeCodeConnection()
    this.connectionMachineRef = connectionMachineRef
    this.cachedConnectionState = []
    this.identityStore = identityStore ?? null
    this.replayLedger = replayLedger ?? null
    this.agentFile = agentFile ?? resolve(profileDir, '../../agents/registry.json')
    this.mainAgentFile = mainAgentFile ?? resolve(profileDir, '../../agents/main.json')
    this.agentAccessFile = agentAccessFile ?? resolve(profileDir, '../../agents/access.json')
    this.agentModelFile = agentModelFile ?? resolve(profileDir, '../../agents/models.json')
    this.workerRoot = workerRoot ?? resolve(profileDir, '../../agents/workspaces')
    this.nativeAgentRoot = nativeAgentRoot ?? resolve(profileDir, '../../agents/native')
    this.agentCreationReceiptFile = agentCreationReceiptFile ?? resolve(profileDir, '../../agents/create-receipts.json')
    this.agentContinuityFile = agentContinuityFile ?? resolve(profileDir, '../../agents/continuity.json')
    this.agentReadinessFile = agentReadinessFile ?? resolve(profileDir, '../../agents/readiness.json')
    this.connectionReceiptFile = connectionReceiptFile ?? resolve(profileDir, '../../connections/receipts.json')
    this.workerStateDir = workerStateDir ?? resolve(profileDir, '../../agents/workers')
    this.mailboxFile = mailboxFile ?? resolve(profileDir, '../../agents/mailbox.jsonl')
    this.agentReferenceProvider = agentReferenceProvider
    this.nativeReferenceProvider = nativeReferenceProvider
    this.agentCreationReceipts = null
    this.agentContinuityRecords = null
    this.agentReadinessStore = null
    this.connectionReceiptStore = null
    this.workerToolExecutors = workerToolExecutors ? { ...workerToolExecutors } : null
    this.workerRuntimeManager = workerRuntimeManager
    this.workerProvider = workerProvider
    this.githubProvider = githubProvider
    this.workerSessionFile = workerSessionFile ?? resolve(profileDir, '../../workers/sessions.json')
    this.workerArtifactRoot = workerArtifactRoot ?? resolve(profileDir, '../../workers/artifacts')
    this.projectFile = projectFile ?? resolve(profileDir, '../../projects/registry.json')
    this.projectManagedRoot = projectManagedRoot ?? resolve(profileDir, '../../projects/repositories')
    this.projectAllowedRoots = projectAllowedRoots ?? [resolve(WORKSPACE_ROOT, '..')]
    this.projectSessionFile = projectSessionFile ?? resolve(profileDir, '../../projects/sessions.json')
    this.projectSessionRoot = projectSessionRoot ?? resolve(profileDir, '../../projects/workspaces')
    this.projectLeaseFile = projectLeaseFile ?? resolve(profileDir, '../../projects/leases.json')
    this.projectRegistry = projectRegistry
    this.projectSessions = projectSessions
    this.taskAccessLeases = taskAccessLeases
    this.rjAwsConnector = rjAwsConnector ?? null
    this.rjAwsConfig = rjAwsConfig
    this.rjAwsTransport = rjAwsTransport
    this.runtimeId = `runtime-${crypto.randomUUID()}`
    this.workerWorkspaces = new Map()
    this.agentContinuity = new Map()
    this.workers = new Map()
    this.mainAgentManifest = null
    this.mainAgentWorkspace = null
    this.askService = null
    this.routingEvidence = null
    this.modelRegistry = modelRegistry
    this.modelRegistryFactory = modelRegistryFactory
    this.agentRegistry = agentRegistry
    this.mainAgentRegistry = mainAgentRegistry
    this.agentAccessPolicy = agentAccessPolicy
    this.agentModelPolicy = agentModelPolicy
    // Hermes SSM targets require explicit env. Never fall back to a live host.
    this.agentDiscovery = agentDiscovery ?? createHermesAgentDiscoveryFromEnv()
    this.hermesSource = hermesSourceState(agentDiscovery)
    this.codexAuth = codexAuth
    this.teamTransport = teamTransport
    this.teamRemoteWorkspaceRoot = teamRemoteWorkspaceRoot
    this.antigravity = createAntigravityConnection({ scratchRoot: resolve(profileDir, '../../antigravity/calls'), appendAudit: fact => this.audit.append(fact) })
    this.browserExecutor = browserExecutor
    this.pendingExecutions = new Map()
    this.activeTasks = new Map()
    this.taskControllers = new Map()
    this.workerOwners = new Map()
    this.agentDiscoveries = new Map()
    this.agentDiscoveryInFlight = null
    this.specialistSecurity = new Map()
    this.mediaDispatchHistory = []
    this.activeMediaInvocations = 0
    this.suspended = false
    this.closing = false
    this.projectQueueBlocked = false
    // Explicit project review is the only source for task file evidence. A
    // workspace GET reads this bounded cache and never invokes Git itself.
    this.taskWorkspaceReviewCache = new Map()
    // Populated only by an explicit account-browser projection path. A task
    // GET never queries the broker because its state read expires/persists
    // leases; an empty cache is deliberately safer than inferred ownership.
    this.taskWorkspaceBrowserBindings = []
    this.taskEvidenceReceiptIssuers = new Map()
    this.taskEvidenceReceiptIssuerFactory = null
    this.taskOutcomeDeriver = null
    this.taskRecoveryClassifier = null
    this.taskEvidenceExecutorsWrapped = false
    this.taskArtifactExecutorsWrapped = false
    this.agentMutation = Promise.resolve()
    this.agentMutationDepth = 0
    this.agentContinuityLocks = new Map()
    this.agentReadinessInFlight = new Map()
    // One pure verification may be in flight for a binding at a time. A fresh
    // request id cannot be used to turn an unresolved effect into a retry.
    this.agentReadinessBindingInFlight = new Map()
    this.accountCompanion = new AccountCompanionRuntime(this)
  }

  async start() {
    const policy = JSON.parse(await readFile(POLICY_URL, 'utf8'))
    this.audit ??= await openRuntimeAudit({ filePath: this.auditFile })
    this.jevSettings ??= await JevSettings.open({ filePath: this.jevSettingsFile })
    this.openRouterSettings ??= await OpenRouterSettings.open({ filePath: this.openRouterSettingsFile })
    this.jevProvider = createJevModelRouter({ apiKeyForCall: () => this.jevSettings.apiKey(), fetchImpl: this.jevFetch })
    this.routingEvidence ??= await RoutingEvidenceStore.open({
      filePath: this.routingEvidenceFile,
      audit: this.audit,
      now: this.now,
    })
    this.browserInputAudit ??= await DurableFileAuditLog.open({ filePath: this.browserInputAuditFile })
    this.identityStore ??= await DurableIdentityStore.open({ filePath: this.identityFile })
    this.replayLedger ??= await GatewayReplayLedger.open({ filePath: this.replayFile })
    this.connectionMachineRef ??= await this.#loadConnectionMachineRef()
    this.connectionPolicy ??= await DurableConnectionPolicy.open({
      filePath: this.connectionFile,
      audit: this.audit,
      now: () => new Date(this.now()).toISOString(),
    })
    this.human = this.identityStore.getOrCreate(this.humanId)
    this.agent = this.identityStore.getOrCreate(this.agentId)
    this.operator = this.identityStore.getOrCreate('operator')
    this.gateway = new ChimeraGateway({
      policy,
      humanKeys: [[this.human.keyId, exportPublicKey(this.human.publicKey)]],
      audit: this.audit,
      replayLedger: this.replayLedger,
      now: this.now,
    })
    if (!this.teamTransport && process.env.CHIMERA_TEAM_TRANSPORT === 'ssh') {
      // SSH is an opt-in connector. A target is deliberately required; the
      // public checkout never guesses an operator host or credential path.
      const target = process.env.CHIMERA_TEAM_TARGET?.trim()
      if (target) this.teamTransport = new RemoteTeamTransport({
        target,
        port: Number(process.env.CHIMERA_TEAM_PORT ?? 2223),
        identityFile: process.env.CHIMERA_TEAM_IDENTITY_FILE ?? '/etc/chimera/team-auth/id_ed25519',
        knownHostsFile: process.env.CHIMERA_TEAM_KNOWN_HOSTS ?? '/etc/chimera/team-auth/known_hosts',
        allowedWorkspaceRoot: this.teamRemoteWorkspaceRoot,
      })
    }
    this.modelConfig = JSON.parse(await readFile(MODEL_ROUTING_URL, 'utf8'))
    this.modelConfig.openAiCompatibleProviders = [
      ...(this.modelConfig.openAiCompatibleProviders ?? []).filter(provider => provider.id !== 'openrouter'),
      { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1',
        apiKeyEnv: 'CHIMERA_OPENROUTER_SETTINGS_KEY',
        models: this.openRouterSettings.models().map(id => ({ id, name: id,
          capabilities: ['conversation', 'orchestration', 'coding', 'reasoning', 'research', 'bulk'],
          inputModalities: ['TEXT'], outputModalities: ['TEXT'] })) },
    ]
    if (!this.modelRegistry) await this.claudeCode.refresh()
    if (!this.codexAuth && !this.modelRegistry) this.codexAuth = new CodexAppServerAuth()
    let authState = null
    if (this.codexAuth) {
      try {
        authState = await this.codexAuth.read()
      } catch {
        authState = this.codexAuth.state()
      }
    }
    this.models = this.modelRegistry ?? await this.#openModelRegistry(authState)
    this.agentRegistry ??= await DurableAgentRegistry.open({
      filePath: this.agentFile,
      audit: this.audit,
      now: this.now,
    })
    this.mainAgentRegistry ??= await DurableAgentRegistry.open({
      filePath: this.mainAgentFile,
      audit: this.audit,
      now: this.now,
    })
    this.nativeReferenceProvider ??= await NativeAgentReferenceProvider.open({
      root: this.nativeAgentRoot,
      audit: this.audit,
    })
    this.agentCreationReceipts ??= await DurableAgentCreationReceipts.open({
      filePath: this.agentCreationReceiptFile,
    })
    this.agentContinuityRecords ??= await DurableAgentContinuityRecords.open({
      filePath: this.agentContinuityFile,
    })
    this.agentReadinessStore ??= await DurableAgentReadinessStore.open({
      filePath: this.agentReadinessFile,
      audit: this.audit,
      now: this.now,
    })
    this.connectionReceiptStore ??= await DurableVerificationReceiptStore.open({
      filePath: this.connectionReceiptFile,
      audit: this.audit,
      now: this.now,
    })
    for (const record of this.agentContinuityRecords.list()) this.agentContinuity.set(record.agentId, structuredClone(record))
    for (const receipt of this.agentCreationReceipts.list()) {
      const continuity = receipt.result?.continuity
      if (Array.isArray(continuity)) {
        const report = continuity.find((entry) => entry?.agentId === receipt.result?.agent?.agentId)
        if (report && !this.agentContinuity.has(report.agentId)) this.agentContinuity.set(report.agentId, structuredClone(report))
      }
    }
    this.agentAccessPolicy ??= await DurableAgentAccessPolicy.open({
      filePath: this.agentAccessFile,
      audit: this.audit,
      now: this.now,
    })
    this.agentModelPolicy ??= await DurableAgentModelPolicy.open({
      filePath: this.agentModelFile,
      audit: this.audit,
      now: this.now,
    })
    if (!this.workerRuntimeManager) {
      const workerSessions = await DurableWorkerSessionLedger.open({
        filePath: this.workerSessionFile,
        audit: this.audit,
        now: this.now,
      })
      const workerArtifacts = await WorkerArtifactStore.open({
        rootDir: this.workerArtifactRoot,
        audit: this.audit,
        now: this.now,
      })
      this.workerProvider ??= new AgentCoreWorkerProvider({
        region: process.env.CHIMERA_AWS_REGION ?? 'us-west-2',
      })
      this.workerRuntimeManager = new WorkerRuntimeManager({
        ledger: workerSessions,
        artifacts: workerArtifacts,
        provider: this.workerProvider,
        audit: this.audit,
        agentExists: (agentId) => agentId === this.agentId || this.#manifestForAgent(agentId) !== null,
        accessProfileFor: (agentId) => this.agentAccessPolicy.get(agentId).profileId,
        humanId: this.humanId,
        now: this.now,
      })
    }
    this.workerToolExecutors ??= createHarnessExecutors({
      accessProfileFor: (agentId) => this.agentAccessPolicy.get(agentId).profileId,
    })
    if (!this.githubProvider) {
      const repositories = resolveGitHubRepositories()
      if (repositories.length > 0) this.githubProvider = new GitHubCliProvider({ repositories })
    }
    if (this.githubProvider) {
      await this.githubProvider.refreshState()
      const githubExecutors = createGitHubToolExecutors({ provider: this.githubProvider })
      this.workerToolExecutors = {
        ...this.workerToolExecutors,
        ...Object.fromEntries(Object.entries(githubExecutors).map(([tool, executor]) => [tool, async (...args) => {
          this.connectionPolicy.assertEnabled('github')
          return executor(...args)
        }])),
      }
    }
    this.workerToolExecutors = {
      ...this.workerToolExecutors,
      ...this.workerRuntimeManager.executors(),
    }
    if (typeof this.workerRuntimeManager.reconcile === 'function') await this.workerRuntimeManager.reconcile()
    this.workerReaper = setInterval(() => {
      void this.workerRuntimeManager.reapExpired().catch((error) => {
        this.audit.append({
          kind: 'worker.runtime.reaper-failed',
          code: typeof error?.code === 'string' ? error.code : 'WORKER_REAPER_FAILED',
          at: new Date(this.now()).toISOString(),
        })
      })
    }, 30_000)
    this.workerReaper.unref?.()
    // Hermes backup targets require explicit env. Never fall back to a production vault bucket.
    this.agentReferenceProvider ??= createHermesReferenceProviderFromEnv()
    const persistedMainAgent = this.mainAgentRegistry.get('rj')
    if (persistedMainAgent) {
      this.mainAgentManifest = persistedMainAgent
      try {
        // Ask continuity may reopen only the runtime-owned local capsule. A
        // restart must not refresh Hermes/native references as a side effect of
        // merely reading state or answering a question.
        this.mainAgentWorkspace = await this.#openLocalWorkspaceFor(persistedMainAgent)
      } catch (error) {
        this.mainAgentWorkspace = null
        await Promise.resolve(this.audit.append({
          kind: 'agent.continuity.ask-unavailable',
          agentId: this.agentId,
          sourceType: persistedMainAgent.source?.type ?? 'unknown',
          failureCode: typeof error?.code === 'string' ? error.code : 'ASK_CONTINUITY_UNAVAILABLE',
          at: new Date(this.now()).toISOString(),
        })).catch(() => {})
      }
    }
    this.agentMailbox = await DurableAgentMailbox.open({
      filePath: this.mailboxFile,
      audit: this.audit,
      now: this.now,
    })
    // Startup interrupts root tasks; queued assignments have no current task
    // authority/resolver and must never be replayed just because they persisted.
    for (const row of this.agentMailbox.list().filter(row => row.status === 'pending' && row.type === 'task_handoff')) {
      await this.agentMailbox.interrupt({ agentId: row.agentId, messageId: row.messageId, reason: 'process-restarted' })
    }
    this.dshInventory = await loadDshEffectInventory()
    this.decisions = await DurableDecisionQueue.open({
      filePath: this.decisionFile,
      audit: this.audit,
      now: this.now,
    })
    await this.decisions.orphanPending('PROCESS_RESTARTED')
    this.tasks = await DurableTaskLedger.open({
      filePath: this.taskFile,
      audit: this.audit,
      now: this.now,
    })
    // Task 10 evidence/recovery modules are loaded after the durable task
    // ledger. If a legacy profile is opened before those modules are present,
    // selected-task reads remain conservative and explicitly unavailable.
    try {
      const ledgerModule = await import('../ceo/task-ledger.mjs')
      this.taskEvidenceReceiptIssuerFactory = typeof ledgerModule.createTaskEvidenceReceiptIssuer === 'function'
        ? ledgerModule.createTaskEvidenceReceiptIssuer
        : null
    } catch (error) {
      if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
    }
    try {
      const outcomeModule = await import('../ceo/task-outcomes.mjs')
      this.taskOutcomeDeriver = typeof outcomeModule.deriveTaskOutcomes === 'function' ? outcomeModule.deriveTaskOutcomes : null
    } catch (error) {
      if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
    }
    try {
      const recoveryModule = await import('../ceo/task-recovery.mjs')
      this.taskRecoveryClassifier = typeof recoveryModule.classifyTaskRecovery === 'function' ? recoveryModule.classifyTaskRecovery : null
    } catch (error) {
      if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
    }
    this.workerApprovalBroker = new WorkerToolApprovalBroker({
      queue: this.decisions,
      audit: this.audit,
      onPending: async (actionId, scope = {}) => {
        const taskId = scope?.taskId ?? null
        const nodeId = scope?.nodeId ?? null
        const assignmentId = scope?.assignmentId ?? null
        const canonicalAssignmentId = scope?.canonicalAssignmentId ?? null
        this.pendingExecutions.set(actionId, {
          kind: 'worker-tool',
          taskId,
          nodeId,
          assignmentId,
          canonicalAssignmentId,
        })
        // Only the canonical assignment owns its plan node. Peer approvals
        // carry the root/node for audit and human context, but cannot make a
        // parent node appear to be waiting or resolved.
        if (assignmentId === canonicalAssignmentId) {
          await this.#recordCanonicalApprovalStep(scope, 'waiting-for-approval', 'HUMAN_CONFIRMATION_REQUIRED')
        }
        if (taskId && this.taskControllers.get(taskId)?.signal.aborted) {
          await this.workerApprovalBroker.expire(actionId, 'TASK_CANCELLED')
          await this.decisions.cancel(actionId, 'TASK_CANCELLED')
        }
      },
      onResolved: async (actionId, scope = {}, result = {}) => {
        if (scope.assignmentId !== scope.canonicalAssignmentId) return
        const status = ['TASK_CANCELLED', 'PROCESS_STOPPED'].includes(result?.reason)
          ? 'cancelled'
          : 'running'
        await this.#recordCanonicalApprovalStep(scope, status, result?.reason ?? 'APPROVAL_RESOLVED')
        if (status === 'cancelled') this.pendingExecutions.delete(actionId)
      },
      now: this.now,
    })
    this.projectRegistry ??= await DurableProjectRegistry.open({
      filePath: this.projectFile,
      managedRoot: this.projectManagedRoot,
      allowedRoots: this.projectAllowedRoots,
      audit: this.audit,
      now: this.now,
    })
    this.projectSessions ??= await ProjectSessionManager.open({
      filePath: this.projectSessionFile,
      sessionRoot: this.projectSessionRoot,
      audit: this.audit,
      now: this.now,
    })
    this.taskAccessLeases ??= await DurableTaskAccessLeases.open({
      filePath: this.projectLeaseFile,
      audit: this.audit,
      now: this.now,
    })
    await this.taskAccessLeases.reapExpired()
    this.rjAwsConnector ??= createRjAwsConnector({
      config: this.rjAwsConfig === undefined ? rjAwsConfigFromEnv() : this.rjAwsConfig,
      identityFor: agentId => agentId === this.agentId
        ? this.agent
        : this.specialistSecurity.get(agentId)?.identity ?? null,
      humanIdentity: this.human,
      evidence: await RjAwsEvidence.open({ stateDir: resolve(this.profileDir, '../../rj-aws/requests') }),
      audit: this.audit,
      now: this.now,
      ...(this.rjAwsTransport ? { transport: this.rjAwsTransport } : {}),
      assertConnected: () => this.connectionPolicy.assertEnabled('rj-aws'),
    })
    for (const [tool, operation] of Object.entries(RJ_AWS_TOOLS)) {
      if (typeof this.rjAwsConnector.executors()[tool] !== 'function') continue
      this.workerToolExecutors[tool] = async (args, context) => {
        if (!context || !args || typeof args !== 'object' || Array.isArray(args)
          || Object.getPrototypeOf(args) !== Object.prototype || Object.keys(args).length !== 0) {
          throw Object.assign(new Error('RJ_AWS_ARGUMENTS_INVALID'), { code: 'RJ_AWS_ARGUMENTS_INVALID' })
        }
        this.connectionPolicy.assertEnabled('rj-aws')
        return this.rjAwsConnector.execute(operation, {
          agentId: context.agentId,
          taskId: context.taskId,
          assertActive: () => this.#rjAwsTaskAuthority(context),
        })
      }
    }
    this.connectionService ??= new ConnectionService({
      policy: this.connectionPolicy,
      adapters: this.#connectionAdapters(),
      machineRef: this.connectionMachineRef,
      now: () => new Date(this.now()).toISOString(),
      receiptStore: this.connectionReceiptStore,
    })
    try { this.cachedConnectionState = structuredClone(this.connectionState()) } catch { this.cachedConnectionState = [] }
    for (const session of this.projectSessions.list().filter((entry) => entry.status === 'working')) {
      const task = this.tasks.get(session.taskId)
      if (!task || !['submitted', 'running'].includes(task.status)) {
        await this.projectSessions.markOutcome(session.taskId, task?.status === 'completed' ? 'completed' : 'failed')
        this.#markTaskWorkspaceReviewStale(session.taskId, 'PROJECT_SESSION_RECONCILED')
        await this.taskAccessLeases.revokeTask(session.taskId, {
          reason: 'runtime-reconciled',
          revokedBy: this.agentId,
        })
      }
    }
    this.conversations = await DurableConversationLedger.open({
      filePath: this.conversationFile,
      audit: this.audit,
      now: this.now,
    })
    this.modelCalls = await DurableModelCallLedger.open({
      filePath: this.modelCallFile,
      audit: this.audit,
      now: this.now,
    })
    this.askService = new AskService({
      history: this.conversations,
      now: this.now,
      resolveInvocation: ({ recipientAgentId, requestId }) => this.#resolveAskInvocation({ recipientAgentId, requestId }),
    })
    this.modelSessions = await CodexSessionBindings.open({ filePath: this.modelSessionFile })
    this.decisionHandler = new HumanDecisionHandler({
      queue: this.decisions,
      gateway: this.gateway,
      humanIdentity: this.human,
      now: this.now,
    })
    this.grant = this.#createBrowserGrant()
    this.operatorGrant = this.#createOperatorGrant()
    this.browserAdapter = new OpenBotBrowserComputerAdapter({
      sessionId: 'browser-ceo-1',
      agentId: this.agentId,
      humanId: this.humanId,
      agentIdentity: this.agent,
      humanIdentity: this.human,
      grant: this.grant,
      gateway: this.gateway,
      audit: this.audit,
      realtimeAudit: this.browserInputAudit,
      profileDir: this.profileDir,
      executor: this.browserExecutor,
      now: this.now,
    })
    this.cachedBrowserState = await this.browserAdapter.start()
    await this.accountCompanion.start()
    this.workerToolExecutors = { ...this.workerToolExecutors, ...this.accountCompanion.executors() }
    this.#installTaskArtifactExecutors()
    this.#installTaskEvidenceExecutors()
    return this.state()
  }

  #createBrowserGrant() {
    return signGrant({
      grantId: `browser-grant-${crypto.randomUUID()}`,
      humanId: this.humanId,
      agentId: this.agentId,
      agentKeyFingerprint: fingerprint(this.agent.publicKey),
      maxTier: 'confirm',
      scopes: [
        { capability: 'browser.observe', resourcePrefix: 'browser:ceo:' },
        { capability: 'browser.navigate', resourcePrefix: 'browser:ceo:' },
        { capability: 'browser.interact', resourcePrefix: 'browser:ceo:' },
        { capability: 'browser.input', resourcePrefix: 'browser:ceo:' },
        { capability: 'model.invoke', resourcePrefix: 'model:openai-compatible:' },
        { capability: 'model.invoke', resourcePrefix: 'model:model-fabric:' },
        { capability: 'external.message', resource: 'telegram:chimera-hq' },
      ],
      ...isoWindow(this.now()),
    }, this.human)
  }

  #createOperatorGrant() {
    return signGrant({
      grantId: `operator-grant-${crypto.randomUUID()}`,
      humanId: this.humanId,
      agentId: 'operator',
      agentKeyFingerprint: fingerprint(this.operator.publicKey),
      maxTier: 'auto',
      scopes: [{ capability: 'agent.message.direct_message', resource: 'agent:ceo' }],
      ...isoWindow(this.now()),
    }, this.human)
  }

  #validateObjective(objective) {
    if (typeof objective !== 'string' || objective.trim().length === 0 || objective.length > 16_384) {
      throw new TypeError('TASK_OBJECTIVE_INVALID')
    }
    return objective.trim()
  }

  #admissionCandidate(requestId, operation, intent) {
    if (requestId === undefined || requestId === null) return null
    if (typeof requestId !== 'string' || requestId.length < 1 || requestId.length > 256) {
      throw Object.assign(new TypeError('TASK_ADMISSION_INVALID'), { code: 'TASK_ADMISSION_INVALID' })
    }
    const requestHash = sha256({ schema: 'chimera.task-admission-intent.v1', operation, intent: structuredClone(intent) })
    const existing = this.tasks?.getAdmission(requestId)
    if (existing) {
      if (existing.requestHash !== requestHash) throw Object.assign(new Error('TASK_ADMISSION_CONFLICT'), { code: 'TASK_ADMISSION_CONFLICT' })
      return { requestId, requestHash, existing, replay: true }
    }
    return { requestId, requestHash, replay: false }
  }

  async #reserveAdmission(candidate, operation, destination, { taskId = null, messageId = null, capturedDefaults = null } = {}) {
    if (!candidate) return null
    const receipt = await this.tasks.reserveAdmission({ requestId: candidate.requestId, requestHash: candidate.requestHash, operation, destination, taskId, messageId, capturedDefaults })
    return receipt
  }

  async #completeAdmission(candidate, status, pointers = {}) {
    if (!candidate) return null
    return this.tasks.completeAdmission({ requestId: candidate.requestId, status, ...pointers })
  }

  async #markAdmissionUncertain(candidate, pointers = {}) {
    if (!candidate) return
    const current = this.tasks.getAdmission(candidate.requestId)
    if (!current || current.status === 'failed' || current.status === 'unknown') return
    await this.#completeAdmission(candidate, 'unknown', {
      ...pointers,
      reason: 'ADMISSION_RECEIPT_UNCERTAIN',
    }).catch(() => {})
  }

  #taskBindsAdmission(taskId, candidate) {
    if (!candidate || !taskId) return false
    const task = this.tasks.get(taskId)
    return Boolean(task
      && task.admissionRequestId === candidate.requestId
      && task.admissionRequestHash === candidate.requestHash)
  }

  #replayAdmissionResult(receipt) {
    if (!receipt) return null
    const task = receipt.taskId ? this.tasks.get(receipt.taskId) : null
    const message = receipt.messageId ? this.conversations?.getMessage(receipt.messageId) ?? null : null
    if (task && message) return { schema: 'chimera.conversation-send-result.v2', message, task, receipt: structuredClone(receipt), replayed: true }
    if (task) return { ...task, receipt: structuredClone(receipt), replayed: true }
    if (message) return { message, receipt: structuredClone(receipt), replayed: true }
    return { schema: 'chimera.task-admission-receipt.v1', requestId: receipt.requestId, status: receipt.status, receipt: structuredClone(receipt), replayed: true }
  }

  #assertDestinationRevision(taskId, expectedDestinationRevision) {
    if (expectedDestinationRevision === undefined || expectedDestinationRevision === null) return
    if (!Number.isSafeInteger(expectedDestinationRevision) || expectedDestinationRevision < 0) {
      throw Object.assign(new TypeError('TASK_DESTINATION_REVISION_INVALID'), { code: 'TASK_DESTINATION_REVISION_INVALID' })
    }
    const current = this.tasks.get(taskId)
    if (!current) throw Object.assign(new Error('TASK_NOT_FOUND'), { code: 'TASK_NOT_FOUND' })
    if ((current.destinationRevision ?? 0) !== expectedDestinationRevision) {
      throw Object.assign(new Error('TASK_DESTINATION_STALE'), { code: 'TASK_DESTINATION_STALE' })
    }
  }

  #assertTaskAdmission({ allowActive = false, checkMutation = true } = {}) {
    this.#assertOpen()
    if (checkMutation && this.agentMutationDepth > 0) {
      const error = new Error('AGENT_MUTATION_IN_PROGRESS')
      error.code = 'AGENT_MUTATION_IN_PROGRESS'
      throw error
    }
    if (!allowActive && (this.tasks.active().length > 0 || this.activeTasks.size > 0)) {
      const error = new Error('TASK_ALREADY_RUNNING')
      error.code = 'TASK_ALREADY_RUNNING'
      throw error
    }
  }

  #assertOpen() {
    if (this.closing) throw Object.assign(new Error('PROCESS_STOPPED'), { code: 'PROCESS_STOPPED' })
  }

  #enqueueAgentMutation(operation) {
    this.agentMutationDepth += 1
    const run = this.agentMutation.then(operation)
    this.agentMutation = run.then(() => undefined, () => undefined)
    return run.finally(() => {
      this.agentMutationDepth -= 1
      if (this.agentMutationDepth === 0) this.#drainProjectQueue()
    })
  }

  #enqueueTaskAdmission(operation, { allowActive = false, requestId = null, requestHash = null } = {}) {
    // Admission is serialized with task lifecycle validation. A concurrent
    // exact replay must reach the same queue and resolve its durable receipt
    // before current active/revision checks can reject it.
    const existingBefore = requestId ? this.tasks.getAdmission(requestId) : null
    if (existingBefore && requestHash && existingBefore.requestHash !== requestHash) {
      throw Object.assign(new Error('TASK_ADMISSION_CONFLICT'), { code: 'TASK_ADMISSION_CONFLICT' })
    }
    if (!existingBefore) this.#assertTaskAdmission({ allowActive })
    const run = this.agentMutation.then(async () => {
      const existing = requestId ? this.tasks.getAdmission(requestId) : null
      if (existing && requestHash && existing.requestHash !== requestHash) {
        throw Object.assign(new Error('TASK_ADMISSION_CONFLICT'), { code: 'TASK_ADMISSION_CONFLICT' })
      }
      if (existing) return this.#replayAdmissionResult(existing)
      this.#assertTaskAdmission({ allowActive, checkMutation: false })
      return operation()
    })
    this.agentMutation = run.then(() => undefined, () => undefined)
    return run
  }

  #assertNoActiveAgentWork(code) {
    this.#assertOpen()
    if (this.activeTasks.size > 0 || this.tasks.active().length > 0) {
      throw Object.assign(new Error(code), { code })
    }
  }

  #drainProjectQueue({ admissionReserved = false } = {}) {
    if (this.closing || this.projectQueueBlocked || this.activeTasks.size > 0) return
    if (!admissionReserved && this.agentMutationDepth > 0) return
    const active = this.tasks.active()
    // Non-queue submissions may be between their durable submit and start.
    if (active.some(task => task.status === 'running' || !task.queuedForExecution)) return
    const next = active.find(task => task.status === 'queued' && !task.recoveryRequired)
    if (next) this.#startTask(next)
  }

  async resumeQueuedTask({ taskId, requestId, expectedDestinationRevision } = {}) {
    const intent = {
      taskId: taskId ?? null,
      expectedDestinationRevision: expectedDestinationRevision ?? null,
    }
    const candidate = this.#admissionCandidate(requestId, 'resume-queued', intent)
    if (candidate?.replay) return this.#replayAdmissionResult(candidate.existing)
    return this.#enqueueTaskAdmission(async () => {
      if (this.projectQueueBlocked) throw Object.assign(new Error('TASK_QUEUE_CLEANUP_REQUIRED'), { code: 'TASK_QUEUE_CLEANUP_REQUIRED' })
      const current = this.tasks.get(taskId)
      if (!current) throw Object.assign(new Error('TASK_NOT_FOUND'), { code: 'TASK_NOT_FOUND' })
      const scope = current.context?.projectId ? 'project' : 'root'
      const boundRevision = expectedDestinationRevision ?? current.destinationRevision ?? 0
      const destination = { scope, taskId, expectedDestinationRevision: boundRevision }
      let admission
      try {
        admission = await this.#reserveAdmission(candidate, 'resume-queued', destination, { taskId })
        if (admission?.replayed) return this.#replayAdmissionResult(admission)
        const record = await this.tasks.resumeQueued(taskId, {
          ...(candidate ? { requestId: candidate.requestId, requestHash: candidate.requestHash } : {}),
          expectedDestinationRevision: boundRevision,
        })
        let receipt
        try {
          receipt = await this.#completeAdmission(candidate, 'accepted', { taskId })
        } catch (error) {
          await this.#markAdmissionUncertain(candidate, { taskId })
          throw error
        }
        this.#drainProjectQueue({ admissionReserved: true })
        return { ...record, ...(receipt ? { receipt } : {}) }
      } catch (error) {
        const durableAdmission = candidate ? this.tasks.getAdmission(candidate.requestId) : null
        const durableRecord = this.tasks.get(taskId)
        const effectMatches = this.#taskEffectMatchesAdmission(durableRecord, durableAdmission, durableAdmission?.destination)
        if (effectMatches || durableAdmission?.status === 'accepted') {
          await this.#markAdmissionUncertain(candidate, { taskId })
          this.#drainProjectQueue({ admissionReserved: true })
        } else if (durableAdmission && durableAdmission.status === 'reserved' && !admission?.replayed) {
          const code = safeTaskFailure(error).code
          const deterministicFailure = ['TASK_DESTINATION_REVISION_INVALID', 'TASK_DESTINATION_STALE', 'TASK_NOT_QUEUED', 'TASK_QUEUE_CLEANUP_REQUIRED'].includes(code)
          await this.#completeAdmission(candidate, deterministicFailure ? 'failed' : 'unknown', { taskId, reason: code }).catch(() => {})
        } else if (admission && !admission.replayed) {
          await this.#completeAdmission(candidate, 'failed', { taskId, reason: safeTaskFailure(error).code }).catch(() => {})
        }
        throw error
      }
    }, { allowActive: true, requestId: candidate?.requestId, requestHash: candidate?.requestHash })
  }

  async submitTask({ objective, budget, queue = false, requestId, requestedSpecialistAgentId = null, conversationId = null, requirements } = {}) {
    const normalizedRequirements = requirements === undefined ? undefined : normalizeTaskRequirements(requirements)
    const intent = {
      objective: typeof objective === 'string' ? objective.trim() : objective ?? null,
      budget: budget ?? null,
      queue: queue === true,
      requestedSpecialistAgentId: requestedSpecialistAgentId ?? null,
      conversationId: conversationId ?? null,
      // Preserve the pre-Task6 admission shape for callers that omitted
      // requirements.  `null` is a different canonical intent and would
      // make an accepted legacy request conflict after restart.
      ...(normalizedRequirements ? { requirements: normalizedRequirements } : {}),
    }
    const candidate = this.#admissionCandidate(requestId, 'new-task', intent)
    if (candidate?.replay) return this.#replayAdmissionResult(candidate.existing)
    const normalizedObjective = this.#validateObjective(objective)
    const normalizedBudget = normalizeTaskBudget(budget)
    return this.#enqueueTaskAdmission(async () => {
      if (requestedSpecialistAgentId !== null && (typeof requestedSpecialistAgentId !== 'string' || !this.#manifestForAgent(requestedSpecialistAgentId))) {
        throw Object.assign(new Error('CHAT_RECIPIENT_NOT_REGISTERED'), { code: 'CHAT_RECIPIENT_NOT_REGISTERED' })
      }
      const selected = this.models.state().selected
      const taskId = `task-${crypto.randomUUID()}`
      const destination = { scope: 'root', ...(conversationId ? { conversationId } : {}), ...(requestedSpecialistAgentId ? { requestedSpecialistAgentId } : {}) }
      let admission
      let record = null
      try {
        admission = await this.#reserveAdmission(candidate, 'new-task', destination, {
          taskId,
          capturedDefaults: { budget: normalizedBudget, model: selected ? { providerId: selected.providerId, model: selected.model } : null,
            ...(normalizedRequirements ? { requirements: normalizedRequirements } : {}) },
        })
        if (admission?.replayed) return this.#replayAdmissionResult(admission)
        record = await this.tasks.submit({
          taskId,
          objective: normalizedObjective,
          model: selected ? { providerId: selected.providerId, model: selected.model } : null,
          context: { budget: normalizedBudget, ...(normalizedRequirements ? { requirements: normalizedRequirements } : {}), ...(queue === true ? { queueScope: 'root' } : {}),
            ...(requestedSpecialistAgentId ? { requestedSpecialistAgentId } : {}), ...(conversationId ? { conversationId } : {}) },
          queue: queue === true,
          ...(candidate ? { admissionRequestId: candidate.requestId, admissionRequestHash: candidate.requestHash } : {}),
        })
        const receipt = await this.#completeAdmission(candidate, 'accepted', { taskId })
        if (queue === true) this.#drainProjectQueue({ admissionReserved: true })
        else this.#startTask(record)
        return { ...record, receipt }
      } catch (error) {
        if (record || this.#taskBindsAdmission(taskId, candidate)) await this.#markAdmissionUncertain(candidate, { taskId })
        else if (admission && !admission.replayed) await this.#completeAdmission(candidate, 'failed', { taskId, reason: safeTaskFailure(error).code }).catch(() => {})
        throw error
      }
    }, { allowActive: queue === true, requestId: candidate?.requestId, requestHash: candidate?.requestHash })
  }

  // Called only after explicit authenticated operator intake handoff. A committed
  // task is returned even after interrupted restart; retries never restart it.
  submitIntakeTask({ taskId, objective, budget } = {}) {
    if (typeof taskId !== 'string' || !/^intake-[a-f0-9]{40}$/.test(taskId)) return Promise.reject(Object.assign(new Error('CLIENT_INTAKE_INVALID'), { code: 'CLIENT_INTAKE_INVALID' }))
    this.intakeSubmissions ??= new Map()
    const pending = this.intakeSubmissions.get(taskId)
    if (pending) {
      if (pending.objective !== objective) return Promise.reject(Object.assign(new Error('CLIENT_INTAKE_CONFLICT'), { code: 'CLIENT_INTAKE_CONFLICT' }))
      return pending.promise
    }
    this.#assertOpen()
    const existing = this.tasks.get(taskId)
    if (existing) {
      const comparableObjective = typeof objective === 'string' ? objective.trim() : objective
      if (existing.objective !== comparableObjective) return Promise.reject(Object.assign(new Error('CLIENT_INTAKE_CONFLICT'), { code: 'CLIENT_INTAKE_CONFLICT' }))
      // A durable intake receipt is idempotent even when unrelated work is
      // active. Do not normalize a new budget or reserve a second admission
      // for a task that already exists.
      return Promise.resolve(existing)
    }
    const promise = (async () => {
      const normalizedObjective = this.#validateObjective(objective)
      const normalizedBudget = normalizeTaskBudget(budget)
      return this.#enqueueTaskAdmission(async () => {
        const selected = this.models.state().selected
        const record = await this.tasks.submit({ taskId, objective: normalizedObjective,
          model: selected ? { providerId: selected.providerId, model: selected.model } : null,
          context: { budget: normalizedBudget, source: 'client-intake' } })
        this.#startTask(record)
        return record
      })
    })().finally(() => this.intakeSubmissions.delete(taskId))
    this.intakeSubmissions.set(taskId, { objective, promise })
    return promise
  }

  async registerProject({ mode, name, path, networkHosts = [] } = {}) {
    if (mode === 'local') return this.projectRegistry.registerLocal({ name, path, networkHosts })
    if (mode === 'managed') return this.projectRegistry.createManaged({ name, networkHosts })
    throw Object.assign(new TypeError('PROJECT_INTAKE_MODE_INVALID'), { code: 'PROJECT_INTAKE_MODE_INVALID' })
  }

  async submitProjectTask({ projectId, objective, access = {}, budget, requestId, requirements } = {}) {
    const normalizedRequirements = requirements === undefined ? undefined : normalizeTaskRequirements(requirements)
    const intent = { projectId: projectId ?? null, objective: typeof objective === 'string' ? objective.trim() : objective ?? null, access: structuredClone(access ?? {}), budget: budget ?? null,
      ...(normalizedRequirements ? { requirements: normalizedRequirements } : {}) }
    const candidate = this.#admissionCandidate(requestId, 'project-task', intent)
    if (candidate?.replay) return this.#replayAdmissionResult(candidate.existing)
    const normalizedObjective = this.#validateObjective(objective)
    const normalizedBudget = normalizeTaskBudget(budget)
    this.#assertOpen()
    if (this.agentMutationDepth > 0) {
      const error = new Error('AGENT_MUTATION_IN_PROGRESS')
      error.code = 'AGENT_MUTATION_IN_PROGRESS'
      throw error
    }
    if (this.projectQueueBlocked) throw Object.assign(new Error('TASK_QUEUE_CLEANUP_REQUIRED'), { code: 'TASK_QUEUE_CLEANUP_REQUIRED' })
    const project = this.projectRegistry.get(projectId)
    if (!project) throw Object.assign(new Error('PROJECT_NOT_FOUND'), { code: 'PROJECT_NOT_FOUND' })
    const accessRequest = {
      profileId: access.profileId ?? 'sandbox',
      networkHosts: access.networkHosts ?? [],
      ttlSeconds: access.ttlSeconds ?? 900,
    }
    if (!AGENT_ACCESS_PROFILES[accessRequest.profileId]
      || !Array.isArray(accessRequest.networkHosts)
      || !Number.isSafeInteger(accessRequest.ttlSeconds)
      || accessRequest.ttlSeconds < 300
      || accessRequest.ttlSeconds > 3600) {
      throw Object.assign(new TypeError('PROJECT_TASK_ACCESS_INVALID'), { code: 'PROJECT_TASK_ACCESS_INVALID' })
    }
    const requestedHosts = [...new Set(accessRequest.networkHosts.map((value) => (
      typeof value === 'string' ? value.trim().toLowerCase().replace(/\.$/, '') : value
    )))]
    if (accessRequest.profileId === 'sandbox' && requestedHosts.length > 0) {
      throw Object.assign(new TypeError('PROJECT_TASK_ACCESS_INVALID'), { code: 'PROJECT_TASK_ACCESS_INVALID' })
    }
    const approvedHosts = new Set(project.networkHosts)
    if (requestedHosts.some((host) => typeof host !== 'string' || !approvedHosts.has(host))) {
      throw Object.assign(new Error('PROJECT_ACCESS_HOST_NOT_APPROVED'), { code: 'PROJECT_ACCESS_HOST_NOT_APPROVED' })
    }
    accessRequest.networkHosts = requestedHosts
    return this.#enqueueTaskAdmission(async () => {
      const selected = this.models.state().selected
      const taskId = `task-${crypto.randomUUID()}`
      let admission
      let record = null
      try {
        admission = await this.#reserveAdmission(candidate, 'project-task', { scope: 'project', projectId }, {
          taskId, capturedDefaults: { budget: normalizedBudget, model: selected ? { providerId: selected.providerId, model: selected.model } : null, accessRequest,
            ...(normalizedRequirements ? { requirements: normalizedRequirements } : {}) },
        })
        if (admission?.replayed) return this.#replayAdmissionResult(admission)
        record = await this.tasks.submit({
          taskId,
          objective: normalizedObjective,
          model: selected ? { providerId: selected.providerId, model: selected.model } : null,
          context: { projectId, projectSessionTaskId: taskId, budget: normalizedBudget, accessRequest,
            ...(normalizedRequirements ? { requirements: normalizedRequirements } : {}) },
          queue: true,
          ...(candidate ? { admissionRequestId: candidate.requestId, admissionRequestHash: candidate.requestHash } : {}),
        })
        const receipt = await this.#completeAdmission(candidate, 'accepted', { taskId })
        this.#drainProjectQueue({ admissionReserved: true })
        return { ...record, receipt }
      } catch (error) {
        if (record || this.#taskBindsAdmission(taskId, candidate)) await this.#markAdmissionUncertain(candidate, { taskId })
        else if (admission && !admission.replayed) await this.#completeAdmission(candidate, 'failed', { taskId, reason: safeTaskFailure(error).code }).catch(() => {})
        throw error
      }
    }, { allowActive: true, requestId: candidate?.requestId, requestHash: candidate?.requestHash })
  }

  #taskRevisionFromObservation(review, identity = null, taskId = null) {
    const checkoutCommit = typeof identity?.checkoutCommit === 'string'
      ? identity.checkoutCommit
      : typeof review?.checkoutCommit === 'string' ? review.checkoutCommit : null
    const baseCommit = typeof review?.baseCommit === 'string' ? review.baseCommit : identity?.baseCommit ?? null
    const branch = typeof review?.branch === 'string' ? review.branch : identity?.preparedBranch ?? null
    if (!checkoutCommit || !baseCommit || !branch || typeof review?.patch !== 'string') return null
    const changedFiles = Array.isArray(review.changedFiles)
      ? review.changedFiles.slice(0, 256).map(file => ({
        path: typeof file?.path === 'string' ? file.path : null,
        status: typeof file?.status === 'string' ? file.status : null,
      }))
      : []
    const patchDigest = sha256(review.patch)
    const contentDigest = sha256({ baseCommit, checkoutCommit, branch, changedFiles, patchDigest })
    const observedTaskId = typeof taskId === 'string' ? taskId : typeof review?.taskId === 'string' ? review.taskId : 'unknown'
    const relativeRoot = typeof identity?.relativeRoot === 'string' && identity.relativeRoot.length <= 512
      ? identity.relativeRoot
      : 'task-workspace'
    return {
      contentDigest,
      checkoutCommit,
      baseCommit,
      branch,
      scope: `task:${observedTaskId}/workspace:${relativeRoot}`,
      contentScope: {
        changedFiles,
        patchDigest,
      },
    }
  }

  #taskEvidenceIssuer(taskId, source) {
    if (typeof this.taskEvidenceReceiptIssuerFactory !== 'function' || typeof taskId !== 'string' || typeof source !== 'string') return null
    const key = `${taskId}:${source}`
    const current = this.taskEvidenceReceiptIssuers.get(key)
    if (current) return current
    const issuer = this.taskEvidenceReceiptIssuerFactory({ taskId, source, now: this.now })
    if (!issuer || typeof issuer.issue !== 'function') return null
    this.taskEvidenceReceiptIssuers.set(key, issuer)
    return issuer
  }

  async #recordTaskEvidence(taskId, { kind, source, operationId, revision, outcome, evidenceRef }) {
    if (typeof this.tasks?.recordEvidence !== 'function' || typeof this.tasks?.listEvidence !== 'function') return null
    const prior = this.tasks.listEvidence(taskId).find(receipt => receipt?.kind === kind && receipt?.operationId === operationId)
    if (prior) return structuredClone(prior)
    const issuer = this.#taskEvidenceIssuer(taskId, source)
    if (!issuer) return null
    const receipt = issuer.issue({ receiptId: `task-evidence-${crypto.randomUUID()}`, kind, operationId, revision, outcome, evidenceRef })
    if (!receipt) return null
    await this.tasks.recordEvidence(taskId, receipt)
    return structuredClone(receipt)
  }

  #taskOutcomeProjection(task, review) {
    if (typeof this.taskOutcomeDeriver !== 'function') return { status: 'unavailable', reason: 'TASK_OUTCOMES_NOT_LOADED', taskId: task.taskId }
    const receipts = typeof this.tasks?.listEvidence === 'function' ? this.tasks.listEvidence(task.taskId) : []
    try {
      return this.taskOutcomeDeriver({
        task: structuredClone(task),
        receipts,
        review: review ? structuredClone(review) : null,
        currentRevision: this.#taskRevisionFromObservation(review, review?.identity ?? null, task.taskId),
      })
    } catch (error) {
      this.audit?.append?.({ kind: 'ceo.task.outcome.projection-failed', taskId: task.taskId,
        code: typeof error?.code === 'string' ? error.code : 'TASK_OUTCOME_PROJECTION_FAILED', at: new Date(this.now()).toISOString() })
      return { status: 'unavailable', reason: 'TASK_OUTCOME_PROJECTION_FAILED', taskId: task.taskId }
    }
  }

  #taskRecoveryProjection(task) {
    if (typeof this.taskRecoveryClassifier !== 'function') return { status: 'unavailable', reason: 'TASK_RECOVERY_NOT_LOADED', taskId: task.taskId }
    const modelCalls = typeof this.modelCalls?.listByTask === 'function' ? this.modelCalls.listByTask(task.taskId) : []
    const approvals = (this.decisions?.all?.() ?? []).filter(row => row?.taskId === task.taskId)
    const cleanup = task.checkpoint?.stage === 'cleanup-failed' ? structuredClone(task.checkpoint) : null
    try {
      return this.taskRecoveryClassifier({
        task: structuredClone(task),
        modelCalls,
        steps: structuredClone(task.steps ?? []),
        approvals,
        connection: this.#taskConnectionProjection(task),
        cleanup,
      })
    } catch (error) {
      this.audit?.append?.({ kind: 'ceo.task.recovery.projection-failed', taskId: task.taskId,
        code: typeof error?.code === 'string' ? error.code : 'TASK_RECOVERY_PROJECTION_FAILED', at: new Date(this.now()).toISOString() })
      return { status: 'unavailable', reason: 'TASK_RECOVERY_PROJECTION_FAILED', taskId: task.taskId }
    }
  }

  #taskConnectionProjection(task) {
    const providerId = task?.routing?.selected?.providerId
    if (typeof providerId !== 'string' || !Array.isArray(this.cachedConnectionState)) return null
    const connection = this.cachedConnectionState.find(row => row?.providerId === providerId)
    if (!connection) return null
    const connected = connection.enabled !== false
      && ['verified', 'signed-in', 'available'].includes(connection.status)
    return {
      status: connected ? 'connected' : 'disconnected',
      connected,
      // The public connection adapters expose reconnect/test operations, not a
      // provider effect reconciliation operation. Never infer reconciliation
      // support from a provider label or a task-controlled field.
      supportsReconciliation: connection.operations?.reconcile === true,
    }
  }

  #installTaskEvidenceExecutors() {
    const toolName = typeof this.workerToolExecutors?.['mcp__chimera_worker__bash'] === 'function'
      ? 'mcp__chimera_worker__bash'
      : typeof this.workerToolExecutors?.bash === 'function' ? 'bash' : null
    if (this.taskEvidenceExecutorsWrapped || !toolName) return
    const original = this.workerToolExecutors[toolName]
    this.workerToolExecutors[toolName] = async (args, context) => {
      if (!context?.taskScoped || typeof context.taskId !== 'string' || typeof context.workspace?.readProjectIdentity !== 'function') return original(args, context)
      const task = this.tasks?.get?.(context.taskId)
      if (!task) return original(args, context)
      const command = typeof args?.command === 'string' ? args.command : 'bounded check'
      const operationId = `check:${typeof context.callId === 'string' ? context.callId : crypto.randomUUID()}`
      const executionScope = `worker:${typeof context.agentId === 'string' ? context.agentId : 'unknown'}/scratch`
      const scopedExecution = revision => `${revision.scope}|execution:${executionScope}`
      let beforeIdentity
      let beforeReview
      let beforeRevision
      try {
        const sessionTaskId = task.context?.projectSessionTaskId ?? context.taskId
        beforeIdentity = await context.workspace.readProjectIdentity()
        beforeReview = await this.projectSessions.review(sessionTaskId)
        beforeRevision = this.#taskRevisionFromObservation(beforeReview, beforeIdentity, context.taskId)
      } catch (error) {
        this.audit?.append?.({ kind: 'ceo.task.check.before-observation-unavailable', taskId: context.taskId,
          code: typeof error?.code === 'string' ? error.code : 'TASK_CHECK_BEFORE_OBSERVATION_UNAVAILABLE', at: new Date(this.now()).toISOString() })
      }
      let result
      try {
        result = await original(args, context)
      } catch (error) {
        if (beforeRevision) {
          await this.#recordTaskEvidence(context.taskId, {
            kind: 'check',
            source: 'bounded-check',
            operationId,
            revision: beforeRevision,
            outcome: {
              status: 'unknown',
              command,
              scope: scopedExecution(beforeRevision),
              signal: 'outcome-unknown',
              reason: 'CHECK_EXECUTOR_OUTCOME_UNKNOWN',
            },
            evidenceRef: `task:${context.taskId}:check:${operationId}`,
          }).catch(() => null)
        }
        throw error
      }
      try {
        if (!beforeRevision) return result
        const sessionTaskId = task.context?.projectSessionTaskId ?? context.taskId
        const afterIdentity = await context.workspace.readProjectIdentity()
        const afterReview = await this.projectSessions.review(sessionTaskId)
        const afterRevision = this.#taskRevisionFromObservation(afterReview, afterIdentity, context.taskId)
        const sameContent = Boolean(afterRevision
          && beforeRevision.contentDigest === afterRevision.contentDigest
          && beforeRevision.checkoutCommit === afterRevision.checkoutCommit
          && beforeRevision.baseCommit === afterRevision.baseCommit
          && beforeRevision.branch === afterRevision.branch)
        const revision = afterRevision ?? beforeRevision
        if (!revision) return result
        const status = sameContent
          ? result?.exitCode === 0 && (result?.signal === null || result?.signal === undefined) ? 'passed' : 'failed'
          : 'unknown'
        const receipt = await this.#recordTaskEvidence(context.taskId, {
          kind: 'check',
          source: 'bounded-check',
          operationId,
          revision,
          outcome: {
            status,
            command,
            scope: scopedExecution(revision),
            exitCode: Number.isSafeInteger(result?.exitCode) ? result.exitCode : null,
            signal: result?.signal ?? null,
            outputDigest: sha256({ stdout: result?.stdout ?? '', stderr: result?.stderr ?? '' }),
            ...(!sameContent ? { reason: 'PROJECT_CONTENT_CHANGED_DURING_CHECK' } : {}),
          },
          evidenceRef: `task:${context.taskId}:check:${sha256({ operationId, revision }).slice(0, 32)}`,
        })
        return receipt ? { ...result, evidenceReceiptId: receipt.receiptId } : result
      } catch (error) {
        this.audit?.append?.({ kind: 'ceo.task.check.receipt-unavailable', taskId: context.taskId,
          code: typeof error?.code === 'string' ? error.code : 'TASK_CHECK_RECEIPT_UNAVAILABLE', at: new Date(this.now()).toISOString() })
        return result
      }
    }
    this.taskEvidenceExecutorsWrapped = true
  }

  #installTaskArtifactExecutors() {
    if (this.taskArtifactExecutorsWrapped || !this.workerRuntimeManager?.artifacts || !this.workerToolExecutors) return
    try {
      this.workerToolExecutors = wrapTaskArtifactExecutors({
        executors: this.workerToolExecutors,
        artifactStore: this.workerRuntimeManager.artifacts,
        recordEvidence: (taskId, receipt) => this.#recordTaskEvidence(taskId, receipt),
      })
      this.taskArtifactExecutorsWrapped = true
    } catch (error) {
      this.audit?.append?.({
        kind: 'ceo.task.artifact-evidence-unavailable',
        code: typeof error?.code === 'string' ? error.code : 'TASK_ARTIFACT_EVIDENCE_UNAVAILABLE',
        at: new Date(this.now()).toISOString(),
      })
    }
  }

  #markTaskWorkspaceReviewStale(taskId, reason) {
    if (!this.taskWorkspaceReviewCache?.size) return
    const selected = this.tasks?.get?.(taskId)
    const sessionTaskId = selected?.context?.projectSessionTaskId ?? taskId
    const taskIds = new Set([taskId, sessionTaskId])
    for (const entry of this.tasks?.list?.() ?? []) {
      if (entry?.context?.projectSessionTaskId === sessionTaskId && typeof entry.taskId === 'string') taskIds.add(entry.taskId)
    }
    for (const [key, review] of this.taskWorkspaceReviewCache.entries()) {
      if (!taskIds.has(key) && !taskIds.has(review?.taskId)) continue
      this.taskWorkspaceReviewCache.set(key, structuredClone({ ...review, stale: true, staleReason: reason }))
    }
  }

  async projectReview(taskId) {
    const task = this.tasks.get(taskId)
    if (!task) throw Object.assign(new Error('TASK_NOT_FOUND'), { code: 'TASK_NOT_FOUND' })
    const sessionTaskId = task.context?.projectSessionTaskId ?? taskId
    const review = await this.projectSessions.review(sessionTaskId)
    const observedAt = new Date(this.now()).toISOString()
    const identity = typeof this.projectSessions.identityReceipt === 'function'
      ? await this.projectSessions.identityReceipt(sessionTaskId)
      : null
    const revision = this.#taskRevisionFromObservation(review, identity, taskId)
    const retained = { ...review, taskId, observedAt, stale: false,
      ...(identity ? { identity } : {}), ...(revision ? { revision } : {}) }
    if (revision) {
      await this.#recordTaskEvidence(taskId, {
        kind: 'review',
        source: 'project-review',
        operationId: `review:${review.reviewDigest}`,
        revision,
        outcome: {
          status: review.status === 'completed' ? 'current' : 'observed',
          reviewDigest: review.reviewDigest,
          identity: {
            checkoutCommit: identity?.checkoutCommit ?? revision.checkoutCommit,
            baseCommit: identity?.baseCommit ?? revision.baseCommit,
            branch: identity?.preparedBranch ?? revision.branch,
            hasWorkingTreeChanges: identity?.hasWorkingTreeChanges === true,
          },
          contentScope: revision.contentScope,
          scope: revision.scope,
        },
        evidenceRef: `task:${taskId}:review:${review.reviewDigest}`,
      })
    }
    this.taskWorkspaceReviewCache.set(taskId, structuredClone(retained))
    if (sessionTaskId !== taskId) this.taskWorkspaceReviewCache.set(sessionTaskId, structuredClone({ ...retained, taskId: sessionTaskId }))
    return review
  }

  async commitProjectSession({ taskId, message, expectedReviewDigest } = {}) {
    const result = await this.projectSessions.commit({ taskId: this.tasks.get(taskId)?.context?.projectSessionTaskId ?? taskId, message, expectedReviewDigest, committedBy: this.humanId })
    this.#markTaskWorkspaceReviewStale(taskId, 'PROJECT_COMMIT_ACCEPTED')
    return result
  }

  async sendMessage({ content, recipientAgentId = this.agentId, budget, requestId, requirements } = {}) {
    const normalizedRequirements = requirements === undefined ? undefined : normalizeTaskRequirements(requirements)
    const intent = { content: typeof content === 'string' ? content.trim() : content ?? null, recipientAgentId, budget: budget ?? null,
      ...(normalizedRequirements ? { requirements: normalizedRequirements } : {}) }
    const candidate = this.#admissionCandidate(requestId, 'send-message', intent)
    if (candidate?.replay) return this.#replayAdmissionResult(candidate.existing)
    const objective = this.#validateObjective(content)
    const normalizedBudget = normalizeTaskBudget(budget)
    return this.#enqueueTaskAdmission(async () => {
      const requestedSpecialistAgentId = recipientAgentId === this.agentId ? null : recipientAgentId
      if (requestedSpecialistAgentId && !this.#manifestForAgent(requestedSpecialistAgentId)) {
        throw Object.assign(new Error('CHAT_RECIPIENT_NOT_REGISTERED'), { code: 'CHAT_RECIPIENT_NOT_REGISTERED' })
      }
      const conversationId = requestedSpecialistAgentId ? `agent:${requestedSpecialistAgentId}` : 'main'
      const taskId = `task-${crypto.randomUUID()}`
      const messageId = `message-${crypto.randomUUID()}`
      const selected = this.models.state().selected
      let admission
      let durableTask = false
      let durableMessage = false
      try {
        admission = await this.#reserveAdmission(candidate, 'send-message', { conversationId, recipientAgentId }, {
          taskId, messageId, capturedDefaults: { budget: normalizedBudget, model: selected ? { providerId: selected.providerId, model: selected.model } : null,
            ...(normalizedRequirements ? { requirements: normalizedRequirements } : {}) },
        })
        if (admission?.replayed) return this.#replayAdmissionResult(admission)
        const record = await this.tasks.submit({
          taskId,
          objective,
          model: selected ? { providerId: selected.providerId, model: selected.model } : null,
          context: { conversationId, requestedSpecialistAgentId, budget: normalizedBudget,
            ...(normalizedRequirements ? { requirements: normalizedRequirements } : {}) },
          ...(candidate ? { admissionRequestId: candidate.requestId, admissionRequestHash: candidate.requestHash } : {}),
        })
        durableTask = true
        const message = await this.conversations.append({
          messageId,
          conversationId,
          senderAgentId: this.humanId,
          recipientAgentIds: [recipientAgentId],
          kind: 'message',
          content: objective,
          taskId,
          ...(candidate ? { requestId: candidate.requestId, requestHash: candidate.requestHash } : {}),
          provenance: { verification: 'human', source: 'team-chat-composer' },
        })
        durableMessage = true
        const receipt = await this.#completeAdmission(candidate, 'accepted', { taskId, messageId })
        this.#startTask(record, { conversationId, replyTo: messageId, requestedSpecialistAgentId })
        return { schema: 'chimera.conversation-send-result.v2', message, task: record, receipt }
      } catch (error) {
        const taskBound = durableTask || this.#taskBindsAdmission(taskId, candidate)
        // The task record is durable, but the paired message may not be. Keep
        // the admission reconcilable instead of converting a post-publish
        // audit failure into a retryable task failure.
        if (taskBound || durableMessage) await this.#markAdmissionUncertain(candidate, { taskId, messageId })
        else if (admission && !admission.replayed) await this.#completeAdmission(candidate, 'failed', { taskId, messageId, reason: safeTaskFailure(error).code }).catch(() => {})
        throw error
      }
    }, { requestId: candidate?.requestId, requestHash: candidate?.requestHash })
  }

  async ask(input) {
    if (!this.askService) throw Object.assign(new Error('RUNTIME_NOT_STARTED'), { code: 'RUNTIME_NOT_STARTED' })
    return this.askService.ask(input)
  }

  async askStatus(requestId) {
    if (!this.askService) throw Object.assign(new Error('RUNTIME_NOT_STARTED'), { code: 'RUNTIME_NOT_STARTED' })
    return this.askService.status(requestId)
  }

  #executorCapabilityFor(manifest) {
    const agentId = manifest?.agentId ?? this.agentId
    const taskBound = Boolean(manifest && hasTaskHarness(manifest))
    if (!taskBound) {
      return {
        schema: 'chimera.executor-capability.v1',
        kind: 'runtime-inference',
        status: 'ready',
        identity: 'chimera.runtime.inference.v1',
        binding: 'runtime-owned',
        requiresTask: false,
        presence: 'present',
      }
    }
    const worker = this.workers.get(agentId)
    const workerState = worker?.status?.().state ?? 'not-open'
    const taskId = this.workerOwners.get(agentId) ?? null
    return {
      schema: 'chimera.executor-capability.v1',
      kind: 'runtime-task-harness',
      status: 'task-bound',
      identity: 'chimera.runtime.task-harness.v1',
      binding: taskId ? 'bound' : 'unbound',
      requiresTask: true,
      presence: workerState,
      ...(taskId ? { taskId } : {}),
    }
  }

  async #readinessSnapshot(agentId) {
    if (typeof agentId !== 'string' || !AGENT_ID.test(agentId)) {
      throw Object.assign(new TypeError('AGENT_ID_INVALID'), { code: 'AGENT_ID_INVALID' })
    }
    const isMain = agentId === this.agentId
    const manifest = isMain ? this.mainAgentManifest : this.#manifestForAgent(agentId)
    if (!isMain && !manifest) throw Object.assign(new Error('AGENT_NOT_REGISTERED'), { code: 'AGENT_NOT_REGISTERED' })
    const readinessManifest = structuredClone(isMain
      ? (manifest ?? {
          ...DEFAULT_RESEARCHER_MANIFEST,
          agentId: this.agentId,
          displayName: 'RJ',
          role: 'CEO and main orchestrator',
          source: { type: 'chimera', sourceId: 'built-in', ref: 'chimera://built-in/ceo' },
        })
      : manifest)
    readinessManifest.agentId = agentId
    const continuity = isMain
      ? (this.agentContinuity.get('rj') ?? (this.mainAgentWorkspace ? materializedContinuity(this.mainAgentWorkspace) : builtInAskContinuity(agentId)))
      : (this.agentContinuity.get(agentId) ?? (manifest.source?.type === 'chimera' && manifest.source?.sourceId === 'built-in' ? builtInAskContinuity(agentId) : null))
    const preference = this.agentModelPolicy.get(agentId)
    let selection
    if (typeof this.models.describeSelection === 'function') {
      const described = this.models.describeSelection(preference)
      const askDescribed = typeof this.models.describeAskSelection === 'function'
        ? this.models.describeAskSelection(preference)
        : null
      selection = {
        ...preference,
        ...described,
        ...(askDescribed ? {
          // Ask has a deliberately narrower pure-provider capability than a
          // task route. Keep native Codex/Antigravity work eligibility visible
          // while binding the fingerprint to the actual Ask leaf when one is
          // available; never relabel a native route as pure inference.
          askSelection: askDescribed,
          askEligible: askDescribed.eligible === true,
          askAvailability: askDescribed.availability ?? 'unknown',
          askExecution: askDescribed.execution ?? 'unknown',
          ...(preference.mode === 'auto' || askDescribed.eligible === true
            ? { providerId: askDescribed.providerId, model: askDescribed.model }
            : {}),
        } : {}),
      }
      if (preference.mode === 'auto') {
        const modelState = this.models.state()
        const catalogFingerprint = sha256({
          providers: (modelState.providers ?? []).map(provider => ({
            id: provider.id,
            configured: provider.configured === true,
            models: (provider.models ?? []).map(model => ({ id: model.id, capabilities: model.capabilities ?? [], availability: model.availability ?? null })),
          })),
        })
        selection = {
          ...selection,
          catalogFingerprint,
          ...(askDescribed ? { askSelectionFingerprint: sha256(askDescribed) } : {}),
        }
      }
      const boundProviderId = selection.providerId && selection.providerId !== 'chimera-auto'
        ? selection.providerId
        : null
      const connection = boundProviderId
        ? this.connectionState().find(entry => entry.providerId === boundProviderId)
        : null
      if (connection) {
        selection = {
          ...selection,
          connectionEnabled: connection.enabled,
          connectionRevision: connection.revision,
          connectionStatus: connection.status,
          connectionMachineRef: connection.provenance.machineRef,
          connectionAccountRef: connection.provenance.accountRef,
          connectionSignedIn: connection.provenance.signedIn,
          connectionSessionStatus: connection.provenance.sessionStatus ?? null,
        }
      }
    } else {
      selection = { ...preference, eligible: preference.mode === 'auto', status: preference.mode === 'auto' ? 'eligible' : 'unavailable' }
    }
    const access = this.agentAccessPolicy.get(agentId)
    const executor = this.#executorCapabilityFor(manifest)
    const verification = this.agentReadinessStore?.latest(agentId, 'agent-readiness') ?? null
    const readiness = buildAgentReadiness({ manifest: readinessManifest, continuity, selection, access, executor, verification })
    return { agentId, manifest, readinessManifest, continuity, preference, selection, access, executor, verification, readiness }
  }

  async agentReadiness({ agentId } = {}) {
    return structuredClone((await this.#readinessSnapshot(agentId)).readiness)
  }

  async agentReadinessReceipt({ agentId, requestId } = {}) {
    if (typeof agentId !== 'string' || !AGENT_ID.test(agentId)
      || typeof requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestId)) {
      throw Object.assign(new TypeError('AGENT_READINESS_QUERY_INVALID'), { code: 'AGENT_READINESS_QUERY_INVALID' })
    }
    const receipt = this.agentReadinessStore?.getRequest({ agentId, requestScope: 'agent-readiness', requestId })
    if (!receipt) throw Object.assign(new Error('AGENT_READINESS_RECEIPT_NOT_FOUND'), { code: 'AGENT_READINESS_RECEIPT_NOT_FOUND' })
    return {
      schema: 'chimera.agent-readiness-receipt.v1',
      agentId,
      requestId,
      status: receipt.status,
      fingerprint: receipt.fingerprint,
      scope: receipt.scope,
      observedAt: receipt.observedAt,
      ...(receipt.errorCode ? { errorCode: receipt.errorCode } : {}),
      ...(receipt.result ? { result: receipt.result } : {}),
    }
  }

  async testAgent(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).length !== 4
      || Object.keys(input).some(key => !['agentId', 'requestId', 'expectedFingerprint', 'allowQuotaUse'].includes(key))
      || typeof input.agentId !== 'string' || !AGENT_ID.test(input.agentId)
      || typeof input.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.requestId)
      || typeof input.expectedFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedFingerprint)
      || input.allowQuotaUse !== true) {
      throw Object.assign(new TypeError('AGENT_READINESS_TEST_INPUT_INVALID'), { code: 'AGENT_READINESS_TEST_INPUT_INVALID' })
    }
    const intentFingerprint = sha256({ agentId: input.agentId, expectedFingerprint: input.expectedFingerprint, allowQuotaUse: true })
    const key = `${input.agentId}:${input.requestId}`
    const active = this.agentReadinessInFlight.get(key)
    if (active) {
      if (active.intentFingerprint !== intentFingerprint) throw Object.assign(new Error('AGENT_READINESS_REQUEST_CONFLICT'), { code: 'AGENT_READINESS_REQUEST_CONFLICT' })
      return active.promise
    }
    const existing = this.agentReadinessStore?.getRequest({ agentId: input.agentId, requestScope: 'agent-readiness', requestId: input.requestId })
    if (existing) {
      if (existing.intentFingerprint !== intentFingerprint) throw Object.assign(new Error('AGENT_READINESS_REQUEST_CONFLICT'), { code: 'AGENT_READINESS_REQUEST_CONFLICT' })
      if (existing.status === 'pending') {
        const observedAt = new Date(this.now()).toISOString()
        const unknown = {
          ...existing,
          status: 'unknown',
          observedAt,
          errorCode: 'AGENT_TEST_OUTCOME_UNKNOWN',
        }
        try {
          await this.agentReadinessStore.record(unknown)
        } catch {
          // A failed terminalization must not make this request executable.
        }
        return {
          schema: 'chimera.agent-test-result.v1',
          agentId: input.agentId,
          requestId: input.requestId,
          status: 'unknown',
          fingerprint: existing.fingerprint,
          scope: existing.scope,
          observedAt,
        }
      }
      return {
        schema: 'chimera.agent-test-result.v1',
        agentId: input.agentId,
        requestId: input.requestId,
        status: existing.status,
        fingerprint: existing.fingerprint,
        scope: existing.scope,
        observedAt: existing.observedAt,
      }
    }
    const bindingKey = `${input.agentId}:${input.expectedFingerprint}`
    const bindingActive = this.agentReadinessBindingInFlight.get(bindingKey)
    if (bindingActive && bindingActive.requestId !== input.requestId) {
      return {
        schema: 'chimera.agent-test-result.v1',
        agentId: input.agentId,
        requestId: input.requestId,
        status: 'unknown',
        fingerprint: input.expectedFingerprint,
        scope: 'inference-only',
        observedAt: new Date(this.now()).toISOString(),
        errorCode: 'AGENT_TEST_BINDING_IN_FLIGHT',
        unresolvedRequestId: bindingActive.requestId,
      }
    }
    const unresolved = this.agentReadinessStore?.findUnresolved?.({
      agentId: input.agentId,
      requestScope: 'agent-readiness',
      fingerprint: input.expectedFingerprint,
      excludeRequestId: input.requestId,
    })?.[0]
    if (unresolved) {
      return {
        schema: 'chimera.agent-test-result.v1',
        agentId: input.agentId,
        requestId: input.requestId,
        status: 'unknown',
        fingerprint: unresolved.fingerprint,
        scope: unresolved.scope,
        observedAt: unresolved.observedAt,
        errorCode: unresolved.errorCode ?? 'AGENT_TEST_OUTCOME_UNKNOWN',
        unresolvedRequestId: unresolved.requestId,
      }
    }
    const promise = this.#runAgentReadinessTest(input, intentFingerprint)
    this.agentReadinessInFlight.set(key, { intentFingerprint, promise })
    this.agentReadinessBindingInFlight.set(bindingKey, { requestId: input.requestId, promise })
    promise.finally(() => {
      const current = this.agentReadinessInFlight.get(key)
      if (current?.promise === promise) this.agentReadinessInFlight.delete(key)
      const binding = this.agentReadinessBindingInFlight.get(bindingKey)
      if (binding?.promise === promise) this.agentReadinessBindingInFlight.delete(bindingKey)
    }).catch(() => {})
    return promise
  }

  async #runAgentReadinessTest(input, intentFingerprint) {
    const snapshot = await this.#readinessSnapshot(input.agentId)
    if (snapshot.readiness.fingerprint !== input.expectedFingerprint) {
      throw Object.assign(new Error('AGENT_READINESS_FINGERPRINT_STALE'), { code: 'AGENT_READINESS_FINGERPRINT_STALE' })
    }
    if (snapshot.readiness.status === 'blocked') {
      throw Object.assign(new Error(snapshot.readiness.checks.find(row => row.status === 'blocked')?.reason ?? 'AGENT_READINESS_BLOCKED'), { code: 'AGENT_READINESS_BLOCKED' })
    }
    // The task-harness capability describes work ownership, not the pure Ask
    // adapter used by this check. Idle imported/native workers therefore remain
    // execution-unknown until a task binds them, while a pure Ask test is
    // admitted or rejected by the captured router below. Never start a worker
    // merely to prove inference readiness; native/tool-only routes still fail
    // closed in #resolveAskInvocation without provider dispatch.
    await this.agentReadinessStore.record({
      agentId: input.agentId,
      requestId: input.requestId,
      requestScope: 'agent-readiness',
      intentFingerprint,
      fingerprint: input.expectedFingerprint,
      scope: 'inference-only',
      status: 'pending',
      observedAt: new Date(this.now()).toISOString(),
    })
    try {
      const invocation = await this.#resolveAskInvocation({
        recipientAgentId: input.agentId,
        requestId: input.requestId,
        verificationScope: 'agent-readiness',
        preferenceOverride: snapshot.preference,
        selectionOverride: snapshot.selection,
      })
      await invocation.router.route('Reply with exactly OK.', {
        ...structuredClone(invocation.context),
        stage: 'ask',
        askRequestId: input.requestId,
        verificationScope: 'agent-readiness',
        readinessFingerprint: input.expectedFingerprint,
      })
      const observedAt = new Date(this.now()).toISOString()
      await this.agentReadinessStore.record({
        agentId: input.agentId,
        requestId: input.requestId,
        requestScope: 'agent-readiness',
        intentFingerprint,
        fingerprint: input.expectedFingerprint,
        scope: 'inference-only',
        status: 'passed',
        observedAt,
        result: { status: 'passed', executor: 'inference-only' },
      })
      return { schema: 'chimera.agent-test-result.v1', agentId: input.agentId, requestId: input.requestId, status: 'passed', fingerprint: input.expectedFingerprint, scope: 'inference-only', observedAt }
    } catch (error) {
      const unknown = error?.name === 'ModelCallOutcomeUnknownError' || ['MODEL_CALL_OUTCOME_UNKNOWN', 'ASK_OUTCOME_UNKNOWN', 'CONNECTION_RESPONSE_LOST'].includes(error?.code)
      const observedAt = new Date(this.now()).toISOString()
      await this.agentReadinessStore.record({
        agentId: input.agentId,
        requestId: input.requestId,
        requestScope: 'agent-readiness',
        intentFingerprint,
        fingerprint: input.expectedFingerprint,
        scope: 'inference-only',
        status: unknown ? 'unknown' : 'failed',
        observedAt,
        errorCode: unknown ? 'AGENT_TEST_OUTCOME_UNKNOWN' : 'AGENT_TEST_FAILED',
      }).catch(() => {})
      if (unknown) return { schema: 'chimera.agent-test-result.v1', agentId: input.agentId, requestId: input.requestId, status: 'unknown', fingerprint: input.expectedFingerprint, scope: 'inference-only', observedAt }
      throw error
    }
  }

  #conversationForTask(record, conversation = null) {
    const saved = record?.context ?? {}
    const requestedSpecialistAgentId = conversation?.requestedSpecialistAgentId
      ?? saved.requestedSpecialistAgentId
      ?? null
    const conversationId = conversation?.conversationId ?? saved.conversationId ?? null
    const replyTo = conversation?.replyTo ?? null
    if (!conversationId && !requestedSpecialistAgentId && !replyTo) return null
    return {
      ...(conversationId ? { conversationId } : {}),
      ...(requestedSpecialistAgentId ? { requestedSpecialistAgentId } : {}),
      ...(replyTo ? { replyTo } : {}),
    }
  }

  #startTask(record, conversation = null) {
    const boundConversation = this.#conversationForTask(record, conversation)
    this.taskControllers.set(record.taskId, new AbortController())
    const operation = this.#runTask(record.taskId, record.objective, boundConversation)
      .then(async (completed) => {
        await this.accountCompanion.revokeTask(record.taskId)
        const sessionTaskId = record.context?.projectSessionTaskId ?? record.taskId
        const projectSession = this.projectSessions?.get(sessionTaskId)
        if (projectSession) {
          await this.projectSessions.markOutcome(
            sessionTaskId,
            completed.status === 'completed' ? 'completed' : 'failed',
          )
          this.#markTaskWorkspaceReviewStale(sessionTaskId, 'PROJECT_SESSION_OUTCOME')
          await this.taskAccessLeases.revokeTask(record.taskId, {
            reason: completed.status === 'completed' ? 'task-completed' : 'task-failed',
            revokedBy: this.agentId,
          })
        }
        if (boundConversation?.conversationId) {
          try {
            await this.conversations.append({
              messageId: `message-${crypto.randomUUID()}`,
              conversationId: boundConversation.conversationId,
              senderAgentId: this.agentId,
              recipientAgentIds: [this.humanId],
              kind: 'message',
              content: redactSensitiveText(completed.summary ?? completed.failure?.message ?? 'RJ stopped safely before completing the task.'),
              taskId: completed.taskId,
              replyTo: boundConversation.replyTo,
              status: completed.status === 'completed' ? 'completed' : 'failed',
              provenance: { verification: 'derived', source: 'rj-task-synthesis' },
            })
          } catch (error) {
            this.audit.append({
              kind: 'ceo.conversation.reply-write-failed',
              taskId: completed.taskId,
              code: typeof error?.code === 'string' ? error.code : 'CONVERSATION_WRITE_FAILED',
              at: new Date(this.now()).toISOString(),
            })
          }
        }
        return completed
      })
      .catch(async (error) => {
        this.projectQueueBlocked = true
        await this.accountCompanion.revokeTask(record.taskId).catch(() => {})
        // Cleanup errors must be visible without leaving an unobserved rejected
        // background promise after the task already reached a terminal state.
        try {
          await this.tasks.checkpoint(record.taskId, { stage: 'cleanup-failed', summary: 'Task cleanup needs attention.', failure: safeTaskFailure(error) })
          await this.taskAccessLeases.revokeTask(record.taskId, { reason: 'task-cleanup-failed', revokedBy: this.agentId })
        } catch { /* The durable task record remains available even if storage is unavailable. */ }
        return this.tasks.get(record.taskId)
      })
      .finally(async () => {
        await this.accountCompanion.revokeTask(record.taskId).catch(() => {})
        await this.teamDispatchers.get(record.taskId)?.close().catch(() => {})
        this.teamDispatchers.delete(record.taskId)
        if (this.taskControllers.get(record.taskId)?.signal.aborted) {
          await this.#cancelTaskApprovals(record.taskId, 'TASK_CANCELLED').catch(() => {})
        }
        this.activeTasks.delete(record.taskId)
        this.taskControllers.delete(record.taskId)
        for (const [agentId, ownerTaskId] of this.workerOwners) {
          if (ownerTaskId === record.taskId) this.workerOwners.delete(agentId)
        }
        this.#drainProjectQueue()
      })
    this.activeTasks.set(record.taskId, operation)
  }

  #assertTaskActive(taskId) {
    if (this.taskControllers.get(taskId)?.stopped) throw Object.assign(new Error('PROCESS_STOPPED'), { code: 'PROCESS_STOPPED' })
    if (this.taskControllers.get(taskId)?.signal.aborted || this.tasks.get(taskId)?.status === 'cancelled') {
      throw Object.assign(new Error('TASK_CANCELLED'), { code: 'TASK_CANCELLED' })
    }
  }

  async #rjAwsTaskAuthority(context) {
    if (typeof context?.assertActive !== 'function') {
      throw Object.assign(new Error('RJ_TASK_AUTHORITY_INACTIVE'), { code: 'RJ_TASK_AUTHORITY_INACTIVE' })
    }
    const active = await context.assertActive()
    if (active === false) throw Object.assign(new Error('RJ_TASK_AUTHORITY_INACTIVE'), { code: 'RJ_TASK_AUTHORITY_INACTIVE' })
    const task = this.tasks.get(context.taskId)
    const security = this.specialistSecurity.get(context.agentId)
    const grant = security?.grant?.payload
    if (!task || task.status !== 'running'
      || this.workerOwners.get(context.agentId) !== context.taskId
      || grant?.agentId !== context.agentId
      || grant?.taskId !== context.taskId
      || Date.parse(grant?.expiresAt) <= this.now()) {
      throw Object.assign(new Error('RJ_TASK_AUTHORITY_INACTIVE'), { code: 'RJ_TASK_AUTHORITY_INACTIVE' })
    }
    const projectTask = typeof task.context?.projectId === 'string'
    const lease = projectTask ? this.taskAccessLeases.activeFor(context.agentId, context.taskId) : null
    if (projectTask && !lease) {
      throw Object.assign(new Error('RJ_TASK_AUTHORITY_INACTIVE'), { code: 'RJ_TASK_AUTHORITY_INACTIVE' })
    }
    const profileId = lease?.profileId ?? this.agentAccessPolicy.get(context.agentId).profileId
    const expiresAt = lease && Date.parse(lease.expiresAt) < Date.parse(grant.expiresAt) ? lease.expiresAt : grant.expiresAt
    return { agentId: context.agentId, taskId: context.taskId, profileId, expiresAt }
  }

  async verifyRjAwsConnection({ requestId } = {}) {
    const candidate = this.#admissionCandidate(requestId, 'rj-aws-verify', { connector: 'rj-aws', operations: ['rj.aws.identity', 'rj.aws.instance_status'] })
    if (candidate?.replay) return this.#replayAdmissionResult(candidate.existing)
    const admissionResult = await this.#enqueueTaskAdmission(async () => {
      this.connectionPolicy?.assertEnabled('rj-aws')
      if (!this.rjAwsConnector?.state().configured) {
        throw Object.assign(new Error('RJ_AWS_NOT_CONFIGURED'), { code: 'RJ_AWS_NOT_CONFIGURED' })
      }
      if (this.tasks.active().length > 0 || this.activeTasks.size > 0) {
        throw Object.assign(new Error('TASK_ALREADY_RUNNING'), { code: 'TASK_ALREADY_RUNNING' })
      }
      const taskId = `rj-aws-verify-${crypto.randomUUID()}`
      const expiresAt = new Date(this.now() + 5 * 60_000).toISOString()
      const operations = ['rj.aws.identity', 'rj.aws.instance_status']
      let admission
      let durableTask = false
      try {
        admission = await this.#reserveAdmission(candidate, 'rj-aws-verify', { connector: 'rj-aws', operations }, {
          taskId, capturedDefaults: { expiresAt },
        })
        if (admission?.replayed) return this.#replayAdmissionResult(admission)
        await this.tasks.submit({
          taskId,
          objective: 'Verify the fixed RJ AWS read-only worker connection.',
          model: null,
          context: { source: 'rj-aws-verification', deterministic: true, operations, expiresAt },
          ...(candidate ? { admissionRequestId: candidate.requestId, admissionRequestHash: candidate.requestHash } : {}),
        })
        durableTask = true
        await this.#completeAdmission(candidate, 'accepted', { taskId })
      } catch (error) {
        if (durableTask || this.#taskBindsAdmission(taskId, candidate)) await this.#markAdmissionUncertain(candidate, { taskId })
        else if (admission && !admission.replayed) await this.#completeAdmission(candidate, 'failed', { taskId, reason: safeTaskFailure(error).code }).catch(() => {})
        throw error
      }
      // Only setup/admission belongs to the shared mutation queue. Physical
      // verification starts after it releases so project work can reserve a
      // queued slot while this read-only connector call is in flight.
      return { taskId, expiresAt, operations }
    }, { requestId: candidate?.requestId, requestHash: candidate?.requestHash })
    if (admissionResult?.replayed) return admissionResult
    const { taskId, expiresAt, operations } = admissionResult
    const controller = new AbortController()
    this.taskControllers.set(taskId, controller)
    const operation = this.#runRjAwsVerification({ taskId, expiresAt, operations })
      .finally(() => {
        this.activeTasks.delete(taskId)
        this.taskControllers.delete(taskId)
        this.#drainProjectQueue()
      })
    this.activeTasks.set(taskId, operation)
    return operation
  }

  async reconcileRjAwsRequest({ requestId } = {}) {
    this.connectionPolicy?.assertEnabled('rj-aws')
    if (!this.rjAwsConnector?.state().configured) throw Object.assign(new Error('RJ_AWS_NOT_CONFIGURED'), { code: 'RJ_AWS_NOT_CONFIGURED' })
    if (this.tasks.active().length || this.activeTasks.size) throw Object.assign(new Error('TASK_ALREADY_RUNNING'), { code: 'TASK_ALREADY_RUNNING' })
    const request = this.rjAwsConnector.state().requests?.find(entry => entry.requestId === requestId)
    if (!request || !this.tasks.get(request.taskId)) throw Object.assign(new Error('RJ_REQUEST_NOT_FOUND'), { code: 'RJ_REQUEST_NOT_FOUND' })
    // The old task remains terminal/interrupted. Only a fresh authenticated lookup is sent.
    const operation = (async () => {
      this.connectionPolicy?.assertEnabled('rj-aws')
      const recovered = await this.rjAwsConnector.reconcile(requestId)
      await this.tasks.checkpoint(request.taskId, { stage: 'rj-aws-reconciled',
        summary: 'Recovered the original signed worker receipt without restarting task execution.',
        receipt: recovered.receipt, effectOutcome: recovered.outcome })
      return { ...recovered, status: 'reconciled', taskId: request.taskId }
    })().finally(() => { this.activeTasks.delete(request.taskId); this.#drainProjectQueue() })
    this.activeTasks.set(request.taskId, operation)
    return operation
  }

  async #runRjAwsVerification({ taskId, expiresAt, operations }) {
    await this.tasks.start(taskId)
    const receipts = []
    const assertActive = () => {
      this.#assertTaskActive(taskId)
      const task = this.tasks.get(taskId)
      if (task?.status !== 'running' || task.context?.source !== 'rj-aws-verification'
        || task.context?.deterministic !== true
        || JSON.stringify(task.context?.operations) !== JSON.stringify(operations)
        || task.context?.expiresAt !== expiresAt
        || Date.parse(expiresAt) <= this.now()) {
        throw Object.assign(new Error('RJ_TASK_AUTHORITY_INACTIVE'), { code: 'RJ_TASK_AUTHORITY_INACTIVE' })
      }
      return { agentId: this.agentId, taskId, profileId: 'connected', expiresAt }
    }
    try {
      for (const operation of operations) {
        this.connectionPolicy?.assertEnabled('rj-aws')
        const execution = await this.rjAwsConnector.execute(operation, { agentId: this.agentId, taskId, assertActive })
        receipts.push(execution.receipt)
        await this.tasks.checkpoint(taskId, {
          stage: 'rj-aws-verification',
          summary: `Verified signed receipt for ${operation}.`,
          receipts,
          effectOutcome: execution.outcome,
        })
        if (execution.outcome !== 'succeeded') {
          throw Object.assign(new Error('RJ_AWS_VERIFICATION_FAILED'), { code: 'RJ_AWS_VERIFICATION_FAILED' })
        }
      }
      await this.tasks.complete(taskId, {
        summary: 'RJ AWS worker execution verified with both signed read-only receipts.',
        result: { schema: 'chimera.rj-aws-verification.v1', receipts },
      })
      return { schema: 'chimera.rj-aws-verification.v1', taskId, status: 'verified', receipts: structuredClone(receipts), receipt: this.tasks.getAdmissionByTask?.(taskId) ?? null }
    } catch (error) {
      if (['queued', 'running'].includes(this.tasks.get(taskId)?.status)) await this.tasks.fail(taskId, safeTaskFailure(error))
      throw error
    }
  }

  async steerTask({ taskId, content, requestId, expectedDestinationRevision } = {}) {
    const candidate = this.#admissionCandidate(requestId, 'task-steer', {
      taskId: taskId ?? null, content: typeof content === 'string' ? content.trim() : content ?? null,
      expectedDestinationRevision: expectedDestinationRevision ?? null,
    })
    if (candidate?.replay) return this.#replayAdmissionResult(candidate.existing)
    const normalized = this.#validateObjective(content)
    if (normalized.length > 4096) throw Object.assign(new TypeError('TASK_STEERING_INVALID'), { code: 'TASK_STEERING_INVALID' })
    return this.#enqueueTaskAdmission(async () => {
      this.#assertDestinationRevision(taskId, expectedDestinationRevision)
      let admission
      let durableSteer = false
      let receipt = null
      try {
        admission = await this.#reserveAdmission(candidate, 'task-steer', { taskId, expectedDestinationRevision: expectedDestinationRevision ?? null })
        if (admission?.replayed) return this.#replayAdmissionResult(admission)
        // Reservation is durable but does not freeze the task destination. Check
        // again after the await, then let the ledger enforce the same revision
        // atomically with the steering mutation.
        this.#assertDestinationRevision(taskId, expectedDestinationRevision)
        const record = await this.tasks.steer(taskId, normalized, expectedDestinationRevision, {
          ...(candidate ? { requestId: candidate.requestId, requestHash: candidate.requestHash } : {}),
        })
        durableSteer = true
        receipt = candidate ? this.tasks.getAdmission(candidate.requestId) : null
        if (candidate && receipt?.status !== 'accepted') throw Object.assign(new Error('TASK_ADMISSION_UNCERTAIN'), { code: 'TASK_ADMISSION_UNCERTAIN', reconciliationRequired: true })
        // A pending tool proposal predates the new instruction. Deny it and let the
        // next model turn choose work using the updated steering.
        await this.#cancelTaskApprovals(taskId, 'TASK_STEERED')
        return { ...record, receipt }
      } catch (error) {
        const currentReceipt = candidate ? this.tasks.getAdmission(candidate.requestId) : null
        if (currentReceipt?.status === 'accepted') {
          durableSteer = true
        } else if (durableSteer) await this.#markAdmissionUncertain(candidate, { taskId })
        else if (admission && !admission.replayed) await this.#completeAdmission(candidate, 'failed', { taskId, reason: safeTaskFailure(error).code }).catch(() => {})
        throw error
      }
    }, { allowActive: true, requestId: candidate?.requestId, requestHash: candidate?.requestHash })
  }

  #taskMessageRecipients(taskId) {
    const task = this.tasks.get(taskId)
    if (!task || !['queued', 'running'].includes(task.status) || this.taskControllers.get(taskId)?.signal.aborted) return []
    const dispatcher = this.teamDispatchers.get(taskId)
    const current = new Set(this.#specialistManifests().map(agent => agent.agentId))
    return [this.agentId, ...(dispatcher?.peers(this.agentId) ?? []).filter(id => current.has(id))]
  }

  #recipientGuidance(taskId, agentId) {
    return this.conversations.list(`task:${taskId}`).filter(message => message.provenance.source === 'operator-task-guidance'
      && message.recipientAgentIds.includes(agentId)).map(message => ({
      messageId: message.messageId, content: message.content, createdAt: message.createdAt,
      ...(message.replyTo ? { replyTo: message.replyTo } : {}), provenance: { verification: 'human' },
    }))
  }

  messageTask(input = {}) {
    const candidate = this.#admissionCandidate(input?.requestId, 'task-message', {
      taskId: input?.taskId ?? null,
      content: typeof input?.content === 'string' ? input.content.trim() : input?.content ?? null,
      recipientAgentIds: Array.isArray(input?.recipientAgentIds) ? [...input.recipientAgentIds].toSorted() : input?.recipientAgentIds ?? null,
      replyTo: input?.replyTo ?? null,
      expectedDestinationRevision: input?.expectedDestinationRevision ?? null,
    })
    if (candidate?.replay) return Promise.resolve(this.#replayAdmissionResult(candidate.existing))
    const previous = this.taskGuidanceWrites.get(input.taskId) ?? Promise.resolve()
    const operation = previous.then(() => this.#saveTaskMessage(input, candidate))
    const settled = operation.catch(() => {})
    this.taskGuidanceWrites.set(input.taskId, settled)
    void settled.then(() => { if (this.taskGuidanceWrites.get(input.taskId) === settled) this.taskGuidanceWrites.delete(input.taskId) })
    return operation
  }

  async #saveTaskMessage({ taskId, content, recipientAgentIds, replyTo, requestId, expectedDestinationRevision } = {}, candidate = null) {
    const fail = code => { throw Object.assign(new TypeError(code), { code }) }
    // The per-task write chain serializes guidance, but exact request replay
    // still has to win before a later destination revision or eligibility
    // check can reject the already-admitted request.
    if (requestId) {
      const existing = this.tasks.getAdmission(requestId)
      if (existing) {
        if (candidate?.requestHash && existing.requestHash !== candidate.requestHash) {
          throw Object.assign(new Error('TASK_ADMISSION_CONFLICT'), { code: 'TASK_ADMISSION_CONFLICT' })
        }
        return this.#replayAdmissionResult(existing)
      }
    }
    if (typeof taskId !== 'string' || taskId.length > 256 || typeof content !== 'string' || !content.trim() || content.length > 4096
      || !Array.isArray(recipientAgentIds) || recipientAgentIds.length < 1 || recipientAgentIds.length > 8
      || recipientAgentIds.some(id => typeof id !== 'string') || new Set(recipientAgentIds).size !== recipientAgentIds.length) fail('TASK_MESSAGE_INVALID')
    if (!this.tasks.get(taskId)) fail('TASK_NOT_FOUND')
    const eligible = this.#taskMessageRecipients(taskId)
    if (!eligible.length) fail('TASK_NOT_ACTIVE')
    if (recipientAgentIds.some(id => !eligible.includes(id))) fail('TASK_MESSAGE_RECIPIENT_INVALID')
    this.#assertDestinationRevision(taskId, expectedDestinationRevision)
    const messages = this.conversations.list(`task:${taskId}`)
    if (replyTo !== undefined && (typeof replyTo !== 'string' || !messages.some(message => message.messageId === replyTo && message.taskId === taskId))) fail('TASK_MESSAGE_PARENT_INVALID')
    if (messages.filter(message => message.provenance.source === 'operator-task-guidance').length >= 32) fail('TASK_MESSAGE_LIMIT')
      const messageId = requestId ? `human-guidance-${sha256({ requestId, taskId, operation: 'task-message' }).slice(0, 48)}` : `human-${crypto.randomUUID()}`
      let admission
      let durableMessage = false
      try {
      admission = await this.#reserveAdmission(candidate, 'task-message', {
        taskId, recipientAgentIds: [...recipientAgentIds].toSorted(), replyTo: replyTo ?? null,
        expectedDestinationRevision: expectedDestinationRevision ?? null,
      }, { messageId, capturedDefaults: { messageId } })
      if (admission?.replayed) return this.#replayAdmissionResult(admission)
      // The reservation does not hold the task room open. Revalidate its
      // lifecycle, eligible recipients, and server-owned revision before the
      // cross-journal message append.
      const eligibleAfterReservation = this.#taskMessageRecipients(taskId)
      if (!eligibleAfterReservation.length) fail('TASK_NOT_ACTIVE')
      if (recipientAgentIds.some(id => !eligibleAfterReservation.includes(id))) fail('TASK_MESSAGE_RECIPIENT_INVALID')
      this.#assertDestinationRevision(taskId, expectedDestinationRevision)
        const message = await this.conversations.append({ messageId, conversationId: `task:${taskId}`,
        taskId, senderAgentId: 'operator', recipientAgentIds, content: redactSensitiveText(content.trim()),
          ...(replyTo !== undefined ? { replyTo } : {}), requestId: candidate?.requestId, requestHash: candidate?.requestHash,
          provenance: { verification: 'human', source: 'operator-task-guidance' } })
      durableMessage = true
      // append() flushes the conversation record before auditing it. A failing
      // audit therefore still leaves an exact request-bound message that can
      // be reconciled without appending or retrying it.
      if (!durableMessage && message) durableMessage = true
      const revised = await this.tasks.reviseDestination(taskId, expectedDestinationRevision)
      const receipt = await this.#completeAdmission(candidate, 'accepted', { taskId, messageId })
      await this.#cancelTaskApprovals(taskId, 'TASK_STEERED', recipientAgentIds)
      const deliveries = this.teamDispatchers.get(taskId)?.state().deliveries ?? []
      const currentEligible = this.#taskMessageRecipients(taskId)
      return { message, recipients: recipientAgentIds.map(agentId => ({ agentId,
        status: currentEligible.includes(agentId) && (agentId === this.agentId || deliveries.some(row => row.recipientAgentId === agentId && ['pending', 'processing', 'waiting'].includes(row.status)))
        ? 'next-boundary' : 'saved-no-active-assignment' })),
        destinationRevision: revised.destinationRevision,
        receipt,
        acknowledgement: 'Guidance saved. Applies only if the addressed agent reaches another safe boundary; finished assignments are not restarted.' }
      } catch (error) {
      if (!durableMessage && messageId && this.conversations.getMessage(messageId)) durableMessage = true
      if (durableMessage) await this.#markAdmissionUncertain(candidate, { taskId, messageId })
      else if (admission && !admission.replayed) await this.#completeAdmission(candidate, 'failed', { taskId, messageId, reason: safeTaskFailure(error).code }).catch(() => {})
      throw error
    }
  }

  async #cancelTaskApprovals(taskId, reason, recipientAgentIds = null) {
    const controller = this.taskControllers.get(taskId)
    for (const decision of this.decisions.pending()) {
      const pending = this.pendingExecutions.get(decision.actionId)
      if (pending?.taskId !== taskId && !(controller?.grantId && decision.agent?.grantId === controller.grantId)) continue
      if (recipientAgentIds && !recipientAgentIds.includes(decision.agent?.agentId)) continue
      await this.workerApprovalBroker.expire(decision.actionId, reason)
      this.gateway.cancelPending(decision.actionId, reason)
      await this.decisions.cancel(decision.actionId, reason)
      this.pendingExecutions.delete(decision.actionId)
    }
  }

  async #recordCanonicalApprovalStep(scope, status, reason) {
    const taskId = scope?.taskId ?? null
    const nodeId = scope?.nodeId ?? null
    const assignmentId = scope?.assignmentId ?? null
    const canonicalAssignmentId = scope?.canonicalAssignmentId ?? null
    if (!taskId || !nodeId || assignmentId !== canonicalAssignmentId) return
    const task = this.tasks?.get(taskId)
    const revision = task?.plan?.revision
    const step = task?.steps?.find((candidate) => candidate.nodeId === nodeId)
    if (!Number.isSafeInteger(revision) || !step || ['completed', 'blocked', 'failed', 'cancelled', 'unknown'].includes(step.status)) return
    try {
      await this.tasks.recordStep(taskId, {
        revision,
        nodeId,
        status,
        messageId: canonicalAssignmentId,
        resultId: null,
        reason,
      })
    } catch (error) {
      // A concurrent canonical result may have won the durable step race. In
      // that case terminal immutability is the correct outcome; every other
      // persistence error must reach the approval caller.
      if (error?.code === 'TASK_STEP_TERMINAL') {
        const latest = this.tasks.get(taskId)?.steps?.find((candidate) => candidate.nodeId === nodeId)
        if (latest && ['completed', 'blocked', 'failed', 'cancelled', 'unknown'].includes(latest.status)) return
      }
      throw error
    }
  }

  async cancelTask({ taskId } = {}) {
    const current = this.tasks.get(taskId)
    if (!current) throw Object.assign(new Error('TASK_NOT_FOUND'), { code: 'TASK_NOT_FOUND' })
    if (current.status !== 'cancelled' && !['queued', 'running'].includes(current.status)) throw Object.assign(new Error('TASK_NOT_ACTIVE'), { code: 'TASK_NOT_ACTIVE' })
    this.taskControllers.get(taskId)?.abort()
    const accountRevocation = this.accountCompanion.revokeTask(taskId)
    // Close admission immediately; the task's cleanup still waits for physical
    // executors so a delayed tool cannot overlap a replacement assignment.
    void this.teamDispatchers.get(taskId)?.close('TASK_CANCELLED').catch(() => {})
    const [record] = await Promise.all([this.tasks.cancel(taskId), accountRevocation])
    await this.#cancelTaskApprovals(taskId, 'TASK_CANCELLED')
    await this.taskAccessLeases.revokeTask(taskId, { reason: 'task-cancelled', revokedBy: this.humanId })
    return record
  }

  async continueTask({ taskId, objective, budget, requestId, expectedDestinationRevision, requirements } = {}) {
    const priorForIntent = this.tasks?.get(taskId)
    const inheritedRequirements = requirements === undefined ? priorForIntent?.context?.requirements : undefined
    const normalizedRequirements = requirements === undefined
      ? (inheritedRequirements ? normalizeTaskRequirements(inheritedRequirements) : undefined)
      : normalizeTaskRequirements(requirements)
    const candidate = this.#admissionCandidate(requestId, 'continuation', {
      taskId: taskId ?? null, objective: typeof objective === 'string' ? objective.trim() : objective ?? null,
      budget: budget ?? null, expectedDestinationRevision: expectedDestinationRevision ?? null,
      ...(normalizedRequirements ? { requirements: normalizedRequirements } : {}),
    })
    if (candidate?.replay) return this.#replayAdmissionResult(candidate.existing)
    const nextObjective = this.#validateObjective(objective)
    return this.#enqueueTaskAdmission(async () => {
      const prior = this.tasks.get(taskId)
      if (!prior) throw Object.assign(new Error('TASK_NOT_FOUND'), { code: 'TASK_NOT_FOUND' })
      if (['queued', 'running'].includes(prior.status)) throw Object.assign(new Error('TASK_NOT_TERMINAL'), { code: 'TASK_NOT_TERMINAL' })
      this.#assertDestinationRevision(taskId, expectedDestinationRevision)
      const selected = this.models.state().selected
      const nextTaskId = `task-${crypto.randomUUID()}`
      const priorSessionTaskId = prior.context?.projectSessionTaskId ?? (this.projectSessions.get(taskId) ? taskId : null)
      const priorSession = priorSessionTaskId ? this.projectSessions.get(priorSessionTaskId) : null
      const sessionTaskId = priorSession && priorSession.status !== 'committed'
        ? priorSessionTaskId : prior.context?.projectId ? nextTaskId : null
      const context = { ...prior.context, priorTaskId: taskId, budget: normalizeTaskBudget(budget ?? prior.context?.budget),
        ...(normalizedRequirements ? { requirements: normalizedRequirements } : {}),
        ...(sessionTaskId ? { projectSessionTaskId: sessionTaskId } : {}),
        ...(priorSession ? { projectId: priorSession.projectId } : {}),
      }
      let admission
      let record
      let durableTask = false
      try {
        admission = await this.#reserveAdmission(candidate, 'continuation', { taskId, expectedDestinationRevision: expectedDestinationRevision ?? null }, {
          taskId: nextTaskId, capturedDefaults: { budget: context.budget, model: selected ? { providerId: selected.providerId, model: selected.model } : null,
            ...(normalizedRequirements ? { requirements: normalizedRequirements } : {}) },
        })
        if (admission?.replayed) return this.#replayAdmissionResult(admission)
        // A terminal task remains addressable, but its lifecycle revision may
        // have changed while the durable reservation was being flushed.
        this.#assertDestinationRevision(taskId, expectedDestinationRevision)
        record = await this.tasks.submit({ taskId: nextTaskId, objective: nextObjective,
          model: selected ? { providerId: selected.providerId, model: selected.model } : null, context,
          ...(candidate ? { admissionRequestId: candidate.requestId, admissionRequestHash: candidate.requestHash } : {}),
        })
        durableTask = true
        if (sessionTaskId === nextTaskId) {
          const project = this.projectRegistry.get(context.projectId)
          if (!project) throw Object.assign(new Error('PROJECT_NOT_FOUND'), { code: 'PROJECT_NOT_FOUND' })
          await this.projectSessions.prepare({ taskId: nextTaskId, project, accessRequest: priorSession?.accessRequest ?? prior.context.accessRequest })
        } else if (sessionTaskId) {
          await this.projectSessions.resume(sessionTaskId)
          this.#markTaskWorkspaceReviewStale(sessionTaskId, 'PROJECT_SESSION_RESUMED')
        }
      } catch (error) {
        const taskBound = durableTask || this.#taskBindsAdmission(nextTaskId, candidate)
        if (!taskBound && this.tasks.get(nextTaskId)?.status === 'queued') await this.tasks.fail(nextTaskId, safeTaskFailure(error)).catch(() => {})
        if (taskBound) await this.#markAdmissionUncertain(candidate, { taskId: nextTaskId })
        else if (admission && !admission.replayed) await this.#completeAdmission(candidate, 'failed', { taskId: nextTaskId, reason: safeTaskFailure(error).code }).catch(() => {})
        throw error
      }
      const conversation = context.conversationId ? { conversationId: context.conversationId, requestedSpecialistAgentId: context.requestedSpecialistAgentId } : null
      let receipt
      try {
        receipt = await this.#completeAdmission(candidate, 'accepted', { taskId: nextTaskId })
      } catch (error) {
        await this.#markAdmissionUncertain(candidate, { taskId: nextTaskId })
        throw error
      }
      this.#startTask(record, conversation)
      return { ...record, receipt }
    }, { requestId: candidate?.requestId, requestHash: candidate?.requestHash })
  }

  #taskHistoryContext(taskId, conversation) {
    const task = this.tasks.get(taskId)
    const projectId = task.context?.projectId
    const conversationId = conversation?.conversationId ?? task.context?.conversationId
    const previous = this.tasks.list().filter((entry) => entry.taskId !== taskId
      && (entry.taskId === task.context?.priorTaskId
        || (projectId && entry.context?.projectId === projectId)
        || (conversationId && entry.context?.conversationId === conversationId)))
      .toSorted((left, right) => Number(right.taskId === task.context?.priorTaskId) - Number(left.taskId === task.context?.priorTaskId)).slice(0, 6)
    const compact = (value, limit = 3000) => redactSensitiveText(typeof value === 'string' ? value : JSON.stringify(value ?? null)).slice(0, limit)
    return {
      history: {
        messages: conversationId ? this.conversations.list(conversationId, { limit: 13 }).filter((message) => message.taskId !== taskId).slice(-12)
          .map((message) => ({ role: message.role, content: compact(message.content, 2000), taskId: message.taskId })) : [],
        tasks: previous.map((entry) => ({ taskId: entry.taskId, objective: compact(entry.objective, 1000), status: entry.status,
          summary: compact(entry.summary ?? entry.failure?.message), checkpoint: compact(entry.checkpoint), lastCompletedWork: compact(entry.lastCompletedWork),
          result: compact(entry.result), projectSessionTaskId: entry.context?.projectSessionTaskId ?? null })),
      },
      ...(task.context?.priorTaskId ? { continuation: { priorTaskId: task.context.priorTaskId,
        instruction: 'Continue only the new objective. Inspect existing artifacts and verify any unknown external outcome before taking another action. Never replay prior tool calls or assume an interrupted effect did not happen.',
        projectSessionTaskId: task.context.projectSessionTaskId ?? null } } : {}),
    }
  }

  #specialistManifests() {
    const imported = this.agentRegistry.list().filter((manifest) => manifest.enabled)
    return imported.some((manifest) => manifest.agentId === DEFAULT_RESEARCHER_MANIFEST.agentId)
      ? imported
      : [structuredClone(DEFAULT_RESEARCHER_MANIFEST), ...imported]
  }

  #manifestForAgent(agentId) {
    return this.agentRegistry.get(agentId)
      ?? this.#specialistManifests().find((manifest) => manifest.agentId === agentId)
      ?? null
  }

  #securityForSpecialist(manifest, taskId = null, peers = []) {
    const previous = this.specialistSecurity.get(manifest.agentId)
    const identity = previous?.identity ?? this.identityStore.getOrCreate(manifest.agentId)
    const grant = signGrant({
      grantId: `${manifest.agentId}-grant-${crypto.randomUUID()}`,
      humanId: this.humanId,
      agentId: manifest.agentId,
      agentKeyFingerprint: fingerprint(identity.publicKey),
      maxTier: 'confirm',
      ...(taskId ? { taskId } : {}),
      scopes: [
        { capability: 'model.invoke', resourcePrefix: 'model:openai-compatible:' },
        { capability: 'model.invoke', resourcePrefix: 'model:model-fabric:' },
        { capability: 'agent.message.structured_result', resource: 'agent:ceo' },
        ...peers.filter(id => id !== manifest.agentId && id !== 'ceo').flatMap(id => [
          { capability: 'agent.message.task_handoff', resource: `agent:${id}` },
          { capability: 'agent.message.structured_result', resource: `agent:${id}` },
        ]),
        ...toolsForAccessProfile(this.agentAccessPolicy.get(manifest.agentId).profileId)
          .filter((tool) => typeof this.workerToolExecutors[tool] === 'function')
          .map((tool) => ({ capability: this.dshInventory.classify(tool).capability, resource: `dsh-tool:${tool}` })),
      ],
      ...isoWindow(this.now()),
    }, this.human)
    const security = { identity, grant }
    this.specialistSecurity.set(manifest.agentId, security)
    return security
  }

  async discoverAgents() {
    for (const [discoveryId, preview] of this.agentDiscoveries) {
      if (preview.expiresAt < this.now()) {
        this.agentDiscoveries.delete(discoveryId)
        continue
      }
      return {
        schema: preview.schema,
        source: structuredClone(preview.source),
        discoveryId,
        expiresAt: new Date(preview.expiresAt).toISOString(),
        candidates: preview.candidates.map((candidate) => ({
          ...discoveryCandidateProjection(candidate, preview.source),
          imported: this.agentRegistry.get(candidate.profileId) !== null,
          reservedForMain: candidate.profileId === 'rj',
        })),
      }
    }
    if (this.agentDiscoveryInFlight) return this.agentDiscoveryInFlight

    this.agentDiscoveryInFlight = (async () => {
      const discovered = await this.agentDiscovery.discover()
      if (discovered?.schema !== 'chimera.agent-discovery.v1'
        || !discovered.source || typeof discovered.source !== 'object' || Array.isArray(discovered.source)
        || typeof discovered.source.id !== 'string' || discovered.source.id.length === 0 || discovered.source.id.length > 64
        || typeof discovered.source.type !== 'string' || discovered.source.type.length === 0 || discovered.source.type.length > 64
        || typeof discovered.source.host !== 'string' || discovered.source.host.length === 0 || discovered.source.host.length > 128
        || !Array.isArray(discovered.candidates)) {
        const error = new Error('AGENT_DISCOVERY_SOURCE_UNAVAILABLE')
        error.code = 'AGENT_DISCOVERY_SOURCE_UNAVAILABLE'
        throw error
      }
      if (discovered.candidates.some(candidate => !candidate || typeof candidate !== 'object' || Array.isArray(candidate))) {
        throw new Error('AGENT_DISCOVERY_INVALID')
      }
      const discoveryId = `discovery-${crypto.randomUUID()}`
      const expiresAt = this.now() + AGENT_DISCOVERY_LIFETIME_MS
      const preview = {
        schema: discovered.schema,
        source: structuredClone(discovered.source),
        expiresAt,
        candidates: discovered.candidates.map((candidate) => structuredClone(candidate)),
      }
      this.agentDiscoveries.clear()
      this.agentDiscoveries.set(discoveryId, preview)
      return {
        schema: preview.schema,
        source: structuredClone(preview.source),
        discoveryId,
        expiresAt: new Date(expiresAt).toISOString(),
        candidates: preview.candidates.map((candidate) => ({
          ...discoveryCandidateProjection(candidate, preview.source),
          imported: this.agentRegistry.get(candidate.profileId) !== null,
          reservedForMain: candidate.profileId === 'rj',
        })),
      }
    })()

    try {
      return await this.agentDiscoveryInFlight
    } finally {
      this.agentDiscoveryInFlight = null
    }
  }

  async importAgents({ discoveryId, agents } = {}) {
    return this.#enqueueAgentMutation(async () => {
    if (typeof discoveryId !== 'string' || !Array.isArray(agents) || agents.length === 0 || agents.length > 16) {
      throw new TypeError('AGENT_IMPORT_INVALID')
    }
    const preview = this.agentDiscoveries.get(discoveryId)
    if (!preview || preview.expiresAt < this.now()) {
      this.agentDiscoveries.delete(discoveryId)
      const error = new Error('AGENT_DISCOVERY_EXPIRED')
      error.code = 'AGENT_DISCOVERY_EXPIRED'
      throw error
    }
    this.#assertNoActiveAgentWork('AGENT_IMPORT_DURING_TASK')
    const candidates = new Map(preview.candidates.map((candidate) => [candidate.candidateId, candidate]))
    const manifests = []
    const selectedCandidateIds = new Set()
    for (const selection of agents) {
      if (!selection || typeof selection !== 'object' || Array.isArray(selection)
        || Object.keys(selection).some(key => !['candidateId', 'displayName', 'role', 'capabilities'].includes(key))
        || (selection.displayName !== undefined && (typeof selection.displayName !== 'string' || selection.displayName.trim().length === 0 || selection.displayName.length > 128))
        || (selection.role !== undefined && (typeof selection.role !== 'string' || selection.role.trim().length === 0 || selection.role.length > 512))
        || (selection.capabilities !== undefined && (!Array.isArray(selection.capabilities) || selection.capabilities.length === 0 || selection.capabilities.length > 32))) {
        const error = new Error('AGENT_IMPORT_INVALID')
        error.code = 'AGENT_IMPORT_INVALID'
        throw error
      }
      const candidate = candidates.get(selection?.candidateId)
      if (!candidate || selectedCandidateIds.has(selection.candidateId)) {
        const error = new Error('AGENT_DISCOVERY_CANDIDATE_INVALID')
        error.code = 'AGENT_DISCOVERY_CANDIDATE_INVALID'
        throw error
      }
      if (candidate.profileId === 'rj') {
        const error = new Error('AGENT_RESERVED_FOR_MAIN_PERSONA')
        error.code = 'AGENT_RESERVED_FOR_MAIN_PERSONA'
        throw error
      }
      selectedCandidateIds.add(selection.candidateId)
      manifests.push(agentManifestFromHermesCandidate(candidate, {
        ...(selection.displayName ? { displayName: selection.displayName.trim() } : {}),
        ...(selection.role ? { role: selection.role } : {}),
        ...(selection.capabilities ? { capabilities: selection.capabilities } : {}),
      }, { now: this.now }))
    }
    const imported = await this.agentRegistry.registerMany(manifests)
    const continuity = []
    for (const manifest of imported) {
      await this.#prepareContinuity(manifest.agentId, { sourceType: manifest.source.type })
      let workspace
      try {
        workspace = await this.#workspaceFor(manifest)
      } catch (error) {
        const report = await this.#publishContinuity(
          unavailableContinuity(manifest.agentId, typeof error?.code === 'string' ? error.code : 'AGENT_CONTINUITY_UNAVAILABLE'),
          { eventKind: 'agent.continuity.unavailable', sourceType: manifest.source.type },
        )
        continuity.push(report)
        continue
      }
      const report = await this.#publishContinuity(materializedContinuity(workspace), {
        eventKind: 'agent.continuity.materialized',
        sourceType: manifest.source.type,
      })
      continuity.push(report)
      try {
        await this.#openHarnessWorker(manifest, async () => {
          const error = new Error('WORKER_MODEL_EXECUTOR_NOT_BOUND')
          error.code = 'WORKER_MODEL_EXECUTOR_NOT_BOUND'
          throw error
        })
      } catch (error) {
        this.audit.append({
          kind: 'agent.worker.unavailable',
          agentId: manifest.agentId,
          sourceType: manifest.source.type,
          failureCode: typeof error?.code === 'string' ? error.code : 'AGENT_WORKER_UNAVAILABLE',
          at: new Date(this.now()).toISOString(),
        })
      }
    }
    return { schema: 'chimera.agent-import-result.v1', imported, continuity }
    })
  }

  async createAgent(input = {}) {
    this.#assertOpen()
    assertExactRecord(input, ['requestId', 'agentId', 'displayName', 'role', 'capabilities', 'persona'], 'AGENT_CREATE_REQUEST_INVALID')
    const { requestId, agentId, displayName, role, capabilities, persona } = input
    if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 256) {
      throw Object.assign(new TypeError('AGENT_CREATE_REQUEST_INVALID'), { code: 'AGENT_CREATE_REQUEST_INVALID' })
    }
    const inputHash = sha256(input)
    const existing = this.agentCreationReceipts?.get(requestId)
    if (existing) {
      if (existing.inputHash !== inputHash) {
        throw Object.assign(new Error('AGENT_CREATE_REQUEST_CONFLICT'), { code: 'AGENT_CREATE_REQUEST_CONFLICT' })
      }
      if (existing.status === 'completed') return structuredClone(existing.result)
    }
    return this.#enqueueAgentMutation(async () => {
      const repeated = this.agentCreationReceipts?.get(requestId)
      if (repeated) {
        if (repeated.inputHash !== inputHash) {
          throw Object.assign(new Error('AGENT_CREATE_REQUEST_CONFLICT'), { code: 'AGENT_CREATE_REQUEST_CONFLICT' })
        }
        if (repeated.status === 'completed') return structuredClone(repeated.result)
      }
      if (NATIVE_RESERVED_AGENT_IDS.includes(agentId)) {
        throw Object.assign(new Error('AGENT_NATIVE_ID_RESERVED'), { code: 'AGENT_NATIVE_ID_RESERVED' })
      }
      // Validate all server-held content before reserving a durable identity.
      validateNativePersonaContent(persona)
      const manifest = agentManifestFromNativeInput({ agentId, displayName, role, capabilities }, { now: this.now })
      const priorReservation = this.agentCreationReceipts?.get(requestId)
      const preexisting = this.agentRegistry.get(agentId)
      if (preexisting && (!priorReservation || priorReservation.agentId !== agentId)) {
        throw Object.assign(new Error('AGENT_ALREADY_REGISTERED'), { code: 'AGENT_ALREADY_REGISTERED' })
      }
      await this.agentCreationReceipts.reserve({ requestId, inputHash, agentId })
      let registered = this.agentRegistry.get(agentId)
      if (registered) {
        if (priorReservation?.status !== 'reserved'
          || priorReservation.agentId !== agentId
          || registered.schema !== manifest.schema || registered.source?.type !== 'chimera'
          || registered.source?.ref !== manifest.source.ref) {
          throw Object.assign(new Error('AGENT_ALREADY_REGISTERED'), { code: 'AGENT_ALREADY_REGISTERED' })
        }
      } else {
        registered = await this.agentRegistry.register(manifest)
      }
      await this.#prepareContinuity(agentId, { sourceType: registered.source.type })
      let continuity
      try {
        await this.nativeReferenceProvider.savePersona({ agentId, content: persona, changedBy: this.humanId })
      } catch (error) {
        // The identity and reservation remain durable, but the historical
        // receipt stays reserved until server-held persona bytes exist. Exact
        // retry can therefore recover after a source/storage interruption.
        await this.#publishContinuity(
          unavailableContinuity(agentId, typeof error?.code === 'string' ? error.code : 'NATIVE_PERSONA_SOURCE_UNAVAILABLE'),
          { eventKind: 'agent.continuity.source-unavailable', sourceType: registered.source.type },
        )
        throw error
      }
      try {
        const workspace = await this.#workspaceFor(registered)
        continuity = [await this.#publishContinuity(materializedContinuity(workspace), {
          eventKind: 'agent.continuity.materialized',
          sourceType: registered.source.type,
        })]
      } catch (error) {
        continuity = [await this.#publishContinuity(
          unavailableContinuity(agentId, typeof error?.code === 'string' ? error.code : 'AGENT_CONTINUITY_UNAVAILABLE'),
          { eventKind: 'agent.continuity.unavailable', sourceType: registered.source.type },
        )]
      }
      const result = {
        schema: 'chimera.agent-create-result.v1',
        requestId,
        agent: registered,
        continuity,
      }
      await this.agentCreationReceipts.put({ requestId, inputHash, result })
      return result
    })
  }

  async updateAgentMetadata(input = {}) {
    assertExactRecord(input, ['agentId', 'displayName', 'role', 'capabilities'], 'AGENT_METADATA_INPUT_INVALID')
    const { agentId, displayName, role, capabilities } = input
    return this.#enqueueAgentMutation(async () => {
      this.#assertNoActiveAgentWork('AGENT_METADATA_CHANGE_DURING_TASK')
      return this.agentRegistry.updateMetadata(agentId, { displayName, role, capabilities }, { changedBy: this.humanId })
    })
  }

  async repairAgentContinuity(input = {}) {
    assertExactRecord(input, ['agentId'], 'AGENT_CONTINUITY_REPAIR_INPUT_INVALID')
    const { agentId } = input
    return this.#enqueueAgentMutation(async () => {
      this.#assertNoActiveAgentWork('AGENT_CONTINUITY_REPAIR_DURING_TASK')
      const manifest = this.agentRegistry.get(agentId)
      if (!manifest) throw Object.assign(new Error('AGENT_NOT_REGISTERED'), { code: 'AGENT_NOT_REGISTERED' })
      await this.#prepareContinuity(agentId, { sourceType: manifest.source.type })
      try {
        const workspace = await this.#refreshWorkspaceFor(manifest)
        const report = await this.#publishContinuity(materializedContinuity(workspace), {
          eventKind: 'agent.continuity.repaired',
          sourceType: manifest.source.type,
        })
        return [report]
      } catch (error) {
        const report = await this.#publishContinuity(
          unavailableContinuity(agentId, typeof error?.code === 'string' ? error.code : 'AGENT_CONTINUITY_UNAVAILABLE'),
          { eventKind: 'agent.continuity.repair-failed', sourceType: manifest.source.type },
        )
        return [report]
      }
    })
  }

  async importMainAgent({ discoveryId, candidateId } = {}) {
    if (typeof discoveryId !== 'string' || typeof candidateId !== 'string') {
      throw new TypeError('MAIN_AGENT_IMPORT_INVALID')
    }
    const preview = this.agentDiscoveries.get(discoveryId)
    if (!preview || preview.expiresAt < this.now()) {
      this.agentDiscoveries.delete(discoveryId)
      throw Object.assign(new Error('AGENT_DISCOVERY_EXPIRED'), { code: 'AGENT_DISCOVERY_EXPIRED' })
    }
    const candidate = preview.candidates.find((entry) => entry.candidateId === candidateId)
    if (!candidate || candidate.profileId !== 'rj') {
      throw Object.assign(new Error('MAIN_AGENT_CANDIDATE_INVALID'), { code: 'MAIN_AGENT_CANDIDATE_INVALID' })
    }
    const manifest = agentManifestFromHermesCandidate(candidate, {
      role: 'CEO and main orchestrator',
      capabilities: ['orchestration', 'coding', 'reasoning', 'research'],
    }, { now: this.now })
    await this.#prepareContinuity(manifest.agentId, { sourceType: manifest.source.type })
    let workspace
    let published
    try {
      workspace = await this.#workspaceFor(manifest)
      published = await this.#publishContinuity(materializedContinuity(workspace), {
        eventKind: 'agent.continuity.main-imported',
        sourceType: manifest.source.type,
      })
    } catch (error) {
      await this.#publishContinuity(
        unavailableContinuity(manifest.agentId, typeof error?.code === 'string' ? error.code : 'AGENT_CONTINUITY_UNAVAILABLE'),
        { eventKind: 'agent.continuity.main-import-failed', sourceType: manifest.source.type },
      )
      throw error
    }
    const existing = this.mainAgentRegistry.get('rj')
    if (!existing) await this.mainAgentRegistry.register(manifest)
    this.mainAgentManifest = manifest
    this.mainAgentWorkspace = workspace
    const continuity = published.status === 'materialized'
      ? { ...workspace.state().continuity, status: published.status, failureCode: null }
      : published
    return {
      schema: 'chimera.main-agent-import-result.v1',
      agentId: this.agentId,
      displayName: 'RJ',
      personaProfileId: manifest.agentId,
      continuity,
    }
  }

  async #workspaceFor(manifest) {
    const existing = this.workerWorkspaces.get(manifest.agentId)
    if (existing) {
      validateRequiredContinuityLayers(manifest, existing.context())
      return existing
    }
    const referenceProvider = this.#referenceProviderFor(manifest)
    const workspace = await AgentWorkerWorkspace.refresh({
      rootDir: this.workerRoot,
      manifest,
      referenceProvider,
      audit: this.audit,
      now: this.now,
    })
    this.workerWorkspaces.set(manifest.agentId, workspace)
    return workspace
  }

  async #openLocalWorkspaceFor(manifest) {
    const evidence = this.agentContinuity.get(manifest.agentId)
    const builtIn = manifest.source?.type === 'chimera' && manifest.source?.sourceId === 'built-in'
    const legacyMainCapsule = this.mainAgentManifest?.agentId === manifest.agentId
      && this.mainAgentManifest?.source?.ref === manifest.source?.ref
    // Older RJ imports predate durable continuity records. They may reopen
    // only after the local capsule proves every declared required layer;
    // current records (including pending/unavailable) remain authoritative.
    if (!evidence && !legacyMainCapsule && !builtIn) {
      throw Object.assign(new Error('ASK_CONTINUITY_UNAVAILABLE'), { code: 'ASK_CONTINUITY_UNAVAILABLE' })
    }
    if (evidence?.status && evidence.status !== 'materialized') {
      throw Object.assign(new Error('ASK_CONTINUITY_UNAVAILABLE'), { code: 'ASK_CONTINUITY_UNAVAILABLE' })
    }
    const existing = this.workerWorkspaces.get(manifest.agentId)
    if (existing) {
      validateRequiredContinuityLayers(manifest, existing.context())
      const current = materializedContinuity(existing)
      if (evidence?.digest && evidence.digest !== current.digest) {
        throw Object.assign(new Error('ASK_CONTINUITY_STALE'), { code: 'ASK_CONTINUITY_STALE' })
      }
      if (evidence?.report && JSON.stringify(evidence.report) !== JSON.stringify(current.report)) {
        throw Object.assign(new Error('ASK_CONTINUITY_STALE'), { code: 'ASK_CONTINUITY_STALE' })
      }
      return existing
    }
    const workspace = await AgentWorkerWorkspace.openLocal({
      workspacePath: resolve(this.workerRoot, manifest.agentId),
      manifest,
      audit: this.audit,
      now: this.now,
    })
    const current = materializedContinuity(workspace)
    if (evidence?.digest && evidence.digest !== current.digest) {
      throw Object.assign(new Error('ASK_CONTINUITY_STALE'), { code: 'ASK_CONTINUITY_STALE' })
    }
    if (evidence?.report && JSON.stringify(evidence.report) !== JSON.stringify(current.report)) {
      throw Object.assign(new Error('ASK_CONTINUITY_STALE'), { code: 'ASK_CONTINUITY_STALE' })
    }
    this.workerWorkspaces.set(manifest.agentId, workspace)
    return workspace
  }

  async #askContinuityFor(agentId, manifest) {
    if (!manifest) return boundedAskContinuity(builtInAskContinuity(agentId))
    const builtIn = manifest.source?.type === 'chimera' && manifest.source?.sourceId === 'built-in'
    if (builtIn && !this.agentContinuity.has(agentId) && !this.workerWorkspaces.has(agentId)) {
      return boundedAskContinuity(builtInAskContinuity(agentId))
    }
    const workspace = await this.#openLocalWorkspaceFor(manifest)
    return boundedAskContinuity(workspace.context())
  }

  async #createSignedPureRouter({ leaf, identity, recipientAgentId, requestId, verificationScope = 'ask' }) {
    const grant = signGrant({
      grantId: `${verificationScope}-model-grant-${crypto.randomUUID()}`,
      humanId: this.humanId,
      agentId: recipientAgentId,
      agentKeyFingerprint: fingerprint(identity.publicKey),
      maxTier: 'auto',
      scopes: [{ capability: 'model.invoke', resource: `model:${leaf.routerId}` }],
      ...isoWindow(this.now(), 15 * 60_000),
    }, this.human)
    const gatewayRouter = createGatewayModelRouter({
      provider: leaf,
      gateway: this.gateway,
      grant,
      identity,
      audit: this.audit,
      agentId: recipientAgentId,
      now: this.now,
    })
    return createReliableModelRouter({
      provider: gatewayRouter,
      ledger: this.modelCalls,
      audit: this.audit,
      now: this.now,
      // Ask and connection verification calls intentionally stay unbound to a
      // selected task. Task work routers below provide their immutable runtime
      // closure binding instead of accepting model-visible context fields.
    })
  }

  async #connectionModelVerification({ providerId, model, requestId }) {
    if (typeof this.models.routerForAsk !== 'function') {
      throw Object.assign(new Error('ASK_EXECUTOR_NOT_PURE'), { code: 'ASK_EXECUTOR_NOT_PURE' })
    }
    const leaf = createAskModelProvider(await this.models.routerForAsk({ mode: 'pinned', providerId, model }))
    const router = await this.#createSignedPureRouter({
      leaf,
      identity: this.agent,
      recipientAgentId: this.agentId,
      requestId,
      verificationScope: `connection-test:${providerId}`,
    })
    await router.route('Reply with exactly OK.', {
      stage: 'ask',
      askRequestId: requestId,
      verificationScope: 'connection-test',
      connectionProviderId: providerId,
      connectionModel: model,
    })
    return {
      costClass: 'quota',
      modelCallSent: true,
      verification: {
        operation: 'test-model',
        model,
        executor: 'inference-only',
        status: 'passed',
        at: new Date(this.now()).toISOString(),
        modelCallSent: true,
      },
    }
  }

  async #resolveAskInvocation({ recipientAgentId, requestId, verificationScope = 'ask', preferenceOverride = null, selectionOverride = null }) {
    const isMain = recipientAgentId === this.agentId
    const manifest = isMain ? this.mainAgentManifest : this.#manifestForAgent(recipientAgentId)
    if (!isMain && !manifest) {
      throw Object.assign(new Error('ASK_RECIPIENT_NOT_REGISTERED'), { code: 'ASK_RECIPIENT_NOT_REGISTERED' })
    }
    const identity = isMain ? this.agent : this.identityStore.getOrCreate(recipientAgentId)
    const preference = preferenceOverride ? structuredClone(preferenceOverride) : this.agentModelPolicy.get(recipientAgentId)
    if (typeof this.models.routerForAsk !== 'function') {
      throw Object.assign(new Error('ASK_EXECUTOR_NOT_PURE'), { code: 'ASK_EXECUTOR_NOT_PURE' })
    }
    const capturedTarget = selectionOverride
      && selectionOverride.providerId !== 'chimera-auto'
      && selectionOverride.providerId !== 'codex'
      && selectionOverride.providerId !== 'antigravity'
      && typeof selectionOverride.providerId === 'string'
      && typeof selectionOverride.model === 'string'
      && selectionOverride.model !== 'auto'
      ? { mode: 'pinned', providerId: selectionOverride.providerId, model: selectionOverride.model }
      : preference
    const leaf = createAskModelProvider(await this.models.routerForAsk(capturedTarget))
    const context = { agentContinuity: await this.#askContinuityFor(recipientAgentId, manifest) }
    if (selectionOverride && capturedTarget !== preference) {
      if (leaf.descriptor?.providerId !== selectionOverride.providerId || leaf.descriptor?.model !== selectionOverride.model) {
        throw Object.assign(new Error('AGENT_READINESS_BINDING_CHANGED'), { code: 'AGENT_READINESS_BINDING_CHANGED' })
      }
      const connection = this.connectionState().find(entry => entry.providerId === selectionOverride.providerId)
      const currentBinding = connection ? {
        connectionEnabled: connection.enabled,
        connectionRevision: connection.revision,
        connectionStatus: connection.status,
        connectionMachineRef: connection.provenance.machineRef,
        connectionAccountRef: connection.provenance.accountRef,
        connectionSignedIn: connection.provenance.signedIn,
      } : {}
      for (const field of ['connectionEnabled', 'connectionRevision', 'connectionStatus', 'connectionMachineRef', 'connectionAccountRef', 'connectionSignedIn']) {
        if (selectionOverride[field] !== undefined && selectionOverride[field] !== currentBinding[field]) {
          throw Object.assign(new Error('AGENT_READINESS_BINDING_CHANGED'), { code: 'AGENT_READINESS_BINDING_CHANGED' })
        }
      }
    }
    const router = await this.#createSignedPureRouter({ leaf, identity, recipientAgentId, requestId, verificationScope })
    return {
      router,
      agentId: recipientAgentId,
      context: { ...context, stage: 'ask', askRequestId: requestId, verificationScope },
      descriptor: leaf.descriptor,
      requestId,
    }
  }

  #referenceProviderFor(manifest) {
    if (manifest?.source?.type === 'chimera') return this.nativeReferenceProvider
    if (manifest?.source?.type === 'hermes') return this.agentReferenceProvider
    throw Object.assign(new Error('AGENT_REFERENCE_PROVIDER_UNSUPPORTED'), { code: 'AGENT_REFERENCE_PROVIDER_UNSUPPORTED' })
  }

  async #refreshWorkspaceFor(manifest) {
    const referenceProvider = this.#referenceProviderFor(manifest)
    const workspace = await AgentWorkerWorkspace.refresh({
      rootDir: this.workerRoot,
      manifest,
      referenceProvider,
      audit: this.audit,
      now: this.now,
    })
    this.workerWorkspaces.set(manifest.agentId, workspace)
    return workspace
  }

  async #publishContinuity(report, { eventKind = 'agent.continuity.updated', sourceType = null } = {}) {
    let current = structuredClone(report)
    try {
      await this.audit.append({
        kind: eventKind,
        agentId: current.agentId,
        ...(sourceType ? { sourceType } : {}),
        ...(current.status === 'materialized' ? { digest: current.digest } : { failureCode: current.failureCode }),
        report: current.report,
        at: new Date(this.now()).toISOString(),
      })
    } catch {
      const unavailable = unavailableContinuity(current.agentId, 'AGENT_CONTINUITY_AUDIT_UNAVAILABLE')
      this.agentContinuity.set(unavailable.agentId, unavailable)
      try {
        await this.agentContinuityRecords.put(unavailable)
      } catch (error) {
        throw Object.assign(new Error('AGENT_CONTINUITY_PERSIST_FAILED'), {
          code: 'AGENT_CONTINUITY_PERSIST_FAILED',
          cause: error,
        })
      }
      return unavailable
    }
    try {
      await this.agentContinuityRecords.put(current)
    } catch (error) {
      const unavailable = unavailableContinuity(
        current.agentId,
        typeof error?.code === 'string' ? error.code : 'AGENT_CONTINUITY_PERSIST_FAILED',
      )
      this.agentContinuity.set(unavailable.agentId, unavailable)
      try {
        await this.agentContinuityRecords.put(unavailable)
      } catch (fallbackError) {
        throw Object.assign(new Error('AGENT_CONTINUITY_PERSIST_FAILED'), {
          code: 'AGENT_CONTINUITY_PERSIST_FAILED',
          cause: fallbackError,
        })
      }
      return unavailable
    }
    this.agentContinuity.set(current.agentId, current)
    return current
  }

  async #prepareContinuity(agentId, { sourceType = null } = {}) {
    const marker = unavailableContinuity(agentId, 'AGENT_CONTINUITY_PENDING')
    try {
      await this.agentContinuityRecords.put(marker)
    } catch (error) {
      throw Object.assign(new Error('AGENT_CONTINUITY_PERSIST_FAILED'), {
        code: 'AGENT_CONTINUITY_PERSIST_FAILED',
        cause: error,
      })
    }
    this.agentContinuity.set(agentId, marker)
    try {
      await this.audit.append({
        kind: 'agent.continuity.pending',
        agentId,
        ...(sourceType ? { sourceType } : {}),
        failureCode: marker.failureCode,
        report: marker.report,
        at: new Date(this.now()).toISOString(),
      })
    } catch {
      // The marker is already durable; leave it pending and require explicit
      // repair if the audit sink is unavailable.
    }
    return marker
  }

  async #openHarnessWorker(manifest, executeModel, security = null) {
    const { identity, grant } = security ?? this.#securityForSpecialist(manifest)
    const worker = await AgentHarnessWorker.open({
      manifest,
      workspace: await this.#workspaceFor(manifest),
      mailbox: this.agentMailbox,
      identity,
      grant,
      gateway: this.gateway,
      audit: this.audit,
      humanKeys: [[this.human.keyId, exportPublicKey(this.human.publicKey)]],
      stateFile: resolve(this.workerStateDir, `${manifest.agentId}.json`),
      inventory: this.dshInventory,
      approvalBroker: this.workerApprovalBroker,
      executeModel,
      toolExecutors: this.workerToolExecutors,
      runtimeId: this.runtimeId,
      now: this.now,
    })
    this.workers.set(manifest.agentId, worker)
    return worker
  }

  async startAgent(agentId) {
    const manifest = this.#manifestForAgent(agentId)
    if (!manifest) throw Object.assign(new Error('AGENT_NOT_REGISTERED'), { code: 'AGENT_NOT_REGISTERED' })
    const worker = this.workers.get(agentId) ?? await this.#openHarnessWorker(manifest, async () => {
      throw Object.assign(new Error('WORKER_MODEL_EXECUTOR_NOT_BOUND'), { code: 'WORKER_MODEL_EXECUTOR_NOT_BOUND' })
    })
    return worker.start()
  }

  async stopAgent(agentId) {
    const worker = this.workers.get(agentId)
    if (!worker) throw Object.assign(new Error('AGENT_WORKER_NOT_OPEN'), { code: 'AGENT_WORKER_NOT_OPEN' })
    // Both fences start synchronously: revoke existing/reserved document leases,
    // then stop worker admission before either durable operation is awaited.
    // Conservative first slice: stopping one participant revokes the task's shares.
    const ownerTaskId = this.workerOwners.get(agentId)
    const revocation = ownerTaskId ? this.accountCompanion.revokeTask(ownerTaskId) : Promise.resolve()
    const stopping = worker.stop()
    const [, status] = await Promise.all([revocation, stopping])
    return status
  }

  async removeAgent(agentId) {
    if (typeof agentId !== 'string' || !AGENT_ID.test(agentId)) throw Object.assign(new TypeError('AGENT_ID_INVALID'), { code: 'AGENT_ID_INVALID' })
    if (agentId === this.agentId || agentId === 'rj') {
      throw Object.assign(new Error('AGENT_MAIN_CANNOT_REMOVE'), { code: 'AGENT_MAIN_CANNOT_REMOVE' })
    }
    if (agentId === DEFAULT_RESEARCHER_MANIFEST.agentId && !this.agentRegistry.get(agentId)) {
      throw Object.assign(new Error('AGENT_BUILTIN_CANNOT_REMOVE'), { code: 'AGENT_BUILTIN_CANNOT_REMOVE' })
    }
    const manifest = this.agentRegistry.get(agentId)
    if (!manifest) throw Object.assign(new Error('AGENT_NOT_REGISTERED'), { code: 'AGENT_NOT_REGISTERED' })
    if (this.activeTasks.size > 0 || this.tasks.active().length > 0) {
      throw Object.assign(new Error('AGENT_REMOVAL_DURING_TASK'), { code: 'AGENT_REMOVAL_DURING_TASK' })
    }

    let harnessWorkerStopped = false
    const existing = this.workers.get(agentId)
    if (existing) {
      const currentState = existing.status().state
      if (['running', 'interrupted', 'crashed'].includes(currentState)) {
        await existing.stop()
        harnessWorkerStopped = true
      }
    }

    const stoppedSessions = []
    const sessions = this.workerRuntimeManager?.state?.().sessions ?? []
    for (const session of sessions.filter((entry) => entry.agentId === agentId
      && ['starting', 'ready', 'stopping'].includes(entry.status))) {
      stoppedSessions.push(await this.workerRuntimeManager.stop(session.workerSessionId, { agentId }))
    }

    await removeAgentWorkerWorkspace({ rootDir: this.workerRoot, agentId })
    await removeAgentWorkerState({ stateDir: this.workerStateDir, agentId })
    await this.agentAccessPolicy.remove(agentId, { removedBy: this.humanId })
    await this.agentModelPolicy.remove(agentId, { removedBy: this.humanId })
    const removed = await this.agentRegistry.unregister(agentId, {
      removedBy: this.humanId,
      reason: 'operator-request',
    })
    this.workers.delete(agentId)
    this.workerWorkspaces.delete(agentId)
    this.specialistSecurity.delete(agentId)
    const removedAt = new Date(this.now()).toISOString()
    this.audit.append({
      kind: 'agent.removed',
      agentId,
      displayName: removed.displayName,
      harnessWorkerStopped,
      workerSessionsStopped: stoppedSessions.length,
      removedBy: this.humanId,
      at: removedAt,
    })
    return {
      schema: 'chimera.agent-removal-result.v1',
      agentId,
      displayName: removed.displayName,
      removedAt,
      harnessWorkerStopped,
      workerSessionsStopped: stoppedSessions.length,
    }
  }

  async recoverAgent(agentId) {
    const manifest = this.#manifestForAgent(agentId)
    if (!manifest) throw Object.assign(new Error('AGENT_NOT_REGISTERED'), { code: 'AGENT_NOT_REGISTERED' })
    const worker = this.workers.get(agentId) ?? await this.#openHarnessWorker(manifest, async () => {
      throw Object.assign(new Error('WORKER_MODEL_EXECUTOR_NOT_BOUND'), { code: 'WORKER_MODEL_EXECUTOR_NOT_BOUND' })
    })
    return worker.recover()
  }

  async setAgentAccess(agentId, profileId) {
    const manifest = this.#manifestForAgent(agentId)
    if (agentId !== this.agentId && !manifest) throw Object.assign(new Error('AGENT_NOT_REGISTERED'), { code: 'AGENT_NOT_REGISTERED' })
    if (this.activeTasks.size > 0 || this.tasks.active().length > 0) {
      throw Object.assign(new Error('AGENT_ACCESS_CHANGE_DURING_TASK'), { code: 'AGENT_ACCESS_CHANGE_DURING_TASK' })
    }
    const existing = this.workers.get(agentId)
    const wasRunning = existing?.status().state === 'running'
    if (wasRunning) await existing.stop()
    const access = await this.agentAccessPolicy.set(agentId, profileId, { changedBy: this.humanId })
    if (agentId === this.agentId) return access
    this.workers.delete(agentId)
    this.specialistSecurity.delete(agentId)
    const worker = await this.#openHarnessWorker(manifest, async () => {
      throw Object.assign(new Error('WORKER_MODEL_EXECUTOR_NOT_BOUND'), { code: 'WORKER_MODEL_EXECUTOR_NOT_BOUND' })
    })
    if (wasRunning) await worker.start()
    return access
  }

  async setAgentModel(agentId, preference) {
    if (agentId !== this.agentId && !this.#manifestForAgent(agentId)) {
      throw Object.assign(new Error('AGENT_NOT_REGISTERED'), { code: 'AGENT_NOT_REGISTERED' })
    }
    if (this.activeTasks.size > 0 || this.tasks.active().length > 0) {
      throw Object.assign(new Error('AGENT_MODEL_CHANGE_DURING_TASK'), { code: 'AGENT_MODEL_CHANGE_DURING_TASK' })
    }
    if (preference?.mode !== 'auto') {
      const description = typeof this.models.describeSelection === 'function'
        ? this.models.describeSelection(preference)
        : (() => {
            const provider = this.models.state().providers?.find(entry => entry.id === preference.providerId && entry.configured)
            const model = provider?.models?.find(entry => entry.id === preference.model)
            const eligible = Boolean(model?.capabilities?.includes('conversation'))
            return { eligible, availability: model?.availability ?? 'unavailable' }
          })()
      const providerState = this.models.state().providers?.find(entry => entry.id === preference.providerId)
      const catalogModel = providerState?.models?.find(entry => entry.id === preference.model)
      const catalogOnly = providerState?.configured === true
        && catalogModel?.capabilities?.includes('conversation')
        && (description?.availability === 'catalog-only' || catalogModel?.availability === 'catalog-only')
      const boundaryReady = ['authenticated', 'verified-route', 'verified-manual'].includes(description?.availability)
      const antigravityReady = preference.providerId === 'antigravity' && description?.availability === 'local-ready'
      // Local native routes are reported as `available` by the measured
      // registry. Saving that work binding is valid even though the separate
      // pure Ask/test adapter may later report unsupported.
      const measuredRoute = description?.availability === 'available'
      const ready = description?.eligible === true && (boundaryReady || antigravityReady || catalogOnly || measuredRoute)
      if (!ready) {
        throw Object.assign(new Error('AGENT_MODEL_NOT_ELIGIBLE'), { code: 'AGENT_MODEL_NOT_ELIGIBLE' })
      }
    }
    return this.agentModelPolicy.set(agentId, preference, { changedBy: this.humanId })
  }

  jevStatus() { return this.jevSettings.status() }

  async saveJevKey(apiKey) {
    const status = await this.jevSettings.save(apiKey)
    this.audit.append({ kind: 'jev.settings.updated', configured: true, at: new Date(this.now()).toISOString() })
    return status
  }

  async disconnectJev() {
    const status = await this.jevSettings.disconnect()
    this.audit.append({ kind: 'jev.settings.updated', configured: false, at: new Date(this.now()).toISOString() })
    return status
  }

  openRouterStatus() { return this.openRouterSettings.status() }

  async saveOpenRouterSettings(input) {
    const before = this.#connectionBinding('openrouter')
    const status = await this.openRouterSettings.save(input)
    this.modelConfig.openAiCompatibleProviders.find(provider => provider.id === 'openrouter').models =
      status.models.map(id => ({ id, name: id, capabilities: ['conversation', 'orchestration', 'coding', 'reasoning', 'research', 'bulk'],
        inputModalities: ['TEXT'], outputModalities: ['TEXT'] }))
    this.models.setOpenAiCompatibleModels?.('openrouter', status.models)
    await this.#invalidateConnectionBinding('openrouter', before)
    this.audit.append({ kind: 'openrouter.settings.updated', configured: true, at: new Date(this.now()).toISOString() })
    return status
  }

  async disconnectOpenRouter() {
    const before = this.#connectionBinding('openrouter')
    const status = await this.openRouterSettings.disconnect()
    this.models.setOpenAiCompatibleModels?.('openrouter', status.models)
    await this.#invalidateConnectionBinding('openrouter', before)
    this.audit.append({ kind: 'openrouter.settings.updated', configured: false, at: new Date(this.now()).toISOString() })
    return status
  }

  async refreshClaudeCode({ invalidateBinding = true } = {}) {
    const before = invalidateBinding ? this.#connectionBinding('claude-code') : null
    const state = await this.claudeCode.refresh()
    this.models.refreshClaudeCode?.()
    if (before) await this.#invalidateConnectionBinding('claude-code', before)
    return state
  }

  #jevForAgent({ grant, identity, agentId }) {
    if (!this.jevSettings.status().configured) return null
    return createJevDecisionService({
      router: createReliableModelRouter({
        provider: createGatewayModelRouter({ provider: this.jevProvider,
          gateway: this.gateway, grant, identity, audit: this.audit, agentId, now: this.now }),
        ledger: this.modelCalls, audit: this.audit, now: this.now,
      }),
      audit: this.audit, now: this.now,
    })
  }

  async #routerForAgent(agentId, {
    taskId = null,
    nodeId = null,
    assignmentId = null,
    capturedSelection = null,
    taskModelPreference = null,
    taskRequirements = null,
    taskStage = 'specialist',
    decisionService = null,
  } = {}) {
    const policyPreference = this.agentModelPolicy.get(agentId)
    // A task-level model preference narrows the operator's captured default,
    // but it cannot weaken an explicit agent pin.  Preferred is still a
    // pre-dispatch choice and may fall back to the captured default; Pinned
    // remains fail-closed when the agent pin conflicts with it.
    const taskPreference = taskModelPreference?.mode === 'preferred' || taskModelPreference?.mode === 'pinned'
      ? structuredClone(taskModelPreference)
      : null
    const effectivePreference = policyPreference.mode === 'pinned'
      ? policyPreference
      : taskPreference ?? policyPreference
    // A task captures the operator's selected model at admission. Auto agent
    // policies must use that binding for the task lifetime; otherwise a later
    // global selection change can silently retarget queued work. Agent-level
    // Preferred/Pinned policies remain stronger than this task default.
    const hasCapturedSelection = capturedSelection
      && typeof capturedSelection.providerId === 'string'
      && typeof capturedSelection.model === 'string'
      && capturedSelection.providerId !== 'chimera-auto'
      && capturedSelection.model !== 'auto'
    const supportsTaskRoutingScope = this.models?.supportsTaskRoutingScope === true
    const hasRouterFor = typeof this.models.routerFor === 'function'
    const bindTaskSelection = supportsTaskRoutingScope
      && effectivePreference.mode === 'auto' && hasCapturedSelection
    const preference = bindTaskSelection
      ? { mode: 'pinned', providerId: capturedSelection.providerId, model: capturedSelection.model }
      : effectivePreference
    const toolScope = this.#routingToolScope(agentId, taskId, taskStage)
    const scope = {
      agentId,
      ...toolScope,
      ...(taskId ? { taskId } : {}),
      ...(nodeId ? { nodeId } : {}),
      ...(assignmentId ? { assignmentId } : {}),
      ...(capturedSelection && typeof capturedSelection === 'object'
        ? { capturedSelection: structuredClone(capturedSelection) }
        : {}),
      ...(preference.mode === 'pinned' && typeof preference.providerId === 'string' && typeof preference.model === 'string'
        ? { taskSelection: { providerId: preference.providerId, model: preference.model } }
        : {}),
    }
    // Function arity is not a reliable capability signal: the native fabric
    // exposes a defaulted second parameter and therefore reports length 0.
    // Passing the additive scope to legacy registries is harmless; the fabric
    // uses it to bind trusted agent/task eligibility before dispatch.
    const scopedRouterFor = supportsTaskRoutingScope && hasRouterFor
    const fallbackScope = {
      ...scope,
      ...(capturedSelection && typeof capturedSelection === 'object'
        ? { taskSelection: capturedSelection.providerId === 'chimera-auto' || capturedSelection.model === 'auto'
          ? undefined
          : { providerId: capturedSelection.providerId, model: capturedSelection.model } }
        : {}),
    }
    if (fallbackScope.taskSelection === undefined) delete fallbackScope.taskSelection
    const fallbackRouter = async () => {
      if (hasRouterFor) {
        try {
          // Preferred fallback is bound to the admission-time selection. It
          // cannot silently use a newer operator selection for this task.
          return await this.models.routerFor({ mode: 'auto' }, fallbackScope, { decisionService })
        } catch (autoError) {
          // Legacy registries expose only their owned global Auto route. That
          // compatibility path is not used by scoped model fabrics, where the
          // captured scope is required for a safe fallback.
          if (!scopedRouterFor && typeof this.models.router === 'function') return this.models.router()
          throw autoError
        }
      }
      return this.models.router()
    }
    let preferredFallbackAttempted = false
    const preferredOrFallback = async (preferredRouter) => {
      // A task may intentionally omit an explicit requirements object.  The
      // model router still derives orchestration for CEO planning and
      // synthesis from the stage, so Preferred must preflight that same
      // effective requirement before the first provider call. Specialist
      // capability inference depends on the actual objective, so specialist
      // routers retain a pure invocation-time selection wrapper below.
      const preflightRequirements = taskRequirements ?? (
        taskStage === 'decompose' || taskStage === 'synthesize'
          ? normalizeTaskRequirements({ capabilities: ['orchestration'] })
          : null
      )
      const explain = typeof preferredRouter?.explain === 'function' ? preferredRouter.explain.bind(preferredRouter) : null
      if (preference.mode !== 'preferred' || !explain) return preferredRouter
      if (preflightRequirements) {
        let explanation
        try {
          explanation = explain({
            requirements: preflightRequirements,
            context: { ...(taskId ? { taskId } : {}), stage: taskStage },
          })
        } catch {
          // An explanation failure is not proof of ineligibility. Preserve the
          // preferred route and let the normal trusted path decide before any
          // provider dispatch.
          return preferredRouter
        }
        if (preferredExplanationProvesIneligible(explanation)) {
          preferredFallbackAttempted = true
          this.audit?.append({
            kind: 'agent.model.fallback',
            agentId,
            providerId: preference.providerId,
            model: preference.model,
            reason: 'PREFERRED_ROUTE_INELIGIBLE_BEFORE_DISPATCH',
            at: new Date(this.now()).toISOString(),
          })
          return fallbackRouter()
        }
      }
      if (taskStage !== 'specialist') return preferredRouter

      // The specialist objective is only available when the delegation is
      // executed. Prepare the captured fallback router now (construction is
      // pure and does not dispatch), then choose between its and Preferred's
      // actual invocation explanations inside the gateway-wrapped route.
      let invocationFallback = null
      let invocationFallbackError = null
      try {
        invocationFallback = await fallbackRouter()
      } catch (error) {
        invocationFallbackError = error
      }
      return createInvocationPreferredFallbackRouter({
        preferredRouter,
        fallbackRouter: invocationFallback,
        fallbackError: invocationFallbackError,
        audit: this.audit,
        agentId,
        providerId: preference.providerId,
        model: preference.model,
        now: this.now,
      })
    }
    if (preference.mode === 'auto') {
      if (scopedRouterFor) {
        try {
          return await this.models.routerFor(preference, scope, { decisionService })
        } catch (error) {
          if (typeof this.models.router === 'function') return this.models.router()
          throw error
        }
      }
      // The pre-scope registry contract kept the root/CEO Auto route on its
      // already-owned default router, while specialist Auto policies went
      // through routerFor so their policy remained observable to deterministic
      // registries. Preserve that distinction for legacy registries; actual
      // task-aware fabrics take the scoped path above.
      if (hasRouterFor && agentId !== this.agentId) {
        try {
          return await this.models.routerFor(preference, scope, { decisionService })
        } catch (error) {
          if (typeof this.models.router === 'function') return this.models.router()
          throw error
        }
      }
      return this.models.router()
    }
    if (!hasRouterFor) {
      if (preference.mode === 'preferred') return this.models.router()
      throw Object.assign(new Error('AGENT_MODEL_ROUTER_UNSUPPORTED'), { code: 'AGENT_MODEL_ROUTER_UNSUPPORTED' })
    }
    try {
      return await preferredOrFallback(await this.models.routerFor(preference, scope, { decisionService }))
    } catch (error) {
      if (preference.mode !== 'preferred') throw error
      if (preferredFallbackAttempted) throw error
      this.audit.append({
        kind: 'agent.model.fallback',
        agentId,
        providerId: preference.providerId,
        model: preference.model,
        reason: typeof error?.code === 'string' ? error.code : 'MODEL_UNAVAILABLE',
        at: new Date(this.now()).toISOString(),
      })
      return fallbackRouter()
    }
  }

  async waitForTask(taskId) {
    // A queued task may not own an executor yet. Wait through preceding jobs,
    // but return paused recovery work immediately instead of hanging forever.
    while (true) {
      const active = this.activeTasks.get(taskId)
      if (active) { await active; break }
      const queued = this.tasks.get(taskId)
      const preceding = this.activeTasks.values().next().value
      if (queued?.status !== 'queued' || queued.recoveryRequired || !preceding) break
      await preceding
    }
    const record = this.tasks.get(taskId)
    if (!record) throw new Error('TASK_NOT_FOUND')
    return record
  }

  #routingToolScope(agentId, taskId, stage = 'specialist') {
    // CEO decomposition and synthesis may plan delegated tool work, but they
    // do not themselves hold the specialist's tool lease. Required-tool
    // eligibility is therefore deferred until the actual worker route.
    if (agentId === this.agentId || stage === 'decompose' || stage === 'synthesize') {
      return { toolAuthority: 'deferred', toolCapabilities: [] }
    }
    const task = typeof taskId === 'string' ? this.tasks?.get(taskId) : null
    const manifest = typeof agentId === 'string' ? this.#manifestForAgent(agentId) : null
    if (!task || !manifest || !hasTaskHarness(manifest)) {
      return { toolAuthority: 'runtime', toolCapabilities: [] }
    }
    const projectTask = typeof task.context?.projectId === 'string'
    const lease = projectTask ? this.taskAccessLeases?.activeFor(agentId, taskId) : null
    if (projectTask && !lease) return { toolAuthority: 'runtime', toolCapabilities: [] }
    let profileId
    try {
      profileId = lease?.profileId ?? this.agentAccessPolicy?.get(agentId)?.profileId
    } catch {
      profileId = null
    }
    if (typeof profileId !== 'string' || !this.workerToolExecutors) {
      return { toolAuthority: 'runtime', toolCapabilities: [] }
    }
    const tools = new Set()
    for (const tool of [...toolsForAccessProfile(profileId), ...PEER_TOOLS]) {
      if (!PEER_TOOLS.includes(tool) && typeof this.workerToolExecutors[tool] !== 'function') continue
      if (projectTask && tool === 'mcp__chimera_worker__code') continue
      tools.add(tool)
      try {
        const capability = this.dshInventory?.classify(tool)?.capability
        if (typeof capability === 'string' && capability.length > 0) tools.add(capability)
      } catch {
        // Peer/task tools may be owned by the dispatcher rather than DSH. The
        // raw runtime tool name remains bounded proof of that worker scope.
      }
    }
    return { toolAuthority: 'runtime', toolCapabilities: [...tools].toSorted() }
  }

  #taskRequirementsForNode(taskId, nodeId = null) {
    const task = typeof taskId === 'string' ? this.tasks?.get(taskId) : null
    const rootRequirements = task?.context?.requirements
    if (nodeId === null || nodeId === undefined) return rootRequirements
    const node = task?.plan?.nodes?.find(candidate => candidate.nodeId === nodeId)
    if (!node) throw Object.assign(new Error('TASK_PLAN_NODE_NOT_FOUND'), { code: 'TASK_PLAN_NODE_NOT_FOUND' })
    if (rootRequirements === undefined && node.requirements === undefined) return undefined
    return combineTaskRequirements(rootRequirements, node.requirements)
  }

  taskHistory({ limit = 50, before = null } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw Object.assign(new TypeError('TASK_LIST_LIMIT_INVALID'), { code: 'TASK_LIST_LIMIT_INVALID' })
    const tasks = this.tasks.list({ limit, before }).map(taskProjection)
    return { tasks, nextCursor: tasks.length === limit ? tasks.at(-1).taskId : null }
  }

  // Pure selected-task read model. This intentionally does not delegate to
  // state(): that method sweeps durable mailboxes and refreshes global browser
  // state, neither of which is safe for an authenticated GET.
  taskWorkspace(taskId) {
    if (typeof taskId !== 'string' || taskId.length === 0 || taskId.length > 256) {
      throw Object.assign(new TypeError('TASK_WORKSPACE_INVALID'), { code: 'TASK_WORKSPACE_INVALID' })
    }
    const record = this.tasks?.get(taskId)
    if (!record) throw Object.assign(new Error('TASK_NOT_FOUND'), { code: 'TASK_NOT_FOUND' })
    const task = taskProjection(record)
    const projectSessionTaskId = record.context?.projectSessionTaskId ?? null
    let session = null
    if (this.projectSessions?.get) {
      const sourceSessionId = projectSessionTaskId ?? taskId
      const sourceSession = this.projectSessions.get(sourceSessionId)
      if (sourceSession && sourceSession.taskId === sourceSessionId) {
        // Continuations may explicitly point at an existing project session;
        // retain that provenance without making it a new source task.
        session = sourceSessionId === taskId
          ? sourceSession
          : { ...sourceSession, taskId, sourceTaskId: sourceSessionId }
      }
    }
    const messages = this.conversations?.list
      ? this.conversations.list(`task:${taskId}`, { limit: 200 })
      : []
    const team = this.teamDispatchers.get(taskId)?.state?.()
      ?? (this.agentMailbox ? teamMessagingProjection(this.agentMailbox, taskId) : null)
    const decisions = this.decisions?.all?.() ?? []
    const leases = this.taskAccessLeases?.list?.() ?? []
    const review = this.taskWorkspaceReviewCache.get(taskId)
      ?? (projectSessionTaskId ? this.taskWorkspaceReviewCache.get(projectSessionTaskId) : null)
    const retainedReview = review && review.taskId === taskId
      ? review
      : review ? {
        ...review,
        taskId,
        sourceTaskId: review.taskId,
        stale: true,
        staleReason: review.staleReason ?? 'CONTINUATION_SOURCE_REVIEW',
      } : null
    const browserBindings = Array.isArray(this.taskWorkspaceBrowserBindings)
      ? this.taskWorkspaceBrowserBindings
      : []
    const routing = record.routing ? { ...structuredClone(record.routing), taskId } : null
    const permissions = projectTaskPermissions(leases, routing, this.agentAccessPolicy)
    // Worker runtime artifacts do not carry task identity. Keep them out of a
    // task view unless a producer has already recorded the binding explicitly;
    // an agent name or globally active worker is not an attribution join key.
    const artifacts = []
    const evidence = this.#taskOutcomeProjection(task, retainedReview)
    const recovery = this.#taskRecoveryProjection(task)
    return buildTaskWorkspace({
      taskId,
      task,
      plan: record.plan ? { ...structuredClone(record.plan), steps: structuredClone(record.steps ?? []) } : session?.plan ? { ...structuredClone(session.plan), revision: record.plan?.revision ?? null } : null,
      team,
      messages,
      decisions,
      leases: permissions,
      session,
      review: retainedReview,
      artifacts,
      browserBindings,
      routing,
      evidence,
      recovery,
    })
  }

  #routeEligibility(route, { requirements, context = {}, scope = null } = {}) {
    const providerId = route?.providerId
    const connectionEnabled = providerId === undefined || providerId === 'chimera'
      ? true
      : (() => {
          try { return this.connectionPolicy?.get(providerId).enabled !== false } catch { return false }
        })()
    // The invoking identity is captured by the runtime-owned router scope.  A
    // route descriptor (or request context) is not an authority source: it
    // may describe the provider/model, but cannot choose which specialist's
    // policy or task grant is being exercised.
    const ownerAgentId = typeof scope?.agentId === 'string' ? scope.agentId : null
    const manifest = ownerAgentId === this.agentId
      ? true
      : typeof ownerAgentId === 'string' && Boolean(this.#manifestForAgent(ownerAgentId)?.enabled)
    let preference = { mode: 'auto' }
    if (ownerAgentId) {
      try { preference = this.agentModelPolicy?.get(ownerAgentId) ?? preference } catch {}
    }
    const exactModel = route?.providerId === preference.providerId && route?.model === preference.model
    const taskSelection = scope?.taskSelection
    const taskModelMatches = !taskSelection
      || (route?.providerId === taskSelection.providerId && route?.model === taskSelection.model)
    // Preferred is a preference, not a hard pin.  The router's shared
    // selection path may fall back before dispatch; only Pinned rejects a
    // non-matching candidate here.
    const modelMatches = ownerAgentId !== null && (preference.mode !== 'pinned'
      || exactModel)
    const taskId = typeof scope?.taskId === 'string' ? scope.taskId : null
    const task = typeof taskId === 'string' ? this.tasks?.get(taskId) : null
    const nativeExecutorBound = !route?.nativeExecution
      || Boolean(this.taskControllers?.get(taskId)?.grantId
        && (ownerAgentId === this.agentId || this.workerOwners?.get(ownerAgentId) === taskId))
    const taskBound = !route?.nativeExecution || Boolean(task && ['submitted', 'running'].includes(task.status))
    const requiredTools = Array.isArray(requirements?.requiredTools) ? requirements.requiredTools : []
    const trustedTools = Array.isArray(scope?.toolCapabilities) ? scope.toolCapabilities : []
    const requiredToolsSatisfied = requiredTools.length === 0
      || scope?.toolAuthority === 'deferred'
      || (scope?.toolAuthority === 'runtime' && requiredTools.every(tool => trustedTools.includes(tool)))
    const reasons = []
    if (!connectionEnabled) reasons.push('connection is disabled')
    if (!manifest) reasons.push('agent is not enabled')
    if (!modelMatches) reasons.push('agent pin does not match this route')
    if (!taskModelMatches) reasons.push('task captured model does not match this route')
    if (!ownerAgentId) reasons.push('invoking agent authority is unavailable')
    if (!taskBound) reasons.push('native executor requires a running task binding')
    if (!nativeExecutorBound) reasons.push('native executor/session is not task-bound')
    if (!requiredToolsSatisfied) reasons.push(scope?.toolAuthority === 'runtime'
      ? 'required tool is not available to the task executor'
      : 'required tool authority is unavailable')
    return {
      connectionEnabled,
      agentAllowed: manifest && modelMatches && taskModelMatches,
      executorAllowed: taskBound && nativeExecutorBound,
      requirementsSatisfied: requiredToolsSatisfied,
      pinSatisfied: modelMatches && taskModelMatches,
      reasons,
      ...(providerId ? { providerId } : {}),
      ...(route?.model ? { model: route.model } : {}),
      ...(requirements?.schema ? { requirementsSchema: requirements.schema } : {}),
    }
  }

  #taskEffectMatchesAdmission(task, receipt, destination) {
    if (!task || !receipt) return false
    const context = task.context ?? {}
    if (receipt.operation === 'resume-queued') {
      const expectedScope = context.projectId ? 'project' : 'root'
      return destination.scope === expectedScope
        && destination.taskId === task.taskId
        && task.recoveryRequired === false
        && task.queueResume?.requestId === receipt.requestId
        && task.queueResume?.requestHash === receipt.requestHash
        && task.queueResume?.destinationRevision === task.destinationRevision
        && task.queueResume?.expectedDestinationRevision === destination.expectedDestinationRevision
    }
    if (task.admissionRequestId !== receipt.requestId
      || task.admissionRequestHash !== receipt.requestHash) return false
    if (receipt.operation === 'new-task') {
      return destination.scope === 'root'
        && !context.projectId
        && (context.conversationId ?? null) === (destination.conversationId ?? null)
        && (context.requestedSpecialistAgentId ?? null) === (destination.requestedSpecialistAgentId ?? null)
    }
    if (receipt.operation === 'project-task') {
      return destination.scope === 'project'
        && context.projectId === destination.projectId
        && context.projectSessionTaskId === task.taskId
    }
    if (receipt.operation === 'send-message') {
      const expectedSpecialist = destination.recipientAgentId === this.agentId ? null : destination.recipientAgentId
      return context.conversationId === destination.conversationId
        && (context.requestedSpecialistAgentId ?? null) === expectedSpecialist
    }
    if (receipt.operation === 'continuation') {
      return context.priorTaskId === destination.taskId
    }
    if (receipt.operation === 'rj-aws-verify') {
      return context.source === 'rj-aws-verification'
        && Array.isArray(destination.operations)
        && JSON.stringify(context.operations) === JSON.stringify(destination.operations)
    }
    return false
  }

  taskAdmissionStatus(requestId) {
    const receipt = this.tasks.getAdmission(requestId)
    if (!receipt) return null
    const destination = receipt.destination ?? {}
    let reconciled = false
    if (receipt.operation === 'task-message' && receipt.messageId) {
      const message = this.conversations.getMessage(receipt.messageId)
      reconciled = Boolean(message
        && message.taskId === destination.taskId
        && message.conversationId === `task:${destination.taskId}`
        && message.provenance?.source === 'operator-task-guidance'
        && message.requestId === receipt.requestId
        && message.requestHash === receipt.requestHash
        && JSON.stringify([...message.recipientAgentIds].toSorted()) === JSON.stringify([...(destination.recipientAgentIds ?? [])].toSorted())
        && (message.replyTo ?? null) === (destination.replyTo ?? null))
    } else if (receipt.operation === 'task-steer') {
      const task = receipt.taskId ? this.tasks.get(receipt.taskId) : null
      reconciled = Boolean(task?.steering?.some(entry => entry.requestId === receipt.requestId && entry.requestHash === receipt.requestHash))
    } else if (['new-task', 'project-task', 'send-message', 'continuation', 'rj-aws-verify', 'resume-queued'].includes(receipt.operation)) {
      const task = receipt.taskId ? this.tasks.get(receipt.taskId) : null
      reconciled = this.#taskEffectMatchesAdmission(task, receipt, destination)
      if (reconciled && receipt.operation === 'send-message' && receipt.messageId) {
        const message = this.conversations.getMessage(receipt.messageId)
        reconciled = Boolean(message
          && message.taskId === receipt.taskId
          && message.conversationId === destination.conversationId
          && message.requestId === receipt.requestId
          && message.requestHash === receipt.requestHash
          && message.provenance?.source === 'team-chat-composer'
          && JSON.stringify(message.recipientAgentIds) === JSON.stringify([destination.recipientAgentId]))
      }
    }
    return {
      schema: 'chimera.task-admission-receipt.v1',
      requestId: receipt.requestId,
      operation: receipt.operation,
      status: reconciled ? 'accepted' : receipt.status,
      ...(reconciled ? { reconciled: true } : {}),
      ...(receipt.taskId ? { taskId: receipt.taskId } : {}),
      ...(receipt.operation === 'continuation' && typeof destination.taskId === 'string'
        ? { parentTaskId: destination.taskId } : {}),
      ...(receipt.messageId ? { messageId: receipt.messageId } : {}),
      ...(receipt.reason ? { reason: receipt.reason } : {}),
      reservedAt: receipt.reservedAt,
      ...(receipt.completedAt ? { completedAt: receipt.completedAt } : {}),
    }
  }

  conversationHistory({ conversationId = 'main', limit = 100, before = null } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw Object.assign(new TypeError('CONVERSATION_LIST_LIMIT_INVALID'), { code: 'CONVERSATION_LIST_LIMIT_INVALID' })
    const messages = this.conversations.list(conversationId, { limit, before })
    return { messages, nextCursor: messages.length === limit ? messages[0].messageId : null }
  }

  async #recordAgentConversationEvent(rootTaskId, event, addressedConversationId = null) {
    const input = {
      messageId: event.messageId,
      conversationId: `task:${rootTaskId}`,
      senderAgentId: event.senderAgentId,
      recipientAgentIds: [event.recipientAgentId],
      kind: event.kind,
      content: redactSensitiveText(event.content),
      taskId: event.taskId,
      status: event.status,
      provenance: event.provenance ?? { verification: 'derived', source: 'runtime-agent-event' },
      ...(event.parentMessageId ? { replyTo: event.parentMessageId } : {}),
    }
    await this.conversations.append(input)
    if (addressedConversationId?.startsWith('agent:')) {
      await this.conversations.append({
        ...input,
        messageId: `message-${crypto.randomUUID()}`,
        conversationId: addressedConversationId,
      })
    }
  }

  async #runTask(taskId, objective, conversation = null) {
    try {
      this.#assertTaskActive(taskId)
      await this.tasks.start(taskId)
      this.#assertTaskActive(taskId)
      const queuedRecord = this.tasks.get(taskId)
      if (queuedRecord.queuedForExecution
        && typeof queuedRecord.context?.projectId === 'string'
        && !this.projectSessions.get(taskId)) {
        const project = this.projectRegistry.get(queuedRecord.context.projectId)
        if (!project) throw Object.assign(new Error('PROJECT_NOT_FOUND'), { code: 'PROJECT_NOT_FOUND' })
        const accessRequest = queuedRecord.context.accessRequest
        if (!accessRequest || accessRequest.networkHosts.some(host => !project.networkHosts.includes(host))) {
          throw Object.assign(new Error('PROJECT_TASK_ACCESS_INVALID'), { code: 'PROJECT_TASK_ACCESS_INVALID' })
        }
        await this.projectSessions.prepare({ taskId, project, accessRequest })
        this.#assertTaskActive(taskId)
      }
      const assertActive = () => this.#assertTaskActive(taskId)
      const getSteeringFor = agentId => [...(this.tasks.get(taskId)?.steering ?? []), ...this.#recipientGuidance(taskId, agentId)]
      const getSteering = () => getSteeringFor(this.agentId)
      const budgetUsage = { turns: 0, toolCalls: 0 }
      const onCheckpoint = async (checkpoint) => {
        const safe = redactSensitiveData(checkpoint)
        safe.budgetUsage = { ...budgetUsage }
        // Large specialist payloads stay in the signed result/model ledgers;
        // checkpoints keep a bounded, durable progress summary.
        if (Buffer.byteLength(JSON.stringify(safe)) > 60 * 1024) {
          delete safe.result
          delete safe.observation
          safe.truncated = true
        }
        await this.tasks.checkpoint(taskId, safe)
      }
      // Execution controls are trusted runtime state, not model-visible context:
      // never serialize callbacks/signals into the signed request or replay hash.
      const guardProvider = (provider, ownerAgentId) => ({ ...provider, route: async (prompt, context) => {
        assertActive()
        const providerId = provider?.descriptor?.providerId
        if (typeof providerId === 'string' && providerId !== 'chimera') this.connectionPolicy?.assertEnabled(providerId)
        const revision = JSON.stringify(getSteeringFor(ownerAgentId))
        const result = await provider.route(prompt, context, {
          signal: this.taskControllers.get(taskId).signal,
          ...(projectWorkspace?.path ? { nativeWorkingDirectory: projectWorkspace.path } : {}),
          sessionBindings: this.modelSessions,
          sessionScope: {
            rootTaskId: taskId,
            agentId: ownerAgentId,
            assignmentId: context.sourceMessageId ?? context.taskId ?? taskId,
            projectId: this.tasks.get(taskId).context?.projectId ?? 'no-project',
          },
          onProgress: async progress => {
            assertActive()
            if (!['codex', 'antigravity', 'claude-code'].includes(progress?.providerId) || !['started', 'responding', 'completed'].includes(progress.phase)) return
            this.audit.append({ kind: 'model.execution.progress', providerId: progress.providerId,
              taskId, agentId: ownerAgentId, phase: progress.phase, at: new Date(this.now()).toISOString() })
          },
        })
        if (provider.nativeExecution && revision !== JSON.stringify(getSteeringFor(ownerAgentId))) {
          throw Object.assign(new Error('NATIVE_EXECUTION_STEERED_REVIEW_REQUIRED'), { code: 'NATIVE_EXECUTION_STEERED_REVIEW_REQUIRED' })
        }
        return result
      } })
      const taskRecord = this.tasks.get(taskId)
      const historyContext = this.#taskHistoryContext(taskId, conversation)
      const sessionTaskId = taskRecord.context?.projectSessionTaskId ?? taskId
      const budget = normalizeTaskBudget(taskRecord.context?.budget)
      const consumeBudget = (kind) => {
        const field = kind === 'turn' ? 'turns' : 'toolCalls'
        const limit = kind === 'turn' ? budget.maxTurns : budget.maxToolCalls
        if (budgetUsage[field] >= limit) throw Object.assign(new Error(kind === 'turn' ? 'AGENT_LOOP_TURN_LIMIT' : 'AGENT_LOOP_TOOL_LIMIT'), { code: kind === 'turn' ? 'AGENT_LOOP_TURN_LIMIT' : 'AGENT_LOOP_TOOL_LIMIT' })
        budgetUsage[field] += 1
      }
      this.grant = this.#createBrowserGrant()
      this.browserAdapter.grant = this.grant
      this.operatorGrant = this.#createOperatorGrant()
      const projectSession = this.projectSessions?.get(sessionTaskId)
      const projectContext = projectSession ? {
        projectId: projectSession.projectId,
        projectName: projectSession.projectName,
        relativeRoot: projectSession.workspace.relativeRoot,
        branch: projectSession.branch,
        baseCommit: projectSession.baseCommit,
        identityReceiptPath: PROJECT_IDENTITY_PATH,
      } : null
      const projectWorkspace = projectSession ? {
        path: projectSession.workspace.path,
        readProjectIdentity: () => this.projectSessions.identityReceipt(sessionTaskId),
        protectedWriteRoots: projectSession.workspace.protectedWriteRoots ?? [resolve(projectSession.workspace.repositoryPath, '.git')],
        state: () => ({
          schema: 'chimera.project-task-workspace.v1',
          isolation: 'per-task-project-workspace',
          identityReceiptPath: PROJECT_IDENTITY_PATH,
          scratch: { mode: 'private-writable', relativeRoot: projectSession.workspace.relativeRoot },
        }),
      } : null
      const requestedPeer = conversation?.requestedSpecialistAgentId
      if (requestedPeer && !this.#manifestForAgent(requestedPeer)) {
        throw Object.assign(new Error('SPECIALIST_NOT_REGISTERED'), { code: 'SPECIALIST_NOT_REGISTERED' })
      }
      const specialistManifests = this.#specialistManifests()
        .filter(manifest => !requestedPeer || manifest.agentId === requestedPeer).slice(0, 8)
      const taskGrant = signGrant({
        grantId: `ceo-task-grant-${crypto.randomUUID()}`,
        humanId: this.humanId,
        agentId: this.agentId,
        agentKeyFingerprint: fingerprint(this.agent.publicKey),
        maxTier: 'confirm',
        taskId,
        scopes: [
          ...specialistManifests.map((manifest) => ({
            capability: 'agent.message.task_handoff',
            resource: `agent:${manifest.agentId}`,
          })),
          { capability: 'model.invoke', resourcePrefix: 'model:openai-compatible:' },
          { capability: 'model.invoke', resourcePrefix: 'model:model-fabric:' },
          { capability: 'external.message', resource: 'telegram:chimera-hq' },
        ],
        ...isoWindow(this.now()),
      }, this.human)
      this.taskControllers.get(taskId).grantId = taskGrant.payload.grantId
      const taskRequirements = taskRecord.context?.requirements
      const ceoJev = this.#jevForAgent({ grant: taskGrant, identity: this.agent, agentId: this.agentId })
      const ceoProvider = await this.#routerForAgent(this.agentId, {
        taskId,
        capturedSelection: taskRecord.model,
        taskModelPreference: taskRequirements?.modelPreference,
        taskRequirements,
        taskStage: 'decompose',
        decisionService: ceoJev,
      })
      const ceoRouter = createReliableModelRouter({
        provider: createGatewayModelRouter({
          provider: guardProvider(ceoProvider, this.agentId),
          gateway: this.gateway,
          grant: taskGrant,
          identity: this.agent,
          audit: this.audit,
          agentId: this.agentId,
          now: this.now,
        }),
        ledger: this.modelCalls,
        audit: this.audit,
        now: this.now,
        bindingFor: ({ context }) => ({
          taskId,
          nodeId: null,
          assignmentId: null,
          agentId: this.agentId,
          stage: ['decompose', 'synthesize'].includes(context?.stage) ? context.stage : 'task',
        }),
      })
      // Capture the same pure selection explanation used by the task-aware
      // router before the first model dispatch. The projection is task-bound,
      // bounded, and durable; it contains no prompt, grant, signal, or
      // provider response. A legacy deterministic router may not expose an
      // explanation, in which case the task simply retains its audit route.
      if (typeof ceoRouter.explain === 'function') {
        try {
          const explanation = ceoRouter.explain({
            requirements: taskRequirements,
            context: { taskId, stage: 'decompose' },
          })
          const routing = taskRoutingProjection(explanation, {
            taskId,
            agentId: this.agentId,
            now: this.now,
          })
          if (routing) await this.tasks.setRouting(taskId, routing)
        } catch (error) {
          this.audit.append({ kind: 'ceo.task.routing.explanation_unavailable', taskId,
            code: typeof error?.code === 'string' ? error.code : 'ROUTING_EXPLANATION_UNAVAILABLE',
            at: new Date(this.now()).toISOString() })
        }
      }
      const humanKeys = [[this.human.keyId, exportPublicKey(this.human.publicKey)]]
      const pinnedPreflightRoutes = new Map()
      const specialistCache = new Map()
      const resolveSpecialist = async (agentId) => {
        assertActive()
        if (specialistCache.has(agentId)) return specialistCache.get(agentId)
        const manifest = specialistManifests.find((entry) => entry.agentId === agentId)
        if (!manifest) throw Object.assign(new Error('SPECIALIST_NOT_REGISTERED'), { code: 'SPECIALIST_NOT_REGISTERED' })
        // A pinned route is an operator choice, not a model suggestion. Check
        // its availability before continuity/reference materialization or
        // worker creation so an unavailable pin cannot be masked by a later
        // workspace error. Per-node routing still performs its own invocation
        // selection with the exact normalized node requirements.
        const pinned = this.agentModelPolicy.get(agentId)
        if (pinned?.mode === 'pinned') {
          const preflightRoute = await this.#routerForAgent(agentId, {
            taskId,
            capturedSelection: taskRecord.model,
            taskModelPreference: taskRequirements?.modelPreference,
            taskRequirements,
            taskStage: 'specialist',
          })
          pinnedPreflightRoutes.set(agentId, preflightRoute)
          assertActive()
        }
        const { identity, grant } = this.#securityForSpecialist(manifest, taskId,
          requestedPeer ? [] : specialistManifests.filter(entry => !projectSession || this.taskAccessLeases.activeFor(entry.agentId, taskId)).map(entry => entry.agentId))
        const specialistJev = this.#jevForAgent({ grant, identity, agentId: manifest.agentId })
        if (this.teamTransport && !projectSession && manifest.source.type === 'hermes') {
          const remoteProfileId = manifest.source.profileId
          const remoteWorkspace = resolve(this.teamRemoteWorkspaceRoot, taskId)
          const executeRemote = async (_request, content, message) => {
            assertActive()
            const remote = await this.teamTransport.dispatch({
              profileId: remoteProfileId,
              taskId,
              requestId: message.messageId,
              objective: content.objective,
              acceptanceCriteria: content.acceptanceCriteria,
              workspaceRoot: remoteWorkspace,
              signal: this.taskControllers.get(taskId)?.signal,
            })
            assertActive()
            this.audit.append({ kind: 'team.remote.run', taskId, agentId: manifest.agentId, profileId: remoteProfileId,
              requestId: message.messageId, runId: remote.runId, outcome: remote.status, at: new Date(this.now()).toISOString() })
            if (remote.status !== 'succeeded') return { status: 'blocked', summary: remote.summary, result: remote.result }
            return { status: 'completed', summary: remote.summary, result: {
              remoteRunId: remote.runId, transport: 'ssh-forced-command', profileId: remoteProfileId, remote: remote.result,
            } }
          }
          const specialist = new SignedSpecialistStub({ agentId: manifest.agentId, identity, grant, gateway: this.gateway,
            audit: this.audit, humanKeys, execute: executeRemote, now: this.now })
          specialistCache.set(agentId, specialist)
          return specialist
        }
        const specialistRouteCache = new Map()
        const specialistRouterFor = async (message) => {
          const nodeId = message?.nodeId ?? null
          const assignmentId = message?.messageId ?? null
          const cacheKey = nodeId ?? assignmentId ?? '__unidentified__'
          let cached = specialistRouteCache.get(cacheKey)
          if (!cached) {
            // Node requirements are a narrowing of the already admitted root
            // requirements. Resolve them from the durable plan immediately
            // before the worker route is constructed so a model-proposed node
            // cannot silently widen or replace the trusted root constraints.
            const effectiveRequirements = this.#taskRequirementsForNode(taskId, nodeId)
            const preflightRoute = pinnedPreflightRoutes.get(manifest.agentId)
            const canReusePreflight = preflightRoute
              && JSON.stringify(effectiveRequirements ?? null) === JSON.stringify(taskRequirements ?? null)
            if (canReusePreflight) pinnedPreflightRoutes.delete(manifest.agentId)
            const specialistProvider = canReusePreflight ? preflightRoute : await this.#routerForAgent(manifest.agentId, {
              taskId,
              nodeId,
              assignmentId,
              capturedSelection: taskRecord.model,
              taskModelPreference: effectiveRequirements?.modelPreference,
              taskRequirements: effectiveRequirements,
              taskStage: 'specialist',
              decisionService: specialistJev,
            })
            let resourceClaims = null
            if (isInferenceOnlyRouter(specialistProvider) && typeof specialistProvider.resourceClaim === 'function') {
              try {
                resourceClaims = await specialistProvider.resourceClaim({
                  requirements: effectiveRequirements,
                  context: {
                    taskId,
                    nodeId,
                    sourceMessageId: assignmentId,
                    stage: 'specialist',
                  },
                  prompt: message?.objective ?? '',
                })
              } catch {
                resourceClaims = null
              }
            }
            cached = { specialistProvider, requirements: effectiveRequirements, resourceClaims }
            specialistRouteCache.set(cacheKey, cached)
          }
          const { specialistProvider, requirements: effectiveRequirements, resourceClaims } = cached
          const router = createReliableModelRouter({
            provider: createGatewayModelRouter({
              provider: guardProvider(specialistProvider, manifest.agentId),
              gateway: this.gateway,
              grant,
              identity,
              audit: this.audit,
              agentId: manifest.agentId,
              now: this.now,
            }),
            ledger: this.modelCalls,
            audit: this.audit,
            now: this.now,
            bindingFor: () => ({
              taskId,
              nodeId,
              assignmentId,
              agentId: manifest.agentId,
              stage: 'specialist',
            }),
          })
          return { router, requirements: effectiveRequirements, resourceClaims }
        }
        const agentContinuity = hasTaskHarness(manifest)
          ? (await this.#workspaceFor(manifest)).context()
          : null
        const specialistContext = (content, message, effectiveRequirements) => ({
          taskId,
          sourceMessageId: message.messageId,
          parentMessageId: message.parentMessageId,
          ...(dispatcher.assignment(message.messageId)?.canonicalAssignmentId
            ? { canonicalAssignmentId: dispatcher.assignment(message.messageId).canonicalAssignmentId }
            : {}),
          ...(message.nodeId ? { nodeId: message.nodeId } : {}),
          eligiblePeers: requestedPeer ? [] : dispatcher.peers(manifest.agentId),
          ...historyContext,
          steering: getSteeringFor(manifest.agentId),
          ...(effectiveRequirements ? { requirements: structuredClone(effectiveRequirements) } : {}),
          ...(projectContext ? { project: projectContext } : {}),
          ...(agentContinuity ? { agentContinuity } : {}),
          specialistAgent: {
            agentId: manifest.agentId,
            displayName: manifest.displayName,
            role: manifest.role,
            capabilities: manifest.capabilities,
            source: manifest.source,
          },
          objective: content.objective,
          acceptanceCriteria: content.acceptanceCriteria,
        })
        if (hasTaskHarness(manifest)) {
          let worker
          const execute = async (_request, content, message) => {
            const assertAssignmentActive = () => { assertActive(); dispatcher.assertJobActive(message.messageId) }
            assertAssignmentActive()
            const { router: specialistRouter, requirements: effectiveRequirements } = await specialistRouterFor(message)
            const lease = projectSession ? this.taskAccessLeases.activeFor(manifest.agentId, taskId) : null
            if (projectSession && !lease) {
              throw Object.assign(new Error('PROJECT_ACCESS_LEASE_INACTIVE'), { code: 'PROJECT_ACCESS_LEASE_INACTIVE' })
            }
            const executionProfileId = lease?.profileId ?? this.agentAccessPolicy.get(manifest.agentId).profileId
            return runBoundedAgentLoop({
              router: specialistRouter,
              worker,
              objective: content.objective,
              context: specialistContext(content, message, effectiveRequirements),
              ...budget,
              assertActive: assertAssignmentActive,
              getSteering: () => getSteeringFor(manifest.agentId),
              onCheckpoint,
              consumeBudget,
              availableTools: [...toolsForAccessProfile(executionProfileId)
                .filter((tool) => typeof this.workerToolExecutors[tool] === 'function')
                .filter((tool) => !(projectSession && tool === 'mcp__chimera_worker__code')), ...PEER_TOOLS,
                ...(specialistJev ? ['jev_decide'] : [])],
              executePeerTool: (name, args, proposal) => dispatcher.executePeerTool(message.messageId, name, args, proposal),
              executeDecisionTool: specialistJev ? async (args, proposal) => {
                assertAssignmentActive()
                proposal.assertProposalCurrent()
                try {
                  const result = await specialistJev.decide({ ...args, taskId, use: 'worker-tool' })
                  assertAssignmentActive()
                  proposal.assertProposalCurrent()
                  return { status: 'completed', result }
                } catch (error) {
                  if (['TASK_STEERED', 'TASK_INBOX_UPDATED'].includes(error?.code)) throw error
                  return { status: 'failed', reason: typeof error?.code === 'string' ? error.code : 'JEV_UNAVAILABLE' }
                }
              } : null,
              getInbox: () => dispatcher.inbox(message.messageId),
              getAccountBrowserLeases: () => this.accountCompanion.leasesFor({ taskId, agentId: manifest.agentId, workerSessionId: worker.sessionId }),
              ...(projectWorkspace ? {
                toolExecution: async () => {
                  const currentLease = this.taskAccessLeases.activeFor(manifest.agentId, taskId)
                  if (!currentLease) {
                    throw Object.assign(new Error('PROJECT_ACCESS_LEASE_INACTIVE'), { code: 'PROJECT_ACCESS_LEASE_INACTIVE' })
                  }
                  return {
                    taskId,
                    nodeId: message.nodeId ?? null,
                    assignmentId: message.messageId,
                    canonicalAssignmentId: dispatcher.assignment(message.messageId)?.canonicalAssignmentId ?? null,
                    workspace: projectWorkspace,
                    accessProfileId: currentLease.profileId,
                    networkHosts: currentLease.networkHosts,
                    taskScoped: true,
                    assertActive: () => {
                      assertAssignmentActive()
                      if (!this.taskAccessLeases.activeFor(manifest.agentId, taskId)) {
                        throw Object.assign(new Error('PROJECT_ACCESS_LEASE_INACTIVE'), { code: 'PROJECT_ACCESS_LEASE_INACTIVE' })
                      }
                      return true
                    },
                  }
                },
              } : {}),
              onEvent: (event) => this.#recordAgentConversationEvent(taskId, event, conversation?.conversationId),
            })
          }
          worker = await this.#openHarnessWorker(manifest, execute, { identity, grant })
          this.workerOwners.set(manifest.agentId, taskId)
          const state = worker.status().state
          if (state === 'registered' || state === 'stopped') await worker.start()
          else if (state === 'interrupted' || state === 'crashed') await worker.recover()
          specialistCache.set(agentId, worker)
          return worker
        }
        const execute = async (_request, content, message) => {
          const { router: specialistRouter, requirements: effectiveRequirements } = await specialistRouterFor(message)
          for (let attempt = 0; attempt < 8; attempt++) {
            assertActive(); dispatcher.assertJobActive(message.messageId); consumeBudget('turn')
            const context = specialistContext(content, message, effectiveRequirements)
            const result = await specialistRouter.route(content.objective, { stage: 'specialist', ...context })
            assertActive(); dispatcher.assertJobActive(message.messageId)
            if (JSON.stringify(context.steering) === JSON.stringify(getSteeringFor(manifest.agentId))) return result
          }
          throw Object.assign(new Error('TASK_STEERING_LIMIT'), { code: 'TASK_STEERING_LIMIT' })
        }
        const specialist = new SignedSpecialistStub({
          agentId: manifest.agentId,
          identity,
          grant,
          gateway: this.gateway,
          audit: this.audit,
          humanKeys,
          execute,
          now: this.now,
        })
        specialist.resolveResources = async ({ node = null, assignmentMessageId = null } = {}) => {
          const resolved = await specialistRouterFor({
            nodeId: node?.nodeId ?? null,
            messageId: assignmentMessageId,
            objective: node?.objective ?? '',
          })
          return resolved.resourceClaims ?? null
        }
        specialistCache.set(manifest.agentId, specialist)
        return specialist
      }
      const dispatcher = new TeamDispatcher({ taskId,
        root: { agentId: this.agentId, identity: this.agent, grant: taskGrant, signingProvider: createEd25519SigningProvider(this.agent) },
        mailbox: this.agentMailbox, gateway: this.gateway, humanKeys, resolveSpecialist, assertActive,
        eligibleAgentIds: specialistManifests.map(manifest => manifest.agentId),
        eligible: agentId => !projectSession || Boolean(this.taskAccessLeases.activeFor(agentId, taskId)),
        onEvent: event => this.#recordAgentConversationEvent(taskId, event, conversation?.conversationId),
        waitMs: this.teamWaitMs, maxExecuting: projectSession ? 1 : 4, now: this.now,
      })
      this.teamDispatchers.set(taskId, dispatcher)
      const workspace = new CeoWorkspace({
        identity: this.agent,
        grant: taskGrant,
        gateway: this.gateway,
        audit: this.audit,
        humanKeys,
        modelRouter: ceoRouter,
        decisionService: ceoJev,
        specialistRouteCandidates: specialistManifests
          .filter(manifest => !projectSession || this.taskAccessLeases.activeFor(manifest.agentId, taskId))
          .map(manifest => manifest.agentId),
        decisions: this.decisions,
        resolveSpecialist,
        dispatchTask: input => dispatcher.delegate(input),
        dispatchPlan: input => dispatcher.dispatchPlan(input),
        resolveResources: async (node) => {
          assertActive()
          const specialist = await resolveSpecialist(node?.specialistAgentId)
          if (typeof specialist?.resolveResources !== 'function') return null
          const resolved = await specialist.resolveResources({
            node,
            assignmentMessageId: null,
          })
          assertActive()
          return resolved
        },
        drainTasks: () => dispatcher.drain(),
        assertActive,
        getSteering,
        onCheckpoint,
        specialistCatalog: specialistManifests,
        agentContext: this.mainAgentWorkspace?.context() ?? null,
        taskContext: { ...historyContext, budget, ...(taskRequirements ? { requirements: structuredClone(taskRequirements) } : {}), ...(projectContext ? { project: projectContext } : {}) },
        onPlan: async (plan, assertProposalCurrent = () => {}) => {
          assertActive()
          assertProposalCurrent()
          // Admission requirements are operator/root constraints. A node may
          // narrow them, but it cannot replace a root pin, privacy, budget, or
          // tool ceiling. Reject conflicts before any plan or handoff becomes
          // visible, then persist the canonical plan as the dispatch barrier.
          for (const node of plan.tasks) combineTaskRequirements(taskRequirements, node.requirements)
          const planHash = sha256({ schema: TASK_PLAN_SCHEMA, tasks: plan.tasks })
          await this.tasks.recordPlan(taskId, { revision: 1, planHash, nodes: plan.tasks })
          this.#markTaskWorkspaceReviewStale(taskId, 'TASK_PLAN_CHANGED')
          assertActive()
          assertProposalCurrent()
          if (!projectSession) return
          assertActive()
          await this.projectSessions.recordPlan(sessionTaskId, plan)
          this.#markTaskWorkspaceReviewStale(sessionTaskId, 'PROJECT_SESSION_PLAN_CHANGED')
          assertActive()
          assertProposalCurrent()
          const selectedAgents = [...new Set(plan.tasks.map((task) => task.specialistAgentId))]
          for (const specialistAgentId of selectedAgents) {
            const manifest = this.#manifestForAgent(specialistAgentId)
            if (!hasTaskHarness(manifest)) {
              throw Object.assign(new Error('PROJECT_SPECIALIST_WORKER_REQUIRED'), { code: 'PROJECT_SPECIALIST_WORKER_REQUIRED' })
            }
            await this.taskAccessLeases.issue({
              taskId,
              agentId: specialistAgentId,
              ceilingProfileId: this.agentAccessPolicy.get(specialistAgentId).profileId,
              requestedProfileId: projectSession.accessRequest?.profileId ?? 'sandbox',
              approvedHosts: projectSession.networkHosts ?? [],
              requestedHosts: projectSession.accessRequest?.networkHosts ?? [],
              ttlSeconds: projectSession.accessRequest?.ttlSeconds ?? 900,
              issuedBy: this.agentId,
            })
            assertActive()
            assertProposalCurrent()
          }
        },
        onStep: async ({ taskId: stepTaskId, nodeId, status, messageId = null, resultId = null, reason = null }) => {
          assertActive()
          if (stepTaskId !== taskId) throw Object.assign(new Error('TASK_STEP_TASK_MISMATCH'), { code: 'TASK_STEP_TASK_MISMATCH' })
          await this.tasks.recordStep(taskId, {
            revision: 1,
            nodeId,
            status,
            messageId,
            resultId,
            reason,
          })
        },
        browserSurface: this.browserAdapter,
        onAgentMessage: (event) => this.#recordAgentConversationEvent(taskId, event, conversation?.conversationId),
        now: this.now,
      })
      const window = isoWindow(this.now(), 15 * 60_000)
      const envelope = createAgentMessageEnvelope({
        signingProvider: createEd25519SigningProvider(this.operator),
        senderAgentId: 'operator',
        recipientAgentId: this.agentId,
        messageId: `operator-${crypto.randomUUID()}`,
        type: 'direct_message',
        taskId,
        ...window,
        content: {
          text: objective,
          ...(conversation?.requestedSpecialistAgentId
            ? { requestedSpecialistAgentId: conversation.requestedSpecialistAgentId }
            : {}),
        },
      })
      const action = signAction({
        actionId: `message-${crypto.randomUUID()}`,
        agentId: 'operator',
        capability: 'agent.message.direct_message',
        resource: 'agent:ceo',
        operation: 'send',
        messageId: envelope.payload.messageId,
        messageHash: sha256(envelope),
        ...window,
      }, this.operator)
      const messageDecision = this.gateway.submit({ grant: this.operatorGrant, action })
      if (messageDecision.status !== 'allowed') throw new Error(messageDecision.reason ?? 'OPERATOR_MESSAGE_DENIED')
      this.audit.append({
        kind: 'agent.message.sent',
        messageId: envelope.payload.messageId,
        taskId,
        senderAgentId: 'operator',
        recipientAgentId: this.agentId,
        messageType: 'direct_message',
        grantId: this.operatorGrant.payload.grantId,
        gatewayActionId: messageDecision.actionId,
        at: new Date(this.now()).toISOString(),
      })
      const result = await workspace.receive({ envelope, senderGrant: this.operatorGrant })
      assertActive()
      if (result.status !== 'completed') {
        const error = new Error(result.reason ?? 'CEO_TASK_NOT_COMPLETED')
        error.code = 'CEO_TASK_NOT_COMPLETED'
        throw error
      }
      return await this.tasks.complete(taskId, {
        summary: result.synthesis.summary,
        result,
      })
    } catch (error) {
      if (this.taskControllers.get(taskId)?.stopped && this.tasks.get(taskId)?.status !== 'cancelled') {
        return this.tasks.fail(taskId, safeTaskFailure(Object.assign(new Error('PROCESS_STOPPED'), { code: 'PROCESS_STOPPED' })))
      }
      if (this.taskControllers.get(taskId)?.signal.aborted || this.tasks.get(taskId)?.status === 'cancelled') {
        return this.tasks.cancel(taskId)
      }
      return this.tasks.fail(taskId, safeTaskFailure(error))
    }
  }

  async agentCommand(input, { taskId = null, nodeId = null } = {}) {
    const result = await this.browserAdapter.agentCommand(input, {
      scope: { taskId, nodeId },
    })
    if (result.status === 'pending') {
      const detail = input?.url ?? this.browserAdapter.state().tabs.find((tab) => tab.active)?.url ?? 'about:blank'
      const pending = this.browserAdapter.pendingAction?.(result.actionId)
      const actionPayload = pending?.action?.payload
      const policyDecision = actionPayload ? evaluatePolicy(this.gateway.policy, actionPayload) : { ruleId: 'browser-adapter', tier: 'confirm' }
      const trustedTaskId = actionPayload?.taskId ?? null
      const trustedNodeId = actionPayload?.nodeId ?? null
      this.pendingExecutions.set(result.actionId, { kind: 'browser', taskId: trustedTaskId, nodeId: trustedNodeId })
      await this.decisions.post({
        actionId: result.actionId,
        challengeHash: result.challengeHash,
        actionDiff: structuredClone(input),
        taskId: trustedTaskId,
        nodeId: trustedNodeId,
        resource: actionPayload?.resource ?? `browser:${this.agentId}:${detail}`,
        expiresAt: actionPayload?.expiresAt ?? new Date(this.now() + 15 * 60_000).toISOString(),
        agent: {
          agentId: this.agentId,
          grantId: this.grant.payload.grantId,
          keyFingerprint: this.grant.payload.agentKeyFingerprint,
        },
        policyRationale: {
          ruleId: policyDecision.ruleId,
          tier: 'confirm',
          reason: result.reason,
        },
        title: `RJ wants to ${input.command.replaceAll('-', ' ')}`,
        detail,
      })
    }
    this.cachedBrowserState = this.browserAdapter.state()
    return result
  }

  async decide(actionId, outcome) {
    const pending = this.pendingExecutions.get(actionId)
    const paths = pending?.kind === 'browser'
      ? {
          decisionPath: (decision) => this.browserAdapter.decide(decision),
          expirePath: () => this.browserAdapter.cancelPending(actionId, 'DECISION_EXPIRED_OR_NOT_ACTIVE'),
        }
      : pending?.kind === 'worker-tool'
        ? {
            decisionPath: (decision) => this.workerApprovalBroker.resolve(actionId, decision),
            expirePath: () => this.workerApprovalBroker.expire(actionId, 'DECISION_EXPIRED_OR_NOT_ACTIVE'),
          }
        : {
            expirePath: () => this.gateway.cancelPending(actionId, 'DECISION_EXPIRED_OR_NOT_ACTIVE'),
          }
    const result = await this.decisionHandler.decide(
      actionId,
      outcome === 'approve' ? 'approve' : 'deny',
      paths,
    )
    if (this.decisions.get(actionId)?.status !== 'pending') this.pendingExecutions.delete(actionId)
    this.cachedBrowserState = this.browserAdapter.state()
    return result
  }

  async humanCommand(input) {
    const result = await this.browserAdapter.humanCommand(input)
    this.cachedBrowserState = this.browserAdapter.state()
    return result
  }

  modelState() {
    return this.models.state()
  }

  connectionState() {
    return this.connectionService?.list() ?? []
  }

  async connectionAction(input) {
    if (!this.connectionService) throw Object.assign(new Error('CONNECTION_SERVICE_UNAVAILABLE'), { code: 'CONNECTION_SERVICE_UNAVAILABLE' })
    const result = await this.connectionService.act(input)
    try { this.cachedConnectionState = structuredClone(this.connectionState()) } catch { /* retain the last safe observation */ }
    return result
  }

  githubState() {
    return this.githubProvider?.state() ?? {
      schema: 'chimera.github-connector.v1',
      connected: false,
      authentication: 'oauth-keychain',
      repositories: [],
      status: 'not-configured',
    }
  }

  async refreshGitHubState({ invalidateBinding = true } = {}) {
    if (!this.githubProvider) return this.githubState()
    const before = invalidateBinding ? this.#connectionBinding('github') : null
    const value = await this.githubProvider.refreshState()
    if (before) await this.#invalidateConnectionBinding('github', before)
    return value
  }

  async startGitHubLogin({ invalidateBinding = true } = {}) {
    if (!this.githubProvider) throw Object.assign(new Error('GITHUB_CONNECTOR_NOT_CONFIGURED'), { code: 'GITHUB_CONNECTOR_NOT_CONFIGURED' })
    const before = invalidateBinding ? this.#connectionBinding('github') : null
    try {
      return await this.githubProvider.beginLogin()
    } finally {
      if (before) await this.#invalidateConnectionBinding('github', before)
    }
  }

  codexAuthState() {
    if (this.codexAuth) return this.codexAuth.state()
    const configured = this.models.state().providers
      .find((provider) => provider.id === 'codex')?.configured === true
    return {
      provider: 'codex',
      available: configured,
      connected: configured,
      status: configured ? 'connected' : 'unavailable',
      ...(configured ? { authentication: 'chatgpt-subscription' } : { error: 'CODEX_APP_SERVER_UNAVAILABLE' }),
    }
  }

  async startCodexLogin({ invalidateBinding = true } = {}) {
    if (!this.codexAuth) {
      const error = new Error('CODEX_APP_SERVER_UNAVAILABLE')
      error.code = 'CODEX_APP_SERVER_UNAVAILABLE'
      throw error
    }
    const before = invalidateBinding ? this.#connectionBinding('codex') : null
    try {
      const { callbackUrl, ...login } = await this.codexAuth.startLogin()
      this.browserAdapter.allowTemporaryNavigation(callbackUrl)
      return login
    } finally {
      if (before) await this.#invalidateConnectionBinding('codex', before)
    }
  }

  async refreshCodexAuth({ invalidateBinding = true } = {}) {
    if (!this.codexAuth) {
      const error = new Error('CODEX_APP_SERVER_UNAVAILABLE')
      error.code = 'CODEX_APP_SERVER_UNAVAILABLE'
      throw error
    }
    const before = invalidateBinding ? this.#connectionBinding('codex') : null
    const authState = await this.codexAuth.read({ refreshToken: false })
    if (!this.modelRegistry) this.models = await this.#openModelRegistry(authState)
    if (before) await this.#invalidateConnectionBinding('codex', before)
    return authState
  }

  async refreshAntigravity({ invalidateBinding = true } = {}) {
    const before = invalidateBinding ? this.#connectionBinding('antigravity') : null
    const value = await this.antigravity.refresh()
    if (before) await this.#invalidateConnectionBinding('antigravity', before)
    return value
  }

  #connectionBinding(providerId) {
    const policy = this.connectionPolicy?.get(providerId) ?? { enabled: true, revision: 0 }
    if (providerId === 'codex') {
      const state = this.codexAuthState()
      return {
        ...policy,
        accountRef: null,
        signedIn: state.connected === true,
        sessionStatus: typeof state.status === 'string' ? state.status : null,
      }
    }
    if (providerId === 'claude-code') {
      const state = this.claudeCode.state()
      return { ...policy, accountRef: null, signedIn: state.configured, sessionStatus: state.status }
    }
    if (providerId === 'openrouter') {
      return { ...policy, accountRef: null, signedIn: this.openRouterSettings.status().configured, sessionStatus: null }
    }
    if (providerId === 'github') {
      const state = this.githubState()
      return {
        ...policy,
        accountRef: typeof state.login === 'string' ? state.login : null,
        signedIn: state.connected === true,
        sessionStatus: typeof state.status === 'string' ? state.status : null,
      }
    }
    if (providerId === 'antigravity') {
      const state = this.antigravity.state()
      return {
        ...policy,
        accountRef: null,
        signedIn: state.authenticated === true,
        sessionStatus: typeof state.status === 'string' ? state.status : null,
      }
    }
    return { ...policy, accountRef: null, signedIn: false, sessionStatus: null }
  }

  async #invalidateConnectionBinding(providerId, before) {
    if (!this.connectionPolicy || !before) return
    const after = this.#connectionBinding(providerId)
    if (after.accountRef === before.accountRef
      && after.signedIn === before.signedIn
      && after.sessionStatus === before.sessionStatus) return
    await this.connectionPolicy.setEnabled(providerId, before.enabled, {
      changedBy: 'auth-refresh',
      expectedRevision: before.revision,
    })
  }

  async #loadConnectionMachineRef() {
    const schema = 'chimera.machine-ref.v1'
    let content
    try {
      content = await readFile(this.connectionMachineRefFile, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      content = null
    }
    if (content !== null) {
      let document
      try { document = JSON.parse(content) } catch {
        throw Object.assign(new Error('CONNECTION_MACHINE_REF_CORRUPT'), { code: 'CONNECTION_MACHINE_REF_CORRUPT' })
      }
      if (!document || typeof document !== 'object' || Array.isArray(document)
        || document.schema !== schema
        || !Object.keys(document).every(key => key === 'schema' || key === 'machineRef')
        || typeof document.machineRef !== 'string'
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(document.machineRef)) {
        throw Object.assign(new Error('CONNECTION_MACHINE_REF_CORRUPT'), { code: 'CONNECTION_MACHINE_REF_CORRUPT' })
      }
      await chmod(this.connectionMachineRefFile, 0o600)
      return document.machineRef
    }

    const machineRef = `machine-${crypto.randomUUID()}`
    await mkdir(dirname(this.connectionMachineRefFile), { recursive: true, mode: 0o700 })
    const temporary = `${this.connectionMachineRefFile}.tmp-${process.pid}-${crypto.randomUUID()}`
    try {
      await writeFile(temporary, JSON.stringify({ schema, machineRef }) + '\n', { mode: 0o600 })
      await chmod(temporary, 0o600)
      await rename(temporary, this.connectionMachineRefFile)
      await chmod(this.connectionMachineRefFile, 0o600)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {})
      throw error
    }
    return machineRef
  }

  #connectionAdapters() {
    const modelConnectionState = providerId => {
      const provider = this.models.state().providers?.find(entry => entry.id === providerId)
      const models = Array.isArray(provider?.models) ? provider.models.map(model => ({ id: model.id })) : []
      return {
        signedIn: ['aws-bedrock-mantle', 'openrouter'].includes(provider?.id) ? provider?.configured === true : false,
        catalogAvailable: models.length > 0,
        models,
        ...(models.length > 0 ? { executor: 'inference-only' } : {}),
        ...(provider?.error ? { error: { code: provider.error } } : {}),
      }
    }
    const localModelRefresh = providerId => async () => {
      // Refreshing this adapter only reprojects the already-loaded catalog. It
      // deliberately does not run a provider access or inference probe.
      modelConnectionState(providerId)
    }
    const pureModelTest = async ({ providerId, model, requestId }) => this.#connectionModelVerification({ providerId, model, requestId })
    const codexOperations = {
      connect: this.codexAuth ? async () => { await this.startCodexLogin({ invalidateBinding: false }) } : undefined,
      refresh: this.codexAuth ? async () => { await this.refreshCodexAuth({ invalidateBinding: false }) } : undefined,
      'test-safe': this.codexAuth ? async () => { await this.refreshCodexAuth({ invalidateBinding: false }) } : undefined,
      reconnect: this.codexAuth ? async () => { await this.startCodexLogin({ invalidateBinding: false }) } : undefined,
      disconnect: true,
    }
    const githubOperations = {
      connect: this.githubProvider ? async () => { await this.startGitHubLogin({ invalidateBinding: false }) } : undefined,
      refresh: this.githubProvider ? async () => { await this.refreshGitHubState({ invalidateBinding: false }) } : undefined,
      'test-safe': this.githubProvider ? async () => { await this.refreshGitHubState({ invalidateBinding: false }) } : undefined,
      reconnect: this.githubProvider ? async () => { await this.startGitHubLogin({ invalidateBinding: false }) } : undefined,
      disconnect: true,
    }
    const adapters = {
      'claude-code': {
        state: () => { const state = this.claudeCode.state(); return {
          signedIn: state.configured, catalogAvailable: state.available,
          sessionStatus: state.status, models: state.models.map(model => ({ id: model.id })),
          executor: 'inference-only' } },
        operations: { refresh: () => this.refreshClaudeCode({ invalidateBinding: false }),
          'test-safe': () => this.refreshClaudeCode({ invalidateBinding: false }),
          'test-model': pureModelTest },
      },
      codex: {
        state: () => {
          const auth = this.codexAuthState()
          const catalog = this.models.state().providers?.find(entry => entry.id === 'codex')
          return {
            signedIn: auth.connected === true,
            catalogAvailable: catalog?.configured === true,
            sessionStatus: auth.status,
            ...(auth.error ? { error: { code: auth.error } } : {}),
          }
        },
        operations: codexOperations,
      },
      antigravity: {
        state: () => {
          const value = this.antigravity.state()
          return {
            signedIn: value.authenticated === true,
            catalogAvailable: Array.isArray(value.models) && value.models.length > 0,
            sessionStatus: value.status,
            ...(value.error ? { error: { code: value.error } } : {}),
          }
        },
        operations: {
          connect: (...args) => this.antigravity.openDesktop(...args),
          refresh: (...args) => this.antigravity.refresh(...args),
          'test-safe': async (...args) => {
            const result = await this.antigravity.refresh(...args)
            if (result.handshakeVerified !== true) {
              const code = typeof result.error === 'string' && /^ANTIGRAVITY_[A-Z_]+$/.test(result.error)
                ? result.error
                : 'ANTIGRAVITY_HANDSHAKE_UNVERIFIED'
              throw Object.assign(new Error(code), { code })
            }
            const policy = this.connectionPolicy.get('antigravity')
            return {
              verification: {
                revision: policy.revision,
                machineRef: this.connectionMachineRef,
                operation: 'native-handshake',
                model: result.models?.[0]?.id,
                status: result.handshakeVerified === true ? 'passed' : 'failed',
                at: new Date(this.now()).toISOString(),
                modelCallSent: false,
              },
              costClass: 'free',
              modelCallSent: false,
            }
          },
          reconnect: (...args) => this.antigravity.openDesktop(...args),
          disconnect: true,
        },
      },
      github: {
        state: () => {
          const value = this.githubState()
          return {
            accountRef: value.login ?? null,
            signedIn: value.connected === true,
            catalogAvailable: Array.isArray(value.repositories) && value.repositories.length > 0,
            sessionStatus: value.status,
          }
        },
        operations: githubOperations,
      },
      'aws-bedrock': {
        state: () => modelConnectionState('aws-bedrock'),
        operations: {
          connect: localModelRefresh('aws-bedrock'),
          refresh: localModelRefresh('aws-bedrock'),
          reconnect: localModelRefresh('aws-bedrock'),
          'test-model': pureModelTest,
          disconnect: true,
        },
      },
      'aws-bedrock-mantle': {
        state: () => modelConnectionState('aws-bedrock-mantle'),
        operations: {
          connect: localModelRefresh('aws-bedrock-mantle'),
          refresh: localModelRefresh('aws-bedrock-mantle'),
          reconnect: localModelRefresh('aws-bedrock-mantle'),
          'test-model': pureModelTest,
          disconnect: true,
        },
      },
      'rj-aws': {
        state: () => {
          const value = this.rjAwsConnector.state()
          const ready = value.transport?.status === 'ready'
          return {
            signedIn: value.configured === true && ready,
            catalogAvailable: value.configured === true,
            ...(value.configured === false ? { error: { code: 'RJ_AWS_NOT_CONFIGURED' } } : {}),
          }
        },
        operations: {
          refresh: async () => {},
          connect: async () => {},
          reconnect: async () => {},
          'test-safe': async () => {
            const result = await this.verifyRjAwsConnection()
            const policy = this.connectionPolicy.get('rj-aws')
            return {
              verification: {
                revision: policy.revision,
                machineRef: this.connectionMachineRef,
                operation: 'signed-read',
                status: result.status === 'verified' ? 'passed' : 'failed',
                at: new Date(this.now()).toISOString(),
                modelCallSent: false,
              },
              costClass: 'free',
              modelCallSent: false,
            }
          },
          disconnect: true,
        },
      },
    }
    for (const provider of this.modelConfig.openAiCompatibleProviders ?? []) {
      if (Object.hasOwn(adapters, provider.id)) continue
      adapters[provider.id] = {
        state: () => modelConnectionState(provider.id),
        operations: {
          ...(provider.id === 'openrouter' ? {} : { connect: localModelRefresh(provider.id) }),
          refresh: localModelRefresh(provider.id),
          ...(provider.id === 'openrouter' ? {} : { reconnect: localModelRefresh(provider.id) }),
          'test-model': pureModelTest,
          disconnect: provider.id === 'openrouter' ? () => this.disconnectOpenRouter() : true,
        },
      }
    }
    return adapters
  }

  async #openModelRegistry(authState) {
    const routeGuard = descriptor => {
      const providerId = descriptor?.providerId
      if (typeof providerId === 'string' && providerId !== 'chimera') this.connectionPolicy?.assertEnabled(providerId)
    }
    if (this.modelRegistryFactory) {
      return this.modelRegistryFactory({
        codexStatus: modelCodexStatus(authState),
        config: this.modelConfig,
        claudeCode: this.claudeCode,
        openAiCompatibleKeyResolvers: { openrouter: () => this.openRouterSettings.apiKey() },
        audit: this.audit,
        workingDirectory: WORKSPACE_ROOT,
        now: this.now,
        routeGuard,
        eligibility: (route, input) => this.#routeEligibility(route, input),
        evidence: this.routingEvidence,
      })
    }
    const { LocalModelFabricRegistry } = await import('../ceo/local-model-fabric.mjs')
    return LocalModelFabricRegistry.open({
      config: this.modelConfig,
      antigravity: this.antigravity,
      claudeCode: this.claudeCode,
      openAiCompatibleKeyResolvers: { openrouter: () => this.openRouterSettings.apiKey() },
      audit: this.audit,
      workingDirectory: WORKSPACE_ROOT,
      ...(authState?.available === true ? { codexStatus: modelCodexStatus(authState) } : {}),
      now: this.now,
      routeGuard,
      eligibility: (route, input) => this.#routeEligibility(route, input),
      evidence: this.routingEvidence,
    })
  }

  async selectModel(input) {
    return this.models.select(input)
  }

  async checkModelAccess(input) {
    const providerId = input?.providerId
    if (typeof providerId === 'string' && providerId !== 'chimera' && providerId !== 'chimera-auto') {
      this.connectionPolicy?.assertEnabled(providerId)
    }
    return this.models.check(input)
  }

  async generateMedia(input) {
    const model = input?.model
    if (typeof model !== 'string' || model.length === 0 || model.length > 512) {
      const error = new Error('MEDIA_REQUEST_INVALID')
      error.code = 'MEDIA_REQUEST_INVALID'
      throw error
    }
    this.connectionPolicy?.assertEnabled('aws-bedrock')
    const currentTime = this.now()
    this.mediaDispatchHistory = this.mediaDispatchHistory
      .filter((dispatchedAt) => dispatchedAt > currentTime - MEDIA_RATE_WINDOW_MS)
    if (this.mediaDispatchHistory.length >= MEDIA_RATE_LIMIT) {
      const error = new Error('MEDIA_RATE_LIMITED')
      error.code = 'MEDIA_RATE_LIMITED'
      throw error
    }
    if (this.activeMediaInvocations >= MEDIA_CONCURRENCY_LIMIT) {
      const error = new Error('MEDIA_CONCURRENCY_LIMITED')
      error.code = 'MEDIA_CONCURRENCY_LIMITED'
      throw error
    }
    const resource = `model:model-fabric:media:${model}`
    const requestHash = sha256(input)
    const action = signAction({
      actionId: `media-${crypto.randomUUID()}`,
      agentId: this.agentId,
      capability: 'model.invoke',
      resource,
      operation: 'generate-media',
      requestHash,
      ...isoWindow(currentTime, 15 * 60_000),
    }, this.agent)
    const policyDecision = evaluatePolicy(this.gateway.policy, action.payload)
    const decision = this.gateway.submit({ grant: this.grant, action })
    if (decision.status !== 'allowed') {
      const error = new Error(decision.reason ?? 'MEDIA_CALL_DENIED')
      error.code = 'MEDIA_CALL_DENIED'
      throw error
    }
    this.audit.append({
      kind: 'media.call.authorized',
      actionId: decision.actionId,
      agentId: this.agentId,
      grantId: this.grant.payload.grantId,
      resource,
      requestHash,
      policyRuleId: policyDecision.ruleId,
      at: new Date(currentTime).toISOString(),
    })
    this.mediaDispatchHistory.push(currentTime)
    this.activeMediaInvocations += 1
    try {
      return await this.models.generateMedia(input)
    } finally {
      this.activeMediaInvocations -= 1
    }
  }

  async mediaStatus(input) {
    this.connectionPolicy?.assertEnabled('aws-bedrock')
    return this.models.mediaStatus(input)
  }

  async startWorker(input) {
    return this.workerRuntimeManager.start(input)
  }

  async stopWorker({ workerSessionId } = {}) {
    return this.workerRuntimeManager.stop(workerSessionId)
  }

  async takeWorkerControl({ workerSessionId } = {}) {
    return this.workerRuntimeManager.takeControl(workerSessionId, { humanId: this.humanId })
  }

  async returnWorkerControl({ workerSessionId } = {}) {
    return this.workerRuntimeManager.returnControl(workerSessionId, { humanId: this.humanId })
  }

  async workerLiveView({ workerSessionId } = {}) {
    return { url: await this.workerRuntimeManager.liveView(workerSessionId, { humanId: this.humanId }), expiresIn: 45 }
  }

  async workerAction({ workerSessionId, ...input } = {}) {
    return this.workerRuntimeManager.action(workerSessionId, input)
  }

  takeControl() {
    return this.browserAdapter.takeControl()
  }

  releaseControl() {
    return this.browserAdapter.returnControl()
  }

  async humanStreamInput(message) {
    return this.browserAdapter.humanStreamInput(message)
  }

  async suspend() {
    const result = await this.browserAdapter.suspend()
    if (result.status === 'allowed') this.suspended = true
    this.cachedBrowserState = this.browserAdapter.state()
    return result
  }

  async resume() {
    const result = await this.browserAdapter.resume()
    if (result.status === 'allowed') this.suspended = false
    this.cachedBrowserState = this.browserAdapter.state()
    return result
  }

  async subscribeScreencast(onFrame) {
    if (this.suspended) {
      onFrame({ type: 'suspended' })
      return async () => {}
    }
    return this.browserAdapter.subscribeScreencast(onFrame)
  }

  async state() {
    await this.agentMailbox.sweep()
    const browser = this.suspended
      ? { ...this.cachedBrowserState, running: false }
      : await this.browserAdapter.refreshState()
    this.cachedBrowserState = browser
    const models = this.models.state()
    const tasks = this.tasks.list({ limit: 50 }).map(taskProjection)
    const mainReadiness = await this.agentReadiness({ agentId: this.agentId }).catch(() => null)
    const specialistReadiness = new Map(await Promise.all(this.#specialistManifests().map(async manifest => [manifest.agentId, await this.agentReadiness({ agentId: manifest.agentId }).catch(() => null)])))
    let connections = this.cachedConnectionState
    try {
      connections = this.connectionState()
      this.cachedConnectionState = structuredClone(connections)
    } catch {
      connections = this.cachedConnectionState
    }
    const activeTask = this.tasks.active().find(task => task.status === 'running')
    const cancelling = [...this.taskControllers.values()].some((controller) => controller.signal.aborted)
    const taskStatus = cancelling ? 'Cancelling'
      : this.decisions.pending().length ? 'Waiting'
        : activeTask ? (['planning', undefined].includes(activeTask.checkpoint?.stage) ? 'Planning' : 'Working') : 'Idle'
    const runtimeStatus = this.suspended ? 'Suspended' : taskStatus
    const projection = createActivityProjection({
      audit: this.audit,
      decisions: this.decisions,
      browserSurface: this.browserAdapter,
      agent: {
        id: this.agentId,
        name: 'RJ',
        model: models.selected?.modelName ?? 'No live model configured',
        status: runtimeStatus,
      },
      session: {
        id: 'browser-ceo-1',
        status: runtimeStatus,
        suspended: this.suspended,
        controller: this.browserAdapter.controller(),
        browser,
        hourlyCost: null,
      },
      now: this.now,
      limit: 12,
      models,
      tasks,
    })
    return {
      ...projection,
      draftScope: { schema: 'chimera.draft-scope.v1', workspaceId: this.connectionMachineRef, operatorId: this.humanId },
      projectQueue: { schema: 'chimera.project-queue.v1', executionConcurrency: 1,
        blocked: this.projectQueueBlocked,
        jobs: this.tasks.active().filter(task => task.queuedForExecution && task.status === 'queued')
          .map((task, index) => ({ taskId: task.taskId, projectId: task.context.projectId ?? null, queueScope: task.context.projectId ? 'project' : 'root', position: index + 1, recoveryRequired: task.recoveryRequired === true })) },
      teamMessaging: { schema: 'chimera.team-messaging.v1', transport: 'local-durable-mailbox',
        tasks: tasks.map(task => ({ ...(this.teamDispatchers.get(task.taskId)?.state() ?? teamMessagingProjection(this.agentMailbox, task.taskId)), destinationRevision: task.destinationRevision, eligibleRecipients: this.#taskMessageRecipients(task.taskId) })) },
      conversations: {
        schema: 'chimera.conversation-projection.v2',
        messages: this.conversations.listAll({ limit: 200 }),
        channels: [
          {
            conversationId: 'main',
            kind: 'hq',
            label: 'Team HQ',
            detail: 'You and RJ',
            recipientAgentId: this.agentId,
            readOnly: false,
          },
          ...this.#specialistManifests().map((manifest) => ({
            conversationId: `agent:${manifest.agentId}`,
            kind: 'agent',
            label: manifest.displayName,
            detail: manifest.role,
            recipientAgentId: manifest.agentId,
            readOnly: false,
          })),
          ...tasks.map((task) => ({
            conversationId: `task:${task.taskId}`,
            kind: 'task-room',
            label: task.objective.length > 44 ? `${task.objective.slice(0, 41)}...` : task.objective,
            detail: `${task.status} · verified + derived audit events`,
            taskId: task.taskId,
            readOnly: true,
          })),
        ],
      },
      auth: { codex: this.codexAuthState() },
      connections: { schema: 'chimera.connections.v1', connections },
      connectors: { github: this.githubState(), rjAws: this.rjAwsConnector.state() },
      projects: {
        schema: 'chimera.project-workspace.v1',
        projects: this.projectRegistry.list(),
        sessions: this.projectSessions.list().map((session) => ({
          ...session,
          workspace: { relativeRoot: session.workspace.relativeRoot },
          source: { type: session.source.type, defaultBranch: session.source.defaultBranch },
        })),
        leases: this.taskAccessLeases.list(),
      },
      agents: {
        schema: 'chimera.agent-roster.v1',
        main: {
          agentId: this.agentId,
          displayName: 'RJ',
          personaProfileId: 'rj',
          role: 'CEO and main orchestrator',
          status: runtimeStatus,
          access: this.agentAccessPolicy.get(this.agentId),
          modelPreference: this.agentModelPolicy.get(this.agentId),
          ...(mainReadiness ? { readiness: mainReadiness } : {}),
          ...(mainReadiness?.checks?.find(row => row.name === 'executor')?.details ? { executor: mainReadiness.checks.find(row => row.name === 'executor').details } : {}),
          ...(this.mainAgentWorkspace ? {
            continuity: this.mainAgentWorkspace.state().continuity,
            source: structuredClone(this.mainAgentManifest.source),
          } : {
            continuity: {
              status: 'not-imported',
              personaProfileId: 'rj',
            },
          }),
        },
        accessProfiles: Object.values(AGENT_ACCESS_PROFILES).map((profile) => structuredClone(profile)),
        specialists: this.#specialistManifests().map((manifest) => {
          const worker = this.workers.get(manifest.agentId)
          const workerStatus = worker?.status()
          const workspace = workerStatus?.workspace
            ? (({ path: _path, ...safe }) => safe)(workerStatus.workspace)
            : null
          return {
            ...manifest,
            access: this.agentAccessPolicy.get(manifest.agentId),
            modelPreference: this.agentModelPolicy.get(manifest.agentId),
            ...(specialistReadiness.get(manifest.agentId) ? { readiness: specialistReadiness.get(manifest.agentId) } : {}),
            ...(specialistReadiness.get(manifest.agentId)?.checks?.find(row => row.name === 'executor')?.details ? { executor: specialistReadiness.get(manifest.agentId).checks.find(row => row.name === 'executor').details } : {}),
            ...(this.agentContinuity.has(manifest.agentId)
              ? { continuity: structuredClone(this.agentContinuity.get(manifest.agentId)) }
              : {}),
            status: this.workerOwners.has(manifest.agentId) ? taskStatus : 'Ready',
            harnessState: workerStatus?.state
              ? workerStatus.state[0].toUpperCase() + workerStatus.state.slice(1)
              : hasTaskHarness(manifest) ? 'Registered' : 'Built in',
            ownedByTaskId: this.workerOwners.get(manifest.agentId) ?? null,
            ...(workspace ? { workspace } : {}),
            ...(workerStatus ? { health: { healthy: workerStatus.state === 'running', restartCount: workerStatus.restartCount } } : {}),
          }
        }),
        source: { ...this.hermesSource },
      },
      workers: this.workerRuntimeManager.state(),
    }
  }

  async close() {
    this.closing = true
    const accountClose = this.accountCompanion.close()
    clearInterval(this.workerReaper)
    for (const controller of this.taskControllers.values()) {
      controller.stopped = true
      controller.abort()
    }
    for (const dispatcher of this.teamDispatchers.values()) void dispatcher.close('PROCESS_STOPPED').catch(() => {})
    const errors = []
    const cleanup = async operation => { try { await operation() } catch (error) { errors.push(error) } }
    await cleanup(() => accountClose)
    await cleanup(() => this.workerApprovalBroker?.cancelAll('PROCESS_STOPPED'))
    for (const decision of this.decisions?.pending?.() ?? []) {
      const pending = this.pendingExecutions.get(decision.actionId)
      await cleanup(() => pending?.kind === 'browser' ? this.browserAdapter.cancelPending(decision.actionId, 'PROCESS_STOPPED') : this.gateway?.cancelPending(decision.actionId, 'PROCESS_STOPPED'))
      await cleanup(() => this.decisions.cancel(decision.actionId, 'PROCESS_STOPPED'))
      this.pendingExecutions.delete(decision.actionId)
    }
    await Promise.allSettled(this.activeTasks.values())
    await cleanup(() => this.browserAdapter.close())
    await cleanup(() => this.tasks.close())
    await cleanup(() => this.modelSessions?.close())
    await cleanup(() => this.conversations.close())
    await cleanup(() => this.projectRegistry?.close())
    await cleanup(() => this.projectSessions?.close())
    await cleanup(() => this.taskAccessLeases?.close())
    await cleanup(() => this.codexAuth?.close())
    await cleanup(() => this.agentReadinessStore?.close?.())
    await cleanup(() => this.connectionReceiptStore?.close?.())
    await cleanup(() => this.routingEvidence?.close?.())
    await cleanup(() => this.agentContinuityRecords?.close())
    await cleanup(() => this.audit?.close?.())
    if (errors.length) throw new AggregateError(errors, 'Runtime cleanup failed')
  }
}
