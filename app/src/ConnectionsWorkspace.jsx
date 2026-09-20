import { useEffect, useRef, useState } from 'react'
import { api, post } from './api.js'
import { Activity, ArrowRight, RefreshCw, ShieldCheck } from './icons.jsx'

function requestId() {
  // The model stays in the signed request intent; the transport id itself is
  // deliberately fixed-width so long catalog ids cannot exceed the durable
  // receipt bound or be truncated into an accidental collision.
  return `connection-test-${crypto.randomUUID()}`
}

const RECOVERY_STORAGE_KEY = 'chimera.connection-recovery.v1'

function safeRecovery(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.providerId !== 'string' || typeof value.requestId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value.providerId)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value.requestId)) return null
  return { providerId: value.providerId, requestId: value.requestId }
}

function readRecovery() {
  try { return safeRecovery(JSON.parse(sessionStorage.getItem(RECOVERY_STORAGE_KEY) ?? 'null')) } catch { return null }
}

function writeRecovery(value) {
  try {
    if (value) sessionStorage.setItem(RECOVERY_STORAGE_KEY, JSON.stringify(value))
    else sessionStorage.removeItem(RECOVERY_STORAGE_KEY)
  } catch { /* session storage is only a remount aid; the server receipt is authoritative */ }
}

function statusText(connection) {
  if (connection.verification?.status === 'passed' && connection.status === 'verified') return 'Verified for this machine and revision'
  if (connection.verification?.status === 'failed') return 'Last test failed; inspect the reason before retrying'
  if (connection.verification?.status === 'unknown') return 'Outcome unknown; inspect the receipt before retrying'
  if (connection.status === 'available') return 'Catalog available; inference not verified'
  return connection.status.replaceAll('-', ' ')
}

