import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { FileText, LockKeyhole, Plus, RefreshCw, Send } from './icons.jsx'
import { TaskControls } from './TaskControls.jsx'
import { ProjectTaskResults } from './ProjectTaskResults.jsx'

const emptyTaskDraft = { objective: '', profileId: 'sandbox', taskHosts: '' }
const emptyIntakeDraft = { mode: 'local', name: '', path: '', approvedHosts: '' }
const ProjectWorkspaceContext = createContext(null)
const acceptedMessages = {
  intake: 'Project registration accepted. Inspect the repository roster for its current state.',
  task: 'Project task accepted. Inspect its task room for execution progress.',
  review: 'Review request completed. If you left the project room, use Review changes to load a fresh review.',
  commit: 'Source commit accepted. Use Review changes to inspect the current source state.',
}

// Drafts and single-flight ownership last for this loaded workspace only.
// Reviewed patches and commit forms deliberately remain view-local.
export function ProjectWorkspaceSession({ children }) {
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const [taskChoice, setSelectedTaskId] = useState('')
  const [intakeDraft, setIntakeDraft] = useState(emptyIntakeDraft)
  const [taskDrafts, setTaskDrafts] = useState({})
  const [busy, setBusy] = useState('')
  const [operationNotice, setOperationNotice] = useState(null)
  const operationLock = useRef(false)
  const selectionVersion = useRef(0)
  return <ProjectWorkspaceContext.Provider value={{ selectedProjectId, setSelectedProjectId, taskChoice, setSelectedTaskId,
    intakeDraft, setIntakeDraft, taskDrafts, setTaskDrafts, busy, setBusy, operationNotice, setOperationNotice, operationLock, selectionVersion }}>{children}</ProjectWorkspaceContext.Provider>
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
    taskDrafts, setTaskDrafts, busy, setBusy, operationNotice, setOperationNotice, operationLock, selectionVersion } = session
  const { mode, name, path, approvedHosts } = intakeDraft
  const updateIntake = changes => setIntakeDraft(current => ({ ...current, ...changes }))
  const draft = taskDrafts[selectedProjectId] ?? emptyTaskDraft
  const { objective, profileId, taskHosts } = draft
  const updateDraft = changes => setTaskDrafts(current => ({ ...current, [selectedProjectId]: { ...(current[selectedProjectId] ?? emptyTaskDraft), ...changes } }))
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

  const run = async (key, label, operation) => {
    // A ref also closes the gap before React renders disabled buttons.
    if (operationLock.current) return
    operationLock.current = true
    setBusy(key)
    setOperationNotice(null)
    try {
      const result = await operation()
      setOperationNotice({ status: 'accepted', label, message: acceptedMessages[key] })
      return result
    }
    catch (cause) { setOperationNotice({ status: 'failed', label, message: String(cause?.message ?? cause).replaceAll('_', ' ') }) }
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
    await run('task', `Queue task: ${selectedProject.name}`, async () => {
      const task = await submitProjectTask({
        projectId: selectedProject.projectId,
        objective: objective.trim(),
        access: { profileId, networkHosts: splitHosts(taskHosts), ttlSeconds: 900 },
      })
      if (selection === selectionVersion.current) selectTask(task.taskId)
      // Do not erase text or access choices edited while the request was pending.
      setTaskDrafts(current => current[selectedProjectId] === draft
        ? { ...current, [selectedProjectId]: { ...draft, objective: '' } } : current)
    })
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

      {operationNotice ? <div className={`project-operation-notice ${operationNotice.status === 'failed' ? 'project-operation-error' : 'accepted'}`} role={operationNotice.status === 'failed' ? 'alert' : 'status'}><strong>{operationNotice.label}</strong><p>{operationNotice.message}</p><small>Your unsent project drafts survive section navigation until this page is reloaded. Nothing is retried automatically.{operationNotice.status === 'failed' ? ' If a connection failed, inspect the project and task list before resubmitting: the server may already have accepted the action.' : ''}</small><button type="button" onClick={() => setOperationNotice(null)}>Dismiss message</button></div> : null}

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
            <div className="project-access-row"><label><span>Task access</span><select value={profileId} onChange={(event) => updateDraft({ profileId: event.target.value, ...(event.target.value === 'sandbox' ? { taskHosts: '' } : {}) })}><option value="sandbox">Sandbox · no network</option><option value="connected">Connected · approved hosts</option><option value="live">Live · approved public internet</option></select></label><label><span>Hosts for this task</span><input disabled={profileId === 'sandbox'} value={taskHosts} onChange={(event) => updateDraft({ taskHosts: event.target.value })} placeholder={selectedProject.networkHosts.length ? selectedProject.networkHosts.join(', ') : 'No hosts approved'} /></label></div>
            <small>RJ may delegate only within each agent’s standing ceiling. Access leases begin during execution and are revoked when the task ends. Jobs run one at a time; up to 32 can wait in the queue.</small>
            {state.projectQueue?.blocked ? <p role="alert">Queue paused because task cleanup needs attention. Inspect the last task’s checkpoint before restarting Chimera.</p> : null}
            <button className="project-primary" type="submit" disabled={!!busy || state.projectQueue?.blocked || !objective.trim()}><Send size={16} />{busy === 'task' ? 'Queuing…' : active ? 'Queue project task' : 'Plan and delegate'}</button>
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
