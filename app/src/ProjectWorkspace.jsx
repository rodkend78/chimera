import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { FileText, LockKeyhole, Plus, RefreshCw, Send } from './icons.jsx'
import { TaskControls } from './TaskControls.jsx'
import { ProjectTaskResults } from './ProjectTaskResults.jsx'
import { api } from './api.js'
import { MAX_RECOVERY_ENTRIES, readScopedEntries, recoveryWarningMessage, removeScopedEntry, safeSessionStorage, writeScopedEntry } from './recovery-store.js'

const emptyTaskDraft = { objective: '', profileId: 'sandbox', taskHosts: '', priorityPreset: 'balanced' }
const ROUTING_PRESETS = new Set(['balanced', 'quality', 'latency', 'economy'])
const emptyIntakeDraft = { mode: 'local', name: '', path: '', approvedHosts: '' }
const ProjectWorkspaceContext = createContext(null)
const acceptedMessages = {
  intake: 'Project registration accepted. Inspect the repository roster for its current state.',
  task: 'Project task accepted. Inspect its task room for execution progress.',
  review: 'Review request completed. If you left the project room, use Review changes to load a fresh review.',
  commit: 'Source commit accepted. Use Review changes to inspect the current source state.',
}

function requestId() {
  return `project-task-${crypto.randomUUID()}`
}

const PROJECT_RECEIPT_PREFIX = 'chimera.project-receipt.v1:'
const PROJECT_DRAFT_PREFIX = 'chimera.project-task-draft.v1:'
const MAX_PROJECT_RECEIPTS = MAX_RECOVERY_ENTRIES
const MAX_PROJECT_DRAFTS = MAX_RECOVERY_ENTRIES
function projectNamespace(scope) {
  const workspaceId = scope?.workspaceId
  const operatorId = scope?.operatorId
  if (typeof workspaceId === 'string' && workspaceId.length > 0 && workspaceId.length <= 256
    && typeof operatorId === 'string' && operatorId.length > 0 && operatorId.length <= 256) return `${encodeURIComponent(workspaceId)}:${encodeURIComponent(operatorId)}`
  return 'legacy'
}
function projectReceiptKey(projectId, action = 'task', namespace = 'legacy') { return `${PROJECT_RECEIPT_PREFIX}${namespace}:${encodeURIComponent(projectId)}:${action}` }
function projectDraftKey(projectId, namespace = 'legacy') { return `${PROJECT_DRAFT_PREFIX}${namespace}:${encodeURIComponent(projectId)}` }
function projectStorage() { return safeSessionStorage() }
function loadProjectReceipts(namespace) {
  return readScopedEntries({
    storage: projectStorage(), prefix: `${PROJECT_RECEIPT_PREFIX}${namespace}:`, maxEntries: MAX_PROJECT_RECEIPTS,
    parse(raw) {
      const value = JSON.parse(raw)
      if (!value?.requestId || value.requestId.length > 256 || !value?.projectId || value.projectId.length > 256) return null
      if (value.submittedObjective !== undefined && (typeof value.submittedObjective !== 'string' || value.submittedObjective.length > 16384)) return null
      if (value.submittedProfileId !== undefined && !['sandbox', 'connected', 'live'].includes(value.submittedProfileId)) return null
      if (value.submittedTaskHosts !== undefined && (typeof value.submittedTaskHosts !== 'string' || value.submittedTaskHosts.length > 4096)) return null
      if (value.submittedPriorityPreset !== undefined && !ROUTING_PRESETS.has(value.submittedPriorityPreset)) return null
      return value
    },
  })
}

function loadProjectDrafts(namespace) {
  const loaded = readScopedEntries({
    storage: projectStorage(), prefix: `${PROJECT_DRAFT_PREFIX}${namespace}:`, maxEntries: MAX_PROJECT_DRAFTS,
    parse(raw) {
      const value = JSON.parse(raw)
      if (!value || typeof value.projectId !== 'string' || value.projectId.length < 1 || value.projectId.length > 256
        || typeof value.objective !== 'string' || value.objective.length > 16384
        || !['sandbox', 'connected', 'live'].includes(value.profileId) || typeof value.taskHosts !== 'string' || value.taskHosts.length > 4096
        || (value.priorityPreset !== undefined && !ROUTING_PRESETS.has(value.priorityPreset))) return null
      return value
    },
  })
  const rows = {}
  for (const value of Object.values(loaded.rows)) rows[value.projectId] = { objective: value.objective, profileId: value.profileId, taskHosts: value.taskHosts, priorityPreset: value.priorityPreset ?? 'balanced' }
  return { rows, ...(loaded.warning ? { warning: loaded.warning } : {}) }
}

