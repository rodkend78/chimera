import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { api, post } from './api.js'
import { MAX_RECOVERY_ENTRIES, readScopedEntries, recoveryWarningMessage, removeScopedEntry, safeSessionStorage, writeScopedEntry } from './recovery-store.js'

const actionLabels = { continue: 'continuation', steer: 'guidance', cancel: 'stop', 'resume-queued': 'resume' }
const acceptedMessages = {
  continue: 'Explicit continuation queued; previous effects will not be replayed automatically',
  steer: 'Guidance saved for next safe boundary',
  cancel: 'Task cancelled. Already-started effects cannot be undone.',
  'resume-queued': 'Queued task resumed; it will run when the executor is available.',
}

const TaskControlContext = createContext(null)
const emptyDraft = { objective: '', budget: 'standard', priorityPreset: 'inherit' }
const ROUTING_PRESETS = new Set(['inherit', 'balanced', 'quality', 'latency', 'economy'])
const RECEIPT_PREFIX = 'chimera.task-control-receipt.v1:'
const DRAFT_PREFIX = 'chimera.task-control-draft.v1:'
const MAX_RECEIPTS = MAX_RECOVERY_ENTRIES
const MAX_DRAFTS = MAX_RECOVERY_ENTRIES

function scopeNamespace(scope) {
  const workspaceId = scope?.workspaceId
  const operatorId = scope?.operatorId
  if (typeof workspaceId === 'string' && workspaceId.length > 0 && workspaceId.length <= 256
    && typeof operatorId === 'string' && operatorId.length > 0 && operatorId.length <= 256) return `${encodeURIComponent(workspaceId)}:${encodeURIComponent(operatorId)}`
  return 'legacy'
}

function receiptKey(taskId, action, namespace = 'legacy') { return `${RECEIPT_PREFIX}${namespace}:${encodeURIComponent(taskId)}:${encodeURIComponent(action)}` }
function draftStorageKey(taskId, action, namespace = 'legacy') { return `${DRAFT_PREFIX}${namespace}:${encodeURIComponent(taskId)}:${encodeURIComponent(action)}` }

function loadReceipts(namespace) {
  return readScopedEntries({
    storage: safeSessionStorage(), prefix: `${RECEIPT_PREFIX}${namespace}:`, maxEntries: MAX_RECEIPTS,
    parse(raw) {
      const value = JSON.parse(raw)
      if (!value || typeof value.requestId !== 'string' || value.requestId.length > 256
        || typeof value.taskId !== 'string' || value.taskId.length > 256 || typeof value.action !== 'string') return null
      if (value.submittedObjective !== undefined && (typeof value.submittedObjective !== 'string' || value.submittedObjective.length > 16384)) return null
      if (value.submittedBudget !== undefined && !['standard', 'extended'].includes(value.submittedBudget)) return null
      if (value.submittedPriorityPreset !== undefined && !ROUTING_PRESETS.has(value.submittedPriorityPreset)) return null
      return value
    },
  })
}

function loadDrafts(namespace) {
  const loaded = readScopedEntries({
    storage: safeSessionStorage(), prefix: `${DRAFT_PREFIX}${namespace}:`, maxEntries: MAX_DRAFTS,
    parse(raw) {
      const value = JSON.parse(raw)
      if (!value || typeof value.taskId !== 'string' || typeof value.action !== 'string'
        || !['guidance', 'continuation'].includes(value.action)
        || typeof value.objective !== 'string' || value.objective.length > 16384
        || (value.budget !== 'standard' && value.budget !== 'extended')
        || (value.priorityPreset !== undefined && !ROUTING_PRESETS.has(value.priorityPreset))) return null
      return { ...value, _draftKey: `${value.taskId}:${value.action}` }
    },
  })
  const rows = {}
  for (const value of Object.values(loaded.rows)) rows[value._draftKey] = { objective: value.objective, budget: value.budget, priorityPreset: value.priorityPreset ?? 'inherit' }
  return { rows, ...(loaded.warning ? { warning: loaded.warning } : {}) }
}

