import test from 'node:test'
import { openTask4Fixture, assert } from './task4-ui-fixture.mjs'

test('rendered composer keeps drafts bound to the selected agent and never writes across target switch', { timeout: 20000 }, async t => {
  const { page, calls, errors } = await openTask4Fixture(t)
  const editor = page.getByRole('textbox', { name: 'Ask agent', exact: true })
  await editor.fill('Private draft for RJ only')
  await page.getByRole('combobox', { name: 'Conversation agent', exact: true }).selectOption('ace')
  await page.waitForFunction(() => document.querySelector('[aria-label="Ask agent"]')?.value === '')
  const stored = await page.evaluate(() => Object.entries(sessionStorage)
    .filter(([key]) => key.includes('chimera.conversation-drafts.v1:'))
    .map(([key, value]) => ({ key, value: JSON.parse(value) })))
  assert.equal(stored.some(entry => entry.value.draft?.content === 'Private draft for RJ only'), true)
  assert.equal(stored.some(entry => entry.key.includes('agent%3Aace') && entry.value.draft?.content === 'Private draft for RJ only'), false)
  await page.getByRole('combobox', { name: 'Conversation agent', exact: true }).selectOption('ceo')
  assert.equal(await editor.inputValue(), 'Private draft for RJ only')
  assert.deepEqual(calls.filter(call => call.path !== '/api/state'), [])
  assert.deepEqual(errors, [])
})

test('rendered Ask requires its exact completion identity and preserves malformed outcomes for read-only lookup', { timeout: 20000 }, async t => {
  const { page, calls, errors } = await openTask4Fixture(t, async ({ path, route }) => {
    if (path !== '/api/conversations/ask') return false
    await route.fulfill({ json: { taskId: 'unrelated-task' } })
    return true
  })
  const editor = page.getByRole('textbox', { name: 'Ask agent', exact: true })
  await editor.fill('Do not accept a task-shaped acknowledgement')
  await page.getByRole('button', { name: 'Ask agent', exact: true }).click()
  await page.getByRole('status').filter({ hasText: /Outcome unknown/ }).waitFor()
  assert.equal(await editor.inputValue(), 'Do not accept a task-shaped acknowledgement')
  assert.equal(await page.getByRole('button', { name: /Check outcome first/ }).count(), 1)
  assert.equal(calls.filter(call => call.path === '/api/conversations/ask').length, 1)
  assert.equal(calls.some(call => call.path === '/api/models/check'), false)
  await page.reload()
  await page.getByRole('button', { name: /Check outcome first/ }).waitFor()
  assert.equal(await page.getByRole('textbox', { name: 'Ask agent', exact: true }).inputValue(), 'Do not accept a task-shaped acknowledgement')
  assert.equal(calls.filter(call => call.path === '/api/conversations/ask').length, 1)
  assert.deepEqual(errors.filter(error => !error.includes('status of 400')), [])
})

test('rendered composer sends strict Ask fields and clears only a matching completion', { timeout: 20000 }, async t => {
  let body = null
  const { page, calls, errors } = await openTask4Fixture(t, async ({ path, body: requestBody, route }) => {
    if (path !== '/api/conversations/ask') return false
    body = requestBody
    await route.fulfill({ json: {
      schema: 'chimera.ask-result.v1', requestId: requestBody.requestId,
      conversationId: requestBody.conversationId, recipientAgentId: requestBody.recipientAgentId,
      status: 'completed', messageId: 'answer-fixture', answer: 'Bounded fixture answer',
    } })
    return true
  })
  const editor = page.getByRole('textbox', { name: 'Ask agent', exact: true })
  await editor.fill('A strict pure Ask')
  await page.getByRole('button', { name: 'Ask agent', exact: true }).click()
  await page.getByRole('status').filter({ hasText: /Request accepted/ }).waitFor()
  assert.deepEqual(Object.keys(body).sort(), ['content', 'conversationId', 'recipientAgentId', 'requestId'].sort())
  assert.equal(await editor.inputValue(), '')
  assert.equal(calls.some(call => call.path === '/api/models/check'), false)
  assert.deepEqual(errors, [])
})

