import { useState } from 'react'
import { ClipboardList, FileText, Users, Globe2, Bot, Image, Activity, Scale } from './icons.jsx'

const primary = [['Queue', 'Work', ClipboardList], ['Projects', 'Projects', FileText], ['Agents', 'Team', Users], ['Browser', 'Browser', Globe2], ['Settings', 'Settings', Bot]]
const secondary = [['Clients', 'Clients', Users], ['Media', 'Media', Image], ['Workers', 'Workers', Bot], ['Activity', 'Activity', Activity], ['Decisions', 'Decisions', Scale]]

export function WorkspaceNavigation({ activeSection, onNavigate, pendingDecisions = 0 }) {
  const [expanded, setExpanded] = useState(() => secondary.some(([id]) => id === activeSection))
  const showTools = expanded
  const item = ([id, label, Icon]) => <button type="button" key={id} aria-label={label} title={label} className={id === activeSection ? 'nav-item active' : 'nav-item'} data-section={id.toLowerCase()} aria-current={id === activeSection ? 'page' : undefined} onClick={() => onNavigate(id)}><Icon size={22} strokeWidth={1.8}/><span>{label}</span></button>
  return <aside className="sidebar">
    <div className="wordmark"><span className="wordmark-text">CHIMERA</span></div>
    <nav className="primary-nav" aria-label="Primary navigation">
      {primary.map(item)}
      {pendingDecisions > 0 && <button type="button" className="nav-item" aria-label={`Needs you (${pendingDecisions})`} title={`Needs you (${pendingDecisions})`} onClick={() => { setExpanded(true); onNavigate('Decisions') }}><Scale size={22}/><span>Needs you ({pendingDecisions})</span></button>}
      <button type="button" className="nav-item" aria-expanded={showTools} aria-controls="workspace-tools" onClick={() => setExpanded(!showTools)}>More tools</button>
      <div id="workspace-tools" hidden={!showTools}>{secondary.map(item)}</div>
    </nav>
  </aside>
}
