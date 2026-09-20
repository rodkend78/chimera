export const TASK_WORKSPACE_SCHEMA = 'chimera.task-workspace.v1'

const MAX_TASK_ID = 256
const MAX_ROWS = 128
const MAX_MESSAGES = 200
const MAX_ARTIFACTS = 128
const MAX_BYTES = 512 * 1024

function mismatch() {
  return Object.assign(new Error('TASK_WORKSPACE_MISMATCH'), { code: 'TASK_WORKSPACE_MISMATCH' })
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function boundedTaskId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TASK_ID
}

function cloneBounded(value, maximum = MAX_BYTES) {
  let encoded
  try { encoded = JSON.stringify(value) } catch { return null }
  if (!encoded || Buffer.byteLength(encoded, 'utf8') > maximum) return null
  try { return JSON.parse(encoded) } catch { return null }
}

function assertSingletonIdentity(value, taskId) {
  if (record(value) && value.taskId !== undefined && value.taskId !== null && value.taskId !== taskId) throw mismatch()
  return value
}

function selectedRows(rows, taskId, { maximum = MAX_ROWS, requireTaskId = true } = {}) {
  if (!Array.isArray(rows)) return []
  return rows
    .filter(row => record(row) && (!requireTaskId || row.taskId === taskId))
    .slice(-maximum)
    .map(row => cloneBounded(row, MAX_BYTES))
    .filter(Boolean)
}

function safePlan(plan, taskId) {
  assertSingletonIdentity(plan, taskId)
  if (!record(plan)) return null
  const rawNodes = Array.isArray(plan.nodes) ? plan.nodes : plan.tasks
  const nodes = Array.isArray(rawNodes)
    ? rawNodes.filter(record).slice(0, 8).map(node => cloneBounded(node, 64 * 1024)).filter(Boolean)
    : []
  return cloneBounded({
    ...(typeof plan.schema === 'string' ? { schema: plan.schema } : {}),
    ...(Number.isSafeInteger(plan.revision) ? { revision: plan.revision } : {}),
    ...(typeof plan.planHash === 'string' ? { planHash: plan.planHash } : {}),
    nodes,
    ...(Array.isArray(plan.steps) ? { steps: plan.steps.slice(0, 32).map(step => cloneBounded(step, 32 * 1024)).filter(Boolean) } : {}),
  }, 256 * 1024) ?? { nodes }
}

function safeTeam(team, taskId) {
  assertSingletonIdentity(team, taskId)
  // A singleton envelope without its own binding is not attributable. The
  // runtime's selected task record is the only place allowed to provide a
  // root task identity without repeating it inside a plan.
  if (!record(team) || team.taskId !== taskId) return null
  const deliveries = Array.isArray(team.deliveries)
    ? team.deliveries.filter(row => record(row) && (row.taskId === undefined || row.taskId === taskId))
      .slice(-64).map(row => cloneBounded(row, 32 * 1024)).filter(Boolean)
    : []
  return cloneBounded({
    taskId,
    ...(Array.isArray(team.participants) ? { participants: [...new Set(team.participants.filter(value => typeof value === 'string'))].slice(0, 32) } : { participants: [] }),
    ...(record(team.counts) ? { counts: cloneBounded(team.counts, 16 * 1024) ?? {} } : { counts: {} }),
    ...(Array.isArray(team.eligibleRecipients) ? { eligibleRecipients: [...new Set(team.eligibleRecipients.filter(value => typeof value === 'string'))].slice(0, 32) } : {}),
    deliveries,
  }, 128 * 1024) ?? { taskId, participants: [], counts: {}, deliveries }
}

function safeReviewIdentity(identity) {
  if (!record(identity)) return null
  const result = {}
  for (const field of ['checkoutCommit', 'baseCommit', 'preparedBranch', 'branch', 'workingTreeDigest', 'relativeRoot']) {
    if (typeof identity[field] === 'string' && identity[field].length <= 512) result[field] = identity[field]
  }
  for (const field of ['hasWorkingTreeChanges', 'clean']) {
    if (typeof identity[field] === 'boolean') result[field] = identity[field]
  }
  return Object.keys(result).length ? result : null
}

