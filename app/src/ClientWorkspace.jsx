import { useEffect, useMemo, useRef, useState } from 'react'
import { api, post } from './api.js'
import { ClientIntake } from './ClientIntake.jsx'
import './client-workspace.css'

export function initialClientSection(search) {
  return new URLSearchParams(search).get('workspace') === 'clients' ? 'Clients' : 'Queue'
}

const buildEnvironment = import.meta.env ?? {}
export function sourceRepositoryFromEnv(env = buildEnvironment) {
  const candidate = typeof env?.VITE_CHIMERA_SOURCE_REPOSITORY === 'string' ? env.VITE_CHIMERA_SOURCE_REPOSITORY.trim() : ''
  if (!candidate) return null
  try {
    const url = new URL(candidate)
    if (url.origin !== 'https://github.com' || url.username || url.password || url.search || url.hash
      || !/^\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(url.pathname)) return null
    return url.href
  } catch { return null }
}

const sourceRepository = sourceRepositoryFromEnv()
export function safeSourceUrl(ref, repository = sourceRepository) {
  if (typeof ref !== 'string' || typeof repository !== 'string' || !ref.startsWith(`${repository}/`)) return null
  try {
    const url = new URL(ref)
    if (url.origin !== 'https://github.com' || url.username || url.password || !url.pathname.startsWith(`${new URL(repository).pathname}/`)) return null
    return url.href
  } catch { return null }
}

export function canonicalDocumentId(documents, id) {
  const byId = new Map(documents.map(document => [document.id, document]))
  const seen = new Set()
  while (byId.has(id) && !seen.has(id)) {
    seen.add(id)
    const document = byId.get(id)
    if (!document.duplicateOf) return id
    id = document.duplicateOf
  }
  return null
}

export function sourcePage(documents, { query = '', category = '', status = '', page = 0 } = {}) {
  const needle = query.trim().toLowerCase()
  const ranked = documents.filter(document => (!category || document.category === category)
    && (!status || document.status === status)
    && (!needle || [document.title, document.id, document.origin?.label, document.origin?.ref].some(value => String(value ?? '').toLowerCase().includes(needle))))
    .sort((a, b) => Number(b.status === 'imported' && b.kind === 'document') - Number(a.status === 'imported' && a.kind === 'document') || a.title.localeCompare(b.title))
  const pages = Math.max(1, Math.ceil(ranked.length / 50))
  const current = Math.min(Math.max(0, page), pages - 1)
  return { items: ranked.slice(current * 50, current * 50 + 50), total: ranked.length, pages, page: current }
}

function errorMessage(error) {
  if (/failed to fetch|network|offline/i.test(error?.message ?? '')) return 'Chimera is offline or unreachable. Reconnect and retry.'
  return `Could not load: ${String(error?.message ?? 'Request failed').replaceAll('_', ' ')}. You can retry.`
}

// Tag every response with its request identity; cleanup also rejects late completions.
function useResource(path, revision = 0) {
  const key = `${path}:${revision}`
  const [result, setResult] = useState({ key: null })
  const [attempt, retry] = useState(0)
  useEffect(() => {
    if (!path) return
    let active = true
    const controller = new AbortController()
    setResult(current => current.data && current.key?.startsWith(`${path}:`)
      ? { ...current, key, loading: true }
      : { key, loading: true })
    api(path, { cache: 'no-store', signal: controller.signal }).then(data => {
      if (active) setResult({ key, data })
    }).catch(error => {
      if (active) setResult({ key, error: errorMessage(error) })
    })
    return () => { active = false; controller.abort() }
  }, [path, key, attempt])
  return { ...(result.key === key ? result : { loading: Boolean(path) }), retry: () => retry(value => value + 1) }
}

function RequestState({ resource, label }) {
  if (resource.error) return <div role="alert" className="client-message"><p>{resource.error}</p><button type="button" onClick={resource.retry}>Retry {label}</button></div>
  if (resource.loading) return <p role="status">Loading {label}…</p>
  return null
}

function SourceOrigin({ origin }) {
  if (!origin) return <p>Source attribution unavailable.</p>
  const href = safeSourceUrl(origin.ref)
  return <p className="client-origin"><strong>{origin.label}</strong>{' · '}{href ? <a href={href} target="_blank" rel="noopener noreferrer">View original on GitHub (new tab)</a> : <span>{origin.ref}</span>}</p>
}