export function ConnectionsWorkspace({ connections = [], returnTarget = null, onReturn, refresh, modelProviders = [], children = null }) {
  const [busy, setBusy] = useState(null)
  const [notice, setNotice] = useState(null)
  const [models, setModels] = useState({})
  const [unknownRequest, setUnknownRequest] = useState(readRecovery)
  const locks = useRef(new Set())
  const requestIds = useRef(new Map())
  const rows = connections.length ? connections : modelProviders.map(provider => ({
    providerId: provider.id,
    status: provider.configured ? 'available' : 'not-connected',
    enabled: provider.configured !== false,
    revision: 0,
    catalogAvailable: (provider.models ?? []).length > 0,
    provenance: { machineRef: null, accountRef: null, signedIn: provider.configured === true },
    operations: { 'test-model': false, refresh: true, connect: false, reconnect: false, disconnect: false },
    verification: null,
    error: null,
    _provider: provider,
  }))
  const requestFor = (connection, operation, model = undefined) => {
    if (operation !== 'test-model') return `connection-${operation}-${connection.providerId}-${crypto.randomUUID()}`
    const key = `${connection.providerId}:${connection.revision}:${model ?? ''}`
    const known = connection.verification?.operation === 'test-model'
      && connection.verification.model === model
      && connection.verification.revision === connection.revision
      && connection.verification.requestId
    if (known) return connection.verification.requestId
    if (!requestIds.current.has(key)) requestIds.current.set(key, requestId(connection.providerId, model))
    return requestIds.current.get(key)
  }
  const rememberUnknown = value => {
    const safe = safeRecovery(value)
    if (!safe) return
    setUnknownRequest(safe)
    writeRecovery(safe)
  }
  useEffect(() => {
    if (unknownRequest) return
    const durable = connections.find(connection => ['unknown', 'pending'].includes(connection.verification?.status)
      && safeRecovery({ providerId: connection.providerId, requestId: connection.verification.requestId }))
    if (durable?.verification?.requestId) rememberUnknown({ providerId: durable.providerId, requestId: durable.verification.requestId })
  }, [connections, unknownRequest])
  const lookupReceipt = async () => {
    if (!unknownRequest) return
    const key = `receipt:${unknownRequest.providerId}:${unknownRequest.requestId}`
    setBusy(key)
    try {
      const query = new URLSearchParams({ providerId: unknownRequest.providerId, requestId: unknownRequest.requestId })
      const result = await api(`/api/connections/receipt?${query.toString()}`)
      const unresolved = result.receipt?.status === 'unknown' || result.receipt?.status === 'pending'
      if (!unresolved) { setUnknownRequest(null); writeRecovery(null) }
      setNotice({ type: unresolved ? 'error' : 'success', text: unresolved ? 'The durable receipt is still unresolved. Do not resubmit this request.' : `Saved receipt: ${result.receipt?.status ?? 'unknown'}.` })
    } catch (error) {
      const text = String(error?.message ?? error).replaceAll('_', ' ').toLowerCase()
      setNotice({ type: 'error', text: `${text}. No request was retried.` })
    } finally { setBusy(null) }
  }
  const act = async (connection, operation, model = undefined) => {
    const key = `${connection.providerId}:${operation}:${model ?? ''}`
    if (locks.current.has(key)) return
    if (operation === 'test-model' && !window.confirm(`Run one inference-only test for ${connection.providerId} · ${model}? This may use provider quota.`)) return
    locks.current.add(key); setBusy(key); setNotice(null)
    const actionRequestId = requestFor(connection, operation, model)
    const body = { providerId: connection.providerId, operation, requestId: actionRequestId, expectedRevision: connection.revision, ...(model ? { model } : {}), ...(operation === 'test-model' ? { allowQuotaUse: true } : {}) }
    let accepted = false
    let unresolved = false
    try {
      const result = await post('/api/connections/action', body)
      const returnedReceipt = result?.receipt
      if (!returnedReceipt || typeof returnedReceipt.requestId !== 'string'
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(returnedReceipt.requestId)
        || !['succeeded', 'failed', 'unknown'].includes(returnedReceipt.status)) {
        throw Object.assign(new Error('CONNECTION_ACKNOWLEDGEMENT_INVALID'), { code: 'CONNECTION_ACKNOWLEDGEMENT_INVALID', ambiguous: true })
      }
      accepted = true
      unresolved = result.receipt?.status === 'unknown' || result.receipt?.status === 'failed'
      if (result.receipt?.status === 'unknown') rememberUnknown({ providerId: connection.providerId, requestId: result.receipt?.requestId ?? actionRequestId })
      setNotice({ type: unresolved ? 'error' : 'success', text: result.receipt?.status === 'unknown' ? 'Outcome unknown. Inspect the receipt before retrying; nothing was resubmitted.' : result.receipt?.status === 'failed' ? 'The operation failed. Inspect the saved evidence before retrying.' : `${operation.replaceAll('-', ' ')} accepted for ${connection.providerId}.` })
      try {
        const refreshed = await refresh?.()
        if (refreshed === false && !unresolved) setNotice({ type: 'success', text: `${operation.replaceAll('-', ' ')} accepted for ${connection.providerId}; the latest workspace state could not be confirmed. Do not resend.` })
      } catch (refreshError) {
        if (!unresolved) setNotice({ type: 'success', text: `${operation.replaceAll('-', ' ')} accepted for ${connection.providerId}; refresh failed, so the displayed status may be stale. Do not resend.` })
      }
    } catch (error) {
      const text = String(error?.message ?? error).replaceAll('_', ' ').toLowerCase()
      const receipt = safeRecovery(error.receipt)
      const unresolvedOutcome = Boolean(error.ambiguous || error.reconciliationRequired || receipt)
      if (unresolvedOutcome) rememberUnknown({ providerId: receipt?.providerId ?? connection.providerId, requestId: receipt?.requestId ?? actionRequestId })
      setNotice({ type: accepted ? 'success' : 'error', text: accepted
        ? `${operation.replaceAll('-', ' ')} accepted for ${connection.providerId}; refresh failed, so the displayed status may be stale. Do not resend.`
        : unresolvedOutcome
          ? 'Outcome unconfirmed. Inspect the saved receipt before retrying; no request was resubmitted.'
          : text })
    } finally { locks.current.delete(key); setBusy(null) }
  }
  return (
    <main className="section-region connections-region" aria-labelledby="connections-workspace-heading">
      <header className="connections-workspace-header"><div><span className="card-kicker">Provider control plane</span><h2 id="connections-workspace-heading">Connections</h2><p>Each row reports durable status, account binding, revision, and evidence. Catalog availability is not an inference check.</p></div>{onReturn ? <button type="button" onClick={onReturn}><ArrowRight size={15} />{returnTarget ? `Return to ${returnTarget.label ?? 'setup'}` : 'Return'}</button> : null}</header>
      {notice ? <p className={`connections-notice ${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'}>{notice.text}</p> : null}
      {unknownRequest ? <button type="button" className="connection-receipt-lookup" onClick={lookupReceipt} disabled={Boolean(busy)}>Check saved receipt for {unknownRequest.requestId}</button> : null}
      <div className="connection-workspace-list">{rows.map(connection => {
        const provider = connection._provider ?? modelProviders.find(item => item.id === connection.providerId)
        const candidates = provider?.models?.filter(model => model.capabilities?.includes('conversation')) ?? []
        const selected = models[connection.providerId] ?? candidates[0]?.id ?? ''
        const testKey = `${connection.providerId}:test-model:${selected}`
        return <article className="connection-workspace-card" key={connection.providerId}>
          <div className="connection-workspace-card-heading"><div className="connection-status-icon">{connection.status === 'verified' ? <ShieldCheck size={18} /> : connection.status === 'needs-attention' ? <Activity size={18} /> : <RefreshCw size={17} />}</div><div><h3>{provider?.name ?? connection.providerId}</h3><p>{statusText(connection)}</p></div><span className={`status-chip ${connection.status === 'verified' ? 'ready' : 'muted'}`}>{connection.status}</span></div>
          <dl className="connection-facts"><div><dt>Machine</dt><dd>{connection.provenance?.machineRef ?? 'Not bound'}</dd></div><div><dt>Account</dt><dd>{connection.provenance?.accountRef ?? 'Not exposed'}</dd></div><div><dt>Session</dt><dd>{connection.provenance?.sessionStatus ?? 'Not exposed'}</dd></div><div><dt>Revision</dt><dd>{connection.revision}</dd></div><div><dt>Signed in</dt><dd>{connection.provenance?.signedIn ? 'Yes' : 'No'}</dd></div><div><dt>Evidence</dt><dd>{connection.verification ? `${connection.verification.status ?? 'unknown'}${connection.verification.model ? ` · ${connection.verification.model}` : ''}` : 'None recorded'}</dd></div></dl>
          {candidates.length && connection.operations?.['test-model'] ? <div className="connection-test-controls"><label>Test model<select value={selected} onChange={event => setModels(current => ({ ...current, [connection.providerId]: event.target.value }))}>{candidates.map(model => <option key={model.id} value={model.id}>{model.name ?? model.id}</option>)}</select></label><button type="button" className="primary-action" onClick={() => act(connection, 'test-model', selected)} disabled={busy === testKey}>{busy === testKey ? 'Testing…' : 'Test inference'}</button></div> : null}
          <div className="connection-actions">{['connect', 'refresh', 'reconnect', 'disconnect'].filter(operation => connection.operations?.[operation]).map(operation => <button key={operation} type="button" onClick={() => act(connection, operation)} disabled={Boolean(busy)}>{operation.replaceAll('-', ' ')}</button>)}</div>
        </article>
      })}</div>
      {children ? <section className="connection-specialized-controls" aria-label="Specialized connection controls">{children}</section> : null}
    </main>
  )
}
