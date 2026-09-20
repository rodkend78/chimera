import test from 'node:test'
import { openTask4Fixture, assert, assertNoHorizontalOverflow } from './task4-ui-fixture.mjs'

async function assertActionable(locator, label) {
  await locator.scrollIntoViewIfNeeded()
  await locator.click({ trial: true })
  assert.equal(await locator.isVisible(), true, `${label} is not visible`)
}

function taskWorkspaceFixture(state) {
  const task = {
    taskId: 'task11-completed',
    objective: 'Review the retained bounded-check evidence',
    status: 'completed',
    summary: 'The explicit continuation retained one observed bounded check.',
    destinationRevision: 3,
    plan: {
      schema: 'chimera.task-plan.v2',
      revision: 2,
      planHash: 'a'.repeat(64),
      nodes: [
        { nodeId: 'prepare', specialistAgentId: 'ace', objective: 'Prepare the retained fixture', acceptanceCriteria: ['Wait for approval'], dependsOn: [] },
        { nodeId: 'check', specialistAgentId: 'ace', objective: 'Run the bounded fixture check', acceptanceCriteria: ['Record the runtime check receipt'], dependsOn: ['prepare'] },
      ],
    },
    steps: [{ nodeId: 'prepare', status: 'completed' }, { nodeId: 'check', status: 'completed' }],
  }
  const decision = {
    actionId: 'task11-approval',
    taskId: task.taskId,
    title: 'Approve bounded fixture check',
    detail: 'The imported Hermes worker requests one exact task-scoped bash action.',
    resource: 'dsh-tool:bash',
    expiresAt: '2099-01-01T00:00:00.000Z',
    agent: { agentId: 'ace' },
    actionDiff: { review: { fields: { Command: "test -s scratch/task11-check.txt", Scope: 'task workspace' } } },
  }
  const node = task.plan.nodes[1]
  const workspace = {
    schema: 'chimera.task-workspace.v1',
    task,
    plan: { ...task.plan, steps: task.steps },
    team: { taskId: task.taskId, participants: ['ace'], eligibleRecipients: [], deliveries: [] },
    conversation: { conversationId: `task:${task.taskId}`, messages: [{
      messageId: 'task11-result', conversationId: `task:${task.taskId}`, taskId: task.taskId,
      senderAgentId: 'ace', recipientAgentIds: ['ceo'], role: 'agent', kind: 'structured_result',
      content: 'The bounded check was observed by the runtime.', status: 'completed', createdAt: '2026-09-19T10:00:00.000Z',
      provenance: { verification: 'verified' },
    }] },
    permissions: [{ taskId: task.taskId, leaseId: 'lease-task11', agentId: 'ace', status: 'active', agentProfileId: 'sandbox', profileId: 'sandbox', ceilingProfileId: 'sandbox', executor: 'runtime-harness', expiresAt: '2099-01-01T00:00:00.000Z', networkHosts: [], tools: ['read', 'bash'] }],
    approvals: [decision],
    files: {
      status: 'reviewed',
      review: { observedAt: '2026-09-19T10:01:00.000Z', reviewDigest: 'b'.repeat(64), changedFiles: [{ path: 'scratch/task11-check.txt', status: '??' }] },
      artifacts: [],
    },
    results: {
      summary: 'The bounded check was observed by the runtime.',
      reports: [{ messageId: 'task11-report', senderAgentId: 'ace', status: 'completed', content: 'Observed exit code 0.', provenance: { verification: 'verified' } }],
    },
    browser: null,
    routing: { schema: 'chimera.routing-explanation.v1', taskId: task.taskId, selected: { agentId: 'ace', model: 'gpt-fixture', executor: 'runtime', reason: 'Task-scoped route' }, candidates: [{ routeId: 'fixture-route', model: 'gpt-fixture', status: 'eligible', reasons: [] }], reasons: ['Task-scoped route'], evidence: { status: 'recorded' } },
    evidence: {
      workProduced: { state: 'observed', evidenceRefs: ['artifact-task11'], observedAt: '2026-09-19T10:02:00.000Z', scope: `task:${task.taskId}` },
      checksPassed: { state: 'passed', evidenceRefs: ['check-task11'], observedAt: '2026-09-19T10:02:00.000Z', scope: `task:${task.taskId}@rev-2` },
      readyForReview: { state: 'ready', evidenceRefs: ['review-task11'], observedAt: '2026-09-19T10:03:00.000Z', scope: `task:${task.taskId}@rev-2` },
      published: { state: 'not-published', evidenceRefs: [], observedAt: '2026-09-19T10:03:00.000Z', scope: `task:${task.taskId}@rev-2` },
    },
    recovery: {
      state: 'unknown',
      summary: 'An external outcome is retained for inspection before any continuation.',
      retained: [{ kind: 'model-call', operationId: 'task11-unknown-call', status: 'ambiguous' }],
      actions: [{ id: 'inspect', label: 'Inspect retained work', enabled: true }],
      retryAllowed: false,
    },
  }
  state.tasks = [task]
  state.teamMessaging = { tasks: [{ taskId: task.taskId, destinationRevision: task.destinationRevision, participants: ['ceo', 'ace'], eligibleRecipients: [], deliveries: [] }] }
  state.conversations = { channels: [{ conversationId: `task:${task.taskId}`, kind: 'task-room', taskId: task.taskId, label: task.objective, detail: 'Task room' }], messages: workspace.conversation.messages }
  state.decisions = [decision]
  state.recentEvents = [{ kind: 'model.route.selected', routeId: 'fixture-task-route', capability: 'coding', selectionReason: 'Task-scoped route', costClass: 'standard' }]
  return { task, decision, workspace, node }
}