function safeReviewRevision(revision) {
  if (typeof revision === 'string' && revision.length > 0 && revision.length <= 512) return revision
  if (!record(revision)) return null
  const contentScope = record(revision.contentScope)
    ? {
      ...(typeof revision.contentScope.patchDigest === 'string' ? { patchDigest: revision.contentScope.patchDigest } : {}),
      changedFiles: Array.isArray(revision.contentScope.changedFiles)
        ? revision.contentScope.changedFiles.slice(0, 256).map(file => ({
          ...(typeof file?.path === 'string' ? { path: file.path } : {}),
          ...(typeof file?.status === 'string' ? { status: file.status } : {}),
        })).filter(file => Object.keys(file).length > 0)
        : [],
    }
    : null
  const result = {
    ...(typeof revision.contentDigest === 'string' ? { contentDigest: revision.contentDigest } : {}),
    ...(typeof revision.reviewDigest === 'string' ? { reviewDigest: revision.reviewDigest } : {}),
    ...(typeof revision.checkoutCommit === 'string' ? { checkoutCommit: revision.checkoutCommit } : {}),
    ...(typeof revision.baseCommit === 'string' ? { baseCommit: revision.baseCommit } : {}),
    ...(typeof revision.branch === 'string' ? { branch: revision.branch } : {}),
    ...(typeof revision.scope === 'string' ? { scope: revision.scope } : {}),
    ...(contentScope ? { contentScope } : {}),
  }
  return Object.keys(result).length ? result : null
}

function safeReview(review, taskId) {
  assertSingletonIdentity(review, taskId)
  if (!record(review)) return null
  const changedFiles = Array.isArray(review.changedFiles)
    ? review.changedFiles.slice(0, 256).map(file => cloneBounded(file, 16 * 1024)).filter(Boolean)
    : []
  const result = {
    ...(typeof review.schema === 'string' ? { schema: review.schema } : {}),
    taskId,
    ...(typeof review.projectId === 'string' ? { projectId: review.projectId } : {}),
    ...(typeof review.projectName === 'string' ? { projectName: review.projectName } : {}),
    ...(typeof review.status === 'string' ? { status: review.status } : {}),
    ...(typeof review.baseCommit === 'string' ? { baseCommit: review.baseCommit } : {}),
    ...(typeof review.branch === 'string' ? { branch: review.branch } : {}),
    ...(record(review.plan) ? { plan: cloneBounded(review.plan, 256 * 1024) } : { plan: null }),
    changedFiles,
    ...(typeof review.patch === 'string'
      ? Buffer.byteLength(review.patch, 'utf8') <= 2 * 1024 * 1024 ? { patch: review.patch } : { patchStatus: 'truncated' }
      : {}),
    ...(typeof review.reviewDigest === 'string' ? { reviewDigest: review.reviewDigest } : {}),
    ...(typeof review.observedAt === 'string' ? { observedAt: review.observedAt } : {}),
    ...(typeof review.sourceTaskId === 'string' ? { sourceTaskId: review.sourceTaskId } : {}),
    ...(safeReviewIdentity(review.identity) ? { identity: safeReviewIdentity(review.identity) } : {}),
    ...(safeReviewRevision(review.revision) ? { revision: safeReviewRevision(review.revision) } : {}),
    ...(typeof review.readyToCommit === 'boolean' ? { readyToCommit: review.readyToCommit } : {}),
    ...(typeof review.stale === 'boolean' ? { stale: review.stale } : {}),
    ...(typeof review.staleReason === 'string' ? { staleReason: review.staleReason } : {}),
  }
  const maximum = 2 * 1024 * 1024
  const complete = cloneBounded(result, maximum)
  if (complete) return complete

  // A large patch must never make conservative review state disappear. Keep
  // the bounded observation metadata and make the omission explicit instead
  // of falling back to a shape that reviewState could misread as current.
  const { patch: _patch, ...metadata } = result
  const withoutPatch = cloneBounded({ ...metadata, patchStatus: 'truncated' }, maximum)
  if (withoutPatch) return withoutPatch

  // Keep the safety-critical fields even if an unusually large changed-file
  // list also exceeds the projection budget.
  return {
    taskId,
    changedFiles: changedFiles.slice(0, 32),
    ...(typeof review.observedAt === 'string' ? { observedAt: review.observedAt } : {}),
    ...(typeof review.reviewDigest === 'string' ? { reviewDigest: review.reviewDigest } : {}),
    ...(safeReviewIdentity(review.identity) ? { identity: safeReviewIdentity(review.identity) } : {}),
    ...(safeReviewRevision(review.revision) ? { revision: safeReviewRevision(review.revision) } : {}),
    ...(typeof review.stale === 'boolean' ? { stale: review.stale } : {}),
    ...(typeof review.staleReason === 'string' ? { staleReason: review.staleReason } : {}),
    patchStatus: 'truncated',
  }
}

