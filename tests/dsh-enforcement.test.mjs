import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { MemoryAuditLog } from '../src/audit-log.mjs'
import {
  approvalReviewForTool,
  DshEnforcementAdapter,
  installDshCordisEnforcement,
} from '../src/dsh/enforcement-adapter.mjs'
import {
  extractDshToolCatalog,
  loadDshEffectInventory,
} from '../src/dsh/effect-inventory.mjs'
import { ChimeraGateway } from '../src/gateway.mjs'
import {
  exportPublicKey,
  fingerprint,
  generateIdentity,
  signDecision,
  signGrant,
} from '../src/identity.mjs'

const now = Date.parse('2026-08-27T18:00:00.000Z')
const expectedCatalog = [
  'ask_user_question', 'bash', 'cordis_define', 'cordis_inspect_list',
  'cordis_inspect_query', 'cordis_inspect_self', 'cordis_run', 'cordis_stop',
  'cordis_undefine', 'create_goal', 'edit', 'exit_plan_mode', 'followup_task',
  'get_goal', 'glob', 'grep', 'interrupt_agent', 'job_kill', 'job_list',
  'job_output', 'list_agents', 'lsp', 'pwsh', 'ralph', 'read', 'read_image',
  'report', 'run_code', 'schedule_create', 'schedule_delete', 'schedule_list',
  'send_message', 'session_event_read', 'session_event_search',
  'session_event_trace', 'session_search', 'session_trace', 'skill',
  'spawn_teammate', 'str_replace_editor', 'subagent', 'team_task_create',
  'team_task_get', 'team_task_list', 'team_task_update', 'terminal_close',
  'terminal_list', 'terminal_open', 'terminal_read', 'terminal_send',
  'terminal_signal', 'todo_write', 'update_goal', 'wait_agent', 'web_fetch',
  'web_search', 'workflow', 'write',
]

const window = {
  issuedAt: '2026-08-27T17:55:00.000Z',
  expiresAt: '2026-08-27T18:30:00.000Z',
}

async function fixture({
  toolName = 'bash',
  toolNames = [toolName],
  grantToolNames = toolNames,
  tier = 'auto',
  maxTier = tier === 'confirm' ? 'confirm' : 'auto',
  approvalBroker,
} = {}) {
  const inventory = await loadDshEffectInventory()
  const routes = toolNames.map((name) => ({ name, route: inventory.classify(name) }))
  const human = generateIdentity('operator')
  const agent = generateIdentity('ceo')
  const audit = new MemoryAuditLog()
  const gateway = new ChimeraGateway({
    policy: {
      version: 1,
      defaultTier: 'blocked',
      rules: routes.map(({ name, route }) => ({
        id: `allow-${route.id}-${name}`,
        capability: route.capability,
        resource: `dsh-tool:${name}`,
        tier,
      })),
    },
    humanKeys: [[human.keyId, exportPublicKey(human.publicKey)]],
    audit,
    now: () => now,
  })
  const grant = signGrant({
    grantId: 'grant-ceo-dsh',
    humanId: 'operator',
    agentId: 'ceo',
    agentKeyFingerprint: fingerprint(agent.publicKey),
    maxTier,
    scopes: routes.filter(({ name }) => grantToolNames.includes(name)).map(({ name, route }) => ({
      capability: route.capability,
      resource: `dsh-tool:${name}`,
    })),
    ...window,
  }, human)
  const adapter = new DshEnforcementAdapter({
    gateway,
    inventory,
    audit,
    authorityFor: (agentId) => agentId === 'ceo' ? { grant, identity: agent } : null,
    approvalBroker,
    now: () => now,
  })
  return { adapter, agent, audit, gateway, grant, human, inventory }
}

function execution({
  callId = 'call-1',
  rootCallId = callId,
  name = 'bash',
  arguments: args = { command: 'pwd' },
  token = Symbol(callId),
  parent,
  agentId = 'ceo',
  sessionId = 'session-1',
} = {}) {
  return {
    callId,
    rootCallId,
    name,
    arguments: args,
    token,
    ...(parent === undefined ? {} : { parent }),
    agent: { id: agentId, session: { id: sessionId } },
    signal: new AbortController().signal,
  }
}

