import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createDraftStore } from './draft-store.js'
import { draftKey, resolveComposerTarget } from './conversation-target.js'
import { buildComposerRequest, mentionSuggestions } from './conversation-composer-contract.js'
import { BrainCircuit, Pause, RefreshCw, Send, ShieldCheck } from './icons.jsx'

const MODES = [
  ['ask', 'Ask agent'],
  ['new-task', 'Start work'],
  ['guidance', 'Guide task'],
  ['continuation', 'Continue task'],
]
const ROUTING_PRESETS = [
  ['balanced', 'Balanced · declared priority'],
  ['latency', 'Prefer speed · observed latency'],
  ['quality', 'Prefer quality · declared quality'],
  ['economy', 'Prefer lower cost · measured evidence'],
]

function agentRows(state) {
  return [state?.agents?.main, ...(state?.agents?.specialists ?? [])].filter(Boolean)
    .map(agent => ({ agentId: agent.agentId, displayName: agent.displayName ?? agent.agentId, role: agent.role ?? '' }))
}

function taskRows(state) {
  return (state?.tasks ?? []).filter(task => ['queued', 'running', 'completed', 'failed', 'interrupted', 'cancelled'].includes(task.status))
}

function targetFor(state, mode, selection, recipients) {
  try { return resolveComposerTarget({ state, mode, selection, recipients }) } catch { return null }
}

function displayName(state, agentId) {
  return agentId === 'ceo' ? 'RJ' : state?.agents?.specialists?.find(agent => agent.agentId === agentId)?.displayName ?? agentId
}

function presetForMode(mode, priorityPreset) {
  if (!['new-task', 'continuation'].includes(mode) || priorityPreset === 'inherit') return null
  return { priorityPreset }
}

function defaultPreset(mode) {
  return mode === 'continuation' ? 'inherit' : 'balanced'
}

function sameRouting(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
}

