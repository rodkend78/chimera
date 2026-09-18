import { validateModelRouter } from './model-router.mjs'
import { sha256 } from '../canonical.mjs'
import { CodexSessionBindings } from './codex-session-bindings.mjs'
import {
  composeStructuredModelPrompt,
  modelOutputSchema,
  parseStructuredModelResponse,
} from './structured-model-output.mjs'

const MAX_TOOL_ARGUMENT_BYTES = 64 * 1024

function boundedString(value, maximum = 2048) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function codedError(code) {
  return Object.assign(new Error(code), { code })
}

async function runTurn(thread, prompt, options, onProgress) {
  const emit = async phase => { await onProgress?.({ providerId: 'codex', phase }) }
  await emit('started')
  options.signal?.throwIfAborted()
  if (typeof thread.runStreamed !== 'function') return thread.run(prompt, options)
  const { events } = await thread.runStreamed(prompt, options)
  let finalResponse, completed = false, responding = false, count = 0
  for await (const event of events) {
    options.signal?.throwIfAborted()
    if (completed) throw codedError('CODEX_TURN_PROTOCOL_INVALID')
    if (++count > 100_000) throw codedError('CODEX_STREAM_LIMIT')
    if (event.type === 'turn.failed' || event.type === 'error') throw codedError('CODEX_TURN_FAILED')
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
      if (typeof event.item.text !== 'string' || Buffer.byteLength(event.item.text) > 2 * 1024 * 1024) throw codedError('CODEX_RESPONSE_LIMIT')
      finalResponse = event.item.text
      if (!responding) { responding = true; await emit('responding') }
    }
    if (event.type === 'turn.completed') completed = true
  }
  if (!completed) throw codedError('CODEX_TURN_INCOMPLETE')
  return { finalResponse }
}

function normalizeStrictToolArguments(response, stage) {
  if (stage !== 'specialist-loop' || response?.toolCall === null) return response
  const encoded = response?.toolCall?.arguments
  if (typeof encoded !== 'string'
    || encoded.length === 0
    || Buffer.byteLength(encoded, 'utf8') > MAX_TOOL_ARGUMENT_BYTES) {
    throw codedError('MODEL_RESPONSE_TOOL_ARGUMENTS_INVALID')
  }
  let argumentsObject
  try {
    argumentsObject = JSON.parse(encoded)
  } catch {
    throw codedError('MODEL_RESPONSE_TOOL_ARGUMENTS_INVALID')
  }
  if (!isRecord(argumentsObject)) throw codedError('MODEL_RESPONSE_TOOL_ARGUMENTS_INVALID')
  return {
    ...response,
    toolCall: {
      ...response.toolCall,
      arguments: argumentsObject,
    },
  }
}

export function createCodexSubscriptionModelRouter({
  codex = null,
  model = 'gpt-5.6-sol',
  workingDirectory = process.cwd(),
  reasoningEffort = 'high',
  skipGitRepoCheck = false,
} = {}) {
  if ((codex !== null && typeof codex?.startThread !== 'function')
    || !boundedString(model, 256)
    || !boundedString(workingDirectory, 4096)
    || !['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(reasoningEffort)
    || typeof skipGitRepoCheck !== 'boolean') {
    throw new TypeError('invalid Codex subscription provider')
  }
  const descriptor = Object.freeze({
    providerId: 'codex',
    model,
    protocol: 'codex-sdk',
    authentication: 'chatgpt-subscription',
  })
  const localSessions = new CodexSessionBindings()
  return validateModelRouter(Object.freeze({
    routerId: `codex:${model}`,
    descriptor,
    async route(prompt, context = {}, controls = {}) {
      const { signal, onProgress } = controls
      signal?.throwIfAborted()
      const client = codex ?? new (await import('@openai/codex-sdk')).Codex()
      signal?.throwIfAborted()
      const threadOptions = {
        model,
        workingDirectory,
        skipGitRepoCheck,
        sandboxMode: 'read-only',
        approvalPolicy: 'never',
        networkAccessEnabled: false,
        webSearchMode: 'disabled',
        modelReasoningEffort: reasoningEffort,
        threadSource: 'chimera',
      }
      const scope = controls.sessionScope
      let lease = null
      let committed = false
      const sessions = controls.sessionBindings ?? localSessions
      if (scope !== undefined) {
        if (!isRecord(scope) || !['rootTaskId', 'agentId', 'assignmentId', 'projectId'].every(field => boundedString(scope[field], 512))
          || !['decompose', 'specialist', 'specialist-loop', 'synthesize'].includes(context.stage)) throw codedError('CODEX_SESSION_SCOPE_INVALID')
        const key = sha256({ schema: 'chimera.codex-session.v1',
          rootTaskId: scope.rootTaskId, agentId: scope.agentId, assignmentId: scope.assignmentId,
          projectId: scope.projectId, stage: context.stage, threadOptions })
        lease = await sessions.begin(key)
      }
      try {
        signal?.throwIfAborted()
        const thread = lease?.threadId
          ? client.resumeThread(lease.threadId, threadOptions)
          : client.startThread(threadOptions)
        const result = await runTurn(thread, composeStructuredModelPrompt(prompt, context, {
          strictToolArguments: true,
        }), {
          outputSchema: modelOutputSchema(context?.stage),
          ...(signal ? { signal } : {}),
        }, onProgress)
        signal?.throwIfAborted()
        const response = normalizeStrictToolArguments(
          parseStructuredModelResponse(result?.finalResponse),
          context?.stage,
        )
        signal?.throwIfAborted()
        if (lease) {
          await sessions.complete(lease, thread.id)
          committed = true
        }
        signal?.throwIfAborted()
        await onProgress?.({ providerId: 'codex', phase: 'completed' })
        signal?.throwIfAborted()
        return response
      } catch (error) {
        if (lease && !committed) {
          try { await sessions.ambiguous(lease) } catch (persistenceFailure) {
            throw Object.assign(new AggregateError([error, persistenceFailure], 'CODEX_SESSION_PERSISTENCE_FAILED'), { code: 'CODEX_SESSION_PERSISTENCE_FAILED' })
          }
        }
        throw error
      }
    },
  }))
}
