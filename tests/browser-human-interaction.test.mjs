import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'
import { dispatchHumanInput, releaseHumanInput, validateHumanInput, decodeBrowserUpload, BROWSER_FILE_LIMITS } from '../src/browser/executor.mjs'

const component = fileURLToPath(new URL('../app/src/LiveViewport.jsx', import.meta.url))
const bundle = await build({
  stdin: {
    contents: `import React from 'react'; import { createRoot } from 'react-dom/client'; import LiveViewport from ${JSON.stringify(component)};
      window.sent = []; window.pending = Promise.resolve();
      const sendInput = (message) => { window.sent.push(message); window.pending = window.pending.then(() => window.remoteInput(message)); };
      const root = createRoot(document.getElementById('root'));
      window.renderViewport = (humanControl) => root.render(React.createElement(LiveViewport, {frame:{width:800,height:600,data:'a'},humanControl,suspended:false,streamStatus:'live',sendInput}));
      window.unmountViewport = () => root.unmount();
      window.renderViewport(window.initialHumanControl ?? true);`,
    resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'jsx',
  }, bundle: true, write: false, platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"production"' }, jsx: 'automatic',
})

async function interactionFixture({ humanControl = true } = {}) {
  const browser = await chromium.launch({ headless: true })
  const remote = await browser.newPage({ viewport: { width: 800, height: 600 } })
  await remote.setContent(`<button style="position:absolute;left:40px;top:30px;width:100px;height:40px" id="button">Click</button>
    <input id="text" style="position:absolute;left:40px;top:100px;width:400px;height:40px">
    <input id="range" type="range" min="0" max="100" value="0" style="position:absolute;left:40px;top:180px;width:400px">
    <div id="scroll" style="position:absolute;left:480px;top:30px;width:200px;height:200px;overflow:auto"><div style="height:2000px">Nested scrolling</div></div>
    <script>window.events=[];document.addEventListener('click',e=>events.push({type:'click',id:e.target.id,shift:e.shiftKey}));document.addEventListener('keydown',e=>events.push({type:'keydown',key:e.key,shift:e.shiftKey,ctrl:e.ctrlKey}));document.addEventListener('keyup',e=>events.push({type:'keyup',key:e.key}));</script>`)
  const front = await browser.newPage({ viewport: { width: 800, height: 600 } })
  await front.exposeFunction('remoteInput', (message) => dispatchHumanInput(remote, message))
  await front.setContent('<style>body{margin:0}.live-viewport{width:800px;height:600px;position:relative}.live-viewport img{width:100%;height:100%;pointer-events:none}.human-input-hint{pointer-events:none}</style><div id="root"></div>')
  await front.evaluate((value) => { window.initialHumanControl = value }, humanControl)
  await front.addScriptTag({ content: bundle.outputFiles[0].text })
  await front.locator('.live-viewport').waitFor()
  return { browser, remote, front, flush: () => front.evaluate(() => window.pending) }
}

test('passive viewport mount, blur, ownership changes, and unmount send no spurious reset', async () => {
  const f = await interactionFixture({ humanControl: false })
  try {
    await f.front.evaluate(() => window.dispatchEvent(new Event('blur')))
    await f.flush()
    assert.deepEqual(await f.front.evaluate(() => sent), [])
    await f.front.evaluate(() => renderViewport(true))
    await f.front.locator('.live-viewport.interactive').waitFor()
    await f.front.evaluate(() => renderViewport(false))
    await f.front.locator('.live-viewport:not(.interactive)').waitFor()
    await f.front.evaluate(() => unmountViewport())
    await f.flush()
    assert.deepEqual(await f.front.evaluate(() => sent), [])
  } finally { await f.browser.close() }
})

test('handback releases a held key exactly once despite repeated blur and unmount', async () => {
  const f = await interactionFixture()
  try {
    await f.front.locator('.live-viewport').focus()
    await f.front.keyboard.down('Shift')
    await f.front.evaluate(() => renderViewport(false))
    await f.front.locator('.live-viewport:not(.interactive)').waitFor()
    await f.front.evaluate(() => { window.dispatchEvent(new Event('blur')); unmountViewport() })
    await f.flush()
    assert.equal(await f.front.evaluate(() => sent.filter((message) => message.type === 'reset').length), 1)
    await dispatchHumanInput(f.remote, { type: 'click', x: 80, y: 50 })
    assert.equal(await f.remote.evaluate(() => events.filter((event) => event.id === 'button').at(-1).shift), false)
  } finally { await f.browser.close() }
})

