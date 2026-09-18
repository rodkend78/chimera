import { useRef, useState } from 'react'
import './operator-recovery.css'

export function OperatorRecovery({ error, onRetry }) {
  const [checking, setChecking] = useState(false)
  const pending = useRef(false)
  const message = String(error || '')
  const needsSignIn = /operator[ _](auth[ _]required|bootstrap[ _]invalid|session[ _]expired|csrf[ _]invalid)/i.test(message)
  const retry = async () => {
    if (pending.current) return
    pending.current = true
    setChecking(true)
    try {
      // App.refresh performs authenticated reads and owns the visible error.
      // It never restarts the service, issues a launch link, or replays a task.
      await onRetry()
    } finally {
      pending.current = false
      setChecking(false)
    }
  }
  return <main className="loading-screen operator-recovery">
    <div className="loading-mark" aria-hidden="true">C</div>
    <strong>CHIMERA</strong>
    {!message ? <p role="status">Starting secure browser workspace…</p> : <section className="operator-recovery-card" aria-labelledby="operator-recovery-title" aria-busy={checking}>
      <span className="operator-recovery-eyebrow">{needsSignIn ? 'Secure workspace access' : 'Workspace connection'}</span>
      <h1 id="operator-recovery-title">{needsSignIn ? 'Sign in to your workspace' : 'Cannot reach your workspace'}</h1>
      <p>{needsSignIn
        ? 'Your operator session is missing or has expired. Open a fresh secure launch link from Chimera’s trusted local launcher in this browser.'
        : 'Chimera has not returned a usable workspace. Check that the local service is running, then try the connection again.'}</p>
      {needsSignIn ? <p>This is your Chimera workspace sign-in, not your ChatGPT, Google, or model-provider account.</p> : null}
      <button type="button" className="operator-recovery-retry" onClick={retry} disabled={checking}>
        {checking ? 'Checking sign-in…' : needsSignIn ? 'Check sign-in again' : 'Try connection again'}
      </button>
      <p className="operator-recovery-note" role="status">{checking ? 'Checking your existing session… ' : ''}This check does not restart Chimera or resubmit work.</p>
      <details className="operator-recovery-help">
        <summary>Device recovery steps</summary>
        <ol>
          <li>On the computer running Chimera, open a terminal in the Chimera project and check <code>npm run pilot:status</code>.</li>
          <li>If the service is stopped, <code>npm run pilot:up</code> starts it and prints a short-lived secure launch link.</li>
          <li>If it is running but your sign-in has expired, the current pilot needs a controlled <code>npm run pilot:restart</code> to print a new link. Check active work and pending approvals before restarting. Starting or restarting can use configured metered services; confirm authorization first.</li>
          <li>Open the new link in the browser you want to use. Do not share it or paste it into a task. Then return here and check sign-in again if needed.</li>
        </ol>
      </details>
      <details className="operator-recovery-help">
        <summary>Connection details</summary>
        <code>{message.slice(0, 500)}</code>
      </details>
    </section>}
  </main>
}