test('the pinned Harness tool catalog has exactly one Chimera owner per tool', async () => {
  const inventory = await loadDshEffectInventory()

  assert.equal(inventory.upstreamCommit, 'b150a551b8d465e31e418e1b2eaf5e79bbb7d28e')
  assert.deepEqual(inventory.catalogTools(), expectedCatalog)
  assert.deepEqual(inventory.auditCoverage(), {
    catalogTools: 58,
    coveredTools: 58,
    duplicateTools: [],
    uncoveredTools: [],
    requiredNonToolPaths: 7,
    ownedNonToolPaths: 7,
  })
  assert.equal(inventory.classify('bash').capability, 'process.execute')
  assert.equal(inventory.classify('write').capability, 'filesystem.write')
  assert.equal(inventory.classify('web_fetch').capability, 'network.request')
  assert.equal(inventory.classify('mcp__github__create_issue').capability, 'mcp.invoke')
  assert.equal(inventory.classify('mcp__chimera_github__pr_checks').capability, 'github.pr.read')
  assert.equal(inventory.classify('mcp__chimera_github__pr_create').capability, 'github.pr.write')
  assert.equal(inventory.classify('mcp__chimera_github__pr_merge').capability, 'github.pr.merge')
  assert.throws(() => inventory.classify('unowned_dynamic_tool'), /UNOWNED_DSH_TOOL/)
})

test('GitHub PR reads are automatic while writes and merges require confirmation', async () => {
  const inventory = await loadDshEffectInventory()
  const policy = JSON.parse(await readFile(new URL('../config/policy.json', import.meta.url), 'utf8'))
  const tierFor = (toolName) => {
    const route = inventory.classify(toolName)
    return policy.rules.find((rule) => rule.capability === route.capability
      && `dsh-tool:${toolName}`.startsWith(rule.resourcePrefix))?.tier
  }

  assert.equal(tierFor('mcp__chimera_github__pr_checks'), 'auto')
  assert.equal(tierFor('mcp__chimera_github__pr_create'), 'confirm')
  assert.equal(tierFor('mcp__chimera_github__pr_comment'), 'confirm')
  assert.equal(tierFor('mcp__chimera_github__pr_merge'), 'confirm')
})

test('every consequential GitHub tool has a bounded semantic approval projection', () => {
  const repository = 'example-org/example-repo'
  const projections = [
    approvalReviewForTool('mcp__chimera_github__pr_create', {
      repository, title: 'Gate 2', head: 'codex/gate2', base: 'main', body: 'Evidence',
    }),
    approvalReviewForTool('mcp__chimera_github__pr_update', {
      repository, number: 6, title: 'Gate 2 complete', state: 'open',
    }),
    approvalReviewForTool('mcp__chimera_github__pr_comment', {
      repository, number: 6, body: 'CI is green.',
    }),
    approvalReviewForTool('mcp__chimera_github__pr_merge', {
      repository, number: 6, expectedHeadSha: 'a'.repeat(40), method: 'squash',
    }),
  ]

  assert.deepEqual(projections.map((review) => review.schema), Array(4).fill('chimera.approval-review.v1'))
  assert.deepEqual(projections.map((review) => review.fields.Repository), Array(4).fill(repository))
  assert.equal(projections[0].fields.Body, 'Evidence')
  assert.equal(projections[2].fields.Comment, 'CI is green.')
})

test('shell, filesystem, network and MCP approvals expose bounded redacted semantics', () => {
  const shell = approvalReviewForTool('bash', { command: 'printf hello', timeoutMs: 1000 })
  assert.equal(shell?.fields.Command, 'printf hello')
  assert.match(shell.fields['Working directory'], /scratch/)
  const write = approvalReviewForTool('write', { path: 'scratch/result', content: 'private content' })
  assert.equal(write?.fields.Path, 'scratch/result')
  assert.equal(write.fields['Content bytes'], 15)
  assert.equal(write.fields.Content, 'private content')
  const edit = approvalReviewForTool('edit', { path: 'scratch/result', oldText: 'old', newText: 'new' })
  assert.equal(edit.fields['Old text'], 'old')
  assert.equal(edit.fields['New text'], 'new')
  assert.equal(JSON.stringify(approvalReviewForTool('write', { path: 'scratch/result', content: 'token=never-display-this' })).includes('never-display-this'), false)
  assert.throws(() => approvalReviewForTool('write', { path: 'scratch/result', content: 'x'.repeat(4097) }), /DSH_APPROVAL_REVIEW_INVALID/)
  const network = approvalReviewForTool('web_fetch', { url: 'https://example.com/docs' })
  assert.match(JSON.stringify(network), /example.com\/docs/)
  const mcp = approvalReviewForTool('mcp__fixture__mutate', { target: 'record-7', token: 'never-display-this' })
  assert.match(JSON.stringify(mcp), /record-7/)
  assert.equal(JSON.stringify(mcp).includes('never-display-this'), false)
  assert.throws(() => approvalReviewForTool('bash', { command: 'x'.repeat(5000) }), /DSH_APPROVAL_REVIEW_INVALID/)
})

