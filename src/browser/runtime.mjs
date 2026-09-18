import crypto from 'node:crypto'
import { createAntigravityConnection } from '../ceo/antigravity-provider.mjs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openRuntimeAudit } from '../audit/runtime-audit.mjs'
import { DurableFileAuditLog } from '../audit/durable-file-log.mjs'
import { createAgentMessageEnvelope } from '../agent-message.mjs'
import { sha256 } from '../canonical.mjs'
import { createActivityProjection } from '../ceo/activity-projection.mjs'
import { DurableAgentRegistry, agentManifestFromHermesCandidate } from '../agents/registry.mjs'
import { AGENT_ACCESS_PROFILES, DurableAgentAccessPolicy, toolsForAccessProfile } from '../agents/access-policy.mjs'
import { runBoundedAgentLoop, normalizeTaskBudget } from '../agents/bounded-work-loop.mjs'
import { AccountCompanionRuntime } from '../account-browser/runtime-integration.mjs'
import { DurableAgentModelPolicy } from '../agents/model-policy.mjs'
import { createHarnessExecutors } from '../agents/harness-executors.mjs'
import { createHermesAgentDiscoveryFromEnv, resolveHermesDiscoveryTarget } from '../agents/hermes-discovery.mjs'
import { createHermesReferenceProviderFromEnv } from '../agents/hermes-reference-provider.mjs'
import { AgentHarnessWorker, removeAgentWorkerState } from '../agents/harness-worker.mjs'
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
import { createGatewayModelRouter } from '../ceo/gateway-model-router.mjs'
import { DurableModelCallLedger, createReliableModelRouter } from '../ceo/reliable-model-router.mjs'
import { SignedSpecialistStub } from '../ceo/specialist-stub.mjs'
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

const POLICY_URL = new URL('../../config/policy.json', import.meta.url)
const MODEL_ROUTING_URL = new URL('../../config/model-routing.json', import.meta.url)
const WORKSPACE_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const MEDIA_RATE_WINDOW_MS = 60 * 60_000
const MEDIA_RATE_LIMIT = 12
const MEDIA_CONCURRENCY_LIMIT = 2
const AGENT_DISCOVERY_LIFETIME_MS = 15 * 60_000
const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

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
    retryable: record.retryable,
    submittedAt: record.submittedAt,
    ...(record.startedAt ? { startedAt: record.startedAt } : {}),
    ...(record.completedAt ? { completedAt: record.completedAt } : {}),
    ...(record.failedAt ? { failedAt: record.failedAt } : {}),
    ...(record.interruptedAt ? { interruptedAt: record.interruptedAt } : {}),
    ...(record.summary ? { summary: record.summary } : {}),
    ...(record.failure ? { failure: record.failure } : {}),
    ...(record.cancelledAt ? { cancelledAt: record.cancelledAt } : {}),
    budget: record.context?.budget ?? null,
    budgetUsage: record.checkpoint?.budgetUsage ?? null,
    priorTaskId: record.context?.priorTaskId ?? null,
    projectId: record.context?.projectId ?? null,
    projectSessionTaskId: record.context?.projectSessionTaskId ?? null,
    checkpoint: record.checkpoint ?? null,
    lastCompletedWork: record.lastCompletedWork ?? null,
    steering: record.steering ?? [],
    queuedForExecution: record.queuedForExecution === true,
    recoveryRequired: record.recoveryRequired === true,
  }
}

