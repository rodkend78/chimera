import './task-permissions.css'

const value = (input, fallback = 'Not recorded') => typeof input === 'string' && input.length ? input : fallback
const strings = input => Array.isArray(input) ? input.filter(item => typeof item === 'string' && item.length) : null

export function TaskPermissions({ workspace, now = Date.now() }) {
  const taskId = workspace?.task?.taskId
  const leases = typeof taskId === 'string' && Array.isArray(workspace?.permissions)
    ? workspace.permissions.filter(lease => lease?.taskId === taskId) : []
  const selected = typeof taskId === 'string' && workspace?.routing?.taskId === taskId ? workspace.routing.selected : null
  const nativeRoute = /antigravity/i.test(selected?.executor ?? '')
  return <details className="task-permissions task-workspace-disclosure">
    <summary>Task access <span>{leases.length} recorded {leases.length === 1 ? 'lease' : 'leases'}</span></summary>
    <p>This is a record of this task’s access, not a new permission grant. Current server-side checks still apply before any action.</p>
    {nativeRoute ? <p className="task-permissions-warning">Antigravity uses its own native permissions. This Chimera summary does not replace those controls.</p> : null}
    {!leases.length ? <p className="task-workspace-muted">No task-bound access lease is recorded. Global agent settings do not establish this task’s permissions.</p> : leases.map(lease => {
      const expires = typeof lease.expiresAt === 'number'
        ? new Date(lease.expiresAt).getTime() : Date.parse(lease.expiresAt ?? '')
      const status = lease.status === 'active' && Number.isFinite(expires) && expires <= now ? 'expired' : value(lease.status)
      const executor = value(lease.executor, selected?.agentId === lease.agentId ? value(selected.executor) : 'Not recorded')
      const tools = strings(lease.tools)
      const hosts = strings(lease.networkHosts)
      const native = /antigravity/i.test(executor)
      return <article className="task-permissions-lease" key={lease.leaseId ?? `${lease.agentId}:${lease.issuedAt}`}>
        <header><strong>{value(lease.agentId)}</strong><span>{status}</span></header>
        <dl>
          <div><dt>Agent profile now</dt><dd>{value(lease.agentProfileId)}</dd></div>
          <div><dt>Task profile</dt><dd>{value(lease.profileId)}</dd></div>
          <div><dt>Granted ceiling</dt><dd>{value(lease.ceilingProfileId)}</dd></div>
          <div><dt>Executor</dt><dd>{executor}</dd></div>
          <div><dt>Expires</dt><dd>{Number.isFinite(expires) ? <time dateTime={typeof lease.expiresAt === 'number' ? new Date(expires).toISOString() : lease.expiresAt}>{new Date(expires).toLocaleString()}</time> : 'Not recorded'}</dd></div>
          <div><dt>Network hosts</dt><dd>{hosts ? hosts.length ? hosts.join(', ') : 'None granted' : 'Not recorded'}</dd></div>
          <div><dt>Tool ceiling</dt><dd>{tools ? tools.length ? tools.join(', ') : 'No tools recorded' : 'Not recorded'}</dd></div>
          <div><dt>Lease</dt><dd>{value(lease.leaseId)}</dd></div>
        </dl>
        {native && !nativeRoute ? <p className="task-permissions-warning">Antigravity uses its own native permissions. This Chimera summary does not replace those controls.</p> : null}
        {lease.warning ? <p className="task-permissions-warning">{lease.warning}</p> : null}
      </article>
    })}
  </details>
}
