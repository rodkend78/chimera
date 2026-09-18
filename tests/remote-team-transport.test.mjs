import assert from 'node:assert/strict'
import test from 'node:test'
import { RemoteTeamTransport } from '../src/agents/remote-team-transport.mjs'

const response = (extra = {}) => ({
  protocol: 'chimera-team-run.v1',
  status: 'succeeded',
  profileId: 'ace',
  taskId: 'task-1',
  requestId: 'request-1',
  runId: 'run-1',
  summary: 'Remote evidence collected.',
  result: { summary: 'Remote evidence collected.', artifact: 'scratch/report.md' },
  ...extra,
})

test('remote dispatch builds one pinned authenticated request and returns the exact run identity', async () => {
  const calls = []
  const transport = new RemoteTeamTransport({
    target: 'worker@example.invalid',
    port: 2223,
    identityFile: '/private/hp/id_ed25519',
    knownHostsFile: '/private/hp/known_hosts',
    allowedWorkspaceRoot: '/var/lib/chimera/team-tasks',
    run: async (command, input, options) => { calls.push({ command, input, options }); return response() },
  })
  const result = await transport.dispatch({
    profileId: 'ace', taskId: 'task-1', requestId: 'request-1', objective: 'Collect evidence',
    acceptanceCriteria: ['Return evidence'], workspaceRoot: '/var/lib/chimera/team-tasks/task-1',
  })
  assert.equal(result.runId, 'run-1')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].command.slice(0, 8), ['/usr/bin/ssh', '-F', '/dev/null', '-p', '2223', '-T', '-o', 'BatchMode=yes'])
  assert.equal(calls[0].command.at(-2), 'worker@example.invalid')
  assert.equal(calls[0].command.at(-1), 'chimera-team-v1 dispatch ace request-1')
  assert.equal(calls[0].input.workspaceRoot, '/var/lib/chimera/team-tasks/task-1')
  assert.equal(calls[0].options.timeoutMs, 900_000)
})

test('remote dispatch rejects workspace escape, unknown profile, and malformed response before retrying', async () => {
  let calls = 0
  const transport = new RemoteTeamTransport({
    target: 'worker@example.invalid', identityFile: '/key', knownHostsFile: '/known',
    allowedWorkspaceRoot: '/var/lib/chimera/team-tasks',
    run: async () => { calls += 1; throw new Error('must not run') },
  })
  await assert.rejects(transport.dispatch({ profileId: 'root', taskId: 'task-1', requestId: 'request-1', objective: 'x', acceptanceCriteria: ['y'], workspaceRoot: '/var/lib/chimera/team-tasks/task-1' }), { code: 'REMOTE_TEAM_PROFILE_INVALID' })
  await assert.rejects(transport.dispatch({ profileId: 'ace', taskId: 'task-1', requestId: 'request-1', objective: 'x', acceptanceCriteria: ['y'], workspaceRoot: '/srv/chimera/other' }), { code: 'REMOTE_TEAM_WORKSPACE_INVALID' })
  assert.equal(calls, 0)
  const malformed = new RemoteTeamTransport({
    target: 'worker@example.invalid', identityFile: '/key', knownHostsFile: '/known', allowedWorkspaceRoot: '/var/lib/chimera/team-tasks',
    run: async () => ({ ...response(), requestId: 'wrong-request' }),
  })
  await assert.rejects(malformed.dispatch({ profileId: 'ace', taskId: 'task-1', requestId: 'request-1', objective: 'x', acceptanceCriteria: ['y'], workspaceRoot: '/var/lib/chimera/team-tasks/task-1' }), { code: 'REMOTE_TEAM_RESPONSE_MISMATCH' })
})

test('remote target rejects leading SSH options and unsafe host syntax before any run', async () => {
  let calls = 0
  for (const target of ['-oProxyCommand=echo%20unsafe', 'worker@-oProxyCommand=echo', 'worker@example.invalid;id', 'worker@example.invalid bad']) {
    assert.throws(() => new RemoteTeamTransport({
      target,
      identityFile: '/key',
      knownHostsFile: '/known',
      allowedWorkspaceRoot: '/var/lib/chimera/team-tasks',
      run: async () => { calls += 1 },
    }), (error) => error.code === 'REMOTE_TEAM_CONFIG_INVALID')
  }
  assert.equal(calls, 0)

  const ipv6 = new RemoteTeamTransport({
    target: 'worker@[2001:db8::1]',
    identityFile: '/key',
    knownHostsFile: '/known',
    allowedWorkspaceRoot: '/var/lib/chimera/team-tasks',
    run: async () => response(),
  })
  assert.equal(ipv6.command('ace', 'request-1').at(-2), 'worker@[2001:db8::1]')
})

test('lost response is surfaced as uncertain and never retried', async () => {
  let calls = 0
  const transport = new RemoteTeamTransport({
    target: 'worker@example.invalid', identityFile: '/key', knownHostsFile: '/known', allowedWorkspaceRoot: '/var/lib/chimera/team-tasks',
    run: async () => { calls += 1; const error = new Error('response lost'); error.code = 'REMOTE_TEAM_RESPONSE_LOST'; throw error },
  })
  await assert.rejects(transport.dispatch({ profileId: 'ace', taskId: 'task-1', requestId: 'request-1', objective: 'x', acceptanceCriteria: ['y'], workspaceRoot: '/var/lib/chimera/team-tasks/task-1' }), { code: 'REMOTE_TEAM_RESPONSE_LOST' })
  assert.equal(calls, 1)
})
