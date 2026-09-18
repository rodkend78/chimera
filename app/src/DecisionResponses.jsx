import { createContext, useContext, useRef, useState } from 'react'
import { post, browserCommandFailureMessage } from './api.js'

export const DecisionResponsesContext = createContext(null)

export function useDecisionResponses(refresh) {
  const [updates, setUpdates] = useState({})
  const pending = useRef(new Set())
  const terminal = useRef(new Set())
  const remember = update => setUpdates(current => ({ ...current, [update.actionId]: update }))
  const blocked = actionId => pending.current.has(actionId) || terminal.current.has(actionId)
  const isPending = actionId => pending.current.has(actionId)
  const dismiss = actionId => {
    if (isPending(actionId)) return
    setUpdates(current => { const next = { ...current }; delete next[actionId]; return next })
  }
  const respond = async (decision, outcome) => {
    const actionId = decision.actionId
    if (blocked(actionId) || !['approve', 'deny'].includes(outcome)) return false
    pending.current.add(actionId)
    const update = { actionId, title: decision.title, outcome, status: 'pending', message: 'Response pending. You may close this review; nothing is resubmitted by navigation.' }
    remember(update)
    try {
      const result = await post(`/api/decisions/${encodeURIComponent(actionId)}`, { outcome })
      if (result?.actionId !== actionId || !['allowed', 'denied'].includes(result?.status)) {
        throw new Error('Decision response did not confirm the requested action')
      }
      if (result.status === 'allowed' || ['HUMAN_DENIED', 'NO_PENDING_ACTION', 'DECISION_EXPIRED_OR_NOT_ACTIVE'].includes(result.reason)) terminal.current.add(actionId)
      const confirmed = { ...update, status: 'confirmed', message: `Service result: ${result.status}${result.reason ? ` · ${result.reason}` : ''}. Inspect Activity for execution details.` }
      remember(confirmed)
      let refreshed = false
      try { refreshed = await refresh() } catch { /* The confirmed service reply remains valid. */ }
      if (!refreshed) remember({ ...confirmed, message: `${confirmed.message} Latest snapshot unconfirmed at acknowledgement; do not repeat a terminal response to refresh it.` })
      return true
    } catch (error) {
      remember({ ...update, status: 'unconfirmed', message: `Response unconfirmed: ${browserCommandFailureMessage(error)}. Inspect Decisions and Activity before retrying; nothing is retried automatically.` })
      return false
    } finally {
      pending.current.delete(actionId)
      // A service reply may already be visible while its snapshot read settles.
      // Publish settlement so dismissal becomes available even with an unchanged view.
      setUpdates(current => ({ ...current }))
    }
  }
  return { updates, blocked, isPending, respond, dismiss }
}

export function DecisionResponse({ actionId, dismissible = false }) {
  const { updates, isPending, dismiss } = useContext(DecisionResponsesContext)
  const update = updates[actionId]
  if (!update) return null
  return <div className="decision-response" role={update.status === 'unconfirmed' ? 'alert' : 'status'}>
    <strong>{update.outcome === 'approve' ? 'Approval requested' : 'Denial requested'} · {update.title}</strong>
    <code>{update.actionId}</code><p>{update.message}</p>
    {dismissible && !isPending(actionId) ? <button className="dismiss-response" type="button" aria-label={`Dismiss response for ${actionId}`} onClick={() => dismiss(actionId)}>Dismiss response</button> : null}
  </div>
}

export function DecisionResponseList() {
  const { updates } = useContext(DecisionResponsesContext)
  const ids = Object.keys(updates)
  if (!ids.length) return null
  return <section className="decision-responses" aria-label="Decision responses">
    <h2>Decision responses</h2>
    <p>Recorded in this loaded workspace. Service replies are not proof that the requested work completed.</p>
    {ids.map(actionId => <DecisionResponse key={actionId} actionId={actionId} dismissible />)}
  </section>
}
