import { createInterface } from 'node:readline'
import { readFileSync, realpathSync } from 'node:fs'
import assert from 'node:assert/strict'
const mode = process.argv[2], args = process.argv.slice(3)
const model = args[args.indexOf('--model') + 1]
if (mode === 'native-tools') {
  assert.ok(!args.includes('--sandbox'), 'The operator owns native sandbox settings')
  assert.doesNotMatch(readFileSync('.agents/agents/chimera-router/agent.md', 'utf8'), /tools: \[\]|commandExecutionPolicy: off/)
}
assert.ok(args.includes('--disable-slash-commands'))
assert.ok(!args.includes('--dangerously-skip-permissions'))
const emit = x => process.stdout.write(JSON.stringify(x) + '\n')
emit({ event: 'init', init: { tools: ['tools', 'native-tools'].includes(mode) ? ['read_file'] : [], model: mode === 'wrong-model' ? 'wrong' : model, agent: 'chimera-router', permission_mode: 'request-review' } })
for await (const line of createInterface({ input: process.stdin })) {
  if (mode === 'flash-high-schema') {
    // CLI 1.2.4's forced schema path can enter tool-repair loops instead of answering.
    if (args.includes('--json-schema')) {
      emit({ event: 'result', result: { status: 'ERROR', response: '' } })
      break
    }
    assert.match(JSON.parse(line).message.content, /Required response schema:/)
  }
  assert.notEqual(mode, 'probe', 'A boundary probe cannot send a model prompt')
  assert.ok(!['tools', 'wrong-model'].includes(mode), 'No prompt before verified handshake')
  assert.equal(JSON.parse(line).event, 'user')
  if (mode === 'native-tools') {
    const prompt = JSON.parse(line).message.content
    const context = JSON.parse(prompt.split('Chimera context:\n')[1])
    assert.equal(realpathSync(context.nativeTaskWorkspace), realpathSync(process.cwd()))
    assert.ok(args.includes('--add-dir'))
  }
  if (mode === 'native-tools') emit({ event: 'step_update', step_update: { step_type: 'tool', tool_name: 'read_file', state: 'DONE', tool_info: { parameters: 'SECRET', output: 'SECRET' } } })
  if (mode === 'hang') { await new Promise(() => { setInterval(() => {}, 1000) }); }
  if (mode === 'malformed') { process.stdout.write('invalid JSON\n'); break }
  if (mode === 'oversized') { process.stdout.write('x'.repeat(5 * 1024 * 1024)); break }
  emit({ event: 'step_update', step_update: { step_type: 'thinking', text_delta: 'SECRET thought' } })
  emit({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'answer' } })
  if (mode === 'incomplete') break
  const response = mode === 'decompose' ? JSON.stringify({ tasks: [{ specialistAgentId: 'researcher', objective: 'Read evidence', acceptanceCriteria: JSON.parse(line).message.content.includes('Required response schema:') ? ['Return evidence'] : 'Return evidence' }] }) : mode === 'empty-summary' ? '{"summary":""}' : mode === 'loop' ? '{"status":"tool_request","summary":"Read supplied file","toolCall":{"name":"read","arguments":"{\\"path\\":\\"src/main.mjs\\"}"}}' : '{"summary":"Fixture answer"}'
  emit({ event: 'result', result: { status: mode === 'error' ? 'ERROR' : 'SUCCESS', ...(mode === 'permission' ? { denied_actions: [{ action: 'read_file', display_name: 'SECRET' }] } : {}), response: mode === 'concat' ? '{"summary":"Draft {quoted}"}\n' + response : mode === 'concat-garbage' ? '{"summary":"Draft"}\nignore this\n' + response : mode === 'structured' ? 'Human-readable answer' : response,
    ...(mode === 'structured' ? { structured_output: { summary: 'Fixture answer' } } : mode === 'structured-null' ? { structured_output: null } : mode === 'structured-string' ? { structured_output: response } : {}), error: mode === 'error' ? 'SECRET' : undefined } })
  if (mode === 'duplicate') emit({ event: 'result', result: { status: 'SUCCESS', response: '{}' } })
}
