import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import * as browserExecutor from '../src/browser/executor.mjs'

test('the default browser session exposes a sharp 1600 by 900 viewport', async () => {
  const profileDir = await mkdtemp(join(tmpdir(), 'chimera-sharp-browser-'))
  const executor = new browserExecutor.ChromiumBrowserExecutor({ profileDir })

  try {
    const state = await executor.state()
    assert.deepEqual(state.viewport, { width: 1600, height: 900 })
  } finally {
    await executor.suspend()
    await rm(profileDir, { recursive: true, force: true })
  }
})

test('the sharp stream profile accepts bounded overrides and rejects unsafe values', () => {
  const profile = browserExecutor.browserStreamProfile?.({
    CHIMERA_BROWSER_VIEWPORT_WIDTH: '1440',
    CHIMERA_BROWSER_VIEWPORT_HEIGHT: '900',
    CHIMERA_BROWSER_STREAM_QUALITY: '82',
  })
  assert.deepEqual(profile, {
    viewport: { width: 1440, height: 900 },
    quality: 82,
  })

  const rejected = browserExecutor.browserStreamProfile?.({
    CHIMERA_BROWSER_VIEWPORT_WIDTH: '4096',
    CHIMERA_BROWSER_VIEWPORT_HEIGHT: '200',
    CHIMERA_BROWSER_STREAM_QUALITY: '100',
  })
  assert.deepEqual(rejected, {
    viewport: { width: 1600, height: 900 },
    quality: 85,
  })
})

test('the browser stream keeps only the newest frame while a send is in flight', () => {
  assert.equal(typeof browserExecutor.createLatestFrameSender, 'function')
  const sends = []
  const callbacks = []
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    send(payload, callback) {
      sends.push(JSON.parse(payload))
      callbacks.push(callback)
    },
  }
  const sender = browserExecutor.createLatestFrameSender(socket)

  sender.push({ type: 'frame', data: 'first' })
  sender.push({ type: 'frame', data: 'stale' })
  sender.push({ type: 'frame', data: 'newest' })

  assert.deepEqual(sends.map((frame) => frame.data), ['first'])
  callbacks.shift()()
  assert.deepEqual(sends.map((frame) => frame.data), ['first', 'newest'])
})

test('the browser stream drops queued frames while socket backpressure is high', () => {
  assert.equal(typeof browserExecutor.createLatestFrameSender, 'function')
  const sends = []
  const socket = {
    readyState: 1,
    bufferedAmount: 2_000_000,
    send(payload, callback) {
      sends.push(JSON.parse(payload))
      callback()
    },
  }
  const sender = browserExecutor.createLatestFrameSender(socket, { maximumBufferedBytes: 512_000 })

  assert.equal(sender.push({ type: 'frame', data: 'stale' }), false)
  assert.deepEqual(sends, [])
})

test('the browser stream caps delivery cadence while retaining the newest frame', () => {
  assert.equal(typeof browserExecutor.createLatestFrameSender, 'function')
  let currentTime = 1_000
  const scheduled = []
  const sends = []
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    send(payload, callback) {
      sends.push(JSON.parse(payload))
      callback()
    },
  }
  const sender = browserExecutor.createLatestFrameSender(socket, {
    minimumFrameIntervalMs: 33,
    now: () => currentTime,
    schedule: (callback, delay) => {
      scheduled.push({ callback, delay })
      return scheduled.length
    },
  })

  sender.push({ type: 'frame', data: 'first' })
  currentTime = 1_010
  sender.push({ type: 'frame', data: 'stale' })
  sender.push({ type: 'frame', data: 'newest' })

  assert.deepEqual(sends.map((frame) => frame.data), ['first'])
  assert.equal(scheduled.length, 1)
  assert.equal(scheduled[0].delay, 23)
  currentTime = 1_033
  scheduled[0].callback()
  assert.deepEqual(sends.map((frame) => frame.data), ['first', 'newest'])
})
