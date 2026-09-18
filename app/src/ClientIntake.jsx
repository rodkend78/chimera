import { useEffect, useRef, useState } from 'react'
import { api, post } from './api.js'
import './client-intake.css'

const EMPTY = { name: '', email: '', services: '', summary: '' }
const POLL_LIMIT = 300
const newRequestId = () => `manual-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`

function message(error, action) {
  const detail = String(error?.message ?? 'Request failed').replaceAll('_', ' ')
  return `${action} not confirmed. ${detail}.`
}

function validStatus(value) {
  return value && typeof value === 'object' && value.connection && value.schedule && value.sync && Array.isArray(value.queue)
}

function formatTime(value) {
  if (!value) return 'Never'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
}

function Brief({ brief }) {
  if (!brief || typeof brief !== 'object') return <p>Brief details unavailable.</p>
  return <dl className="client-intake-brief">
    <div><dt>Business</dt><dd>{String(brief.businessName ?? '')}</dd></div>
    <div><dt>Contact</dt><dd>{String(brief.contactEmail ?? '')}</dd></div>
    <div><dt>Services</dt><dd>{Array.isArray(brief.services) ? brief.services.map(String).join(', ') : ''}</dd></div>
    <div><dt>Summary</dt><dd>{String(brief.summary ?? '') || 'No summary supplied.'}</dd></div>
    <div><dt>Constraints</dt><dd>{Array.isArray(brief.constraints) ? brief.constraints.map(String).join(' ') : 'No constraints supplied.'}</dd></div>
  </dl>
}

