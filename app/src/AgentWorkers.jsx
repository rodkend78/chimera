import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { post } from './api.js'
import { Bot, Clock3, FileText, Monitor, ShieldCheck, Terminal, Users } from './icons.jsx'

const BrowserLiveView = lazy(() => import('bedrock-agentcore/browser/live-view').then((module) => ({ default: module.BrowserLiveView })))

function remaining(expiresAt) {
  const milliseconds = Date.parse(expiresAt) - Date.now()
  if (milliseconds <= 0) return 'Expired'
  const minutes = Math.ceil(milliseconds / 60_000)
  return `${minutes} min remaining`
}
function SessionIcon({ kind }) {
  return kind === 'computer' ? <Monitor size={19} /> : <Terminal size={19} />
}

export function AgentWorkers({ state, refresh, notify }) {
  const workers = state.workers ?? { sessions: [], artifacts: [], limits: {} }
  const agents = useMemo(() => [state.agents.main, ...(state.agents.specialists ?? [])], [state.agents])
  const [agentId, setAgentId] = useState(agents[0]?.agentId ?? 'ceo')
  const [kind, setKind] = useState('code')
  const [ttlSeconds, setTtlSeconds] = useState(900)
  const [busy, setBusy] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const [liveUrl, setLiveUrl] = useState('')
  const selectedAgent = agents.find((agent) => agent.agentId === agentId) ?? agents[0]
  const selectedSession = workers.sessions.find((session) => session.workerSessionId === selectedId)
  const computerAllowed = ['connected', 'live'].includes(selectedAgent?.access?.profileId)
  const activeSessions = workers.sessions.filter((session) => ['starting', 'ready', 'stopping'].includes(session.status))

  useEffect(() => {
    if (!selectedSession || selectedSession.controller.type !== 'human' || selectedSession.status !== 'ready') setLiveUrl('')
  }, [selectedSession?.controller.type, selectedSession?.status, selectedSession?.workerSessionId])

  const run = async (label, operation) => {
    setBusy(label)
    try {
      const result = await operation()
      await refresh()
      return result
    } catch (cause) {
      notify(cause.message.replaceAll('_', ' ').toLowerCase())
      throw cause
    } finally {
      setBusy('')
    }
  }

  const launch = async (event) => {
    event.preventDefault()
    const session = await run('launch', () => post('/api/workers/start', {
      agentId, kind, ttlSeconds,
      ...(kind === 'computer' ? { viewport: { width: 1280, height: 800 } } : {}),
    }))
    setSelectedId(session.workerSessionId)
    notify(`${selectedAgent.displayName} ${kind} worker is ready`)
  }

  const stop = async (session) => {
    await run(`stop:${session.workerSessionId}`, () => post('/api/workers/stop', { workerSessionId: session.workerSessionId }))
    if (selectedId === session.workerSessionId) setLiveUrl('')
    notify(`${session.agentId} worker stopped`)
  }

  const takeControl = async (session) => {
    setSelectedId(session.workerSessionId)
    await run(`control:${session.workerSessionId}`, async () => {
      if (session.controller.type !== 'human') await post('/api/workers/control/take', { workerSessionId: session.workerSessionId })
      const view = await post('/api/workers/live-view', { workerSessionId: session.workerSessionId })
      setLiveUrl(view.url)
    })
    notify('Human control active for this worker')
  }

  const returnControl = async (session) => {
    await run(`control:${session.workerSessionId}`, () => post('/api/workers/control/return', { workerSessionId: session.workerSessionId }))
    setLiveUrl('')
    notify(`Control returned to ${session.agentId}`)
  }

  return (
    <main className="section-region workers-region" aria-labelledby="workers-heading">
      <header className="section-header">
        <div><span className="section-eyebrow">Independent execution</span><h1 id="workers-heading">Agent Workers</h1><p>Launch an isolated AWS machine for one agent. Code workers run shell and files; Computer workers add a live browser that you can take over.</p></div>
        <span className="worker-capacity"><i />{activeSessions.length} / {workers.limits.activeSessions ?? 4} active</span>
      </header>

      <div className="worker-layout">
        <section className="surface-card worker-launch-card">
          <div className="card-heading compact"><span className="worker-card-icon"><Bot size={22} /></span><div><span className="card-kicker">New microVM</span><h2>Launch a worker</h2></div></div>
          <form className="worker-launch-form" onSubmit={launch}>
            <label><span>Agent</span><select value={agentId} onChange={(event) => setAgentId(event.target.value)}>{agents.map((agent) => <option value={agent.agentId} key={agent.agentId}>{agent.displayName}</option>)}</select></label>
            <fieldset><legend>Machine type</legend>
              <button className={kind === 'code' ? 'active' : ''} type="button" onClick={() => setKind('code')}><Terminal size={18} /><span><strong>Code</strong><small>Shell, code & files</small></span></button>
              <button className={kind === 'computer' ? 'active' : ''} type="button" disabled={!computerAllowed} onClick={() => setKind('computer')}><Monitor size={18} /><span><strong>Computer</strong><small>Browser + live control</small></span></button>
            </fieldset>
            <label><span>Automatic teardown</span><select value={ttlSeconds} onChange={(event) => setTtlSeconds(Number(event.target.value))}><option value={300}>5 minutes</option><option value={900}>15 minutes</option><option value={1800}>30 minutes</option><option value={3600}>60 minutes</option></select></label>
            <div className={`worker-boundary ${computerAllowed ? 'connected' : ''}`}><ShieldCheck size={18} /><span><strong>{selectedAgent?.access?.label ?? 'Sandbox'}</strong><small>{computerAllowed ? 'Computer Use enabled · public internet guarded by Chimera policy' : 'Code isolation only · select Connected or Live access on Agents for Computer Use'}</small></span></div>
            <button className="worker-launch" type="submit" disabled={busy === 'launch' || (kind === 'computer' && !computerAllowed)}>{busy === 'launch' ? 'Launching in AWS…' : `Launch ${kind} worker`}</button>
          </form>
        </section>

        <section className="surface-card worker-session-card">
          <div className="card-heading compact"><div><span className="card-kicker">AgentCore fleet</span><h2>Worker sessions</h2></div></div>
          <div className="worker-session-list">
            {workers.sessions.length ? workers.sessions.map((session) => {
              const agent = agents.find((entry) => entry.agentId === session.agentId)
              const active = ['starting', 'ready', 'stopping'].includes(session.status)
              return (
                <article className={`worker-session-row ${selectedId === session.workerSessionId ? 'selected' : ''}`} key={session.workerSessionId}>
                  <button className="worker-session-select" type="button" onClick={() => setSelectedId(session.workerSessionId)}>
                    <span className="worker-kind-icon"><SessionIcon kind={session.kind} /></span>
                    <span><strong>{agent?.displayName ?? session.agentId} · {session.kind}</strong><small><Clock3 size={12} /> {remaining(session.expiresAt)} · {session.artifacts.length} artifacts</small></span>
                  </button>
                  <span className={`status-chip ${session.status === 'ready' ? 'ready' : ''}`}>{session.status}</span>
                  <div className="worker-row-actions">
                    {session.kind === 'computer' && session.status === 'ready' ? <button type="button" disabled={Boolean(busy)} onClick={() => session.controller.type === 'human' ? returnControl(session) : takeControl(session)}>{session.controller.type === 'human' ? <Users size={14} /> : <Monitor size={14} />}{session.controller.type === 'human' ? 'Return to agent' : 'Take control'}</button> : null}
                    {active ? <button className="worker-stop" type="button" disabled={Boolean(busy)} onClick={() => stop(session)}>Stop</button> : null}
                  </div>
                </article>
              )
            }) : <div className="empty-state worker-empty"><Terminal size={27} /><strong>No cloud workers yet</strong><span>Launch a short-lived machine for RJ or a specialist. Chimera will tear it down automatically.</span></div>}
          </div>
        </section>
      </div>

      {selectedSession ? (
        <section className="surface-card worker-inspector">
          <header><div><span className="worker-kind-icon"><SessionIcon kind={selectedSession.kind} /></span><span><strong>{selectedSession.agentId} {selectedSession.kind} worker</strong><small>{selectedSession.controller.type === 'human' ? 'You are controlling this machine' : `${selectedSession.agentId} controls this machine`}</small></span></div><span className="status-chip ready">{selectedSession.status}</span></header>
          {selectedSession.kind === 'computer' ? (
            <div className="worker-live-view">
              {liveUrl ? <Suspense fallback={<div className="worker-view-placeholder"><Monitor size={28} /><span>Connecting to the managed computer…</span></div>}><BrowserLiveView signedUrl={liveUrl} remoteWidth={selectedSession.viewport?.width ?? 1280} remoteHeight={selectedSession.viewport?.height ?? 800} /></Suspense> : <div className="worker-view-placeholder"><Monitor size={34} /><strong>{selectedSession.controller.type === 'human' ? 'Live View URL expired' : 'Agent owns this computer'}</strong><span>{selectedSession.status === 'ready' ? 'Take control to open the interactive browser. Agent automation pauses until you return control.' : 'This worker is no longer active.'}</span>{selectedSession.status === 'ready' ? <button type="button" onClick={() => takeControl(selectedSession)}>{selectedSession.controller.type === 'human' ? 'Reconnect Live View' : 'Take control'}</button> : null}</div>}
            </div>
          ) : <div className="worker-code-summary"><Terminal size={32} /><div><strong>Isolated code environment</strong><span>RJ and this agent can run bounded code, shell commands, and files through the signed harness. Exported files remain in Chimera after teardown.</span></div></div>}
          {selectedSession.artifacts.length ? <div className="worker-artifacts"><span>Retained artifacts</span>{selectedSession.artifacts.map((artifact) => <div key={artifact.artifactId}><FileText size={15} /><span><strong>{artifact.name}</strong><small>{Math.ceil(artifact.bytes / 1024)} KB · SHA-256 {artifact.sha256.slice(0, 10)}…</small></span></div>)}</div> : null}
        </section>
      ) : null}
    </main>
  )
}
