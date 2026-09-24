import { useEffect, useRef, useState } from 'react'
import { api, post } from './api.js'
import './provider-setup.css'

export function OpenRouterConnection({ refresh }) {
  const [status, setStatus] = useState(null)
  const [apiKey, setApiKey] = useState('')
  const [models, setModels] = useState('openrouter/free')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    api('/api/openrouter/settings').then(value => {
      if (mounted.current) { setStatus(value); setModels(value.models.join('\n')) }
    }).catch(() => { if (mounted.current) setNotice({ error: true, text: 'Could not load OpenRouter settings.' }) })
    return () => { mounted.current = false }
  }, [])
  const save = async event => {
    event.preventDefault()
    if (busy) return
    const selected = models.split('\n').map(value => value.trim()).filter(Boolean)
    if (!selected.length || (!apiKey.trim() && !status?.configured)) {
      setNotice({ error: true, text: 'Enter your API key and at least one model ID.' }); return
    }
    setBusy(true); setNotice(null)
    try {
      const next = await post('/api/openrouter/settings', { ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), models: selected })
      if (!mounted.current) return
      setStatus(next); setApiKey(''); setModels(next.models.join('\n'))
      setNotice({ error: false, text: 'Saved on this machine. Select a model in Team or run an inference test to verify access.' })
      try { await refresh?.() } catch {
        if (mounted.current) setNotice({ error: false, text: 'Key saved, but the workspace could not refresh. Check connection status before retrying.' })
      }
    } catch {
      if (mounted.current) setNotice({ error: true, text: 'Save could not be confirmed. Check the connection status before trying again.' })
    } finally { if (mounted.current) setBusy(false) }
  }
  const disconnect = async () => {
    if (busy) return
    setBusy(true); setNotice(null)
    try {
      const next = await post('/api/openrouter/disconnect', {})
      if (!mounted.current) return
      setStatus(next); setApiKey(''); setModels(next.models.join('\n'))
      setNotice({ error: false, text: 'The saved key was removed. New OpenRouter calls are disabled.' })
      try { await refresh?.() } catch {
        if (mounted.current) setNotice({ error: false, text: 'Key removed, but the workspace could not refresh. Check connection status before retrying.' })
      }
    } catch {
      if (mounted.current) setNotice({ error: true, text: 'Disconnect could not be confirmed. Check the connection status.' })
    } finally { if (mounted.current) setBusy(false) }
  }
  return <article className="provider-setup" aria-labelledby="openrouter-heading">
    <header><div><span className="card-kicker">Bring your own key</span><h3 id="openrouter-heading">OpenRouter</h3></div>
      <span className={`status-chip ${status?.configured ? 'ready' : 'muted'}`}>{status === null ? 'Checking…' : status.configured ? 'Key saved' : 'Not configured'}</span></header>
    <p>Connect your own OpenRouter key and choose the model IDs to show in Chimera. The default <code>openrouter/free</code> uses OpenRouter’s free model router; other model IDs may use paid credits.</p>
    <p>Chimera stores the key in a private local file and sends task text to OpenRouter only when you use its models. Saving a key does not test inference or quota.</p>
    <form onSubmit={save}>
      <label htmlFor="openrouter-key">OpenRouter API key</label>
      <input id="openrouter-key" type="password" autoComplete="new-password" spellCheck="false" value={apiKey}
        onChange={event => setApiKey(event.target.value)} placeholder={status?.configured ? 'Leave blank to keep saved key' : 'Paste your own key'} />
      <label htmlFor="openrouter-models">Model IDs, one per line</label>
      <textarea id="openrouter-models" rows="3" spellCheck="false" value={models} onChange={event => setModels(event.target.value)} />
      <div className="provider-setup-actions"><button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save connection'}</button>
        {status?.configured ? <button type="button" disabled={busy} onClick={disconnect}>Disconnect OpenRouter</button> : null}</div>
    </form>
    <small>Get a key and model IDs from <a href="https://openrouter.ai/settings/keys" target="_blank" rel="noopener noreferrer">OpenRouter</a>. Keys are never returned to this page after saving.</small>
    {notice ? <p role={notice.error ? 'alert' : 'status'}>{notice.text}</p> : null}
  </article>
}