function safeSession(session, taskId) {
  assertSingletonIdentity(session, taskId)
  if (!record(session)) return null
  const result = cloneBounded(session, 256 * 1024)
  if (!result) return null
  // A session is already selected by the runtime's recorded task context. Do
  // not expose private checkout paths in a task read model.
  if (result.workspace && record(result.workspace)) {
    const { path: _path, repositoryPath: _repositoryPath, protectedWriteRoots: _roots, ...workspace } = result.workspace
    result.workspace = workspace
  }
  if (result.source && record(result.source)) {
    const { path: _path, ...source } = result.source
    result.source = source
  }
  return result
}

function safeArtifacts(artifacts, taskId) {
  return (Array.isArray(artifacts) ? artifacts : [])
    .filter(row => record(row) && row.taskId === taskId)
    .slice(-MAX_ARTIFACTS)
    .map(row => {
      const { path: _path, storageName: _storageName, taskId: _taskId, ...safe } = row
      return cloneBounded({ ...safe, taskId }, 32 * 1024)
    })
    .filter(Boolean)
}

function reviewState(review) {
  if (!review) return { status: 'unloaded', reviewStatus: 'unloaded', loaded: false }
  if (review.stale === true) return { status: 'stale', reviewStatus: 'stale', loaded: true }
  if ((review.changedFiles ?? []).length === 0) return { status: 'empty', reviewStatus: 'empty', loaded: true }
  return { status: 'current', reviewStatus: 'current', loaded: true }
}

function safeEvidence(evidence, taskId) {
  if (!record(evidence)) return { status: 'unavailable', reason: 'TASK_OUTCOME_NOT_LOADED', taskId }
  assertSingletonIdentity(evidence, taskId)
  const stages = {}
  for (const name of ['workProduced', 'checksPassed', 'readyForReview', 'published']) {
    const stage = evidence[name]
    if (!record(stage)) continue
    assertSingletonIdentity(stage, taskId)
    const bounded = cloneBounded({ ...stage, taskId }, 64 * 1024)
    if (bounded) stages[name] = bounded
  }
  if (!Object.keys(stages).length) {
    return {
      taskId,
      status: typeof evidence.status === 'string' ? evidence.status : 'unavailable',
      ...(typeof evidence.reason === 'string' ? { reason: evidence.reason } : {}),
    }
  }
  return cloneBounded({ taskId, ...stages, ...(typeof evidence.status === 'string' ? { status: evidence.status } : {}) }, 256 * 1024)
    ?? { taskId, status: 'unavailable', reason: 'TASK_OUTCOME_BOUND_INVALID' }
}

