import { useEffect, useRef, useState } from 'react'
import { post } from './api.js'
import './antigravity-connection.css'

const ERRORS = {
  ANTIGRAVITY_ACCOUNT_MODE_REQUIRED: 'Antigravity CLI is configured for API billing. Switch it to your signed-in account in Antigravity before connecting. Chimera will not change your settings.',
  ANTIGRAVITY_CLI_UPDATE_REQUIRED: 'Update Antigravity CLI to a version supporting streaming input and custom agents, then check again.',
  ANTIGRAVITY_CATALOG_UNAVAILABLE: 'Could not load a model catalog. Open Antigravity, complete account sign-in, then check again.',
  ANTIGRAVITY_HOOKS_REQUIRE_REVIEW: 'Global Antigravity startup hooks need review before unattended delegation.',
  ANTIGRAVITY_HANDSHAKE_INVALID: 'Could not verify the CLI session. Check Antigravity before trying again; no prompt was sent.',
  ANTIGRAVITY_MODEL_MISMATCH: 'The CLI did not confirm the selected model at startup. No prompt was sent.',
}

export function AntigravityConnection({ provider, refresh }) {
  const [pending, setPending] = useState(null)
  const [message, setMessage] = useState('')
  const busy = useRef(false), mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const act = async action => {
    if (busy.current) return
    busy.current = true
    setPending(action); setMessage('')
    try {
      const result = await post(`/api/antigravity/${action}`, {})
      if (action === 'refresh') {
        await refresh()
        if (mounted.current) setMessage(result.error ? ERRORS[result.error] ?? 'Antigravity is unavailable. Check the local app and CLI, then try again.' : 'Models loaded. Open Team, choose the agent’s model, and select Only use this model to prevent fallback.')
      } else if (mounted.current) setMessage('Launch requested. Antigravity opens in a separate desktop window; no task was started. Complete sign-in there if needed.')
    } catch {
      if (mounted.current) setMessage(action === 'open'
        ? 'Launch not confirmed. Check the Antigravity app before trying again; Chimera will not retry automatically.'
        : 'Connection check failed. Your previous model selection was not changed.')
    } finally {
      busy.current = false
      if (mounted.current) setPending(null)
    }
  }
  return <article className="antigravity-connection" aria-labelledby="antigravity-heading">
    <header><div><span className="card-kicker">Operator-managed native executor</span><h3 id="antigravity-heading">Antigravity</h3></div>
      <span className={`status-chip ${provider?.authenticated ? 'ready' : 'muted'}`}>{provider?.authenticated ? 'Tested successfully' : provider?.configured ? 'Available to select' : 'Not connected'}</span></header>
    <p>Use your signed-in Antigravity account on this machine. No API-key fallback. Model discovery does not prove a working model session or available quota.</p>
    <p>Available to RJ and every specialist through their model picker. Native tools use your Antigravity CLI permissions, not Chimera’s Sandbox or network limits. CLI permission settings may differ from the desktop app. Chimera does not auto-approve requests.</p>
    {provider?.configured ? <p>Go to Team and use the model dropdown on an agent’s card. The list below is a catalog, not a picker.</p> : null}
    {provider?.models?.length ? <details><summary>View available models ({provider.models.length})</summary><ul aria-label="Antigravity models">{provider.models.map(model => <li key={model.id}>{model.name}</li>)}</ul></details> : null}
    {provider?.error ? <p role="alert">{ERRORS[provider.error] ?? 'Check the installed Antigravity app and CLI before trying again.'}</p> : null}
    <div className="antigravity-actions">
      <button type="button" disabled={pending !== null} onClick={() => act('refresh')}>{pending === 'refresh' ? 'Finding models…' : 'Find Antigravity models'}</button>
      <button type="button" disabled={pending !== null} onClick={() => act('open')}>{pending === 'open' ? 'Opening…' : 'Open Antigravity app'}</button>
    </div>
    <small>Native work can change files or use the network when Antigravity permits it. Project tasks receive their task worktree; other work uses a private retained folder. Inspect partial work before retrying failures. Desktop launch opens a separate window.</small>
    <small>If a task reports ANTIGRAVITY_PERMISSION_REQUIRED, review the CLI’s /permissions settings for the specific task folder or action, then submit it again. Chimera will not change those rules or retry the task automatically.</small>
    {message ? <p role="status">{message}</p> : null}
  </article>
}