test('a JSON prototype-named argument remains visible in an MCP approval', () => {
  const args = JSON.parse('{"__proto__":{"operation":"delete","target":"record-7"},"visible":"ok"}')
  const review = approvalReviewForTool('mcp__fixture__mutate', args)
  assert.equal(JSON.parse(review.fields.Arguments).__proto__.operation, 'delete')
  assert.match(review.fields.Arguments, /record-7/)
})

test('confirm review and execution use an immutable snapshot of the original arguments', async () => {
  let exec
  const f = await fixture({ tier: 'confirm', approvalBroker: { async request(request) {
    assert.equal(request.review.fields.Command, 'printf safe')
    assert.throws(() => { exec.arguments.command = 'printf unsafe' }, TypeError)
    return signDecision({ actionId: request.actionId, challengeHash: request.challengeHash,
      outcome: 'approve', ...window }, f.human)
  } } })
  exec = execution({ arguments: { command: 'printf safe' } })
  assert.equal((await f.adapter.preExecute(exec)).kind, 'allow')
  assert.equal(exec.arguments.command, 'printf safe')
})

test('an invalid confirm preview terminalizes the gateway action rather than leaving it pending', async () => {
  const f = await fixture({ tier: 'confirm', approvalBroker: { request() { assert.fail('must not enqueue') } } })
  assert.deepEqual(await f.adapter.preExecute(execution({ arguments: { command: 'x'.repeat(5000) } })),
    { kind: 'deny', reason: 'DSH_APPROVAL_REVIEW_INVALID' })
  const pending = f.audit.entries().map(entry => entry.fact).find(entry => entry.kind === 'action.pending')
  assert.ok(pending)
  assert.equal(f.gateway.cancelPending(pending.actionId).reason, 'NO_PENDING_ACTION')
})

test('the upstream catalog parser reads unique tool headings in stable order', () => {
  const markdown = [
    '# Catalog',
    '### `write`',
    'body',
    '### `bash`',
    '### `write`',
  ].join('\n')

  assert.deepEqual(extractDshToolCatalog(markdown), ['bash', 'write'])
})

test('every pinned tool class and dynamic MCP call is mediated by the same fail-closed adapter', async () => {
  const toolNames = [...expectedCatalog, 'mcp__fixture__mutate']
  const f = await fixture({ toolNames, grantToolNames: ['bash'] })
  let bodyRuns = 0

  for (const [index, name] of toolNames.entries()) {
    const decision = await f.adapter.preExecute(execution({
      callId: `inventory-${index}`,
      name,
      arguments: { probe: true },
    }))
    if (decision.kind === 'allow') bodyRuns += 1
    assert.equal(decision.kind, name === 'bash' ? 'allow' : 'deny', name)
  }

  assert.equal(bodyRuns, 1)
})

test('an allowed Harness call is signed with complete session and call lineage', async () => {
  const f = await fixture()
  const exec = execution()

  const decision = await f.adapter.preExecute(exec)

  assert.equal(decision.kind, 'allow')
  const authorized = f.audit.entries().map((entry) => entry.fact)
    .find((fact) => fact.kind === 'dsh.tool.authorized')
  assert.deepEqual({
    agentId: authorized.agentId,
    sessionId: authorized.sessionId,
    callId: authorized.callId,
    rootCallId: authorized.rootCallId,
    parentCallId: authorized.parentCallId,
    toolName: authorized.toolName,
    resource: authorized.resource,
  }, {
    agentId: 'ceo',
    sessionId: 'session-1',
    callId: 'call-1',
    rootCallId: 'call-1',
    parentCallId: null,
    toolName: 'bash',
    resource: 'dsh-tool:bash',
  })
})

