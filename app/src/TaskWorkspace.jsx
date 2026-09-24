import { useCallback, useEffect, useRef, useState } from 'react'
import { api, browserCommandFailureMessage } from './api.js'
import { TaskOutcome } from './TaskOutcome.jsx'
import { TaskPermissions } from './TaskPermissions.jsx'
import './task-workspace.css'

function list(value) { return Array.isArray(value) ? value : [] }

function label(value, fallback = 'Unknown') {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function statusLabel(value) {
  return label(value, 'unknown').replaceAll('-', ' ')
}

function safeDate(value) {
  const timestamp = typeof value === 'number' ? value : Date.parse(value ?? '')
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : null
}

function messageAuthor(message) {
  if (['ceo', 'rj'].includes(message?.senderAgentId)) return 'RJ'
  if (message?.senderAgentId === 'rod' || message?.senderAgentId === 'operator') return 'You'
  return label(message?.senderAgentId)
}

function renderRoute(routing) {
  if (!routing) return <p className="task-workspace-muted">No task-specific routing explanation is recorded.</p>
  if (Array.isArray(routing)) return routing.length ? <ul>{routing.map((row, index) => <li key={`${row.routeId ?? 'route'}-${index}`}>{row.routeId ?? row.model ?? 'Route'} · {statusLabel(row.status)}</li>)}</ul> : <p className="task-workspace-muted">No task-specific route candidates are recorded.</p>
  const selected = routing.selected
  return <div className="task-workspace-routing-copy">
    {selected ? <p>Selected {label(selected.agentId, 'unknown agent')} · {label(selected.model ?? selected.routeId, 'unknown model')} · {label(selected.executor, 'unknown executor')}.</p>
      : routing.selectionPending === true ? <p>Jev selection was pending when this routing record was captured.</p>
        : <p>No eligible route was recorded for this task.</p>}
    {selected?.reason ? <p>{selected.reason}</p> : null}
    {list(routing.reasons).length ? <ul>{routing.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul> : null}
    {list(routing.candidates).some(row => row.status !== 'eligible') ? <details><summary>Rejected candidates</summary><ul>{routing.candidates.filter(row => row.status !== 'eligible').map((row, index) => <li key={`${row.routeId ?? row.model ?? 'candidate'}-${index}`}>{row.model ?? row.routeId ?? 'Unknown route'} · {statusLabel(row.status)}{list(row.reasons).length ? ` · ${row.reasons.join('; ')}` : ''}</li>)}</ul></details> : null}
  </div>
}

function PlanProgress({ workspace }) {
  const task = workspace.task ?? {}
  const plan = workspace.plan
  const nodes = list(plan?.nodes)
  const steps = list(plan?.steps).length ? plan.steps : list(task.steps)
  const stepByNode = new Map(steps.map(step => [step.nodeId, step]))
  const blocked = steps.filter(step => ['blocked', 'failed'].includes(step.status))
  if (!nodes.length) return <section className="task-workspace-card task-workspace-plan"><div className="task-workspace-card-heading"><h3>Plan and progress</h3><span>Not recorded</span></div><p className="task-workspace-muted">No recorded plan nodes are loaded for this task. Progress is not inferred from a generic checklist.</p></section>
  return <section className="task-workspace-card task-workspace-plan" aria-label="Task plan and progress">
    <div className="task-workspace-card-heading"><h3>Plan and progress</h3><span>Revision {plan?.revision ?? 'unknown'}</span></div>
    <ol className="task-workspace-plan-list">
      {nodes.map(node => {
        const step = stepByNode.get(node.nodeId)
        const status = step?.status ?? 'queued'
        return <li key={node.nodeId} className={`task-workspace-plan-node status-${status}`}>
          <span className="task-workspace-node-status">{statusLabel(status)}</span>
          <div><strong>{label(node.objective, node.nodeId)}</strong><small>{label(node.specialistAgentId, 'unassigned')} · {list(node.dependsOn).length ? `after ${node.dependsOn.join(', ')}` : 'ready when admitted'}</small></div>
          {step?.reason ? <p>{step.reason}</p> : null}
        </li>
      })}
    </ol>
    {blocked.length ? <p className="task-workspace-blocker" role="status">Blocked: {blocked.map(step => `${step.nodeId} · ${step.reason ?? statusLabel(step.status)}`).join('; ')}</p> : null}
  </section>
}

function Conversation({ workspace }) {
  const messages = list(workspace.conversation?.messages)
  return <section className="task-workspace-card task-workspace-conversation" aria-label="Selected task conversation">
    <div className="task-workspace-card-heading"><h3>Conversation</h3><span>{messages.length} recorded</span></div>
    {messages.length ? <div className="task-workspace-message-list">{messages.map(message => <article key={message.messageId} className={`task-workspace-message kind-${message.kind ?? 'message'}`}>
      <div><strong>{messageAuthor(message)}</strong><small>{label(message.kind, 'message').replaceAll('_', ' ')} · {label(message.status)}</small></div>
      <p>{message.content}</p>
      {safeDate(message.createdAt) ? <time dateTime={message.createdAt}>{safeDate(message.createdAt)}</time> : null}
    </article>)}</div> : <p className="task-workspace-muted">No messages are recorded for this task yet.</p>}
  </section>
}

function Results({ workspace }) {
  const results = workspace.results ?? {}
  const reports = list(results.reports)
  return <section className="task-workspace-card task-workspace-results" aria-label="Selected task results">
    <div className="task-workspace-card-heading"><h3>Results</h3><span>{reports.length} specialist {reports.length === 1 ? 'report' : 'reports'}</span></div>
    <article className="task-workspace-summary-card"><strong>Summary</strong><p>{results.summary ?? workspace.task?.failure?.message ?? (['queued', 'running', 'submitted'].includes(workspace.task?.status) ? 'Work is in progress. No final summary is recorded yet.' : 'No summary is recorded for this task.')}</p><small>Summary is a task record, not a test or publication receipt.</small></article>
    {reports.map(report => <article className="task-workspace-report" key={report.messageId}><div><strong>{messageAuthor(report)}</strong><small>{label(report.provenance?.verification, 'derived')} event · {label(report.status)}</small></div><p>{report.content}</p></article>)}
    {!reports.length ? <p className="task-workspace-muted">No specialist reports are recorded for this task.</p> : null}
  </section>
}

function TeamDetails({ workspace }) {
  const team = workspace.team
  const deliveries = list(team?.deliveries)
  return <details className="task-workspace-disclosure"><summary>Team <span>{team?.participants?.length ?? 0} participants</span></summary>
    {team ? <><p>{list(team.participants).length ? `Assigned: ${team.participants.join(', ')}` : 'No peer assignments are recorded.'}</p><ul>{deliveries.map(delivery => <li key={delivery.messageId}>{label(delivery.senderAgentId)} → {label(delivery.recipientAgentId)} · {statusLabel(delivery.status)}{delivery.reason ? ` · ${delivery.reason}` : ''}</li>)}</ul>{!deliveries.length ? <p className="task-workspace-muted">No raw deliveries are recorded.</p> : null}</> : <p className="task-workspace-muted">No task-bound team projection is available.</p>}
  </details>
}

function FilesDetails({ workspace }) {
  const files = workspace.files ?? {}
  const review = files.review
  const changedFiles = list(review?.changedFiles)
  const artifacts = list(files.artifacts)
  const status = files.status ?? 'unloaded'
  return <details className="task-workspace-disclosure task-workspace-files"><summary>Files <span>{statusLabel(status)}</span></summary>
    <p>{status === 'unloaded' ? 'Review not loaded. Use the explicit project review action to observe the workspace.' : status === 'empty' ? 'Explicit review loaded: no changed files were observed.' : status === 'stale' ? 'Retained review is stale and cannot be treated as current.' : 'Explicit review retained for this task.'}</p>
    {review?.observedAt ? <small>Observed {safeDate(review.observedAt) ?? review.observedAt}{review.reviewDigest ? ` · digest ${review.reviewDigest}` : ''}</small> : null}
    {review?.patchStatus === 'truncated' ? <p className="task-workspace-unavailable">Observed patch omitted at the read boundary; review metadata is retained.</p> : null}
    {changedFiles.length ? <ul>{changedFiles.map((file, index) => <li key={`${file.path ?? 'file'}-${index}`}>{file.status ?? 'changed'} · {file.path ?? 'unnamed file'}</li>)}</ul> : null}
    {artifacts.length ? <ul>{artifacts.map(file => <li key={file.artifactId}>{file.name ?? file.artifactId} · {file.mimeType ?? 'artifact'} · {file.bytes ?? 0} bytes</li>)}</ul> : <p className="task-workspace-muted">No task-bound worker artifacts are available.</p>}
    {review?.patch ? <details><summary>Observed patch</summary><pre>{review.patch}</pre></details> : null}
  </details>
}

function DecisionDetails({ workspace }) {
  const approvals = list(workspace.approvals)
  return <details className="task-workspace-disclosure"><summary>Decisions <span>{approvals.length} task-bound</span></summary>
    {approvals.length ? <ul className="task-workspace-approval-list">{approvals.map(decision => <li key={decision.actionId}><strong>{decision.title ?? decision.actionId}</strong><span>{decision.resource ?? 'Exact target unavailable'} · expires {safeDate(decision.expiresAt) ?? decision.expiresAt ?? 'unknown'}</span><pre>{JSON.stringify(decision.actionDiff ?? {}, null, 2)}</pre></li>)}</ul> : <p className="task-workspace-muted">No task-bound approvals are recorded. Unbound legacy approvals remain in Needs you.</p>}
  </details>
}

function BrowserDetails({ workspace, onNavigate }) {
  const browser = workspace.browser
  return <details className="task-workspace-disclosure"><summary>Browser <span>{browser ? 'task-bound' : 'global / unattributed'}</span></summary>
    {browser ? <><p>Recorded task-bound browser binding for {label(browser.agentId, 'unknown agent')}. This read is observational; it does not control or refresh the browser.</p><dl><div><dt>Lease</dt><dd>{browser.leaseId ?? 'unknown'}</dd></div><div><dt>Status</dt><dd>{statusLabel(browser.status ?? 'recorded')}</dd></div><div><dt>Expires</dt><dd>{safeDate(browser.expiresAt) ?? browser.expiresAt ?? 'unknown'}</dd></div>{browser.observedAt ? <div><dt>Observed</dt><dd>{safeDate(browser.observedAt) ?? browser.observedAt}</dd></div> : null}</dl></> : <><p>No task-bound browser session is recorded. A globally active tab does not belong to this task.</p><button type="button" onClick={() => onNavigate?.('Browser')}>Open global Browser</button></>}
  </details>
}

function Details({ workspace }) {
  const task = workspace.task ?? {}
  return <details className="task-workspace-disclosure"><summary>Details <span>technical record</span></summary>
    <dl><div><dt>Task ID</dt><dd>{task.taskId}</dd></div><div><dt>Status</dt><dd>{statusLabel(task.status)}</dd></div>{task.destinationRevision !== undefined ? <div><dt>Destination revision</dt><dd>{task.destinationRevision}</dd></div> : null}{task.routing ? <div><dt>Routing</dt><dd>{renderRoute(workspace.routing)}</dd></div> : null}</dl>
    <p className="task-workspace-unavailable">Outcome stages are conservative runtime observations. A summary, model statement, or local commit is not a check or publication receipt.</p>
  </details>
}

export function TaskWorkspace({ taskId, onNavigate, onDestinationChange, onOutcomeAction, refresh }) {
  const [workspace, setWorkspace] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const workspaceRef = useRef(null)
  const requestRef = useRef(null)
  const generationRef = useRef(0)
  const inFlightRef = useRef(false)

  const load = useCallback(async ({ silent = false } = {}) => {
    if (inFlightRef.current) return
    const controller = new AbortController()
    requestRef.current = controller
    const generation = generationRef.current
    inFlightRef.current = true
    if (!silent) setLoading(true)
    try {
      const result = await api(`/api/tasks/${encodeURIComponent(taskId)}/workspace`, { signal: controller.signal, cache: 'no-store' })
      if (controller.signal.aborted || generationRef.current !== generation) return
      if (result?.schema !== 'chimera.task-workspace.v1' || result.task?.taskId !== taskId) throw new Error('TASK_WORKSPACE_IDENTITY_INVALID')
      workspaceRef.current = result
      setWorkspace(result)
      setError('')
    } catch (cause) {
      if (controller.signal.aborted || generationRef.current !== generation) return
      setError(browserCommandFailureMessage(cause))
      if (workspaceRef.current?.task?.taskId === taskId) setWorkspace(workspaceRef.current)
    } finally {
      if (generationRef.current === generation) {
        inFlightRef.current = false
        setLoading(false)
      }
    }
  }, [taskId])

  useEffect(() => {
    generationRef.current += 1
    workspaceRef.current = null
    inFlightRef.current = false
    setWorkspace(null)
    setError('')
    setLoading(true)
    void load()
    const interval = setInterval(() => { void load({ silent: true }) }, 2500)
    return () => { clearInterval(interval); generationRef.current += 1; inFlightRef.current = false }
  }, [taskId, load])

  const stale = Boolean(error && workspace?.task?.taskId === taskId)
  const handleOutcomeAction = useCallback((action, detail) => {
    if (action === 'retry-read') {
      void load()
      return
    }
    if (action === 'inspect') {
      const files = document.querySelector('.task-workspace-files')
      if (files && 'open' in files) files.open = true
      files?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
    onOutcomeAction?.(action, detail)
  }, [load, onOutcomeAction])
  if (!workspace) return <section className="task-workspace" aria-label="Selected task workspace"><div className="task-workspace-loading" role={error ? 'alert' : 'status'}>{error ? <><strong>Task workspace unavailable</strong><span>{error}</span><button type="button" onClick={() => void load()}>Retry selected task</button></> : <><strong>Loading selected task</strong><span>{taskId}</span></>}</div></section>
  const task = workspace.task
  return <section className="task-workspace" aria-label="Selected task workspace">
    <header className="task-workspace-header"><div><span className="card-kicker">Selected task workspace</span><h2>{task.objective}</h2><p>{task.taskId} · {statusLabel(task.status)}{task.summary ? ` · ${task.summary}` : ''}</p></div><div className="task-workspace-header-actions"><span className={`status-chip status-${task.status}`}>{statusLabel(task.status)}</span>{stale ? <span className="task-workspace-stale" role="status">Stale view</span> : null}<button type="button" onClick={() => { void load(); void refresh?.() }}>Refresh view</button></div></header>
    <article className="task-workspace-summary"><span className="card-kicker">Summary</span><p>{task.summary ?? task.failure?.message ?? (['queued', 'running', 'submitted'].includes(task.status) ? 'Work is in progress. Current plan and recorded events are below.' : 'No summary is recorded for this task.')}</p>{task.failure ? <p className="task-workspace-blocker">Blocker: {task.failure.message ?? task.failure.code ?? 'Task failed'}</p> : null}<div className="task-workspace-actions"><button type="button" onClick={() => { onDestinationChange?.({ taskId: task.taskId, recipientAgentIds: [], replyTo: null, destinationRevision: task.destinationRevision ?? null }); onNavigate?.('Queue') }}>Guide this task</button>{workspace.routing ? <button type="button" onClick={() => document.querySelector('.task-workspace-routing')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })}>View routing</button> : null}</div></article>
    <PlanProgress workspace={workspace} />
    <div className="task-workspace-primary-grid"><Conversation workspace={workspace} /><Results workspace={workspace} /></div>
    <TaskOutcome workspace={workspace} onAction={handleOutcomeAction} />
    <section className="task-workspace-card task-workspace-routing" aria-label="Task routing explanation"><div className="task-workspace-card-heading"><h3>Why this route</h3><span>Task-bound</span></div>{renderRoute(workspace.routing)}</section>
    <div className="task-workspace-disclosures"><TeamDetails workspace={workspace} /><FilesDetails workspace={workspace} /><TaskPermissions workspace={workspace} /><DecisionDetails workspace={workspace} /><BrowserDetails workspace={workspace} onNavigate={onNavigate} /><Details workspace={workspace} /></div>
    {error ? <p className="task-workspace-refresh-error" role="alert">{error}. The last known selected-task view is retained.</p> : null}
  </section>
}
