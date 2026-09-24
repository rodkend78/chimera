import { useEffect, useRef, useState } from 'react'
import { api, post } from './api.js'
import './jev-connection.css'

export function JevConnection() {
  const [status, setStatus] = useState(null)
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null)
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    api('/api/jev/settings').then(result => { if (active.current) setStatus(result) })
      .catch(() => { if (active.current) setMessage({ error: true, text: 'Could not load Jev settings. Check the local Chimera service.' }) })
    return () => { active.current = false }
  }, [])

  const save = async event => {
    event.preventDefault()
    if (busy || !apiKey.trim()) return
    setBusy(true); setMessage(null)
    try {
      const result = await post('/api/jev/settings', { apiKey: apiKey.trim() })
      if (!active.current) return
      setStatus(result); setApiKey('')
      setMessage({ error: false, text: 'Key saved on this machine. Provider access will be checked when a task uses Jev.' })
    } catch {
      if (active.current) setMessage({ error: true, text: 'Save could not be confirmed. Check the connection status before trying again.' })
    } finally { if (active.current) setBusy(false) }
  }

  const disconnect = async () => {
    if (busy) return
    setBusy(true); setMessage(null)
    try {
      const result = await post('/api/jev/disconnect')
      if (!active.current) return
      setStatus(result); setApiKey('')
      setMessage({ error: false, text: 'Jev disconnected and the saved key was removed.' })
    } catch {
      if (active.current) setMessage({ error: true, text: 'Disconnect could not be confirmed. Check the connection status.' })
    } finally { if (active.current) setBusy(false) }
  }

  const refresh = async () => {
    if (busy) return
    try {
      const result = await api('/api/jev/settings')
      if (active.current) { setStatus(result); setMessage(null) }
    } catch {
      if (active.current) setMessage({ error: true, text: 'Could not load Jev settings.' })
    }
  }

  return <article className="jev-connection" aria-labelledby="jev-heading">
    <header><div><span className="card-kicker">Optional decision provider</span><h3 id="jev-heading">TypeSafe Jev</h3></div>
      <span className={`status-chip ${status?.configured ? 'ready' : 'muted'}`}>{status === null ? 'Checking…' : status.configured ? 'Key saved' : 'Not configured'}</span></header>
    <p>Jev helps RJ choose eligible models and specialists, and gives workers bounded Choice, Score, or yes/no decisions. Your execution model still handles writing and tool use.</p>
    <p>Get your own API key from the <a href="https://console.typesafe.ai/" target="_blank" rel="noopener noreferrer">TypeSafe dashboard</a>. Chimera stores it in a private local file and never returns it to the browser after saving. Task text and explicit Jev decision state are sent to TypeSafe when you use this connection.</p>
    <form onSubmit={save}><label htmlFor="jev-api-key">TypeSafe API key</label><div className="jev-key-row">
      <input id="jev-api-key" type="password" autoComplete="new-password" spellCheck="false" value={apiKey}
        onChange={event => setApiKey(event.target.value)} placeholder={status?.configured ? 'Enter a new key to replace the saved key' : 'Paste your own key'} />
      <button type="submit" disabled={busy || !apiKey.trim()}>{busy ? 'Saving…' : status?.configured ? 'Replace key' : 'Save key'}</button>
    </div></form>
    <div className="jev-actions"><button type="button" onClick={refresh} disabled={busy}>Check status</button>
      {status?.configured ? <button type="button" onClick={disconnect} disabled={busy}>Disconnect Jev</button> : null}</div>
    {message ? <p role={message.error ? 'alert' : 'status'} className={message.error ? 'jev-error' : 'jev-success'}>{message.text}</p> : null}
  </article>
}
