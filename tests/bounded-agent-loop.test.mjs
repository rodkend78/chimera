import assert from 'node:assert/strict'
import test from 'node:test'
import { runBoundedAgentLoop } from '../src/agents/bounded-work-loop.mjs'
import { createDeterministicModelRouter } from '../src/ceo/model-router.mjs'

test('bounded agent loop gives an allowed tool observation back to the model before completion', async () => {
  const calls = []
  const events = []
  const router = createDeterministicModelRouter({
    responder: async (_prompt, context) => {
      calls.push(context)
      if (context.loop.turn === 1) {
        return {
          status: 'tool_request',
          summary: 'I need the continuity file.',
          toolCall: { name: 'read', arguments: { path: 'mounts/memory/MEMORY.md' } },
        }
      }
      return { status: 'completed', summary: `Used ${context.loop.observations[0].tool}.` }
    },
  })
  const worker = {
    async executeTool(call) {
      assert.equal(call.name, 'read')
      return { status: 'completed', result: { content: 'safe observation' } }
    },
  }

  const result = await runBoundedAgentLoop({
    router,
    worker,
    objective: 'Use continuity to answer.',
    context: { taskId: 'task-loop-1', specialistAgent: { agentId: 'ace' } },
    availableTools: ['read'],
    onEvent: async (event) => events.push(event),
  })

  assert.equal(result.summary, 'Used read.')
  assert.equal(result.toolCalls, 1)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].loop.observations[0].result.content, 'safe observation')
  assert.deepEqual(events.map((event) => event.kind), ['tool_request', 'tool_result'])
  assert.deepEqual(events.map((event) => event.provenance.verification), ['derived', 'derived'])
})

test('bounded agent loop derives an auditable summary when a compatible provider omits it from a tool request', async () => {
  const calls = []
  const events = []
  const router = createDeterministicModelRouter({
    responder: async (_prompt, context) => {
      calls.push(context)
      if (context.loop.turn === 1) {
        return {
          status: 'tool_request',
          toolCall: { name: 'glob', arguments: { pattern: 'mounts/persona/**/*' } },
        }
      }
      return { status: 'completed', summary: 'Continuity inspected.' }
    },
  })
  const result = await runBoundedAgentLoop({
    router,
    worker: { async executeTool() { return { status: 'completed', result: { paths: [] } } } },
    objective: 'Inspect continuity.',
    context: { taskId: 'task-loop-provider-compat', specialistAgent: { agentId: 'ace' } },
    availableTools: ['glob'],
    onEvent: async (event) => events.push(event),
  })

  assert.equal(result.summary, 'Continuity inspected.')
  assert.equal(result.toolCalls, 1)
  assert.equal(events[0].content, 'ace requested glob.')
  assert.match(calls[0].loop.toolContracts.glob.pattern, /zero or more/)
  assert.match(calls[0].loop.toolContracts.glob.path, /optional/)
  assert.match(calls[0].loop.toolContracts.glob.results, /truncated/)
})

test('bounded agent loop redacts sensitive tool observations before the model sees them', async () => {
  const calls = []
  const router = createDeterministicModelRouter({
    responder: async (_prompt, context) => {
      calls.push(context)
      if (context.loop.turn === 1) {
        return {
          status: 'tool_request',
          summary: 'Inspect the bounded result.',
          toolCall: { name: 'read', arguments: { path: 'mounts/memory/notes.json' } },
        }
      }
      return { status: 'completed', summary: 'Used the redacted observation.' }
    },
  })
  await runBoundedAgentLoop({
    router,
    worker: {
      async executeTool() {
        return {
          status: 'completed',
          result: {
            authorization: 'Bearer secret-token-value-12345',
            apiKey: 'sk-live-secret-value-12345',
            note: 'password=hunter2-super-secret',
            safe: 'public finding',
          },
        }
      },
    },
    objective: 'Use the result safely.',
    context: { taskId: 'task-loop-redaction', specialistAgent: { agentId: 'ace' } },
    availableTools: ['read'],
  })

  const encoded = JSON.stringify(calls[1].loop.observations[0])
  assert.doesNotMatch(encoded, /secret-token-value|sk-live-secret|hunter2/)
  assert.match(encoded, /\[REDACTED\]/)
  assert.equal(calls[1].loop.observations[0].result.safe, 'public finding')
})

