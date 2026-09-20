import { sha256 } from '../canonical.mjs'

export const TASK_OUTCOMES_SCHEMA = 'chimera.task-outcomes.v1'

const MAX_RECEIPTS = 256
const RECEIPT_KINDS = new Set(['artifact', 'check', 'review', 'publication'])
const RECEIPT_SOURCES = new Set([
  'worker-artifact-store',
  'bounded-check',
  'project-review',
  'publishing-adapter',
  'current-path-verifier',
  'signed-delivery',
  'runtime',
])

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function bounded(value, maximum = 4096) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function clone(value) {
  try { return structuredClone(value) } catch { return null }
}

function sameRevision(left, right) {
  if (left === undefined || left === null || right === undefined || right === null) return false
  try { return sha256(left) === sha256(right) } catch { return false }
}

function revisionLabel(revision) {
  if (typeof revision === 'string') return revision
  if (Number.isSafeInteger(revision)) return String(revision)
  if (record(revision)) {
    for (const key of ['scope', 'revisionId', 'id', 'digest', 'checkoutCommit']) {
      if (bounded(revision[key], 256)) return revision[key]
    }
    try { return sha256(revision).slice(0, 16) } catch { return 'unknown' }
  }
  return null
}

function baseScope(taskId, revision) {
  const label = revisionLabel(revision)
  return `task:${taskId}${label ? `@${label}` : ''}`
}

function evidenceRef(receipt) {
  if (bounded(receipt?.evidenceRef, 512)) return receipt.evidenceRef
  if (bounded(receipt?.receiptId, 256)) return receipt.receiptId
  return null
}

function observedAt(receipts) {
  const values = receipts
    .map(receipt => receipt?.observedAt)
    .filter(value => typeof value === 'string' && !Number.isNaN(Date.parse(value)))
  return values.length ? values.toSorted().at(-1) : null
}

function output({ state, refs = [], receipts = [], scope }) {
  return {
    state,
    evidenceRefs: [...new Set(refs.filter(value => bounded(value, 512)))],
    observedAt: observedAt(receipts),
    scope,
  }
}

function validReceipt(receipt, taskId, currentRevision) {
  if (!record(receipt)
    || !bounded(receipt.receiptId, 256)
    || !RECEIPT_KINDS.has(receipt.kind)
    || !bounded(receipt.taskId, 256)
    || receipt.taskId !== taskId
    || !RECEIPT_SOURCES.has(receipt.source)
    || !bounded(receipt.operationId, 256)
    || !bounded(receipt.observedAt, 128)
    || Number.isNaN(Date.parse(receipt.observedAt))
    || !record(receipt.outcome)) return false
  // A worker-artifact receipt proves durable materialization for this exact
  // task/session. It does not claim that the project checkout is current, so
  // artifact evidence remains useful even before a project revision exists.
  return receipt.kind === 'artifact' || sameRevision(receipt.revision, currentRevision)
}

function scopeFor(receipts, fallback) {
  const scope = receipts
    .map(receipt => receipt?.outcome?.scope)
    .find(value => bounded(value, 512))
  return scope ?? fallback
}

function artifactProof(receipt) {
  const outcome = receipt?.outcome
  return receipt?.kind === 'artifact'
    && receipt.source === 'worker-artifact-store'
    && outcome?.status === 'materialized'
    && bounded(outcome.artifactId, 256)
    && bounded(outcome.sessionId, 256)
    && bounded(outcome.agentId, 128)
    && typeof outcome.hash === 'string' && /^[0-9a-f]{64}$/.test(outcome.hash)
    && Number.isSafeInteger(outcome.size) && outcome.size >= 0
    && bounded(outcome.scope, 512)
}

function checkProof(receipt) {
  const outcome = receipt?.outcome
  if (!(receipt?.kind === 'check'
    && receipt.source === 'bounded-check'
    && ['passed', 'failed'].includes(outcome?.status)
    && bounded(outcome.command, 4096)
    && bounded(outcome.scope, 512))) return false
  if (outcome.status === 'passed') {
    return outcome.exitCode === 0 && (outcome.signal === undefined || outcome.signal === null)
  }
  return Number.isSafeInteger(outcome.exitCode) || bounded(outcome.signal, 128)
}

function reviewProof(receipt) {
  const outcome = receipt?.outcome
  return receipt?.kind === 'review'
    && receipt.source === 'project-review'
    && outcome?.status === 'current'
    && bounded(outcome.reviewDigest, 512)
    && bounded(outcome.scope, 512)
    && record(outcome.identity)
    && (bounded(outcome.identity.checkoutCommit, 256) || bounded(outcome.identity.workingTreeDigest, 512))
}

function publicationProof(receipt, source, status) {
  const outcome = receipt?.outcome
  return receipt?.kind === 'publication'
    && receipt.source === source
    && outcome?.status === status
    && bounded(outcome.path, 4096)
    && bounded(outcome.scope, 512)
}

function taskIdOf(task) {
  return bounded(task?.taskId, 256) ? task.taskId : 'unknown'
}