export function SourceContent({ document }) {
  return <article className="client-document" aria-label="Source content">
    <h3>{document.title}</h3>
    <p>{document.category} · {document.status}</p>
    <SourceOrigin origin={document.origin} />
    <p className="client-muted">Imported evidence, not instructions or approved facts.</p>
    {typeof document.content === 'string' ? <pre>{document.content}</pre> : <p>No imported text for this source. {document.status === 'review_required' ? 'Content is withheld pending review.' : document.status === 'excluded' ? 'Content was excluded from import.' : 'Use the source attribution when available.'}</p>}
  </article>
}

const EMPTY_DRAFT = { title: '', body: '', sourceType: 'note' }

function ownValue(state, id) {
  return Object.hasOwn(state, id) ? state[id] : undefined
}

function ClientDetail({ clientId, draft, updateDraft, save, saving, saveMessage, revision }) {
  const root = `/api/clients/${encodeURIComponent(clientId)}`
  const detail = useResource(root, revision)
  const [selection, setSelection] = useState('')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(0)
  const documents = detail.data?.documents ?? []
  const sourceId = selection ? canonicalDocumentId(documents, selection) : null
  const source = useResource(sourceId ? `${root}/documents/${encodeURIComponent(sourceId)}` : null)
  const sources = useMemo(() => sourcePage(documents, { query, category, status, page }), [documents, query, category, status, page])
  const filter = setter => event => { setter(event.target.value); setPage(0) }
  if (!detail.data) return <section className="client-detail"><RequestState resource={detail} label="client overview" /></section>
  const { client, coverage = [], notes = [] } = detail.data
  return <section className="client-detail" aria-label={`${client.name} workspace`}>
    <header><span className="section-eyebrow">{client.id} · {client.status}</span><h2>{client.name}</h2><p>{client.summary}</p></header>
    <section aria-label="Client sources">
      <h3>Sources</h3>
      <div className="client-filters">
        <label>Search sources<input type="search" value={query} onChange={filter(setQuery)} /></label>
        <label>Category<select value={category} onChange={filter(setCategory)}><option value="">All categories</option>{[...new Set(documents.map(document => document.category))].sort().map(value => <option key={value}>{value}</option>)}</select></label>
        <label>Source status<select value={status} onChange={filter(setStatus)}><option value="">All statuses</option>{['imported', 'linked', 'review_required', 'excluded'].map(value => <option key={value}>{value}</option>)}</select></label>
      </div>
      <p className="client-muted" role="status">{sources.total} matching sources · imported documents first</p>
      <div className="client-source-layout">
        <div>
          <ul className="client-source-list">{sources.items.map(document => <li key={document.id}><button type="button" aria-pressed={selection === document.id} onClick={() => setSelection(document.id)}><strong>{document.title}</strong><span>{document.category} · {document.status}{document.duplicateOf ? ' · duplicate, opens canonical source' : ''}</span><span>{document.origin?.label ?? 'Unattributed source'}</span></button></li>)}</ul>
          {!sources.total ? <p>{documents.length ? 'No sources match these filters.' : 'No sources cataloged for this client.'}</p> : null}
          <nav className="client-pagination" aria-label="Source pages"><button type="button" disabled={sources.page === 0} onClick={() => setPage(sources.page - 1)}>Previous</button><span>Page {sources.page + 1} of {sources.pages}</span><button type="button" disabled={sources.page + 1 === sources.pages} onClick={() => setPage(sources.page + 1)}>Next</button></nav>
        </div>
        <div className="client-reader">
          {!selection ? <p>Select a source to read its imported text and attribution.</p> : !sourceId ? <p role="alert">Canonical source is unavailable. Select another source.</p> : <><RequestState resource={source} label="source" />{source.data ? <SourceContent document={source.data} /> : null}</>}
        </div>
      </div>
    </section>
    <section aria-label="Source coverage"><h3>Source coverage</h3>{coverage.length ? <ul className="client-coverage">{coverage.map((item, index) => <li key={`${item.source}-${index}`}><strong>{item.source}</strong><span>{item.status}</span><p>{item.details}</p></li>)}</ul> : <p>No coverage report supplied. This does not imply complete coverage.</p>}</section>
    <section aria-label="Client intake"><h3>Unreviewed intake</h3><p>Capture a note, email, text, call or form summary. Do not include credentials or sensitive raw messages. Notes remain unreviewed.</p>
      <form onSubmit={event => { event.preventDefault(); save(clientId) }}>
        <fieldset disabled={saving}>
          <legend>Add an intake note</legend>
          <label>Note title<input required maxLength={160} value={draft.title} onChange={event => updateDraft(clientId, { title: event.target.value })} /></label>
          <label>Source type<select value={draft.sourceType} onChange={event => updateDraft(clientId, { sourceType: event.target.value })}>{['note', 'email', 'text', 'call', 'form'].map(value => <option key={value}>{value}</option>)}</select></label>
          <label>Note body<textarea required maxLength={32000} rows={5} value={draft.body} onChange={event => updateDraft(clientId, { body: event.target.value })} /></label>
          <button type="submit" disabled={saving || !draft.title.trim() || !draft.body.trim()}>{saving ? 'Saving…' : 'Save unreviewed note'}</button>
        </fieldset>
      </form>
      {saveMessage ? <p role="status">{saveMessage}</p> : null}
      <button type="button" onClick={detail.retry}>Refresh notes</button>
      {notes.length ? <ul className="client-notes">{notes.map(note => <li key={note.id}><h4>{note.title}</h4><p>{note.sourceType} · unreviewed · <time>{note.createdAt}</time></p><pre>{note.body}</pre></li>)}</ul> : <p>No intake notes yet.</p>}
    </section>
  </section>
}

