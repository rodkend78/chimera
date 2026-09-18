import { useEffect, useRef, useState } from 'react'
import { api, browserCommandFailureMessage } from './api.js'
import { AgentAvatar } from './AgentAvatar.jsx'
import './project-results.css'

export function ProjectTaskResults({ task, session, messages = [], agents = [] }) {
  const [history, setHistory] = useState([])
  const [cursor, setCursor] = useState(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const request = useRef(null)
  useEffect(() => () => request.current?.abort(), [])
  const conversationId = `task:${task.taskId}`
  const hasRjSummary = task.status === 'completed' && typeof task.summary === 'string'
  const reports = [...new Map([...history, ...messages]
    .filter(message => message.conversationId === conversationId && message.kind === 'structured_result')
    .map(message => [message.messageId, message])).values()]
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
  const displayName = id => ['ceo', 'rj'].includes(id) ? 'RJ' : agents.find(agent => agent.agentId === id)?.displayName ?? id

  const loadHistory = async () => {
    if (busy) return
    const controller = new AbortController()
    request.current = controller
    setBusy(true); setError('')
    try {
      const query = new URLSearchParams({ conversationId, limit: '100' })
      if (cursor) query.set('before', cursor)
      const result = await api(`/api/conversations/messages?${query}`, { signal: controller.signal })
      if (!Array.isArray(result.messages)) throw new Error('REPORT_HISTORY_INVALID')
      if (!controller.signal.aborted) {
        setHistory(previous => [...result.messages, ...previous])
        setCursor(result.nextCursor ?? null)
      }
    } catch (failure) {
      if (!controller.signal.aborted) setError(browserCommandFailureMessage(failure))
    } finally { if (!controller.signal.aborted) setBusy(false) }
  }

  return <section className="project-results" aria-label="Task results">
    <header><span className="card-kicker">Task results</span><h3>{task.objective.length > 240 ? `${task.objective.slice(0, 160)}…` : task.objective}</h3><span className={`status-chip status-${task.status}`}>{task.status}</span></header>
    {task.objective.length > 240 ? <details><summary>Full objective</summary><p className="project-result-content">{task.objective}</p></details> : null}
    <dl className="project-result-meta">
      <div><dt>Task</dt><dd>{task.taskId}</dd></div>
      {session?.baseCommit ? <div><dt>Prepared base · not a current snapshot</dt><dd>{session.baseCommit}</dd></div> : null}
      {task.priorTaskId ? <div><dt>Continues</dt><dd>{task.priorTaskId}</dd></div> : null}
    </dl>
    <article className="project-result-card" aria-label={hasRjSummary ? 'RJ task summary' : 'Runtime task outcome'}>
      <div className="project-result-author"><AgentAvatar agentId={hasRjSummary ? 'ceo' : 'harness'} name={hasRjSummary ? 'RJ' : 'Harness'} /><div><strong>{hasRjSummary ? 'RJ · task summary' : 'Harness · task outcome'}</strong><small>{hasRjSummary ? 'Derived summary' : 'Runtime status'} · {task.status}</small></div></div>
      <p className="project-result-content">{task.summary ?? task.failure?.message ?? (['queued', 'running', 'submitted'].includes(task.status) ? 'Work is in progress. No final summary is recorded yet.' : 'No summary is loaded for this task. Earlier records remain available in Queue history.')}</p>
      {task.completedAt ? <time dateTime={task.completedAt}>{new Date(task.completedAt).toLocaleString()}</time> : null}
    </article>
    <div className="project-result-section-heading"><h4>Specialist reports</h4><span>{reports.length} loaded</span></div>
    <p className="project-result-note">Provenance identifies the recorded message, not proof that its conclusions are correct. Review the source and changes before accepting work.</p>
    {reports.map(report => <article className="project-result-card" aria-label={`Report from ${displayName(report.senderAgentId)}`} key={report.messageId}>
      <div className="project-result-author"><AgentAvatar agentId={report.senderAgentId} name={displayName(report.senderAgentId)} /><div><strong>{displayName(report.senderAgentId)} → {(report.recipientAgentIds ?? []).map(displayName).join(', ')}</strong><small>{report.provenance?.verification === 'verified' ? 'Verified event' : report.provenance?.verification === 'legacy' ? 'Legacy record' : 'Derived event'} · {report.status}</small></div></div>
      <p className="project-result-content">{report.content}</p>
      <time dateTime={report.createdAt}>{new Date(report.createdAt).toLocaleString()}</time>
    </article>)}
    {!reports.length ? <p className="project-result-note">No specialist reports loaded. Load this task’s history to check earlier messages.</p> : null}
    {error ? <p role="alert">{error}. Your loaded reports are preserved; retry when ready.</p> : null}
    {cursor !== null ? <button className="project-review-button" type="button" onClick={loadHistory} disabled={busy}>{busy ? 'Loading reports…' : cursor ? 'Load earlier agent reports' : 'Load agent report history'}</button> : <p className="project-result-note">All available history for this task has been loaded.</p>}
    <p className="project-result-note">To continue, enter a new objective in the task controls below. Reading a report never starts work or commits files.</p>
  </section>
}