function safeTaskFailure(error) {
  const code = typeof error?.code === 'string' && error.code.length <= 256
    ? error.code
    : 'TASK_FAILED'
  const message = error instanceof Error && error.message.length <= 16_384
    ? error.message
    : 'The task failed safely.'
  return { code, message }
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

export class ChimeraBrowserRuntime {
  constructor({
    profileDir,
    decisionFile,
    taskFile,
    conversationFile,
    modelCallFile,
    modelSessionFile,
    modelRegistry,
    modelRegistryFactory,
    agentFile,
    agentRegistry,
    mainAgentFile,
    mainAgentRegistry,
    agentDiscovery,
    workerRoot,
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
    this.auditFile = auditFile ?? resolve(profileDir, '../../audit/events.jsonl')
    this.browserInputAuditFile = browserInputAuditFile ?? resolve(profileDir, '../../audit/browser-input.jsonl')
    this.browserInputAudit = browserInputAudit ?? null
    this.identityFile = identityFile ?? resolve(profileDir, '../../identity/actors.json')
    this.replayFile = replayFile ?? resolve(profileDir, '../../gateway/replay.jsonl')
    this.identityStore = identityStore ?? null
    this.replayLedger = replayLedger ?? null
    this.agentFile = agentFile ?? resolve(profileDir, '../../agents/registry.json')
    this.mainAgentFile = mainAgentFile ?? resolve(profileDir, '../../agents/main.json')
    this.agentAccessFile = agentAccessFile ?? resolve(profileDir, '../../agents/access.json')
    this.agentModelFile = agentModelFile ?? resolve(profileDir, '../../agents/models.json')
    this.workerRoot = workerRoot ?? resolve(profileDir, '../../agents/workspaces')
    this.workerStateDir = workerStateDir ?? resolve(profileDir, '../../agents/workers')
    this.mailboxFile = mailboxFile ?? resolve(profileDir, '../../agents/mailbox.jsonl')
    this.agentReferenceProvider = agentReferenceProvider
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
    this.workers = new Map()
    this.mainAgentManifest = null
    this.mainAgentWorkspace = null
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
    this.accountCompanion = new AccountCompanionRuntime(this)
  }

  async start() {
    const policy = JSON.parse(await readFile(POLICY_URL, 'utf8'))
    this.audit ??= await openRuntimeAudit({ filePath: this.auditFile })
    this.browserInputAudit ??= await DurableFileAuditLog.open({ filePath: this.browserInputAuditFile })
    this.identityStore ??= await DurableIdentityStore.open({ filePath: this.identityFile })
    this.replayLedger ??= await GatewayReplayLedger.open({ filePath: this.replayFile })
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
      this.workerToolExecutors = {
        ...this.workerToolExecutors,
        ...createGitHubToolExecutors({ provider: this.githubProvider }),
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
        this.mainAgentWorkspace = await this.#workspaceFor(persistedMainAgent)
      } catch (error) {
        if (!isHermesTargetNotConfigured(error)) throw error
        this.mainAgentWorkspace = null
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
    this.workerApprovalBroker = new WorkerToolApprovalBroker({
      queue: this.decisions,
      audit: this.audit,
      onPending: (actionId) => {
        const taskId = this.activeTasks.keys().next().value
        this.pendingExecutions.set(actionId, { kind: 'worker-tool', taskId })
        if (taskId && this.taskControllers.get(taskId)?.signal.aborted) {
          void this.workerApprovalBroker.expire(actionId, 'TASK_CANCELLED')
          void this.decisions.cancel(actionId, 'TASK_CANCELLED')
        }
      },
      now: this.now,
    })
    this.tasks = await DurableTaskLedger.open({
      filePath: this.taskFile,
      audit: this.audit,
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
    })
    for (const [tool, operation] of Object.entries(RJ_AWS_TOOLS)) {
      if (typeof this.rjAwsConnector.executors()[tool] !== 'function') continue
      this.workerToolExecutors[tool] = async (args, context) => {
        if (!context || !args || typeof args !== 'object' || Array.isArray(args)
          || Object.getPrototypeOf(args) !== Object.prototype || Object.keys(args).length !== 0) {
          throw Object.assign(new Error('RJ_AWS_ARGUMENTS_INVALID'), { code: 'RJ_AWS_ARGUMENTS_INVALID' })
        }
        return this.rjAwsConnector.execute(operation, {
          agentId: context.agentId,
          taskId: context.taskId,
          assertActive: () => this.#rjAwsTaskAuthority(context),
        })
      }
    }
    for (const session of this.projectSessions.list().filter((entry) => entry.status === 'working')) {
      const task = this.tasks.get(session.taskId)
      if (!task || !['submitted', 'running'].includes(task.status)) {
        await this.projectSessions.markOutcome(session.taskId, task?.status === 'completed' ? 'completed' : 'failed')
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

  #assertTaskAdmission() {
    this.#assertOpen()
    if (this.tasks.active().length > 0 || this.activeTasks.size > 0) {
      const error = new Error('TASK_ALREADY_RUNNING')
      error.code = 'TASK_ALREADY_RUNNING'
      throw error
    }
  }

  #assertOpen() {
    if (this.closing) throw Object.assign(new Error('PROCESS_STOPPED'), { code: 'PROCESS_STOPPED' })
  }

  #drainProjectQueue() {
    if (this.closing || this.projectQueueBlocked || this.activeTasks.size > 0) return
    const active = this.tasks.active()
    // Non-queue submissions may be between their durable submit and start.
    if (active.some(task => task.status === 'running' || !task.queuedForExecution)) return
    const next = active.find(task => task.status === 'queued' && !task.recoveryRequired)
    if (next) this.#startTask(next)
  }

  async resumeQueuedTask({ taskId } = {}) {
    this.#assertOpen()
    if (this.projectQueueBlocked) throw Object.assign(new Error('TASK_QUEUE_CLEANUP_REQUIRED'), { code: 'TASK_QUEUE_CLEANUP_REQUIRED' })
    const record = await this.tasks.resumeQueued(taskId)
    this.#drainProjectQueue()
    return record
  }

  async submitTask({ objective, budget } = {}) {
    const normalizedObjective = this.#validateObjective(objective)
    const normalizedBudget = normalizeTaskBudget(budget)
    this.#assertTaskAdmission()
    const selected = this.models.state().selected
    const taskId = `task-${crypto.randomUUID()}`
    const record = await this.tasks.submit({
      taskId,
      objective: normalizedObjective,
      model: selected ? { providerId: selected.providerId, model: selected.model } : null,
      context: { budget: normalizedBudget },
    })
    this.#startTask(record)
    return record
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
    const promise = (async () => {
      const normalizedObjective = this.#validateObjective(objective)
      this.#assertOpen()
      const existing = this.tasks.get(taskId)
      if (existing) {
        if (existing.objective !== normalizedObjective) throw Object.assign(new Error('CLIENT_INTAKE_CONFLICT'), { code: 'CLIENT_INTAKE_CONFLICT' })
        return existing
      }
      const normalizedBudget = normalizeTaskBudget(budget)
      this.#assertTaskAdmission()
      const selected = this.models.state().selected
      const record = await this.tasks.submit({ taskId, objective: normalizedObjective,
        model: selected ? { providerId: selected.providerId, model: selected.model } : null,
        context: { budget: normalizedBudget, source: 'client-intake' } })
      this.#startTask(record)
      return record
    })().finally(() => this.intakeSubmissions.delete(taskId))
    this.intakeSubmissions.set(taskId, { objective, promise })
    return promise
  }

  async registerProject({ mode, name, path, networkHosts = [] } = {}) {
    if (mode === 'local') return this.projectRegistry.registerLocal({ name, path, networkHosts })
    if (mode === 'managed') return this.projectRegistry.createManaged({ name, networkHosts })
    throw Object.assign(new TypeError('PROJECT_INTAKE_MODE_INVALID'), { code: 'PROJECT_INTAKE_MODE_INVALID' })
  }

  async submitProjectTask({ projectId, objective, access = {}, budget } = {}) {
    const normalizedObjective = this.#validateObjective(objective)
    const normalizedBudget = normalizeTaskBudget(budget)
    this.#assertOpen()
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
    const selected = this.models.state().selected
    const taskId = `task-${crypto.randomUUID()}`
    const record = await this.tasks.submit({
      taskId,
      objective: normalizedObjective,
      model: selected ? { providerId: selected.providerId, model: selected.model } : null,
      context: { projectId, projectSessionTaskId: taskId, budget: normalizedBudget, accessRequest },
      queue: true,
    })
    this.#drainProjectQueue()
    return record
  }

  async projectReview(taskId) {
    return this.projectSessions.review(this.tasks.get(taskId)?.context?.projectSessionTaskId ?? taskId)
  }

  async commitProjectSession({ taskId, message, expectedReviewDigest } = {}) {
    return this.projectSessions.commit({ taskId: this.tasks.get(taskId)?.context?.projectSessionTaskId ?? taskId, message, expectedReviewDigest, committedBy: this.humanId })
  }

  async sendMessage({ content, recipientAgentId = this.agentId, budget } = {}) {
    const objective = this.#validateObjective(content)
    const normalizedBudget = normalizeTaskBudget(budget)
    this.#assertTaskAdmission()
    const requestedSpecialistAgentId = recipientAgentId === this.agentId ? null : recipientAgentId
    if (requestedSpecialistAgentId && !this.#manifestForAgent(requestedSpecialistAgentId)) {
      throw Object.assign(new Error('CHAT_RECIPIENT_NOT_REGISTERED'), { code: 'CHAT_RECIPIENT_NOT_REGISTERED' })
    }
    const conversationId = requestedSpecialistAgentId ? `agent:${requestedSpecialistAgentId}` : 'main'
    const taskId = `task-${crypto.randomUUID()}`
    const messageId = `message-${crypto.randomUUID()}`
    const selected = this.models.state().selected
    const record = await this.tasks.submit({
      taskId,
      objective,
      model: selected ? { providerId: selected.providerId, model: selected.model } : null,
      context: { conversationId, requestedSpecialistAgentId, budget: normalizedBudget },
    })
    let message
    try {
      message = await this.conversations.append({
        messageId,
        conversationId,
        senderAgentId: this.humanId,
        recipientAgentIds: [recipientAgentId],
        kind: 'message',
        content: objective,
        taskId,
        provenance: { verification: 'human', source: 'team-chat-composer' },
      })
    } catch (error) {
      await this.tasks.fail(taskId, { code: 'CONVERSATION_WRITE_FAILED', message: 'RJ could not durably save the message.' })
      throw error
    }
    this.#startTask(record, { conversationId, replyTo: messageId, requestedSpecialistAgentId })
    return { schema: 'chimera.conversation-send-result.v2', message, task: record }
  }

  #startTask(record, conversation = null) {
    this.taskControllers.set(record.taskId, new AbortController())
    const operation = this.#runTask(record.taskId, record.objective, conversation)
      .then(async (completed) => {
        await this.accountCompanion.revokeTask(record.taskId)
        const sessionTaskId = record.context?.projectSessionTaskId ?? record.taskId
        const projectSession = this.projectSessions?.get(sessionTaskId)
        if (projectSession) {
          await this.projectSessions.markOutcome(
            sessionTaskId,
            completed.status === 'completed' ? 'completed' : 'failed',
          )
          await this.taskAccessLeases.revokeTask(record.taskId, {
            reason: completed.status === 'completed' ? 'task-completed' : 'task-failed',
            revokedBy: this.agentId,
          })
        }
        if (conversation) {
          try {
            await this.conversations.append({
              messageId: `message-${crypto.randomUUID()}`,
              conversationId: conversation.conversationId,
              senderAgentId: this.agentId,
              recipientAgentIds: [this.humanId],
              kind: 'message',
              content: redactSensitiveText(completed.summary ?? completed.failure?.message ?? 'RJ stopped safely before completing the task.'),
              taskId: completed.taskId,
              replyTo: conversation.replyTo,
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

  async verifyRjAwsConnection() {
    if (!this.rjAwsConnector?.state().configured) {
      throw Object.assign(new Error('RJ_AWS_NOT_CONFIGURED'), { code: 'RJ_AWS_NOT_CONFIGURED' })
    }
    if (this.tasks.active().length > 0 || this.activeTasks.size > 0) {
      throw Object.assign(new Error('TASK_ALREADY_RUNNING'), { code: 'TASK_ALREADY_RUNNING' })
    }
    const taskId = `rj-aws-verify-${crypto.randomUUID()}`
    const expiresAt = new Date(this.now() + 5 * 60_000).toISOString()
    const operations = ['rj.aws.identity', 'rj.aws.instance_status']
    await this.tasks.submit({
      taskId,
      objective: 'Verify the fixed RJ AWS read-only worker connection.',
      model: null,
      context: { source: 'rj-aws-verification', deterministic: true, operations, expiresAt },
    })
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
    if (!this.rjAwsConnector?.state().configured) throw Object.assign(new Error('RJ_AWS_NOT_CONFIGURED'), { code: 'RJ_AWS_NOT_CONFIGURED' })
    if (this.tasks.active().length || this.activeTasks.size) throw Object.assign(new Error('TASK_ALREADY_RUNNING'), { code: 'TASK_ALREADY_RUNNING' })
    const request = this.rjAwsConnector.state().requests?.find(entry => entry.requestId === requestId)
    if (!request || !this.tasks.get(request.taskId)) throw Object.assign(new Error('RJ_REQUEST_NOT_FOUND'), { code: 'RJ_REQUEST_NOT_FOUND' })
    // The old task remains terminal/interrupted. Only a fresh authenticated lookup is sent.
    const operation = (async () => {
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
      return { schema: 'chimera.rj-aws-verification.v1', taskId, status: 'verified', receipts: structuredClone(receipts) }
    } catch (error) {
      if (['queued', 'running'].includes(this.tasks.get(taskId)?.status)) await this.tasks.fail(taskId, safeTaskFailure(error))
      throw error
    }
  }

  async steerTask({ taskId, content } = {}) {
    const normalized = this.#validateObjective(content)
    if (normalized.length > 4096) throw Object.assign(new TypeError('TASK_STEERING_INVALID'), { code: 'TASK_STEERING_INVALID' })
    const record = await this.tasks.steer(taskId, normalized)
    // A pending tool proposal predates the new instruction. Deny it and let the
    // next model turn choose work using the updated steering.
    await this.#cancelTaskApprovals(taskId, 'TASK_STEERED')
    return record
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
    const previous = this.taskGuidanceWrites.get(input.taskId) ?? Promise.resolve()
    const operation = previous.then(() => this.#saveTaskMessage(input))
    const settled = operation.catch(() => {})
    this.taskGuidanceWrites.set(input.taskId, settled)
    void settled.then(() => { if (this.taskGuidanceWrites.get(input.taskId) === settled) this.taskGuidanceWrites.delete(input.taskId) })
    return operation
  }

  async #saveTaskMessage({ taskId, content, recipientAgentIds, replyTo } = {}) {
    const fail = code => { throw Object.assign(new TypeError(code), { code }) }
    if (typeof taskId !== 'string' || taskId.length > 256 || typeof content !== 'string' || !content.trim() || content.length > 4096
      || !Array.isArray(recipientAgentIds) || recipientAgentIds.length < 1 || recipientAgentIds.length > 8
      || recipientAgentIds.some(id => typeof id !== 'string') || new Set(recipientAgentIds).size !== recipientAgentIds.length) fail('TASK_MESSAGE_INVALID')
    if (!this.tasks.get(taskId)) fail('TASK_NOT_FOUND')
    const eligible = this.#taskMessageRecipients(taskId)
    if (!eligible.length) fail('TASK_NOT_ACTIVE')
    if (recipientAgentIds.some(id => !eligible.includes(id))) fail('TASK_MESSAGE_RECIPIENT_INVALID')
    const messages = this.conversations.list(`task:${taskId}`)
    if (replyTo !== undefined && (typeof replyTo !== 'string' || !messages.some(message => message.messageId === replyTo && message.taskId === taskId))) fail('TASK_MESSAGE_PARENT_INVALID')
    if (messages.filter(message => message.provenance.source === 'operator-task-guidance').length >= 32) fail('TASK_MESSAGE_LIMIT')
    const message = await this.conversations.append({ messageId: `human-${crypto.randomUUID()}`, conversationId: `task:${taskId}`,
      taskId, senderAgentId: 'operator', recipientAgentIds, content: redactSensitiveText(content.trim()),
      ...(replyTo !== undefined ? { replyTo } : {}), provenance: { verification: 'human', source: 'operator-task-guidance' } })
    await this.#cancelTaskApprovals(taskId, 'TASK_STEERED', recipientAgentIds)
    const deliveries = this.teamDispatchers.get(taskId)?.state().deliveries ?? []
    const currentEligible = this.#taskMessageRecipients(taskId)
    return { message, recipients: recipientAgentIds.map(agentId => ({ agentId,
      status: currentEligible.includes(agentId) && (agentId === this.agentId || deliveries.some(row => row.recipientAgentId === agentId && ['pending', 'processing', 'waiting'].includes(row.status)))
        ? 'next-boundary' : 'saved-no-active-assignment' })),
      acknowledgement: 'Guidance saved. Applies only if the addressed agent reaches another safe boundary; finished assignments are not restarted.' }
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

  async continueTask({ taskId, objective, budget } = {}) {
    const nextObjective = this.#validateObjective(objective)
    this.#assertTaskAdmission()
    const prior = this.tasks.get(taskId)
    if (!prior) throw Object.assign(new Error('TASK_NOT_FOUND'), { code: 'TASK_NOT_FOUND' })
    if (['queued', 'running'].includes(prior.status)) throw Object.assign(new Error('TASK_NOT_TERMINAL'), { code: 'TASK_NOT_TERMINAL' })
    const selected = this.models.state().selected
    const nextTaskId = `task-${crypto.randomUUID()}`
    const priorSessionTaskId = prior.context?.projectSessionTaskId ?? (this.projectSessions.get(taskId) ? taskId : null)
    const priorSession = priorSessionTaskId ? this.projectSessions.get(priorSessionTaskId) : null
    const sessionTaskId = priorSession && priorSession.status !== 'committed'
      ? priorSessionTaskId : prior.context?.projectId ? nextTaskId : null
    const context = { ...prior.context, priorTaskId: taskId, budget: normalizeTaskBudget(budget ?? prior.context?.budget),
      ...(sessionTaskId ? { projectSessionTaskId: sessionTaskId } : {}),
      ...(priorSession ? { projectId: priorSession.projectId } : {}),
    }
    const record = await this.tasks.submit({ taskId: nextTaskId, objective: nextObjective,
      model: selected ? { providerId: selected.providerId, model: selected.model } : null, context })
    try {
      if (sessionTaskId === nextTaskId) {
        const project = this.projectRegistry.get(context.projectId)
        if (!project) throw Object.assign(new Error('PROJECT_NOT_FOUND'), { code: 'PROJECT_NOT_FOUND' })
        await this.projectSessions.prepare({ taskId: nextTaskId, project, accessRequest: priorSession?.accessRequest ?? prior.context.accessRequest })
      } else if (sessionTaskId) await this.projectSessions.resume(sessionTaskId)
    } catch (error) { await this.tasks.fail(nextTaskId, safeTaskFailure(error)); throw error }
    const conversation = context.conversationId ? { conversationId: context.conversationId, requestedSpecialistAgentId: context.requestedSpecialistAgentId } : null
    this.#startTask(record, conversation)
    return record
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
          ...structuredClone(candidate),
          imported: this.agentRegistry.get(candidate.profileId) !== null,
          reservedForMain: candidate.profileId === 'rj',
        })),
      }
    }
    if (this.agentDiscoveryInFlight) return this.agentDiscoveryInFlight

    this.agentDiscoveryInFlight = (async () => {
      const discovered = await this.agentDiscovery.discover()
      if (discovered?.schema !== 'chimera.agent-discovery.v1' || !Array.isArray(discovered.candidates)) {
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
          ...structuredClone(candidate),
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
    const candidates = new Map(preview.candidates.map((candidate) => [candidate.candidateId, candidate]))
    const manifests = []
    const selectedCandidateIds = new Set()
    for (const selection of agents) {
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
        ...(selection.role ? { role: selection.role } : {}),
        ...(selection.capabilities ? { capabilities: selection.capabilities } : {}),
      }, { now: this.now }))
    }
    for (const manifest of manifests) await this.#workspaceFor(manifest)
    const imported = await this.agentRegistry.registerMany(manifests)
    for (const manifest of imported) {
      await this.#openHarnessWorker(manifest, async () => {
        const error = new Error('WORKER_MODEL_EXECUTOR_NOT_BOUND')
        error.code = 'WORKER_MODEL_EXECUTOR_NOT_BOUND'
        throw error
      })
    }
    return { schema: 'chimera.agent-import-result.v1', imported }
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
    const workspace = await this.#workspaceFor(manifest)
    const existing = this.mainAgentRegistry.get('rj')
    if (!existing) await this.mainAgentRegistry.register(manifest)
    this.mainAgentManifest = manifest
    this.mainAgentWorkspace = workspace
    const continuity = workspace.state().continuity
    this.audit.append({
      kind: 'agent.continuity.main-imported',
      agentId: this.agentId,
      personaProfileId: manifest.agentId,
      sourceRef: manifest.source.ref,
      digest: continuity.digest,
      report: continuity.report,
      at: new Date(this.now()).toISOString(),
    })
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
    if (existing) return existing
    const workspace = await AgentWorkerWorkspace.open({
      rootDir: this.workerRoot,
      manifest,
      referenceProvider: this.agentReferenceProvider,
      audit: this.audit,
      now: this.now,
    })
    this.workerWorkspaces.set(manifest.agentId, workspace)
    return workspace
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
      const state = this.models.state()
      const provider = state.providers?.find((entry) => entry.id === preference?.providerId && entry.configured)
      const model = provider?.models?.find((entry) => entry.id === preference?.model)
      const ready = ['authenticated', 'verified-route', 'verified-manual'].includes(model?.availability)
        || (provider?.id === 'antigravity' && model?.availability === 'local-ready')
      if (!model?.capabilities?.includes('conversation') || !ready) {
        throw Object.assign(new Error('AGENT_MODEL_NOT_ELIGIBLE'), { code: 'AGENT_MODEL_NOT_ELIGIBLE' })
      }
    }
    return this.agentModelPolicy.set(agentId, preference, { changedBy: this.humanId })
  }

  async #routerForAgent(agentId) {
    const preference = this.agentModelPolicy.get(agentId)
    if (preference.mode === 'auto') return this.models.router()
    if (typeof this.models.routerFor !== 'function') {
      if (preference.mode === 'preferred') return this.models.router()
      throw Object.assign(new Error('AGENT_MODEL_ROUTER_UNSUPPORTED'), { code: 'AGENT_MODEL_ROUTER_UNSUPPORTED' })
    }
    try {
      return await this.models.routerFor(preference)
    } catch (error) {
      if (preference.mode !== 'preferred') throw error
      this.audit.append({
        kind: 'agent.model.fallback',
        agentId,
        providerId: preference.providerId,
        model: preference.model,
        reason: typeof error?.code === 'string' ? error.code : 'MODEL_UNAVAILABLE',
        at: new Date(this.now()).toISOString(),
      })
      return this.models.router()
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

  taskHistory({ limit = 50, before = null } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw Object.assign(new TypeError('TASK_LIST_LIMIT_INVALID'), { code: 'TASK_LIST_LIMIT_INVALID' })
    const tasks = this.tasks.list({ limit, before }).map(taskProjection)
    return { tasks, nextCursor: tasks.length === limit ? tasks.at(-1).taskId : null }
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
      if (queuedRecord.queuedForExecution && !this.projectSessions.get(taskId)) {
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
            if (!['codex', 'antigravity'].includes(progress?.providerId) || !['started', 'responding', 'completed'].includes(progress.phase)) return
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
      const ceoProvider = await this.#routerForAgent(this.agentId)
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
      })
      const humanKeys = [[this.human.keyId, exportPublicKey(this.human.publicKey)]]
      const resolveSpecialist = async (agentId) => {
        assertActive()
        const manifest = specialistManifests.find((entry) => entry.agentId === agentId)
        if (!manifest) throw Object.assign(new Error('SPECIALIST_NOT_REGISTERED'), { code: 'SPECIALIST_NOT_REGISTERED' })
        const { identity, grant } = this.#securityForSpecialist(manifest, taskId,
          requestedPeer ? [] : specialistManifests.filter(entry => !projectSession || this.taskAccessLeases.activeFor(entry.agentId, taskId)).map(entry => entry.agentId))
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
          return new SignedSpecialistStub({ agentId: manifest.agentId, identity, grant, gateway: this.gateway,
            audit: this.audit, humanKeys, execute: executeRemote, now: this.now })
        }
        const specialistProvider = await this.#routerForAgent(manifest.agentId)
        const specialistRouter = createReliableModelRouter({
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
        })
        const agentContinuity = manifest.source.type === 'hermes'
          ? (await this.#workspaceFor(manifest)).context()
          : null
        const specialistContext = (content, message) => ({
          taskId,
          sourceMessageId: message.messageId,
          parentMessageId: message.parentMessageId,
          eligiblePeers: requestedPeer ? [] : dispatcher.peers(manifest.agentId),
          ...historyContext,
          steering: getSteeringFor(manifest.agentId),
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
        if (manifest.source.type === 'hermes') {
          let worker
          const execute = async (_request, content, message) => {
            const assertAssignmentActive = () => { assertActive(); dispatcher.assertJobActive(message.messageId) }
            assertAssignmentActive()
            const lease = projectSession ? this.taskAccessLeases.activeFor(manifest.agentId, taskId) : null
            if (projectSession && !lease) {
              throw Object.assign(new Error('PROJECT_ACCESS_LEASE_INACTIVE'), { code: 'PROJECT_ACCESS_LEASE_INACTIVE' })
            }
            const executionProfileId = lease?.profileId ?? this.agentAccessPolicy.get(manifest.agentId).profileId
            return runBoundedAgentLoop({
              router: specialistRouter,
              worker,
              objective: content.objective,
              context: specialistContext(content, message),
              ...budget,
              assertActive: assertAssignmentActive,
              getSteering: () => getSteeringFor(manifest.agentId),
              onCheckpoint,
              consumeBudget,
              availableTools: [...toolsForAccessProfile(executionProfileId)
                .filter((tool) => typeof this.workerToolExecutors[tool] === 'function')
                .filter((tool) => !(projectSession && tool === 'mcp__chimera_worker__code')), ...PEER_TOOLS],
              executePeerTool: (name, args, proposal) => dispatcher.executePeerTool(message.messageId, name, args, proposal),
              getInbox: () => dispatcher.inbox(message.messageId),
              getAccountBrowserLeases: () => this.accountCompanion.leasesFor({ taskId, agentId: manifest.agentId, workerSessionId: worker.sessionId }),
              ...(projectWorkspace ? {
                toolExecution: async () => {
                  const currentLease = this.taskAccessLeases.activeFor(manifest.agentId, taskId)
                  if (!currentLease) {
                    throw Object.assign(new Error('PROJECT_ACCESS_LEASE_INACTIVE'), { code: 'PROJECT_ACCESS_LEASE_INACTIVE' })
                  }
                  return {
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
          return worker
        }
        const execute = async (_request, content, message) => {
          for (let attempt = 0; attempt < 8; attempt++) {
            assertActive(); dispatcher.assertJobActive(message.messageId); consumeBudget('turn')
            const context = specialistContext(content, message)
            const result = await specialistRouter.route(content.objective, { stage: 'specialist', ...context })
            assertActive(); dispatcher.assertJobActive(message.messageId)
            if (JSON.stringify(context.steering) === JSON.stringify(getSteeringFor(manifest.agentId))) return result
          }
          throw Object.assign(new Error('TASK_STEERING_LIMIT'), { code: 'TASK_STEERING_LIMIT' })
        }
        return new SignedSpecialistStub({
          agentId: manifest.agentId,
          identity,
          grant,
          gateway: this.gateway,
          audit: this.audit,
          humanKeys,
          execute,
          now: this.now,
        })
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
        decisions: this.decisions,
        resolveSpecialist,
        dispatchTask: input => dispatcher.delegate(input),
        drainTasks: () => dispatcher.drain(),
        assertActive,
        getSteering,
        onCheckpoint,
        specialistCatalog: specialistManifests,
        agentContext: this.mainAgentWorkspace?.context() ?? null,
        taskContext: { ...historyContext, budget, ...(projectContext ? { project: projectContext } : {}) },
        onPlan: async (plan) => {
          if (!projectSession) return
          assertActive()
          await this.projectSessions.recordPlan(sessionTaskId, plan)
          const selectedAgents = [...new Set(plan.tasks.map((task) => task.specialistAgentId))]
          for (const specialistAgentId of selectedAgents) {
            const manifest = this.#manifestForAgent(specialistAgentId)
            if (manifest?.source?.type !== 'hermes') {
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
          }
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

  async agentCommand(input) {
    const result = await this.browserAdapter.agentCommand(input)
    if (result.status === 'pending') {
      const detail = input?.url ?? this.browserAdapter.state().tabs.find((tab) => tab.active)?.url ?? 'about:blank'
      const pending = this.browserAdapter.pendingAction?.(result.actionId)
      const actionPayload = pending?.action?.payload
      const policyDecision = actionPayload ? evaluatePolicy(this.gateway.policy, actionPayload) : { ruleId: 'browser-adapter', tier: 'confirm' }
      this.pendingExecutions.set(result.actionId, { kind: 'browser' })
      await this.decisions.post({
        actionId: result.actionId,
        challengeHash: result.challengeHash,
        actionDiff: structuredClone(input),
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

  githubState() {
    return this.githubProvider?.state() ?? {
      schema: 'chimera.github-connector.v1',
      connected: false,
      authentication: 'oauth-keychain',
      repositories: [],
      status: 'not-configured',
    }
  }

  async refreshGitHubState() {
    if (!this.githubProvider) return this.githubState()
    return this.githubProvider.refreshState()
  }

  async startGitHubLogin() {
    if (!this.githubProvider) throw Object.assign(new Error('GITHUB_CONNECTOR_NOT_CONFIGURED'), { code: 'GITHUB_CONNECTOR_NOT_CONFIGURED' })
    return this.githubProvider.beginLogin()
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

  async startCodexLogin() {
    if (!this.codexAuth) {
      const error = new Error('CODEX_APP_SERVER_UNAVAILABLE')
      error.code = 'CODEX_APP_SERVER_UNAVAILABLE'
      throw error
    }
    const { callbackUrl, ...login } = await this.codexAuth.startLogin()
    this.browserAdapter.allowTemporaryNavigation(callbackUrl)
    return login
  }

  async refreshCodexAuth() {
    if (!this.codexAuth) {
      const error = new Error('CODEX_APP_SERVER_UNAVAILABLE')
      error.code = 'CODEX_APP_SERVER_UNAVAILABLE'
      throw error
    }
    const authState = await this.codexAuth.read({ refreshToken: false })
    if (!this.modelRegistry) this.models = await this.#openModelRegistry(authState)
    return authState
  }

  async #openModelRegistry(authState) {
    if (this.modelRegistryFactory) {
      return this.modelRegistryFactory({
        codexStatus: modelCodexStatus(authState),
        config: this.modelConfig,
        audit: this.audit,
        workingDirectory: WORKSPACE_ROOT,
        now: this.now,
      })
    }
    const { LocalModelFabricRegistry } = await import('../ceo/local-model-fabric.mjs')
    return LocalModelFabricRegistry.open({
      config: this.modelConfig,
      antigravity: this.antigravity,
      audit: this.audit,
      workingDirectory: WORKSPACE_ROOT,
      ...(authState?.available === true ? { codexStatus: modelCodexStatus(authState) } : {}),
      now: this.now,
    })
  }

  async selectModel(input) {
    return this.models.select(input)
  }

  async checkModelAccess(input) {
    return this.models.check(input)
  }

  async generateMedia(input) {
    const model = input?.model
    if (typeof model !== 'string' || model.length === 0 || model.length > 512) {
      const error = new Error('MEDIA_REQUEST_INVALID')
      error.code = 'MEDIA_REQUEST_INVALID'
      throw error
    }
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
      projectQueue: { schema: 'chimera.project-queue.v1', executionConcurrency: 1,
        blocked: this.projectQueueBlocked,
        jobs: this.tasks.active().filter(task => task.queuedForExecution && task.status === 'queued')
          .map((task, index) => ({ taskId: task.taskId, projectId: task.context.projectId, position: index + 1, recoveryRequired: task.recoveryRequired === true })) },
      teamMessaging: { schema: 'chimera.team-messaging.v1', transport: 'local-durable-mailbox',
        tasks: tasks.map(task => ({ ...(this.teamDispatchers.get(task.taskId)?.state() ?? teamMessagingProjection(this.agentMailbox, task.taskId)), eligibleRecipients: this.#taskMessageRecipients(task.taskId) })) },
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
            status: this.workerOwners.has(manifest.agentId) ? taskStatus : 'Ready',
            harnessState: workerStatus?.state
              ? workerStatus.state[0].toUpperCase() + workerStatus.state.slice(1)
              : manifest.source.type === 'hermes' ? 'Registered' : 'Built in',
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
    await cleanup(() => this.audit?.close?.())
    if (errors.length) throw new AggregateError(errors, 'Runtime cleanup failed')
  }
}
