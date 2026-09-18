import assert from 'node:assert/strict'
import test from 'node:test'
import { createCodexSubscriptionModelRouter } from '../src/ceo/codex-subscription-provider.mjs'
import { modelOutputSchema } from '../src/ceo/structured-model-output.mjs'

function streamingCodex(events, observe = () => {}) {
  return { startThread(options) {
    observe('start', options)
    return { async runStreamed(prompt, controls) {
      observe('run', controls)
      return { events: (async function* () { yield* events })() }
    } }
  } }
}

const sessionScope = { rootTaskId: 'root-1', agentId: 'ace', assignmentId: 'assignment-1', projectId: 'project-1' }

function sessionCodex() {
  const starts = [], resumes = []
  let sequence = 0
  const thread = id => ({ id, async run() { return { finalResponse: '{"summary":"Done"}' } } })
  return {
    starts, resumes,
    startThread(options) { starts.push(options); return thread(`thread-${++sequence}`) },
    resumeThread(id, options) { resumes.push({ id, options }); return thread(id) },
  }
}

test('Codex continues a single assignment but isolates agents, tasks, projects, assignments, and stages', async () => {
  const codex = sessionCodex(), router = createCodexSubscriptionModelRouter({ codex })
  const route = (scope = sessionScope, stage = 'specialist') => router.route('Finish', { stage }, { sessionScope: scope })
  await route(); await route()
  assert.equal(codex.starts.length, 1)
  assert.equal(codex.resumes.length, 1)
  assert.equal(codex.resumes[0].id, 'thread-1')
  assert.deepEqual(codex.resumes[0].options, codex.starts[0])
  for (const field of Object.keys(sessionScope)) await route({ ...sessionScope, [field]: `different-${field}` })
  await route(sessionScope, 'synthesize')
  assert.equal(codex.starts.length, 6)
  // Model-visible context alone is not permission to attach to a prior session.
  await router.route('Finish', { stage: 'specialist', sessionScope })
  await router.route('Finish', { stage: 'specialist', sessionScope })
  assert.equal(codex.starts.length, 8)
})

test('Codex refuses overlapping turns and quarantines an ambiguous assignment instead of replaying it', async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  let calls = 0
  const router = createCodexSubscriptionModelRouter({ codex: { startThread() {
    calls++
    if (calls > 1) throw new Error('overlapping native start')
    return { id: 'thread-unknown', async run() { entered.resolve(); await release.promise; throw new Error('disconnected') } }
  } } })
  const pending = router.route('Finish', { stage: 'specialist' }, { sessionScope })
  const rejected = assert.rejects(pending, /disconnected/)
  await entered.promise
  try {
    await assert.rejects(router.route('Overlap', { stage: 'specialist' }, { sessionScope }), { code: 'CODEX_SESSION_BUSY' })
  } finally { release.resolve() }
  await rejected
  await assert.rejects(router.route('Retry?', { stage: 'specialist' }, { sessionScope }), { code: 'CODEX_SESSION_OUTCOME_UNKNOWN' })
  assert.equal(calls, 1)
})

test('Codex streams bounded metadata, passes cancellation, and waits for turn completion', async () => {
  const signal = new AbortController().signal
  const progress = [], observed = []
  const router = createCodexSubscriptionModelRouter({ codex: streamingCodex([
    { type: 'thread.started', thread_id: 'fixture-thread' },
    { type: 'turn.started' },
    ...Array.from({ length: 100 }, () => ({ type: 'item.updated', item: { type: 'reasoning', text: 'PRIVATE_REASONING' } })),
    { type: 'item.completed', item: { type: 'agent_message', text: '{"summary":"Done"}' } },
    { type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 3 } },
  ], (kind, value) => observed.push({ kind, value })) })
  assert.deepEqual(await router.route('Finish', { stage: 'synthesize' }, { signal, onProgress: item => progress.push(item) }), { summary: 'Done' })
  assert.equal(observed.find(row => row.kind === 'run').value.signal, signal)
  assert.deepEqual(progress, [
    { providerId: 'codex', phase: 'started' },
    { providerId: 'codex', phase: 'responding' },
    { providerId: 'codex', phase: 'completed' },
  ])
  assert.doesNotMatch(JSON.stringify(progress), /PRIVATE_REASONING|fixture-thread|Done/)
})

