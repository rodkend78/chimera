import test from 'node:test'
import assert from 'node:assert/strict'
import { createDraftStore } from '../app/src/draft-store.js'

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null },
    setItem(key, value) { values.set(key, String(value)) },
    removeItem(key) { values.delete(key) },
    key(index) { return [...values.keys()][index] ?? null },
    get length() { return values.size },
  }
}

const target = {
  workspaceId: 'workspace-fixture', operatorId: 'operator-fixture', mode: 'guidance',
  conversationId: 'task:alpha', taskId: 'alpha', recipientAgentIds: ['ace'], replyTo: null,
}

test('draft store restores sending drafts as unconfirmed without changing target identity', () => {
  const storage = memoryStorage()
  const first = createDraftStore({ storage, scope: 'workspace-fixture:operator-fixture', now: () => 1000 })
  const saved = first.save(target, { content: 'Keep this text', budget: 'standard', destinationRevision: 4, requestId: 'request-1', status: 'sending' })
  assert.equal(saved.status, 'sending')

  const reopened = createDraftStore({ storage, scope: 'workspace-fixture:operator-fixture', now: () => 2000 })
  assert.deepEqual(reopened.get(target), {
    content: 'Keep this text', budget: 'standard', destinationRevision: 4, requestId: 'request-1', status: 'unconfirmed',
  })
})

test('draft store persists bounded routing choices in the same scoped destination row', () => {
  const storage = memoryStorage()
  const first = createDraftStore({ storage, scope: 'workspace-fixture:operator-fixture' })
  first.save(target, { content: 'Keep route choice', status: 'draft', routingRequirements: { priorityPreset: 'latency', outputModalities: ['TEXT'] } })
  const reopened = createDraftStore({ storage, scope: 'workspace-fixture:operator-fixture' })
  assert.deepEqual(reopened.get(target).routingRequirements, { outputModalities: ['TEXT'], priorityPreset: 'latency' })
  assert.throws(() => first.save(target, { content: 'Reject grants', status: 'draft', routingRequirements: { grant: 'allow-all' } }), { code: 'COMPOSER_ROUTING_REQUIREMENTS_INVALID' })
})

test('draft store preserves an explicit null submitted routing snapshot across reopen', () => {
  const storage = memoryStorage()
  const first = createDraftStore({ storage, scope: 'workspace-fixture:operator-fixture' })
  first.save(target, {
    content: 'Editable continuation',
    routingRequirements: { priorityPreset: 'latency' },
    pendingRequestId: 'request-inherit',
    pendingContent: 'Submitted continuation',
    pendingBudget: 'standard',
    pendingRoutingRequirements: null,
    status: 'unconfirmed',
  })
  const reopened = createDraftStore({ storage, scope: 'workspace-fixture:operator-fixture' })
  const saved = reopened.get(target)
  assert.equal(Object.hasOwn(saved, 'pendingRoutingRequirements'), true)
  assert.equal(saved.pendingRoutingRequirements, null)
  assert.deepEqual(saved.routingRequirements, { priorityPreset: 'latency' })
})

test('draft store warns and keeps unsent text when storage is full', () => {
  let warning = null
  const storage = { ...memoryStorage(), setItem() { throw new Error('QUOTA') } }
  const store = createDraftStore({ storage, scope: 'workspace-fixture:operator-fixture', onWarning: value => { warning = value } })
  const result = store.save(target, { content: 'Must not disappear', budget: 'standard', destinationRevision: 1, requestId: null, status: 'draft' })
  assert.equal(result.content, 'Must not disappear')
  assert.equal(store.get(target).content, 'Must not disappear')
  assert.equal(warning, 'DRAFT_PERSISTENCE_UNAVAILABLE')
})

test('draft store prunes empty acknowledged drafts but never evicts unsent content', () => {
  const storage = memoryStorage()
  const store = createDraftStore({ storage, scope: 'workspace-fixture:operator-fixture', maxDrafts: 2 })
  const empty = { ...target, taskId: 'empty', conversationId: 'task:empty' }
  const unsent = { ...target, taskId: 'unsent', conversationId: 'task:unsent' }
  const newest = { ...target, taskId: 'newest', conversationId: 'task:newest' }
  store.save(empty, { content: '', budget: 'standard', destinationRevision: 1, requestId: null, status: 'accepted' })
  store.save(unsent, { content: 'Do not discard', budget: 'standard', destinationRevision: 1, requestId: null, status: 'draft' })
  store.save(newest, { content: 'Newest', budget: 'standard', destinationRevision: 1, requestId: null, status: 'draft' })
  assert.equal(store.get(empty), null)
  assert.equal(store.get(unsent).content, 'Do not discard')
  assert.equal(store.get(newest).content, 'Newest')
})

test('draft store rejects a new unsent draft at the bound instead of evicting older unsent text', () => {
  const store = createDraftStore({ storage: memoryStorage(), scope: 'workspace-fixture:operator-fixture', maxDrafts: 2 })
  const first = { ...target, taskId: 'first', conversationId: 'task:first' }
  const second = { ...target, taskId: 'second', conversationId: 'task:second' }
  const third = { ...target, taskId: 'third', conversationId: 'task:third' }
  store.save(first, { content: 'First unsent', status: 'draft' })
  store.save(second, { content: 'Second unsent', status: 'unconfirmed' })
  assert.throws(() => store.save(third, { content: 'Third unsent', status: 'draft' }), { code: 'DRAFT_STORAGE_LIMIT_REACHED' })
  assert.equal(store.get(first).content, 'First unsent')
  assert.equal(store.get(second).content, 'Second unsent')
  assert.equal(store.get(third), null)
})