function safeRecovery(recovery, taskId) {
  if (!record(recovery)) return { status: 'unavailable', reason: 'TASK_RECOVERY_NOT_LOADED', taskId }
  assertSingletonIdentity(recovery, taskId)
  const retained = Array.isArray(recovery.retained)
    ? recovery.retained.filter(row => {
      if (!record(row)) return false
      if (row.taskId !== undefined && row.taskId !== taskId) throw mismatch()
      return true
    }).slice(-64).map(row => cloneBounded(row, 32 * 1024)).filter(Boolean)
    : []
  const actions = Array.isArray(recovery.actions)
    ? recovery.actions.slice(0, 16).map(action => cloneBounded(action, 16 * 1024)).filter(Boolean)
    : []
  const bounded = cloneBounded({
    taskId,
    ...(typeof recovery.state === 'string' ? { state: recovery.state } : {}),
    ...(typeof recovery.status === 'string' ? { status: recovery.status } : {}),
    ...(typeof recovery.summary === 'string' ? { summary: recovery.summary } : {}),
    retained,
    actions,
    ...(typeof recovery.retryAllowed === 'boolean' ? { retryAllowed: recovery.retryAllowed } : {}),
    ...(typeof recovery.observedAt === 'string' ? { observedAt: recovery.observedAt } : {}),
  }, 256 * 1024)
  return bounded ?? { taskId, status: 'unavailable', reason: 'TASK_RECOVERY_BOUND_INVALID', retained: [], actions: [] }
}

export function buildTaskWorkspace({
  taskId,
  task,
  plan,
  team,
  messages = [],
  decisions = [],
  leases = [],
  session,
  review,
  artifacts = [],
  browserBindings = [],
  routing,
  evidence,
  recovery,
} = {}) {
  if (!boundedTaskId(taskId) || !record(task) || task.taskId !== taskId) throw mismatch()
  assertSingletonIdentity(plan, taskId)
  assertSingletonIdentity(team, taskId)
  assertSingletonIdentity(session, taskId)
  assertSingletonIdentity(review, taskId)
  assertSingletonIdentity(routing, taskId)

  const safeTask = cloneBounded(task, 256 * 1024)
  if (!safeTask) throw mismatch()
  const conversationMessages = (Array.isArray(messages) ? messages : [])
    .filter(row => record(row) && row.taskId === taskId && row.conversationId === `task:${taskId}`)
    .slice(-MAX_MESSAGES)
    .map(row => cloneBounded(row, 64 * 1024)).filter(Boolean)
  const reports = conversationMessages.filter(row => row.kind === 'structured_result')
  const selectedDecisions = selectedRows(decisions, taskId, { maximum: 64 })
  const selectedLeases = selectedRows(leases, taskId, { maximum: 64 })
  const safeReviewValue = safeReview(review, taskId)
  const safeArtifactValues = safeArtifacts(artifacts, taskId)
  const safeEvidenceValue = safeEvidence(evidence, taskId)
  const safeRecoveryValue = safeRecovery(recovery, taskId)
  const filesState = reviewState(safeReviewValue)
  const files = {
    ...filesState,
    taskId,
    review: safeReviewValue,
    artifacts: safeArtifactValues,
    artifactStatus: safeArtifactValues.length ? 'task-bound' : 'unavailable',
  }

  const safeRouting = Array.isArray(routing)
    ? selectedRows(routing, taskId, { maximum: 32 })
    : (record(routing) ? (routing.taskId === taskId ? cloneBounded(routing, 128 * 1024) : null) : routing ?? null)
  return {
    schema: TASK_WORKSPACE_SCHEMA,
    task: safeTask,
    plan: safePlan(plan, taskId),
    team: safeTeam(team, taskId),
    conversation: { conversationId: `task:${taskId}`, messages: conversationMessages },
    permissions: selectedLeases,
    approvals: selectedDecisions,
    files,
    results: {
      taskId,
      summary: safeTask.summary ?? null,
      status: safeTask.status ?? 'unknown',
      messages: conversationMessages,
      reports,
      items: reports,
    },
    browser: (Array.isArray(browserBindings) ? browserBindings : [])
      .find(row => record(row) && row.taskId === taskId) ? cloneBounded(browserBindings.find(row => record(row) && row.taskId === taskId), 128 * 1024) : null,
    routing: safeRouting,
    evidence: safeEvidenceValue,
    recovery: safeRecoveryValue,
    ...(safeSession(session, taskId) ? { session: safeSession(session, taskId) } : {}),
  }
}