function persistDraft(taskId, action, draft, namespace, onWarning) {
  const storage = safeSessionStorage()
  if (!storage) {
    onWarning?.('LOCAL_RECOVERY_UNAVAILABLE')
    return { ok: false, warning: 'LOCAL_RECOVERY_UNAVAILABLE' }
  }
  const key = draftStorageKey(taskId, action, namespace)
  const priorityPreset = ROUTING_PRESETS.has(draft.priorityPreset) ? draft.priorityPreset : 'inherit'
  if (!draft.objective.trim() && draft.budget === 'standard' && priorityPreset === 'inherit') {
    return removeScopedEntry({ storage, key, onWarning })
  }
  return writeScopedEntry({ storage, prefix: `${DRAFT_PREFIX}${namespace}:`, key,
    value: { taskId, action, objective: draft.objective, budget: draft.budget, priorityPreset }, maxEntries: MAX_DRAFTS, onWarning })
}

function removeDraft(taskId, action, namespace) {
  return removeScopedEntry({ storage: safeSessionStorage(), key: draftStorageKey(taskId, action, namespace) })
}

function persistReceipt(receipt, namespace = 'legacy', onWarning) {
  const storage = safeSessionStorage()
  if (!storage) {
    onWarning?.('LOCAL_RECOVERY_UNAVAILABLE')
    return { ok: false, warning: 'LOCAL_RECOVERY_UNAVAILABLE' }
  }
  return writeScopedEntry({ storage, prefix: `${RECEIPT_PREFIX}${namespace}:`, key: receiptKey(receipt.taskId, receipt.action, namespace), value: receipt, maxEntries: MAX_RECEIPTS, onWarning })
}

function removeReceipt(receipt, namespace = 'legacy') {
  const storage = safeSessionStorage()
  if (!storage) return { ok: false, warning: 'LOCAL_RECOVERY_UNAVAILABLE' }
  const key = receiptKey(receipt.taskId, receipt.action, namespace)
  try {
    const raw = storage.getItem(key)
    if (raw !== null) {
      const current = JSON.parse(raw)
      if (current?.requestId !== receipt.requestId) return { ok: true, skipped: true }
    }
  } catch {
    return { ok: false, warning: 'LOCAL_RECOVERY_UNAVAILABLE' }
  }
  return removeScopedEntry({ storage, key })
}

function requestIdFor(task, action) {
  if (action === 'cancel' || !Number.isSafeInteger(task?.destinationRevision)) return null
  return `task-control-${action}-${crypto.randomUUID()}`
}

function admissionOperation(action) {
  return ({ continue: 'continuation', steer: 'task-steer', 'resume-queued': 'resume-queued', cancel: 'cancel' })[action] ?? action
}

function draftActionFor(action) {
  return action === 'continue' ? 'continuation' : action === 'steer' ? 'guidance' : null
}

