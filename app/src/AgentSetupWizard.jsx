import { useEffect, useMemo, useRef, useState } from 'react'
import { api, post } from './api.js'
import { ArrowLeft, ArrowRight, CheckSquare2, LockKeyhole, X } from './icons.jsx'

const STEPS = ['source', 'identity', 'model', 'access', 'check']

function agentFor(state, agentId) {
  if (agentId === 'ceo') return state?.agents?.main ?? null
  return state?.agents?.specialists?.find(agent => agent.agentId === agentId) ?? null
}

function messageFor(error) {
  return String(error?.message ?? error).replaceAll('_', ' ').toLowerCase()
}

function hasHermesSource(preview) {
  return Boolean(preview?.source
    && typeof preview.source === 'object'
    && typeof preview.source.id === 'string'
    && preview.source.id.trim()
    && typeof preview.source.type === 'string'
    && preview.source.type.trim()
    && typeof preview.source.host === 'string'
    && preview.source.host.trim())
}

function isHermesPreviewExpired(preview) {
  const expiresAt = Date.parse(preview?.expiresAt ?? '')
  return !Number.isFinite(expiresAt) || expiresAt <= Date.now()
}

function normalizeHermesPreview(preview) {
  if (!preview || !Array.isArray(preview.candidates)) return preview
  return {
    ...preview,
    candidates: preview.candidates.map(candidate => ({
      ...candidate,
      continuity: {
        ...(candidate.continuity ?? {}),
        ...(candidate.dependencyStatus !== undefined ? { dependencyStatus: candidate.dependencyStatus } : {}),
      },
    })),
  }
}

function draftKey(value) {
  return JSON.stringify(value)
}

function acceptedDraftState(value) {
  return {
    identity: value?.identity && typeof value.identity === 'object' ? value.identity : {},
    model: value?.model && typeof value.model === 'object' ? value.model : {},
    access: value?.access && typeof value.access === 'object' ? value.access : {},
  }
}