test('bounded agent loop rejects a tool outside the supplied access profile without executing it', async () => {
  const router = createDeterministicModelRouter({
    responder: async () => ({
      status: 'tool_request',
      summary: 'Attempt network access.',
      toolCall: { name: 'web_fetch', arguments: { url: 'https://example.com' } },
    }),
  })
  let executed = false
  await assert.rejects(runBoundedAgentLoop({
    router,
    worker: { async executeTool() { executed = true } },
    objective: 'Read a local file.',
    context: { taskId: 'task-loop-2', specialistAgent: { agentId: 'ace' } },
    availableTools: ['read'],
  }), (error) => error?.code === 'AGENT_LOOP_TOOL_NOT_ALLOWED')
  assert.equal(executed, false)
})

test('bounded agent loop stops after the configured tool-call bound', async () => {
  const router = createDeterministicModelRouter({
    responder: async () => ({
      status: 'tool_request',
      summary: 'Keep reading.',
      toolCall: { name: 'read', arguments: { path: 'mounts/memory/MEMORY.md' } },
    }),
  })
  await assert.rejects(runBoundedAgentLoop({
    router,
    worker: { async executeTool() { return { status: 'completed', result: { content: 'ok' } } } },
    objective: 'Bound this task.',
    context: { taskId: 'task-loop-3', specialistAgent: { agentId: 'ace' } },
    availableTools: ['read'],
    maxTurns: 3,
    maxToolCalls: 2,
  }), (error) => error?.code === 'AGENT_LOOP_TOOL_LIMIT')
})

test('bounded agent loop halts after an unknown tool effect and never asks the model to repeat it', async () => {
  let modelCalls = 0
  const checkpoints = []
  const events = []
  await assert.rejects(runBoundedAgentLoop({
    router: createDeterministicModelRouter({ responder: async (_prompt, context) => {
      modelCalls += 1
      if (context.loop.turn === 1) return { status: 'tool_request', toolCall: { name: 'read', arguments: { path: 'scratch/mutation.txt' } } }
      return { status: 'completed', summary: 'The mutation is complete.' }
    } }),
    worker: { async executeTool() { return { status: 'unknown', reason: 'WORKER_TOOL_OUTCOME_UNKNOWN' } } },
    objective: 'Perform one mutation.',
    context: { taskId: 'task-tool-unknown', nodeId: 'node-one', specialistAgent: { agentId: 'ace' } },
    availableTools: ['read'],
    onCheckpoint: async checkpoint => checkpoints.push(checkpoint),
    onEvent: async event => events.push(event),
  }), { code: 'AGENT_LOOP_TOOL_OUTCOME_UNKNOWN' })
  assert.equal(modelCalls, 1)
  assert.equal(checkpoints.filter(value => value.stage === 'tool-dispatch').length, 1)
  assert.equal(checkpoints.at(-1).effectOutcome, 'unknown')
  assert.equal(events.filter(event => event.kind === 'tool_result').length, 0)
})

test('bounded agent loop resolves task execution context immediately before each tool call', async () => {
  let resolveCount = 0
  const router = createDeterministicModelRouter({
    responder: async (_prompt, context) => context.loop.turn < 3
      ? { status: 'tool_request', summary: 'Use the leased tool.', toolCall: { name: 'read', arguments: { path: 'scratch/result.txt' } } }
      : { status: 'completed', summary: 'done' },
  })
  const executions = []
  const result = await runBoundedAgentLoop({
    router,
    worker: { async executeTool(_call, execution) { executions.push(execution); return { status: 'completed', result: { ok: true } } } },
    objective: 'Use current task authority.',
    context: { taskId: 'task-loop-resolver', specialistAgent: { agentId: 'ace' } },
    availableTools: ['read'],
    toolExecution: async ({ turn }) => { resolveCount += 1; return { accessProfileId: turn === 1 ? 'connected' : 'sandbox' } },
  })
  assert.equal(result.status, 'completed')
  assert.equal(resolveCount, 2)
  assert.deepEqual(executions.map((execution) => execution.accessProfileId), ['connected', 'sandbox'])
})

test('coding default budget supports more than four tools and records completed checkpoints', async () => {
  const checkpoints = []
  const result = await runBoundedAgentLoop({
    router: createDeterministicModelRouter({ responder: async (_prompt, context) => context.loop.turn <= 8
      ? { status: 'tool_request', toolCall: { name: 'read', arguments: { path: 'scratch/code.js' } } }
      : { status: 'completed', summary: 'Inspected all eight files.' } }),
    worker: { executeTool: async () => ({ status: 'completed', result: { content: 'code' } }) },
    objective: 'Inspect the implementation.', context: { taskId: 'task-long-code', specialistAgent: { agentId: 'ace' } },
    availableTools: ['read'], onCheckpoint: async (value) => { checkpoints.push(value) },
  })
  assert.equal(result.toolCalls, 8)
  assert.equal(checkpoints.filter((value) => value.stage === 'tool-completed').length, 8)
  assert.equal(checkpoints.at(-1).summary, 'Inspected all eight files.')
})