test('rendered new-task acceptance preserves a newer budget and routing choice in the scoped draft', { timeout: 20000 }, async t => {
  let release, markArrived, requestBody
  const arrived = new Promise(resolve => { release = resolve })
  const requestArrived = new Promise(resolve => { markArrived = resolve })
  const { page, calls, errors } = await openTask4Fixture(t, async ({ path, body, route }) => {
    if (path !== '/api/tasks') return false
    requestBody = body
    markArrived()
    await arrived
    await route.fulfill({ json: { taskId: 'task-new', receipt: { requestId: body.requestId, operation: 'new-task', status: 'accepted' } } })
    return true
  })
  const action = page.getByRole('combobox', { name: 'Conversation action', exact: true })
  await action.selectOption('new-task')
  const editor = page.getByRole('textbox', { name: 'New task objective', exact: true })
  await editor.fill('Preserve the full submitted snapshot')
  await page.getByRole('button', { name: 'Start work', exact: true }).click()
  await requestArrived
  await page.getByRole('combobox', { name: 'Conversation budget', exact: true }).selectOption('extended')
  await page.getByRole('combobox', { name: 'Task routing preference', exact: true }).selectOption('latency')
  release()
  await page.getByRole('status').filter({ hasText: /Your newer draft was preserved/ }).waitFor()
  assert.equal(requestBody.requirements.priorityPreset, 'balanced')
  assert.equal(requestBody.budget.maxTurns, 32)
  assert.equal(await editor.inputValue(), 'Preserve the full submitted snapshot')
  assert.equal(await page.getByRole('combobox', { name: 'Conversation budget', exact: true }).inputValue(), 'extended')
  assert.equal(await page.getByRole('combobox', { name: 'Task routing preference', exact: true }).inputValue(), 'latency')
  await page.reload()
  await page.getByRole('combobox', { name: 'Conversation action', exact: true }).selectOption('new-task')
  assert.equal(await page.getByRole('textbox', { name: 'New task objective', exact: true }).inputValue(), 'Preserve the full submitted snapshot')
  assert.equal(await page.getByRole('combobox', { name: 'Conversation budget', exact: true }).inputValue(), 'extended')
  assert.equal(await page.getByRole('combobox', { name: 'Task routing preference', exact: true }).inputValue(), 'latency')
  assert.equal(calls.filter(call => call.path === '/api/tasks').length, 1)
  assert.deepEqual(errors, [])
})

test('accepted new-task retires its request identity when only a newer budget remains', { timeout: 20000 }, async t => {
  let release
  let markArrived
  let firstBody
  let postCount = 0
  const requestArrived = new Promise(resolve => { markArrived = resolve })
  const responseGate = new Promise(resolve => { release = resolve })
  const { page, calls, errors } = await openTask4Fixture(t, async ({ path, body, route }) => {
    if (path !== '/api/tasks') return false
    postCount += 1
    if (postCount === 1) {
      firstBody = body
      markArrived()
      await responseGate
    }
    await route.fulfill({ json: { taskId: `task-budget-${postCount}`, receipt: { requestId: body.requestId, operation: 'new-task', status: 'accepted' } } })
    return true
  })
  const action = page.getByRole('combobox', { name: 'Conversation action', exact: true })
  await action.selectOption('new-task')
  const editor = page.getByRole('textbox', { name: 'New task objective', exact: true })
  await editor.fill('Keep the newer budget without reusing the old request')
  await page.getByRole('button', { name: 'Start work', exact: true }).click()
  await requestArrived
  await page.getByRole('combobox', { name: 'Conversation budget', exact: true }).selectOption('extended')
  release()
  await page.getByRole('status').filter({ hasText: /Your newer draft was preserved/ }).waitFor()
  await page.getByRole('button', { name: 'Start work', exact: true }).click()
  await page.getByRole('status').filter({ hasText: /Request accepted/ }).waitFor()
  const bodies = calls.filter(call => call.path === '/api/tasks').map(call => call.body)
  assert.equal(bodies.length, 2)
  assert.notEqual(bodies[0].requestId, bodies[1].requestId)
  assert.equal(firstBody.budget.maxTurns, 32)
  assert.equal(bodies[1].budget.maxTurns, 64)
  assert.deepEqual(errors, [])
})

