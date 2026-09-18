import { useEffect, useRef, useState } from 'react'
import { api, post } from './api.js'

const empty = { status: 'checking', pendingPairs: [], profiles: [], leases: [] }
const terminal = status => ({ human: 'Stopped', expired: 'Expired', restarted: 'Restarted', disconnected: 'Disconnected', cancelled: 'Cancelled', navigation: 'Page changed' }[status] ?? 'Unavailable')

export function AccountCompanion() {
  const [state, setState] = useState(empty)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(false)
  const busy = useRef(false), mounted = useRef(false), loaded = useRef(false)
  async function request(path = null, body = null) {
    if (busy.current) return
    busy.current = true; setPending(true); setError(false)
    try {
      const result = path ? await post(`/api/account-companion/${path}`, body) : await api('/api/account-companion/state', { cache: 'no-store' })
      if (mounted.current) setState(result)
    } catch { if (mounted.current) setError(true) }
    finally { busy.current = false; if (mounted.current) setPending(false) }
  }
  useEffect(() => {
    mounted.current = true
    if (!loaded.current) { loaded.current = true; void request() }
    return () => { mounted.current = false }
  }, [])
  return <section className="account-companion" aria-labelledby="account-companion-title" aria-busy={pending}>
    <header><div><span className="account-browser__eyebrow">Explicit document sharing</span><h2 id="account-companion-title">Share with a task</h2></div>
      <button type="button" disabled={pending} onClick={() => request()}>Refresh sharing</button></header>
    {error ? <p role="alert">Sharing status is unconfirmed. Refresh to check the current state before trying again.</p> : null}
    {state.status === 'checking' ? <p role="status">Checking companion…</p> : null}
    {state.status === 'not-installed' ? <div className="account-companion__setup"><h3>Companion not installed</h3><strong>Agent access unavailable</strong>
      <p>Prepare the companion using the setup instructions in docs/BROWSER_CONTRACT.md. Load the prepared extension in Chrome, then approve its pairing here. Installation is an explicit local step.</p></div> : null}
    {state.status === 'unavailable' ? <p role="status">Companion unavailable. Check its prepared configuration and private socket, then restart the runtime explicitly. Chrome remains yours to use.</p> : null}
    {state.status === 'available' ? <>
      <p>Ask an eligible task participant to read your shared page. Its wait lasts up to 60 seconds. In Chrome, choose that task and agent and click Share this tab. Shared visible text goes to the agent’s configured model/provider, which may be remote. Sign-in and account recovery remain human-only.</p>
      {!state.profiles.length && !state.pendingPairs.length ? <p role="status">Not paired. Open the companion in Chrome to request pairing.</p> : null}
      {state.pendingPairs.map(pair => <article key={pair.pairingId} className="account-companion__item">
        <strong>Pairing requested</strong><span>Pairing ID: {pair.pairingId}</span><span>Profile: {pair.profileId}</span>
        <p>Compare this Pairing ID with the companion popup you just opened. Approve only an exact match.</p>
        {pair.approved ? <p role="status">Approval recorded. Complete pairing in Chrome.</p> : <button type="button" disabled={pending} onClick={() => request('pair/approve', { pairingId: pair.pairingId })}>Approve pairing</button>}
      </article>)}
      {state.profiles.map(profile => <article key={profile.profileId} className="account-companion__item">
        <strong>{profile.status === 'paired' ? (state.leases.some(lease => lease.profileId === profile.profileId && lease.status === 'active') ? 'Paired' : 'Paired · No shared tabs') : 'Disconnected'}</strong>
        <span>Profile: {profile.profileId}</span>
        {profile.status === 'paired' ? <button type="button" disabled={pending} onClick={() => request('pair/revoke', { profileId: profile.profileId })}>Revoke pairing</button> : null}
      </article>)}
      {state.leases.map(lease => <article key={lease.leaseId} className="account-companion__item">
        <strong>{lease.status === 'active' ? 'Shared read-only' : terminal(lease.status)}</strong>
        <span>{lease.origin}</span><span>Task: {lease.taskId} · Agent: {lease.agentId}</span>
        {lease.expiresAt ? <span>Expires: {new Date(lease.expiresAt).toLocaleString()}</span> : null}
        {lease.status === 'active' ? <button type="button" disabled={pending} onClick={() => request('lease/revoke', { leaseId: lease.leaseId })}>Stop sharing</button> : null}
      </article>)}
    </> : null}
  </section>
}
