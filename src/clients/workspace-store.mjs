import { constants, lstatSync, mkdirSync, openSync, closeSync, fstatSync, readSync, writeFileSync, fsyncSync, renameSync, unlinkSync } from 'node:fs'
import { resolve, parse, join } from 'node:path'
import { randomUUID } from 'node:crypto'

const CATALOG_LIMIT = 64 * 1024 * 1024
const NOTES_LIMIT = 8 * 1024 * 1024
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const SOURCE_TYPES = ['note', 'email', 'text', 'call', 'form']
const queues = new Map()
const fail = code => Object.assign(new Error(`CLIENT_WORKSPACE_${code}`), { code: `CLIENT_WORKSPACE_${code}` })
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value, max, min = 0) => typeof value === 'string' && value.length >= min && value.length <= max && !value.includes('\0')
const identifier = value => typeof value === 'string' && ID.test(value)
const date = value => text(value, 32, 20) && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value))
const keys = (value, names) => object(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name))
const credentials = value => /-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----|\b(?:password|passwd|api[_ -]?key|access[_ -]?token|client[_ -]?secret)\s*[:=]\s*\S+|\b(?:sk-[a-zA-Z0-9_-]{20,}|gh[pousr]_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{20,}|AKIA[A-Z0-9]{16})\b|\bBearer\s+[a-zA-Z0-9._~-]{16,}/i.test(value)

function ancestors(directory, create = false) {
  let current = parse(directory).root
  for (const part of directory.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, part)
    let info
    try { info = lstatSync(current) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      if (!create) return
      mkdirSync(current, { mode: 0o700 })
      info = lstatSync(current)
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw fail('CORRUPT')
  }
}
function readJson(directory, name, limit) {
  ancestors(directory)
  const path = join(directory, name)
  let info
  try { info = lstatSync(path) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > limit) throw fail('CORRUPT')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const actual = fstatSync(fd)
    if (!actual.isFile() || actual.size > limit || actual.nlink !== 1) throw fail('CORRUPT')
    // Read no more than the budget even if a file grows during the read.
    const chunks = []; let size = 0
    while (size <= limit) {
      const chunk = Buffer.alloc(Math.min(65536, limit + 1 - size))
      const count = readSync(fd, chunk, 0, chunk.length, null)
      if (!count) break
      size += count; chunks.push(chunk.subarray(0, count))
    }
    if (size > limit) throw fail('CORRUPT')
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (value === null) throw fail('CORRUPT')
    return value
  } finally { closeSync(fd) }
}
function validateCatalog(catalog) {
  if (catalog === null) return
  if (!keys(catalog, ['schemaVersion', 'importedAt', 'clients']) || catalog.schemaVersion !== 1 || !date(catalog.importedAt) || !Array.isArray(catalog.clients) || catalog.clients.length > 10000) throw fail('CORRUPT')
  const ids = new Set()
  for (const client of catalog.clients) {
    if (!keys(client, ['id', 'name', 'summary', 'status', 'documents', 'coverage']) || !identifier(client.id) || ids.has(client.id) || !text(client.name, 200, 1) || !text(client.summary, 32000) || !text(client.status, 64, 1) || !Array.isArray(client.documents) || client.documents.length > 100000 || !Array.isArray(client.coverage) || client.coverage.length > 10000) throw fail('CORRUPT')
    ids.add(client.id)
    const documents = new Set()
    for (const doc of client.documents) {
      if (!keys(doc, ['id', 'title', 'category', 'kind', 'status', 'origin', 'sha256', 'bytes', 'content', ...(Object.hasOwn(doc, 'duplicateOf') ? ['duplicateOf'] : [])]) || !identifier(doc.id) || documents.has(doc.id) || !text(doc.title, 1024, 1) || !text(doc.category, 200, 1) || !['document', 'code', 'asset', 'reference'].includes(doc.kind) || !['imported', 'linked', 'review_required', 'excluded'].includes(doc.status) || !keys(doc.origin, ['label', 'ref']) || !text(doc.origin.label, 1024, 1) || !text(doc.origin.ref, 8192) || !(doc.sha256 === null || (typeof doc.sha256 === 'string' && /^[a-f0-9]{64}$/.test(doc.sha256))) || !Number.isSafeInteger(doc.bytes) || doc.bytes < 0 || !(doc.content === null || text(doc.content, 8 * 1024 * 1024)) || (doc.status !== 'imported' && doc.content !== null)) throw fail('CORRUPT')
      documents.add(doc.id)
    }
    const byId = new Map(client.documents.map(doc => [doc.id, doc]))
    for (const doc of client.documents) {
      if (!Object.hasOwn(doc, 'duplicateOf')) continue
      const canonical = byId.get(doc.duplicateOf)
      if (!identifier(doc.duplicateOf) || doc.duplicateOf === doc.id || doc.status !== 'linked' || !canonical || canonical.status !== 'imported' || typeof canonical.content !== 'string' || Object.hasOwn(canonical, 'duplicateOf') || canonical.sha256 !== doc.sha256) throw fail('CORRUPT')
    }
    for (const entry of client.coverage) if (!keys(entry, ['source', 'status', 'details']) || !text(entry.source, 1024, 1) || !text(entry.status, 64, 1) || !text(entry.details, 32000)) throw fail('CORRUPT')
  }
}
function validNoteInput(note) {
  return keys(note, ['title', 'body', 'sourceType']) && text(note.title, 160, 1) && note.title.trim().length > 0 && text(note.body, 32000, 1) && note.body.trim().length > 0 && SOURCE_TYPES.includes(note.sourceType) && !credentials(`${note.title}\n${note.body}`)
}
function validateNotes(notes, catalog) {
  if (!Array.isArray(notes)) throw fail('CORRUPT')
  const ids = new Set()
  for (const note of notes) {
    if (!keys(note, ['id', 'clientId', 'title', 'body', 'sourceType', 'createdAt', 'status']) || !identifier(note.id) || ids.has(note.id) || !identifier(note.clientId) || !catalog?.clients.some(c => c.id === note.clientId) || !date(note.createdAt) || note.status !== 'unreviewed' || !validNoteInput({ title: note.title, body: note.body, sourceType: note.sourceType })) throw fail('CORRUPT')
    ids.add(note.id)
  }
}
function summary({ id, name, summary, status }) { return { id, name, summary, status } }

