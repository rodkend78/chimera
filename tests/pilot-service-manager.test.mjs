import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { execFile as execFileCallback } from 'node:child_process'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import {
  evaluatePilotServiceStatus,
  inspectPilotService,
  pilotServicePlist,
  removePilotService,
  submitPilotService,
  waitForPilotService,
} from '../src/pilot/service-manager.mjs'

const execFile = promisify(execFileCallback)

test('pilot service status distinguishes a healthy daemon from a stale cached UI', () => {
  assert.deepEqual(
    evaluatePilotServiceStatus({ jobLoaded: true, portListening: true }),
    { status: 'running', jobLoaded: true, portListening: true },
  )
  assert.deepEqual(
    evaluatePilotServiceStatus({ jobLoaded: false, portListening: false }),
    { status: 'stopped', jobLoaded: false, portListening: false },
  )
  assert.deepEqual(
    evaluatePilotServiceStatus({ jobLoaded: true, portListening: false }),
    { status: 'starting', jobLoaded: true, portListening: false },
  )
  assert.deepEqual(
    evaluatePilotServiceStatus({ jobLoaded: false, portListening: true }),
    { status: 'unmanaged', jobLoaded: false, portListening: true },
  )
})

test('pilot launch agent plist escapes every command value and enables restart', () => {
  const plist = pilotServicePlist({
    label: 'com.example.chimera',
    program: '/tmp/node&runner',
    args: ['arg<one>', 'quoted"value'],
    outputPath: '/tmp/chimera&pilot.log',
    workingDirectory: '/tmp/project<root>',
  })
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/)
  assert.match(plist, /\/tmp\/node&amp;runner/)
  assert.match(plist, /arg&lt;one&gt;/)
  assert.match(plist, /quoted&quot;value/)
  assert.match(plist, /\/tmp\/project&lt;root&gt;/)
  assert.doesNotMatch(plist, /node&runner|arg<one>|quoted"value|project<root>/)
})

test('macOS pilot service survives its launching process and can be stopped cleanly', { skip: process.platform !== 'darwin' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-pilot-service-'))
  const label = `com.teamrsi.chimera.test.${process.pid}.${crypto.randomUUID()}`
  const port = await freePort()
  const outputPath = join(directory, 'service.log')
  const code = `require('node:net').createServer(socket => socket.end()).listen(${port}, '127.0.0.1')`

  try {
    await submitPilotService({
      label,
      program: process.execPath,
      args: ['-e', code],
      outputPath,
    })
    const running = await waitForPilotService({ label, host: '127.0.0.1', port, timeoutMs: 5_000 })
    assert.equal(running.status, 'running')

    const { stdout } = await execFile('launchctl', ['print', `gui/${process.getuid()}/${label}`])
    const firstPid = Number(stdout.match(/\bpid = (\d+)/)?.[1])
    assert.ok(Number.isInteger(firstPid) && firstPid > 0)
    process.kill(firstPid, 'SIGKILL')
    await waitForDifferentPid(label, firstPid)
    const restarted = await waitForPilotService({ label, host: '127.0.0.1', port, timeoutMs: 5_000 })
    assert.equal(restarted.status, 'running')

    await removePilotService({ label })
    const stopped = await inspectPilotService({ label, host: '127.0.0.1', port })
    assert.equal(stopped.status, 'stopped')
  } finally {
    await removePilotService({ label }).catch(() => {})
    await rm(directory, { recursive: true, force: true })
  }
})

async function waitForDifferentPid(label, previousPid) {
  const deadline = Date.now() + 5_000
  do {
    const { stdout = '' } = await execFile('launchctl', ['print', `gui/${process.getuid()}/${label}`]).catch(() => ({}))
    const pid = Number(stdout.match(/\bpid = (\d+)/)?.[1])
    if (Number.isInteger(pid) && pid > 0 && pid !== previousPid) return pid
    await new Promise((resolve) => setTimeout(resolve, 50))
  } while (Date.now() < deadline)
  throw new Error('pilot service did not restart with a new pid')
}

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}