for (const tail of [[], [{ type: 'turn.failed', error: { message: 'SECRET failure detail' } }], [{ type: 'error', message: 'SECRET' }]]) {
  test(`Codex rejects incomplete/failed streams even after a final-looking message: ${JSON.stringify(tail.map(row => row.type))}`, async () => {
    const router = createCodexSubscriptionModelRouter({ codex: streamingCodex([
      { type: 'item.completed', item: { type: 'agent_message', text: '{"summary":"Not committed"}' } }, ...tail,
    ]) })
    await assert.rejects(router.route('Finish', { stage: 'synthesize' }), error =>
      ['CODEX_TURN_INCOMPLETE', 'CODEX_TURN_FAILED'].includes(error.code) && !error.message.includes('SECRET'))
  })
}

test('Codex never starts a pre-cancelled call and rejects a late result after cancellation', async () => {
  const controller = new AbortController()
  let starts = 0
  const router = createCodexSubscriptionModelRouter({ codex: { startThread() {
    starts++
    return { async run(_prompt, options) {
      assert.equal(options.signal, controller.signal)
      controller.abort()
      return { finalResponse: '{"summary":"stale"}' }
    } }
  } } })
  await assert.rejects(router.route('Finish', { stage: 'synthesize' }, { signal: controller.signal }), { name: 'AbortError' })
  await assert.rejects(router.route('Finish again', {}, { signal: controller.signal }), { name: 'AbortError' })
  assert.equal(starts, 1)
})

test('Codex rejects messages arriving after turn completion instead of treating them as a committed answer', async () => {
  const router = createCodexSubscriptionModelRouter({ codex: streamingCodex([
    { type: 'item.completed', item: { type: 'agent_message', text: '{"summary":"committed"}' } },
    { type: 'turn.completed' },
    { type: 'item.completed', item: { type: 'agent_message', text: '{"summary":"uncommitted"}' } },
  ]) })
  await assert.rejects(router.route('Finish', { stage: 'synthesize' }), { code: 'CODEX_TURN_PROTOCOL_INVALID' })
})

test('Codex cancellation during durable completion never returns a stale result or masks the abort', async () => {
  const controller = new AbortController(), codex = sessionCodex()
  let ambiguous = 0
  const sessions = {
    begin: async () => ({ threadId: null }),
    complete: async () => { controller.abort() },
    ambiguous: async () => { ambiguous++; throw new Error('already committed') },
  }
  await assert.rejects(createCodexSubscriptionModelRouter({ codex }).route('Finish', { stage: 'specialist' }, {
    signal: controller.signal, sessionScope, sessionBindings: sessions,
  }), { name: 'AbortError' })
  assert.equal(ambiguous, 0, 'A known completed native turn is not rewritten after the binding commit')
})

function assertStrictObjectSchemas(schema) {
  if (!schema || typeof schema !== 'object') return
  if (schema.type === 'object') {
    assert.deepEqual(
      [...(schema.required ?? [])].sort(),
      Object.keys(schema.properties ?? {}).sort(),
    )
    assert.equal(schema.additionalProperties, false)
  }
  for (const value of Object.values(schema)) {
    if (Array.isArray(value)) value.forEach(assertStrictObjectSchemas)
    else assertStrictObjectSchemas(value)
  }
}

test('Codex output schemas satisfy strict structured-output requirements', () => {
  for (const stage of ['decompose', 'specialist', 'specialist-loop', 'synthesize']) {
    assertStrictObjectSchemas(modelOutputSchema(stage))
  }
})

