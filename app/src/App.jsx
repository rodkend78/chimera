import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { api, browserCommandFailureMessage, initializeOperatorSession, post, startCodexBrowserLogin } from './api.js'
import { AgentWorkers } from './AgentWorkers.jsx'
import { WorkspaceNavigation } from './WorkspaceNavigation.jsx'
import { AgentAvatar } from './AgentAvatar.jsx'
import { ProjectWorkspace, ProjectWorkspaceSession } from './ProjectWorkspace.jsx'
import { ClientWorkspace, initialClientSection } from './ClientWorkspace.jsx'
import { AntigravityConnection } from './AntigravityConnection.jsx'
import { RjAwsConnection } from './RjAwsConnection.jsx'
import { isSelectableConversationModel } from './model-availability.js'
import LiveViewport from './LiveViewport.jsx'
import { BrowserFiles } from './BrowserFiles.jsx'
import { AccountBrowser } from './AccountBrowser.jsx'
import { TaskControls, TaskControlSession } from './TaskControls.jsx'
import { TaskRoomControls } from './TaskRoomControls.jsx'
import { TaskWorkspace } from './TaskWorkspace.jsx'
import { useTranscriptReading } from './useTranscriptReading.js'
import { DecisionResponsesContext, DecisionResponse, DecisionResponseList, useDecisionResponses } from './DecisionResponses.jsx'
import { OperatorRecovery } from './OperatorRecovery.jsx'
import { AgentSetupWizard } from './AgentSetupWizard.jsx'
import { ConnectionsWorkspace } from './ConnectionsWorkspace.jsx'
import { ConversationComposer } from './ConversationComposer.jsx'
import './agent-setup.css'
import './conversation-composer.css'
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Bot,
  BrainCircuit,
  ChevronDown,
  ClipboardList,
  FileText,
  Globe2,
  Image,
  LockKeyhole,
  MessageSquareText,
  PanelRightClose,
  PanelRightOpen,
  Pause,
  Plus,
  RefreshCw,
  Scale,
  Search,
  Send,
  Sparkles,
  Table2,
  Trash2,
  Users,
  Video,
  X,
} from './icons.jsx'

function TopBar({ state, onControl, onModelSelect, railCollapsed, onToggleRail }) {
  const human = state.controller.type === 'human'
  const selected = state.models?.selected
  const selectedValue = selected
    ? JSON.stringify({ providerId: selected.providerId, model: selected.model })
    : ''
  const modelOptions = state.models?.providers.flatMap((provider) => (
    provider.models.filter((model) => isSelectableConversationModel(provider, model)).map((model) => ({
      providerId: provider.id,
      providerName: provider.name,
      configured: provider.configured,
      modelId: model.id,
      modelName: model.name,
      availability: model.availability,
    }))
  )) ?? []
  const unavailable = Boolean(selectedValue
    && !(selected.providerId === 'chimera-auto' && selected.model === 'auto')
    && !modelOptions.some(option => option.providerId === selected.providerId && option.modelId === selected.model))
  const routeNotice = unavailable
    ? `Current route unavailable in this picker: ${selected.providerId} · ${selected.model}. The selection is preserved; choose another model explicitly.`
    : undefined
  return (
    <header className="topbar">
      <div className="agent-summary">
        <AgentAvatar agentId="ceo" name="RJ" />
        <strong>RJ</strong>
        <ChevronDown size={16} />
        <span className="top-divider" />
        <BrainCircuit size={20} className="muted-icon" />
        <select
          className={`model-select${unavailable ? ' model-select-unavailable' : ''}`}
          aria-label="RJ model"
          aria-description={routeNotice}
          title={routeNotice}
          value={selectedValue}
          onChange={(event) => {
            if (event.target.value) onModelSelect(JSON.parse(event.target.value))
          }}
        >
          {!selectedValue ? <option value="">Connect Codex or AWS</option> : null}
          <option value={JSON.stringify({ providerId: 'chimera-auto', model: 'auto' })}>Chimera Auto · Best model for task</option>
          {unavailable ? <option value={selectedValue} disabled>Unavailable · {selected.modelName ?? selected.model}</option> : null}
          {modelOptions.map((option) => (
            <option
              key={`${option.providerId}:${option.modelId}`}
              value={JSON.stringify({ providerId: option.providerId, model: option.modelId })}
            >
              {option.providerName} · {option.modelName}{option.availability ? ` (${option.availability})` : ''}
            </option>
          ))}
        </select>
        <span className="top-divider" />
        <span className={`agent-status ${state.suspended ? 'paused' : ''}`}><i />{state.agent.status}</span>
      </div>
      <div className="topbar-actions">
        <div className={`control-lease ${human ? 'human' : ''}`}>
          {human ? <Users size={21} /> : <Bot size={21} />}
          <span>{human ? 'Human controlling' : 'Agent controlling'}</span>
          <button type="button" onClick={onControl}>{human ? 'Return to agent' : 'Take control'}</button>
        </div>
        {onToggleRail ? (
          <button
            type="button"
            className="rail-toggle-btn"
            aria-label={railCollapsed ? 'Expand decisions rail' : 'Collapse decisions rail'}
            title={railCollapsed ? 'Expand decisions rail' : 'Collapse decisions rail'}
            onClick={onToggleRail}
          >
            {railCollapsed ? <PanelRightOpen size={20} /> : <PanelRightClose size={20} />}
          </button>
        ) : null}
      </div>
    </header>
  )
}

function BrowserTabs({ tabs, humanControl, command, notify }) {
  return (
    <div className="browser-tabs" role="tablist" aria-label="Browser tabs">
      {tabs.map((tab) => (
        <button
          className={`browser-tab ${tab.active ? 'active' : ''}`}
          key={tab.tabId}
          role="tab"
          aria-selected={tab.active}
          type="button"
          onClick={() => humanControl ? command({ command: 'activate-tab', tabId: tab.tabId }) : notify('Take control to switch tabs')}
        >
          <span className="tab-favicon">{tab.url.includes('developments') ? <Globe2 size={14} /> : 'E'}</span>
          <span className="tab-title">{tab.title || 'New tab'}</span>
          <span
            className="tab-close"
            role="button"
            tabIndex={-1}
            aria-label={`Close ${tab.title}`}
            onClick={(event) => {
              event.stopPropagation()
              if (humanControl) command({ command: 'close-tab', tabId: tab.tabId })
              else notify('Take control to close tabs')
            }}
          ><X size={14} /></span>
        </button>
      ))}
      <button
        className="new-tab"
        type="button"
        aria-label="Open new tab"
        onClick={() => humanControl ? command({ command: 'open-tab', url: 'about:blank' }) : notify('Take control to open a tab')}
      ><Plus size={18} /></button>
    </div>
  )
}

function BrowserToolbar({ activeTab, humanControl, command }) {
  const [value, setValue] = useState(activeTab?.url ?? 'about:blank')
  useEffect(() => setValue(activeTab?.url ?? 'about:blank'), [activeTab?.url])

  const navigate = (event) => {
    event.preventDefault()
    if (!humanControl || !value.trim()) return
    const destination = /^[a-z]+:/i.test(value.trim()) ? value.trim() : `https://${value.trim()}`
    command({ command: 'navigate', url: destination, tabId: activeTab?.tabId })
  }

  return (
    <div className="browser-toolbar">
      <button type="button" aria-label="Back" disabled={!humanControl} onClick={() => command({ command: 'back' })}><ArrowLeft size={20} /></button>
      <button type="button" aria-label="Forward" disabled={!humanControl} onClick={() => command({ command: 'forward' })}><ArrowRight size={20} /></button>
      <button type="button" aria-label="Reload" disabled={!humanControl} onClick={() => command({ command: 'reload' })}><RefreshCw size={18} /></button>
      <form id="browser-address-form" className="address-form" onSubmit={navigate}>
        <LockKeyhole size={16} />
        <input
          aria-label="Address"
          disabled={!humanControl}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          spellCheck="false"
        />
      </form>
      <button
        type="submit"
        form="browser-address-form"
        aria-label="Go to address"
        disabled={!humanControl || !value.trim()}
      ><Search size={19} /></button>
    </div>
  )
}

function BrowserWorkspace({ state, frame, streamStatus, humanCommand, sendInput, notify }) {
  const [browserMode, setBrowserMode] = useState('sandbox')
  const tabs = state.browser.tabs ?? []
  const activeTab = tabs.find((tab) => tab.active) ?? tabs[0]
  const humanControl = state.controller.type === 'human'
  return (
    <main className="browser-region browser-region--modes">
      <div className="browser-mode-switch" role="group" aria-label="Browser mode">
        <button type="button" aria-pressed={browserMode === 'sandbox'} onClick={() => setBrowserMode('sandbox')}>Agent sandbox</button>
        <button type="button" aria-pressed={browserMode === 'accounts'} onClick={() => setBrowserMode('accounts')}>My accounts</button>
      </div>
      {browserMode === 'accounts' ? <AccountBrowser /> : <div className="browser-frame">
        <BrowserTabs tabs={tabs} humanControl={humanControl} command={humanCommand} notify={notify} />
        <BrowserToolbar activeTab={activeTab} humanControl={humanControl} command={humanCommand} />
        <BrowserFiles humanControl={humanControl} notify={notify} />
        <LiveViewport
          frame={frame}
          streamStatus={streamStatus}
          humanControl={humanControl}
          sendInput={sendInput}
          suspended={state.suspended}
        />
      </div>}
    </main>
  )
}

function ActivityIcon({ event }) {
  const kind = event.kind ?? ''
  if (kind.includes('snapshot') || kind.includes('read')) return <FileText size={21} />
  if (kind.includes('decision')) return <ClipboardList size={21} />
  if (kind.includes('search')) return <Search size={21} />
  if (kind.includes('table')) return <Table2 size={21} />
  if (kind.includes('control')) return <Users size={21} />
  return <Globe2 size={21} />
}

function SectionHeader({ eyebrow, title, detail, action, headingId }) {
  return (
    <header className="section-header">
      <div>
        <span className="section-eyebrow">{eyebrow}</span>
        <h1 id={headingId}>{title}</h1>
        <p>{detail}</p>
      </div>
      {action}
    </header>
  )
}

const MODEL_FILTERS = [
  ['all', 'All'],
  ['conversation', 'Text & code'],
  ['image-generation', 'Image'],
  ['video-generation', 'Video'],
  ['embedding', 'Embedding'],
]

function ModelCapabilityIcon({ capabilities }) {
  if (capabilities.includes('video-generation')) return <Video size={18} />
  if (capabilities.includes('image-generation') || capabilities.includes('image-editing')) return <Image size={18} />
  return <BrainCircuit size={18} />
}

function modelStatus(model) {
  if (model.adapter === 'ready') return ['Adapter ready', 'ready']
  if (['verified-route', 'verified-manual', 'authenticated', 'available'].includes(model.availability)) return ['Configured route', 'ready']
  if (model.availability === 'access-eligible') return ['Access eligible', 'eligible']
  if (model.availability === 'access-required') {
    return [model.endpoint === 'bedrock-mantle' ? 'Mantle connection required' : 'AWS access required', 'warning']
  }
  if (model.availability === 'unavailable') return ['Unavailable', 'danger']
  if (model.availability === 'catalog-only') return ['Catalog only · not verified', 'muted']
  return ['Check access', 'muted']
}

function ModelCatalog({ state, onModelSelect, onModelCheck, onOpenMedia }) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [pending, setPending] = useState('')
  const awsProviders = state.models?.providers.filter((provider) => provider.id.startsWith('aws-bedrock')) ?? []
  const models = awsProviders.flatMap((provider) => (provider.models ?? []).map((model) => ({
    ...model,
    providerId: provider.id,
    providerName: provider.name,
    region: provider.region,
  })))
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return models.filter((model) => (filter === 'all' || model.capabilities?.includes(filter))
      && (!needle || `${model.name} ${model.id} ${model.provider}`.toLowerCase().includes(needle)))
  }, [filter, models, query])
  const run = async (model, operation) => {
    setPending(`${model.providerId}:${model.id}`)
    try {
      await operation({ providerId: model.providerId, model: model.id })
    } finally {
      setPending('')
    }
  }
  return (
    <section className="surface-card model-catalog" aria-labelledby="model-catalog-heading">
      <div className="catalog-heading">
        <div>
          <span className="card-kicker">AWS model fabric</span>
          <h2 id="model-catalog-heading">Bedrock catalog</h2>
          <p>{state.models?.catalog?.total ?? models.length} routes across Bedrock Runtime and Mantle in {awsProviders[0]?.region ?? 'your AWS region'}. Access and adapter readiness are checked separately.</p>
        </div>
        <label className="catalog-search"><Search size={17} /><input aria-label="Search Bedrock models" placeholder="Search Grok, Opus, Stability…" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      </div>
      <div className="catalog-filters" role="group" aria-label="Model capability">
        {MODEL_FILTERS.map(([value, label]) => (
          <button className={filter === value ? 'active' : ''} type="button" key={value} onClick={() => setFilter(value)}>{label}</button>
        ))}
      </div>
      <div className="catalog-list">
        {visible.map((model) => {
          const [status, tone] = modelStatus(model)
          const conversation = model.capabilities?.includes('conversation')
          const ready = ['verified-route', 'verified-manual'].includes(model.availability)
          const active = state.models?.selected?.providerId === model.providerId && state.models.selected.model === model.id
          const checking = pending === `${model.providerId}:${model.id}`
          return (
            <article className="catalog-row" key={`${model.providerId}:${model.id}`}>
              <span className="model-kind"><ModelCapabilityIcon capabilities={model.capabilities ?? []} /></span>
              <div className="model-copy">
                <div><strong>{model.name}</strong><span>{model.provider} · {model.endpoint === 'bedrock-mantle' ? 'Mantle' : 'Runtime'}</span></div>
                <code>{model.id}</code>
                {model.strengths?.length ? <p className="model-strengths">Strong for {model.strengths.join(', ')}.</p> : null}
                <ul>{(model.capabilities ?? []).map((capability) => <li key={capability}>{capability.replace('-', ' ')}</li>)}</ul>
              </div>
              <div className="model-action">
                <span className={`model-access tone-${tone}`}>{status}</span>
                {model.adapter === 'ready' ? (
                  <button type="button" onClick={onOpenMedia}>Open Media</button>
                ) : conversation ? (
                  <button
                    type="button"
                    disabled={active || checking}
                    onClick={() => run(model, onModelSelect)}
                  >{checking ? 'Selecting…' : active ? 'In use' : ready ? 'Use model' : 'Select model'}</button>
                ) : model.availability === 'access-eligible' ? (
                  <button type="button" disabled>Adapter required</button>
                ) : (
                  <button type="button" disabled={checking} onClick={() => run(model, onModelCheck)}>{checking ? 'Checking…' : 'Check access'}</button>
                )}
              </div>
            </article>
          )
        })}
        {!visible.length ? <div className="catalog-empty">No Bedrock models match this filter.</div> : null}
      </div>
    </section>
  )
}

