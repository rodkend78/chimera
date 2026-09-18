const ACTIVITY_SCHEMA = 'chimera.activity-projection.v1'

function actorFor(fact) {
  return fact.agentId
    ?? fact.actorId
    ?? fact.senderAgentId
    ?? fact.recipientAgentId
    ?? 'system'
}

function labelFor(fact) {
  if (fact.kind === 'model.execution.progress') {
    return ({ started: 'Codex model turn started', responding: 'Codex response received; awaiting completion',
      completed: 'Codex model turn completed' })[fact.phase] ?? 'Codex model progress'
  }
  const labels = {
    'agent.message.accepted': 'Signed agent message accepted',
    'agent.message.rejected': 'Signed agent message rejected',
    'agent.message.sent': 'Signed task handoff sent',
    'ceo.task.decomposed': 'RJ decomposed the task',
    'ceo.task.submitted': 'Task queued for RJ',
    'ceo.task.started': 'RJ started the task',
    'ceo.task.completed': 'RJ completed the task',
    'ceo.task.failed': 'RJ task failed safely',
    'ceo.task.interrupted': 'RJ task was interrupted without retry',
    'ceo.synthesis.completed': 'RJ synthesized specialist results',
    'model.selection.changed': 'Human changed the RJ model',
    'decision.queued': 'Human decision required',
    'decision.resolved': 'Human decision resolved',
    'decision.replay-rejected': 'Replayed human decision rejected',
    'browser.session.started': 'Browser session started',
    'browser.control.taken': 'Human took browser control',
    'browser.control.returned': 'Browser control returned to the agent',
  }
  if (labels[fact.kind]) return labels[fact.kind]
  if (fact.kind === 'action.pending') return `Decision required for ${fact.actionId}`
  if (fact.kind === 'action.decision') return `Gateway ${fact.outcome} ${fact.actionId}`
  if (fact.kind === 'browser.action') return `${fact.actorId} ${fact.outcome} browser ${fact.command}`
  return String(fact.kind ?? 'activity').replaceAll('.', ' ')
}

export function createActivityProjection({
  audit,
  decisions,
  browserSurface,
  agent = { id: 'ceo', name: 'RJ', model: 'Model router', status: 'Working' },
  session = {},
  now = () => Date.now(),
  limit = 50,
  models,
  tasks,
} = {}) {
  if (!audit || typeof audit.entries !== 'function' || typeof audit.verify !== 'function') {
    throw new TypeError('activity projection requires an audit log')
  }
  const generatedAt = new Date(now()).toISOString()
  const recentEvents = (audit.recent?.(limit) ?? audit.entries().slice(-limit)).reverse().map((entry) => ({
    sequence: entry.seq,
    entryHash: entry.entryHash,
    at: entry.fact.at ?? generatedAt,
    ...entry.fact,
    label: labelFor(entry.fact),
  }))
  const grouped = new Map()
  for (const event of recentEvents) {
    const agentId = actorFor(event)
    const current = grouped.get(agentId) ?? { agentId, eventCount: 0, lastEventAt: event.at, lastKind: event.kind }
    current.eventCount += 1
    if (Date.parse(event.at) > Date.parse(current.lastEventAt)) {
      current.lastEventAt = event.at
      current.lastKind = event.kind
    }
    grouped.set(agentId, current)
  }
  const pendingDecisions = decisions?.pending?.() ?? []
  const browser = browserSurface?.state?.() ?? session.browser ?? { running: false, tabs: [] }
  const controller = browserSurface?.controller?.() ?? session.controller ?? { type: 'agent', id: agent.id }
  const sessionState = {
    id: session.id ?? 'ceo-workspace',
    status: session.status ?? agent.status,
    suspended: session.suspended ?? !browser.running,
    controller,
    browser,
  }
  const auditState = audit.summary?.() ?? audit.verify()

  return {
    schema: ACTIVITY_SCHEMA,
    generatedAt,
    recentEvents,
    agentActivity: [...grouped.values()],
    pendingDecisions,
    session: sessionState,
    audit: auditState,
    agent: structuredClone(agent),
    controller,
    browser,
    suspended: sessionState.suspended,
    hourlyCost: session.hourlyCost ?? null,
    activity: recentEvents,
    decisions: pendingDecisions,
    ...(models ? { models: structuredClone(models) } : {}),
    ...(tasks ? { tasks: structuredClone(tasks) } : {}),
  }
}