test('rendered Task11 workspace keeps plans, outcomes, approvals, Ask, and recovery reachable', { timeout: 45_000 }, async t => {
  let fixture
  const { page, state, calls, errors } = await openTask4Fixture(t, async ({ path, body, route }) => {
    if (path === '/api/tasks/task11-completed/workspace') {
      await route.fulfill({ json: fixture.workspace })
      return true
    }
    if (path === '/api/conversations/ask') {
      await route.fulfill({ json: {
        schema: 'chimera.ask-result.v1', requestId: body.requestId, conversationId: body.conversationId,
        recipientAgentId: body.recipientAgentId, status: 'completed', messageId: 'ask-task11',
        answer: 'The Ask path used inference only.', message: 'Ask completed without tools.',
      } })
      return true
    }
    if (path === '/api/decisions/task11-approval') {
      state.decisions = []
      await route.fulfill({ json: { actionId: 'task11-approval', status: 'allowed' } })
      return true
    }
    return false
  }, { width: 1440, height: 1000 })
  fixture = taskWorkspaceFixture(state)
  try {
    await page.reload()
    await page.getByRole('button', { name: 'Work', exact: true }).click()
    await page.getByRole('region', { name: 'Selected task workspace', exact: true }).waitFor()
    await page.getByRole('heading', { name: fixture.task.objective, exact: true }).waitFor()
    await page.getByRole('region', { name: 'Task plan and progress', exact: true }).waitFor()
    await page.getByText('Run the bounded fixture check', { exact: true }).waitFor()
    await page.getByRole('region', { name: 'Selected task results', exact: true }).waitFor()

    const outcome = page.getByRole('region', { name: 'Task outcomes and recovery', exact: true })
    await outcome.getByText('Checks passed', { exact: true }).waitFor()
    await outcome.getByText('Passed', { exact: true }).waitFor()
    await outcome.getByText('Not published', { exact: true }).waitFor()
    await outcome.getByText('Execution retry blocked', { exact: true }).waitFor()
    assert.equal(await outcome.getByRole('button', { name: /Retry|Continue/ }).count(), 0)
    await outcome.getByRole('button', { name: 'Inspect retained work', exact: true }).focus()
    assert.equal(await outcome.getByRole('button', { name: 'Inspect retained work', exact: true }).evaluate(element => document.activeElement === element), true)

    const decisions = page.locator('details.task-workspace-disclosure').filter({ hasText: 'Decisions' })
    await decisions.locator('summary').click()
    await page.getByText('Approve bounded fixture check', { exact: true }).waitFor()
    const access = page.locator('details.task-permissions')
    await access.locator('summary').click()
    await access.getByText('Task profile', { exact: true }).waitFor()
    await access.getByText('sandbox', { exact: true }).first().waitFor()

    await page.getByRole('button', { name: 'Needs you (1)', exact: true }).click()
    await page.getByRole('heading', { name: 'Decisions', exact: true }).waitFor()
    const review = page.getByRole('button', { name: 'Review', exact: true }).first()
    await review.click()
    const dialog = page.getByRole('dialog', { name: 'Approve bounded fixture check', exact: true })
    await dialog.waitFor()
    assert.equal(await dialog.getByRole('button', { name: 'Close', exact: true }).evaluate(element => document.activeElement === element), true)
    await page.keyboard.press('Escape')
    assert.equal(await review.evaluate(element => document.activeElement === element), true)
    await review.click()
    await dialog.getByRole('button', { name: 'Approve', exact: true }).focus()
    await page.keyboard.press('Enter')
    await page.getByText(/Service result: allowed/).first().waitFor()

    await page.getByRole('button', { name: 'Work', exact: true }).click()
    await page.getByRole('region', { name: 'Selected task workspace', exact: true }).waitFor()
    const composer = page.getByRole('region', { name: 'Conversation composer', exact: true })
    await composer.getByRole('combobox', { name: 'Conversation action', exact: true }).selectOption('ask')
    await composer.getByRole('combobox', { name: 'Conversation agent', exact: true }).selectOption('ace')
    await composer.getByRole('textbox', { name: 'Ask agent', exact: true }).fill('Explain the retained bounded-check boundary.')
    await composer.getByRole('button', { name: 'Ask agent', exact: true }).click()
    await composer.getByText('Ask completed without tools.', { exact: true }).waitFor()
    assert.equal(calls.filter(call => call.path === '/api/conversations/ask').length, 1)
    assert.equal(calls.find(call => call.path === '/api/conversations/ask').body.recipientAgentId, 'ace')

    for (const width of [390, 768, 1440, 2560]) {
      await page.setViewportSize({ width, height: 1000 })
      await page.getByRole('region', { name: 'Selected task workspace', exact: true }).scrollIntoViewIfNeeded()
      assert.equal(await assertNoHorizontalOverflow(page), true, `horizontal overflow at ${width}px`)
      for (const locator of [page.getByRole('region', { name: 'Task plan and progress', exact: true }), outcome, composer]) {
        await assertActionable(locator, `workspace surface at ${width}px`)
      }
    }

    await page.setViewportSize({ width: 720, height: 500 })
    await page.evaluate(() => { document.documentElement.style.zoom = '2' })
    assert.equal(await assertNoHorizontalOverflow(page), true, 'horizontal overflow at 200% zoom')
    await assertActionable(page.getByRole('region', { name: 'Task plan and progress', exact: true }), 'task plan at 200% zoom')
    await assertActionable(outcome, 'task outcomes at 200% zoom')
    await assertActionable(page.getByRole('button', { name: 'Refresh view', exact: true }), 'Refresh view at 200% zoom')
    await assertActionable(composer.getByRole('textbox', { name: 'Ask agent', exact: true }), 'Ask textbox at 200% zoom')
    assert.equal(await page.locator('vite-error-overlay').count(), 0)
    assert.deepEqual(errors, [])
  } catch (error) {
    console.error('Task11 rendered diagnostics', errors, await page.locator('body').innerText())
    throw error
  }
})
