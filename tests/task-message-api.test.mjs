import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OperatorSessionManager } from '../src/browser/operator-session.mjs'
import { handleTaskMessageRequest } from '../src/browser/task-message-api.mjs'

test('task message HTTP route requires operator session and CSRF before reading or writing guidance', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-message-api-'))
  const sessions = await OperatorSessionManager.open({ filePath: join(directory, 'session.json') })
  const session = sessions.exchangeBootstrap(sessions.issueBootstrap())
  const calls = []
  const runtime = { messageTask: async input => { calls.push(input); if (input.replyTo === 'foreign') throw Object.assign(new Error('TASK_MESSAGE_PARENT_INVALID'), { code: 'TASK_MESSAGE_PARENT_INVALID' }); return { acknowledgement: 'Saved', message: input } } }
  const server = createServer(async (request, response) => {
    const result = await handleTaskMessageRequest({ request, runtime, operatorSessions: sessions })
    response.writeHead(result.status, { 'content-type': 'application/json' }); response.end(JSON.stringify(result.body))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }) })
  const url = `http://127.0.0.1:${server.address().port}/api/tasks/message`
  const body = { taskId: 'one', recipientAgentIds: ['ace'], content: 'Address Ace' }
  const cookie = `${session.cookieName}=${session.cookieToken}`
  for (const [headers, expected] of [[{}, 401], [{ cookie }, 403], [{ cookie, 'x-chimera-csrf': 'wrong' }, 403]]) {
    assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })).status, expected)
  }
  assert.equal(calls.length, 0)
  const headers = { cookie, 'x-chimera-csrf': session.csrfToken }
  const accepted = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  assert.equal(accepted.status, 200); assert.deepEqual(calls[0], body)
  assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ...body, replyTo: 'foreign' }) })).status, 400)
  assert.equal((await fetch(url, { method: 'POST', headers, body: '{invalid' })).status, 400)
  assert.equal((await fetch(url, { method: 'POST', headers, body: 'x'.repeat(40000) })).status, 413)
})
