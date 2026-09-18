import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ChimeraBrowserRuntime } from '../src/browser/runtime.mjs'
import { createDeterministicModelRouter } from '../src/ceo/model-router.mjs'

const manifest = {
  schema: 'chimera.agent-manifest.v1', agentId: 'ace', displayName: 'Ace', role: 'General specialist',
  capabilities: ['general'], modelPreference: { mode: 'chimera-auto' }, enabled: true,
  source: { type: 'hermes', sourceId: 'hermes-aws', profileId: 'ace', ref: 'hermes://configured-hermes/profiles/ace' },
  personaRefs: [{ type: 'hermes-profile', ref: 'hermes://configured-hermes/profiles/ace/persona' }],
  memoryRefs: [{ type: 'hermes-profile', ref: 'hermes://configured-hermes/profiles/ace/memory' }],
  skillRefs: [{ type: 'hermes-profile', ref: 'hermes://configured-hermes/profiles/ace/skills' }],
  execution: { adapter: 'model-fabric', isolation: 'per-agent-workspace', sideEffects: 'dsh-required' },
  importedAt: '2026-09-10T00:00:00.000Z',
}

const modelRegistry = (calls) => ({
  state: () => ({ schema: 'chimera.model-provider-registry.v1', selected: { providerId: 'fixture', providerName: 'Fixture', model: 'ceo', modelName: 'CEO' }, providers: [] }),
  router: () => createDeterministicModelRouter({ routerId: 'openai-compatible:fixture:ceo', responder: async (_prompt, context) => {
    calls.push(context.stage)
    if (context.stage === 'decompose') return { tasks: [{ specialistAgentId: 'ace', objective: 'Return a bounded server finding.', acceptanceCriteria: ['Include the remote run ID.'] }] }
    if (context.stage === 'synthesize') return { summary: 'CEO verified the server-backed finding.' }
    return { summary: 'unexpected' }
  } }),
  async select() {},
})

test('runtime routes a non-project team handoff through the authenticated remote transport', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-remote-team-runtime-'))
  const transportCalls = []
  const transport = { dispatch: async input => {
    transportCalls.push(input)
    return { protocol: 'chimera-team-run.v1', status: 'succeeded', profileId: 'ace', taskId: input.taskId, requestId: input.requestId, runId: 'run-server-1', summary: 'Ace returned server evidence.', result: { text: 'Evidence from the server profile.' } }
  } }
  const agentFile = join(directory, 'agents.json')
  await writeFile(agentFile, JSON.stringify({ schema: 'chimera.agent-registry.v1', agents: [manifest] }))
  const runtime = new ChimeraBrowserRuntime({ profileDir: join(directory, 'profiles/ceo'), agentFile, modelRegistry: modelRegistry([]), teamTransport: transport,
    browserExecutor: { async start() { return { running: true, tabs: [] } }, async state() { return { running: true, tabs: [] } }, async suspend() { return { running: false, tabs: [] } } } })
  try {
    await runtime.start()
    const submitted = await runtime.submitTask({ objective: 'Ask Ace for the server-backed finding.' })
    const completed = await runtime.waitForTask(submitted.taskId)
    assert.equal(completed.status, 'completed', JSON.stringify(completed))
    assert.equal(transportCalls.length, 1)
    assert.equal(transportCalls[0].profileId, 'ace')
    assert.equal(transportCalls[0].workspaceRoot, `/var/lib/chimera/team-tasks/${submitted.taskId}`)
    assert.ok(completed.result || completed.summary)
  } finally {
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
})