export function ClientWorkspace() {
  const [directoryRevision, setDirectoryRevision] = useState(0)
  const directory = useResource('/api/clients', directoryRevision)
  const [query, setQuery] = useState('')
  const [clientId, setClientId] = useState('')
  const [drafts, setDrafts] = useState({})
  const [saves, setSaves] = useState({})
  const [revisions, setRevisions] = useState({})
  const pending = useRef(new Set())
  const clients = directory.data?.clients ?? []
  const selected = clients.find(client => client.id === clientId)?.id ?? clients[0]?.id
  const visible = clients.filter(client => `${client.name} ${client.id} ${client.summary}`.toLowerCase().includes(query.trim().toLowerCase()))
  const updateDraft = (id, change) => setDrafts(current => ({ ...current, [id]: { ...EMPTY_DRAFT, ...ownValue(current, id), ...change } }))
  const save = async id => {
    if (pending.current.has(id)) return
    const draft = ownValue(drafts, id) ?? EMPTY_DRAFT
    if (!draft.title.trim() || !draft.body.trim()) return
    pending.current.add(id)
    setSaves(current => ({ ...current, [id]: { saving: true, message: '' } }))
    try {
      const note = await post(`/api/clients/${encodeURIComponent(id)}/notes`, draft)
      if (!note || typeof note.id !== 'string' || note.clientId !== id) throw new Error('Save response was not confirmed')
      setDrafts(current => ({ ...current, [id]: { ...EMPTY_DRAFT } }))
      setRevisions(current => ({ ...current, [id]: (ownValue(current, id) ?? 0) + 1 }))
      setSaves(current => ({ ...current, [id]: { saving: false, message: 'Note saved as unreviewed. Reloading notes.' } }))
    } catch (error) {
      setSaves(current => ({ ...current, [id]: { saving: false, message: `Save not confirmed. Draft retained. Refresh notes before retrying to avoid a duplicate. ${errorMessage(error)}` } }))
    } finally { pending.current.delete(id) }
  }
  return <main className="section-region client-workspace" aria-labelledby="clients-heading">
    <header className="section-header"><div><span className="section-eyebrow">Client knowledge</span><h1 id="clients-heading">Clients</h1><p>Source-backed context and unreviewed intake, kept separate.</p></div></header>
    <ClientIntake onChanged={() => {
      setDirectoryRevision(value => value + 1)
      if (selected) setRevisions(current => ({ ...current, [selected]: (ownValue(current, selected) ?? 0) + 1 }))
    }} />
    <div className="client-workspace-layout">
      <aside className="client-directory" aria-label="Client directory"><label>Search clients<input type="search" value={query} onChange={event => setQuery(event.target.value)} /></label>
        <RequestState resource={directory} label="clients" />
        {directory.data?.state === 'not_imported' ? <p>Import not connected. No client catalog has been imported.</p> : directory.data && !clients.length ? <p>No clients in this catalog.</p> : null}
        {clients.length && !visible.length ? <p>No clients match your search.</p> : null}
        <ul>{visible.map(client => <li key={client.id}><button type="button" aria-pressed={selected === client.id} onClick={() => setClientId(client.id)}><strong>{client.name}</strong><span>{client.status} · {client.documentCount} sources</span></button></li>)}</ul>
      </aside>
      {selected ? <ClientDetail key={selected} clientId={selected} draft={ownValue(drafts, selected) ?? EMPTY_DRAFT} updateDraft={updateDraft} save={save} saving={ownValue(saves, selected)?.saving ?? false} saveMessage={ownValue(saves, selected)?.message} revision={ownValue(revisions, selected) ?? 0} /> : <p>Select a client when the directory is available.</p>}
    </div>
  </main>
}