test('Codex subscription provider decodes strict specialist tool arguments into an object', async () => {
  let emittedPrompt
  const codex = {
    startThread() {
      return {
        async run(prompt) {
          emittedPrompt = prompt
          return {
            finalResponse: JSON.stringify({
              status: 'tool_request',
              summary: 'Create the pull request.',
              toolCall: {
                name: 'mcp__chimera_github__pr_create',
                arguments: JSON.stringify({
                  repository: 'example-org/example-repo',
                  title: 'Record the V1 golden live task',
                  head: 'chimera/v1-golden-acceptance-20260902',
                  base: 'main',
                }),
              },
            }),
            items: [],
            usage: null,
          }
        },
      }
    },
  }
  const router = createCodexSubscriptionModelRouter({ codex })

  const result = await router.route('Open the approved pull request.', { stage: 'specialist-loop' })

  assert.match(emittedPrompt, /arguments is a JSON-encoded string containing one object/)
  assert.deepEqual(result.toolCall.arguments, {
    repository: 'example-org/example-repo',
    title: 'Record the V1 golden live task',
    head: 'chimera/v1-golden-acceptance-20260902',
    base: 'main',
  })
})

test('Codex subscription provider rejects malformed strict specialist tool arguments', async () => {
  for (const argumentsValue of [
    'not-json',
    '[]',
    JSON.stringify({ payload: 'x'.repeat(64 * 1024) }),
  ]) {
    const codex = {
      startThread() {
        return {
          run: async () => ({
            finalResponse: JSON.stringify({
              status: 'tool_request',
              summary: 'Request a tool.',
              toolCall: { name: 'read', arguments: argumentsValue },
            }),
            items: [],
            usage: null,
          }),
        }
      },
    }
    const router = createCodexSubscriptionModelRouter({ codex })

    await assert.rejects(
      router.route('Use one bounded tool.', { stage: 'specialist-loop' }),
      (error) => error.code === 'MODEL_RESPONSE_TOOL_ARGUMENTS_INVALID',
    )
  }
})

test('Codex subscription provider uses a read-only Codex thread and returns structured output', async () => {
  const starts = []
  const runs = []
  const codex = {
    startThread(options) {
      starts.push(structuredClone(options))
      return {
        async run(prompt, options) {
          runs.push({ prompt, options: structuredClone(options) })
          return {
            finalResponse: JSON.stringify({
              tasks: [{
                specialistAgentId: 'researcher',
                objective: 'Inspect the bounded evidence.',
                acceptanceCriteria: ['Return one cited finding.'],
              }],
            }),
            items: [],
            usage: null,
          }
        },
      }
    },
  }
  const router = createCodexSubscriptionModelRouter({
    codex,
    model: 'gpt-5.6-sol',
    workingDirectory: '/workspace/chimera',
    reasoningEffort: 'high',
  })

  const result = await router.route('Plan this task.', {
    stage: 'decompose',
    taskId: 'task-codex-1',
    availableSpecialists: ['researcher'],
  })

  assert.equal(result.tasks[0].specialistAgentId, 'researcher')
  assert.deepEqual(starts, [{
    model: 'gpt-5.6-sol',
    workingDirectory: '/workspace/chimera',
    skipGitRepoCheck: false,
    sandboxMode: 'read-only',
    approvalPolicy: 'never',
    networkAccessEnabled: false,
    webSearchMode: 'disabled',
    modelReasoningEffort: 'high',
    threadSource: 'chimera',
  }])
  assert.equal(runs.length, 1)
  assert.match(runs[0].prompt, /Chimera context:/)
  assert.match(runs[0].prompt, /task-codex-1/)
  assert.equal(runs[0].options.outputSchema.required.includes('tasks'), true)
  assert.deepEqual(router.descriptor, {
    providerId: 'codex',
    model: 'gpt-5.6-sol',
    protocol: 'codex-sdk',
    authentication: 'chatgpt-subscription',
  })
})

test('Codex subscription provider rejects malformed final responses', async () => {
  const codex = {
    startThread() {
      return { run: async () => ({ finalResponse: 'not-json', items: [], usage: null }) }
    },
  }
  const router = createCodexSubscriptionModelRouter({ codex, model: 'gpt-5.6-terra' })

  await assert.rejects(
    router.route('Return a result.', { stage: 'specialist' }),
    (error) => error.code === 'MODEL_RESPONSE_INVALID_JSON',
  )
})