export function AgentSetupWizard({ state, onClose, onComplete, refresh, onDiscoverAgents, onImportAgents, onImportMainAgent, onOpenConnections, initialState = null, onStateChange }) {
  const agents = [state?.agents?.main, ...(state?.agents?.specialists ?? [])].filter(Boolean)
  const [step, setStep] = useState(initialState?.step ?? 0)
  const [agentId, setAgentId] = useState(initialState?.agentId ?? agents[0]?.agentId ?? 'ceo')
  const [source, setSource] = useState(initialState?.source ?? 'existing')
  const [draft, setDraft] = useState(initialState?.draft ?? { agentId: 'new-agent', displayName: '', role: '', capabilities: 'general', persona: '' })
  const [identityDrafts, setIdentityDrafts] = useState(initialState?.identityDrafts ?? {})
  const [modelDrafts, setModelDrafts] = useState(initialState?.modelDrafts ?? {})
  const [accessDrafts, setAccessDrafts] = useState(initialState?.accessDrafts ?? {})
  const [testRequestIds, setTestRequestIds] = useState(initialState?.testRequestIds ?? {})
  const [testReceipts, setTestReceipts] = useState(initialState?.testReceipts ?? {})
  const [acceptedDrafts, setAcceptedDrafts] = useState(() => acceptedDraftState(initialState?.acceptedDrafts))
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState(null)
  const [hermesPreview, setHermesPreview] = useState(initialState?.hermesPreview ?? null)
  const [hermesOverrides, setHermesOverrides] = useState(initialState?.hermesOverrides ?? {})
  const createRequestId = useRef(initialState?.createRequestId ?? null)
  const acceptedDraftsRef = useRef(acceptedDraftState(initialState?.acceptedDrafts))
  const dialogRef = useRef(null)
  const returnFocusRef = useRef(typeof document !== 'undefined' ? document.activeElement : null)
  const busyRef = useRef(busy)
  const onCloseRef = useRef(onClose)
  busyRef.current = busy
  onCloseRef.current = onClose
  const agent = agentFor(state, agentId)
  const readiness = agent?.readiness ?? null
  const testBindingKey = `${agent?.agentId ?? agentId}:${readiness?.fingerprint ?? 'unresolved'}`
  const savedTest = testReceipts[testBindingKey] ?? null
  const providers = useMemo(() => (state?.models?.providers ?? []).filter(provider => provider.configured && (provider.models ?? []).some(model => model.capabilities?.includes('conversation'))), [state?.models?.providers])
  const preference = agent?.modelPreference ?? { mode: 'auto' }
  const profile = agent?.access?.profileId ?? 'sandbox'
  const identity = identityDrafts[agentId] ?? {
    displayName: agent?.displayName ?? '',
    role: agent?.role ?? '',
    capabilities: (agent?.capabilities ?? []).join(', '),
  }
  const fallbackModel = providers.flatMap(provider => (provider.models ?? []).filter(model => model.capabilities?.includes('conversation')).map(model => ({ providerId: provider.id, model: model.id })))[0] ?? null
  const rawModelDraft = modelDrafts[agentId] ?? preference
  const modelDraft = rawModelDraft.mode !== 'auto' && (!rawModelDraft.providerId || !rawModelDraft.model)
    ? { ...rawModelDraft, providerId: fallbackModel?.providerId, model: fallbackModel?.model }
    : rawModelDraft
  const modelValue = modelDraft.mode === 'auto' ? 'auto' : `${modelDraft.providerId ?? ''}::${modelDraft.model ?? ''}`
  const accessValue = accessDrafts[agentId] ?? profile
  const savedModelUnavailable = modelDraft.mode !== 'auto'
    && !providers.some(provider => provider.id === modelDraft.providerId && (provider.models ?? []).some(model => model.id === modelDraft.model))

  useEffect(() => {
    onStateChange?.({ step, agentId, source, draft, identityDrafts, modelDrafts, accessDrafts, testRequestIds, testReceipts, acceptedDrafts, hermesPreview, hermesOverrides, createRequestId: createRequestId.current })
  }, [step, agentId, source, draft, identityDrafts, modelDrafts, accessDrafts, testRequestIds, testReceipts, acceptedDrafts, hermesPreview, hermesOverrides, onStateChange])

  useEffect(() => {
    const focusable = () => [...(dialogRef.current?.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])') ?? [])]
    const closeButton = dialogRef.current?.querySelector('[data-setup-close]')
    closeButton?.focus()
    const onKeyDown = event => {
      if (event.key === 'Escape') {
        event.preventDefault()
        if (!busyRef.current) onCloseRef.current?.()
        return
      }
      if (event.key !== 'Tab') return
      const elements = focusable()
      if (elements.length === 0) return
      const first = elements[0]
      const last = elements.at(-1)
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus?.()
    }
  }, [])

  const run = async work => {
    if (busy) return
    setBusy(true)
    setNotice(null)
    try {
      const result = await work()
      try {
        const refreshed = await refresh?.()
        if (refreshed === false) setNotice({ type: 'success', text: 'Accepted, but the latest workspace state could not be confirmed. Your saved input is retained; do not resend.' })
      } catch {
        setNotice({ type: 'success', text: 'Accepted, but refreshing the workspace failed. Your saved input is retained; do not resend.' })
      }
      return result
    } catch (error) {
      setNotice({ type: 'error', text: messageFor(error) })
      return null
    } finally { setBusy(false) }
  }

  const createNative = () => run(async () => {
    if (!createRequestId.current) createRequestId.current = `agent-create-${crypto.randomUUID()}`
    const result = await post('/api/agents/create', {
      requestId: createRequestId.current,
      agentId: draft.agentId,
      displayName: draft.displayName,
      role: draft.role,
      capabilities: draft.capabilities.split(',').map(value => value.trim()).filter(Boolean),
      persona: draft.persona,
    })
    setAgentId(result.agent?.agentId ?? draft.agentId)
    setSource('existing')
    setNotice({ type: 'success', text: 'Native agent registered; continuity is still evidence-bound.' })
    setStep(1)
    return result
  })

  const discoverHermes = () => run(async () => {
    const result = await onDiscoverAgents?.()
    setHermesPreview(normalizeHermesPreview(result))
    return result
  })

  const importHermes = (candidate) => run(async () => {
    if (!hermesPreview) return null
    if (!hasHermesSource(hermesPreview)) {
      throw Object.assign(new Error('AGENT_DISCOVERY_SOURCE_UNAVAILABLE'), { code: 'AGENT_DISCOVERY_SOURCE_UNAVAILABLE' })
    }
    if (isHermesPreviewExpired(hermesPreview)) {
      throw Object.assign(new Error('AGENT_DISCOVERY_EXPIRED'), { code: 'AGENT_DISCOVERY_EXPIRED' })
    }
    if (candidate.reservedForMain) {
      const result = await onImportMainAgent?.({ discoveryId: hermesPreview.discoveryId, candidateId: candidate.candidateId })
      setAgentId(result?.agentId ?? 'ceo')
      setSource('existing')
      setHermesPreview(null)
      setStep(1)
      return result
    }
    const override = hermesOverrides[candidate.candidateId] ?? {}
    const result = await onImportAgents?.({
      discoveryId: hermesPreview.discoveryId,
      agents: [{
        candidateId: candidate.candidateId,
        ...(override.displayName?.trim() ? { displayName: override.displayName.trim() } : {}),
        ...(override.role?.trim() ? { role: override.role.trim() } : {}),
        ...(override.capabilities?.trim() ? { capabilities: override.capabilities.split(',').map(value => value.trim()).filter(Boolean) } : {}),
      }],
    })
    const imported = result?.imported?.[0]
    if (imported?.agentId) setAgentId(imported.agentId)
    setSource('existing')
    setHermesPreview(null)
    const incomplete = (result?.continuity ?? []).some(item => item?.status !== 'materialized'
      || ['persona', 'memory'].some(kind => Number.isInteger(item?.report?.[kind]?.files) && item.report[kind].files === 0))
    if (incomplete) setNotice({ type: 'error', text: 'Imported identity is saved, but required continuity is incomplete. Repair it before Ask or testing.' })
    setStep(1)
    return result
  })

  const saveIdentity = () => run(async () => {
    if (!agent || agent.agentId === 'ceo') return true
    const next = {
      agentId: agent.agentId,
      displayName: identity.displayName.trim(),
      role: identity.role.trim(),
      capabilities: identity.capabilities.split(',').map(value => value.trim()).filter(Boolean),
    }
    const key = draftKey(next)
    if (acceptedDraftsRef.current.identity[agent.agentId] === key) return true
    const result = await post('/api/agents/metadata', next)
    acceptedDraftsRef.current = { ...acceptedDraftsRef.current, identity: { ...acceptedDraftsRef.current.identity, [agent.agentId]: key } }
    setAcceptedDrafts(acceptedDraftsRef.current)
    return result
  })

  const repairContinuity = () => run(async () => {
    if (!agent || agent.agentId === 'ceo') return null
    return post('/api/agents/continuity/repair', { agentId: agent.agentId })
  })

  const saveModel = () => run(async () => {
    if (!agent) return null
    const value = modelValue
    const next = value === 'auto' ? { mode: 'auto' } : { mode: ['preferred', 'pinned'].includes(modelDraft.mode) ? modelDraft.mode : 'preferred', providerId: value.split('::')[0], model: value.split('::').slice(1).join('::') }
    const request = { agentId: agent.agentId, ...next }
    const key = draftKey(request)
    if (acceptedDraftsRef.current.model[agent.agentId] === key) return true
    const result = await post('/api/agents/model', request)
    acceptedDraftsRef.current = { ...acceptedDraftsRef.current, model: { ...acceptedDraftsRef.current.model, [agent.agentId]: key } }
    setAcceptedDrafts(acceptedDraftsRef.current)
    return result
  })

  const saveAccess = () => run(async () => {
    if (!agent) return null
    const next = accessValue
    if (next === 'live' && !window.confirm('Live workflow can act on external systems after human confirmation. Continue?')) return null
    const request = { agentId: agent.agentId, profileId: next }
    const key = draftKey(request)
    if (acceptedDraftsRef.current.access[agent.agentId] === key) return true
    const result = await post('/api/agents/access', request)
    acceptedDraftsRef.current = { ...acceptedDraftsRef.current, access: { ...acceptedDraftsRef.current.access, [agent.agentId]: key } }
    setAcceptedDrafts(acceptedDraftsRef.current)
    return result
  })

  const testAgent = () => run(async () => {
    if (!agent || !readiness) return null
    if (!window.confirm('Run one inference-only model test? This may use provider quota; no tools or task work will run.')) return null
    const key = `${agent.agentId}:${readiness.fingerprint}`
    const request = testRequestIds[key] ?? testReceipts[key]?.requestId ?? `agent-test-${crypto.randomUUID()}`
    if (!testRequestIds[key]) setTestRequestIds(current => ({ ...current, [key]: request }))
    setTestReceipts(current => ({ ...current, [key]: { ...(current[key] ?? {}), requestId: request, fingerprint: readiness.fingerprint, status: 'unconfirmed' } }))
    const result = await post('/api/agents/test', { agentId: agent.agentId, requestId: request, expectedFingerprint: readiness.fingerprint, allowQuotaUse: true })
    const status = result?.status ?? result?.receipt?.status
    if (status) setTestReceipts(current => ({ ...current, [key]: { ...(current[key] ?? {}), requestId: result?.unresolvedRequestId ?? result?.receipt?.requestId ?? result?.requestId ?? request, fingerprint: result?.fingerprint ?? readiness.fingerprint, status } }))
    return result
  })

  const lookupTest = () => run(async () => {
    if (!agent) return null
    const key = `${agent.agentId}:${readiness?.fingerprint ?? 'unresolved'}`
    const requestId = testReceipts[key]?.requestId ?? readiness?.lastTest?.requestId
    const query = new URLSearchParams({ agentId: agent.agentId, ...(requestId ? { requestId } : {}) })
    const result = await api(`/api/agents/readiness?${query.toString()}`)
    setTestReceipts(current => ({ ...current, [key]: { ...(current[key] ?? {}), requestId: result.requestId ?? requestId, fingerprint: result.fingerprint ?? readiness?.fingerprint ?? null, status: result.status ?? result.lastTest?.status ?? 'unknown' } }))
    return result
  })

  const next = async () => {
    if (step === 0 && source === 'native') {
      if (!agentFor(state, draft.agentId)) {
        await createNative()
        return
      }
      setNotice({ type: 'error', text: 'That agent ID is already registered. Choose Use a registered agent or enter a new ID; setup will not switch identities silently.' })
      return
    }
    if (step === 1 && (await saveIdentity()) === null) return
    if (step === 2 && (await saveModel()) === null) return
    if (step === 3 && (await saveAccess()) === null) return
    setStep(index => Math.min(STEPS.length - 1, index + 1))
  }

  const finish = async () => {
    if (agent) {
      if (identityDrafts[agentId] && (await saveIdentity()) === null) return
      if (modelDrafts[agentId] && (await saveModel()) === null) return
      if (accessDrafts[agentId] && (await saveAccess()) === null) return
    }
    onComplete?.()
  }

  return (
    <div className="agent-setup-backdrop" role="presentation">
      <section ref={dialogRef} className="agent-setup-wizard" role="dialog" aria-modal="true" aria-labelledby="agent-setup-heading" tabIndex={-1}>
        <header className="agent-setup-header">
          <div><span className="card-kicker">Bounded setup</span><h2 id="agent-setup-heading">Agent setup</h2><p>Configure identity, continuity, model, and access. Setup never starts a worker or silently tests a provider.</p></div>
          <button type="button" aria-label="Close setup" data-setup-close autoFocus onClick={onClose} disabled={busy}><X size={18} /></button>
        </header>
        <nav className="agent-setup-steps" aria-label="Setup steps">
          {STEPS.map((name, index) => <button key={name} type="button" className={index === step ? 'active' : ''} aria-current={index === step ? 'step' : undefined} onClick={() => !busy && setStep(index)}><span>{index < step ? <CheckSquare2 size={14} /> : index + 1}</span>{name}</button>)}
        </nav>
        {notice ? <p className={`agent-setup-notice ${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'}>{notice.text}</p> : null}
        <div className="agent-setup-body">
          {STEPS[step] === 'source' ? <section className="setup-step"><h3>Choose a source</h3><p>Native agents are created locally with bounded persona text. Hermes discovery is read-only until you explicitly import a candidate.</p><div className="setup-choice-grid"><button type="button" className={source === 'existing' ? 'selected' : ''} onClick={() => setSource('existing')}>Use a registered agent<span>Preserve existing identity and durable continuity.</span></button><button type="button" className={source === 'native' ? 'selected' : ''} onClick={() => setSource('native')}>Create native agent<span>Register a Chimera v2 persona without credentials.</span></button><button type="button" className={source === 'hermes' ? 'selected' : ''} onClick={() => setSource('hermes')}>Import from Hermes<span>Preview a configured source, then choose an agent.</span></button></div>{source === 'native' ? <div className="setup-form-grid"><label>Agent ID<input value={draft.agentId} onChange={event => setDraft(current => ({ ...current, agentId: event.target.value }))} /></label><label>Display name<input value={draft.displayName} onChange={event => setDraft(current => ({ ...current, displayName: event.target.value }))} /></label><label>Role<input value={draft.role} onChange={event => setDraft(current => ({ ...current, role: event.target.value }))} /></label><label>Capabilities<input value={draft.capabilities} onChange={event => setDraft(current => ({ ...current, capabilities: event.target.value }))} /></label><label className="full">Persona<textarea value={draft.persona} onChange={event => setDraft(current => ({ ...current, persona: event.target.value }))} /></label></div> : null}{source === 'hermes' ? <div className="hermes-wizard-import"><button type="button" onClick={discoverHermes} disabled={busy}>{busy ? 'Discovering…' : 'Find Hermes agents'}</button>{hermesPreview ? <div className="hermes-preview" aria-label="Hermes discovery preview"><div className="hermes-preview-meta"><strong>{hasHermesSource(hermesPreview) ? hermesPreview.source.host : 'Hermes source unavailable'}</strong><span className={!hasHermesSource(hermesPreview) || isHermesPreviewExpired(hermesPreview) ? 'warning' : ''}>{!hasHermesSource(hermesPreview) ? 'Source unavailable; discover again.' : isHermesPreviewExpired(hermesPreview) ? 'Preview expired; discover again.' : `Preview expires ${new Date(hermesPreview.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`}</span></div>{hermesPreview.candidates?.map(candidate => { const override = hermesOverrides[candidate.candidateId] ?? {}; const exclusions = candidate.exclusions ?? candidate.continuity?.exclusions ?? []; const dependencies = candidate.dependencies ?? candidate.continuity?.dependencies ?? candidate.continuity?.dependencyStatus ?? []; return <div className="hermes-preview-candidate" key={candidate.candidateId}><div><strong>{candidate.displayName}</strong> · {candidate.defaultRole}<small>{candidate.sourceRef ?? 'Source reference unavailable'}</small>{exclusions.length ? <small className="warning">Excluded layers: {exclusions.join(', ')}</small> : null}{dependencies.length ? <small>Dependencies: {Array.isArray(dependencies) ? dependencies.join(', ') : String(dependencies)}</small> : null}</div><div className="hermes-preview-fields"><label>Display name<input value={override.displayName ?? candidate.displayName ?? ''} disabled={busy || candidate.imported || candidate.reservedForMain} onChange={event => setHermesOverrides(current => ({ ...current, [candidate.candidateId]: { ...current[candidate.candidateId], displayName: event.target.value } }))} /></label><label>Role<input value={override.role ?? candidate.defaultRole ?? ''} disabled={busy || candidate.imported || candidate.reservedForMain} onChange={event => setHermesOverrides(current => ({ ...current, [candidate.candidateId]: { ...current[candidate.candidateId], role: event.target.value } }))} /></label><label>Capabilities<input value={override.capabilities ?? (candidate.defaultCapabilities ?? []).join(', ')} disabled={busy || candidate.imported || candidate.reservedForMain} onChange={event => setHermesOverrides(current => ({ ...current, [candidate.candidateId]: { ...current[candidate.candidateId], capabilities: event.target.value } }))} /></label></div><button type="button" disabled={busy || candidate.imported || !hasHermesSource(hermesPreview) || isHermesPreviewExpired(hermesPreview)} onClick={() => importHermes(candidate)}>{candidate.reservedForMain ? 'Import RJ continuity' : candidate.imported ? 'Already imported' : 'Import selected'}</button></div> })}</div> : <p className="setup-hint">No discovery request runs until you select Find Hermes agents.</p>}</div> : null}</section> : null}
          {STEPS[step] === 'identity' ? <section className="setup-step"><h3>Identity and continuity</h3><label>Agent<select value={agentId} onChange={event => setAgentId(event.target.value)}>{agents.map(item => <option value={item.agentId} key={item.agentId}>{item.displayName} · {item.agentId}</option>)}</select></label>{agent ? <><div className="setup-form-grid"><label>Display name<input value={identity.displayName} disabled={agent.agentId === 'ceo'} onChange={event => setIdentityDrafts(current => ({ ...current, [agentId]: { ...identity, displayName: event.target.value } }))} /></label><label>Role<input value={identity.role} disabled={agent.agentId === 'ceo'} onChange={event => setIdentityDrafts(current => ({ ...current, [agentId]: { ...identity, role: event.target.value } }))} /></label><label className="full">Capabilities<input value={identity.capabilities} disabled={agent.agentId === 'ceo'} onChange={event => setIdentityDrafts(current => ({ ...current, [agentId]: { ...identity, capabilities: event.target.value } }))} /></label></div><div className="setup-evidence-card"><strong>{identity.displayName || agent.displayName}</strong><span>{agent.source?.type === 'hermes' ? 'Hermes profile' : 'Chimera native profile'}</span><span>Continuity: {agent.continuity?.status ?? 'not imported'}</span><span>Required persona: {agent.continuity?.report?.persona?.files ?? 'unresolved'} retained file(s)</span><span>{agent.source?.type === 'hermes' ? 'Required memory' : 'Optional memory'}: {agent.continuity?.report?.memory?.files ?? 'unresolved'} retained file(s)</span><span>Optional skills: {agent.continuity?.report?.skills?.files ?? 'unresolved'} retained file(s)</span><span>Excluded layers: {agent.continuity?.report?.excluded?.length ? agent.continuity.report.excluded.join(', ') : 'None reported'}</span><span>Dependencies: {agent.continuity?.report?.dependencyStatus ?? 'unresolved'}</span>{agent.continuity?.status !== 'materialized' ? <><p className="warning">Continuity must be repaired before Ask or a test can be considered ready.</p>{agent.agentId !== 'ceo' ? <><button type="button" onClick={repairContinuity} disabled={busy}>{busy ? 'Repairing…' : 'Repair continuity'}</button>{onOpenConnections ? <button type="button" onClick={onOpenConnections} disabled={busy}>Open Connections to repair</button> : null}</> : <p className="setup-hint">RJ continuity is imported through the reserved Hermes RJ flow; no repair is sent automatically.</p>}</> : null}</div></> : <p className="warning">Select a registered agent before continuing.</p>}</section> : null}
          {STEPS[step] === 'model' ? <section className="setup-step"><h3>Model and executor</h3><p>Catalog presence is not a verification. Save a known conversation-capable route, then test explicitly in the final step.</p>{agent ? <><label>Routing behavior<select aria-label={`Routing behavior for ${agent.displayName}`} value={modelDraft.mode ?? 'auto'} onChange={event => setModelDrafts(current => ({ ...current, [agentId]: event.target.value === 'auto' ? { mode: 'auto' } : { ...modelDraft, mode: event.target.value } }))}><option value="auto">Auto · choose a compatible route</option><option value="preferred">Preferred · allow a backup model</option><option value="pinned">Pinned · fail closed if unavailable</option></select></label><label>Conversation model<select id={`wizard-model-${agent.agentId}`} value={modelValue} onChange={event => { if (event.target.value === 'auto') { setModelDrafts(current => ({ ...current, [agentId]: { mode: 'auto' } })); return }; const [providerId, ...modelParts] = event.target.value.split('::'); const mode = ['preferred', 'pinned'].includes(modelDraft.mode) ? modelDraft.mode : 'preferred'; setModelDrafts(current => ({ ...current, [agentId]: { ...modelDraft, mode, providerId, model: modelParts.join('::') } })) }}><option value="auto">Chimera Auto · best available pure route</option>{savedModelUnavailable ? <option value={modelValue} disabled>Unavailable · {modelDraft.providerId} · {modelDraft.model}</option> : null}{providers.flatMap(provider => (provider.models ?? []).filter(model => model.capabilities?.includes('conversation')).map(model => <option key={`${provider.id}:${model.id}`} value={`${provider.id}::${model.id}`}>{provider.name} · {model.name} ({model.availability ?? 'catalog'})</option>))}</select></label><p className="setup-hint"><LockKeyhole size={14} /> Native Codex and Antigravity tools are not advertised as pure Ask verification.</p></> : null}</section> : null}
          {STEPS[step] === 'access' ? <section className="setup-step"><h3>Access policy</h3><p>Access controls task tools and side effects; it does not turn a model catalog entry into proof of inference.</p>{agent ? <select id={`wizard-access-${agent.agentId}`} value={accessValue} onChange={event => setAccessDrafts(current => ({ ...current, [agentId]: event.target.value }))}>{(state.agents?.accessProfiles ?? []).map(item => <option value={item.profileId} key={item.profileId}>{item.label} · {item.network}</option>)}</select> : null}</section> : null}
          {STEPS[step] === 'check' ? <section className="setup-step"><h3>Check and save</h3><div className="readiness-card">{readiness ? <><div className="readiness-heading"><strong>{readiness.status}</strong><code>{readiness.fingerprint.slice(0, 12)}…</code></div><ul>{readiness.checks.map(check => <li key={check.name} className={`readiness-${check.status}`}><span>{check.name}</span><span>{check.status}{check.reason ? ` · ${check.reason}` : ''}</span></li>)}</ul><p>{readiness.lastTest?.historical ? 'The last test belongs to an older model/access binding.' : readiness.lastTest ? `Last test: ${readiness.lastTest.status}` : 'No inference test has been sent.'}</p>{['unknown', 'unconfirmed'].includes(savedTest?.status) || readiness.lastTest?.status === 'unknown' ? <button type="button" onClick={lookupTest} disabled={busy}>Check saved outcome</button> : null}<button type="button" className="primary-action" onClick={testAgent} disabled={busy || readiness.status === 'blocked'}>{busy ? 'Testing…' : 'Run inference-only test'}</button><p className="setup-hint">This verifies one inference response only; it does not verify tools, task execution, or publication.</p></> : <p>Choose a registered agent first.</p>}</div></section> : null}
        </div>
        <footer className="agent-setup-footer"><button type="button" onClick={onClose} disabled={busy}>Keep draft</button><div><button type="button" onClick={() => setStep(index => Math.max(0, index - 1))} disabled={busy || step === 0}><ArrowLeft size={16} />Back</button>{step < STEPS.length - 1 ? <button type="button" className="primary-action" onClick={next} disabled={busy}>{busy ? 'Saving…' : 'Continue'}<ArrowRight size={16} /></button> : <button type="button" className="primary-action" onClick={finish} disabled={busy}>{busy ? 'Saving…' : 'Done'}</button>}</div></footer>
      </section>
    </div>
  )
}