test('rendered continuation is available only for terminal tasks and known Ask failures offer a new request', { timeout: 20000 }, async t => {
  let askCount = 0
  const { page, calls, errors } = await openTask4Fixture(t, async ({ path, body, route, state }) => {
    if (path === '/api/state') {
      state.tasks = [
        { taskId: 'active-task', objective: 'Still running', status: 'running', destinationRevision: 2 },
        { taskId: 'terminal-task', objective: 'Finished safely', status: 'completed', destinationRevision: 4 },
      ]
      return false
    }
    if (path === '/api/tasks/continue') {
      await route.fulfill({ json: { taskId: 'terminal-task', receipt: { requestId: body.requestId, operation: 'continuation', status: 'accepted' } } })
      return true
    }
    if (path !== '/api/conversations/ask') return false
    askCount += 1
    await route.fulfill({ json: askCount === 1
      ? { schema: 'chimera.ask-result.v1', requestId: body.requestId, conversationId: body.conversationId, recipientAgentId: body.recipientAgentId, status: 'failed-not-sent', failureCode: 'MODEL_UNAVAILABLE' }
      : { schema: 'chimera.ask-result.v1', requestId: body.requestId, conversationId: body.conversationId, recipientAgentId: body.recipientAgentId, status: 'completed', messageId: 'answer-after-retry', answer: 'Retried safely.' } })
    return true
  })
  await page.getByRole('combobox', { name: 'Conversation action', exact: true }).selectOption('continuation')
  await page.getByRole('combobox', { name: 'Conversation task', exact: true }).selectOption('terminal-task')
  await page.getByRole('textbox', { name: 'Continuation objective', exact: true }).fill('Continue from the saved checkpoint')
  const continueButton = page.getByRole('button', { name: 'Continue task', exact: true })
  assert.equal(await continueButton.isEnabled(), true)
  await continueButton.click()
  await page.getByRole('status').filter({ hasText: /Request accepted/ }).waitFor()
  await page.getByRole('combobox', { name: 'Conversation task', exact: true }).selectOption('active-task')
  assert.equal(await continueButton.isDisabled(), true)
  assert.equal(await page.getByText('Destination unavailable').count(), 1)

  await page.getByRole('combobox', { name: 'Conversation action', exact: true }).selectOption('ask')
  await page.getByRole('combobox', { name: 'Conversation agent', exact: true }).selectOption('ace')
  const askEditor = page.getByRole('textbox', { name: 'Ask agent', exact: true })
  await askEditor.fill('Use a new request after a proven preflight failure')
  await page.getByRole('button', { name: 'Ask agent', exact: true }).click()
  await page.getByRole('status').filter({ hasText: /was not sent/i }).waitFor()
  assert.equal(await page.getByRole('button', { name: /Retry as new request/ }).count(), 1)
  const firstRequestId = calls.find(call => call.path === '/api/conversations/ask')?.body.requestId
  await page.getByRole('button', { name: /Retry as new request/ }).click()
  await page.getByRole('status').filter({ hasText: /Request accepted/ }).waitFor()
  const askBodies = calls.filter(call => call.path === '/api/conversations/ask').map(call => call.body)
  assert.equal(askBodies.length, 2)
  assert.notEqual(askBodies[0].requestId, askBodies[1].requestId)
  assert.equal(firstRequestId, askBodies[0].requestId)
  assert.deepEqual(errors, [])
})

test('rendered known Ask rejection stays a retryable draft after editing and reload', { timeout: 20000 }, async t => {
  const { page, calls, errors } = await openTask4Fixture(t, async ({ path, route }) => {
    if (path !== '/api/conversations/ask') return false
    await route.fulfill({ status: 400, json: { error: 'MODEL_UNAVAILABLE' } })
    return true
  })
  const editor = page.getByRole('textbox', { name: 'Ask agent', exact: true })
  await editor.fill('Known pre-dispatch rejection')
  await page.getByRole('button', { name: 'Ask agent', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: /model unavailable/i }).waitFor()
  await editor.fill('Edited retry draft')
  await page.reload()
  const reloadedEditor = page.getByRole('textbox', { name: 'Ask agent', exact: true })
  assert.equal(await reloadedEditor.inputValue(), 'Edited retry draft')
  assert.equal(await page.getByRole('button', { name: /Check outcome first/ }).count(), 0)
  assert.equal(await page.getByRole('button', { name: 'Ask agent', exact: true }).isEnabled(), true)
  assert.equal(calls.filter(call => call.path === '/api/conversations/ask').length, 1)
  assert.deepEqual(errors.filter(error => !error.includes('status of 400')), [])
})