test('draft store never prunes unresolved evidence when the editable text is empty', () => {
  const store = createDraftStore({ storage: memoryStorage(), scope: 'workspace-fixture:operator-fixture', maxDrafts: 1 })
  const pending = { ...target, taskId: 'pending-empty', conversationId: 'task:pending-empty' }
  const next = { ...target, taskId: 'next', conversationId: 'task:next' }
  store.save(pending, { content: '', pendingRequestId: 'request-pending', pendingContent: 'Original request', status: 'unconfirmed' })
  assert.throws(() => store.save(next, { content: 'New unsent text', status: 'draft' }), { code: 'DRAFT_STORAGE_LIMIT_REACHED' })
  assert.equal(store.get(pending).pendingRequestId, 'request-pending')
  assert.equal(store.get(pending).pendingContent, 'Original request')
  assert.equal(store.get(next), null)
})

test('draft store uses browser-safe UTF-8 measurement and never clears another namespace', () => {
  const foreignKey = 'chimera.conversation-drafts.v1:other-scope:foreign'
  const storage = memoryStorage({
    'chimera.conversation-drafts.v1:workspace-fixture:operator-fixture:index': JSON.stringify([{ key: foreignKey, status: 'draft', contentBytes: 4, updatedAt: 1 }]),
    [foreignKey]: JSON.stringify({ draft: { content: 'foreign' }, updatedAt: 1 }),
  })
  const previousBuffer = globalThis.Buffer
  try {
    globalThis.Buffer = undefined
    const store = createDraftStore({ storage, scope: 'workspace-fixture:operator-fixture' })
    store.save(target, { content: 'héllo', status: 'draft' })
    store.clearScope()
    assert.notEqual(storage.getItem(foreignKey), null)
  } finally {
    globalThis.Buffer = previousBuffer
  }
})

test('draft store keeps an in-memory index when persistence is unavailable and enforces the bound', () => {
  const warnings = []
  const store = createDraftStore({ storage: null, scope: 'workspace-fixture:operator-fixture', maxDrafts: 2, onWarning: code => warnings.push(code) })
  const first = { ...target, taskId: 'memory-first', conversationId: 'task:memory-first' }
  const second = { ...target, taskId: 'memory-second', conversationId: 'task:memory-second' }
  const third = { ...target, taskId: 'memory-third', conversationId: 'task:memory-third' }
  store.save(first, { content: 'first', status: 'draft' })
  store.save(second, { content: 'second', status: 'draft' })
  assert.throws(() => store.save(third, { content: 'third', status: 'draft' }), { code: 'DRAFT_STORAGE_LIMIT_REACHED' })
  assert.equal(store.get(first).content, 'first')
  assert.equal(store.get(second).content, 'second')
  assert.equal(store.get(third), null)
  assert.equal(warnings[0], 'DRAFT_PERSISTENCE_UNAVAILABLE')
})

test('draft store rebuilds an owned orphan after a corrupt index and clears only owned entries', () => {
  const owned = 'chimera.conversation-drafts.v1:workspace-fixture:operator-fixture:'
  const orphan = `${owned}${encodeURIComponent('chimera-draft-v1:{"taskId":"orphan"}')}`
  const foreign = 'chimera.conversation-drafts.v1:other-scope:foreign'
  const storage = memoryStorage({
    [`${owned}index`]: '{not-json',
    [orphan]: JSON.stringify({ draft: { content: 'orphan', status: 'draft' }, updatedAt: 5 }),
    [foreign]: JSON.stringify({ draft: { content: 'foreign' }, updatedAt: 5 }),
  })
  const store = createDraftStore({ storage, scope: 'workspace-fixture:operator-fixture' })
  assert.equal(store.get({ taskId: 'orphan' }), null)
  store.clearScope()
  assert.equal(storage.getItem(orphan), null)
  assert.notEqual(storage.getItem(foreign), null)
})

test('draft store trusts the durable entry over a stale index after a partial index write', () => {
  const backing = memoryStorage()
  let failIndex = false
  const storage = {
    getItem: key => backing.getItem(key),
    setItem(key, value) {
      if (failIndex && key.endsWith(':index')) throw new Error('INDEX_WRITE_FAILED')
      backing.setItem(key, value)
    },
    removeItem: key => backing.removeItem(key),
    key: index => backing.key(index),
    get length() { return backing.length },
  }
  const store = createDraftStore({ storage, scope: 'workspace-fixture:operator-fixture', maxDrafts: 1 })
  const second = { ...target, taskId: 'partial-second', conversationId: 'task:partial-second' }
  store.save(target, { content: '', status: 'accepted' })
  failIndex = true
  store.save(target, { content: 'New unsent text', status: 'draft' })
  assert.throws(() => store.save(second, { content: 'Another unsent text', status: 'draft' }), { code: 'DRAFT_STORAGE_LIMIT_REACHED' })
  assert.equal(store.get(target).content, 'New unsent text')
  const reopened = createDraftStore({ storage, scope: 'workspace-fixture:operator-fixture', maxDrafts: 1 })
  assert.equal(reopened.get(target).content, 'New unsent text')
})
