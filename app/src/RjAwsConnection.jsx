import { useRef, useState } from 'react'
import { post } from './api.js'
import './rj-aws-connection.css'

function transportLabel(connection) {
  if (!connection?.configured) return 'Not configured'
  return ({
    ready: 'SSH transport ready',
    'auth-required': 'Tailscale authentication required',
    offline: 'Worker offline',
    unknown: 'Transport outcome unknown',
    'not-checked': 'Not checked',
  })[connection.transport?.status] ?? 'Not checked'
}

export function RjAwsConnection({ connection, refresh }) {
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState('')
  const [failed, setFailed] = useState(false)
  const busy = useRef(false)
  const verify = async () => {
    if (busy.current || !connection?.configured) return
    busy.current = true
    setPending(true); setMessage(''); setFailed(false)
    try {
      await post('/api/rj-aws/verify', {})
      await refresh()
      setMessage('Both fixed read-only operations returned pinned signed receipts. The verification task is stored with model:null; no model was called.')
    } catch (error) {
      try { await refresh() } catch {}
      setFailed(true)
      setMessage(error?.message === 'TASK_ALREADY_RUNNING'
        ? 'Verification was not started because another task is active.'
        : 'Execution was not verified. The result may be unknown; Chimera will not replay it automatically. Inspect the verification task evidence before trying again.')
    } finally {
      busy.current = false
      setPending(false)
    }
  }
  const reconcile = async requestId => {
    if (busy.current || !connection?.configured) return
    busy.current = true
    setPending(true); setMessage(''); setFailed(false)
    try {
      await post('/api/rj-aws/reconcile', { requestId })
      await refresh()
      setMessage('The original signed receipt was recovered. Its task was not restarted and no new AWS operation was requested.')
    } catch {
      try { await refresh() } catch {}
      setFailed(true)
      setMessage('The original request could not be reconciled. Its outcome remains unresolved; no replacement execution was requested.')
    } finally { busy.current = false; setPending(false) }
  }
  const executionVerified = connection?.execution?.status === 'verified'
  return <article className="rj-aws-connection" aria-labelledby="rj-aws-heading">
    <header>
      <div><span className="card-kicker">Pinned Tailscale SSH connector</span><h3 id="rj-aws-heading">RJ AWS worker</h3></div>
      <span className={`status-chip ${executionVerified ? 'ready' : 'muted'}`}>{executionVerified ? 'Execution verified' : 'Execution not verified'}</span>
    </header>
    <p>Two fixed read-only operations only: AWS identity and the configured EC2 instance status. Verification never invokes a model and never replays an uncertain request.</p>
    <dl className="rj-aws-status" aria-label="RJ AWS connection status">
      <div><dt>Configuration</dt><dd>{connection?.configured ? 'Pinned worker key configured' : 'Not configured'}</dd></div>
      <div><dt>SSH transport</dt><dd>{transportLabel(connection)}</dd></div>
      <div><dt>Signed execution</dt><dd>{executionVerified ? 'Verified' : connection?.execution?.status === 'unknown' ? 'Unknown' : 'Not verified'}</dd></div>
      {connection?.retention ? <div><dt>Local evidence</dt><dd>{connection.retention.status === 'retained' ? 'Signed evidence retained locally' : connection.retention.status === 'unavailable' ? 'Local evidence unavailable' : 'Not checked'}</dd></div> : null}
      {connection?.audit ? <div><dt>Audit delivery</dt><dd>{connection.audit.status === 'unavailable' ? 'Audit unavailable' : connection.audit.status === 'retained' ? 'Audit retained' : 'Not checked'}</dd></div> : null}
    </dl>
    {connection?.target ? <p className="rj-aws-target"><strong>Fixed target</strong><span>{connection.target.account} · {connection.target.region}</span><code>{connection.target.instanceId}</code></p> : null}
    {connection?.lastReceipt ? <p className="rj-aws-receipt"><strong>Latest signed receipt</strong><span>{connection.lastReceipt.operation} · {connection.lastReceipt.outcome}</span><code>{connection.lastReceipt.requestId}</code></p> : null}
    <button type="button" onClick={verify} disabled={pending || !connection?.configured}>{pending ? 'Verifying signed execution…' : 'Verify signed execution'}</button>
    {connection?.requests?.length ? <section aria-label="Original request evidence">
      <p>Look up an original request, including after restart or expiry. Reconciliation cannot start an unaccepted operation.</p>
      {connection.requests.map(request => <div className="rj-aws-receipt" key={request.requestId}>
        <span>{request.operation} · {request.outcome}</span><code>{request.requestId}</code><small>Task: {request.taskId}</small>
        <button type="button" onClick={() => reconcile(request.requestId)} disabled={pending}>Reconcile original request</button>
      </div>)}
    </section> : null}
    {!connection?.configured ? <small>Add only the reviewed worker public key to local Chimera configuration before this connection becomes available to agents.</small> : null}
    {message ? <p role={failed ? 'alert' : 'status'}>{message}</p> : null}
  </article>
}
