import { createContext, useContext, useRef, useState } from 'react'
import { post } from './api.js'

const actionLabels = { continue: 'continuation', steer: 'guidance', cancel: 'stop', 'resume-queued': 'resume' }
const acceptedMessages = {
  continue: 'Explicit continuation queued; previous effects will not be replayed automatically',
  steer: 'Guidance saved for next safe boundary',
  cancel: 'Task cancelled. Already-started effects cannot be undone.',
  'resume-queued': 'Queued task resumed; it will run when the executor is available.',
}

const TaskControlContext = createContext(null)
const emptyDraft = { objective: '', budget: 'standard' }

// Owned by this loaded workspace, not by Queue or Projects. Delayed replies can
// settle while neither section is mounted. Nothing is persisted or auto-replayed.
export function TaskControlSession({ children }) {
  const pending = useRef(new Map())
  const latest = useRef(new Map())
  const [inFlight, setInFlight] = useState([])
  const [notices, setNotices] = useState({})
  const [drafts, setDrafts] = useState({})
  return <TaskControlContext.Provider value={{ pending, latest, inFlight, setInFlight, notices, setNotices, drafts, setDrafts }}>{children}</TaskControlContext.Provider>
}

function useTaskControlSession() {
  const session = useContext(TaskControlContext)
  if (!session) throw new Error('Task controls require a workspace session')
  return session
}