// Owned by this loaded workspace, not by Queue or Projects. Delayed replies can
// settle while neither section is mounted. Nothing is persisted or auto-replayed.
export function TaskControlSession({ children, scope = null }) {
  const namespace = scopeNamespace(scope)
  const namespaceRef = useRef(namespace)
  namespaceRef.current = namespace
  const pending = useRef(new Map())
  const latest = useRef(new Map())
  const lookupLocks = useRef(new Map())
  const [inFlight, setInFlight] = useState([])
  const [notices, setNotices] = useState({})
  const initialDrafts = loadDrafts(namespace)
  const initialReceipts = loadReceipts(namespace)
  const draftsRef = useRef(initialDrafts.rows)
  const receiptsRef = useRef(initialReceipts.rows)
  const [drafts, setDraftRows] = useState(() => initialDrafts.rows)
  const [receipts, setReceiptRows] = useState(() => initialReceipts.rows)
  const [storageWarning, setStorageWarning] = useState(() => initialDrafts.warning ?? initialReceipts.warning ?? null)
  const setDrafts = update => {
    const current = draftsRef.current
    const next = typeof update === 'function' ? update(current) : update
    draftsRef.current = next
    setDraftRows(next)
    return next
  }
  const setReceipts = update => {
    const current = receiptsRef.current
    const next = typeof update === 'function' ? update(current) : update
    receiptsRef.current = next
    setReceiptRows(next)
    return next
  }
  useEffect(() => {
    const nextDrafts = loadDrafts(namespace)
    const nextReceipts = loadReceipts(namespace)
    namespaceRef.current = namespace
    draftsRef.current = nextDrafts.rows
    receiptsRef.current = nextReceipts.rows
    setDraftRows(nextDrafts.rows)
    setReceiptRows(nextReceipts.rows)
    setStorageWarning(nextDrafts.warning ?? nextReceipts.warning ?? null)
  }, [namespace])
  const warnStorage = code => setStorageWarning(code)
  return <TaskControlContext.Provider value={{ pending, latest, lookupLocks, namespaceRef, draftsRef, receiptsRef, inFlight, setInFlight, notices, setNotices, drafts, setDrafts, receipts, setReceipts, namespace, storageWarning, warnStorage }}>{children}</TaskControlContext.Provider>
}

function useTaskControlSession() {
  const session = useContext(TaskControlContext)
  if (!session) throw new Error('Task controls require a workspace session')
  return session
}

