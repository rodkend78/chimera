import './task-workspace.css'

const STAGES = [
  ['workProduced', 'Work produced'],
  ['checksPassed', 'Checks passed'],
  ['readyForReview', 'Ready for review'],
  ['published', 'Published'],
]

const ACTION_LABELS = {
  inspect: 'Inspect retained work',
  reconnect: 'Reconnect',
  reconcile: 'Reconcile',
  'resume-queued': 'Resume queued work',
  continue: 'Start explicit continuation',
  retry: 'Use explicit continuation',
  'retry-read': 'Retry workspace read',
}

function text(value, fallback = 'Unavailable') {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function stateLabel(value) {
  const normalized = text(value, 'unavailable').replaceAll('-', ' ')
  return `${normalized.slice(0, 1).toUpperCase()}${normalized.slice(1)}`
}

function dateLabel(value) {
  const timestamp = typeof value === 'number' ? value : Date.parse(value ?? '')
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : null
}

function actionLabel(action) {
  return text(action?.label, ACTION_LABELS[action?.id] ?? 'Review next safe action')
}

export function TaskOutcome({ workspace, onAction }) {
  const evidence = workspace?.evidence ?? {}
  const recovery = workspace?.recovery ?? {}
  const actions = Array.isArray(recovery.actions) ? recovery.actions : []
  const retained = Array.isArray(recovery.retained) ? recovery.retained : []
  return <section className="task-outcome task-workspace-card" aria-label="Task outcomes and recovery">
    <div className="task-workspace-card-heading"><h3>Outcome evidence</h3><span>{evidence.status === 'unavailable' ? 'Not loaded' : 'Receipt-backed'}</span></div>
    <p className="task-outcome-intro">Each stage below comes from a runtime observation. Task summaries, model prose, and commits do not promote a stage.</p>
    <div className="task-outcome-stage-grid">
      {STAGES.map(([key, heading]) => {
        const stage = evidence[key] ?? {}
        const observed = dateLabel(stage.observedAt)
        return <article className={`task-outcome-stage state-${stage.state ?? 'unavailable'}`} key={key} aria-label={`${heading} outcome`}>
          <strong>{heading}</strong>
          <span>{stateLabel(stage.state)}</span>
          {observed ? <small>Observed {observed}</small> : null}
          {stage.scope ? <small>Scope: {stage.scope}</small> : null}
          {Array.isArray(stage.evidenceRefs) && stage.evidenceRefs.length ? <small>{stage.evidenceRefs.length} evidence reference{stage.evidenceRefs.length === 1 ? '' : 's'}</small> : null}
        </article>
      })}
    </div>
    <div className="task-outcome-recovery" aria-label="Task recovery">
      <div className="task-outcome-recovery-heading"><div><strong>Recovery</strong><span>{stateLabel(recovery.state ?? recovery.status)}</span></div>{recovery.retryAllowed === false ? <small>Execution retry blocked</small> : null}</div>
      <p>{text(recovery.summary, recovery.status === 'unavailable' ? 'Recovery state is not loaded.' : 'No additional recovery guidance is recorded.')}</p>
      {retained.length ? <p className="task-outcome-retained">Retained work: {retained.map(row => text(row.operationId ?? row.kind ?? row.nodeId, 'recorded effect')).join(', ')}</p> : null}
      {actions.length ? <div className="task-outcome-actions">{actions.map(action => {
        const enabled = action.enabled !== false && action.available !== false
        return <button key={`${action.id ?? 'action'}:${actionLabel(action)}`} type="button" disabled={!enabled} onClick={() => enabled && onAction?.(action.id, action)}>{actionLabel(action)}</button>
      })}</div> : <p className="task-workspace-muted">No safe recovery action is available from this observation.</p>}
    </div>
    <details className="task-outcome-technical"><summary>Technical explanation</summary><dl><div><dt>Task</dt><dd>{workspace?.task?.taskId ?? 'unknown'}</dd></div><div><dt>Recovery state</dt><dd>{stateLabel(recovery.state ?? recovery.status)}</dd></div><div><dt>Retry allowed</dt><dd>{recovery.retryAllowed === true ? 'yes' : 'no'}</dd></div>{recovery.reason ? <div><dt>Reason</dt><dd>{recovery.reason}</dd></div> : null}</dl></details>
  </section>
}
