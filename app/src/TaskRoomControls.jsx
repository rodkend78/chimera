const deliveryLabels = { pending: 'queued', processing: 'working', waiting: 'waiting', completed: 'replied', acknowledged: 'replied', failed: 'failed', expired: 'blocked (expired)', interrupted: 'interrupted' }

export function TaskRoomControls({ task, team, address, setAddress, displayName }) {
  const active = ['queued', 'running'].includes(task.status)
  const recipients = address?.taskId === task.taskId ? address.recipientAgentIds : []
  const select = id => setAddress(previous => {
    const current = previous?.taskId === task.taskId ? previous : { taskId: task.taskId, recipientAgentIds: [] }
    return { ...current, recipientAgentIds: current.recipientAgentIds.includes(id) ? current.recipientAgentIds.filter(value => value !== id) : [...current.recipientAgentIds, id] }
  })
  return <section className="task-room-controls" aria-label="Task collaboration">
    <strong>Team · {task.status}</strong>
    <p>{team?.participants?.length ? `Participating: ${team.participants.map(displayName).join(', ')}` : 'No peer assignments yet.'}</p>
    {active ? <fieldset><legend>Address participants in the command dock</legend>
      {(team?.eligibleRecipients ?? []).map(id => <label key={id}><input type="checkbox" aria-label={`@${displayName(id)}`} checked={recipients.includes(id)} disabled={!recipients.includes(id) && recipients.length >= 8} onChange={() => select(id)} />@{displayName(id)}</label>)}
      {!team?.eligibleRecipients?.length ? <span>No eligible recipients available yet.</span> : null}
    </fieldset> : <p>Task {task.status}. Guidance is inactive.</p>}
    {active ? <p>Select up to 8 recipients. Saved guidance applies at their next safe boundary; finished assignments do not restart. Unaddressed guidance remains general.</p> : null}
    <details open><summary>Delivery status · {team?.deliveries?.length ?? 0}</summary>
      <ul className="task-deliveries">{(team?.deliveries ?? []).map(row => <li key={row.messageId}>
        <span>{displayName(row.senderAgentId)} → {displayName(row.recipientAgentId)}{row.waitingForAgentId ? ` · awaiting ${displayName(row.waitingForAgentId)}` : ''}</span>
        <span className={`status-chip status-${row.status}`}>{deliveryLabels[row.status] ?? 'unknown'}</span>
        {row.reason ? <small>{row.reason}</small> : null}
      </li>)}</ul>
      {!team?.deliveries?.length ? <p>No peer deliveries yet.</p> : null}
    </details>
  </section>
}