test('rendered known Ask rejection clears only its settled pending identity when edited before response', { timeout: 20000 }, async t => {
  let release
  let markRequestArrived
  const requestArrived = new Promise(resolve => { markRequestArrived = resolve })
  const responseGate = new Promise(resolve => { release = resolve })
  t.after(() => release?.())
  const { page, calls, errors } = await openTask4Fixture(t, async ({ path, body, route }) => {
    if (path !== '/api/conversations/ask') return false
    markRequestArrived(body)
    await responseGate
    await route.fulfill({ status: 400, json: { error: 'MODEL_UNAVAILABLE' } })
    return true
  })
  const editor = page.getByRole('textbox', { name: 'Ask agent', exact: true })
  await editor.fill('Original request rejected before edit')
  await page.getByRole('button', { name: 'Ask agent', exact: true }).click()
  await requestArrived
  await editor.fill('Newer retry draft entered before response')
  release()
  await page.getByRole('alert').filter({ hasText: /model unavailable/i }).waitFor()
  await page.reload()
  const reloadedEditor = page.getByRole('textbox', { name: 'Ask agent', exact: true })
  assert.equal(await reloadedEditor.inputValue(), 'Newer retry draft entered before response')
  assert.equal(await page.getByRole('button', { name: /Check outcome first/ }).count(), 0)
  assert.equal(await page.getByRole('button', { name: 'Ask agent', exact: true }).isEnabled(), true)
  assert.equal(calls.filter(call => call.path === '/api/conversations/ask').length, 1)
  assert.deepEqual(errors.filter(error => !error.includes('status of 400')), [])
})

test('history restoration never copies one agent draft into another agent target', { timeout: 20000 }, async t => {
  const { page, calls, errors } = await openTask4Fixture(t, async ({ path, body, route }) => {
    if (path !== '/api/conversations/ask') return false
    await route.fulfill({ json: {
      schema: 'chimera.ask-result.v1', requestId: body.requestId,
      conversationId: body.conversationId, recipientAgentId: body.recipientAgentId,
      status: 'completed', messageId: `answer-${body.recipientAgentId}`, answer: 'History fixture answer',
    } })
    return true
  })
  const editor = page.getByRole('textbox', { name: 'Ask agent', exact: true })
  await editor.fill('Original RJ request')
  await page.getByRole('button', { name: 'Ask agent', exact: true }).click()
  await page.getByRole('status').filter({ hasText: /Request accepted/ }).waitFor()
  await editor.fill('Private RJ draft')
  await editor.evaluate(element => element.setSelectionRange(0, 0))
  await editor.press('ArrowUp')
  assert.equal(await editor.inputValue(), 'Original RJ request')
  await page.getByRole('combobox', { name: 'Conversation agent', exact: true }).selectOption('ace')
  const aceEditor = page.getByRole('textbox', { name: 'Ask agent', exact: true })
  await aceEditor.press('ArrowDown')
  assert.equal(await aceEditor.inputValue(), '')
  assert.equal(calls.filter(call => call.path === '/api/conversations/ask').length, 1)
  assert.deepEqual(errors, [])
})

test('a late task-message acknowledgement cannot replace a newer reply-parent choice', { timeout: 20000 }, async t => {
  let release
  let markRequestArrived
  const requestArrived = new Promise(resolve => { markRequestArrived = resolve })
  const responseGate = new Promise(resolve => { release = resolve })
  const { page, state, calls, errors } = await openTask4Fixture(t, async ({ path, body, route }) => {
    if (path !== '/api/tasks/message') return false
    markRequestArrived(body)
    await responseGate
    await route.fulfill({ json: {
      taskId: body.taskId, destinationRevision: 3,
      receipt: { requestId: body.requestId, operation: 'task-message', status: 'accepted' },
      message: { messageId: 'fixture-message' },
    } })
    return true
  })
  state.tasks = [{ taskId: 'alpha', objective: 'Alpha website review', status: 'running', destinationRevision: 2 }]
  state.teamMessaging = { tasks: [{ taskId: 'alpha', participants: ['ceo', 'ace', 'iris'], eligibleRecipients: ['ace', 'iris'], deliveries: [] }] }
  state.conversations.channels = [{ conversationId: 'task:alpha', taskId: 'alpha', kind: 'task-room', label: 'Alpha website review', detail: 'Task room' }]
  state.conversations.messages = [
    { messageId: 'reply-ace', taskId: 'alpha', conversationId: 'task:alpha', content: 'Ace report', senderAgentId: 'ace', recipientAgentIds: ['ceo'] },
    { messageId: 'reply-iris', taskId: 'alpha', conversationId: 'task:alpha', content: 'Iris report', senderAgentId: 'iris', recipientAgentIds: ['ceo'] },
  ]
  await page.reload()
  const composer = page.getByRole('region', { name: 'Conversation composer', exact: true })
  await composer.getByRole('combobox', { name: 'Conversation action', exact: true }).selectOption('guidance')
  await composer.getByRole('combobox', { name: 'Conversation task', exact: true }).selectOption('alpha')
  await composer.getByRole('textbox', { name: 'Task guidance', exact: true }).waitFor()
  await composer.getByRole('textbox', { name: 'Mention teammates', exact: true }).fill('Ace')
  await composer.getByRole('option', { name: '@Ace · ace', exact: true }).click()
  const replyParent = composer.getByRole('combobox', { name: 'Reply parent', exact: true })
  await replyParent.selectOption('reply-ace')
  await composer.getByRole('textbox', { name: 'Task guidance', exact: true }).fill('Reply to the first report')
  await composer.getByRole('button', { name: 'Guide task', exact: true }).click()
  await requestArrived
  assert.equal(calls.filter(call => call.path === '/api/tasks/message').length, 1)
  await replyParent.selectOption('reply-iris')
  release()
  await page.waitForTimeout(500)
  assert.equal(await replyParent.inputValue(), 'reply-iris')
  assert.equal(calls.filter(call => call.path === '/api/tasks/message').length, 1)
  assert.deepEqual(errors, [])
})