test('unknown tools and missing agent authority fail closed before the tool body', async () => {
  const f = await fixture()
  let bodyRuns = 0
  const run = async (exec) => {
    const decision = await f.adapter.preExecute(exec)
    if (decision.kind === 'allow') bodyRuns += 1
    return decision
  }

  assert.deepEqual(await run(execution({ name: 'unowned_dynamic_tool' })), {
    kind: 'deny',
    reason: 'UNOWNED_DSH_TOOL',
  })
  assert.deepEqual(await run(execution({ agentId: 'intruder', callId: 'call-2' })), {
    kind: 'deny',
    reason: 'NO_DSH_AGENT_AUTHORITY',
  })
  assert.equal(bodyRuns, 0)
  const denials = f.audit.entries().map((entry) => entry.fact)
    .filter((fact) => fact.kind === 'dsh.tool.denied')
  assert.equal(denials.some((fact) => (
    fact.callId === 'call-2'
      && fact.agentId === 'intruder'
      && fact.reason === 'NO_DSH_AGENT_AUTHORITY'
  )), true)
})

test('Code Mode sub-dispatches inherit the root id and resolve the exact parent call', async () => {
  const f = await fixture({ toolNames: ['run_code', 'bash'] })
  const rootToken = Symbol('run-code')
  const root = execution({ callId: 'root-1', name: 'run_code', token: rootToken })
  const child = execution({
    callId: 'root-1:code:1',
    rootCallId: 'root-1',
    name: 'bash',
    token: Symbol('child'),
    parent: rootToken,
  })

  await f.adapter.preExecute(root)
  const childDecision = await f.adapter.preExecute(child)

  assert.equal(childDecision.kind, 'allow')
  const authorized = f.audit.entries().map((entry) => entry.fact)
    .find((fact) => fact.kind === 'dsh.tool.authorized' && fact.callId === 'root-1:code:1')
  assert.equal(authorized.rootCallId, 'root-1')
  assert.equal(authorized.parentCallId, 'root-1')
})

test('a denied Code Mode transport cannot establish lineage for a nested call', async () => {
  const f = await fixture()
  const rootToken = Symbol('denied-run-code')
  const root = execution({ callId: 'root-denied', name: 'run_code', token: rootToken })
  const child = execution({
    callId: 'root-denied:code:1',
    rootCallId: 'root-denied',
    name: 'bash',
    token: Symbol('child'),
    parent: rootToken,
  })

  assert.equal((await f.adapter.preExecute(root)).kind, 'deny')
  assert.deepEqual(await f.adapter.preExecute(child), {
    kind: 'deny',
    reason: 'UNRESOLVED_DSH_PARENT',
  })
})

test('the same Harness call id cannot be authorized twice', async () => {
  const f = await fixture()
  const exec = execution()

  assert.equal((await f.adapter.preExecute(exec)).kind, 'allow')
  assert.deepEqual(await f.adapter.preExecute(exec), {
    kind: 'deny',
    reason: 'REPLAYED_ACTION',
  })
})

test('reusing one Harness call id with different arguments is denied', async () => {
  const f = await fixture()

  assert.equal((await f.adapter.preExecute(execution({ arguments: { command: 'pwd' } }))).kind, 'allow')
  assert.deepEqual(
    await f.adapter.preExecute(execution({ arguments: { command: 'curl https://example.com' } })),
    { kind: 'deny', reason: 'REPLAYED_ACTION' },
  )
})

test('confirm-tier execution requires a challenge-bound human signature', async () => {
  let pending
  const f = await fixture({
    tier: 'confirm',
    approvalBroker: {
      async request(request) {
        pending = request
        return signDecision({
          actionId: request.actionId,
          challengeHash: request.challengeHash,
          outcome: 'approve',
          issuedAt: '2026-08-27T17:59:59.000Z',
          expiresAt: '2026-08-27T18:05:00.000Z',
        }, f.human)
      },
    },
  })

  const decision = await f.adapter.preExecute(execution())

  assert.equal(decision.kind, 'allow')
  assert.equal(typeof pending.challengeHash, 'string')
  const facts = f.audit.entries().map((entry) => entry.fact)
  assert.equal(facts.some((fact) => fact.kind === 'dsh.approval.asked'), true)
  assert.equal(facts.some((fact) => fact.kind === 'dsh.approval.decided' && fact.outcome === 'allowed'), true)
})

