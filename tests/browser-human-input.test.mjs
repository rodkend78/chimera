import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { chromium } from 'playwright'
import * as browserInput from '../app/src/browser-stream-input.js'
import { dispatchHumanInput } from '../src/browser/executor.mjs'

const { browserPoint, pointerClickMessage } = browserInput

const appSource = await readFile(new URL('../app/src/LiveViewport.jsx', import.meta.url), 'utf8')
const styles = await readFile(new URL('../app/src/styles.css', import.meta.url), 'utf8')

test('the streamed browser accepts mouse click events from manual in-app control', () => {
  assert.match(appSource, /onClick=/)
  assert.match(appSource, /onContextMenu=/)
  assert.match(appSource, /onPointerUp=/)
  assert.match(appSource, /onKeyUp=/)
  assert.match(appSource, /onPaste=/)
  assert.match(styles, /\.live-viewport img \{[^}]*pointer-events: none;/)
})

test('the streamed browser frame stays inside the viewport used for pointer mapping', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    const image = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800"></svg>'
    await page.setContent(`
      <style>${styles}</style>
      <div class="live-viewport" style="width: 1736px; height: 779px">
        <img src="${image}" alt="Live Chromium page">
      </div>
    `)
    await page.locator('.live-viewport img').waitFor()
    const boxes = await page.locator('.live-viewport').evaluate((surface) => {
      const frame = surface.querySelector('img')
      const surfaceBox = surface.getBoundingClientRect()
      const frameBox = frame.getBoundingClientRect()
      return {
        surface: { width: surfaceBox.width, height: surfaceBox.height },
        frame: { width: frameBox.width, height: frameBox.height },
      }
    })

    assert.deepEqual(boxes, {
      surface: { width: 1736, height: 779 },
      frame: { width: 1736, height: 779 },
    })
  } finally {
    await browser.close()
  }
})

test('a viewport pointer release becomes one atomic Chromium click', () => {
  const frame = { width: 1600, height: 900 }
  const rect = { left: 100, top: 50, width: 1600, height: 900 }

  const point = browserPoint({ clientX: 900, clientY: 500 }, rect, frame)
  const message = pointerClickMessage(point)

  assert.deepEqual(message, {
    type: 'click',
    x: 800,
    y: 450,
    button: 'left',
  })
})

test('an atomic click is dispatched as one positioned mouse operation', async () => {
  const calls = []
  const page = {
    mouse: {
      click: async (...args) => calls.push(args),
    },
  }

  await dispatchHumanInput(page, {
    type: 'click',
    x: 512,
    y: 144,
    button: 'left',
  })

  assert.deepEqual(calls, [[512, 144, { button: 'left' }]])
})

test('wheel bursts are coalesced into one input per animation frame', () => {
  assert.equal(typeof browserInput.createWheelInputScheduler, 'function')
  const callbacks = []
  const sent = []
  const scheduler = browserInput.createWheelInputScheduler(
    (message) => sent.push(message),
    (callback) => callbacks.push(callback),
  )

  scheduler.push({ deltaX: 2, deltaY: 40 })
  scheduler.push({ deltaX: -1, deltaY: 60 })
  scheduler.push({ deltaX: 0, deltaY: -10 })

  assert.equal(callbacks.length, 1)
  assert.deepEqual(sent, [])
  callbacks.shift()()
  assert.deepEqual(sent, [{ type: 'wheel', x: 0, y: 0, deltaX: 1, deltaY: 90 }])
})

test('wheel modes normalize to pixels at the actual browser pointer', () => {
  const callbacks = []
  const sent = []
  const scheduler = browserInput.createWheelInputScheduler((message) => sent.push(message), (callback) => callbacks.push(callback))
  scheduler.push({ deltaX: 1, deltaY: 2, deltaMode: 1 }, { x: 40, y: 80 })
  scheduler.push({ deltaX: 0, deltaY: 1, deltaMode: 2 }, { x: 60, y: 90 }, 720)
  callbacks.shift()()
  assert.deepEqual(sent, [{ type: 'wheel', x: 60, y: 90, deltaX: 16, deltaY: 752 }])
})

test('pointer drag presses at its origin, releases at its destination, and suppresses the following click', () => {
  const sent = []
  const pointer = browserInput.createPointerInputController((message) => sent.push(message))
  pointer.down({ x: 10, y: 10 })
  pointer.move({ x: 11, y: 10 })
  assert.equal(sent.length, 0)
  pointer.move({ x: 30, y: 20 })
  pointer.up({ x: 50, y: 20 })
  pointer.cancel() // Normal lostpointercapture after pointerup must preserve click suppression.
  pointer.click({ x: 50, y: 20 })
  assert.deepEqual(sent, [
    { type: 'mouse', event: 'pressed', x: 10, y: 10, button: 'left' },
    { type: 'mouse', event: 'moved', x: 30, y: 20, button: 'left' },
    { type: 'mouse', event: 'released', x: 50, y: 20, button: 'left' },
  ])
})