test('rendered unknown Ask keeps its original request identity after a newer draft edit and exact lookup', { timeout: 20000 }, async t => {
  let release
  let markRequestArrived
  const requestArrived = new Promise(resolve => { markRequestArrived = resolve })
  const responseGate = new Promise(resolve => { release = resolve })
  let originalBody = null
  const { page, calls, errors } = await openTask4Fixture(t, async ({ path, body, route, search }) => {
    if (path === '/api/conversations/ask') {
      originalBody = body
      markRequestArrived(body)
      await responseGate
      await route.fulfill({ json: { schema: 'chimera.ask-result.v1', requestId: body.requestId, conversationId: body.conversationId, recipientAgentId: body.recipientAgentId, status: 'unknown' } })
      return true
    }
    if (path.startsWith('/api/conversations/asks/')) {
      assert.equal(path.split('/').at(-1), originalBody.requestId)
      await route.fulfill({ json: { schema: 'chimera.ask-result.v1', requestId: originalBody.requestId, conversationId: originalBody.conversationId, recipientAgentId: originalBody.recipientAgentId, status: 'unknown' } })
      return true
    }
    return false
  })
  const editor = page.getByRole('textbox', { name: 'Ask agent', exact: true })
  await editor.fill('Original pending intent')
  await page.getByRole('button', { name: 'Ask agent', exact: true }).click()
  await requestArrived
  await editor.fill('Newer editable draft')
  release()
  await page.getByRole('status').filter({ hasText: /Outcome unknown/ }).waitFor()
  assert.equal(await page.getByRole('button', { name: /Check saved outcome/ }).count(), 1)
  await page.getByRole('button', { name: /Check saved outcome/ }).click()
  await page.getByRole('status').filter({ hasText: /still unresolved/ }).waitFor()
  assert.equal(await editor.inputValue(), 'Newer editable draft')
  await page.reload()
  await page.getByRole('button', { name: /Check saved outcome/ }).waitFor()
  assert.equal(await page.getByRole('textbox', { name: 'Ask agent', exact: true }).inputValue(), 'Newer editable draft')
  assert.equal(calls.filter(call => call.path === '/api/conversations/ask').length, 1)
  assert.deepEqual(errors, [])
})

