import { useState } from 'react'
import { post } from './api.js'
import './provider-setup.css'

export function ClaudeCodeConnection({ provider, refresh }) {
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState(null)
  const check = async () => {
    if (busy) return
    setBusy(true); setNotice(null)
    try {
      const value = await post('/api/claude-code/refresh', {})
      setNotice(value.configured ? 'Claude Code sign-in found. Sonnet, Opus, and Haiku are available in the model picker.'
        : value.status === 'cli-not-found' ? 'Install Claude Code on this machine, then check again.'
          : value.status === 'cli-update-required' ? 'Update Claude Code to version 2.1.248 or newer, then check again.'
            : 'Run claude auth login in a local terminal, then check again.')
      try { await refresh?.() } catch { setNotice('Sign-in check completed, but the workspace could not refresh. Check status before retrying.') }
    } catch { setNotice('Could not confirm Claude Code status. Check the local CLI before retrying.') }
    finally { setBusy(false) }
  }
  return <article className="provider-setup" aria-labelledby="claude-code-heading">
    <header><div><span className="card-kicker">Local signed-in CLI</span><h3 id="claude-code-heading">Claude Code</h3></div>
      <span className={`status-chip ${provider?.configured ? 'ready' : 'muted'}`}>{provider?.configured ? 'Signed in' : provider?.connectionStatus === 'cli-not-found' ? 'CLI missing' : 'Sign-in needed'}</span></header>
    <p>Use your own Claude Code account on this machine. Chimera offers Sonnet, Opus, and Haiku for RJ, specialists, and Ask when the CLI is signed in.</p>
    <p>Install <a href="https://code.claude.com/docs/en/setup" target="_blank" rel="noopener noreferrer">Claude Code</a>, then run <code>claude auth login</code> in a local terminal. Chimera sends task text through the CLI with tools and customizations disabled; Chimera’s own approval and tool flow remains in control.</p>
    <div className="provider-setup-actions"><button type="button" disabled={busy} onClick={check}>{busy ? 'Checking…' : 'Check Claude Code sign-in'}</button></div>
    <small>Checking sign-in does not run a model. An inference test may use your Claude quota.</small>
    {notice ? <p role="status">{notice}</p> : null}
  </article>
}