function persistProjectDraft(projectId, draft, namespace, onWarning) {
  const storage = projectStorage()
  if (!storage) {
    onWarning?.('LOCAL_RECOVERY_UNAVAILABLE')
    return { ok: false, warning: 'LOCAL_RECOVERY_UNAVAILABLE' }
  }
  if (typeof projectId !== 'string' || !projectId) return { ok: false, warning: 'LOCAL_RECOVERY_INVALID_KEY' }
  const key = projectDraftKey(projectId, namespace)
  const priorityPreset = ROUTING_PRESETS.has(draft.priorityPreset) ? draft.priorityPreset : 'balanced'
  if (!draft.objective.trim() && draft.profileId === 'sandbox' && !draft.taskHosts && priorityPreset === 'balanced') {
    return removeScopedEntry({ storage, key, onWarning })
  }
  return writeScopedEntry({ storage, prefix: `${PROJECT_DRAFT_PREFIX}${namespace}:`, key,
    value: { projectId, objective: draft.objective, profileId: draft.profileId, taskHosts: draft.taskHosts, priorityPreset }, maxEntries: MAX_PROJECT_DRAFTS, onWarning })
}

function removeProjectDraft(projectId, namespace) {
  return removeScopedEntry({ storage: projectStorage(), key: projectDraftKey(projectId, namespace) })
}

// Drafts and single-flight ownership last for this loaded workspace only.
// Reviewed patches and commit forms deliberately remain view-local.
export function ProjectWorkspaceSession({ children, scope = null }) {
  const namespace = projectNamespace(scope)
  const namespaceRef = useRef(namespace)
  namespaceRef.current = namespace
  const initialDrafts = loadProjectDrafts(namespace)
  const initialReceipts = loadProjectReceipts(namespace)
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const [taskChoice, setSelectedTaskId] = useState('')
  const [intakeDraft, setIntakeDraft] = useState(emptyIntakeDraft)
  const taskDraftsRef = useRef(initialDrafts.rows)
  const receiptsRef = useRef(initialReceipts.rows)
  const lookupLocks = useRef(new Map())
  const latestOperation = useRef(null)
  const [taskDrafts, setTaskDraftRows] = useState(() => initialDrafts.rows)
  const [busy, setBusy] = useState('')
  const [operationNotice, setOperationNotice] = useState(null)
  const [receipts, setReceiptRows] = useState(() => initialReceipts.rows)
  const [storageWarning, setStorageWarning] = useState(() => initialDrafts.warning ?? initialReceipts.warning ?? null)
  const operationLock = useRef(false)
  const selectionVersion = useRef(0)
  const setTaskDrafts = update => {
    const current = taskDraftsRef.current
    const next = typeof update === 'function' ? update(current) : update
    taskDraftsRef.current = next
    setTaskDraftRows(next)
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
    const nextDrafts = loadProjectDrafts(namespace)
    const nextReceipts = loadProjectReceipts(namespace)
    namespaceRef.current = namespace
    taskDraftsRef.current = nextDrafts.rows
    receiptsRef.current = nextReceipts.rows
    setTaskDraftRows(nextDrafts.rows)
    setReceiptRows(nextReceipts.rows)
    setStorageWarning(nextDrafts.warning ?? nextReceipts.warning ?? null)
  }, [namespace])
  return <ProjectWorkspaceContext.Provider value={{ selectedProjectId, setSelectedProjectId, taskChoice, setSelectedTaskId,
    intakeDraft, setIntakeDraft, taskDrafts, setTaskDrafts, taskDraftsRef, busy, setBusy, operationNotice, setOperationNotice, receipts, setReceipts, receiptsRef, lookupLocks, latestOperation, operationLock, selectionVersion, namespaceRef, namespace, storageWarning, setStorageWarning }}>{children}</ProjectWorkspaceContext.Provider>
}

function splitHosts(value) {
  return value.split(',').map((host) => host.trim()).filter(Boolean)
}