test('a late completion for another agent cannot clear the current agent pending receipt', { timeout: 20000 }, async t => {
  let releaseAce
  let markAceRequest
  let markAceAcknowledged
  const aceRequest = new Promise(resolve => { markAceRequest = resolve })
  const aceAcknowledged = new Promise(resolve => { markAceAcknowledged = resolve })
  const aceGate = new Promise(resolve => { releaseAce = resolve })
  t.after(() => releaseAce?.())
  const { page, calls, errors } = await openTask4Fixture(t, async ({ path, body, route }) => {
    if (path !== '/api/conversations/ask') return false
    if (body.recipientAgentId === 'ace') {
      markAceRequest(body)
      await aceGate
      await route.fulfill({ json: {
        schema: 'chimera.ask-result.v1', requestId: body.requestId,
        conversationId: body.conversationId, recipientAgentId: body.recipientAgentId,
        status: 'completed', messageId: 'ace-answer', answer: 'Ace completed safely.',
      } })
      markAceAcknowledged()
      return true
    }
    await route.fulfill({ json: {
      schema: 'chimera.ask-result.v1', requestId: body.requestId,
      conversationId: body.conversationId, recipientAgentId: body.recipientAgentId,
      status: 'unknown',
    } })
    return true
  })
  const agent = page.getByRole('combobox', { name: 'Conversation agent', exact: true })
  const editor = page.getByRole('textbox', { name: 'Ask agent', exact: true })
  await editor.fill('RJ request whose outcome must remain recoverable')
  await page.getByRole('button', { name: 'Ask agent', exact: true }).click()
  await page.getByRole('button', { name: /Check outcome first/ }).waitFor()
  await agent.selectOption('ace')
  await editor.fill('Ace request that may complete late')
  await page.getByRole('button', { name: 'Ask agent', exact: true }).click()
  const aceBody = await aceRequest
  await agent.selectOption('ceo')
  await editor.fill('RJ newer text remains separate')
  releaseAce()
  await aceAcknowledged
  await page.waitForFunction(() => document.querySelector('[aria-label="Conversation agent"]')?.value === 'ceo')
  await page.reload()
  await page.getByRole('button', { name: /Check outcome first/ }).waitFor()
  assert.equal(await page.getByRole('textbox', { name: 'Ask agent', exact: true }).inputValue(), 'RJ newer text remains separate')
  assert.equal(calls.filter(call => call.path === '/api/conversations/ask').length, 2)
  assert.ok(aceBody, 'the second request reached the Ace fixture branch')
  assert.deepEqual(errors, [])
})

test('rendered late Ask completion finalizes only its own receipt and preserves a newer draft after reload', { timeout: 20000 }, async t => {
  let release
  let observed
  const requestSeen = new Promise(resolve => { observed = resolve })
  const responseGate = new Promise(resolve => { release = resolve })
  t.after(() => release?.())
  const { page, errors } = await openTask4Fixture(t, async ({ path, body, route }) => {
    if (path !== '/api/conversations/ask') return false
    observed(body)
    await responseGate
    await route.fulfill({ json: {
      schema: 'chimera.ask-result.v1', requestId: body.requestId,
      conversationId: body.conversationId, recipientAgentId: body.recipientAgentId,
      status: 'completed', messageId: 'late-answer-fixture', answer: 'Completed after the edit.',
    } })
    return true
  })
  const editor = page.getByRole('textbox', { name: 'Ask agent', exact: true })
  await editor.fill('Original request')
  await page.getByRole('button', { name: 'Ask agent', exact: true }).click()
  const original = await requestSeen
  await editor.fill('Newer unsent draft')
  release()
  await page.getByRole('status').filter({ hasText: /preserved/i }).waitFor()
  assert.equal(await editor.inputValue(), 'Newer unsent draft')
  await page.reload()
  const reloadedEditor = page.getByRole('textbox', { name: 'Ask agent', exact: true })
  await reloadedEditor.waitFor()
  assert.equal(await reloadedEditor.inputValue(), 'Newer unsent draft')
  assert.equal(original.content, 'Original request')
  assert.deepEqual(errors, [])
})

test('rendered app-shell composer keeps target, editor and Send reachable at supported widths', { timeout: 20000 }, async t => {
  const { page, errors } = await openTask4Fixture(t)
  for (const [width, height] of [[390, 844], [768, 900], [1440, 1000], [2560, 1200]]) {
    await page.setViewportSize({ width, height })
    const bounds = await page.evaluate(() => {
      const composer = document.querySelector('.conversation-composer')
      const editor = document.querySelector('[aria-label="Ask agent"]')
      const submit = composer?.querySelector('button[type="submit"]')
      const visible = element => {
        const rect = element?.getBoundingClientRect()
        return rect && rect.width > 0 && rect.height > 0 && rect.x >= 0 && rect.y >= 0
          && rect.right <= innerWidth && rect.bottom <= innerHeight
      }
      return { composer: visible(composer), editor: visible(editor), submit: visible(submit), overflow: document.documentElement.scrollWidth > innerWidth }
    })
    assert.equal(bounds.composer, true, `${width}px composer should be in the viewport`)
    assert.equal(bounds.editor, true, `${width}px editor should be in the viewport`)
    assert.equal(bounds.submit, true, `${width}px Send should be in the viewport`)
    assert.equal(bounds.overflow, false, `${width}px layout should not overflow horizontally`)
  }
  assert.deepEqual(errors, [])
})