export function ClientIntake({ onChanged = () => {} }) {
  const [status, setStatus] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState(EMPTY)
  const [requestId, setRequestId] = useState(newRequestId)
  const [lastRequestId, setLastRequestId] = useState('')
  const pending = useRef(new Set())
  const pollCount = useRef(0)
  const generation = useRef(0)

  const accept = value => {
    if (!validStatus(value)) throw new Error('CLIENT_INTAKE_STATUS_INVALID')
    setStatus(value); setError(''); return value
  }
  const refresh = async (expected = generation.current) => {
    const value = await api('/api/client-intake', { cache: 'no-store' })
    if (expected !== generation.current) return null
    return accept(value)
  }
  useEffect(() => {
    const expected = generation.current
    refresh(expected).catch(err => { if (expected === generation.current) setError(message(err, 'Intake status')) })
    return () => { generation.current++ }
  }, [])
  useEffect(() => {
    if (status?.connection?.state !== 'authorizing' || pollCount.current >= POLL_LIMIT) return
    const timer = setTimeout(() => {
      pollCount.current++
      const expected = generation.current
      refresh(expected).catch(err => { if (expected === generation.current) setError(message(err, 'Authorization status')) })
    }, 1000)
    return () => clearTimeout(timer)
  }, [status])

  const mutation = async (key, action, changed = true) => {
    if (pending.current.has(key)) return
    pending.current.add(key); generation.current++; setBusy(key); setError('')
    try {
      const value = await action()
      if (validStatus(value)) accept(value); else await refresh()
      if (changed) await onChanged()
      return value
    } catch (err) { setError(message(err, key === 'create' ? 'Save' : 'Action')); throw err }
    finally { pending.current.delete(key); setBusy('') }
  }
  const save = async event => {
    event.preventDefault()
    if (pending.current.has('create')) return
    if (!draft.name.trim() || !draft.email.trim() || !draft.services.trim()) return
    try {
      await mutation('create', async () => {
        const created = await post('/api/client-intake/clients', { requestId, name: draft.name, email: draft.email, services: draft.services.split(',').map(value => value.trim()).filter(Boolean), summary: draft.summary })
        if (!created?.client || typeof created.client.id !== 'string') throw new Error('CLIENT_CREATE_RESPONSE_INVALID')
        return created
      })
      setLastRequestId(requestId); setRequestId(newRequestId()); setDraft(EMPTY); setAdding(false)
    } catch { /* Error is rendered and the draft/request identity stay intact. */ }
  }
  const connect = () => mutation('connect', async () => { pollCount.current = 0; return post('/api/client-intake/connect') }, false).catch(() => {})
  const disconnect = () => mutation('disconnect', () => post('/api/client-intake/disconnect'), false).catch(() => {})
  const sync = () => mutation('sync', () => post('/api/client-intake/sync')).catch(() => {})
  const handoff = id => mutation(`handoff:${id}`, () => post('/api/client-intake/handoff', { id })).catch(() => {})

  return <section className="client-intake" aria-labelledby="client-intake-heading">
    <div className="client-intake-heading"><div><span className="section-eyebrow">Capture and queue</span><h2 id="client-intake-heading">Client intake</h2></div><div className="client-intake-actions"><button type="button" onClick={() => setAdding(value => !value)}>Add client</button><button type="button" onClick={() => refresh().catch(err => setError(message(err, 'Refresh')))} disabled={Boolean(busy)}>Refresh intake</button></div></div>
    {error ? <p role="alert" className="client-intake-error">{error}</p> : null}
    {!status && !error ? <p role="status">Loading client intake…</p> : null}
    {status ? <>
      <div className="client-intake-status">
        <div><strong>Google connection</strong><span>{status.connection.state}</span><p>{status.connection.account ?? status.connection.setupMessage ?? 'No account connected.'}</p>{status.connection.state === 'authorizing' ? <p role="status">Complete Google consent in the system browser. Chimera will check the result for a limited time.</p> : null}</div>
        <div><strong>Capture schedule</strong><span>{status.schedule.time} {status.schedule.timeZone}</span><p>Next check: {formatTime(status.schedule.nextCheckAt)}</p></div>
        <div><strong>Source status</strong><span>{status.sync.running ? 'Checking now' : 'Idle'}</span><p>Last attempt: {formatTime(status.sync.lastAttemptAt)}<br />Last successful check: {formatTime(status.sync.lastSuccessAt)}</p>{status.sync.error ? <p role="alert">{String(status.sync.error).replaceAll('_', ' ')}</p> : null}</div>
      </div>
      <div className="client-intake-actions">
        {['setup_required', 'disconnected', 'error'].includes(status.connection.state) ? <button type="button" onClick={connect} disabled={Boolean(busy)}>{busy === 'connect' ? 'Connecting…' : 'Connect Google'}</button> : null}
        {['connected', 'authorizing'].includes(status.connection.state) ? <button type="button" onClick={disconnect} disabled={Boolean(busy)}>{busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect Google'}</button> : null}
        <button type="button" onClick={sync} disabled={Boolean(busy) || status.connection.state === 'authorizing'}>{busy === 'sync' || status.sync.running ? 'Checking…' : 'Check now'}</button>
      </div>
      <section aria-label="Build brief queue"><h3>Build brief queue</h3>{status.queue.length ? <ul className="client-intake-queue">{status.queue.map(row => <li key={row.id}><header><strong>{String(row.clientName ?? 'Unnamed client')}</strong><span>{String(row.status ?? 'unknown').replaceAll('_', ' ')}</span></header><Brief brief={row.brief} />{Array.isArray(row.issues) && row.issues.length ? <p>Review issues: {row.issues.map(String).join(', ')}</p> : null}{row.status === 'ready' ? <div className="client-intake-handoff"><p><strong>Warning:</strong> Handing this brief to RJ may start paid model work. It does not authorize publishing, payments, or external communication.</p><button type="button" disabled={Boolean(busy)} onClick={() => handoff(row.id)}>{busy === `handoff:${row.id}` ? 'Handing off…' : 'Hand off to RJ'}</button></div> : row.status === 'handed_off' ? <p role="status">Handed off to RJ · task {String(row.taskId ?? '')}</p> : <p>Operator review is required before handoff.</p>}</li>)}</ul> : <p>No build briefs are queued.</p>}</section>
    </> : null}
    {adding ? <form onSubmit={save} className="client-intake-form"><fieldset disabled={busy === 'create'}><legend>Add a client manually</legend><label>Business name<input required maxLength={200} value={draft.name} onChange={event => setDraft(current => ({ ...current, name: event.target.value }))} /></label><label>Contact email<input required type="email" maxLength={254} value={draft.email} onChange={event => setDraft(current => ({ ...current, email: event.target.value }))} /></label><label>Services<input required maxLength={4000} placeholder="Website, SEO/AIO, AI Receptionist" value={draft.services} onChange={event => setDraft(current => ({ ...current, services: event.target.value }))} /></label><label>Project summary<textarea rows={4} maxLength={32000} value={draft.summary} onChange={event => setDraft(current => ({ ...current, summary: event.target.value }))} /></label><span data-testid="manual-request-id" data-request-id={requestId} className="client-intake-request">Retry identity retained until creation is confirmed.</span><button type="submit" disabled={busy === 'create'}>{busy === 'create' ? 'Saving…' : 'Save client'}</button></fieldset></form> : null}
    <span hidden data-testid="last-request-id" data-request-id={lastRequestId} />
  </section>
}
