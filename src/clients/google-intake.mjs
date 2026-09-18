import { createHash } from 'node:crypto'
import { credentialLike, intakeError } from './intake-store.mjs'
import { validEmail } from './intake-service.mjs'
import { GOOGLE_FORM_ID_ENV, googleFormIdFromEnv, validGoogleFormId } from './google-config.mjs'

export { GOOGLE_FORM_ID_ENV, googleFormIdFromEnv } from './google-config.mjs'
export const FORM_ID = null
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const labels = { name: 'Legal business name', first: 'Primary contact — first name', last: 'Primary contact — last name', email: 'Email', services: 'Which services are you buying? (check all — skip the later pages you didn’t buy)', terms: 'I accept the Terms of Service.', privacy: 'I accept the privacy / data-handling terms.', consent: 'I consent to being contacted about this project.' }
const normalize = value => String(value ?? '').replace(/[‘’]/g, "'").trim().replace(/\s*\*$/, '').trim()
export async function boundedJson(fetcher, url, options = {}, limit = 2 * 1024 * 1024) {
  const response = await fetcher(url, { ...options, redirect: 'error', signal: options.signal ?? AbortSignal.timeout(15000) })
  if (!response.ok || response.redirected) throw intakeError('GOOGLE_REQUEST_FAILED')
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw intakeError('RESPONSE_LIMIT') }
  const chunks = []; let size = 0
  for await (const chunk of response.body ?? []) { size += chunk.length; if (size > limit) throw intakeError('RESPONSE_LIMIT'); chunks.push(chunk) }
  try { const value = JSON.parse(Buffer.concat(chunks).toString()); if (!value || Array.isArray(value) || typeof value !== 'object') throw Error(); return value } catch { throw intakeError('GOOGLE_SCHEMA') }
}
export function mapResponse(form, response, formId = FORM_ID) {
  if (!validGoogleFormId(formId)) throw intakeError('GOOGLE_SETUP_REQUIRED')
  if (!response || typeof response.responseId !== 'string' || response.responseId.length > 256 || !response.responseId || !Number.isFinite(Date.parse(response.lastSubmittedTime)) || !Number.isFinite(Date.parse(response.createTime)) || !response.answers || typeof response.answers !== 'object' || Array.isArray(response.answers)) throw intakeError('GOOGLE_SCHEMA')
  const issues = [], questions = new Map(), mapping = {}
  for (const item of form.items ?? []) {
    const question = item.questionItem?.question
    if (question?.questionId) { if (questions.has(question.questionId)) issues.push('SCHEMA_REVIEW_REQUIRED'); questions.set(question.questionId, { label: item.title, question }) }
    else if (item.questionGroupItem) issues.push('SCHEMA_REVIEW_REQUIRED')
  }
  for (const [key, label] of Object.entries(labels)) {
    const matches = [...questions.entries()].filter(([, q]) => normalize(q.label) === normalize(label))
    if (matches.length !== 1) issues.push('SCHEMA_REVIEW_REQUIRED')
    else mapping[key] = matches[0][0]
  }
  const evidence = [], values = {}
  for (const [questionId, answer] of Object.entries(response.answers)) {
    if (!questions.has(questionId) || answer?.questionId !== questionId) issues.push('SCHEMA_REVIEW_REQUIRED')
    let raw = answer?.textAnswers?.answers?.map(a => a.value)
    if (!raw) { raw = answer?.fileUploadAnswers?.answers?.map(a => ({ fileId: a.fileId, fileName: a.fileName, mimeType: a.mimeType })) ?? []; issues.push('ANSWER_REVIEW_REQUIRED') }
    if (raw.length > 50 || raw.some(v => typeof v !== 'string' || v.length > 32000)) issues.push('ANSWER_REVIEW_REQUIRED')
    if (credentialLike(JSON.stringify(raw))) { raw = ['[Credential-like answer withheld]']; issues.push('CREDENTIAL_CONTENT') }
    values[questionId] = raw
    evidence.push({ questionId, label: questions.get(questionId)?.label ?? 'Unknown question', answers: raw, trust: 'untrusted' })
  }
  const get = key => values[mapping[key]] ?? []
  const single = key => { const v = get(key); return v.length === 1 && typeof v[0] === 'string' ? v[0].trim() : '' }
  let name = single('name'), email = single('email').toLowerCase(), services = get('services').filter(v => typeof v === 'string')
  if (!name || name.length > 200 || name.includes('\0')) { issues.push('CONTACT_REQUIRED'); name = 'Submission requires review' }
  if (!single('first') || !single('last')) issues.push('CONTACT_REQUIRED')
  if (!validEmail(email)) { email = ''; issues.push('EMAIL_REQUIRED') }
  if (response.respondentEmail && response.respondentEmail.toLowerCase() !== email) issues.push('EMAIL_MISMATCH')
  if (!services.length || services.length > 20 || services.some(s => !s.trim() || s.length > 200 || s.includes('\0'))) { issues.push('SERVICES_REQUIRED'); services = [] }
  const allowedServices = questions.get(mapping.services)?.question.choiceQuestion?.options?.map(o => o.value) ?? []
  if (services.some(s => !allowedServices.includes(s))) issues.push('SERVICES_REVIEW_REQUIRED')
  for (const key of ['terms', 'privacy', 'consent']) {
    const accepted = single(key)
    const allowed = questions.get(mapping[key])?.question.choiceQuestion?.options?.map(o => o.value) ?? []
    if (!accepted || !allowed.includes(accepted) || !/^(yes|i (?:accept|agree|consent)|accept|agree|consent|checked|true)(?:\b|$)/i.test(accepted)) issues.push('CONSENT_REQUIRED')
  }
  if (issues.includes('CREDENTIAL_CONTENT')) { name = 'Submission requires review'; email = ''; services = [] }
  return { sourceId: `${formId}:${response.responseId}`, version: hash([response.lastSubmittedTime, response.answers]), name, email, services, issues: [...new Set(issues)], evidence, references: [] }
}
export class GoogleIntake {
  constructor({ connection, fetch = globalThis.fetch, formId, maxPages = 20 }) {
    let resolvedFormId = null, configError = null
    try {
      resolvedFormId = formId === undefined ? googleFormIdFromEnv() : formId === null ? null : String(formId).trim()
      if (resolvedFormId !== null && !validGoogleFormId(resolvedFormId)) throw intakeError('GOOGLE_CONFIG_INVALID')
    } catch (error) { configError = error?.code ?? 'CLIENT_INTAKE_GOOGLE_CONFIG_INVALID'; resolvedFormId = null }
    Object.assign(this, { connection, fetch, formId: resolvedFormId, maxPages, configError })
  }
  async get(url) { return boundedJson(this.fetch, url, { headers: { authorization: `Bearer ${await this.connection.accessToken()}` } }) }
  async supportingReferences(email) {
    if (!validEmail(email)) return []
    const mail = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages')
    mail.search = new URLSearchParams({ q: `from:(${email}) newer_than:365d`, maxResults: '10', fields: 'messages(id,threadId),nextPageToken,resultSizeEstimate' })
    const drive = new URL('https://www.googleapis.com/drive/v3/files')
    // Membership predicates associate references with this contact without reading content.
    const escaped = email.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    drive.search = new URLSearchParams({ q: `trashed = false and ('${escaped}' in owners or '${escaped}' in writers)`, pageSize: '10', fields: 'files(id,name,mimeType,webViewLink),nextPageToken' })
    const [messages, files] = await Promise.all([this.get(mail.href), this.get(drive.href)])
    return [...(messages.messages ?? []).slice(0, 10).map(m => ({ kind: 'email', id: m.id, threadId: m.threadId, trust: 'untrusted' })), ...(files.files ?? []).slice(0, 10).map(f => ({ kind: 'drive', id: f.id, name: credentialLike(f.name ?? '') ? '[Withheld]' : f.name, mimeType: f.mimeType, url: typeof f.webViewLink === 'string' && /^https:\/\/(?:drive|docs)\.google\.com\//.test(f.webViewLink) ? f.webViewLink : null, trust: 'untrusted' }))]
  }
  async scan({ capture, recovery, checkpoint = () => {} }) {
    if (this.configError || !this.formId) throw intakeError(this.configError ? 'GOOGLE_CONFIG_INVALID' : 'GOOGLE_SETUP_REQUIRED')
    const base = `https://forms.googleapis.com/v1/forms/${encodeURIComponent(this.formId)}`
    const form = await this.get(base)
    if (form.formId !== this.formId || !Array.isArray(form.items) || form.items.length > 1000) throw intakeError('GOOGLE_SCHEMA')
    let pageToken = recovery?.formId === this.formId ? recovery.pageToken : undefined
    const visited = new Set()
    for (let page = 0; page < this.maxPages; page++) {
      if (visited.has(pageToken)) throw intakeError('PAGINATION_LOOP'); visited.add(pageToken)
      const url = new URL(`${base}/responses`); url.searchParams.set('pageSize', '100'); if (pageToken) url.searchParams.set('pageToken', pageToken)
      const data = await this.get(url.href)
      if ((data.responses !== undefined && !Array.isArray(data.responses)) || (data.responses?.length ?? 0) > 100 || (data.nextPageToken !== undefined && (typeof data.nextPageToken !== 'string' || data.nextPageToken.length > 4096))) throw intakeError('GOOGLE_SCHEMA')
      for (const response of data.responses ?? []) {
        const item = mapResponse(form, response, this.formId)
        if (!item.issues.length) {
          try { item.references = await this.supportingReferences(item.email) } catch { item.issues.push('SUPPORTING_REFERENCES_UNAVAILABLE') }
        }
        await capture(item)
      }
      pageToken = data.nextPageToken || null
      await checkpoint(pageToken ? { formId: this.formId, pageToken } : null)
      if (!pageToken) return { complete: true }
    }
    return { complete: false }
  }
}