test('a GitHub merge approval exposes the exact validated target to the human', async () => {
  let pending
  const toolName = 'mcp__chimera_github__pr_merge'
  const f = await fixture({
    toolName,
    tier: 'confirm',
    approvalBroker: {
      async request(request) {
        pending = request
        return signDecision({
          actionId: request.actionId,
          challengeHash: request.challengeHash,
          outcome: 'approve',
          issuedAt: '2026-08-27T17:59:59.000Z',
          expiresAt: '2026-08-27T18:05:00.000Z',
        }, f.human)
      },
    },
  })

  const decision = await f.adapter.preExecute(execution({
    name: toolName,
    arguments: {
      repository: 'example-org/example-repo',
      number: 6,
      expectedHeadSha: 'a'.repeat(40),
      method: 'squash',
    },
  }))

  assert.equal(decision.kind, 'allow')
  assert.deepEqual(pending.review, {
    schema: 'chimera.approval-review.v1',
    summary: 'Merge PR #6 in example-org/example-repo using squash',
    fields: {
      Repository: 'example-org/example-repo',
      'Pull request': '#6',
      'Expected head SHA': 'a'.repeat(40),
      'Merge method': 'squash',
    },
  })
})

test('a malformed GitHub write is denied before the approval queue', async () => {
  let approvalRequests = 0
  const toolName = 'mcp__chimera_github__pr_merge'
  const f = await fixture({
    toolName,
    tier: 'confirm',
    approvalBroker: {
      async request() {
        approvalRequests += 1
        return null
      },
    },
  })

  assert.deepEqual(await f.adapter.preExecute(execution({
    name: toolName,
    arguments: {
      repository: 'example-org/example-repo',
      number: 6,
      expectedHeadSha: 'not-a-commit',
      method: 'squash',
    },
  })), { kind: 'deny', reason: 'DSH_APPROVAL_REVIEW_INVALID' })
  assert.equal(approvalRequests, 0)
})

test('a Harness approval outcome without a Chimera human signature cannot execute', async () => {
  const f = await fixture({
    tier: 'confirm',
    approvalBroker: {
      async request() {
        return { outcome: 'allowed-once' }
      },
    },
  })

  assert.deepEqual(await f.adapter.preExecute(execution()), {
    kind: 'deny',
    reason: 'MALFORMED_DECISION',
  })
})

test('a Cordis denial never delegates to the next policy listener or tool body', async () => {
  const f = await fixture()
  let delegated = 0
  const context = {
    tools: { guard: () => () => {} },
    on(event, listener) {
      if (event === 'tools/pre-execute') this.preExecute = listener
      return () => {}
    },
  }
  installDshCordisEnforcement(context, f.adapter)

  const decision = await context.preExecute(execution({ name: 'unowned_dynamic_tool' }), async () => {
    delegated += 1
    return { kind: 'allow' }
  })

  assert.deepEqual(decision, { kind: 'deny', reason: 'UNOWNED_DSH_TOOL' })
  assert.equal(delegated, 0)
})

test('a Cordis installation delegates only after Chimera allows and cleans parent lineage on result', async () => {
  const f = await fixture()
  const listeners = new Map()
  const context = {
    tools: { guard: () => () => {} },
    on(event, listener) {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
  }
  const dispose = installDshCordisEnforcement(context, f.adapter)
  let delegated = 0
  const exec = execution()

  const decision = await listeners.get('tools/pre-execute')(exec, async () => {
    delegated += 1
    return { kind: 'allow' }
  })
  listeners.get('tools/result')(exec, { isError: false, content: [] })
  const afterResult = await f.adapter.preExecute(execution({
    callId: 'call-1:code:1',
    rootCallId: 'call-1',
    token: Symbol('late-child'),
    parent: exec.token,
  }))

  assert.deepEqual(decision, { kind: 'allow' })
  assert.equal(delegated, 1)
  assert.deepEqual(afterResult, { kind: 'deny', reason: 'UNRESOLVED_DSH_PARENT' })
  dispose()
  assert.deepEqual([...listeners.keys()], [])
})

test('the monotonic Cordis guard denies when another listener short-circuits before Chimera', async () => {
  const f = await fixture()
  const guards = []
  const context = {
    tools: {
      guard(callback) {
        guards.push(callback)
        return () => guards.splice(guards.indexOf(callback), 1)
      },
    },
    on() {
      return () => {}
    },
  }
  const dispose = installDshCordisEnforcement(context, f.adapter)

  assert.equal(guards.length, 1)
  assert.equal(guards[0](execution()), 'CHIMERA_DSH_GATE_BYPASSED')
  assert.equal(f.audit.entries().map((entry) => entry.fact).some((fact) => (
    fact.kind === 'dsh.tool.denied' && fact.reason === 'CHIMERA_DSH_GATE_BYPASSED'
  )), true)
  dispose()
  assert.equal(guards.length, 0)
})