export function ConversationComposer({ state, onSubmit, onLookup, onOpenSetup, onTargetChange, onConnectCodex, onSuspend, initialTarget = null, initialTargetVersion = 0 }) {
  const agents = useMemo(() => agentRows(state), [state?.agents])
  const tasks = useMemo(() => taskRows(state), [state?.tasks])
  const firstAgent = initialTarget?.requestedSpecialistAgentId ?? initialTarget?.recipientAgentIds?.[0] ?? agents[0]?.agentId ?? 'ceo'
  const [mode, setMode] = useState(initialTarget?.mode ?? 'ask')
  const [agentId, setAgentId] = useState(firstAgent)
  const [taskId, setTaskId] = useState(initialTarget?.taskId ?? '')
  const [recipients, setRecipients] = useState(initialTarget?.recipientAgentIds ?? [])
  const [replyTo, setReplyTo] = useState(initialTarget?.replyTo ?? null)
  const [content, setContent] = useState('')
  const [budget, setBudget] = useState(initialTarget?.budget ?? 'standard')
  const [priorityPreset, setPriorityPreset] = useState(initialTarget?.routingRequirements?.priorityPreset ?? defaultPreset(initialTarget?.mode ?? 'ask'))
  const [queueRequested, setQueueRequested] = useState(initialTarget?.queue !== false)
  const [notice, setNotice] = useState(null)
  const [busy, setBusy] = useState(false)
  const [mentionInput, setMentionInput] = useState('')
  const [unknownRequest, setUnknownRequest] = useState(null)
  const [knownFailure, setKnownFailure] = useState(null)
  const [history, setHistory] = useState([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [destinationReviewRequired, setDestinationReviewRequired] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const requestRef = useRef(null)
  const busyRef = useRef(false)
  const contentRef = useRef(content)
  const budgetRef = useRef(budget)
  const priorityPresetRef = useRef(priorityPreset)
  const currentTargetRef = useRef(null)
  const pendingRequestRef = useRef(null)
  const historyDraftRef = useRef(null)
  const hydratedTargetRef = useRef(null)
  const pendingHydrationRef = useRef(null)
  const appliedInitialTargetRef = useRef(null)
  const scopeKey = state?.draftScope?.workspaceId && state?.draftScope?.operatorId
    ? `${state.draftScope.workspaceId}:${state.draftScope.operatorId}` : null
  const storage = useMemo(() => {
    if (!scopeKey) return null
    try { return globalThis?.sessionStorage ?? null } catch { return null }
  }, [scopeKey])
  const store = useMemo(() => createDraftStore({
    storage,
    scope: scopeKey,
    onWarning: code => setNotice?.({ type: 'warning', text: code.replaceAll('_', ' ').toLowerCase() }),
  }), [scopeKey, storage])
  const selection = mode === 'guidance' || mode === 'continuation'
    ? { taskId, conversationId: taskId ? `task:${taskId}` : null, replyTo }
    : { agentId, requestedSpecialistAgentId: agentId, conversationId: agentId === 'ceo' ? 'main' : `agent:${agentId}` }
  const resolvedTarget = targetFor(state, mode, selection, mode === 'ask' ? [agentId] : recipients)
  const target = resolvedTarget ? { ...resolvedTarget, ...(mode === 'new-task' ? { queue: queueRequested } : {}) } : null
  const targetId = target ? draftKey(target) : null
  const targetRevision = target?.destinationRevision ?? null
  // The draft key intentionally excludes destinationRevision, but hydration
  // still has to rerun when the server-owned lifecycle revision changes.
  const hydrationKey = target ? `${targetId}:${targetRevision ?? 'none'}` : null
  const selectedTask = tasks.find(task => task.taskId === taskId)
  const destinationAvailable = mode === 'guidance'
    ? ['queued', 'running'].includes(selectedTask?.status)
    : mode === 'continuation'
      ? Boolean(selectedTask && !['queued', 'running'].includes(selectedTask.status))
      : true
  const eligible = state?.teamMessaging?.tasks?.find(task => task.taskId === taskId)?.eligibleRecipients
    ?? selectedTask?.eligibleRecipients ?? []
  const replyParents = (state?.conversations?.messages ?? []).filter(message => message?.taskId === taskId && message?.conversationId === `task:${taskId}`)
  const mentionRows = mentionSuggestions(mentionInput, agents.map(agent => ({ ...agent, eligible: eligible.includes(agent.agentId) })))
  const codex = state?.auth?.codex ?? { connected: false, status: 'unavailable' }

  const initialTargetKey = initialTarget ? draftKey(initialTarget) : null
  useLayoutEffect(() => {
    const applicationKey = initialTarget ? `${initialTargetKey}:${initialTargetVersion}` : null
    if (!initialTarget || applicationKey === appliedInitialTargetRef.current) return
    appliedInitialTargetRef.current = applicationKey
    setMode(initialTarget.mode ?? 'ask')
    setAgentId(initialTarget.requestedSpecialistAgentId ?? initialTarget.recipientAgentIds?.[0] ?? 'ceo')
    setTaskId(initialTarget.taskId ?? '')
    setRecipients(initialTarget.recipientAgentIds ?? [])
    setReplyTo(initialTarget.replyTo ?? null)
    if (initialTarget.budget) setBudget(initialTarget.budget)
    setPriorityPreset(initialTarget.routingRequirements?.priorityPreset ?? defaultPreset(initialTarget.mode ?? 'ask'))
    setNotice(null)
    setUnknownRequest(null)
    setDestinationReviewRequired(false)
  }, [initialTargetKey, initialTargetVersion, initialTarget])

  useEffect(() => { contentRef.current = content }, [content])
  useEffect(() => { budgetRef.current = budget }, [budget])
  useEffect(() => { priorityPresetRef.current = priorityPreset }, [priorityPreset])

  useLayoutEffect(() => {
    if (!target) return
    pendingHydrationRef.current = hydrationKey
    const saved = store.get(target)
    hydratedTargetRef.current = targetId
    currentTargetRef.current = target
    setHistoryIndex(-1)
    historyDraftRef.current = null
    if (saved?.status === 'accepted') {
      store.remove(target)
      setContent('')
      setBudget('standard')
      setPriorityPreset(defaultPreset(mode))
      requestRef.current = null
      pendingRequestRef.current = null
      setUnknownRequest(null)
      setKnownFailure(null)
      setDestinationReviewRequired(false)
    } else if (saved) {
      setContent(saved.content)
      setBudget(saved.budget ?? 'standard')
      setPriorityPreset(saved.routingRequirements?.priorityPreset ?? defaultPreset(mode))
      const pendingRequestId = saved.pendingRequestId ?? (['sending', 'unconfirmed'].includes(saved.status) ? saved.requestId : null)
      const pendingContent = saved.pendingContent ?? (['sending', 'unconfirmed'].includes(saved.status) ? saved.content : null)
      const pendingBudget = saved.pendingBudget ?? (pendingRequestId ? saved.budget : null)
      const pendingRoutingRequirements = Object.hasOwn(saved, 'pendingRoutingRequirements')
        ? saved.pendingRoutingRequirements
        : (pendingRequestId ? saved.routingRequirements ?? null : null)
      pendingRequestRef.current = pendingRequestId ? {
        requestId: pendingRequestId,
        content: pendingContent ?? '',
        budget: pendingBudget ?? 'standard',
        routingRequirements: pendingRoutingRequirements,
      } : null
      requestRef.current = saved.requestId && (!pendingRequestId || saved.requestId === pendingRequestId && saved.content === pendingContent) ? saved.requestId : null
      if (pendingRequestId) setUnknownRequest({ requestId: pendingRequestId, target, content: pendingContent ?? '', budget: pendingBudget ?? 'standard', routingRequirements: pendingRoutingRequirements })
      else setUnknownRequest(null)
      setKnownFailure(saved.failureCode ? { requestId: saved.requestId, code: saved.failureCode } : null)
      const stale = saved.destinationRevision !== null && target.destinationRevision !== null && saved.destinationRevision !== target.destinationRevision
      setDestinationReviewRequired(stale)
      if (saved.destinationRevision !== null && target.destinationRevision !== null && saved.destinationRevision !== target.destinationRevision) {
        setNotice({ type: 'warning', text: 'The destination changed while this draft was away. Review the target before sending.' })
      }
    } else {
      setContent('')
      setBudget(initialTarget?.budget ?? 'standard')
      setPriorityPreset(defaultPreset(mode))
      requestRef.current = null
      pendingRequestRef.current = null
      setUnknownRequest(null)
      setKnownFailure(null)
      setDestinationReviewRequired(false)
    }
    onTargetChange?.({ target, draftKey: targetId })
  }, [hydrationKey, initialTargetVersion, targetId, store])

  useEffect(() => {
    if (!target || hydratedTargetRef.current !== targetId || destinationReviewRequired) return
    // Hydration and persistence effects run in declaration order during the
    // same commit. Skip that first persistence pass so old editable state can
    // never be written under the newly selected destination. The rerender
    // caused by hydration performs the real save with the new state.
    if (pendingHydrationRef.current === hydrationKey) {
      pendingHydrationRef.current = null
      return
    }
    const pending = pendingRequestRef.current
    if (!content.trim() && !requestRef.current && !pending) {
      store.remove(target)
      return
    }
    try {
      store.save(target, {
        content,
        budget,
        routingRequirements: presetForMode(mode, priorityPreset),
        destinationRevision: target.destinationRevision ?? null,
        requestId: requestRef.current,
        ...(pending ? {
          pendingRequestId: pending.requestId,
          pendingContent: pending.content,
          pendingBudget: pending.budget,
          pendingRoutingRequirements: pending.routingRequirements,
        } : {}),
        ...(knownFailure?.code ? { failureCode: knownFailure.code } : {}),
        status: unknownRequest ? 'unconfirmed' : pending ? 'sending' : 'draft',
      })
    } catch (error) {
      setNotice({ type: 'warning', text: String(error?.message ?? error).replaceAll('_', ' ').toLowerCase() })
    }
  }, [content, budget, priorityPreset, mode, hydrationKey, initialTargetVersion, targetId, unknownRequest, knownFailure, destinationReviewRequired, store])

  const updateMode = nextMode => {
    setMode(nextMode)
    setNotice(null)
    setUnknownRequest(null)
    if (nextMode === 'guidance' || nextMode === 'continuation') {
      setReplyTo(null)
      setRecipients([])
    }
    if (nextMode === 'continuation' && priorityPreset === 'balanced') setPriorityPreset('inherit')
    if (nextMode === 'new-task') {
      setQueueRequested(true)
      if (priorityPreset === 'inherit') setPriorityPreset('balanced')
    }
  }

  const updatePriorityPreset = nextPreset => {
    if (requestRef.current && nextPreset !== priorityPreset) requestRef.current = null
    setPriorityPreset(nextPreset)
  }

  const selectMention = agent => {
    setRecipients(current => current.includes(agent.agentId) ? current : [...current, agent.agentId].toSorted())
    setMentionInput('')
  }

  const rememberAccepted = () => {
    if (!target || !content.trim()) return
    const entry = { target: structuredClone(target), content, budget, priorityPreset }
    setHistory(current => [entry, ...current.filter(row => draftKey(row.target) !== targetId || row.content !== content)].slice(0, 20))
    setHistoryIndex(-1)
    historyDraftRef.current = null
  }

  const onEditorKeyDown = event => {
    if (!['ArrowUp', 'ArrowDown'].includes(event.key) || !target) return
    const atStart = event.currentTarget.selectionStart === 0 && event.currentTarget.selectionEnd === 0
    const sameTarget = entry => entry && draftKey(entry.target) === targetId
    const entries = history.filter(entry => sameTarget(entry))
    if (event.key === 'ArrowUp' && (atStart || !content.trim()) && entries.length) {
      event.preventDefault()
      if (historyIndex < 0) historyDraftRef.current = { content, budget, priorityPreset }
      const nextIndex = historyIndex < 0 ? 0 : Math.min(historyIndex + 1, entries.length - 1)
      setHistoryIndex(nextIndex)
      setContent(entries[nextIndex].content)
      setBudget(entries[nextIndex].budget)
      setPriorityPreset(entries[nextIndex].priorityPreset ?? defaultPreset(mode))
    } else if (event.key === 'ArrowDown' && historyIndex >= 0) {
      event.preventDefault()
      const nextIndex = historyIndex - 1
      if (nextIndex < 0) {
        setHistoryIndex(-1)
        setContent(historyDraftRef.current?.content ?? '')
        setBudget(historyDraftRef.current?.budget ?? 'standard')
        setPriorityPreset(historyDraftRef.current?.priorityPreset ?? defaultPreset(mode))
        historyDraftRef.current = null
      } else {
        setHistoryIndex(nextIndex)
        setContent(entries[nextIndex].content)
        setBudget(entries[nextIndex].budget)
        setPriorityPreset(entries[nextIndex].priorityPreset ?? defaultPreset(mode))
      }
    }
  }

  const submit = async event => {
    event.preventDefault()
    if (!target || !content.trim() || busy || busyRef.current || unknownRequest || destinationReviewRequired) return
    const requestId = requestRef.current ?? `composer-${crypto.randomUUID()}`
    requestRef.current = requestId
    const savedContent = content
    const savedBudget = budget
    const savedRoutingRequirements = presetForMode(mode, priorityPreset)
    const request = buildComposerRequest({ target, content: savedContent, requestId, budget: savedBudget, routingRequirements: savedRoutingRequirements })
    pendingRequestRef.current = { requestId, content: savedContent, budget: savedBudget, routingRequirements: savedRoutingRequirements }
    setKnownFailure(null)
    const canUpdateSubmittedDraft = () => {
      const currentDraft = store.get(target)
      return !currentDraft
        || (currentDraft.requestId === requestId && currentDraft.content === savedContent && currentDraft.budget === savedBudget && sameRouting(currentDraft.routingRequirements, savedRoutingRequirements))
        || (currentDraft.pendingRequestId === requestId && currentDraft.content === savedContent && currentDraft.budget === savedBudget && sameRouting(currentDraft.routingRequirements, savedRoutingRequirements))
    }
    const settleSubmittedDraft = (extra = {}) => {
      const currentDraft = store.get(target)
      if (!currentDraft) {
        store.save(target, { content: savedContent, budget: savedBudget, routingRequirements: savedRoutingRequirements, destinationRevision: target.destinationRevision ?? null,
          requestId: null, pendingRequestId: null, pendingContent: null, status: 'draft', ...extra })
        return true
      }
      // A newer editable value is allowed to replace the submitted content
      // while the response is in flight. It still belongs to this request's
      // draft row until this exact request settles; clear only its pending
      // identity and retain that newer value.
      if ((currentDraft.requestId !== requestId && currentDraft.pendingRequestId !== requestId)
        || currentDraft.content !== savedContent
        || currentDraft.budget !== savedBudget
        || !sameRouting(currentDraft.routingRequirements, savedRoutingRequirements)) return false
      store.save(target, { ...currentDraft, requestId: null, pendingRequestId: null, pendingContent: null, pendingBudget: null, pendingRoutingRequirements: null, status: 'draft', ...extra })
      return true
    }
    const clearSettledPendingIdentity = (extra = {}) => {
      const currentDraft = store.get(target)
      if (!currentDraft || (currentDraft.requestId !== requestId && currentDraft.pendingRequestId !== requestId)) return false
      store.save(target, {
        ...currentDraft,
        requestId: null,
        pendingRequestId: null,
        pendingContent: null,
        pendingBudget: null,
        pendingRoutingRequirements: null,
        status: 'draft',
        ...extra,
      })
      return true
    }
    const targetIsCurrent = () => currentTargetRef.current && draftKey(currentTargetRef.current) === targetId
    try {
      store.save(target, { content: savedContent, budget: savedBudget, routingRequirements: savedRoutingRequirements, destinationRevision: target.destinationRevision ?? null, requestId, pendingRequestId: requestId, pendingContent: savedContent, pendingBudget: savedBudget, pendingRoutingRequirements: savedRoutingRequirements, status: 'sending' })
    } catch (error) {
      setNotice({ type: 'error', text: String(error?.message ?? error).replaceAll('_', ' ').toLowerCase() })
      return
    }
    busyRef.current = true
    setBusy(true)
    setNotice(null)
    try {
      const result = await onSubmit(request, target)
      const resultStatus = result?.status ?? result?.receipt?.status
      const receipt = result?.receipt
      const receiptMatches = receipt?.requestId === requestId
        && receipt.status === 'accepted'
        && receipt.operation === ({ ask: null, 'new-task': 'new-task', guidance: target.recipientAgentIds?.length ? 'task-message' : 'task-steer', continuation: 'continuation' }[target.mode] ?? null)
      const accepted = target.mode === 'ask'
        ? result?.schema === 'chimera.ask-result.v1'
          && result.requestId === requestId
          && result.conversationId === target.conversationId
          && result.recipientAgentId === target.recipientAgentIds?.[0]
          && result.status === 'completed'
          && typeof result.messageId === 'string'
          && typeof result.answer === 'string'
        : receiptMatches
          && (typeof result?.taskId === 'string' || typeof result?.task?.taskId === 'string' || typeof result?.message?.messageId === 'string')
          && (target.mode !== 'guidance' || (Number.isSafeInteger(result?.destinationRevision) && (target.destinationRevision === null || result.destinationRevision >= target.destinationRevision)))
      const knownNotSent = target.mode === 'ask'
        && result?.schema === 'chimera.ask-result.v1'
        && result.requestId === requestId
        && result.conversationId === target.conversationId
        && result.recipientAgentId === target.recipientAgentIds?.[0]
        && result.status === 'failed-not-sent'
        && typeof result.failureCode === 'string'
      const acceptedMessage = typeof result?.message === 'string'
        ? result.message : typeof result?.acknowledgement === 'string'
          ? result.acknowledgement : 'Request accepted. Inspect the destination for status.'
      const unchanged = targetIsCurrent() && contentRef.current === savedContent && budgetRef.current === savedBudget && sameRouting(presetForMode(mode, priorityPresetRef.current), savedRoutingRequirements)
      if (knownNotSent) {
        if (targetIsCurrent()) {
          pendingRequestRef.current = null
          requestRef.current = null
          setUnknownRequest(null)
          setKnownFailure({ requestId, code: result.failureCode })
        }
        if (!settleSubmittedDraft({ failureCode: result.failureCode })
          && !clearSettledPendingIdentity({ failureCode: result.failureCode })
          && canUpdateSubmittedDraft()) store.save(target, { content: savedContent, budget: savedBudget, routingRequirements: savedRoutingRequirements, destinationRevision: target.destinationRevision ?? null, requestId: null, failureCode: result.failureCode, status: 'draft' })
        if (targetIsCurrent()) setNotice({ type: 'warning', text: `Ask was not sent (${result.failureCode.replaceAll('_', ' ').toLowerCase()}). Retry as a new request.` })
      } else if (!accepted || result?.uncertain || ['unknown', 'unconfirmed', 'pending', 'reserved'].includes(resultStatus) || result?.receipt?.status === 'unknown') {
        if (canUpdateSubmittedDraft()) store.save(target, { content: savedContent, budget: savedBudget, routingRequirements: savedRoutingRequirements, destinationRevision: target.destinationRevision ?? null, requestId: null, pendingRequestId: requestId, pendingContent: savedContent, pendingBudget: savedBudget, pendingRoutingRequirements: savedRoutingRequirements, status: 'unconfirmed' })
        if (targetIsCurrent()) {
          setUnknownRequest({ requestId, target, content: savedContent, budget: savedBudget, routingRequirements: savedRoutingRequirements })
          setNotice({ type: 'warning', text: 'Outcome unknown. Check the saved receipt or history; nothing was resubmitted.' })
        }
      } else if (accepted) {
        // Finalize the request's own draft even when the user switched to a
        // different destination or typed a newer draft while it was in flight.
        const currentDraft = store.get(target)
        const requestStillOwnsDraft = !currentDraft
          || (currentDraft.requestId === requestId && currentDraft.content === savedContent && currentDraft.budget === savedBudget && sameRouting(currentDraft.routingRequirements, savedRoutingRequirements))
        if (targetIsCurrent()) {
          // The accepted request is terminal even when editable budget or
          // routing choices changed while it was in flight. Retire its ID so
          // the next explicit submission gets a fresh admission identity;
          // the newer draft remains in the scoped store below.
          pendingRequestRef.current = null
          requestRef.current = null
        }
        rememberAccepted()
        if (requestStillOwnsDraft) store.remove(target)
        else if (currentDraft) store.save(target, { ...currentDraft, requestId: null, pendingRequestId: null, pendingContent: null, pendingBudget: null, pendingRoutingRequirements: null, status: 'draft' })
        if (unchanged) {
          setContent('')
          setUnknownRequest(null)
          setKnownFailure(null)
          setNotice({ type: 'success', text: acceptedMessage })
        } else if (targetIsCurrent()) {
          setNotice({ type: 'success', text: `${acceptedMessage} Your newer draft was preserved.` })
        }
      } else {
        if (targetIsCurrent()) {
          pendingRequestRef.current = null
          requestRef.current = null
        }
        if (!settleSubmittedDraft()
          && !clearSettledPendingIdentity()
          && canUpdateSubmittedDraft()) store.save(target, { content: savedContent, budget: savedBudget, routingRequirements: savedRoutingRequirements, destinationRevision: target.destinationRevision ?? null, requestId: null, status: 'draft' })
        if (targetIsCurrent()) setNotice({ type: 'error', text: 'The response did not contain a valid acceptance receipt. Inspect the destination before retrying.' })
      }
    } catch (error) {
      const uncertain = error?.ambiguous === true || error?.reconciliationRequired === true
      const unchanged = currentTargetRef.current && draftKey(currentTargetRef.current) === targetId
        && contentRef.current === savedContent && budgetRef.current === savedBudget && sameRouting(presetForMode(mode, priorityPresetRef.current), savedRoutingRequirements)
      if (!uncertain && targetIsCurrent()) {
        pendingRequestRef.current = null
        requestRef.current = null
      }
      if (uncertain) {
        if (canUpdateSubmittedDraft()) store.save(target, { content: savedContent, budget: savedBudget, routingRequirements: savedRoutingRequirements, destinationRevision: target.destinationRevision ?? null, requestId: null, pendingRequestId: requestId, pendingContent: savedContent, pendingBudget: savedBudget, pendingRoutingRequirements: savedRoutingRequirements, status: 'unconfirmed' })
      } else if (!settleSubmittedDraft()) {
        if (!clearSettledPendingIdentity() && canUpdateSubmittedDraft()) store.save(target, { content: savedContent, budget: savedBudget, routingRequirements: savedRoutingRequirements, destinationRevision: target.destinationRevision ?? null, requestId: null, status: 'draft' })
      }
      if (uncertain && targetIsCurrent()) {
        setUnknownRequest({ requestId, target, content: savedContent, budget: savedBudget, routingRequirements: savedRoutingRequirements })
        setNotice({ type: 'warning', text: 'The request outcome is unconfirmed. Check its status before taking another action.' })
      } else if (targetIsCurrent()) setNotice({ type: 'error', text: String(error?.message ?? error).replaceAll('_', ' ').toLowerCase() })
    } finally { busyRef.current = false; setBusy(false) }
  }

  const lookup = async () => {
    if (!unknownRequest || typeof onLookup !== 'function') return
    if (busyRef.current) return
    const lookupTarget = unknownRequest.target
    const lookupTargetId = draftKey(lookupTarget)
    const lookupIsCurrent = () => currentTargetRef.current && draftKey(currentTargetRef.current) === lookupTargetId
    const lookupRequestId = unknownRequest.requestId
    const lookupContent = unknownRequest.content ?? ''
    const lookupBudget = unknownRequest.budget ?? 'standard'
    busyRef.current = true
    setBusy(true)
    try {
      const result = await onLookup(lookupRequestId, lookupTarget)
      const status = result?.status ?? result?.receipt?.status
      const matches = lookupTarget.mode === 'ask'
        ? result?.schema === 'chimera.ask-result.v1' && result.requestId === lookupRequestId
          && result.conversationId === lookupTarget.conversationId && result.recipientAgentId === lookupTarget.recipientAgentIds?.[0]
        : result?.requestId === unknownRequest.requestId && result?.status === 'accepted'
          && result?.operation === ({ 'new-task': 'new-task', guidance: lookupTarget.recipientAgentIds?.length ? 'task-message' : 'task-steer', continuation: 'continuation' }[lookupTarget.mode] ?? null)
      const knownNotSent = matches && lookupTarget.mode === 'ask' && result?.status === 'failed-not-sent' && typeof result.failureCode === 'string'
      if (knownNotSent) {
        if (lookupIsCurrent()) {
          pendingRequestRef.current = null
          requestRef.current = null
          setUnknownRequest(null)
          setKnownFailure({ requestId: lookupRequestId, code: result.failureCode })
        }
        const currentDraft = store.get(lookupTarget)
        if (currentDraft) store.save(lookupTarget, { ...currentDraft, requestId: null, pendingRequestId: null, pendingContent: null, pendingBudget: null, pendingRoutingRequirements: null, failureCode: result.failureCode, status: 'draft' })
        if (lookupIsCurrent()) setNotice({ type: 'warning', text: `Ask was not sent (${result.failureCode.replaceAll('_', ' ').toLowerCase()}). Retry as a new request.` })
      } else if (!matches || !['accepted', 'succeeded', 'completed'].includes(status)) {
        if (lookupIsCurrent()) setNotice({ type: 'warning', text: 'The saved receipt is still unresolved. Do not resend this request.' })
      } else {
        const currentDraft = store.get(lookupTarget)
        const unchanged = lookupIsCurrent()
          ? contentRef.current === lookupContent && budgetRef.current === lookupBudget && sameRouting(presetForMode(lookupTarget.mode ?? mode, priorityPresetRef.current), unknownRequest.routingRequirements)
          : !currentDraft || (currentDraft.content === lookupContent && currentDraft.pendingRequestId === lookupRequestId
            && currentDraft.budget === lookupBudget && sameRouting(currentDraft.routingRequirements, unknownRequest.routingRequirements))
        if (lookupIsCurrent()) {
          pendingRequestRef.current = null
          requestRef.current = null
        }
        if (unchanged) {
          store.remove(lookupTarget)
          if (lookupIsCurrent()) {
            setContent('')
            setUnknownRequest(null)
            setKnownFailure(null)
          }
        } else {
          if (currentDraft) store.save(lookupTarget, { ...currentDraft, requestId: null, pendingRequestId: null, pendingContent: null, pendingBudget: null, pendingRoutingRequirements: null, status: 'draft' })
          if (lookupIsCurrent()) setUnknownRequest(null)
        }
        if (lookupIsCurrent()) setNotice({ type: 'success', text: `Saved outcome: ${status}.` })
      }
    } catch (error) { setNotice({ type: 'warning', text: `${String(error?.message ?? error).replaceAll('_', ' ').toLowerCase()}. No request was retried.` }) } finally { busyRef.current = false; setBusy(false) }
  }

  const modeLabel = MODES.find(([value]) => value === mode)?.[1] ?? 'Send'
  const recipientLabel = recipients.length ? recipients.map(id => `@${displayName(state, id)}`).join(', ') : 'No recipients selected'
  return <section className="conversation-composer" aria-label="Conversation composer" data-mode={mode} data-recovery={Boolean(unknownRequest)}>
    <header className="conversation-composer-header"><div><span className="card-kicker">Target first</span><h2>Conversation</h2><p>Choose the exact agent or task before writing. Changing targets selects a separate draft.</p></div><div className="conversation-composer-header-actions">{onOpenSetup ? <button type="button" onClick={() => onOpenSetup({ target, draftKey: targetId })}><ShieldCheck size={15} />Agent setup</button> : null}<button type="button" disabled={connecting || codex.status === 'connecting'} onClick={async () => { setConnecting(true); try { await onConnectCodex?.() } finally { setConnecting(false) } }}>{connecting ? 'Opening…' : codex.connected ? 'Codex connected' : codex.status === 'connecting' ? 'Sign-in open' : <><BrainCircuit size={15} />Connect Codex</>}</button><button type="button" onClick={onSuspend}>{state?.suspended ? <RefreshCw size={15} /> : <Pause size={15} />}{state?.suspended ? 'Resume' : 'Suspend'}</button></div></header>
    {notice || unknownRequest ? <div className="conversation-feedback">
      {notice ? <p role={notice.type === 'error' ? 'alert' : 'status'} className={`conversation-notice ${notice.type}`}>{notice.text}</p> : null}
      {unknownRequest ? <div className="conversation-recovery-actions">
        <button type="button" className="conversation-receipt-lookup" disabled={busy} onClick={lookup}>Check saved outcome</button>
        <details className="conversation-recovery-details"><summary>Request details</summary><code>{unknownRequest.requestId}</code></details>
      </div> : null}
    </div> : null}
    <div className="conversation-composer-controls">
      <label>Action<select aria-label="Conversation action" value={mode} onChange={event => updateMode(event.target.value)}>{MODES.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
      {mode === 'guidance' || mode === 'continuation' ? <label>Task<select aria-label="Conversation task" value={taskId} onChange={event => setTaskId(event.target.value)}><option value="">Choose a task</option>{tasks.map(task => <option key={task.taskId} value={task.taskId}>{task.objective} · {task.status}</option>)}</select></label> : <label>Agent<select aria-label="Conversation agent" value={agentId} onChange={event => setAgentId(event.target.value)}>{agents.map(agent => <option key={agent.agentId} value={agent.agentId}>{agent.displayName} · {agent.role}</option>)}</select></label>}
      {mode === 'continuation' || mode === 'new-task' ? <label>Budget<select aria-label="Conversation budget" value={budget} onChange={event => setBudget(event.target.value)}><option value="standard">Standard · 32 turns / 24 tools</option><option value="extended">Extended · 64 turns / 48 tools</option></select></label> : null}
      {mode === 'continuation' || mode === 'new-task' ? <label>Routing<select aria-label="Task routing preference" value={priorityPreset} onChange={event => updatePriorityPreset(event.target.value)}>{mode === 'continuation' ? <option value="inherit">Use captured task preference</option> : null}{ROUTING_PRESETS.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label> : null}
      {mode === 'new-task' ? <label className="conversation-queue-choice"><span>Admission</span><span><input type="checkbox" checked={queueRequested} onChange={event => setQueueRequested(event.target.checked)} /> Queue if RJ is busy</span></label> : null}
    </div>
    {mode === 'guidance' && taskId ? <div className="conversation-recipient-area"><span>Recipients</span><div className="conversation-recipient-chips">{recipients.map(id => <button type="button" key={id} onClick={() => setRecipients(current => current.filter(value => value !== id))}>@{displayName(state, id)} ×</button>)}{!recipients.length ? <small>{recipientLabel} · guidance will steer the task</small> : null}</div><label>Mentions<input aria-label="Mention teammates" value={mentionInput} onChange={event => setMentionInput(event.target.value)} placeholder="Type a name or ID" /></label>{mentionInput.trim() && mentionRows.length ? <div className="conversation-mention-suggestions" role="listbox" aria-label="Mention suggestions">{mentionRows.map(agent => <button type="button" role="option" key={agent.agentId} onClick={() => selectMention(agent)}>@{agent.displayName} · {agent.agentId}</button>)}</div> : null}</div> : null}
    {mode === 'guidance' && taskId && replyParents.length ? <label>Reply parent<select aria-label="Reply parent" value={replyTo ?? ''} onChange={event => setReplyTo(event.target.value || null)}><option value="">No parent</option>{replyParents.map(message => <option value={message.messageId} key={message.messageId}>{message.content.slice(0, 80)}</option>)}</select></label> : null}
    <form onSubmit={submit}><textarea aria-label={mode === 'ask' ? 'Ask agent' : mode === 'new-task' ? 'New task objective' : mode === 'continuation' ? 'Continuation objective' : 'Task guidance'} value={content} maxLength={16 * 1024} onKeyDown={onEditorKeyDown} onChange={event => { const nextContent = event.target.value; if (requestRef.current && nextContent !== contentRef.current) requestRef.current = null; if (knownFailure && nextContent !== contentRef.current) setKnownFailure(null); setHistoryIndex(-1); setContent(nextContent) }} placeholder={target ? `Write a ${modeLabel.toLowerCase()} for the selected destination…` : 'Choose a destination first…'} />{destinationReviewRequired ? <div className="conversation-destination-review" role="alert"><span>The selected task changed. Review its current lifecycle before sending.</span><button type="button" onClick={() => { setDestinationReviewRequired(false); if (target) store.save(target, { content, budget, routingRequirements: presetForMode(mode, priorityPreset), destinationRevision: target.destinationRevision ?? null, requestId: requestRef.current, status: unknownRequest ? 'unconfirmed' : 'draft' }) }}>Review current destination</button></div> : null}<div className="conversation-composer-footer"><span>{target && destinationAvailable ? `${modeLabel} · ${target.conversationId}${target.taskId ? ` · ${target.taskId}` : ''}` : 'Destination unavailable'}</span><button type="submit" className="primary-action" disabled={busy || Boolean(unknownRequest) || destinationReviewRequired || !target || !destinationAvailable || !content.trim()}>{busy ? 'Sending…' : unknownRequest ? 'Check outcome first' : knownFailure ? 'Retry as new request' : modeLabel}<Send size={16} /></button></div></form>
  </section>
}

export { buildComposerRequest, mentionSuggestions }