const HERMES_INSTANCE_ENV = 'CHIMERA_HERMES_INSTANCE_ID'
const HERMES_NOT_CONFIGURED_COPY = `set ${HERMES_INSTANCE_ENV} to import from a configured Hermes source`

function hermesIntakeErrorMessage(cause) {
  const code = cause?.message ?? ''
  if (code === 'HERMES_DISCOVERY_NOT_CONFIGURED' || code === 'HERMES_REFERENCE_NOT_CONFIGURED') {
    return HERMES_NOT_CONFIGURED_COPY
  }
  return code.replaceAll('_', ' ').toLowerCase()
}

function normalizeHermesPreview(preview) {
  if (!preview || !Array.isArray(preview.candidates)) return preview
  return {
    ...preview,
    candidates: preview.candidates.map(candidate => ({
      ...candidate,
      dependencies: candidate.dependencyStatus !== undefined
        ? [candidate.dependencyStatus]
        : candidate.dependencies,
    })),
  }
}

function AgentImportPanel({ state, onDiscoverAgents, onImportAgents, onImportMainAgent }) {
  const [preview, setPreview] = useState(null)
  const [selected, setSelected] = useState([])
  const [overrides, setOverrides] = useState({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const discover = async () => {
    setBusy(true)
    setError('')
    try {
      const result = await onDiscoverAgents()
      setPreview(normalizeHermesPreview(result))
      setOverrides({})
      setSelected(result.candidates.filter((candidate) => !candidate.imported && !candidate.reservedForMain).map((candidate) => candidate.candidateId))
    } catch (cause) {
      setError(hermesIntakeErrorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  const toggle = (candidateId) => {
    setSelected((current) => current.includes(candidateId)
      ? current.filter((id) => id !== candidateId)
      : [...current, candidateId])
  }
  const importSelected = async () => {
    if (!preview || selected.length === 0) return
    setBusy(true)
    setError('')
    try {
      const result = await onImportAgents({
        discoveryId: preview.discoveryId,
        agents: selected.map((candidateId) => ({
          candidateId,
          ...(overrides[candidateId]?.displayName?.trim() ? { displayName: overrides[candidateId].displayName.trim() } : {}),
          ...(overrides[candidateId]?.role?.trim() ? { role: overrides[candidateId].role.trim() } : {}),
          ...(overrides[candidateId]?.capabilities?.trim() ? { capabilities: overrides[candidateId].capabilities.split(',').map(value => value.trim()).filter(Boolean) } : {}),
        })),
      })
      if ((result?.continuity ?? []).some(item => item?.status !== 'materialized')) setError('Import accepted, but continuity is incomplete. Open agent setup to repair it before Ask or testing.')
      setPreview(null)
      setSelected([])
    } catch (cause) {
      setError(hermesIntakeErrorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  const importMain = async () => {
    const candidate = preview?.candidates.find((entry) => entry.reservedForMain)
    if (!candidate) return
    setBusy(true)
    setError('')
    try {
      await onImportMainAgent({ discoveryId: preview.discoveryId, candidateId: candidate.candidateId })
      setPreview(null)
    } catch (cause) {
      setError(hermesIntakeErrorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  const previewExpired = Boolean(preview && Date.parse(preview.expiresAt ?? '') <= Date.now())
  return (
    <section className="surface-card agent-import-panel" aria-labelledby="agent-import-heading">
      <div className="agent-import-heading">
        <div><span className="card-kicker">Hermes source intake</span><h2 id="agent-import-heading">Import from a Hermes source</h2><p>When configured, Find Hermes agents pulls specialists over read-only SSM. Chimera does not default to a host. Credentials, sessions, schedules, and config stay outside the worker.</p></div>
        <button type="button" onClick={discover} disabled={busy}><RefreshCw size={16} />{busy && !preview ? 'Discovering…' : 'Find Hermes agents'}</button>
      </div>
      {error ? <p className="agent-import-error" role="alert">{error}</p> : null}
      {preview ? (
        <div className="agent-preview">
          <div className="agent-preview-meta"><span>{preview.source?.host ?? 'Hermes source unavailable'}</span><strong>{preview.candidates.length} profiles found</strong><small className={previewExpired ? 'warning' : ''}>{previewExpired ? 'Preview expired; run discovery again.' : `Read-only preview · expires ${new Date(preview.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`}</small></div>
          <div className="agent-candidate-grid">
            {preview.candidates.map((candidate) => (
              <label className={`agent-candidate ${candidate.imported || candidate.reservedForMain ? 'imported' : ''}`} key={candidate.candidateId}>
                <input type="checkbox" checked={candidate.imported || selected.includes(candidate.candidateId)} disabled={candidate.imported || candidate.reservedForMain || busy || previewExpired} onChange={() => toggle(candidate.candidateId)} />
                <AgentAvatar className="candidate-avatar" agentId={candidate.profileId} name={candidate.displayName} />
                <span><strong>{candidate.displayName}</strong><small>{candidate.reservedForMain ? 'Reserved for the main RJ persona' : candidate.imported ? 'Already registered' : candidate.defaultRole}</small><small>{candidate.exclusions?.length ? `Excluded: ${candidate.exclusions.join(', ')}` : ''}{candidate.dependencies?.length ? ` Dependencies: ${candidate.dependencies.join(', ')}` : ''}</small></span>
                {!candidate.imported && !candidate.reservedForMain ? <span className="agent-candidate-overrides"><input aria-label={`Display name for ${candidate.displayName}`} value={overrides[candidate.candidateId]?.displayName ?? candidate.displayName} disabled={busy || previewExpired} onChange={event => setOverrides(current => ({ ...current, [candidate.candidateId]: { ...current[candidate.candidateId], displayName: event.target.value } }))} /><input aria-label={`Role for ${candidate.displayName}`} value={overrides[candidate.candidateId]?.role ?? candidate.defaultRole ?? ''} disabled={busy || previewExpired} onChange={event => setOverrides(current => ({ ...current, [candidate.candidateId]: { ...current[candidate.candidateId], role: event.target.value } }))} /><input aria-label={`Capabilities for ${candidate.displayName}`} value={overrides[candidate.candidateId]?.capabilities ?? (candidate.defaultCapabilities ?? []).join(', ')} disabled={busy || previewExpired} onChange={event => setOverrides(current => ({ ...current, [candidate.candidateId]: { ...current[candidate.candidateId], capabilities: event.target.value } }))} /></span> : null}
              </label>
            ))}
          </div>
          <div className="agent-import-actions">
            <button type="button" onClick={() => setPreview(null)} disabled={busy}>Cancel</button>
            {preview.candidates.some((candidate) => candidate.reservedForMain) && state.agents?.main?.continuity?.status === 'not-imported'
              ? <button type="button" onClick={importMain} disabled={busy || previewExpired}>Import RJ continuity</button>
              : null}
            <button className="primary-action" type="button" onClick={importSelected} disabled={busy || previewExpired || selected.length === 0}>{busy ? 'Importing…' : `Import selected (${selected.length})`}</button>
          </div>
        </div>
      ) : (
        <div className="agent-import-empty"><LockKeyhole size={18} /><span>{state.agents?.source?.configured
          ? `Discovery pulls agents from the configured source (${state.agents.source.host}) with a fixed read-only SSM inventory.`
          : HERMES_NOT_CONFIGURED_COPY}</span></div>
      )}
    </section>
  )
}

function eligibleConversationModels(state) {
  return (state.models?.providers ?? []).flatMap((provider) => (
    provider.configured ? (provider.models ?? [])
      .filter((model) => isSelectableConversationModel(provider, model, { allowCatalogOnly: true }))
      .map((model) => ({
        providerId: provider.id,
        providerName: provider.name,
        model: model.id,
        modelName: model.name,
      })) : []
  ))
}

function AgentModelPicker({ agent, state, busy, onSelect }) {
  const preference = agent.modelPreference ?? { mode: 'auto' }
  const models = eligibleConversationModels(state)
  const routeValue = preference.mode === 'auto' ? 'auto' : `${preference.providerId}::${preference.model}`
  const unavailable = preference.mode !== 'auto' && !models.some(model => model.providerId === preference.providerId && model.model === preference.model)
  const unavailableId = `model-unavailable-${agent.agentId}`
  return (
    <div className="agent-model-picker">
      <div><label htmlFor={`model-${agent.agentId}`}>Choose model</label><span>{preference.mode === 'auto' ? 'Let RJ choose for each task' : preference.mode === 'pinned' ? 'Only this model. Pause if unavailable.' : 'Use this model first; another may be used if unavailable.'}</span></div>
      <select
        id={`model-${agent.agentId}`}
        aria-label={`Model for ${agent.displayName}`}
        aria-describedby={unavailable ? unavailableId : undefined}
        value={routeValue}
        disabled={busy}
        onChange={(event) => {
          if (event.target.value === 'auto') return onSelect(agent.agentId, { mode: 'auto' })
          const [providerId, model] = event.target.value.split('::')
          return onSelect(agent.agentId, {
            mode: ['preferred', 'pinned'].includes(preference.mode) ? preference.mode : 'preferred',
            providerId,
            model,
          })
        }}
      >
        <option value="auto">Chimera Auto · best model for task</option>
        {unavailable ? <option value={routeValue} disabled>Unavailable · {preference.providerId} · {preference.model}</option> : null}
        {models.map((model) => <option value={`${model.providerId}::${model.model}`} key={`${model.providerId}:${model.model}`}>{model.providerName} · {model.modelName}</option>)}
      </select>
      {preference.mode !== 'auto' ? (
        <select
          aria-label={`Routing behavior for ${agent.displayName}`}
          value={preference.mode}
          disabled={busy}
          onChange={(event) => onSelect(agent.agentId, { ...preference, mode: event.target.value })}
        >
          <option value="preferred">Allow a backup model</option>
          <option value="pinned">Only use this model</option>
        </select>
      ) : <span className="model-mode-auto">Auto</span>}
      {preference.providerId === 'antigravity' && preference.mode !== 'auto' ? <p className="model-route-unavailable">
        Native Antigravity tools use your Antigravity CLI permissions. Chimera Sandbox and network settings do not restrict those native tools.
      </p> : null}
      {unavailable ? <p id={unavailableId} className="model-route-unavailable" role="status">
        <strong>Saved model unavailable</strong>
        <span>{preference.providerId} · {preference.model}</span>
        This route is not currently eligible. Your {preference.mode === 'pinned' ? 'Pinned' : 'Preferred'} selection is preserved.
        {preference.mode === 'pinned' ? ' Work using this pin fails closed until the route is available or you choose another model.' : ' Work may fall back to Auto while this preferred route is unavailable.'}
      </p> : null}
    </div>
  )
}

function specialistOwnedByTask(agent) {
  return Boolean(agent?.ownedByTaskId)
}

function AgentAccessControls({ agent, profiles, busy, onLifecycle, onSelect, showLifecycle = true }) {
  const imported = agent.executor?.requiresTask === true || agent.executor?.kind === 'task-harness' || agent.executor?.kind === 'runtime-task-harness'
  const owned = specialistOwnedByTask(agent)
  const running = agent.harnessState === 'Running'
  const recover = ['Interrupted', 'Crashed'].includes(agent.harnessState)
  const startAvailable = !imported || owned
  const lifecycleLabel = recover ? 'Recover' : running ? 'Stop worker' : 'Start worker'
  const lifecycleDisabled = busy || (!running && !recover && !startAvailable)
  return (
    <>
      <div className="agent-access-control">
        <label htmlFor={`access-${agent.agentId}`}>Harness access</label>
        <select
          id={`access-${agent.agentId}`}
          aria-label={`Access level for ${agent.displayName}`}
          value={agent.access.profileId}
          disabled={busy}
          onChange={(event) => onSelect(agent, event.target.value)}
        >
          {profiles.map((profile) => <option value={profile.profileId} key={profile.profileId}>{profile.label}</option>)}
        </select>
        <p>{agent.access.description}</p>
        <span className={`access-network access-${agent.access.profileId}`}>{agent.access.network.replaceAll('-', ' ')}</span>
      </div>
      {showLifecycle ? <div className="agent-worker-controls">
        <span>{agent.workspace ? `${agent.workspace.mounts.reduce((count, mount) => count + mount.files, 0)} read-only files` : 'Workspace pending'}</span>
        <span>{owned ? `Owned by RJ task ${agent.ownedByTaskId.slice(-8)}` : imported ? 'Runs under an RJ task' : agent.health ? `${agent.health.restartCount} recoveries` : 'Not started'}</span>
        {imported && !owned && !running && !recover ? (
          <span className="worker-bound-hint">This specialist runs under an RJ task, not as an independent daemon.</span>
        ) : (
          <button type="button" disabled={lifecycleDisabled} onClick={() => onLifecycle(agent)}>
            {busy ? 'Updating…' : lifecycleLabel}
          </button>
        )}
      </div> : null}
    </>
  )
}

const AgentUpdatesContext = createContext(null)

function AgentUpdatesSession({ children }) {
  const locks = useRef(new Set())
  const [updates, setUpdates] = useState([])
  const remember = useCallback(update => setUpdates(current => [
    ...current.filter(item => item.agentId !== update.agentId), update,
  ]), [])
  const run = async (agent, action, work) => {
    if (locks.current.has(agent.agentId)) return
    locks.current.add(agent.agentId)
    const update = { agentId: agent.agentId, name: agent.displayName, action, status: 'pending' }
    remember(update)
    try {
      const result = await work()
      remember({ ...update, status: 'accepted', message: result?.workspaceRefreshed === false
        ? 'Update accepted, but workspace status could not refresh. Displayed settings may be stale; do not repeat this accepted request.'
        : 'Update accepted. The latest workspace snapshot has been requested.' })
    } catch (cause) {
      remember({ ...update, status: 'unconfirmed', message: `${String(cause?.message ?? cause).replaceAll('_', ' ').toLowerCase()}. Update unconfirmed. Inspect the agent and Activity before retrying; nothing is retried automatically.` })
    } finally { locks.current.delete(agent.agentId) }
  }
  const dismiss = agentId => {
    if (!locks.current.has(agentId)) setUpdates(current => current.filter(item => item.agentId !== agentId))
  }
  return <AgentUpdatesContext.Provider value={{ updates, run, dismiss }}>{children}</AgentUpdatesContext.Provider>
}

function AgentsView({ settingsOnly = false, state, refresh, onNavigate, onOpenSetup, onOpenConnections, onReturnToSetup, setupReturnTarget = null, onModelSelect, onModelCheck, onDiscoverAgents, onImportAgents, onImportMainAgent, onAgentLifecycle, onAgentAccess, onRemoveAgent, onAgentModel, onConnectGitHub }) {
  const providers = state.models?.providers ?? []
  const selected = state.models?.selected
  const specialists = state.agents?.specialists ?? []
  const { updates, run, dismiss } = useContext(AgentUpdatesContext)
  const busy = agentId => updates.some(update => update.agentId === agentId && update.status === 'pending')
  const [connectingGitHub, setConnectingGitHub] = useState(false)
  const lifecycle = async (agent) => {
    const action = ['Interrupted', 'Crashed'].includes(agent.harnessState)
      ? 'recover'
      : agent.harnessState === 'Running' ? 'stop' : 'start'
    await run(agent, `${action[0].toUpperCase()}${action.slice(1)} worker`, () => onAgentLifecycle(agent.agentId, action))
  }
  const selectAccess = async (agent, profileId) => {
    if (profileId === agent.access.profileId) return
    const profile = state.agents.accessProfiles.find((candidate) => candidate.profileId === profileId)
    if (profileId === 'live' && !window.confirm(`${profile.warning}\n\nContinue with Live workflow for ${agent.displayName}?`)) return
    await run(agent, 'Access update', () => onAgentAccess(agent.agentId, profileId))
  }
  const selectAgentModel = async (agentId, preference) => {
    const agent = agentId === state.agents.main.agentId ? state.agents.main : specialists.find(item => item.agentId === agentId)
    if (agent) await run(agent, 'Model update', () => onAgentModel(agentId, preference))
  }
  const remove = async (agent) => {
    if (!window.confirm(`Remove ${agent.displayName} from the Chimera team? Their Hermes source profile and audit history will be preserved.`)) return
    await run(agent, 'Remove agent', () => onRemoveAgent(agent.agentId))
  }
  return (
    <main className="section-region" aria-labelledby="agents-heading">
      <SectionHeader
        eyebrow={settingsOnly ? 'Workspace setup' : 'Team roster'}
        title={settingsOnly ? 'Settings' : 'Your team'}
        detail={settingsOnly ? 'Connect your accounts, discover models, and import agents. Setup does not start work.' : 'Choose your agent and model. Account setup and imports live in Settings.'}
        headingId="agents-heading"
        action={<div className="section-header-actions"><button className="primary-action" type="button" onClick={() => onNavigate(settingsOnly ? 'Agents' : 'Settings')}>{settingsOnly ? 'Choose agent models' : 'Manage connections'}</button><button type="button" onClick={onOpenSetup}>New agent</button></div>}
      />
      {updates.length ? <section className="agent-updates" aria-labelledby="agent-updates-heading">
        <h2 id="agent-updates-heading">Agent updates</h2>
        <p>Latest update per agent in this loaded workspace. Switching sections does not repeat a request.</p>
        {updates.map(update => <div className="agent-update" key={update.agentId} role={update.status === 'unconfirmed' ? 'alert' : 'status'}>
          <div><strong>{update.name} · {update.action}</strong><span>{update.status === 'pending' ? 'Updating… You can switch sections while this request finishes.' : update.message}</span></div>
          {update.status !== 'pending' ? <button type="button" onClick={() => dismiss(update.agentId)} aria-label={`Dismiss update for ${update.name}`}>Dismiss</button> : null}
        </div>)}
      </section> : null}
      <div className="section-grid agents-grid" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
        {!settingsOnly && <div className="agent-roster-stack">
          <article className="surface-card agent-card">
          <div className="card-heading agent-card-heading">
            <AgentAvatar className="large-agent-avatar" agentId="ceo" name="RJ" />
            <div><span className="card-kicker">Main agent · CEO</span><h2>RJ</h2><p>Your digital operating persona and team controller.</p></div>
            <div className="agent-card-actions"><span className={`status-chip ${state.suspended ? 'muted' : 'ready'}`}>{state.agent.status}</span></div>
          </div>
          <dl className="detail-list">
            <div><dt>Routing</dt><dd>{selected ? `${selected.providerName} · ${selected.modelName}` : 'No route selected'}</dd></div>
            <div><dt>Authority</dt><dd>Signed, policy-mediated delegation</dd></div>
            <div><dt>Controller</dt><dd>{state.controller.type === 'human' ? 'Human operator' : 'RJ'}</dd></div>
          </dl>
          <AgentModelPicker agent={state.agents.main} state={state} busy={busy(state.agents.main.agentId)} onSelect={selectAgentModel} />
          <AgentAccessControls
            agent={state.agents.main}
            profiles={state.agents.accessProfiles}
            busy={busy(state.agents.main.agentId)}
            onSelect={selectAccess}
            showLifecycle={false}
          />
          </article>
          {specialists.map((agent) => (
            <article className="surface-card specialist-card" key={agent.agentId}>
              <div className="card-heading agent-card-heading">
                <AgentAvatar className="large-agent-avatar specialist-avatar" agentId={agent.agentId} name={agent.displayName} />
                <div><span className="card-kicker">{agent.harnessState}</span><h2>{agent.displayName}</h2><p>{agent.role}</p></div>
                <div className="agent-card-actions"><span className="status-chip ready">{agent.status}</span>
                <button className="agent-remove" type="button" aria-label={`Remove ${agent.displayName} from team`} disabled={busy(agent.agentId)} onClick={() => remove(agent)}><Trash2 size={14} />{updates.some(update => update.agentId === agent.agentId && update.status === 'pending' && update.action === 'Remove agent') ? 'Removing…' : 'Remove'}</button>
                </div>
              </div>
              <ul className="agent-capabilities">{agent.capabilities.map((capability) => <li key={capability}>{capability}</li>)}</ul>
              <details className="agent-source"><summary>Profile details</summary><span>{agent.source.type === 'hermes' ? 'Team box profile' : 'Chimera'}</span><code>{agent.source.ref}</code></details>
              {agent.source.type === 'hermes' ? <p className="agent-task-bound">Imported specialists run under an RJ task. Start worker is available only while that task owns them.</p> : null}
              <AgentModelPicker agent={agent} state={state} busy={busy(agent.agentId)} onSelect={selectAgentModel} />
              <AgentAccessControls
                agent={agent}
                profiles={state.agents.accessProfiles}
                busy={busy(agent.agentId)}
                onLifecycle={lifecycle}
                onSelect={selectAccess}
              />
            </article>
          ))}
        </div>}
        {settingsOnly ? <ConnectionsWorkspace
          connections={state.connections?.connections ?? []}
          modelProviders={providers}
          returnTarget={setupReturnTarget ? { label: 'setup', composerTarget: setupReturnTarget.composerTarget ?? null, draftKey: setupReturnTarget.draftKey ?? null } : { label: 'team' }}
          onReturn={setupReturnTarget ? onReturnToSetup : () => onNavigate('Agents')}
          refresh={refresh}
        >
          {/* The shared surface preserves the specialized subscription connected and approved route evidence. */}
          <RjAwsConnection connection={state.connectors?.rjAws} refresh={refresh} />
          <AntigravityConnection provider={providers.find(provider => provider.id === 'antigravity')} refresh={refresh} />
          {state.connectors?.github ? <article className="connection-row" key="github">
            <span className={`connection-dot ${state.connectors.github.connected ? 'ready' : ''}`} />
            <div><strong>GitHub</strong><span>{state.connectors.github.connected ? `${state.connectors.github.login} · OAuth keychain · ${state.connectors.github.repositories.length} approved ${state.connectors.github.repositories.length === 1 ? 'repository' : 'repositories'}` : state.connectors.github.status === 'not-configured' ? 'Repository allowlist not configured' : 'OAuth authorization needed'}</span>{state.connectors.github.repositories?.length ? <ul aria-label="Approved GitHub repositories">{state.connectors.github.repositories.map(repository => { const name = typeof repository === 'string' ? repository : repository?.fullName ?? repository?.name; return name ? <li key={name}>{name}</li> : null })}</ul> : null}</div>
            <span className={`status-chip ${state.connectors.github.connected ? 'ready' : 'muted'}`}>{state.connectors.github.connected ? 'Connected' : 'Offline'}</span>
            {!state.connectors.github.connected && state.connectors.github.repositories.length ? <button type="button" disabled={connectingGitHub} onClick={async () => { setConnectingGitHub(true); try { await onConnectGitHub() } finally { setConnectingGitHub(false) } }}>{connectingGitHub ? 'Authorizing…' : 'Connect GitHub'}</button> : null}
          </article> : null}
        </ConnectionsWorkspace> : null}
      </div>
      {settingsOnly && <details><summary>Import agents</summary><AgentImportPanel state={state} onDiscoverAgents={onDiscoverAgents} onImportAgents={onImportAgents} onImportMainAgent={onImportMainAgent} /></details>}
      {settingsOnly && <details><summary>Advanced model catalog</summary><ModelCatalog state={state} onModelSelect={onModelSelect} onModelCheck={onModelCheck} onOpenMedia={() => onNavigate('Media')} /></details>}
    </main>
  )
}

const QueueContext = createContext(null)

function QueueSession({ children }) {
  const readingPositions = useRef(new Map())
  const [olderTasks, setOlderTasks] = useState([])
  const [olderMessages, setOlderMessages] = useState({})
  const [selectedId, setSelectedId] = useState(undefined)
  const [historyRequest, setHistoryRequest] = useState(null)
  const historyLock = useRef(false)
  const loadHistory = async ({ kind, conversationId, label, before }) => {
    if (historyLock.current) return
    historyLock.current = true
    const request = { kind, conversationId, label, status: 'pending' }
    setHistoryRequest(request)
    try {
      const query = new URLSearchParams({ limit: '100' })
      if (before) query.set('before', before)
      let count
      if (kind === 'messages') {
        query.set('conversationId', conversationId)
        const page = await api(`/api/conversations/messages?${query}`)
        if (!Array.isArray(page?.messages) || page.messages.some(message => !message || typeof message.messageId !== 'string'
          || !message.messageId || message.conversationId !== conversationId)) throw new Error('History response did not identify the requested conversation')
        setOlderMessages(previous => ({ ...previous, [conversationId]: [...new Map([
          ...page.messages, ...(previous[conversationId] ?? []),
        ].map(message => [message.messageId, message])).values()] }))
        count = page.messages.length
      } else {
        const page = await api(`/api/tasks?${query}`)
        if (!Array.isArray(page?.tasks) || page.tasks.some(task => !task || typeof task.taskId !== 'string' || !task.taskId)) throw new Error('History response did not identify its tasks')
        setOlderTasks(previous => [...new Map([...previous, ...page.tasks].map(task => [task.taskId, task])).values()])
        count = page.tasks.length
      }
      setHistoryRequest({ ...request, status: 'loaded', message: count ? `Loaded ${count} earlier ${kind}. Reading history does not execute work.` : `No earlier ${kind} were returned. Existing history is retained.` })
    } catch (cause) {
      setHistoryRequest({ ...request, status: 'failed', message: `${browserCommandFailureMessage(cause)}. Existing history is retained. ${kind === 'messages' ? 'Select this conversation, then use Load older messages' : 'Use Load older tasks'} to retry explicitly; navigation does not retry the read.` })
    } finally { historyLock.current = false }
  }
  return <QueueContext.Provider value={{ olderTasks, olderMessages, selectedId, setSelectedId, historyRequest, loadHistory, readingPositions }}>{children}</QueueContext.Provider>
}

function QueueView({ state, onConnectCodex, refresh, notify, onNavigate, onOutcomeAction, roomAddress, setRoomAddress }) {
  const { olderTasks, olderMessages, selectedId: savedSelectedId, setSelectedId, historyRequest, loadHistory: readHistory, readingPositions } = useContext(QueueContext)
  const historyBusy = historyRequest?.status === 'pending'
  const tasks = [...(state.tasks ?? []), ...olderTasks.filter((task) => !state.tasks?.some((current) => current.taskId === task.taskId))]
  // A task can arrive before its channel projection. Derive only navigation
  // metadata from that real task record, never a substitute task or authority.
  const channels = [...(state.conversations?.channels ?? []), ...tasks.filter((task) => !state.conversations?.channels?.some((channel) => channel.conversationId === `task:${task.taskId}`)).map((task) => ({ conversationId: `task:${task.taskId}`, taskId: task.taskId, kind: 'task-room', label: task.objective, detail: `Task record · ${task.status}` }))]
  const latest = tasks[0]
  const initialSelectedId = latest ? `task:${latest.taskId}` : channels[0]?.conversationId ?? 'main'
  const selectedId = savedSelectedId ?? initialSelectedId
  useEffect(() => { setSelectedId(current => current ?? initialSelectedId) }, [initialSelectedId, setSelectedId])
  const [connecting, setConnecting] = useState(false)
  const selected = channels.find((channel) => channel.conversationId === selectedId)
  const reading = useTranscriptReading(selected?.conversationId, readingPositions)
  const roomTask = selected?.kind === 'task-room' ? tasks.find(task => `task:${task.taskId}` === selected.conversationId
    && (selected.taskId === undefined || selected.taskId === task.taskId)) : null
  const messageBelongsToRoom = message => message?.conversationId === selected?.conversationId
    && (selected?.kind !== 'task-room' ? true : Boolean(roomTask && message.taskId === roomTask.taskId))
  const messages = [...new Map([...(olderMessages[selected?.conversationId] ?? []), ...(state.conversations?.messages ?? [])]
    .filter(messageBelongsToRoom).map((message) => [message.messageId, message])).values()]
  const team = state.teamMessaging?.tasks?.find(task => task.taskId === roomTask?.taskId)
  const messageById = new Map(messages.map(message => [message.messageId, message]))
  const addressForChannel = channel => {
    if (channel?.kind === 'task-room' && channel.taskId) {
      return { taskId: channel.taskId, recipientAgentIds: [], replyTo: null, destinationRevision: tasks.find(task => task.taskId === channel.taskId)?.destinationRevision ?? null }
    }
    if (channel?.recipientAgentId) return { agentId: channel.recipientAgentId, conversationId: channel.conversationId }
    return null
  }
  // Queue history owns the initial/restored destination when App has no
  // explicit room address yet. Once the operator selects a composer target,
  // keep that target through section navigation and polling instead of
  // silently rebinding its draft to whichever room refreshed most recently.
  useEffect(() => {
    if (!selected || roomAddress) return
    const address = addressForChannel(selected)
    if (address) setRoomAddress(address)
  }, [selected?.conversationId, selected?.kind, selected?.recipientAgentId, selected?.taskId, roomAddress, tasks, setRoomAddress])
  const selectRoom = id => {
    setSelectedId(id)
    const next = channels.find(channel => channel.conversationId === id)
    setRoomAddress(addressForChannel(next))
  }
  const preserveTaskAddress = next => setRoomAddress(current => current?.taskId === next?.taskId ? current : next)
  const loadHistory = (kind) => {
    if (kind === 'messages' && !selected) return
    return readHistory({ kind, conversationId: selected?.conversationId,
      label: kind === 'messages' ? selected.label : 'Objectives',
      before: kind === 'messages' ? messages[0]?.messageId : tasks.at(-1)?.taskId })
  }
  const configured = Boolean(state.models?.selected)
  const codex = state.auth?.codex ?? { connected: false, status: 'unavailable' }
  const agents = new Map([
    ['rod', 'You'],
    ['operator', 'You'],
    ['ceo', 'RJ'],
    ['rj', 'RJ'],
    ['harness', 'Harness'],
    ...(state.agents?.specialists ?? []).map((agent) => [agent.agentId, agent.displayName]),
  ])
  const displayName = (agentId) => agents.get(agentId) ?? String(agentId ?? 'harness').split('-').map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(' ')
  const provenanceLabel = (message) => {
    if (message.provenance?.verification === 'verified') return 'Verified event'
    if (message.provenance?.verification === 'human') return 'Human input'
    if (message.provenance?.verification === 'legacy') return 'Legacy record'
    return 'Derived event'
  }
  const messageLabel = (message) => {
    if (message.kind === 'task_handoff') return `${displayName(message.senderAgentId)} → ${displayName(message.recipientAgentIds[0])} · handoff`
    if (message.kind === 'structured_result') return `${displayName(message.senderAgentId)} → ${displayName(message.recipientAgentIds[0])} · result`
    if (message.kind === 'tool_request') return `${displayName(message.senderAgentId)} → Harness · tool request`
    if (message.kind === 'tool_result') return `Harness → ${displayName(message.recipientAgentIds[0])} · observation`
    return displayName(message.senderAgentId)
  }
  return (
    <main className="section-region queue-region" aria-labelledby="queue-heading">
      <SectionHeader
        eyebrow="RJ's queue"
        title="What are we working on?"
        detail="Tell RJ what you want to accomplish in the message box below. Follow your conversations, progress, and results here."
        headingId="queue-heading"
      />
      {historyRequest ? <section className="history-read-status" aria-label="History read status">
        <div className="media-notice" role={historyRequest.status === 'failed' ? 'alert' : 'status'}>
          <strong>Older {historyRequest.kind} · {historyRequest.label}</strong>
          {historyRequest.kind === 'messages' ? <code>{historyRequest.conversationId}</code> : null}
          <span>{historyRequest.status === 'pending' ? 'Loading history… You can switch sections while this read finishes.' : historyRequest.message}</span>
        </div>
      </section> : null}
      {roomTask ? <TaskControls tasks={tasks} selectedTaskId={roomTask.taskId} onSelectTask={taskId => selectRoom(`task:${taskId}`)} refresh={refresh} notify={notify} />
        : <p className="queue-compose-hint" role="status">{!selected
          ? 'Selected conversation unavailable. Choose another room or load older tasks.'
          : selected.kind === 'task-room'
            ? 'Task details are missing or inconsistent. Load older tasks or select another room before using task controls.'
            : 'Select a task room or objective to use task controls.'}</p>}
      {roomTask ? <TaskWorkspace taskId={roomTask.taskId} onNavigate={onNavigate} onDestinationChange={preserveTaskAddress} onOutcomeAction={onOutcomeAction} refresh={refresh} /> : null}
      {state.recentEvents?.find((event) => event.kind === 'model.route.selected') ? <p className="queue-compose-hint global-model-route" aria-label="Global last model route">Global last model route (not this task&apos;s route): {(() => {
        const route = state.recentEvents.find((event) => event.kind === 'model.route.selected')
        return `${route.routeId} · ${route.capability} · ${route.selectionReason ?? 'configured route'} · cost class: ${route.costClass} (not measured spend)`
      })()}</p> : null}
      <section className="surface-card queue-connection">
        <div className={`provider-connection status-${codex.status}`}>
          <span className="provider-mark"><BrainCircuit size={18} /></span>
          <div>
            <strong>ChatGPT / Codex</strong>
            <span>{codex.connected
              ? `${codex.planType ? `${codex.planType} ` : ''}subscription connected`
              : codex.status === 'connecting' ? 'Finish sign-in in the browser tab' : 'Connect your subscription'}</span>
          </div>
          <button
            type="button"
            disabled={connecting || codex.status === 'connecting'}
            onClick={async () => {
              setConnecting(true)
              try {
                await onConnectCodex()
              } finally {
                setConnecting(false)
              }
            }}
          >{connecting ? 'Opening…' : codex.connected ? 'Reconnect' : codex.status === 'connecting' ? 'Sign-in open' : 'Connect'}</button>
        </div>
        <p className="queue-compose-hint">{configured
          ? 'Give RJ the next objective from the command dock. One task runs at a time.'
          : 'Connect Codex or AWS, then give RJ one bounded objective from the command dock.'}</p>
      </section>
      <div className="queue-layout">
        <section className="surface-card queue-history" aria-label="RJ queue">
          <div className="panel-title"><div><span className="card-kicker">History</span><h2>Objectives</h2></div>{latest ? <span>{latest.status}</span> : null}</div>
          {tasks.length ? tasks.map((task) => (
            <article className={`queue-task-row ${roomTask?.taskId === task.taskId ? 'active' : ''}`} key={task.taskId}>
              <button type="button" aria-pressed={roomTask?.taskId === task.taskId} onClick={() => selectRoom(`task:${task.taskId}`)}>
                <strong>{task.objective}</strong>
                <span>{task.status}{task.summary ? ` · ${task.summary}` : ''}</span>
              </button>
            </article>
          )) : <p className="queue-empty">No objectives yet. The command dock is the only compose path.</p>}
          <button className="history-load" type="button" disabled={historyBusy} onClick={() => void loadHistory('tasks')}>Load older tasks</button>
        </section>
        <section className="surface-card team-chat-layout queue-transcript">
          <aside className="conversation-channels" aria-label="Work history">
            <div className="channel-group"><span>RJ and specialists</span>
              {channels.filter((channel) => channel.kind !== 'task-room').map((channel) => (
                <button className={`conversation-channel ${channel.conversationId === selected?.conversationId ? 'active' : ''}`} type="button" aria-label={`${channel.label} ${channel.detail}`} aria-pressed={channel.conversationId === selected?.conversationId} key={channel.conversationId} onClick={() => selectRoom(channel.conversationId)}>
                  <AgentAvatar className="channel-avatar" agentId={channel.kind === 'hq' ? 'ceo' : channel.recipientAgentId} name={displayName(channel.recipientAgentId ?? 'ceo')} />
                  <span><strong>{channel.label}</strong><small>{channel.detail}</small></span>
                </button>
              ))}
            </div>
            <div className="channel-group task-room"><span>Task rooms</span>
              {channels.filter((channel) => channel.kind === 'task-room').map((channel) => (
                <button className={`conversation-channel ${channel.conversationId === selected?.conversationId ? 'active' : ''}`} type="button" aria-label={`${channel.label} ${channel.detail}`} aria-pressed={channel.conversationId === selected?.conversationId} key={channel.conversationId} onClick={() => selectRoom(channel.conversationId)}>
                  <span className="channel-avatar"><FileText size={15} /></span>
                  <span><strong>{channel.label}</strong><small>{channel.detail}</small></span>
                </button>
              ))}
              {!channels.some((channel) => channel.kind === 'task-room') ? <p>No audit task rooms yet.</p> : null}
            </div>
          </aside>
          <div className="team-chat-thread">
            <header className="chat-thread-header">
              {selected?.kind === 'task-room' ? <span className="channel-avatar"><FileText size={16} /></span> : <AgentAvatar className="channel-avatar" agentId={selected?.kind === 'hq' ? 'ceo' : selected?.recipientAgentId ?? 'ceo'} name={displayName(selected?.recipientAgentId ?? 'ceo')} />}
              <div><strong>{selected?.label ?? 'Conversation unavailable'}</strong><span>{selected?.detail ?? 'Choose a room from work history'}</span></div>
              <span className="status-chip muted">History</span>
            </header>
            <div className="chat-transcript" aria-live="polite" aria-label="Conversation transcript" tabIndex={0} ref={reading.transcript} onScroll={reading.onScroll}>
              {roomTask ? <TaskRoomControls task={roomTask} team={team} address={roomAddress} setAddress={setRoomAddress} displayName={displayName} /> : null}
              <button className="history-load" type="button" disabled={historyBusy || !selected} onClick={() => void loadHistory('messages')}>Load older messages</button>
              {messages.length ? messages.map((message) => (
                <article className={`conversation-message role-${message.role} kind-${message.kind}`} key={message.messageId} data-message-id={message.messageId}>
                  <AgentAvatar className="conversation-avatar" agentId={message.senderAgentId} name={displayName(message.senderAgentId)} />
                  <div><strong>{messageLabel(message)}</strong>
                    {message.replyTo ? <blockquote className="message-parent">{messageById.has(message.replyTo) ? `Reply to ${displayName(messageById.get(message.replyTo).senderAgentId)}: ${messageById.get(message.replyTo).content.slice(0, 160)}` : 'Reply to an earlier task message · load older messages for context'}</blockquote> : null}
                    <p>{message.content}</p><time>{new Date(message.createdAt).toLocaleString([], { hour: 'numeric', minute: '2-digit' })} · {provenanceLabel(message)}</time>
                    {roomTask && ['queued', 'running'].includes(roomTask.status) ? <button className="message-reply" type="button" aria-label={`Reply to ${displayName(message.senderAgentId)}`} onClick={() => setRoomAddress(previous => ({
                      taskId: roomTask.taskId, recipientAgentIds: previous?.taskId === roomTask.taskId && previous.recipientAgentIds.length ? previous.recipientAgentIds : (team?.eligibleRecipients?.includes(message.senderAgentId) ? [message.senderAgentId] : []),
                      replyTo: message.messageId, replyLabel: `${displayName(message.senderAgentId)}: ${message.content.slice(0, 100)}`,
                    }))}>Reply</button> : null}
                  </div>
                  <span className={`status-chip status-${message.status}`}>{message.status}</span>
                </article>
              )) : (
                <div className="empty-state"><MessageSquareText size={26} /><strong>No history in this room yet</strong><span>Give RJ one bounded objective from the command dock. Verified handoffs and derived tool events stay here.</span></div>
              )}
            </div>
            <div className="transcript-footer">
              {!reading.atLatest && selected ? <button type="button" className="transcript-latest" onClick={reading.jumpToLatest}>Jump to latest</button> : null}
              <p className="queue-compose-hint">Select participants or a reply here, then send guidance from the command dock.</p>
            </div>
          </div>
        </section>
      </div>
    </main>
  )
}

const MediaContext = createContext(null)

// Local previews and request ownership last for this loaded workspace. Runtime
// video references are supplied by the existing state API, not durable storage.
function MediaSession({ children }) {
  const [draft, setDraft] = useState({ kind: 'image', prompt: '', aspectRatio: '16:9', duration: '5s', resolution: '540p' })
  const [result, setResultState] = useState(null)
  const resultRef = useRef(null)
  const [working, setWorking] = useState(false)
  const [notice, setNotice] = useState(null)
  const [statusError, setStatusError] = useState('')
  const [statusRequest, setStatusRequest] = useState(null)
  const [playbackError, setPlaybackError] = useState(null)
  const generationLock = useRef(false)
  const statusLock = useRef(false)
  const [records, setRecords] = useState([])
  const [selectedKey, setSelectedKey] = useState('')
  const imageSequence = useRef(0)
  const selectionVersion = useRef(0)
  const remember = useCallback(entry => setRecords(current => {
    const next = current.some(item => item.key === entry.key)
      ? current.map(item => item.key === entry.key ? entry : item) : [...current, entry]
    let images = 0
    return next.slice().reverse().filter(item => item.value.kind !== 'image' || ++images <= 10).reverse()
  }), [])
  const setResult = useCallback((value, { select = true } = {}) => {
    const number = value.kind === 'image' ? ++imageSequence.current : null
    const key = value.kind === 'video' ? `video:${value.jobId}` : `image:${number}`
    remember({ key, label: value.kind === 'video' ? `Video ${value.jobId}` : `Image ${number}`, value })
    if (select) { resultRef.current = value; setResultState(value); setSelectedKey(key) }
  }, [remember])
  const selectRecord = useCallback(entry => {
    selectionVersion.current++
    remember(entry)
    resultRef.current = entry.value
    setResultState(entry.value)
    setSelectedKey(entry.key)
    setStatusError('')
  }, [remember])
  return <MediaContext.Provider value={{ draft, setDraft, result, setResult, resultRef, working, setWorking,
    notice, setNotice, statusError, setStatusError, generationLock, statusLock, records, selectedKey,
    selectRecord, selectionVersion, statusRequest, setStatusRequest, playbackError, setPlaybackError }}>{children}</MediaContext.Provider>
}

function MediaStudio({ state, notify, refresh }) {
  const mediaModels = state.models?.providers
    .find((provider) => provider.id === 'aws-bedrock')?.models
    .filter((model) => model.adapter === 'ready'
      && model.capabilities?.some((capability) => ['image-generation', 'video-generation'].includes(capability))) ?? []
  const imageModel = mediaModels.find((model) => model.capabilities.includes('image-generation'))
  const videoModel = mediaModels.find((model) => model.capabilities.includes('video-generation'))
  const { draft, setDraft, result, setResult, resultRef, working, setWorking, notice, setNotice,
    statusError, setStatusError, generationLock, statusLock, records, selectedKey, selectRecord, selectionVersion,
    statusRequest, setStatusRequest, playbackError, setPlaybackError } = useContext(MediaContext)
  const { kind, prompt, aspectRatio, duration, resolution } = draft
  const updateDraft = changes => setDraft(current => ({ ...current, ...changes }))
  const knownKeys = new Set(records.map(entry => entry.key))
  const runtimeRecords = (state.models?.media?.jobs ?? [])
    .filter(job => job.kind === 'video' && typeof job.jobId === 'string' && !knownKeys.has(`video:${job.jobId}`))
    .map(job => ({ key: `video:${job.jobId}`, label: `Video ${job.jobId}`, value: job }))
  const history = [...runtimeRecords, ...records].reverse()
  const imageExtension = result?.kind === 'image'
    ? new Map([['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/webp', 'webp']]).get(result.mimeType) : null
  const imageDownload = imageExtension && typeof result.base64 === 'string' && result.base64.trim()
    ? {
      href: `data:${result.mimeType};base64,${result.base64}`,
      filename: `chimera-${String(result.modelId ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60).replace(/^-|-$/g, '') || 'model'}-${selectedKey.replace(':', '-')}.${imageExtension}`,
    } : null

  useEffect(() => {
    if (result?.kind !== 'video' || result.status !== 'in-progress') return undefined
    const jobId = result.jobId
    let stopped = false
    const ownsResult = () => !stopped && resultRef.current?.jobId === jobId
    const timer = setInterval(async () => {
      if (statusLock.current || !ownsResult()) return
      statusLock.current = true
      setStatusRequest({ jobId, kind: 'poll' })
      try {
        const updated = await post('/api/media/status', { jobId })
        if (!ownsResult()) return
        if (updated?.kind !== 'video' || updated.jobId !== jobId) throw new Error('Status response did not identify the requested video')
        setResult(updated)
        setStatusError('')
        if (updated.status === 'completed') notify('Luma video is ready')
        await refresh()
      } catch (cause) {
        if (ownsResult()) setStatusError(String(cause?.message ?? cause).replaceAll('_', ' ').toLowerCase())
      } finally {
        statusLock.current = false
        setStatusRequest(null)
      }
    }, 5000)
    return () => { stopped = true; clearInterval(timer) }
  }, [notify, refresh, result?.jobId, result?.kind, result?.status, resultRef, setResult, setStatusError, statusLock, setStatusRequest])

  const loadVideo = async () => {
    const current = resultRef.current
    if (current?.kind !== 'video' || current.status !== 'completed' || statusLock.current) return
    const jobId = current.jobId
    const version = selectionVersion.current
    const ownsResult = () => resultRef.current?.jobId === jobId && selectionVersion.current === version
    statusLock.current = true
    setStatusRequest({ jobId, kind: 'playback' })
    setStatusError('')
    try {
      const updated = await post('/api/media/status', { jobId })
      if (!ownsResult()) return
      if (updated?.kind !== 'video' || updated.jobId !== jobId) throw new Error('Status response did not identify the requested video')
      setResult(updated)
      setPlaybackError(null)
      if (updated.status === 'completed' && !updated.artifactUrl) {
        setStatusError('The video completed, but no playback link was returned. Check the configured artifact resolver before trying again')
      }
    } catch (cause) {
      if (ownsResult()) setStatusError(String(cause?.message ?? cause).replaceAll('_', ' ').toLowerCase())
    } finally {
      statusLock.current = false
      setStatusRequest(null)
    }
  }

  const submit = async (event) => {
    event.preventDefault()
    const model = kind === 'image' ? imageModel : videoModel
    if (!model || !prompt.trim() || generationLock.current) return
    generationLock.current = true
    const selectionAtDispatch = selectionVersion.current
    setWorking(true)
    setNotice(null)
    try {
      const generated = await post('/api/media/generate', {
        model: model.id,
        prompt: prompt.trim(),
        aspectRatio,
        ...(kind === 'video' ? { duration, resolution, loop: false } : { outputFormat: 'png' }),
      })
      const select = selectionVersion.current === selectionAtDispatch
      setResult(generated, { select })
      if (select) setStatusError('')
      const accepted = { status: 'accepted', model: model.name, message: kind === 'image' ? 'Image generation completed.' : 'Video job accepted. See the latest status in the result panel.' }
      setNotice(accepted)
      notify(kind === 'image' ? 'Stability image generated' : 'Luma video job started')
      let refreshed = false
      try { refreshed = await refresh() } catch { /* acceptance remains valid */ }
      if (!refreshed) setNotice(current => current === accepted ? { ...accepted, message: `${accepted.message} Workspace status could not refresh. Do not repeat this accepted request.` } : current)
    } catch (cause) {
      setNotice({ status: 'failed', model: model.name, message: `${String(cause?.message ?? cause).replaceAll('_', ' ').toLowerCase()}. The request was not confirmed. Inspect Activity or the provider's job history before trying again; no automatic generation retry is performed.` })
    } finally {
      generationLock.current = false
      setWorking(false)
    }
  }

  const activeModel = kind === 'image' ? imageModel : videoModel
  return (
    <main className="section-region media-region" aria-labelledby="media-heading">
      <SectionHeader
        eyebrow="Creative model fabric"
        title="Media Studio"
        detail="Generate production images with Stability Image or asynchronous video with Luma Ray. Every invocation uses your AWS account and stays attributed to its model."
        headingId="media-heading"
      />
      {history.length ? <section className="media-history" aria-labelledby="media-history-heading">
        <h2 id="media-history-heading">Recent media</h2>
        <p>Latest 10 image previews stay in this tab. Video references come from this session and the current runtime—not permanent storage. Only the selected video is checked while Media is open.</p>
        <div className="media-history-list" role="group" aria-label="Choose media result">
          {history.map(entry => <button type="button" key={entry.key} aria-pressed={selectedKey === entry.key}
            onClick={() => selectRecord(entry)}>
            <strong>{entry.label}</strong><span>{entry.value.modelId}</span><small>{entry.value.status}</small>
          </button>)}
        </div>
      </section> : null}
      <section className="media-studio">
        <form className="media-composer" onSubmit={submit}>
          <div className="media-mode" role="tablist" aria-label="Media type">
            <button className={kind === 'image' ? 'active' : ''} type="button" role="tab" aria-selected={kind === 'image'} onClick={() => updateDraft({ kind: 'image' })}><Image size={18} />Stability Image</button>
            <button className={kind === 'video' ? 'active' : ''} type="button" role="tab" aria-selected={kind === 'video'} onClick={() => updateDraft({ kind: 'video' })}><Video size={18} />Luma Video</button>
          </div>
          <div className="media-model-line"><span>{activeModel?.name ?? 'Model unavailable'}</span><code>{activeModel?.id ?? 'Check AWS connection'}</code></div>
          <label className="media-prompt">
            <span>Describe the {kind}</span>
            <textarea maxLength={kind === 'image' ? 10000 : 5000} value={prompt} onChange={(event) => updateDraft({ prompt: event.target.value })} placeholder={kind === 'image' ? 'A cinematic product image of…' : 'A slow camera move through…'} />
          </label>
          <div className="media-settings">
            <label><span>Aspect</span><select value={aspectRatio} onChange={(event) => updateDraft({ aspectRatio: event.target.value })}><option>16:9</option><option>1:1</option><option>9:16</option><option>4:3</option><option>3:4</option><option>21:9</option></select></label>
            {kind === 'video' ? <label><span>Duration</span><select value={duration} onChange={(event) => updateDraft({ duration: event.target.value })}><option>5s</option><option>9s</option></select></label> : null}
            {kind === 'video' ? <label><span>Resolution</span><select value={resolution} onChange={(event) => updateDraft({ resolution: event.target.value })}><option>540p</option><option>720p</option></select></label> : null}
          </div>
          <p className="media-session-hint">Draft and recent results stay here while you switch sections. Reloading clears local previews; it does not cancel a submitted job.</p>
          {notice ? <div className="media-notice" role={notice.status === 'failed' ? 'alert' : 'status'}><strong>Latest request · {notice.model}</strong><span>{notice.message}</span></div> : null}
          <button className="media-generate" type="submit" disabled={!activeModel || !prompt.trim() || working}><Sparkles size={18} />{working ? 'Sending…' : kind === 'image' ? 'Generate image' : 'Generate video'}</button>
        </form>
        <section className="media-preview" aria-live="polite">
          {result ? <div className="media-result-meta"><strong>{result.modelId}</strong>{result.jobId ? <code>Job: {result.jobId}</code> : null}</div> : null}
          {statusError ? <div className="media-notice" role="alert"><span>Status check failed: {statusError}. The last known result is retained. {result?.status === 'in-progress' ? 'Status checks resume while Media is open' : 'Playback recovery requires an explicit retry'}; generation is not retried.</span></div> : null}
          {result?.kind === 'image' ? <img src={`data:${result.mimeType};base64,${result.base64}`} alt="generated image" /> : null}
          {result?.kind === 'image' ? <div className="media-playback-controls media-export-controls">
            {imageDownload ? <><a href={imageDownload.href} download={imageDownload.filename}>Save image</a><span>Downloads this selected image in its original format. No new generation or upload. Save previews before reloading.</span></>
              : <span>Image export is unavailable: the result is missing image data or is not a supported PNG, JPEG or WebP file.</span>}
          </div> : null}
          {result?.kind === 'video' && result.artifactUrl ? <video key={`${result.jobId}:${result.artifactUrl}`} src={result.artifactUrl} controls preload="none" onError={() => {
            if (resultRef.current?.jobId === result.jobId && resultRef.current?.artifactUrl === result.artifactUrl) setPlaybackError({ jobId: result.jobId, url: result.artifactUrl })
          }} /> : null}
          {result?.kind === 'video' && playbackError?.jobId === result.jobId && playbackError?.url === result.artifactUrl ? <div className="media-notice" role="alert">This video could not play. The link may have expired, or the browser may not support the file. Refresh its playback link explicitly; no new video will be generated.</div> : null}
          {result?.kind === 'video' && result.status === 'completed' ? <div className="media-playback-controls">
            <button type="button" onClick={loadVideo} disabled={Boolean(statusRequest)}>{statusRequest ? statusRequest.jobId === result.jobId ? 'Loading video…' : 'Waiting for another check…' : result.artifactUrl ? 'Refresh playback link' : 'Load video'}</button>
            <span>Checks this existing job using your AWS account. It does not generate a new video. Press Play to load the media file.</span>
          </div> : null}
          {result?.kind === 'video' && result.status === 'failed' ? <div className="media-notice" role="alert"><strong>Video generation failed</strong><span>{result.error ? String(result.error).replaceAll('_', ' ').toLowerCase() : 'The provider did not report a reason'}. Inspect the job before deciding whether to submit a new request. No automatic regeneration is performed.</span></div> : null}
          {result?.kind === 'video' && !result.artifactUrl && result.status !== 'failed' ? <div className="media-progress"><Video size={34} /><strong>{result.status === 'in-progress' ? 'Luma is rendering' : result.status}</strong><span>{result.status === 'in-progress' ? 'Video generation usually takes several minutes. Chimera is checking the signed job automatically.' : 'No playback file is loaded. Completed videos can be opened with Load video.'}</span></div> : null}
          {!result ? <div className="media-progress"><Sparkles size={34} /><strong>Your generated work appears here</strong><span>Choose an AWS specialist, describe the result, and Chimera will keep the original model attribution.</span></div> : null}
        </section>
      </section>
    </main>
  )
}

function ActivityView({ state }) {
  return (
    <main className="section-region" aria-labelledby="activity-heading">
      <SectionHeader eyebrow="Signed timeline" title="Activity" detail="Review model routing, control changes, browser work, handoffs, and outcomes in one place." headingId="activity-heading" />
      <section className="surface-card list-card">
        {state.activity.length ? state.activity.map((event, index) => (
          <article className="workspace-row" key={`${event.sequence}-${index}`}>
            <span className={`activity-icon tone-${index % 4}`}><ActivityIcon event={event} /></span>
            <div><strong>{event.label}</strong><span>{event.kind}</span></div>
            <time>{new Date(event.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</time>
          </article>
        )) : <div className="empty-state"><Activity size={26} /><strong>No activity yet</strong><span>Signed events will appear as Chimera works.</span></div>}
      </section>
    </main>
  )
}

function DecisionsView({ state, onDecision }) {
  const { blocked } = useContext(DecisionResponsesContext)
  return (
    <main className="section-region" aria-labelledby="decisions-heading">
      <SectionHeader eyebrow="Human authority" title="Decisions" detail="Review the exact requested action before granting or denying consequential work." headingId="decisions-heading" />
      <DecisionResponseList />
      <section className="surface-card decisions-list">
        {state.decisions.length ? state.decisions.map((decision) => (
          <article className="decision-list-card" key={decision.actionId}>
            <div><span className="send-icon"><Send size={21} /></span><div><strong>{decision.title}</strong><p>{decision.detail}</p></div></div>
            <div className="decision-actions"><button className="deny" type="button" disabled={blocked(decision.actionId)} onClick={() => onDecision(decision, 'deny')}>Deny</button><button className="review" type="button" onClick={() => onDecision(decision, 'review')}>Review</button></div>
          </article>
        )) : <div className="empty-state"><Scale size={26} /><strong>No decisions waiting</strong><span>Chimera will stop here whenever policy requires your approval.</span></div>}
      </section>
    </main>
  )
}

// The global dock and rail follow execution, not the room being read. Keep
// display and dispatch on the same running-first, then queued selection rule.
function currentTask(state) {
  return state.tasks?.find(task => task.status === 'running')
    ?? state.tasks?.find(task => task.status === 'queued')
}

function dockDestination(state, address) {
  const addressed = Boolean(address?.recipientAgentIds.length || address?.replyTo)
  const task = addressed ? state.tasks?.find(task => task.taskId === address.taskId) : currentTask(state)
  const kind = addressed ? 'message' : task ? 'steer' : 'objective'
  const taskId = task?.taskId ?? (addressed ? address.taskId : null)
  const recipientAgentIds = addressed ? [...address.recipientAgentIds] : []
  const replyTo = addressed ? address.replyTo ?? null : null
  const name = id => id === 'ceo' ? 'RJ' : state.agents?.specialists?.find(agent => agent.agentId === id)?.displayName ?? id
  return {
    kind, taskId, recipientAgentIds, replyTo,
    key: JSON.stringify([kind, taskId, [...recipientAgentIds].sort(), replyTo]),
    label: kind === 'objective' ? 'New objective · RJ'
      : `${task?.objective ?? 'Task context unavailable'} · ${taskId}${addressed ? ` · ${recipientAgentIds.map(id => `@${name(id)}`).join(', ')}${replyTo ? ` · Reply to ${address.replyLabel ?? replyTo}` : ''}` : ' · General guidance'}`,
  }
}

function DraftDestinationDialog({ review, destination, onClose, onRefresh, onConfirm }) {
  const dialog = useRef(null)
  useEffect(() => {
    const previousFocus = document.activeElement
    const element = dialog.current
    element.showModal()
    return () => { element.close(); previousFocus?.focus?.() }
  }, [])
  const changedAgain = review.destination.key !== destination.key
  return <dialog ref={dialog} className="decision-dialog draft-destination-dialog" aria-labelledby="draft-destination-title" onCancel={event => { event.preventDefault(); onClose() }}>
    <h2 id="draft-destination-title">Review draft destination</h2>
    <p>Your text is preserved. Changing its destination does not send it.</p>
    <dl><dt>Drafted for</dt><dd>{review.original.label}</dd><dt>Proposed destination</dt><dd>{review.destination.label}</dd></dl>
    {changedAgain ? <p role="status">The destination changed again. Review the latest destination before continuing.</p> : null}
    {changedAgain ? <button type="button" onClick={onRefresh}>Review latest destination</button> : null}
    <div className="dialog-actions"><button type="button" autoFocus onClick={onClose}>Keep draft</button><button type="button" className="approve" disabled={changedAgain} onClick={onConfirm}>Use this destination</button></div>
  </dialog>
}

function TaskPlan({ state }) {
  const active = currentTask(state)
  const latest = active ?? state.tasks?.[0]
  const status = latest?.status
  const nodes = latest?.plan?.nodes ?? latest?.plan?.tasks ?? []
  const steps = new Map((latest?.steps ?? []).map(step => [step.nodeId, step]))
  return (
    <section className="task-plan-panel" aria-label="Task plan">
      <div className="panel-title"><div><span className="card-kicker">{active ? active.status === 'running' ? 'Current execution' : 'Queued objective' : latest ? 'Latest recorded task' : 'Ready for work'}</span><h2>Task plan</h2></div>{latest ? <span>{status}</span> : null}</div>
      <p className="plan-scope">Global execution snapshot · not the selected room</p>
      {latest ? <p className="plan-objective" title={`${latest.objective}\nTask ID: ${latest.taskId}`}>{latest.objective}</p> : <p className="plan-objective">Give RJ one bounded objective from the command dock.</p>}
      {latest ? <p className="plan-task-id">Task ID · {latest.taskId}</p> : null}
      <ol className="plan-steps">
        {nodes.map((node, index) => {
          const step = steps.get(node.nodeId)
          const nodeStatus = step?.status ?? 'recorded'
          return <li className={`plan-step status-${nodeStatus}`} key={node.nodeId ?? `${node.objective}-${index}`}>
            <span className="plan-marker">{nodeStatus === 'completed' ? '✓' : index + 1}</span>
            <div><strong>{node.objective ?? node.nodeId ?? 'Recorded plan node'}</strong><span>{nodeStatus}{node.specialistAgentId ? ` · ${node.specialistAgentId}` : ''}</span></div>
          </li>
        })}
        {!nodes.length ? <li className="plan-step status-recorded"><span className="plan-marker">—</span><div><strong>No recorded plan nodes yet</strong><span>Plan not loaded</span></div></li> : null}
      </ol>
    </section>
  )
}

function RightRail({ state, onDecision, railCollapsed }) {
  const { blocked } = useContext(DecisionResponsesContext)
  if (railCollapsed) return null
  return (
    <aside className="right-rail">
      <TaskPlan state={state} />
      <section className="activity-panel">
        <div className="panel-title"><h2>Activity</h2></div>
        <div className="activity-list">
          {state.activity.slice(0, 4).map((event, index) => (
            <div className="activity-row" key={`${event.sequence}-${index}`}>
              <span className={`activity-icon tone-${index % 4}`}><ActivityIcon event={event} /></span>
              <div><p>{event.label}</p><time>{new Date(event.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</time></div>
            </div>
          ))}
        </div>
      </section>
      <section className="decisions-panel">
        <div className="panel-title"><h2>Decisions</h2>{state.decisions.length ? <span>{state.decisions.length} pending</span> : null}</div>
        {state.decisions.length ? state.decisions.slice(0, 1).map((decision) => (
          <article className="decision-card" key={decision.actionId}>
            <div className="decision-copy"><span className="send-icon"><Send size={21} /></span><strong>{decision.title}</strong></div>
            <div className="decision-actions">
              <button className="deny" type="button" disabled={blocked(decision.actionId)} onClick={() => onDecision(decision, 'deny')}>Deny</button>
              <button className="review" type="button" onClick={() => onDecision(decision, 'review')}>Review</button>
            </div>
            <DecisionResponse actionId={decision.actionId} />
          </article>
        )) : <div className="decision-empty"><Sparkles size={20} /><span>No decisions waiting</span></div>}
      </section>
    </aside>
  )
}

function MainWorkspace({ activeSection, state, frame, streamStatus, humanCommand, sendInput, notify, onNavigate, onOpenSetup, onOpenConnections, onReturnToSetup, setupReturnTarget, onDecision, onConnectCodex, onConnectGitHub, onModelSelect, onModelCheck, onDiscoverAgents, onImportAgents, onImportMainAgent, onAgentLifecycle, onAgentAccess, onRemoveAgent, onAgentModel, registerProject, submitProjectTask, reviewProject, commitProject, refresh, onOutcomeAction, roomAddress, setRoomAddress }) {
  if (['Agents', 'Settings'].includes(activeSection)) return <AgentsView settingsOnly={activeSection === 'Settings'} state={state} refresh={refresh} onNavigate={onNavigate} onOpenSetup={onOpenSetup} onOpenConnections={onOpenConnections} onReturnToSetup={onReturnToSetup} setupReturnTarget={setupReturnTarget} onModelSelect={onModelSelect} onModelCheck={onModelCheck} onDiscoverAgents={onDiscoverAgents} onImportAgents={onImportAgents} onImportMainAgent={onImportMainAgent} onAgentLifecycle={onAgentLifecycle} onAgentAccess={onAgentAccess} onRemoveAgent={onRemoveAgent} onAgentModel={onAgentModel} onConnectGitHub={onConnectGitHub} />
  if (activeSection === 'Queue') return <QueueView state={state} onConnectCodex={onConnectCodex} refresh={refresh} notify={notify} onNavigate={onNavigate} onOutcomeAction={onOutcomeAction} roomAddress={roomAddress} setRoomAddress={setRoomAddress} />
  if (activeSection === 'Workers') return <AgentWorkers state={state} refresh={refresh} notify={notify} />
  if (activeSection === 'Clients') return <ClientWorkspace />
  if (activeSection === 'Media') return <MediaStudio state={state} notify={notify} refresh={refresh} />
  if (activeSection === 'Projects') return <ProjectWorkspace state={state} registerProject={registerProject} submitProjectTask={submitProjectTask} reviewProject={reviewProject} commitProject={commitProject} notify={notify} refresh={refresh} />
  if (activeSection === 'Activity') return <ActivityView state={state} />
  if (activeSection === 'Decisions') return <DecisionsView state={state} onDecision={onDecision} />
  return <BrowserWorkspace state={state} frame={frame} streamStatus={streamStatus} humanCommand={humanCommand} sendInput={sendInput} notify={notify} />
}

function StatusBar({ state, onSuspend, onTask, onConnectCodex, roomAddress, setRoomAddress }) {
  const [draft, setDraft] = useState({ text: '', target: null })
  const objective = draft.text
  const [submitting, setSubmitting] = useState(false)
  const sending = useRef(false)
  const noticeSequence = useRef(0)
  const targetDisclosure = useRef(null)
  const [notice, setNotice] = useState(null)
  const [review, setReview] = useState(null)
  const [connecting, setConnecting] = useState(false)
  const [history, setHistory] = useState([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const draftRef = useRef(null)
  const active = currentTask(state)
  const destination = dockDestination(state, roomAddress)
  const targetChanged = Boolean(objective.trim() && draft.target && draft.target.key !== destination.key)
  const addressed = Boolean(roomAddress?.recipientAgentIds.length || roomAddress?.replyTo)
  const addressedTask = state.tasks?.find(task => task.taskId === roomAddress?.taskId)
  const eligibleRecipients = state.teamMessaging?.tasks?.find(task => task.taskId === roomAddress?.taskId)?.eligibleRecipients ?? []
  const invalidAddress = addressed && (!['queued', 'running'].includes(addressedTask?.status) || !roomAddress.recipientAgentIds.length || roomAddress.recipientAgentIds.some(id => !eligibleRecipients.includes(id)))
  const agentName = id => id === 'ceo' ? 'RJ' : state.agents?.specialists?.find(agent => agent.agentId === id)?.displayName ?? id
  const targetTask = addressed ? addressedTask : active
  const targetMode = addressed ? invalidAddress ? 'Guidance unavailable' : 'Addressed guidance'
    : active ? active.status === 'queued' ? 'Guide queued task' : 'Guide current task' : 'New objective'
  const targetObjective = targetTask?.objective ?? (addressed ? 'Task context unavailable' : 'RJ · bounded work')
  const configured = Boolean(state.models?.selected)
  const codex = state.auth?.codex ?? { connected: false, status: 'unavailable' }
  useEffect(() => {
    const closeOutside = event => {
      const disclosure = targetDisclosure.current
      if (disclosure && !disclosure.contains(event.target)) disclosure.open = false
    }
    document.addEventListener('pointerdown', closeOutside, true)
    document.addEventListener('focusin', closeOutside)
    return () => {
      document.removeEventListener('pointerdown', closeOutside, true)
      document.removeEventListener('focusin', closeOutside)
    }
  }, [])
  const onKeyDown = (event) => {
    if (submitting) return
    if (event.key === 'ArrowUp' && (event.target.selectionStart === 0 || !objective)) {
      if (history.length === 0) return
      event.preventDefault()
      if (historyIndex === -1) {
        draftRef.current = draft
        const nextIndex = history.length - 1
        setHistoryIndex(nextIndex)
        setDraft(history[nextIndex])
      } else if (historyIndex > 0) {
        const nextIndex = historyIndex - 1
        setHistoryIndex(nextIndex)
        setDraft(history[nextIndex])
      }
    } else if (event.key === 'ArrowDown' && historyIndex !== -1) {
      event.preventDefault()
      if (historyIndex < history.length - 1) {
        const nextIndex = historyIndex + 1
        setHistoryIndex(nextIndex)
        setDraft(history[nextIndex])
      } else {
        setHistoryIndex(-1)
        setDraft(draftRef.current ?? { text: '', target: null })
      }
    }
  }
  const submit = async (event) => {
    event.preventDefault()
    if (!objective.trim() || sending.current || !configured || invalidAddress) return
    if (targetChanged) { setReview({ original: draft.target, destination }); return }
    const text = objective.trim()
    const submittedDraft = draft
    const submittedTarget = draft.target ?? destination
    sending.current = true
    setSubmitting(true)
    try {
      const result = await onTask(text, submittedTarget)
      setNotice({ ...result, target: submittedTarget, id: ++noticeSequence.current })
      if (!result.accepted) return
      setHistory(prev => [...prev.filter(item => item.text !== text || item.target.key !== submittedTarget.key), { text, target: submittedTarget }].slice(-20))
      setHistoryIndex(-1)
      draftRef.current = null
      setDraft(previous => previous === submittedDraft ? { text: '', target: null } : previous)
    } catch (cause) {
      setNotice({ accepted: false, uncertain: true, message: String(cause.message ?? cause), target: submittedTarget, id: ++noticeSequence.current })
    } finally {
      sending.current = false
      setSubmitting(false)
    }
  }
  return (
    <footer className="statusbar">
      <div className="status-tools">
        <div className="session-details">
          <span className={`live-dot ${state.suspended ? 'off' : ''}`} />
          <span>{state.suspended ? 'Session suspended' : 'Session live'}</span>
          <i />
          <span>{state.browser.tabs.length} tabs · {Number.isFinite(state.hourlyCost) ? `$${state.hourlyCost.toFixed(2)}/hr (estimate)` : 'Cost not measured'}</span>
          <i />
          <span>{active ? 'RJ is working one objective' : "RJ's queue · one bounded objective"}</span>
        </div>
        <div className="status-tool-actions">
          <button
            type="button"
            disabled={connecting || codex.status === 'connecting'}
            onClick={async () => {
              setConnecting(true)
              try {
                await onConnectCodex()
              } finally {
                setConnecting(false)
              }
            }}
          >{connecting ? 'Opening…' : codex.connected ? 'Codex connected' : 'Connect Codex'}</button>
          <button type="button" onClick={onSuspend}>{state.suspended ? <RefreshCw size={16} /> : <Pause size={16} />}{state.suspended ? 'Resume' : 'Suspend'}</button>
        </div>
      </div>
      <form className="command-dock" onSubmit={submit}>
        {addressed ? <div className="dock-address"><span>{roomAddress.recipientAgentIds.map(id => `@${agentName(id)}`).join(', ') || 'Choose recipients'}{roomAddress.replyTo ? ` · Reply to ${roomAddress.replyLabel}` : ''}{invalidAddress ? ' · inactive or missing recipients' : ''}</span>
          {roomAddress.replyTo ? <button type="button" onClick={() => setRoomAddress(previous => ({ taskId: previous.taskId, recipientAgentIds: previous.recipientAgentIds }))}>Clear reply</button> : null}
          <button type="button" onClick={() => setRoomAddress(null)}>General guidance</button></div> : null}
        <div className="command-agent"><AgentAvatar agentId="ceo" name="RJ" /><span><strong>RJ · CEO</strong><small>One objective at a time</small></span></div>
        <div className="dock-composer">
          <details ref={targetDisclosure} className="dock-target" key={notice?.id ?? 'none'} open={notice ? true : undefined}
            onKeyDown={event => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus() } }}>
            <summary id="dock-target-label" title={`${targetMode} · ${targetObjective}`}>{targetChanged ? 'Destination changed · ' : ''}{targetMode} · {targetObjective}{notice ? notice.accepted ? ' · Last send accepted' : ' · Review last send' : ''}</summary>
            <div className="dock-target-detail">
              <strong>{targetObjective}</strong>
              {targetTask || addressed ? <code>Task ID: {targetTask?.taskId ?? roomAddress.taskId}</code> : null}
              <p>{addressed
                ? invalidAddress ? 'Sending is blocked. Select eligible recipients on an active task, or explicitly return to general guidance.'
                  : 'Sends only to the selected participants on this task at their next safe boundary. It does not restart finished assignments.'
                : active ? 'General guidance targets this task, independent of the room you are viewing. To guide another task, use its task controls or address its participants.'
                  : 'Starts a new bounded objective through RJ. Viewing a completed task does not continue it; use that task’s Continue control for an explicit continuation.'}</p>
              {targetChanged ? <p>Your draft has a different destination. Review it before sending.</p> : null}
              {notice ? <section className="dock-result" aria-label="Last dock result">
                <strong>{notice.accepted ? 'Sent' : notice.uncertain ? 'Send unconfirmed' : 'Not sent'} · {notice.target.label}</strong>
                <p>{notice.message}</p>
                {notice.uncertain ? <p>Inspect task history before retrying: the server may have accepted the request. Nothing is retried automatically.</p> : null}
                <button type="button" onClick={() => setNotice(null)}>Dismiss result</button>
              </section> : null}
            </div>
          </details>
          <input
            aria-label="RJ queue objective"
            aria-describedby="dock-target-label"
            maxLength={active || addressed ? 4096 : 16384}
            placeholder={configured ? addressed ? 'Guide the selected participants…' : active ? 'Guide the current task…' : 'Give RJ one bounded objective…' : 'Connect a model to start work'}
            disabled={!configured || invalidAddress}
            value={objective}
            onChange={(event) => {
              const text = event.target.value
              setDraft(previous => ({ text, target: text ? previous.target ?? destination : null }))
              if (historyIndex !== -1) setHistoryIndex(-1)
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        <button type="submit" aria-label={targetChanged ? 'Review destination' : addressed ? 'Send task guidance' : active ? 'Guide current task' : 'Queue objective'} disabled={!configured || submitting || !objective.trim() || invalidAddress}><Send size={21} /></button>
      </form>
      {review ? <DraftDestinationDialog review={review} destination={destination}
        onClose={() => setReview(null)} onRefresh={() => setReview(previous => ({ ...previous, destination }))}
        onConfirm={() => {
          if (review.destination.key !== destination.key) return
          setDraft(previous => previous.target?.key === review.original.key ? { ...previous, target: review.destination } : previous)
          setReview(null)
        }} /> : null}
    </footer>
  )
}

function ComposerUnavailable({ onRefresh }) {
  return <footer className="statusbar conversation-unavailable" aria-label="Conversation composer unavailable">
    <div className="conversation-unavailable-card" role="status">
      <strong>Composer unavailable</strong>
      <span>Chimera has not confirmed this workspace/operator identity. Sending is disabled until the scoped workspace state is available.</span>
      <button type="button" onClick={() => void onRefresh?.()}>Refresh workspace</button>
    </div>
  </footer>
}

function DecisionDialog({ decision, close, act }) {
  const { blocked } = useContext(DecisionResponsesContext)
  const dialog = useRef(null)
  useEffect(() => {
    if (!decision) return undefined
    const previousFocus = document.activeElement
    const element = dialog.current
    element.showModal()
    return () => { element.close(); if (previousFocus?.isConnected) previousFocus.focus?.() }
  }, [decision])
  if (!decision) return null
  const review = decision.actionDiff?.review
  const agent = decision.agent?.agentId
    ? decision.agent.agentId.split('-').map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(' ')
    : 'Unknown agent'
  return (
      <dialog ref={dialog} className="decision-dialog decision-review-dialog" aria-labelledby="decision-title"
        onCancel={event => { event.preventDefault(); close() }}
        onKeyDown={event => {
          if (event.key !== 'Tab') return
          const buttons = [...event.currentTarget.querySelectorAll('button:not(:disabled)')]
          const first = buttons[0], last = buttons.at(-1)
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
        }}
        onClick={event => {
          if (event.target !== event.currentTarget) return
          const bounds = event.currentTarget.getBoundingClientRect()
          if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close()
        }}>
        <button className="dialog-close" type="button" aria-label="Close" autoFocus onClick={close}><X size={18} /></button>
        <div className="dialog-heading"><span className="send-icon"><Send size={22} /></span><div><h2 id="decision-title">{decision.title}</h2><p>{decision.detail}</p></div></div>
        {review?.fields ? (
          <dl className="decision-review" aria-label="Exact action target">
            {Object.entries(review.fields).map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{label === 'Expected head SHA' ? <code>{String(value)}</code> : String(value)}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        <div className="dialog-meta"><span>Agent</span><strong>{agent}</strong><span>Policy</span><strong>Human confirmation</strong></div>
        <DecisionResponse actionId={decision.actionId} />
        <div className="dialog-actions"><button type="button" disabled={blocked(decision.actionId)} onClick={() => act('deny')}>Deny</button><button className="approve" type="button" disabled={blocked(decision.actionId)} onClick={() => act('approve')}>Approve</button></div>
      </dialog>
  )
}

export function App() {
  const [state, setState] = useState(null)
  const [activeSection, setActiveSection] = useState('Queue')
  const [setupOpen, setSetupOpen] = useState(false)
  const [setupState, setSetupState] = useState(null)
  useEffect(() => { setActiveSection(initialClientSection(window.location.search)) }, [])
  const [roomAddress, setRoomAddress] = useState(null)
  const [navigationTargetVersion, setNavigationTargetVersion] = useState(0)
  const [frame, setFrame] = useState({ data: null, width: 1600, height: 900 })
  const [streamStatus, setStreamStatus] = useState('Connecting to live browser…')
  const [toast, setToast] = useState('')
  const [error, setError] = useState('')
  const [reviewing, setReviewing] = useState(null)
  const [operatorReady, setOperatorReady] = useState(false)
  const [railCollapsed, setRailCollapsed] = useState(true)
  const socket = useRef(null)
  const refreshedLogin = useRef(null)
  const latestRefresh = useRef(null)
  const setupReturnTarget = useRef(null)
  const composerTargetRef = useRef(null)

  const refresh = useCallback(async () => {
    const request = { confirmed: false }
    latestRefresh.current = request
    try {
      const snapshot = await api('/api/state', { cache: 'no-store' })
      if (latestRefresh.current === request) {
        setState(snapshot)
        setError('')
        request.confirmed = true
      }
    } catch (cause) {
      if (latestRefresh.current === request) setError(cause.message)
    }
    // An older read cannot overwrite newer state or report it as failed. A
    // newer read still pending/failed leaves freshness unconfirmed, not the write.
    return latestRefresh.current.confirmed
  }, [])
  const decisionResponses = useDecisionResponses(refresh)

  useEffect(() => {
    let stopped = false
    let timer = null
    let polling = false
    const poll = async () => {
      if (stopped || polling) return
      polling = true
      clearTimeout(timer)
      try {
        await initializeOperatorSession()
        if (stopped) return
        setOperatorReady(true)
        await refresh()
      } catch (cause) {
        if (!stopped) { setOperatorReady(false); setError(browserCommandFailureMessage(cause)) }
      } finally {
        polling = false
        scheduleNext()
      }
    }
    const scheduleNext = () => {
      if (stopped) return
      const interval = typeof document !== 'undefined' && document.hidden ? 3500 : 900
      timer = setTimeout(() => { if (!stopped) void poll() }, interval)
    }
    void poll()
    const onVisibilityChange = () => {
      if (typeof document !== 'undefined' && !document.hidden && !stopped) {
        void poll()
      }
    }
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      stopped = true
      clearTimeout(timer)
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [refresh])

  useEffect(() => {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    let closed = false
    let retry
    const connect = () => {
      if (closed) return
      const ws = new WebSocket(`${protocol}//${location.host}/api/browser/stream`)
      socket.current = ws
      ws.onopen = () => setStreamStatus('Waiting for Chromium frame…')
      ws.onmessage = (event) => {
        const message = JSON.parse(event.data)
        if (message.type === 'frame') {
          setFrame(message)
          setStreamStatus('Live')
        } else if (message.type === 'suspended') {
          setFrame((current) => ({ ...current, data: null }))
        } else if (message.type === 'input-denied') {
          setToast((message.reason ?? 'INPUT_DENIED').replaceAll('_', ' ').toLowerCase())
        } else if (message.type === 'error') {
          setToast((message.error ?? 'BROWSER_STREAM_ERROR').replaceAll('_', ' ').toLowerCase())
        }
      }
      ws.onclose = () => {
        setStreamStatus('Browser disconnected — reconnecting…')
        setFrame((current) => ({ ...current, data: null }))
        socket.current = null
        if (!closed) retry = setTimeout(connect, 800)
      }
    }
    if (operatorReady) connect()
    return () => {
      closed = true
      clearTimeout(retry)
      socket.current?.close()
    }
  }, [operatorReady])

  useEffect(() => {
    if (!toast) return undefined
    const timer = setTimeout(() => setToast(''), 2200)
    return () => clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    const login = state?.auth?.codex?.login
    if (login?.status !== 'succeeded' || refreshedLogin.current === login.loginId) return
    refreshedLogin.current = login.loginId
    void post('/api/auth/codex/refresh')
      .then(refresh)
      .then(() => setToast('ChatGPT subscription connected'))
      .catch((cause) => setToast(cause.message.replaceAll('_', ' ').toLowerCase()))
  }, [state?.auth?.codex?.login?.loginId, state?.auth?.codex?.login?.status, refresh])

  const command = async (body) => {
    try {
      const result = await post('/api/browser/human', body)
      if (result.status === 'denied') setToast(result.reason.replaceAll('_', ' ').toLowerCase())
      await refresh()
      return result
    } catch (cause) {
      setToast(browserCommandFailureMessage(cause))
      return { status: 'denied', reason: 'BROWSER_COMMAND_UNAVAILABLE' }
    }
  }

  const control = async () => {
    try {
      await post(state.controller.type === 'human' ? '/api/control/release' : '/api/control/take')
      await refresh()
    } catch (cause) { setToast(browserCommandFailureMessage(cause)) }
  }

  const onOutcomeAction = useCallback((action) => {
    const focusTaskControl = (selector, message) => {
      const element = typeof document === 'undefined' ? null : document.querySelector(selector)
      if (typeof HTMLElement !== 'undefined' && element instanceof HTMLElement) {
        element.focus()
        setToast(message)
        return true
      }
      setToast(`${message} The selected task controls are not currently available.`)
      return false
    }
    const focusTaskControlButton = (predicate, message) => {
      const button = typeof document === 'undefined'
        ? null
        : [...document.querySelectorAll('.task-controls button')].find(candidate => predicate(candidate))
      if (typeof HTMLElement !== 'undefined' && button instanceof HTMLElement) {
        button.focus()
        setToast(message)
        return true
      }
      setToast(`${message} No matching saved action is available.`)
      return false
    }
    if (action === 'inspect') return
    if (action === 'continue' || action === 'retry') {
      focusTaskControl('input[aria-label="Continuation objective"], input[aria-label="Task guidance"]',
        action === 'retry'
          ? 'No automatic replay was sent. Enter an explicit continuation or guidance objective and review it before sending.'
          : 'Enter an explicit continuation objective, then review and send it from Task controls.')
      return
    }
    if (action === 'resume-queued') {
      focusTaskControlButton(button => button.textContent?.trim() === 'Resume queued task',
        'Review the saved task destination, then click Resume queued task to send the server-validated request.')
      return
    }
    if (action === 'reconcile') {
      focusTaskControlButton(button => button.textContent?.trim() === 'Check saved outcome',
        'Inspect the saved receipt before deciding. No task request was retried.')
      return
    }
    if (action === 'reconnect') {
      setActiveSection('Settings')
      setToast('Open Connections to reconnect the required provider. This does not resume or replay the task.')
      return
    }
    setToast('No automatic task action was sent. Inspect the selected task before continuing.')
  }, [])

  const selectModel = async (selection) => {
    try {
      await post('/api/models/select', selection)
      setToast('RJ model updated')
    } catch (cause) {
      setToast(cause.message.replaceAll('_', ' ').toLowerCase())
    } finally {
      await refresh()
    }
  }

  const checkModel = async (selection) => {
    try {
      const result = await post('/api/models/check', selection)
      setToast(result.availability === 'access-eligible'
        ? 'AWS access is eligible; this model needs its specialist adapter'
        : result.availability === 'verified-manual' ? 'Model access verified' : 'AWS model access is not available')
    } catch (cause) {
      setToast(cause.message.replaceAll('_', ' ').toLowerCase())
    } finally {
      await refresh()
    }
  }

  const submitTask = async (objective, expectedDestination) => {
    const destination = dockDestination(state, roomAddress)
    if (destination.key !== expectedDestination?.key) return { accepted: false, message: 'Destination changed before submission. Review the current destination; nothing was sent.' }
    const submittedAddress = roomAddress
    let acknowledgement
    try {
      if (destination.kind === 'message') {
        const result = await post('/api/tasks/message', { taskId: destination.taskId, recipientAgentIds: destination.recipientAgentIds,
          ...(destination.replyTo ? { replyTo: destination.replyTo } : {}), content: objective })
        acknowledgement = result.acknowledgement
        setRoomAddress(previous => previous === submittedAddress ? { taskId: previous.taskId, recipientAgentIds: previous.recipientAgentIds } : previous)
      } else if (destination.kind === 'steer') await post('/api/tasks/steer', { taskId: destination.taskId, content: objective })
      else await post('/api/conversations/messages', { content: objective, recipientAgentId: 'ceo' })
    } catch (cause) {
      return { accepted: false, uncertain: true, message: cause.message.replaceAll('_', ' ').toLowerCase() }
    }
    const refreshed = await refresh()
    const message = acknowledgement ?? (destination.kind === 'objective' ? 'Task queued for RJ' : 'Guidance saved for the next safe task boundary')
    return { accepted: true, message: refreshed ? message : `${message}. The latest workspace state could not be confirmed at acknowledgement; the send was accepted. Do not resend it to refresh the view.` }
  }

  const submitComposer = async (request) => {
    const result = await post(request.endpoint, request.body)
    const resultMessage = typeof result?.message === 'string' ? result.message : 'Request accepted.'
    try {
      const refreshed = await refresh()
      return refreshed === false ? { ...result, message: `${resultMessage} The latest workspace state could not be confirmed; do not resend.` } : result
    } catch {
      return { ...result, message: `${resultMessage} The latest workspace state could not be confirmed; do not resend.` }
    }
  }

  const lookupComposer = async (requestId, target) => {
    const path = target?.mode === 'ask' ? `/api/conversations/asks/${encodeURIComponent(requestId)}` : `/api/tasks/receipts/${encodeURIComponent(requestId)}`
    return api(path, { cache: 'no-store' })
  }

  const connectCodex = async () => {
    try {
      await startCodexBrowserLogin({
        humanControl: state.controller.type === 'human',
      })
      await refresh()
      setToast('Finish ChatGPT sign-in in the new browser tab')
    } catch (cause) {
      setToast(cause.message.replaceAll('_', ' ').toLowerCase())
      throw cause
    }
  }

  const connectGitHub = async () => {
    try {
      const result = await post('/api/github/auth/login')
      await refresh()
      setToast(result.connected ? `GitHub connected as ${result.login}` : 'GitHub authorization was not completed')
      return result
    } catch (cause) {
      setToast(cause.message.replaceAll('_', ' ').toLowerCase())
      throw cause
    }
  }

  const openSetup = (context = {}) => {
    const contextTarget = context?.target && typeof context.target === 'object' && typeof context.target.mode === 'string' ? context.target : null
    const contextDraftKey = typeof context?.draftKey === 'string' ? context.draftKey : null
    const composerTarget = contextTarget ?? composerTargetRef.current ?? null
    composerTargetRef.current = composerTarget
    setupReturnTarget.current = { section: activeSection, roomAddress, taskId: roomAddress?.taskId ?? null, agentId: setupState?.agentId ?? null, setupStep: setupState?.step ?? 0,
      ...(composerTarget ? { composerTarget: structuredClone(composerTarget) } : {}), ...(contextDraftKey ? { draftKey: contextDraftKey } : {}) }
    setSetupState(current => current ?? {})
    setSetupOpen(true)
  }

  const openSetupConnections = (context = {}) => {
    const contextTarget = context?.target && typeof context.target === 'object' && typeof context.target.mode === 'string' ? context.target : null
    const contextDraftKey = typeof context?.draftKey === 'string' ? context.draftKey : null
    const composerTarget = contextTarget ?? composerTargetRef.current ?? setupReturnTarget.current?.composerTarget ?? null
    composerTargetRef.current = composerTarget
    if (!setupReturnTarget.current) {
      setupReturnTarget.current = { section: activeSection, roomAddress, taskId: roomAddress?.taskId ?? null, agentId: setupState?.agentId ?? null, setupStep: setupState?.step ?? 0,
        ...(composerTarget ? { composerTarget: structuredClone(composerTarget) } : {}), ...(contextDraftKey ? { draftKey: contextDraftKey } : {}) }
    } else if (composerTarget) {
      setupReturnTarget.current = { ...setupReturnTarget.current, composerTarget: structuredClone(composerTarget), ...(contextDraftKey ? { draftKey: contextDraftKey } : {}) }
    }
    setSetupOpen(false)
    setActiveSection('Settings')
  }

  const returnToSetup = () => {
    const target = setupReturnTarget.current
    if (!target) return
    setActiveSection(target.section)
    setRoomAddress(target.roomAddress)
    setSetupOpen(true)
  }

  const closeSetup = () => {
    const target = setupReturnTarget.current
    if (target) {
      setActiveSection(target.section)
      setRoomAddress(target.roomAddress)
    }
    setupReturnTarget.current = null
    setSetupOpen(false)
  }

  const completeSetup = async () => {
    await refresh()
    setSetupState(null)
    setupReturnTarget.current = null
    setSetupOpen(false)
  }

  const discoverAgents = () => post('/api/agents/discover')

  const importAgents = async (selection) => {
    const result = await post('/api/agents/import', selection)
    await refresh()
    setToast(`${result.imported.length} agent${result.imported.length === 1 ? '' : 's'} registered with Chimera`)
    return result
  }

  const importMainAgent = async (selection) => {
    const result = await post('/api/agents/main/import', selection)
    await refresh()
    setToast(`RJ continuity imported · ${result.continuity.report.persona.files} persona files`)
    return result
  }

  const agentLifecycle = async (agentId, action) => {
    try {
      const result = await post(`/api/agents/workers/${action}`, { agentId })
      const workspaceRefreshed = await refresh()
      setToast(`${agentId} worker ${result.state}`)
      return { ...result, workspaceRefreshed }
    } catch (cause) {
      setToast(cause.message.replaceAll('_', ' ').toLowerCase())
      throw cause
    }
  }

  const agentAccess = async (agentId, profileId) => {
    try {
      const result = await post('/api/agents/access', { agentId, profileId })
      const workspaceRefreshed = await refresh()
      setToast(`${agentId} now uses ${result.label}`)
      return { ...result, workspaceRefreshed }
    } catch (cause) {
      setToast(cause.message.replaceAll('_', ' ').toLowerCase())
      throw cause
    }
  }

  const agentModel = async (agentId, preference) => {
    try {
      const result = await post('/api/agents/model', { agentId, ...preference })
      const workspaceRefreshed = await refresh()
      setToast(`${agentId === 'ceo' ? 'RJ' : agentId} model set to ${result.mode === 'auto' ? 'Chimera Auto' : result.mode}`)
      return { ...result, workspaceRefreshed }
    } catch (cause) {
      setToast(cause.message.replaceAll('_', ' ').toLowerCase())
      throw cause
    }
  }

  const removeAgent = async (agentId) => {
    try {
      const result = await post('/api/agents/remove', { agentId })
      const workspaceRefreshed = await refresh()
      setToast(`${result.displayName} removed from the Chimera team`)
      return { ...result, workspaceRefreshed }
    } catch (cause) {
      setToast(cause.message.replaceAll('_', ' ').toLowerCase())
      throw cause
    }
  }

  const registerProject = async (input) => {
    try {
      const result = await post('/api/projects', input)
      await refresh()
      setToast(`${result.name} is ready for RJ`)
      return result
    } catch (cause) {
      setToast(cause.message.replaceAll('_', ' ').toLowerCase())
      throw cause
    }
  }

  const submitProjectTask = async (input) => {
    try {
      const result = await post('/api/projects/tasks', input)
      let refreshed = true
      try { refreshed = (await refresh()) !== false } catch { refreshed = false }
      setToast('Project task queued. RJ will start it when the executor is available.')
      return refreshed ? result : { ...result, refreshFailed: true, message: 'Project task accepted. The latest workspace state could not be confirmed; do not resend.' }
    } catch (cause) {
      setToast(cause.message.replaceAll('_', ' ').toLowerCase())
      throw cause
    }
  }

  const reviewProject = async (taskId) => {
    try {
      const result = await post('/api/projects/review', { taskId })
      await refresh()
      return result
    } catch (cause) {
      setToast(cause.message.replaceAll('_', ' ').toLowerCase())
      throw cause
    }
  }

  const commitProject = async (input) => {
    try {
      const result = await post('/api/projects/commit', input)
      await refresh()
      setToast('Reviewed project changes committed')
      return result
    } catch (cause) {
      setToast(cause.message.replaceAll('_', ' ').toLowerCase())
      throw cause
    }
  }

  const decision = async (selected, action) => {
    if (action === 'review') return setReviewing(selected)
    if (await decisionResponses.respond(selected, action)) {
      setReviewing(current => current?.actionId === selected.actionId ? null : current)
    }
  }

  const suspend = async () => {
    await post(state.suspended ? '/api/session/resume' : '/api/session/suspend')
    if (!state.suspended) setFrame((current) => ({ ...current, data: null }))
    await refresh()
    if (state.suspended) location.reload()
  }

  const sendInput = useCallback((message) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(message))
    else setToast('Browser is reconnecting. Input was not sent.')
  }, [])

  const humanControl = state?.controller.type === 'human'
  const shellClass = useMemo(() => `app-shell ${humanControl ? 'human-control' : 'agent-control'}${railCollapsed ? ' rail-collapsed' : ''}`, [humanControl, railCollapsed])
  const roomComposerTarget = roomAddress?.taskId && state.draftScope?.workspaceId && state.draftScope?.operatorId ? {
    mode: 'guidance', workspaceId: state.draftScope.workspaceId, operatorId: state.draftScope.operatorId,
    conversationId: `task:${roomAddress.taskId}`, taskId: roomAddress.taskId,
    recipientAgentIds: roomAddress.recipientAgentIds ?? [], replyTo: roomAddress.replyTo ?? null,
    ...(roomAddress.replyLabel ? { replyLabel: roomAddress.replyLabel } : {}),
  } : roomAddress?.agentId && state.draftScope?.workspaceId && state.draftScope?.operatorId ? {
    mode: 'ask', workspaceId: state.draftScope.workspaceId, operatorId: state.draftScope.operatorId,
    conversationId: roomAddress.conversationId ?? (roomAddress.agentId === 'ceo' ? 'main' : `agent:${roomAddress.agentId}`),
    recipientAgentIds: [roomAddress.agentId], requestedSpecialistAgentId: roomAddress.agentId,
  } : null
  // A live Queue channel owns navigation while the setup overlay is closed.
  // A saved setup target is only authoritative while returning through that
  // overlay; otherwise it could pin the composer to an older agent channel.
  const navigationComposerTarget = setupOpen
    ? setupReturnTarget.current?.composerTarget ?? roomComposerTarget
    : roomComposerTarget ?? setupReturnTarget.current?.composerTarget ?? null

  if (!state) return <OperatorRecovery error={error} onRetry={refresh} />
  return (
    <DecisionResponsesContext.Provider value={decisionResponses}><TaskControlSession scope={state?.draftScope}><ProjectWorkspaceSession scope={state?.draftScope}><MediaSession><AgentUpdatesSession><QueueSession>
    <div className={shellClass}>
      <WorkspaceNavigation activeSection={activeSection} pendingDecisions={state.decisions?.length ?? 0} onNavigate={section => {
        setActiveSection(section)
        setNavigationTargetVersion(current => current + 1)
        if (!setupOpen) setRoomAddress(current => current
          ? { ...current, ...(current.taskId ? { recipientAgentIds: [], replyTo: null, replyLabel: null } : {}) }
          : null)
      }} />
      <TopBar state={state} onControl={control} onModelSelect={selectModel} railCollapsed={railCollapsed} onToggleRail={() => setRailCollapsed((current) => !current)} />
      {error ? <div className="connection-alert" role="alert">Connection problem: {browserCommandFailureMessage(error)}. Displayed state may be stale.</div> : null}
      <MainWorkspace
        activeSection={activeSection}
        state={state}
        frame={frame}
        streamStatus={streamStatus}
        humanCommand={command}
        sendInput={sendInput}
        notify={setToast}
        onNavigate={setActiveSection}
        onOpenSetup={openSetup}
        onOpenConnections={openSetupConnections}
        onReturnToSetup={returnToSetup}
        setupReturnTarget={setupReturnTarget.current}
        onDecision={decision}
        onOutcomeAction={onOutcomeAction}
        onConnectCodex={connectCodex}
        onConnectGitHub={connectGitHub}
        onModelSelect={selectModel}
        onModelCheck={checkModel}
        onDiscoverAgents={discoverAgents}
        onImportAgents={importAgents}
        onImportMainAgent={importMainAgent}
        onAgentLifecycle={agentLifecycle}
        onAgentAccess={agentAccess}
        onRemoveAgent={removeAgent}
        onAgentModel={agentModel}
        registerProject={registerProject}
        submitProjectTask={submitProjectTask}
        reviewProject={reviewProject}
        commitProject={commitProject}
        refresh={refresh}
        roomAddress={roomAddress}
        setRoomAddress={setRoomAddress}
      />
      {setupOpen ? <AgentSetupWizard
        state={state}
        onClose={closeSetup}
        onComplete={completeSetup}
        refresh={refresh}
        initialState={setupState}
        onStateChange={setSetupState}
        onOpenConnections={openSetupConnections}
        onDiscoverAgents={discoverAgents}
        onImportAgents={importAgents}
        onImportMainAgent={importMainAgent}
      /> : null}
      <RightRail state={state} onDecision={decision} railCollapsed={railCollapsed} />
      {state.draftScope?.workspaceId && state.draftScope?.operatorId ? <ConversationComposer
        state={state}
        onSubmit={submitComposer}
        onLookup={lookupComposer}
        onOpenSetup={openSetup}
        onConnectCodex={connectCodex}
        onSuspend={suspend}
        onTargetChange={({ target }) => { composerTargetRef.current = target }}
        initialTarget={navigationComposerTarget}
        initialTargetVersion={navigationTargetVersion}
      /> : <ComposerUnavailable onRefresh={refresh} />}
      {toast ? <div className="toast" role="status">{toast}</div> : null}
      <DecisionDialog decision={reviewing} close={() => setReviewing(null)} act={(action) => decision(reviewing, action)} />
    </div>
    </QueueSession></AgentUpdatesSession></MediaSession></ProjectWorkspaceSession></TaskControlSession></DecisionResponsesContext.Provider>
  )
}
