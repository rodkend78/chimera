import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { MemoryAuditLog } from '../../src/audit-log.mjs'
import {
  DshEnforcementAdapter,
  installDshCordisEnforcement,
} from '../../src/dsh/enforcement-adapter.mjs'
import { loadDshEffectInventory } from '../../src/dsh/effect-inventory.mjs'
import { ChimeraGateway } from '../../src/gateway.mjs'
import {
  exportPublicKey,
  fingerprint,
  generateIdentity,
  signGrant,
} from '../../src/identity.mjs'

const upstreamPath = resolve(process.argv[2] ?? '../deepseek-harness-upstream')
const fromUpstream = (path) => import(pathToFileURL(resolve(upstreamPath, path)).href)
const [{ Context }, { default: SystemPrompt }, { default: ToolRuntime, defineTool }] = await Promise.all([
  fromUpstream('vendor/cordis/lib/index.js'),
  fromUpstream('packages/core/system-prompt/lib/index.js'),
  fromUpstream('packages/core/tools/lib/index.js'),
])

const now = Date.parse('2026-08-27T18:00:00.000Z')
const human = generateIdentity('rod')
const agentIdentity = generateIdentity('ceo')
const inventory = await loadDshEffectInventory()
const audit = new MemoryAuditLog()
const gateway = new ChimeraGateway({
  policy: {
    version: 1,
    defaultTier: 'blocked',
    rules: [
      { id: 'allow-bash', capability: 'process.execute', resource: 'dsh-tool:bash', tier: 'auto' },
      { id: 'allow-write', capability: 'filesystem.write', resource: 'dsh-tool:write', tier: 'auto' },
    ],
  },
  humanKeys: [[human.keyId, exportPublicKey(human.publicKey)]],
  audit,
  now: () => now,
})
const grant = signGrant({
  grantId: 'gate1-real-cordis',
  humanId: 'rod',
  agentId: 'ceo',
  agentKeyFingerprint: fingerprint(agentIdentity.publicKey),
  maxTier: 'auto',
  scopes: [{ capability: 'process.execute', resource: 'dsh-tool:bash' }],
  issuedAt: '2026-08-27T17:55:00.000Z',
  expiresAt: '2026-08-27T18:30:00.000Z',
}, human)
const adapter = new DshEnforcementAdapter({
  gateway,
  inventory,
  audit,
  authorityFor: (agentId, sessionId) => (
    agentId === 'ceo' && sessionId === 'session-gate1'
      ? { grant, identity: agentIdentity }
      : null
  ),
  now: () => now,
})

const ctx = new Context()
let bashBodyRuns = 0
let writeBodyRuns = 0
let bypassBodyRuns = 0
try {
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  installDshCordisEnforcement(ctx, adapter)
  ctx.tools.register(defineTool({
    name: 'bash',
    description: 'Gate 1 allowed execution fixture',
    parameters: { command: { type: 'string', required: true } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      bashBodyRuns += 1
      return `ran:${args.command}`
    },
  }))
  ctx.tools.register(defineTool({
    name: 'web_fetch',
    description: 'Gate 1 listener-order bypass fixture',
    parameters: { url: { type: 'string', required: true } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      bypassBodyRuns += 1
      return `fetched:${args.url}`
    },
  }))
  ctx.tools.register(defineTool({
    name: 'write',
    description: 'Gate 1 denied execution fixture',
    parameters: { path: { type: 'string', required: true } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      writeBodyRuns += 1
      return `wrote:${args.path}`
    },
  }))

  const agent = { id: 'ceo', session: { id: 'session-gate1' } }
  const signal = new AbortController().signal
  const allowed = await ctx.tools.execute({
    callId: 'gate1-allowed',
    name: 'bash',
    arguments: { command: 'pwd' },
    agent,
    signal,
  })
  const denied = await ctx.tools.execute({
    callId: 'gate1-denied',
    name: 'write',
    arguments: { path: '/tmp/should-not-exist' },
    agent,
    signal,
  })
  const disposeShortCircuit = ctx.on(
    'tools/pre-execute',
    async () => ({ kind: 'allow' }),
    { prepend: true },
  )
  const bypassed = await ctx.tools.execute({
    callId: 'gate1-listener-bypass',
    name: 'web_fetch',
    arguments: { url: 'https://example.com' },
    agent,
    signal,
  })
  disposeShortCircuit()

  assert.equal(allowed.isError, false)
  assert.equal(allowed.value, 'ran:pwd')
  assert.equal(denied.isError, true)
  assert.match(denied.error?.message ?? '', /OUTSIDE_GRANT_SCOPE/)
  assert.equal(bashBodyRuns, 1)
  assert.equal(writeBodyRuns, 0)
  assert.equal(bypassed.isError, true)
  assert.match(bypassed.error?.message ?? '', /CHIMERA_DSH_GATE_BYPASSED/)
  assert.equal(bypassBodyRuns, 0)
  assert.equal(audit.verify().valid, true)
  const facts = audit.entries().map((entry) => entry.fact)
  assert.equal(facts.some((fact) => fact.kind === 'dsh.tool.authorized' && fact.callId === 'gate1-allowed'), true)
  assert.equal(facts.some((fact) => fact.kind === 'dsh.tool.denied' && fact.callId === 'gate1-denied'), true)

  process.stdout.write(`${JSON.stringify({
    status: 'passed',
    runtime: 'pinned DeepSeek Harness Cordis ToolRuntime',
    allowedBodyRuns: bashBodyRuns,
    deniedBodyRuns: writeBodyRuns,
    bypassBodyRuns,
    denialReason: denied.error?.message,
    bypassReason: bypassed.error?.message,
    auditChainValid: audit.verify().valid,
  })}\n`)
} finally {
  await ctx.fiber.dispose()
}