export function TaskControls({ tasks = [], refresh, notify, selectedTaskId, onSelectTask }) {
  const [selectedId, setSelectedId] = useState('')
  const { pending, latest, inFlight, setInFlight, notices, setNotices } = useTaskControlSession()
  const task = selectedTaskId !== undefined ? tasks.find(item => item.taskId === selectedTaskId)
    : tasks.find((item) => item.taskId === selectedId) ?? tasks[0]
  if (!task) return null
  const active = ['queued', 'running'].includes(task.status)
  const busy = inFlight.some(request => request.taskId === task.taskId)
  const stopping = inFlight.some(request => request.taskId === task.taskId && request.action === 'cancel')
  const notice = notices[task.taskId]
  const run = async (action, { objective = '', budget = 'standard' } = {}, onAccepted = () => {}) => {
    const running = pending.current.get(task.taskId) ?? new Set()
    // Stop is independent of a slow guidance/resume request, but is itself
    // single-flight. All other actions wait for this task's pending requests.
    if (action === 'cancel' ? running.has('cancel') : running.size > 0) return
    if (['continue', 'steer'].includes(action) && !objective.trim()) return
    running.add(action)
    pending.current.set(task.taskId, running)
    const request = { taskId: task.taskId, action }
    latest.current.set(task.taskId, request)
    const updatePending = () => setInFlight([...pending.current].flatMap(([taskId, actions]) => [...actions].map(action => ({ taskId, action }))))
    const updateNotice = (status, message) => {
      if (latest.current.get(task.taskId) !== request) return false
      setNotices(current => ({ ...current, [task.taskId]: { status, message, action } }))
      return true
    }
    updatePending()
    updateNotice('pending', `Sending ${actionLabels[action]} request…`)
    try {
      const limits = budget === 'extended' ? { maxTurns: 64, maxToolCalls: 48 } : { maxTurns: 32, maxToolCalls: 24 }
      await post(`/api/tasks/${action}`, { taskId: task.taskId,
        ...(action === 'steer' ? { content: objective } : action === 'continue' ? { objective, budget: limits } : {}) })
      onAccepted()
      let message = acceptedMessages[action]
      let refreshed = false
      try { refreshed = (await refresh()) !== false }
      catch { /* An acknowledged effect stays accepted even if its read fails. */ }
      if (!refreshed) message += ' The action was accepted, but status refresh failed. The displayed state may be stale. Inspect the task before taking another action; do not repeat this accepted request.'
      if (updateNotice('accepted', message)) notify(`${task.objective.slice(0, 80)}: ${actionLabels[action]} accepted`)
    } catch (error) {
      const message = String(error?.message ?? error).replaceAll('_', ' ').toLowerCase()
      if (updateNotice('failed', message)) notify(`${task.objective.slice(0, 80)}: ${actionLabels[action]} request failed`)
    } finally {
      running.delete(action)
      if (!running.size) pending.current.delete(task.taskId)
      updatePending()
    }
  }
  return <section className="surface-card task-controls" aria-label="Task recovery and control">
    <label>Task <select aria-label="Task to control" value={task.taskId} onChange={(event) => { setSelectedId(event.target.value); onSelectTask?.(event.target.value) }}>
      {tasks.map((item) => <option key={item.taskId} value={item.taskId}>{item.objective.slice(0, 80)} · {item.recoveryRequired ? 'Paused after restart' : item.status}</option>)}
    </select></label>
    <p>Status: {task.status} · Task budget: {task.budget?.maxTurns ?? 32} specialist turns / {task.budget?.maxToolCalls ?? 24} tool calls shared by the team.
      {task.checkpoint ? ` Checkpoint: ${task.checkpoint.phase ?? task.checkpoint.stage ?? 'saved'}.` : ' No saved checkpoint yet.'}</p>
    <p>{active ? 'Guidance is applied before the next model/tool boundary. Stop revokes task access; it cannot undo an in-flight action.' : 'Continue with an explicit next objective. Prior artifacts and checkpoints stay linked; uncertain effects are not blindly retried.'}</p>
    {task.status === 'queued' && task.recoveryRequired ? <p>Paused after restart. This job has not started and will not run until you resume it. Its saved access ceiling and task budget still apply.</p> : null}
    {notice ? <div className={`task-action-notice ${notice.status}`} role={notice.status === 'failed' ? 'alert' : 'status'}><strong>{actionLabels[notice.action]} · {task.taskId}</strong><p>{notice.message}</p>{notice.status === 'failed' ? <small>Your draft stays with this task across Queue and Projects until this page is reloaded. Nothing is retried automatically. Check the task and history before resubmitting: a lost connection can leave the action's outcome uncertain.</small> : null}</div> : null}
    <TaskActionForm key={`${task.taskId}:${active ? 'active' : 'terminal'}`} task={task} active={active} busy={busy} stopping={stopping} run={run} />
  </section>
}

function TaskActionForm({ task, active, busy, stopping, run }) {
  const { drafts, setDrafts } = useTaskControlSession()
  // Task identity and action type are both required: unsent guidance must never
  // become a continuation when the task completes while the operator is away.
  const draftKey = `${task.taskId}:${active ? 'guidance' : 'continuation'}`
  const draft = drafts[draftKey] ?? emptyDraft
  const setDraft = update => setDrafts(current => {
    const previous = current[draftKey] ?? emptyDraft
    const next = update(previous)
    return next === previous ? current : { ...current, [draftKey]: next }
  })
  const { objective, budget } = draft
  return <form onSubmit={(event) => {
    event.preventDefault()
    void run(active ? 'steer' : 'continue', draft, () => setDraft(current => current === draft ? { ...current, objective: '' } : current))
  }}>
      <input aria-label={active ? 'Task guidance' : 'Continuation objective'} maxLength={active ? 4096 : 16384} value={objective} onChange={(event) => setDraft(current => ({ ...current, objective: event.target.value }))} placeholder={active ? 'Tell RJ how to adjust this work…' : 'Describe exactly what RJ should do next…'} />
      {!active ? <select aria-label="Continuation budget" value={budget} onChange={(event) => setDraft(current => ({ ...current, budget: event.target.value }))}><option value="standard">Standard · 32 turns / 24 tools</option><option value="extended">Extended · 64 turns / 48 tools</option></select> : null}
      <button disabled={busy || !objective.trim()} type="submit">{active ? 'Guide task' : 'Continue task'}</button>
      {active ? <button disabled={stopping} type="button" onClick={() => void run('cancel')}>Stop task</button> : null}
      {task.status === 'queued' && task.recoveryRequired ? <button disabled={busy} type="button" onClick={() => void run('resume-queued')}>Resume queued task</button> : null}
    </form>
}
