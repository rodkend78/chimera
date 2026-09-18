import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, chmod } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClientIntakeService } from '../src/clients/intake-service.mjs'
import { IntakeStore } from '../src/clients/intake-store.mjs'
const ingestion = await import('../src/clients/google-intake.mjs').catch(() => ({}))
const oauth = await import('../src/clients/google-connection.mjs').catch(() => ({}))
const labels = ['Legal business name', 'Primary contact — first name', 'Primary contact — last name', 'Email', 'Which services are you buying? (check all — skip the later pages you didn’t buy)', 'I accept the Terms of Service.', 'I accept the privacy / data-handling terms.', 'I consent to being contacted about this project.']
const form = { formId: 'fixture-form', info: { title: 'Intake', documentTitle: 'Intake' }, revisionId: 'rev', responderUri: 'https://docs.google.com/forms/d/e/fixture/viewform', items: labels.map((title, i) => ({ itemId: `i${i}`, title, questionItem: { question: { questionId: `q${i}`, required: true, ...(i < 4 ? { textQuestion: { paragraph: false } } : { choiceQuestion: { type: 'CHECKBOX', options: [{ value: i === 4 ? 'Website' : 'Yes' }], shuffle: false } }) } } })) }
function response(id = 'response-1') {
  return { responseId: id, createTime: '2026-09-08T10:00:00Z', lastSubmittedTime: '2026-09-08T10:00:00Z', respondentEmail: 'owner@example.test', answers: Object.fromEntries(['Business', 'A', 'Owner', 'owner@example.test', 'Website', 'Yes', 'Yes', 'Yes'].map((value, i) => [`q${i}`, { questionId: `q${i}`, textAnswers: { answers: [{ value }] } }])) }
}
const json = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
test('maps actual Forms list response without formId using fetched question identity', () => {
  assert.equal(typeof ingestion.mapResponse, 'function')
  const result = ingestion.mapResponse(form, response(), 'fixture-form')
  assert.equal(result.sourceId, 'fixture-form:response-1')
  assert.equal(result.email, 'owner@example.test')
  assert.deepEqual(result.services, ['Website'])
  assert.deepEqual(result.issues, [])
  assert.equal(result.evidence[0].questionId, 'q0')
  assert.equal(result.evidence[0].label, 'Legal business name')
  const straight = structuredClone(form); straight.items[4].title = straight.items[4].title.replace('didn’t', "didn't")
  assert.deepEqual(ingestion.mapResponse(straight, response(), 'fixture-form').issues, [])
})
test('schema ambiguity, absent consent, mismatched respondent and credential values require review', () => {
  assert.equal(typeof ingestion.mapResponse, 'function')
  const missing = response(); delete missing.answers.q5
  assert.ok(ingestion.mapResponse(form, missing, 'fixture-form').issues.includes('CONSENT_REQUIRED'))
  const mismatch = response(); mismatch.respondentEmail = 'other@example.test'
  assert.ok(ingestion.mapResponse(form, mismatch, 'fixture-form').issues.includes('EMAIL_MISMATCH'))
  const ambiguous = structuredClone(form); ambiguous.items.push({ ...ambiguous.items[0], itemId: 'extra', questionItem: { question: { questionId: 'extra', textQuestion: {} } } })
  assert.ok(ingestion.mapResponse(ambiguous, response(), 'fixture-form').issues.includes('SCHEMA_REVIEW_REQUIRED'))
  const secret = response(); secret.answers.q0.textAnswers.answers[0].value = 'password=do-not-store'
  const result = ingestion.mapResponse(form, secret, 'fixture-form')
  assert.ok(result.issues.includes('CREDENTIAL_CONTENT'))
  assert.doesNotMatch(JSON.stringify(result), /do-not-store/)
  const legitimate = structuredClone(form); legitimate.items.push({ itemId: 'info', title: 'Access & credentials', textItem: {} })
  assert.deepEqual(ingestion.mapResponse(legitimate, response(), 'fixture-form').issues, [])
})
test('two pages capture, bound persists continuation, and reference lookups remain client scoped metadata', async () => {
  assert.equal(typeof ingestion.GoogleIntake, 'function')
  const urls = [], captured = []; let checkpoint
  const adapter = new ingestion.GoogleIntake({ formId: 'fixture-form', maxPages: 1, connection: { async accessToken() { return 'synthetic' } }, fetch: async url => {
    const u = new URL(url); urls.push(u)
    if (u.hostname === 'forms.googleapis.com') return json(u.pathname.endsWith('/responses') ? u.searchParams.get('pageToken') ? { responses: [response('response-2')] } : { responses: [response()], nextPageToken: 'page2' } : form)
    if (u.hostname === 'gmail.googleapis.com') return json({ messages: [{ id: 'm1', threadId: 't1' }], resultSizeEstimate: 1 })
    if (u.hostname === 'www.googleapis.com') return json({ files: [{ id: 'd1', name: 'Supporting brief', mimeType: 'application/pdf', webViewLink: 'https://drive.google.com/file/d/d1/view' }] })
    assert.fail('unexpected external URL')
  } })
  assert.equal((await adapter.scan({ capture: x => captured.push(x), checkpoint: x => { checkpoint = x } })).complete, false)
  assert.equal(checkpoint.pageToken, 'page2')
  assert.equal((await adapter.scan({ capture: x => captured.push(x), recovery: checkpoint, checkpoint() {} })).complete, true)
  assert.equal(captured.length, 2)
  assert.equal(captured[0].references.length, 2)
  const mail = urls.find(u => u.hostname === 'gmail.googleapis.com')
  assert.match(mail.searchParams.get('q'), /owner@example.test/)
  assert.equal(mail.searchParams.get('maxResults'), '10')
  assert.ok(urls.filter(u => u.hostname === 'www.googleapis.com').every(u => u.searchParams.get('q').includes('owner@example.test')))
})
test('transport rejects redirects, oversized bodies, malformed schema and partial pages honestly', async () => {
  assert.equal(typeof ingestion.GoogleIntake, 'function')
  for (const payload of [new Response('redirect', { status: 302 }), json({ responses: 'invalid' }), new Response('x'.repeat(2100000), { status: 200 })]) {
    const adapter = new ingestion.GoogleIntake({ formId: 'fixture-form', connection: { async accessToken() { return 'synthetic' } }, fetch: async url => new URL(url).pathname.endsWith('/responses') ? payload : json(form) })
    await assert.rejects(adapter.scan({ capture() {}, checkpoint() {} }))
  }
})
async function connectionFixture(t, { account = 'owner@example.test', identityEmail = account, verified = true, beforeIdentity = async () => {} } = {}) {
  assert.equal(typeof oauth.GoogleConnection, 'function')
  const directory = await mkdtemp(join(realpathSync(tmpdir()), 'chimera-oauth-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const clientFile = join(directory, 'client.json')
  await writeFile(clientFile, JSON.stringify({ installed: { client_id: 'fixture.apps.googleusercontent.com', client_secret: 'synthetic-registration', redirect_uris: ['http://localhost'] } }), { mode: 0o600 })
  let secret = null, launch, tokenCalls = 0, refreshFails = false, clock = Date.now()
  const keychain = { async get() { return secret }, async set(value) { secret = value }, async delete() { secret = null }, async available() { return true } }
  const connection = new oauth.GoogleConnection({ clientFile, account, keychain, now: () => clock, openBrowser: async url => { launch = new URL(url) }, fetch: async (url, options) => {
    if (url === 'https://oauth2.googleapis.com/token') { tokenCalls++; if (refreshFails) return new Response('sensitive error', { status: 400 }); assert.ok(options.body instanceof URLSearchParams); return json({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 3600, token_type: 'Bearer', scope: oauth.GOOGLE_SCOPES.join(' ') }) }
    if (url === 'https://openidconnect.googleapis.com/v1/userinfo') { await beforeIdentity(); return json({ sub: 'synthetic-subject', email: identityEmail, email_verified: verified }) }
    assert.fail('unexpected OAuth URL')
  } })
  t.after(() => connection.close())
  return { connection, keychain, clientFile, launch: () => launch, tokenCalls: () => tokenCalls, failRefresh() { refreshFails = true }, advance(ms) { clock += ms } }
}
test('PKCE loopback consent verifies account, consumes state once, persists only keychain and disconnects', async t => {
  const f = await connectionFixture(t)
  assert.equal((await f.connection.status()).state, 'disconnected')
  await f.connection.connect()
  const auth = f.launch(); assert.equal(auth.searchParams.get('code_challenge_method'), 'S256')
  assert.equal((await f.connection.status()).state, 'authorizing')
  const callback = new URL(auth.searchParams.get('redirect_uri')); callback.searchParams.set('state', auth.searchParams.get('state')); callback.searchParams.set('code', 'synthetic-code')
  assert.equal((await fetch(callback)).status, 200)
  assert.equal((await f.connection.status()).state, 'connected')
  assert.equal(await f.connection.accessToken(), 'synthetic-access')
  assert.ok(await f.keychain.get())
  assert.equal(f.tokenCalls(), 1)
  await assert.rejects(fetch(callback))
  await f.connection.disconnect(); assert.equal(await f.keychain.get(), null)
  assert.equal((await f.connection.status()).state, 'disconnected')
})
test('wrong account and unverified email cannot persist credentials', async t => {
  for (const options of [{ identityEmail: 'wrong@example.test' }, { verified: false }]) {
    const f = await connectionFixture(t, options); await f.connection.connect()
    const callback = new URL(f.launch().searchParams.get('redirect_uri')); callback.searchParams.set('state', f.launch().searchParams.get('state')); callback.searchParams.set('code', 'synthetic')
    assert.equal((await fetch(callback)).status, 400)
    assert.equal(await f.keychain.get(), null)
    assert.equal((await f.connection.status()).state, 'error')
  }
})
test('OAuth denial, bad state and expiry cannot authenticate; saved email alone is not connected', async t => {
  const f = await connectionFixture(t); await f.connection.connect()
  const callback = new URL(f.launch().searchParams.get('redirect_uri')); callback.searchParams.set('state', 'wrong'); callback.searchParams.set('code', 'synthetic')
  assert.equal((await fetch(callback)).status, 400); assert.equal(f.tokenCalls(), 0)
  callback.searchParams.set('state', f.launch().searchParams.get('state')); callback.searchParams.set('error', 'access_denied'); callback.searchParams.delete('code')
  assert.equal((await fetch(callback)).status, 400); assert.equal(f.tokenCalls(), 0)
  assert.equal((await f.connection.status()).state, 'error')
  await f.keychain.set({ email: 'owner@example.test', refreshToken: 'synthetic' })
  f.failRefresh()
  await assert.rejects(f.connection.restore())
  assert.equal((await f.connection.status()).state, 'error')
  assert.doesNotMatch(JSON.stringify(await f.connection.status()), /sensitive|synthetic/)
})
test('missing registration and nonprivate registration require setup without browser launch', async t => {
  const f = await connectionFixture(t)
  await chmod(f.clientFile, 0o644)
  assert.equal((await f.connection.status()).state, 'setup_required')
  await chmod(f.clientFile, 0o600)
  await writeFile(f.clientFile, '{}', { mode: 0o600 })
  assert.equal((await f.connection.status()).state, 'setup_required')
  await f.connection.connect(); assert.equal(f.launch(), undefined)
})
test('expired callback consumes authorization without exchanging code', async t => {
  const f = await connectionFixture(t); await f.connection.connect(); f.advance(300001)
  const callback = new URL(f.launch().searchParams.get('redirect_uri')); callback.searchParams.set('state', f.launch().searchParams.get('state')); callback.searchParams.set('code', 'synthetic')
  assert.equal((await fetch(callback)).status, 400); assert.equal(f.tokenCalls(), 0)
  assert.equal(await f.keychain.get(), null)
})
test('callback state comparison rejects equal-character non-ASCII input without throwing', () => {
  assert.equal(typeof oauth.validOAuthState, 'function')
  assert.equal(oauth.validOAuthState('ñ'.repeat(43), 'a'.repeat(43)), false)
  assert.equal(oauth.validOAuthState('a'.repeat(43), 'a'.repeat(43)), true)
  assert.equal(oauth.validOAuthState('a'.repeat(42), 'a'.repeat(43)), false)
})
test('disconnect waits for in-progress verification and blocks reconnect until old callback retires', async t => {
  let enter, release
  const entered = new Promise(r => { enter = r }); const blocked = new Promise(r => { release = r })
  const f = await connectionFixture(t, { beforeIdentity: async () => { enter(); await blocked } }); await f.connection.connect()
  const original = f.launch().href
  const callback = new URL(f.launch().searchParams.get('redirect_uri')); callback.searchParams.set('state', f.launch().searchParams.get('state')); callback.searchParams.set('code', 'synthetic')
  const reply = fetch(callback).catch(() => null); await entered
  const disconnecting = f.connection.disconnect()
  await f.connection.connect()
  assert.equal(f.launch().href, original, 'old callback must retire before a new authorization launches')
  release(); await disconnecting; await reply
  assert.equal(await f.keychain.get(), null)
  assert.equal((await f.connection.status()).state, 'disconnected')
})
test('unavailable keychain produces setup state and never uses plaintext fallback', async t => {
  const f = await connectionFixture(t)
  f.keychain.get = async () => { throw Object.assign(new Error('native private diagnostic'), { code: 'CLIENT_INTAKE_KEYCHAIN_UNAVAILABLE' }) }
  await assert.rejects(f.connection.restore())
  assert.equal((await f.connection.status()).state, 'setup_required')
  assert.doesNotMatch(JSON.stringify(await f.connection.status()), /native private/)
})
test('real disk service and Forms adapter resume partial pagination after restart and deduplicate full replay', async t => {
  const directory = await mkdtemp(join(realpathSync(tmpdir()), 'chimera-forms-disk-'))
  let failPage = true
  const connection = { async accessToken() { return 'synthetic' }, async status() { return { state: 'connected', account: 'owner@example.test', setupMessage: null } }, async close() {} }
  const google = new ingestion.GoogleIntake({ formId: 'fixture-form', connection, fetch: async url => {
    const u = new URL(url)
    if (u.hostname === 'gmail.googleapis.com') return json({ messages: [], resultSizeEstimate: 0 })
    if (u.hostname === 'www.googleapis.com') return json({ files: [] })
    if (!u.pathname.endsWith('/responses')) return json(form)
    if (!u.searchParams.get('pageToken')) return json({ responses: [response()], nextPageToken: 'second' })
    if (failPage) return new Response('sensitive diagnostic', { status: 503 })
    return json({ responses: [response('response-2')] })
  } })
  let service = new ClientIntakeService({ store: await IntakeStore.open({ directory }), google, connection })
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }) })
  await service.sync()
  assert.equal((await service.list()).clients.length, 1)
  assert.equal((await service.status()).sync.lastSuccessAt, null)
  await service.close(); failPage = false
  service = new ClientIntakeService({ store: await IntakeStore.open({ directory }), google, connection })
  await service.start()
  assert.equal((await service.list()).clients.length, 2)
  assert.ok((await service.status()).sync.lastSuccessAt)
  await service.sync()
  assert.equal((await service.status()).queue.length, 2)
})
test('concurrent connect and disconnect cannot leave a callback that reconnects the account', async t => {
  const f = await connectionFixture(t)
  await Promise.all([f.connection.connect(), f.connection.disconnect()])
  assert.equal(f.launch(), undefined, 'disconnect invalidates connect before browser launch')
  assert.equal((await f.connection.status()).state, 'disconnected')
  assert.equal(await f.keychain.get(), null)
  assert.equal(f.tokenCalls(), 0)
  await f.connection.connect()
  const callback = new URL(f.launch().searchParams.get('redirect_uri'))
  callback.searchParams.set('state', f.launch().searchParams.get('state')); callback.searchParams.set('code', 'synthetic')
  assert.equal((await fetch(callback)).status, 200, 'a later deliberate reconnect remains usable')
})
test('disconnect during loopback listener startup retires the pending connect without hanging', { timeout: 2000 }, async t => {
  const f = await connectionFixture(t)
  const connecting = f.connection.connect()
  // Pause at the real listener-start boundary before Node delivers its listening event.
  while (!f.connection.pending) await Promise.resolve()
  await Promise.all([connecting, f.connection.disconnect()])
  assert.equal(f.launch(), undefined)
  assert.equal((await f.connection.status()).state, 'disconnected')
  assert.equal(await f.keychain.get(), null)
})
test('invalid form business and service facts retain review evidence and allow next page after restart', async t => {
  const directory = await mkdtemp(join(realpathSync(tmpdir()), 'chimera-invalid-form-'))
  const name = 'n'.repeat(201), serviceValue = 's'.repeat(201)
  const malformed = [response('long-name'), response('long-service'), response('many-services')]
  malformed[0].answers.q0.textAnswers.answers[0].value = name
  malformed[1].answers.q4.textAnswers.answers[0].value = serviceValue
  malformed[2].answers.q4.textAnswers.answers = Array.from({ length: 21 }, (_, i) => ({ value: `service-${i}` }))
  const valid = response('later-valid'); valid.answers.q3.textAnswers.answers[0].value = 'later@example.test'; valid.respondentEmail = 'later@example.test'
  const connection = { async accessToken() { return 'synthetic' }, async status() { return { state: 'connected' } }, async close() {} }
  const google = new ingestion.GoogleIntake({ connection, formId: 'fixture-form', maxPages: 1, fetch: async url => {
    const u = new URL(url)
    if (u.hostname === 'gmail.googleapis.com') return json({ messages: [], resultSizeEstimate: 0 })
    if (u.hostname === 'www.googleapis.com') return json({ files: [] })
    if (!u.pathname.endsWith('/responses')) return json(form)
    return json(u.searchParams.get('pageToken') ? { responses: [valid] } : { responses: malformed, nextPageToken: 'valid-page' })
  } })
  let store = await IntakeStore.open({ directory }); let service = new ClientIntakeService({ store, google, connection })
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }) })
  await service.sync()
  assert.equal((await service.list()).clients.length, 3, 'invalid contact facts must not poison the page transaction')
  assert.equal(store.read().recovery.pageToken, 'valid-page')
  assert.ok((await service.status()).queue.every(q => q.status === 'review_required'))
  const first = (await service.list()).clients[0]
  assert.equal(first.name, 'Submission requires review')
  const document = (await service.detail(first.id)).documents[0]
  assert.ok((await service.document(first.id, document.id)).content.includes(name))
  assert.deepEqual((await service.list()).clients[1].services, [])
  await service.close(); store = await IntakeStore.open({ directory }); service = new ClientIntakeService({ store, google, connection })
  await service.sync()
  assert.equal((await service.list()).clients.length, 4)
  assert.ok((await service.status()).sync.lastSuccessAt)
  assert.equal((await service.status()).queue.at(-1).status, 'ready')
})
test('startup restore paused in availability cannot reconnect after disconnect deletes credentials', async t => {
  let allowAvailable, enteredAvailable, allowDelete, allowIdentity, enteredIdentity
  const available = new Promise(r => { allowAvailable = r }), availableEntered = new Promise(r => { enteredAvailable = r })
  const deleting = new Promise(r => { allowDelete = r })
  const identity = new Promise(r => { allowIdentity = r }), identityEntered = new Promise(r => { enteredIdentity = r })
  const f = await connectionFixture(t, { beforeIdentity: async () => { enteredIdentity(); await identity } })
  await f.keychain.set({ refreshToken: 'synthetic' })
  f.keychain.available = async () => { enteredAvailable(); await available; return true }
  const remove = f.keychain.delete.bind(f.keychain)
  f.keychain.delete = async () => { await deleting; await remove() }
  const restoring = f.connection.restore().catch(() => null)
  await availableEntered
  const disconnecting = f.connection.disconnect()
  allowAvailable()
  // Old behavior reaches verification using the refresh credential before deletion;
  // correct cancellation may retire before any credential read or token exchange.
  await Promise.race([identityEntered, restoring])
  allowDelete(); await disconnecting
  allowIdentity(); await restoring
  assert.equal((await f.connection.status()).state, 'disconnected')
  assert.equal((await f.connection.status()).account, null)
  assert.equal(await f.keychain.get(), null)
  await assert.rejects(f.connection.accessToken(), { code: 'CLIENT_INTAKE_DISCONNECTED' })
  await f.connection.connect()
  const callback = new URL(f.launch().searchParams.get('redirect_uri'))
  callback.searchParams.set('state', f.launch().searchParams.get('state')); callback.searchParams.set('code', 'synthetic')
  assert.equal((await fetch(callback)).status, 200)
})
test('a stale restore with no credential cannot reset a newer authorization state', async t => {
  let entered, release
  const blocked = new Promise(r => { release = r }), reached = new Promise(r => { entered = r })
  const f = await connectionFixture(t)
  f.keychain.get = async () => { entered(); await blocked; return null }
  const restoring = f.connection.restore().catch(() => null)
  await reached; await f.connection.connect(); release(); await restoring
  assert.equal((await f.connection.status()).state, 'authorizing')
})
test('direct restores coalesce and disconnect retires them while identity verification is blocked', { timeout: 2000 }, async t => {
  let entered, release
  const blocked = new Promise(r => { release = r }), reached = new Promise(r => { entered = r })
  const f = await connectionFixture(t, { beforeIdentity: async () => { entered(); await blocked } })
  t.after(() => release())
  await f.keychain.set({ refreshToken: 'synthetic' })
  const first = f.connection.restore().catch(() => null), second = f.connection.restore().catch(() => null)
  await reached
  await f.connection.disconnect()
  release(); await Promise.all([first, second])
  assert.equal(f.tokenCalls(), 1)
  assert.equal((await f.connection.status()).state, 'disconnected')
  await assert.rejects(f.connection.accessToken(), { code: 'CLIENT_INTAKE_DISCONNECTED' })
})