export class ClientWorkspaceStore {
  constructor({ directory, appendAudit = async () => {} }) {
    if (!text(directory, 4096, 1) || typeof appendAudit !== 'function') throw fail('INVALID')
    this.directory = resolve(directory)
    this.appendAudit = appendAudit
  }
  static async open(options) {
    const store = new ClientWorkspaceStore(options)
    store.load()
    return store
  }
  load() {
    try {
      const catalog = readJson(this.directory, 'catalog.json', CATALOG_LIMIT)
      validateCatalog(catalog)
      const notes = readJson(this.directory, 'notes.json', NOTES_LIMIT) ?? []
      validateNotes(notes, catalog)
      return { catalog, notes }
    } catch { throw fail('CORRUPT') }
  }
  client(data, clientId) {
    if (!identifier(clientId)) throw fail('INVALID')
    const client = data.catalog?.clients.find(c => c.id === clientId)
    if (!client) throw fail('NOT_FOUND')
    return client
  }
  async list() {
    const { catalog } = this.load()
    return { clients: (catalog?.clients ?? []).map(c => ({ ...summary(c), documentCount: c.documents.length })), state: catalog ? 'ready' : 'not_imported' }
  }
  async detail(clientId) {
    const data = this.load(); const client = this.client(data, clientId)
    return { client: summary(client), documents: client.documents.map(({ content, ...metadata }) => metadata), coverage: client.coverage, notes: data.notes.filter(n => n.clientId === clientId) }
  }
  async document(clientId, documentId) {
    if (!identifier(documentId)) throw fail('INVALID')
    const doc = this.client(this.load(), clientId).documents.find(d => d.id === documentId)
    if (!doc) throw fail('NOT_FOUND')
    return doc
  }
  async addNote(clientId, input) {
    if (!identifier(clientId) || !validNoteInput(input)) throw fail('INVALID')
    const task = (queues.get(this.directory) ?? Promise.resolve()).then(async () => {
      const data = this.load(); this.client(data, clientId)
      const note = { id: randomUUID(), clientId, ...input, createdAt: new Date().toISOString(), status: 'unreviewed' }
      const json = JSON.stringify([...data.notes, note])
      if (Buffer.byteLength(json) > NOTES_LIMIT) throw fail('INVALID')
      let temp
      try {
        ancestors(this.directory, true)
        temp = join(this.directory, `.notes-${randomUUID()}.tmp`)
        const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        try { writeFileSync(fd, json); fsyncSync(fd) } finally { closeSync(fd) }
        ancestors(this.directory)
        renameSync(temp, join(this.directory, 'notes.json'))
        const dirFd = openSync(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
        try { fsyncSync(dirFd) } finally { closeSync(dirFd) }
      } catch { throw fail('CORRUPT') } finally { if (temp) { try { unlinkSync(temp) } catch {} } }
      // A failed audit sink cannot turn a committed note into an ambiguous failed save.
      try { await this.appendAudit({ type: 'client_workspace_note_added', clientId, noteId: note.id, status: 'unreviewed' }) } catch {}
      return note
    })
    const settled = task.catch(() => {})
    queues.set(this.directory, settled)
    try { return await task } finally { if (queues.get(this.directory) === settled) queues.delete(this.directory) }
  }
}