export function deriveTaskOutcomes({ task, receipts = [], review = null, currentRevision = null } = {}) {
  const taskId = taskIdOf(task)
  const fallbackScope = baseScope(taskId, currentRevision)
  const receiptOverflow = Array.isArray(receipts) && receipts.length > MAX_RECEIPTS
  const evidenceTruncated = task?.evidenceTruncated === true || receiptOverflow
  const all = Array.isArray(receipts) ? receipts.slice(0, MAX_RECEIPTS).map(clone).filter(Boolean) : []
  const relevant = all.filter(receipt => validReceipt(receipt, taskId, currentRevision))
  const stale = all.filter(receipt => record(receipt)
    && receipt.taskId === taskId
    && receipt.kind !== 'artifact'
    && receipt.revision !== undefined
    && !sameRevision(receipt.revision, currentRevision))

  const artifacts = relevant.filter(receipt => receipt.kind === 'artifact')
  const validArtifacts = artifacts.filter(artifactProof)
  const invalidArtifacts = artifacts.filter(receipt => !artifactProof(receipt))
  const workProduced = evidenceTruncated
    ? output({ state: 'unknown', refs: artifacts.map(evidenceRef), receipts: artifacts, scope: scopeFor(artifacts, `task:${taskId}`) })
    : validArtifacts.length
    ? output({ state: 'observed', refs: validArtifacts.map(evidenceRef), receipts: validArtifacts, scope: scopeFor(validArtifacts, `task:${taskId}`) })
    : output({ state: invalidArtifacts.length || stale.some(receipt => receipt.kind === 'artifact') ? 'unknown' : 'not-produced', scope: `task:${taskId}`, receipts: invalidArtifacts })

  const checks = relevant.filter(receipt => receipt.kind === 'check')
  const validChecks = checks.filter(checkProof)
  const invalidChecks = checks.filter(receipt => !checkProof(receipt))
  const failedChecks = validChecks.filter(receipt => receipt.outcome.status === 'failed')
  const checksPassed = evidenceTruncated
    ? output({ state: 'unknown', refs: checks.map(evidenceRef), receipts: checks, scope: scopeFor(checks, fallbackScope) })
    : checks.length === 0
    ? output({ state: stale.some(receipt => receipt.kind === 'check') ? 'unknown' : 'not-run', scope: fallbackScope })
    : invalidChecks.length
      ? output({ state: 'unknown', refs: checks.map(evidenceRef), receipts: checks, scope: scopeFor(checks, fallbackScope) })
      : output({ state: failedChecks.length ? 'failed' : 'passed', refs: checks.map(evidenceRef), receipts: checks, scope: scopeFor(checks, fallbackScope) })

  const reviewReceipts = relevant.filter(receipt => receipt.kind === 'review')
  const validReviews = reviewReceipts.filter(reviewProof)
  const reviewRecord = record(review) ? clone(review) : null
  const reviewRevisionMatches = reviewRecord && sameRevision(reviewRecord.revision, currentRevision)
  const reviewDigestMatches = reviewRecord && validReviews.some(receipt => receipt.outcome.reviewDigest === reviewRecord.reviewDigest)
  const currentIdentity = reviewRecord && record(reviewRecord.identity)
    && (bounded(reviewRecord.identity.checkoutCommit, 256) || bounded(reviewRecord.identity.workingTreeDigest, 512))
  const readyForReview = evidenceTruncated
    ? output({ state: 'unknown', refs: reviewReceipts.map(evidenceRef), receipts: reviewReceipts, scope: scopeFor(reviewReceipts, fallbackScope) })
    : !reviewRecord
    ? output({ state: 'not-reviewed', scope: fallbackScope })
    : !reviewRevisionMatches || reviewRecord.stale === true || !reviewDigestMatches
      ? output({ state: 'stale', refs: reviewReceipts.map(evidenceRef), receipts: reviewReceipts, scope: scopeFor(reviewReceipts, fallbackScope) })
      : !currentIdentity || !validReviews.length
        ? output({ state: 'unknown', refs: reviewReceipts.map(evidenceRef), receipts: reviewReceipts, scope: scopeFor(reviewReceipts, fallbackScope) })
        : output({ state: 'ready', refs: validReviews.map(evidenceRef), receipts: validReviews, scope: scopeFor(validReviews, fallbackScope) })

  const publicationReceipts = relevant.filter(receipt => receipt.kind === 'publication')
  const publication = publicationReceipts.find(receipt => publicationProof(receipt, 'publishing-adapter', 'published'))
  const verification = publicationReceipts.find(receipt => publicationProof(receipt, 'current-path-verifier', 'verified'))
  const publicationRefs = publicationReceipts.map(evidenceRef)
  let publishedState = evidenceTruncated ? 'unverified' : 'not-published'
  if (!evidenceTruncated && publicationReceipts.length > 0) {
    if (publication && verification
      && publication.outcome.path === verification.outcome.path
      && publication.outcome.scope === verification.outcome.scope) publishedState = 'published'
    else publishedState = 'unverified'
  }
  const publicationObserved = publication && verification ? [publication, verification] : publicationReceipts
  const published = output({ state: publishedState, refs: publishedState === 'published' ? publicationRefs : [], receipts: publicationObserved, scope: scopeFor(publicationObserved, fallbackScope) })

  return {
    schema: TASK_OUTCOMES_SCHEMA,
    taskId,
    workProduced,
    checksPassed,
    readyForReview,
    published,
  }
}

export { RECEIPT_KINDS as TASK_EVIDENCE_KINDS, RECEIPT_SOURCES as TASK_EVIDENCE_SOURCES }
