import { useState } from 'react'

// Visual identities only. These do not grant capabilities or change routing.
const ANIMALS = Object.freeze({
  rj: 'Lion', ace: 'Beaver', ada: 'Peregrine falcon', ash: 'Red fox',
  genie: 'Peacock', inboxarchitect: 'Hummingbird', iris: 'Leopard',
  'paul-blart': 'German shepherd', sam: 'Gray wolf', researcher: 'Great horned owl',
})

export function AgentAvatar({ agentId, name, className = 'agent-avatar' }) {
  const id = agentId === 'ceo' ? 'rj' : agentId
  const animal = Object.hasOwn(ANIMALS, id ?? '') ? ANIMALS[id] : null
  const source = animal ? `/agent-portraits/${id}.jpg` : null
  const [failedSource, setFailedSource] = useState(null)
  const initials = String(name ?? agentId ?? '?').split(/[\s-]+/).map(part => part[0] ?? '').join('').slice(0, 2).toUpperCase()
  return (
    <span className={`${className} agent-portrait`} data-agent-id={agentId} title={animal ? `${name ?? agentId} · ${animal}` : name} aria-hidden="true">
      {source && failedSource !== source
        ? <img src={source} alt="" width="256" height="256" loading="lazy" decoding="async" onError={() => setFailedSource(source)} />
        : initials}
    </span>
  )
}