test('real viewport mouse clicks survive pointer capture, double clicks, and held Shift', async () => {
  const f = await interactionFixture()
  try {
    await f.front.mouse.click(80, 50)
    await f.flush()
    assert.equal(await f.remote.evaluate(() => events.filter((e) => e.id === 'button').length), 1)
    await f.front.keyboard.down('Shift')
    await f.front.mouse.click(80, 50)
    await f.front.keyboard.up('Shift')
    await f.flush()
    assert.equal(await f.remote.evaluate(() => events.filter((e) => e.id === 'button').at(-1).shift), true)
    const clicks = await f.front.evaluate(() => sent.filter((e) => e.type === 'click'))
    assert.equal(clicks.length, 2)
    assert.equal(await f.front.evaluate(() => sent.some((e) => e.type === 'key' && e.event === 'up' && e.key === 'Shift')), true)
    await f.front.mouse.dblclick(80, 50)
    await f.flush()
    assert.equal(await f.front.evaluate(() => sent.filter((e) => e.type === 'click').at(-1).clickCount), 2)
  } finally { await f.browser.close() }
})

test('real viewport drags move a Chromium slider without a duplicate atomic click', async () => {
  const f = await interactionFixture()
  try {
    await f.front.mouse.move(50, 190)
    await f.front.mouse.down()
    await f.front.mouse.move(390, 190, { steps: 8 })
    await f.front.mouse.up()
    await f.flush()
    assert.ok(Number(await f.remote.locator('#range').inputValue()) > 70)
    assert.equal(await f.front.evaluate(() => sent.filter((e) => e.type === 'click').length), 0)
    assert.equal(await f.front.evaluate(() => sent.filter((e) => e.type === 'mouse' && e.event === 'released').length), 1)
  } finally { await f.browser.close() }
})

test('real viewport supports typing, selection shortcuts, clipboard paste, and blur cleanup', async () => {
  const f = await interactionFixture()
  try {
    await f.front.mouse.click(100, 120)
    await f.front.keyboard.type('hello')
    await f.flush()
    assert.equal(await f.remote.locator('#text').inputValue(), 'hello')
    await f.front.keyboard.press('ControlOrMeta+A')
    await f.flush()
    // Clipboard text originates from the operator's browser event, never the host filesystem.
    await f.front.locator('.live-viewport').evaluate((element) => {
      const clipboardData = new DataTransfer()
      clipboardData.setData('text/plain', 'Pasted ✓\ntext')
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))
    })
    await f.flush()
    assert.equal(await f.remote.locator('#text').inputValue(), 'Pasted ✓ text')
    await f.front.locator('.live-viewport').evaluate((element) => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'é', code: 'KeyE', bubbles: true, cancelable: true })))
    await f.flush()
    assert.equal(await f.remote.locator('#text').inputValue(), 'Pasted ✓ texté')
    await f.front.keyboard.down('Shift')
    await f.front.locator('.live-viewport').evaluate((element) => element.blur())
    await f.flush()
    await dispatchHumanInput(f.remote, { type: 'click', x: 80, y: 50 })
    assert.equal(await f.remote.evaluate(() => events.filter((e) => e.id === 'button').at(-1).shift), false)
  } finally { await f.browser.close() }
})

test('positioned wheel input scrolls the nested target and cleanup releases dragged buttons', async () => {
  const f = await interactionFixture()
  try {
    await dispatchHumanInput(f.remote, { type: 'wheel', x: 500, y: 60, deltaX: 0, deltaY: 200 })
    await f.remote.waitForFunction(() => document.getElementById('scroll').scrollTop > 0)
    await dispatchHumanInput(f.remote, { type: 'mouse', event: 'pressed', x: 50, y: 190, button: 'left' })
    await releaseHumanInput(f.remote)
    await dispatchHumanInput(f.remote, { type: 'mouse', event: 'moved', x: 400, y: 190 })
    assert.ok(Number(await f.remote.locator('#range').inputValue()) < 20)
  } finally { await f.browser.close() }
})

test('invalid human messages and uploads are bounded before browser dispatch', () => {
  for (const input of [null, { type: 'mouse', event: 'unknown', x: 1, y: 2 }, { type: 'click', x: NaN, y: 0 }, { type: 'text', text: 'a'.repeat(65_537) }, { type: 'wheel', deltaX: 0, deltaY: Infinity }]) {
    assert.throws(() => validateHumanInput(input), /INVALID_BROWSER_INPUT/)
  }
  const valid = [{ name: 'hello.txt', mimeType: 'text/plain', base64: Buffer.from('hello').toString('base64') }]
  assert.equal(decodeBrowserUpload(valid)[0].buffer.toString(), 'hello')
  assert.throws(() => decodeBrowserUpload([{ ...valid[0], name: '../private.txt' }]), /INVALID_BROWSER_UPLOAD/)
  assert.throws(() => decodeBrowserUpload([{ ...valid[0], base64: '!@#' }]), /INVALID_BROWSER_UPLOAD/)
  assert.throws(() => decodeBrowserUpload(Array(BROWSER_FILE_LIMITS.uploadCount + 1).fill(valid[0])), /INVALID_BROWSER_UPLOAD/)
})