function statusLabel(value) {
  return value ? value[0].toUpperCase() + value.slice(1) : 'Ready'
}

export function ProjectWorkspace({ state, registerProject, submitProjectTask, reviewProject, commitProject, notify, refresh }) {
  const projects = state.projects?.projects ?? []
  const sessions = state.projects?.sessions ?? []
  const session = useContext(ProjectWorkspaceContext)
  if (!session) throw new Error('Projects require a workspace session')
  const { selectedProjectId, setSelectedProjectId, taskChoice, setSelectedTaskId, intakeDraft, setIntakeDraft,
    taskDrafts, setTaskDrafts, taskDraftsRef, busy, setBusy, operationNotice, setOperationNotice, receipts, setReceipts, receiptsRef, lookupLocks, latestOperation, operationLock, selectionVersion, namespaceRef, namespace, storageWarning, setStorageWarning } = session
  const { mode, name, path, approvedHosts } = intakeDraft
  const updateIntake = changes => setIntakeDraft(current => ({ ...current, ...changes }))
  const draft = taskDrafts[selectedProjectId] ?? emptyTaskDraft
  const { objective, profileId, taskHosts, priorityPreset = 'balanced' } = draft
  const updateDraft = changes => setTaskDrafts(current => {
    const next = { ...(current[selectedProjectId] ?? emptyTaskDraft), ...changes }
    const result = persistProjectDraft(selectedProjectId, next, namespace, setStorageWarning)
    if (!result.ok && result.warning) setStorageWarning(result.warning)
    return { ...current, [selectedProjectId]: next }
  })
  const [loadedReview, setReview] = useState(null)
  const [commitMessage, setCommitMessage] = useState('')

  // Leaving the room invalidates selection/review callbacks, not the request.
  useEffect(() => () => { selectionVersion.current++ }, [selectionVersion])

  useEffect(() => {
    if (!projects.some((project) => project.projectId === selectedProjectId)) {
      selectionVersion.current++
      setSelectedProjectId(projects[0]?.projectId ?? '')
    }
  }, [projects, selectedProjectId])

  const selectedProject = projects.find((project) => project.projectId === selectedProjectId) ?? null
  const restoredReceipt = selectedProjectId ? receipts[projectReceiptKey(selectedProjectId, 'task', namespace)] : null
  const activeOperation = latestOperation.current
  const pendingTaskOwner = activeOperation?.kind === 'run' && activeOperation.action === 'task' && operationLock.current
    ? activeOperation
    : null
  const pendingTaskReceipt = pendingTaskOwner
    ? receipts[projectReceiptKey(pendingTaskOwner.projectId, 'task', namespace)]
    : null
  const pendingProjectTask = Boolean(pendingTaskOwner && pendingTaskReceipt)
  const visibleOperationNotice = pendingProjectTask ? {
    status: 'pending', label: pendingTaskOwner.label ?? `Queue task: ${pendingTaskOwner.projectId}`,
    message: 'Submitting project task…', receipt: null,
  } : operationNotice ?? (restoredReceipt ? {
    status: 'unknown', label: `Queue task: ${selectedProject?.name ?? selectedProjectId}`,
    message: 'Outcome unknown. Check the saved project receipt before taking another action.', receipt: restoredReceipt,
  } : null)
  const unresolvedProjectReceipt = Boolean(restoredReceipt || (visibleOperationNotice?.status === 'unknown' && visibleOperationNotice?.receipt))
  const projectSessions = useMemo(
    () => sessions.filter((session) => session.projectId === selectedProjectId),
    [sessions, selectedProjectId],
  )
  const active = state.tasks?.some((task) => ['submitted', 'queued', 'running'].includes(task.status))
  const projectTasks = (state.tasks ?? []).filter(task => task.projectId === selectedProjectId)
  const taskEntries = [...projectTasks, ...projectSessions.filter(session => !projectTasks.some(task => task.taskId === session.taskId))
    .map(session => ({ taskId: session.taskId, objective: `Earlier task ${session.taskId.slice(-8)}`, status: session.status }))]
  const selectedTask = taskEntries.find(task => task.taskId === taskChoice) ?? taskEntries[0] ?? null
  const selectedTaskId = selectedTask?.taskId ?? ''
  const selectedSession = projectSessions.find(session => session.taskId === (selectedTask?.projectSessionTaskId ?? selectedTaskId)) ?? null
  const review = loadedReview?.taskId === selectedTaskId ? loadedReview.value : null
  const selectTask = taskId => { selectionVersion.current++; setSelectedTaskId(taskId); setReview(null); setCommitMessage('') }
  const selectProject = projectId => { selectionVersion.current++; setSelectedProjectId(projectId); setSelectedTaskId(''); setReview(null); setCommitMessage('') }

  const receiptIsCurrent = receipt => {
    if (!receipt || namespaceRef.current !== namespace || typeof receipt.requestId !== 'string') return false
    const current = receiptsRef.current[projectReceiptKey(receipt.projectId, receipt.action, namespace)]
    return current?.requestId === receipt.requestId
  }
  const rememberReceipt = receipt => {
    if (!receipt || namespaceRef.current !== namespace) return { ok: false, warning: 'LOCAL_RECOVERY_STALE' }
    const key = projectReceiptKey(receipt.projectId, receipt.action, namespace)
    const current = receiptsRef.current[key]
    if (current && current.requestId !== receipt.requestId) return { ok: false, warning: 'LOCAL_RECOVERY_STALE' }
    const storage = projectStorage()
    const result = writeScopedEntry({ storage, prefix: `${PROJECT_RECEIPT_PREFIX}${namespace}:`, key, value: receipt, maxEntries: MAX_PROJECT_RECEIPTS, onWarning: setStorageWarning })
    if (result.ok) setReceipts(currentRows => ({ ...currentRows, [key]: receipt }))
    return result
  }
  const forgetReceipt = receipt => {
    if (!receiptIsCurrent(receipt)) return false
    const key = projectReceiptKey(receipt.projectId, receipt.action, namespace)
    const storage = projectStorage()
    if (storage) {
      try {
        const raw = storage.getItem(key)
        if (raw !== null && JSON.parse(raw)?.requestId !== receipt.requestId) return false
      } catch {
        setStorageWarning('LOCAL_RECOVERY_UNAVAILABLE')
        return false
      }
    }
    const result = removeScopedEntry({ storage, key, onWarning: setStorageWarning })
    if (!result.ok) return false
    setReceipts(currentRows => {
      if (currentRows[key]?.requestId !== receipt.requestId) return currentRows
      const next = { ...currentRows }
      delete next[key]
      return next
    })
    return true
  }
  const clearSubmittedTaskDraft = receipt => {
    if (typeof receipt?.submittedObjective !== 'string') return { ok: true, changed: false }
    if (receipt.requestId !== null && !receiptIsCurrent(receipt)) return { ok: false, warning: 'LOCAL_RECOVERY_STALE' }
    if (namespaceRef.current !== namespace) return { ok: false, warning: 'LOCAL_RECOVERY_STALE' }
    // Receipt lookup may wait while the operator edits the project draft. Use
    // the latest row before any storage write so an accepted older request
    // cannot erase newer content saved during that lookup.
    const currentDraft = taskDraftsRef.current[receipt.projectId]
    if (!currentDraft || currentDraft.objective.trim() !== receipt.submittedObjective.trim()
      || currentDraft.profileId !== (receipt.submittedProfileId ?? 'sandbox')
      || currentDraft.taskHosts !== (receipt.submittedTaskHosts ?? '')
      || (currentDraft.priorityPreset ?? 'balanced') !== (receipt.submittedPriorityPreset ?? 'balanced')) return { ok: true, changed: false }
    if (taskDraftsRef.current[receipt.projectId] !== currentDraft) return { ok: true, changed: false }
    const next = { ...currentDraft, objective: '' }
    const persisted = persistProjectDraft(receipt.projectId, next, namespace, setStorageWarning)
    if (!persisted.ok) return { ok: false, warning: persisted.warning }
    if (taskDraftsRef.current[receipt.projectId] !== currentDraft) return { ok: true, changed: false }
    setTaskDrafts(current => current[receipt.projectId] === currentDraft ? { ...current, [receipt.projectId]: next } : current)
    return { ok: true, changed: true }
  }
  const run = async (key, label, operation, { receipt = null } = {}) => {
    // A ref also closes the gap before React renders disabled buttons.
    if (operationLock.current) return
    if (receipt && receiptsRef.current[projectReceiptKey(receipt.projectId, receipt.action, namespace)]) {
      setOperationNotice({ status: 'unknown', label, message: 'Outcome unknown. Check the saved project receipt before taking another action.', receipt })
      return
    }
    const owner = { kind: 'run', action: key, label, projectId: receipt?.projectId ?? selectedProjectId, token: Symbol('project-operation') }
    latestOperation.current = owner
    const savedReceipt = receipt ? { ...receipt, status: 'unknown' } : null
    if (receipt) {
      const persisted = rememberReceipt(savedReceipt)
      if (!persisted.ok) {
        forgetReceipt(savedReceipt)
        setOperationNotice({ status: 'failed', label, message: `This task was not sent. ${recoveryWarningMessage(persisted.warning)} Keep this project open and retry only after storage is available.` })
        return
      }
    }
    operationLock.current = true
    setBusy(key)
    setOperationNotice(null)
    try {
      const result = await operation()
      if (savedReceipt) {
        if (latestOperation.current !== owner) return result
        const cleared = clearSubmittedTaskDraft(savedReceipt)
        const removed = cleared.ok && forgetReceipt(savedReceipt)
        if (!removed) {
          if (latestOperation.current === owner && receiptIsCurrent(savedReceipt)) setOperationNotice({ status: 'unknown', label, message: 'The task was accepted, but local recovery is still unresolved. Check the saved project receipt before taking another action.' , receipt: savedReceipt })
          return result
        }
      }
      if (latestOperation.current === owner) setOperationNotice({ status: 'accepted', label, message: result?.refreshFailed ? `${acceptedMessages[key]} The latest workspace state could not be confirmed; do not resend.` : acceptedMessages[key] })
      return result
    }
    catch (cause) {
      if (receipt && (cause?.ambiguous === true || cause?.reconciliationRequired === true)) {
        if (latestOperation.current !== owner) return
        const retained = rememberReceipt(savedReceipt)
        if (retained.ok && latestOperation.current === owner) setOperationNotice({ status: 'unknown', label, message: 'Outcome unknown. Check the saved project receipt before taking another action.', receipt: savedReceipt })
      } else {
        if (latestOperation.current !== owner) return
        if (savedReceipt) forgetReceipt(savedReceipt)
        if (latestOperation.current === owner) setOperationNotice({ status: 'failed', label, message: String(cause?.message ?? cause).replaceAll('_', ' ') })
      }
    }
    finally { operationLock.current = false; setBusy('') }
  }

  const intake = async (event) => {
    event.preventDefault()
    if (!name.trim() || (mode === 'local' && !path.trim())) return
    const selection = selectionVersion.current
    await run('intake', `Add project: ${name.trim()}`, async () => {
      const project = await registerProject({
        mode,
        name: name.trim(),
        ...(mode === 'local' ? { path: path.trim() } : {}),
        networkHosts: splitHosts(approvedHosts),
      })
      if (selection === selectionVersion.current) selectProject(project.projectId)
      setIntakeDraft(current => current === intakeDraft ? { ...current, name: '', path: '', approvedHosts: '' } : current)
    })
  }

  const start = async (event) => {
    event.preventDefault()
    if (!selectedProject || !objective.trim() || state.projectQueue?.blocked) return
    const selection = selectionVersion.current
    const savedReceipt = state.draftScope?.workspaceId ? {
      projectId: selectedProject.projectId, action: 'task', requestId: requestId(), operation: 'project-task',
      submittedObjective: objective.trim(), submittedProfileId: profileId, submittedTaskHosts: taskHosts, submittedPriorityPreset: priorityPreset,
    } : null
    const legacySubmitted = {
      projectId: selectedProject.projectId, action: 'task', requestId: null,
      submittedObjective: objective.trim(), submittedProfileId: profileId, submittedTaskHosts: taskHosts, submittedPriorityPreset: priorityPreset,
    }
    await run('task', `Queue task: ${selectedProject.name}`, async () => {
      const task = await submitProjectTask({
        projectId: selectedProject.projectId,
        objective: objective.trim(),
        access: { profileId, networkHosts: splitHosts(taskHosts), ttlSeconds: 900 },
        requirements: { priorityPreset },
        ...(savedReceipt ? { requestId: savedReceipt.requestId } : {}),
      })
      if (selection === selectionVersion.current) selectTask(task.taskId)
      if (!savedReceipt) clearSubmittedTaskDraft(legacySubmitted)
      return task
    }, { receipt: savedReceipt })
  }

  const lookupReceipt = async () => {
    const visibleReceipt = visibleOperationNotice?.receipt
    const key = visibleReceipt ? projectReceiptKey(visibleReceipt.projectId, visibleReceipt.action, namespace) : null
    const receipt = key ? receiptsRef.current[key] : null
    if (!visibleReceipt || !receipt || receipt.requestId !== visibleReceipt.requestId || namespaceRef.current !== namespace) return
    if (operationLock.current || busy === 'task') return
    const lockKey = `${namespace}:${key}:${receipt.requestId}`
    if (lookupLocks.current.has(lockKey)) return
    const owner = { kind: 'lookup', projectId: receipt.projectId, token: Symbol('project-receipt-lookup') }
    lookupLocks.current.set(lockKey, owner)
    latestOperation.current = owner
    const label = visibleOperationNotice?.label ?? `Queue task: ${selectedProject?.name ?? receipt.projectId}`
    const stillCurrent = () => namespaceRef.current === namespace
      && receiptsRef.current[key]?.requestId === receipt.requestId
      && lookupLocks.current.get(lockKey) === owner
    try {
      const result = await api(`/api/tasks/receipts/${encodeURIComponent(receipt.requestId)}`, { cache: 'no-store' })
      if (!stillCurrent()) return
      if (result?.requestId !== receipt.requestId || result?.operation !== receipt.operation) throw new Error('TASK_RECEIPT_IDENTITY_INVALID')
      if (result.status === 'accepted') {
        const cleared = clearSubmittedTaskDraft(receipt)
        const removed = cleared.ok && forgetReceipt(receipt)
        if (!removed || latestOperation.current !== owner) return
        setOperationNotice({ status: 'accepted', label, message: acceptedMessages.task })
      } else if (result.status === 'failed') {
        if (!forgetReceipt(receipt) || latestOperation.current !== owner) return
        setOperationNotice({ status: 'failed', label, message: `${result.reason ?? 'The project task was not accepted.'} Retry explicitly when ready.` })
      } else if (latestOperation.current === owner) setOperationNotice(current => ({ ...current, status: 'unknown', message: 'The saved project receipt is still unresolved. Do not resend this task.' }))
    } catch (cause) {
      if (stillCurrent() && latestOperation.current === owner) setOperationNotice(current => ({ ...current, status: 'unknown', message: `${String(cause?.message ?? cause).replaceAll('_', ' ').toLowerCase()}. No task was retried.` }))
    } finally {
      if (lookupLocks.current.get(lockKey) === owner) lookupLocks.current.delete(lockKey)
    }
  }

  const loadReview = async () => {
    if (!selectedSession) return
    const selection = selectionVersion.current
    await run('review', `Review changes: ${selectedProject.name} · ${selectedTaskId}`, async () => {
      setReview(null)
      const value = await reviewProject(selectedSession.taskId)
      if (selection === selectionVersion.current) setReview({ taskId: selectedTaskId, value })
    })
  }

  const commit = async (event) => {
    event.preventDefault()
    if (!selectedSession || !review?.readyToCommit || !commitMessage.trim()) return
    const selection = selectionVersion.current
    await run('commit', `Commit changes: ${selectedProject.name} · ${selectedTaskId}`, async () => {
      await commitProject({ taskId: selectedSession.taskId, message: commitMessage.trim(), expectedReviewDigest: review?.reviewDigest })
      if (selection === selectionVersion.current) {
        setCommitMessage(current => current === commitMessage ? '' : current)
        setReview(null)
      }
      try {
        const value = await reviewProject(selectedSession.taskId)
        if (selection === selectionVersion.current) setReview({ taskId: selectedTaskId, value })
      } catch (cause) {
        throw new Error(`Commit succeeded, but the updated review could not load. Use Review changes to inspect the new state; do not repeat the commit. ${cause.message}`)
      }
    })
  }

  return (
    <main className="section-region projects-region" aria-labelledby="projects-heading">
      <header className="section-header">
        <div><span className="section-eyebrow">ADE workspace</span><h1 id="projects-heading">Projects</h1><p>Give RJ a Git project, let the team work in a task-isolated copy, then review every file before an explicit commit reaches your source.</p></div>
      </header>

      {storageWarning ? <p className="project-storage-warning" role="alert">{recoveryWarningMessage(storageWarning)}</p> : null}
      {visibleOperationNotice ? <div className={`project-operation-notice ${visibleOperationNotice.status === 'failed' ? 'project-operation-error' : visibleOperationNotice.status}`} role={visibleOperationNotice.status === 'failed' ? 'alert' : 'status'}><strong>{visibleOperationNotice.label}</strong><p>{visibleOperationNotice.message}</p>{visibleOperationNotice.status === 'unknown' && visibleOperationNotice.receipt ? <button type="button" disabled={!!operationLock.current || !!busy} title={operationLock.current || busy ? `Check saved outcome after the ${busy || 'current project action'} completes.` : undefined} onClick={() => void lookupReceipt()}>Check saved outcome</button> : null}<small>Your unsent project drafts survive section navigation until this page is reloaded. Nothing is retried automatically.{visibleOperationNotice.status === 'failed' ? ' If a connection failed, inspect the project and task list before resubmitting: the server may already have accepted the action.' : ''}</small><button type="button" onClick={() => setOperationNotice(null)}>Dismiss message</button></div> : null}

      <div className="project-layout">
        <section className="surface-card project-intake-card">
          <div className="card-heading compact"><span className="project-card-icon"><Plus size={20} /></span><div><span className="card-kicker">Project intake</span><h2>Add a repository</h2></div></div>
          <form className="project-form" onSubmit={intake}>
            <label><span>Repository mode</span><select value={mode} onChange={(event) => updateIntake({ mode: event.target.value })}><option value="local">Use an existing local Git repository</option><option value="managed">Create a Chimera-managed repository</option></select></label>
            <label><span>Project name</span><input value={name} maxLength={256} onChange={(event) => updateIntake({ name: event.target.value })} placeholder="Website rebuild" /></label>
            {mode === 'local' ? <label><span>Repository path</span><input value={path} maxLength={4096} onChange={(event) => updateIntake({ path: event.target.value })} placeholder="/absolute/path/to/project" /></label> : null}
            <label><span>Approved network hosts</span><input value={approvedHosts} onChange={(event) => updateIntake({ approvedHosts: event.target.value })} placeholder="github.com, api.example.com" /><small>Optional. Task leases can only narrow this project allowlist.</small></label>
            <button className="project-primary" type="submit" disabled={!!busy || !name.trim() || (mode === 'local' && !path.trim())}>{busy === 'intake' ? 'Adding…' : mode === 'local' ? 'Add project' : 'Create project'}</button>
          </form>
        </section>

        <section className="surface-card project-list-card">
          <div className="card-heading compact"><span className="project-card-icon"><FileText size={20} /></span><div><span className="card-kicker">Repository roster</span><h2>{projects.length} project{projects.length === 1 ? '' : 's'}</h2></div></div>
          <div className="project-list">
            {projects.map((project) => <button className={project.projectId === selectedProjectId ? 'project-row selected' : 'project-row'} type="button" key={project.projectId} onClick={() => selectProject(project.projectId)}><span><strong>{project.name}</strong><small>{project.source.type} · {project.defaultBranch}</small></span><i className="project-ready">Ready</i></button>)}
            {!projects.length ? <div className="project-empty">Add an existing Git repository or let Chimera create one.</div> : null}
          </div>
        </section>
      </div>

      {selectedProject ? <section className="surface-card project-work-card">
        <header className="project-work-heading"><div><span className="card-kicker">RJ project room</span><h2>{selectedProject.name}</h2><code>{selectedProject.source.path}</code></div><span className="project-boundary"><LockKeyhole size={16} /> Isolated until commit</span></header>
        <div className="project-work-grid">
          <form className="project-task-form" onSubmit={start}>
            <label><span>Objective for RJ</span><textarea value={objective} maxLength={16384} onChange={(event) => updateDraft({ objective: event.target.value })} placeholder="Describe the outcome and acceptance criteria…" /></label>
            <div className="project-access-row"><label><span>Task access</span><select value={profileId} onChange={(event) => updateDraft({ profileId: event.target.value, ...(event.target.value === 'sandbox' ? { taskHosts: '' } : {}) })}><option value="sandbox">Sandbox · no network</option><option value="connected">Connected · approved hosts</option><option value="live">Live · approved public internet</option></select></label><label><span>Hosts for this task</span><input disabled={profileId === 'sandbox'} value={taskHosts} onChange={(event) => updateDraft({ taskHosts: event.target.value })} placeholder={selectedProject.networkHosts.length ? selectedProject.networkHosts.join(', ') : 'No hosts approved'} /></label><label><span>Routing</span><select aria-label="Project task routing preference" value={priorityPreset} onChange={(event) => updateDraft({ priorityPreset: event.target.value })}><option value="balanced">Balanced · declared priority</option><option value="latency">Prefer speed · observed latency</option><option value="quality">Prefer quality · declared quality</option><option value="economy">Prefer lower cost · measured evidence</option></select></label></div>
            <small>RJ may delegate only within each agent’s standing ceiling. Access leases begin during execution and are revoked when the task ends. Jobs run one at a time; up to 32 can wait in the queue.</small>
            {state.projectQueue?.blocked ? <p role="alert">Queue paused because task cleanup needs attention. Inspect the last task’s checkpoint before restarting Chimera.</p> : null}
            <button className="project-primary" type="submit" disabled={!!busy || state.projectQueue?.blocked || unresolvedProjectReceipt || !objective.trim()}><Send size={16} />{busy === 'task' ? 'Queuing…' : active ? 'Queue project task' : 'Plan and delegate'}</button>
          </form>

          <div className="project-session-panel">
            <div className="project-session-tabs" aria-label="Project tasks">{taskEntries.map(task => <button className={task.taskId === selectedTaskId ? 'active' : ''} aria-pressed={task.taskId === selectedTaskId} title={task.objective} type="button" key={task.taskId} onClick={() => selectTask(task.taskId)}><span>{task.objective}</span><i className={`status-chip status-${task.status}`}>{statusLabel(task.status)}</i></button>)}</div>
            {selectedTask ? <div className="project-session-detail">
              <ProjectTaskResults key={selectedTaskId} task={selectedTask} session={selectedSession} messages={state.conversations?.messages} agents={state.agents?.specialists} />
              {selectedSession ? <>
              <div className="project-session-meta"><span><b>Branch</b><code>{selectedSession.branch}</code></span><span><b>Workspace</b><code>{selectedSession.workspace.relativeRoot}</code></span></div>
              <div className="project-plan"><span>RJ plan and staffing</span>{selectedSession.plan?.tasks?.length ? <ol>{selectedSession.plan.tasks.map((task, index) => <li key={`${task.specialistAgentId}-${index}`}><i>{index + 1}</i><div><strong>{task.specialistAgentId}</strong><p>{task.objective}</p><small>{task.acceptanceCriteria.join(' · ')}</small></div></li>)}</ol> : <p>RJ’s signed plan will appear here before any specialist starts.</p>}</div>
              <button className="project-review-button" type="button" disabled={!!busy} onClick={loadReview}><RefreshCw size={15} />{busy === 'review' ? 'Loading…' : 'Review changes'}</button>
              {review ? <div className="project-review"><div><strong>{review.changedFiles.length} changed file{review.changedFiles.length === 1 ? '' : 's'}</strong><span>{review.readyToCommit ? 'Awaiting your commit' : statusLabel(review.status)}</span></div>{review.changedFiles.length ? <ul>{review.changedFiles.map((file) => <li key={file.path}><code>{file.status.trim() || 'M'}</code><span>{file.path}</span></li>)}</ul> : <p>No project changes to deliver.</p>}<pre>{review.patch || 'No patch.'}</pre>{review.readyToCommit ? <form className="project-commit" onSubmit={commit}><input value={commitMessage} maxLength={512} onChange={(event) => setCommitMessage(event.target.value)} placeholder="Commit message" /><button type="submit" disabled={!!busy || !commitMessage.trim()}>{busy === 'commit' ? 'Committing…' : 'Commit to source'}</button></form> : null}</div> : null}
              </> : <p className="project-result-note">No prepared workspace is available for this task yet.</p>}
            </div> : <div className="project-empty">Describe the work above. RJ will staff an imported agent and keep its changes isolated for review.</div>}
          </div>
        </div>
        <div className="project-task-controls"><TaskControls tasks={projectTasks} selectedTaskId={selectedTaskId} onSelectTask={selectTask} refresh={refresh} notify={notify} /></div>
      </section> : null}
    </main>
  )
}