export function TaskControls({ tasks = [], refresh, notify, selectedTaskId, onSelectTask }) {
  const [selectedId, setSelectedId] = useState('')
  const { pending, latest, lookupLocks, namespaceRef, draftsRef, receiptsRef, inFlight, setInFlight, notices, setNotices, drafts, setDrafts, receipts, setReceipts, namespace, storageWarning, warnStorage } = useTaskControlSession()
  const task = selectedTaskId !== undefined ? tasks.find(item => item.taskId === selectedTaskId)
    : tasks.find((item) => item.taskId === selectedId) ?? tasks[0]
  if (!task) return null
  const active = ['queued', 'running'].includes(task.status)
  const busy = inFlight.some(request => request.taskId === task.taskId)
  const stopping = inFlight.some(request => request.taskId === task.taskId && request.action === 'cancel')
  const storedReceipt = receipts[receiptKey(task.taskId, 'continue', namespace)] ?? receipts[receiptKey(task.taskId, 'steer', namespace)] ?? receipts[receiptKey(task.taskId, 'cancel', namespace)] ?? receipts[receiptKey(task.taskId, 'resume-queued', namespace)]
  const notice = notices[task.taskId] ?? (storedReceipt ? { status: 'unknown', action: storedReceipt.action, message: 'Outcome unknown. Check the saved receipt before taking another action.' } : null)
  const receiptIsCurrent = receipt => {
    if (!receipt || namespaceRef.current !== namespace || typeof receipt.requestId !== 'string') return false
    const current = receiptsRef.current[receiptKey(receipt.taskId, receipt.action, namespace)]
    return current?.requestId === receipt.requestId
  }
  const rememberReceipt = receipt => {
    if (!receipt || namespaceRef.current !== namespace) return { ok: false, warning: 'LOCAL_RECOVERY_STALE' }
    const key = receiptKey(receipt.taskId, receipt.action, namespace)
    const current = receiptsRef.current[key]
    if (current && current.requestId !== receipt.requestId) return { ok: false, warning: 'LOCAL_RECOVERY_STALE' }
    const result = persistReceipt(receipt, namespace, warnStorage)
    if (result.ok) setReceipts(currentRows => ({ ...currentRows, [key]: receipt }))
    return result
  }
  const forgetReceipt = receipt => {
    if (!receiptIsCurrent(receipt)) return false
    const key = receiptKey(receipt.taskId, receipt.action, namespace)
    const result = removeReceipt(receipt, namespace)
    if (!result.ok) {
      if (result.warning) warnStorage(result.warning)
      return false
    }
    if (result.skipped) return false
    setReceipts(currentRows => {
      if (currentRows[key]?.requestId !== receipt.requestId) return currentRows
      const next = { ...currentRows }
      delete next[key]
      return next
    })
    return true
  }
  const clearSubmittedDraft = receipt => {
    const draftAction = draftActionFor(receipt?.action)
    if (!draftAction || typeof receipt?.submittedObjective !== 'string') return { ok: true, changed: false }
    if (!receiptIsCurrent(receipt)) return { ok: false, warning: 'LOCAL_RECOVERY_STALE' }
    const key = `${receipt.taskId}:${draftAction}`
    // Receipt lookup can remain awaited while the operator edits the draft.
    // Read the latest in-memory row before writing so an accepted older
    // request cannot erase newer content that was saved during the lookup.
    const currentDraft = draftsRef.current[key]
    const submittedBudget = receipt.submittedBudget === 'extended' ? 'extended' : 'standard'
    const submittedPriorityPreset = ROUTING_PRESETS.has(receipt.submittedPriorityPreset) ? receipt.submittedPriorityPreset : 'inherit'
    if (!currentDraft || currentDraft.objective !== receipt.submittedObjective || currentDraft.budget !== submittedBudget
      || (currentDraft.priorityPreset ?? 'inherit') !== submittedPriorityPreset) return { ok: true, changed: false }
    if (draftsRef.current[key] !== currentDraft) return { ok: true, changed: false }
    const next = { ...currentDraft, objective: '' }
    const persisted = persistDraft(receipt.taskId, draftAction, next, namespace, warnStorage)
    if (!persisted.ok) return { ok: false, warning: persisted.warning }
    if (draftsRef.current[key] !== currentDraft) return { ok: true, changed: false }
    setDrafts(current => current[key] === currentDraft ? { ...current, [key]: next } : current)
    return { ok: true, changed: true }
  }
  const run = async (action, { objective = '', budget = 'standard', priorityPreset = 'inherit' } = {}, onAccepted = () => {}) => {
    const running = pending.current.get(task.taskId) ?? new Set()
    // Stop is independent of a slow guidance/resume request, but is itself
    // single-flight. All other actions wait for this task's pending requests.
    const stored = receiptsRef.current[receiptKey(task.taskId, action, namespace)]
    if (stored) {
      setNotices(current => ({ ...current, [task.taskId]: { status: 'unknown', action, message: 'Outcome unknown. Check the saved receipt before taking another action.' } }))
      return
    }
    if (action === 'cancel' ? running.has('cancel') : running.size > 0) return
    if (['continue', 'steer'].includes(action) && !objective.trim()) return
    const request = { taskId: task.taskId, action, requestId: requestIdFor(task, action) }
    const submittedObjective = typeof objective === 'string' ? objective : ''
    const submittedBudget = budget === 'extended' ? 'extended' : 'standard'
    const submittedPriorityPreset = ROUTING_PRESETS.has(priorityPreset) ? priorityPreset : 'inherit'
    const requestReceipt = request.requestId ? { taskId: task.taskId, action, requestId: request.requestId, operation: admissionOperation(action), status: 'unknown', submittedObjective, submittedBudget, submittedPriorityPreset } : null
    if (request.requestId) {
      const persisted = rememberReceipt(requestReceipt)
      if (!persisted.ok) {
        forgetReceipt(requestReceipt)
        setNotices(current => ({ ...current, [task.taskId]: { status: 'failed', action, message: `This action was not sent. ${recoveryWarningMessage(persisted.warning)} Keep this task open and retry only after storage is available.` } }))
        return
      }
    }
    running.add(action)
    pending.current.set(task.taskId, running)
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
        ...(request.requestId ? { requestId: request.requestId } : {}),
        ...(action === 'steer' ? { content: objective, ...(Number.isSafeInteger(task.destinationRevision) ? { expectedDestinationRevision: task.destinationRevision } : {}) } : action === 'continue' ? { objective, budget: limits, ...(submittedPriorityPreset !== 'inherit' ? { requirements: { priorityPreset: submittedPriorityPreset } } : {}), ...(Number.isSafeInteger(task.destinationRevision) ? { expectedDestinationRevision: task.destinationRevision } : {}) } : action === 'resume-queued' ? { ...(Number.isSafeInteger(task.destinationRevision) ? { expectedDestinationRevision: task.destinationRevision } : {}) } : {}) })
      if (requestReceipt) {
        const cleared = clearSubmittedDraft(requestReceipt)
        const removed = cleared.ok && forgetReceipt(requestReceipt)
        if (!removed) {
          if (receiptIsCurrent(requestReceipt) && latest.current.get(task.taskId) === request) updateNotice('unknown', 'The action was accepted, but local recovery is still unresolved. Check the saved outcome before taking another action.')
          return
        }
      }
      onAccepted()
      let message = acceptedMessages[action]
      let refreshed = false
      try { refreshed = (await refresh()) !== false }
      catch { /* An acknowledged effect stays accepted even if its read fails. */ }
      if (!refreshed) message += ' The action was accepted, but status refresh failed. The displayed state may be stale. Inspect the task before taking another action; do not repeat this accepted request.'
      if (updateNotice('accepted', message)) notify(`${task.objective.slice(0, 80)}: ${actionLabels[action]} accepted`)
    } catch (error) {
      const message = String(error?.message ?? error).replaceAll('_', ' ').toLowerCase()
      if (request.requestId && (error?.ambiguous === true || error?.reconciliationRequired === true)) {
        rememberReceipt(requestReceipt)
        if (updateNotice('unknown', 'Outcome unknown. Check the saved receipt before taking another action; nothing was resent.')) notify(`${task.objective.slice(0, 80)}: ${actionLabels[action]} outcome unknown`)
      } else {
        if (requestReceipt) forgetReceipt(requestReceipt)
        if (updateNotice('failed', message)) notify(`${task.objective.slice(0, 80)}: ${actionLabels[action]} request failed`)
      }
    } finally {
      running.delete(action)
      if (!running.size) pending.current.delete(task.taskId)
      updatePending()
    }
  }
  const lookup = async () => {
    const key = storedReceipt ? receiptKey(storedReceipt.taskId, storedReceipt.action, namespace) : null
    const currentReceipt = key ? receiptsRef.current[key] : null
    if (!currentReceipt || busy || namespaceRef.current !== namespace) return
    const lockKey = `${namespace}:${key}:${currentReceipt.requestId}`
    if (lookupLocks.current.has(lockKey)) return
    const lookupOwner = { taskId: currentReceipt.taskId, action: 'lookup', requestId: currentReceipt.requestId }
    lookupLocks.current.set(lockKey, lookupOwner)
    latest.current.set(currentReceipt.taskId, lookupOwner)
    const stillCurrent = () => namespaceRef.current === namespace
      && receiptsRef.current[key]?.requestId === currentReceipt.requestId
      && lookupLocks.current.get(lockKey) === lookupOwner
    try {
      const result = await api(`/api/tasks/receipts/${encodeURIComponent(currentReceipt.requestId)}`, { cache: 'no-store' })
      if (!stillCurrent()) return
      const operation = admissionOperation(currentReceipt.action)
      const taskMatches = operation === 'continuation'
        ? result?.parentTaskId === currentReceipt.taskId && typeof result?.taskId === 'string'
        : result?.taskId === currentReceipt.taskId
      if (result?.requestId !== currentReceipt.requestId || !taskMatches || result?.operation !== operation) throw new Error('TASK_RECEIPT_IDENTITY_INVALID')
      if (result.status === 'accepted') {
        const cleared = clearSubmittedDraft(currentReceipt)
        const removed = cleared.ok && forgetReceipt(currentReceipt)
        if (!removed || latest.current.get(currentReceipt.taskId) !== lookupOwner) return
        setNotices(current => ({ ...current, [currentReceipt.taskId]: { status: 'accepted', action: currentReceipt.action, message: acceptedMessages[currentReceipt.action] } }))
      } else if (result.status === 'failed') {
        if (!forgetReceipt(currentReceipt) || latest.current.get(currentReceipt.taskId) !== lookupOwner) return
        setNotices(current => ({ ...current, [currentReceipt.taskId]: { status: 'failed', action: currentReceipt.action, message: `${result.reason ?? 'The request was not accepted.'} Retry explicitly when ready.` } }))
      } else if (latest.current.get(currentReceipt.taskId) === lookupOwner) setNotices(current => ({ ...current, [currentReceipt.taskId]: { status: 'unknown', action: currentReceipt.action, message: 'The saved receipt is still unresolved. Do not resend this request.' } }))
    } catch (error) {
      if (stillCurrent() && latest.current.get(currentReceipt.taskId) === lookupOwner) setNotices(current => ({ ...current, [currentReceipt.taskId]: { status: 'unknown', action: currentReceipt.action, message: `${String(error?.message ?? error).replaceAll('_', ' ').toLowerCase()}. No request was retried.` } }))
    } finally {
      if (lookupLocks.current.get(lockKey) === lookupOwner) lookupLocks.current.delete(lockKey)
    }
  }
  return <section className="surface-card task-controls" aria-label="Task recovery and control">
    <label>Task <select aria-label="Task to control" value={task.taskId} onChange={(event) => { setSelectedId(event.target.value); onSelectTask?.(event.target.value) }}>
      {tasks.map((item) => <option key={item.taskId} value={item.taskId}>{item.objective.slice(0, 80)} · {item.recoveryRequired ? 'Paused after restart' : item.status}</option>)}
    </select></label>
    <p>Status: {task.status} · Task budget: {task.budget?.maxTurns ?? 32} specialist turns / {task.budget?.maxToolCalls ?? 24} tool calls shared by the team.
      {task.checkpoint ? ` Checkpoint: ${task.checkpoint.phase ?? task.checkpoint.stage ?? 'saved'}.` : ' No saved checkpoint yet.'}</p>
    {task.routing ? <section className="task-routing-summary" aria-label="Task routing details">
      {task.routing.selected
        ? <p>Selected route: {task.routing.selected.agentId ?? 'unknown agent'} · {task.routing.selected.model ?? task.routing.selected.routeId ?? 'unknown model'} · {task.routing.selected.executor ?? 'unknown executor'}{task.routing.selected.reason ? ` · ${task.routing.selected.reason}` : ''}</p>
        : task.routing.selectionPending === true
          ? <p role="status">Jev selection was pending when this routing record was captured. {task.routing.reasons?.join('; ')}</p>
          : <p role="status">No eligible model route was available for this task. {task.routing.reasons?.join('; ') ?? 'The routing evidence is unresolved.'}</p>}
      {task.routing.candidates?.some(candidate => candidate.status !== 'eligible') ? <details><summary>Rejected routing candidates</summary><ul>{task.routing.candidates.filter(candidate => candidate.status !== 'eligible').map(candidate => <li key={`${candidate.routeId ?? candidate.model ?? 'candidate'}:${candidate.status ?? 'unknown'}`}><strong>{candidate.model ?? candidate.routeId ?? 'Unknown route'}</strong> · {candidate.status ?? 'unknown'}{candidate.details?.length ? ` · ${candidate.details.join('; ')}` : candidate.reasons?.length ? ` · ${candidate.reasons.join('; ')}` : ''}</li>)}</ul></details> : null}
    </section> : null}
    <p>{active ? 'Guidance is applied before the next model/tool boundary. Stop revokes task access; it cannot undo an in-flight action.' : 'Continue with an explicit next objective. Prior artifacts and checkpoints stay linked; uncertain effects are not blindly retried.'}</p>
    {task.status === 'queued' && task.recoveryRequired ? <p>Paused after restart. This job has not started and will not run until you resume it. Its saved access ceiling and task budget still apply.</p> : null}
    {notice ? <div className={`task-action-notice ${notice.status}`} role={notice.status === 'failed' ? 'alert' : 'status'}><strong>{actionLabels[notice.action]} · {task.taskId}</strong><p>{notice.message}</p>{notice.status === 'unknown' && storedReceipt ? <button type="button" onClick={() => void lookup()} disabled={busy}>Check saved outcome</button> : null}{notice.status === 'failed' ? <small>Your draft stays with this task across Queue and Projects until this page is reloaded. Nothing is retried automatically. Check the task and history before resubmitting: a lost connection can leave the action's outcome uncertain.</small> : null}</div> : null}
      {storageWarning ? <p className="task-storage-warning" role="alert">{recoveryWarningMessage(storageWarning)}</p> : null}
      <TaskActionForm key={`${task.taskId}:${active ? 'active' : 'terminal'}`} task={task} active={active} busy={busy} stopping={stopping} receiptAction={storedReceipt?.action ?? null} run={run} storageWarning={storageWarning} warnStorage={warnStorage} />
  </section>
}

function TaskActionForm({ task, active, busy, stopping, receiptAction, run, warnStorage }) {
  const { drafts, setDrafts, namespace } = useTaskControlSession()
  // Task identity and action type are both required: unsent guidance must never
  // become a continuation when the task completes while the operator is away.
  const draftKey = `${task.taskId}:${active ? 'guidance' : 'continuation'}`
  const draft = drafts[draftKey] ?? emptyDraft
  const setDraft = update => setDrafts(current => {
    const previous = current[draftKey] ?? emptyDraft
    const next = update(previous)
    const result = persistDraft(task.taskId, active ? 'guidance' : 'continuation', next, namespace, warnStorage)
    if (!next.objective.trim() && next.budget === 'standard' && (next.priorityPreset ?? 'inherit') === 'inherit') removeDraft(task.taskId, active ? 'guidance' : 'continuation', namespace)
    return next === previous ? current : { ...current, [draftKey]: next }
  })
  const { objective, budget, priorityPreset = 'inherit' } = draft
  return <form onSubmit={(event) => {
    event.preventDefault()
    void run(active ? 'steer' : 'continue', draft, () => setDraft(current => current === draft ? { ...current, objective: '' } : current))
  }}>
      <input aria-label={active ? 'Task guidance' : 'Continuation objective'} maxLength={active ? 4096 : 16384} value={objective} onChange={(event) => setDraft(current => ({ ...current, objective: event.target.value }))} placeholder={active ? 'Tell RJ how to adjust this work…' : 'Describe exactly what RJ should do next…'} />
      {!active ? <select aria-label="Continuation budget" value={budget} onChange={(event) => setDraft(current => ({ ...current, budget: event.target.value }))}><option value="standard">Standard · 32 turns / 24 tools</option><option value="extended">Extended · 64 turns / 48 tools</option></select> : null}
      {!active ? <select aria-label="Continuation routing preference" value={priorityPreset} onChange={(event) => setDraft(current => ({ ...current, priorityPreset: event.target.value }))}><option value="inherit">Use captured task preference</option><option value="balanced">Balanced · declared priority</option><option value="latency">Prefer speed · observed latency</option><option value="quality">Prefer quality · declared quality</option><option value="economy">Prefer lower cost · measured evidence</option></select> : null}
      <button disabled={busy || !objective.trim() || Boolean(receiptAction)} type="submit">{active ? 'Guide task' : 'Continue task'}</button>
      {active ? <button disabled={stopping} type="button" onClick={() => void run('cancel')}>Stop task</button> : null}
      {task.status === 'queued' && task.recoveryRequired ? <button disabled={busy} type="button" onClick={() => void run('resume-queued')}>Resume queued task</button> : null}
    </form>
}
