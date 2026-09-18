import { useEffect, useRef, useState } from 'react'
import { api, post } from './api.js'
import { AccountCompanion } from './AccountCompanion.jsx'
import './account-browser.css'

const DESTINATIONS = [
  { label: 'Browser home', detail: 'Start with a neutral Chrome page.', url: 'https://www.google.com/' },
  { label: 'Google sign-in', detail: 'Sign in personally in the native Chrome window.', url: 'https://accounts.google.com/' },
  { label: 'Chrome profile help', detail: 'Learn how to create a separate Team RSI profile.', url: 'https://support.google.com/chrome/answer/2364824' },
]

const STATUS_COPY = {
  available: ['Chrome is ready', 'available'],
  'missing-browser': ['Chrome is not installed', 'blocked'],
  'unsupported-platform': ['This account browser requires macOS or a Linux desktop', 'blocked'],
  unavailable: ['Chrome is unavailable', 'blocked'],
}

function launchErrorMessage(error) {
  switch (error instanceof Error ? error.message : String(error)) {
    case 'ACCOUNT_BROWSER_URL_INVALID':
      return 'That destination is not approved. Choose one of the listed destinations.'
    case 'ACCOUNT_BROWSER_AUDIT_UNAVAILABLE':
      return 'The launch was not dispatched because Chimera could not record the request. You can try again.'
    case 'ACCOUNT_BROWSER_PROFILE_UNAVAILABLE':
      return 'Chimera Work storage is unavailable or unsafe. Chrome was not launched; check the dedicated browser directory before trying again.'
    case 'ACCOUNT_BROWSER_LAUNCH_UNCONFIRMED':
      return 'Chrome may have received the request. Check Chrome first; Chimera will not retry automatically.'
    case 'ACCOUNT_BROWSER_RESULT_UNRECORDED':
      return 'The desktop accepted the launch request, but Chimera could not record the result. Check Chrome first; do not retry automatically.'
    case 'ACCOUNT_BROWSER_UNSUPPORTED_PLATFORM':
      return 'This account browser requires macOS or a Linux desktop.'
    case 'ACCOUNT_BROWSER_NOT_INSTALLED':
      return 'Chrome is not installed. Install it, then check again.'
    case 'ACCOUNT_BROWSER_UNAVAILABLE':
      return 'Chrome is unavailable. Check again before another launch attempt.'
    default:
      return 'The result is unconfirmed. Check Chrome first; Chimera will not retry automatically.'
  }
}

export function AccountBrowser() {
  const [availability, setAvailability] = useState({ status: 'checking' })
  const [destination, setDestination] = useState(DESTINATIONS[0].url)
  const [launchState, setLaunchState] = useState({ status: 'idle', message: '' })
  const mounted = useRef(true)
  const loaded = useRef(false)
  const requestGeneration = useRef(0)
  const launchPending = useRef(false)

  const checkAvailability = async () => {
    const generation = ++requestGeneration.current
    setAvailability({ status: 'checking' })
    try {
      const result = await api('/api/account-browser/state', { cache: 'no-store' })
      if (mounted.current && generation === requestGeneration.current) setAvailability(result)
    } catch {
      if (mounted.current && generation === requestGeneration.current) setAvailability({ status: 'check-failed' })
    }
  }

  useEffect(() => {
    mounted.current = true
    if (!loaded.current) {
      loaded.current = true
      void checkAvailability()
    }
    return () => {
      mounted.current = false
    }
  }, [])

  const openChrome = async () => {
    if (launchPending.current || availability.status !== 'available' || !DESTINATIONS.some(item => item.url === destination)) return
    launchPending.current = true
    setLaunchState({ status: 'pending', message: 'Sending launch request…' })
    try {
      await post('/api/account-browser/open', { url: destination })
      if (mounted.current) setLaunchState({ status: 'accepted', message: 'The desktop launch request was accepted. This does not confirm Chrome opened, page load or sign-in.' })
    } catch (error) {
      if (mounted.current) setLaunchState({ status: 'error', message: launchErrorMessage(error) })
    } finally {
      launchPending.current = false
    }
  }

  const status = STATUS_COPY[availability.status]
  const pending = launchState.status === 'pending'
  return (
    <section className="account-browser" role="region" aria-labelledby="account-browser-title">
      <header className="account-browser__hero">
        <div>
          <span className="account-browser__eyebrow">Native account browser</span>
          <h1 id="account-browser-title">My accounts</h1>
          <p>Open Chimera Work, your dedicated Chrome instance for account pages you control personally.</p>
        </div>
        <div className={`account-browser__availability account-browser__availability--${status?.[1] ?? 'checking'}`} aria-live="polite">
          <i />
          <span>{availability.status === 'checking' ? 'Checking Chrome…' : availability.status === 'check-failed' ? 'Could not check Chrome' : status?.[0] ?? 'Chrome status unavailable'}</span>
        </div>
      </header>

      <div className="account-browser__grid">
        <div className="account-browser__primary">
          <div className="account-browser__control-row">
            <span><strong>Human control</strong><small>Chrome stays under your direct control.</small></span>
            <span><strong>Explicit sharing only</strong><small>Pairing alone never grants an agent access.</small></span>
          </div>

          <fieldset className="account-browser__destinations">
            <legend>Choose a destination</legend>
            {DESTINATIONS.map(item => (
              <label key={item.url} className={destination === item.url ? 'selected' : ''}>
                <input type="radio" name="account-destination" value={item.url} checked={destination === item.url} onChange={event => setDestination(event.target.value)} />
                <span><strong>{item.label}</strong><small>{item.detail}</small></span>
              </label>
            ))}
          </fieldset>

          <div className="account-browser__actions">
            <button className="account-browser__open" type="button" disabled={availability.status !== 'available' || pending} onClick={openChrome}>Open Chrome</button>
            <button className="account-browser__check" type="button" disabled={availability.status === 'checking' || pending} onClick={checkAvailability}>Check again</button>
          </div>
          {launchState.status !== 'idle' ? (
            <div className={`account-browser__feedback account-browser__feedback--${launchState.status}`} role="status">
              <strong>{launchState.status === 'accepted' ? 'Launch requested' : launchState.status === 'error' ? 'Launch not confirmed' : 'Requesting launch'}</strong>
              <span>{launchState.message}</span>
            </div>
          ) : null}
        </div>

        <aside className="account-browser__guidance" aria-label="Account browser boundaries">
          <span className="account-browser__eyebrow">What to expect</span>
          <h2>A separate, native window</h2>
          <p>Chrome opens outside Chimera. A launch request does not prove that the page loaded or that an account authenticated.</p>
          <ul>
            <li>Chimera Work uses separate browser storage, without remote debugging. RJ’s automation browser stays separate.</li>
            <li>Complete passwords, MFA, passkeys, recovery and CAPTCHA yourself.</li>
            <li>No profile, cookies or sign-in status are read or copied by Chimera.</li>
          </ul>
          <div className="account-browser__boundary"><strong>Sandbox control is separate</strong><span>Take control / Return to agent in the top bar applies only to Agent sandbox, never native Chrome.</span></div>
        </aside>
      </div>
      <AccountCompanion />
    </section>
  )
}