test('cancellation during a tool preserves its observed result but never invokes another model turn', async () => {
  let cancelled = false
  let modelCalls = 0
  const checkpoints = []
  await assert.rejects(runBoundedAgentLoop({
    router: createDeterministicModelRouter({ responder: async () => {
      modelCalls += 1
      return { status: 'tool_request', toolCall: { name: 'read', arguments: { path: 'scratch/code.js' } } }
    } }),
    worker: { executeTool: async () => { cancelled = true; return { status: 'completed', result: { content: 'last completed work' } } } },
    objective: 'Inspect code.', context: { taskId: 'task-cancel-code', specialistAgent: { agentId: 'ace' } },
    availableTools: ['read'], onCheckpoint: async (value) => { checkpoints.push(value) },
    assertActive: () => { if (cancelled) throw Object.assign(new Error('TASK_CANCELLED'), { code: 'TASK_CANCELLED' }) },
  }), { code: 'TASK_CANCELLED' })
  assert.equal(modelCalls, 1)
  assert.equal(checkpoints.at(-1).observation.result.content, 'last completed work')
})

test('steering during model work discards the stale tool proposal and supplies new instruction', async () => {
  const steering = []
  let executed = false
  const result = await runBoundedAgentLoop({
    router: createDeterministicModelRouter({ responder: async (_prompt, context) => {
      if (context.loop.turn === 1) {
        steering.push({ sequence: 1, content: 'Only summarize; do not write.' })
        return { status: 'tool_request', toolCall: { name: 'write', arguments: { path: 'scratch/code.js', content: 'stale' } } }
      }
      assert.equal(context.steering[0].content, 'Only summarize; do not write.')
      return { status: 'completed', summary: 'Summarized.' }
    } }),
    worker: { executeTool: async () => { executed = true } },
    objective: 'Implement code.', context: { taskId: 'task-steer-code', specialistAgent: { agentId: 'ace' } },
    availableTools: ['write'], getSteering: () => steering,
  })
  assert.equal(result.summary, 'Summarized.')
  assert.equal(executed, false)
})

test('new peer inbox evidence discards a stale model proposal before peer dispatch', async () => {
  const inbox = []; let peerCalls = 0
  const result = await runBoundedAgentLoop({
    router: createDeterministicModelRouter({ responder: async (_prompt, context) => {
      if (context.loop.turn === 1) {
        inbox.push({ summary: 'Peer already finished the requested evidence.' })
        return { status: 'tool_request', toolCall: { name: 'agent_send', arguments: { recipientAgentId: 'iris', objective: 'Duplicate work' } } }
      }
      assert.match(context.inbox[0].summary, /already finished/)
      return { status: 'completed', summary: 'Used arrived evidence.' }
    } }),
    worker: { executeTool: async () => { throw new Error('No worker tool expected') } },
    objective: 'Check evidence.', context: { taskId: 'task-inbox', specialistAgent: { agentId: 'ace' } },
    availableTools: ['agent_send'], getInbox: () => inbox,
    executePeerTool: async () => { peerCalls++; return { status: 'queued' } },
  })
  assert.equal(result.summary, 'Used arrived evidence.')
  assert.equal(peerCalls, 0)
})

test('peer callback retains its original inbox revision across asynchronous admission', async () => {
  const inbox = []; let guarded = false
  const result = await runBoundedAgentLoop({
    router: createDeterministicModelRouter({ responder: async (_prompt, context) => context.loop.turn === 1
      ? { status: 'tool_request', toolCall: { name: 'agent_send', arguments: { recipientAgentId: 'iris', objective: 'Old work' } } }
      : { status: 'completed', summary: 'Replanned with the new inbox.' } }),
    worker: { executeTool: async () => { throw new Error('Unexpected DSH tool') } },
    objective: 'Peer work.', context: { taskId: 'peer-revision', specialistAgent: { agentId: 'ace' } },
    availableTools: ['agent_send'], getInbox: () => inbox,
    executePeerTool: async (_name, _args, proposal) => {
      await Promise.resolve()
      inbox.push({ summary: 'Do not repeat completed work.' })
      guarded = true
      proposal.assertProposalCurrent()
      throw new Error('Stale admission should have failed')
    },
  })
  assert.equal(guarded, true)
  assert.equal(result.summary, 'Replanned with the new inbox.')
})
