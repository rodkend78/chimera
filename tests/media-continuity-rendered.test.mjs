import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const image = { kind: 'image', status: 'completed', modelId: 'stability.fixture', mimeType: 'image/png',
  base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' }
const video = { kind: 'video', status: 'in-progress', modelId: 'luma.fixture', jobId: 'video-one', outputS3Uri: 's3://fixture/video-one/' }

async function fixture(t, handler, { clock = false } = {}) {
  const server = await createServer({ configFile: new URL('../app/vite.config.js', import.meta.url).pathname,
    server: { host: '127.0.0.1', port: 0, hmr: false, proxy: {} } })
  await server.listen()
  const browser = await chromium.launch({ headless: true })
  t.after(async () => { await browser.close(); await server.close() })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  page.setDefaultTimeout(3000)
  if (clock) await page.clock.install()
  const errors = [], calls = []
  const state = {
    agent: { id: 'ceo', name: 'RJ', status: 'Idle' }, controller: { type: 'agent', id: 'ceo' }, suspended: false,
    browser: { running: true, tabs: [] }, activity: [], recentEvents: [], decisions: [], audit: { valid: true },
    models: { selected: { providerId: 'fixture', model: 'fixture' }, providers: [{ id: 'aws-bedrock', name: 'AWS Bedrock', models: [
      { id: 'stability.fixture', name: 'Stability fixture', adapter: 'ready', capabilities: ['image-generation'] },
      { id: 'luma.fixture', name: 'Luma fixture', adapter: 'ready', capabilities: ['video-generation'] },
    ] }] }, auth: { codex: { connected: true } }, agents: { specialists: [] },
    conversations: { channels: [], messages: [] }, tasks: [], projects: { projects: [], sessions: [], leases: [] },
  }
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => {
    if (['error', 'warning'].includes(message.type()) && !message.text().includes('503 (Service Unavailable)')) errors.push(message.text())
  })
  await page.routeWebSocket('**/api/browser/stream', socket => socket.onMessage(() => {}))
  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.hostname !== '127.0.0.1') throw new Error(`Unexpected external request: ${url.origin}`)
    const path = url.pathname
    if (!path.startsWith('/api/')) return route.continue()
    if (path === '/api/operator/session') return route.fulfill({ json: { csrfToken: 'fixture', expiresAt: new Date(Date.now() + 60000).toISOString() } })
    const body = route.request().method() === 'POST' ? route.request().postDataJSON() : null
    if (path !== '/api/state') calls.push({ path, body })
    if (await handler?.({ route, path, body, state })) return
    await route.fulfill({ json: path === '/api/state' ? state : {} })
  })
  const url = `http://127.0.0.1:${server.httpServer.address().port}/`
  await page.goto(url)
  assert.equal(page.url(), url)
  assert.equal(await page.title(), 'Chimera Browser Workspace')
  if (await page.getByRole('button', { name: 'More tools', exact: true }).getAttribute('aria-expanded') === 'false') await page.getByRole('button', { name: 'More tools', exact: true }).click()
  await page.getByRole('button', { name: 'Media', exact: true }).click()
  await page.getByRole('heading', { name: 'Media Studio', exact: true }).waitFor()
  return { page, calls, errors }
}

async function roundTrip(page) {
  await page.getByRole('button', { name: 'Work', exact: true }).click()
  if (await page.getByRole('button', { name: 'More tools', exact: true }).getAttribute('aria-expanded') === 'false') await page.getByRole('button', { name: 'More tools', exact: true }).click()
  await page.getByRole('button', { name: 'Media', exact: true }).click()
}

test('media draft settings and generated result survive section navigation without replay', { timeout: 20000 }, async t => {
  const { page, calls, errors } = await fixture(t, async ({ path, route }) => {
    if (path !== '/api/media/generate') return false
    await route.fulfill({ json: image }); return true
  })
  await page.getByRole('textbox', { name: 'Describe the image' }).fill('A turquoise mechanical owl')
  await page.getByRole('combobox', { name: 'Aspect', exact: true }).selectOption('1:1')
  await page.getByRole('button', { name: 'Generate image', exact: true }).click()
  await page.getByRole('img', { name: 'generated image' }).waitFor()
  await page.getByRole('tab', { name: 'Luma Video' }).click()
  await page.getByRole('combobox', { name: 'Duration' }).selectOption('9s')
  await page.getByRole('combobox', { name: 'Resolution' }).selectOption('720p')
  await roundTrip(page)
  assert.equal(await page.getByRole('tab', { name: 'Luma Video' }).getAttribute('aria-selected'), 'true')
  assert.equal(await page.getByRole('textbox', { name: 'Describe the video' }).inputValue(), 'A turquoise mechanical owl')
  assert.equal(await page.getByRole('combobox', { name: 'Aspect', exact: true }).inputValue(), '1:1')
  assert.equal(await page.getByRole('combobox', { name: 'Duration' }).inputValue(), '9s')
  assert.equal(await page.getByRole('combobox', { name: 'Resolution' }).inputValue(), '720p')
  assert.equal(await page.getByRole('img', { name: 'generated image' }).isVisible(), true)
  assert.deepEqual(calls.filter(c => c.path === '/api/media/generate').map(c => c.body), [
    { model: 'stability.fixture', prompt: 'A turquoise mechanical owl', aspectRatio: '1:1', outputFormat: 'png' },
  ])
  assert.deepEqual(errors, [])
})

test('media generation stays single-flight across same-turn submits and navigation; late result preserves new draft', { timeout: 20000 }, async t => {
  let release, arrived
  const pending = new Promise(resolve => { arrived = resolve })
  const { page, calls, errors } = await fixture(t, async ({ path, route }) => {
    if (path !== '/api/media/generate') return false
    arrived(); await new Promise(resolve => { release = resolve })
    await route.fulfill({ json: image }); return true
  })
  t.after(() => release?.())
  await page.getByRole('textbox', { name: 'Describe the image' }).fill('Original request')
  await page.locator('.media-composer').evaluate(form => { form.requestSubmit(); form.requestSubmit() })
  await pending
  assert.equal(calls.filter(c => c.path === '/api/media/generate').length, 1)
  await roundTrip(page)
  assert.equal(await page.getByRole('button', { name: 'Sending…', exact: true }).isDisabled(), true)
  await page.getByRole('textbox', { name: 'Describe the image' }).fill('New unsent idea')
  await page.locator('.media-composer').evaluate(form => form.requestSubmit())
  await page.getByRole('button', { name: 'Work', exact: true }).click()
  release()
  await page.getByText('Stability image generated', { exact: true }).waitFor()
  if (await page.getByRole('button', { name: 'More tools', exact: true }).getAttribute('aria-expanded') === 'false') await page.getByRole('button', { name: 'More tools', exact: true }).click()
  await page.getByRole('button', { name: 'Media', exact: true }).click()
  await page.getByRole('img', { name: 'generated image' }).waitFor()
  assert.equal(await page.getByRole('textbox', { name: 'Describe the image' }).inputValue(), 'New unsent idea')
  assert.equal(calls.filter(c => c.path === '/api/media/generate').length, 1)
  assert.deepEqual(errors, [])
})

test('media failures retain drafts and persistent recovery guidance without automatically retrying', { timeout: 20000 }, async t => {
  const { page, calls, errors } = await fixture(t, async ({ path, route }) => {
    if (path !== '/api/media/generate') return false
    await route.fulfill({ status: 503, json: { error: 'MEDIA_SERVICE_UNAVAILABLE' } }); return true
  })
  await page.getByRole('textbox', { name: 'Describe the image' }).fill('Keep this prompt')
  await page.getByRole('button', { name: 'Generate image', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: /media service unavailable/i }).waitFor()
  await roundTrip(page)
  assert.equal(await page.getByRole('alert').filter({ hasText: /not.*automatically|no automatic/i }).isVisible(), true)
  assert.equal(await page.getByRole('textbox', { name: 'Describe the image' }).inputValue(), 'Keep this prompt')
  assert.equal(calls.filter(c => c.path === '/api/media/generate').length, 1)
  await page.locator('.media-composer').hover()
  await page.mouse.wheel(0, 450)
  await page.waitForFunction(() => {
    const button = document.querySelector('.media-generate').getBoundingClientRect()
    const dock = document.querySelector('.statusbar').getBoundingClientRect()
    return button.top >= 90 && button.bottom <= dock.top
  })
  await page.screenshot({ path: '/tmp/chimera-media-recovery-desktop.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('alert').scrollIntoViewIfNeeded()
  await page.screenshot({ path: '/tmp/chimera-media-recovery-mobile.png' })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  assert.equal(await page.locator('vite-error-overlay').count(), 0)
  assert.deepEqual(errors, [])
})

test('accepted media remains accepted when workspace refresh fails', { timeout: 20000 }, async t => {
  let generated = false
  const { page, calls, errors } = await fixture(t, async ({ path, route }) => {
    if (path === '/api/media/generate') { generated = true; await route.fulfill({ json: image }); return true }
    if (path === '/api/state' && generated) { await route.fulfill({ status: 503, json: { error: 'STATE_UNAVAILABLE' } }); return true }
    return false
  })
  await page.getByRole('textbox', { name: 'Describe the image' }).fill('Accepted once')
  await page.getByRole('button', { name: 'Generate image', exact: true }).click()
  await page.locator('.media-notice').filter({ hasText: /Do not repeat this accepted request/ }).waitFor()
  await roundTrip(page)
  assert.equal(await page.getByRole('img', { name: 'generated image' }).isVisible(), true)
  assert.equal(await page.locator('.media-notice[role="alert"]').count(), 0)
  assert.equal(calls.filter(c => c.path === '/api/media/generate').length, 1)
  assert.deepEqual(errors, [])
})

test('failed video checks retain the job, pause off-screen, and recover without generating again', { timeout: 20000 }, async t => {
  let checks = 0
  const { page, calls, errors } = await fixture(t, async ({ path, route }) => {
    if (path === '/api/media/generate') { await route.fulfill({ json: video }); return true }
    if (path === '/api/media/status') {
      checks += 1
      await route.fulfill(checks === 1 ? { status: 503, json: { error: 'VIDEO_STATUS_UNAVAILABLE' } }
        : { json: { ...video, status: 'completed' } }); return true
    }
    return false
  }, { clock: true })
  await page.getByRole('tab', { name: 'Luma Video' }).click()
  await page.getByRole('textbox', { name: 'Describe the video' }).fill('A cinematic orbital shot of a turquoise mechanical owl')
  await page.getByRole('button', { name: 'Generate video', exact: true }).click()
  await page.getByText('Luma is rendering', { exact: true }).waitFor()
  await page.clock.runFor(5100)
  await page.getByRole('alert').filter({ hasText: /video status unavailable/ }).waitFor()
  assert.equal(await page.getByText('Job: video-one', { exact: true }).isVisible(), true)
  await page.getByRole('button', { name: 'Work', exact: true }).click()
  await page.clock.runFor(11000)
  assert.equal(checks, 1, 'leaving Media does not keep issuing status requests')
  if (await page.getByRole('button', { name: 'More tools', exact: true }).getAttribute('aria-expanded') === 'false') await page.getByRole('button', { name: 'More tools', exact: true }).click()
  await page.getByRole('button', { name: 'Media', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: /video status unavailable/ }).waitFor()
  await page.clock.runFor(5100)
  await page.locator('.media-progress strong').filter({ hasText: /^completed$/ }).waitFor()
  assert.equal(await page.locator('.media-preview [role="alert"]').count(), 0)
  assert.equal(calls.filter(c => c.path === '/api/media/generate').length, 1)
  assert.deepEqual(calls.filter(c => c.path === '/api/media/status').map(c => c.body), [{ jobId: 'video-one' }, { jobId: 'video-one' }])
  assert.deepEqual(errors, [])
})

test('late video status cannot replace a newer image and status reads do not overlap', { timeout: 25000 }, async t => {
  let release, arrived
  const pending = new Promise(resolve => { arrived = resolve })
  const { page, calls, errors } = await fixture(t, async ({ path, route, body }) => {
    if (path === '/api/media/generate') {
      await route.fulfill({ json: body.model === 'luma.fixture' ? video : image }); return true
    }
    if (path === '/api/media/status') {
      arrived(); await new Promise(resolve => { release = resolve })
      await route.fulfill({ json: { ...video, status: 'completed' } }); return true
    }
    return false
  }, { clock: true })
  t.after(() => release?.())
  await page.getByRole('tab', { name: 'Luma Video' }).click()
  await page.getByRole('textbox', { name: 'Describe the video' }).fill('Orbit the owl')
  await page.getByRole('button', { name: 'Generate video', exact: true }).click()
  await page.getByText('Luma is rendering', { exact: true }).waitFor()
  await page.clock.runFor(5100)
  await pending
  await page.clock.runFor(11000)
  assert.equal(calls.filter(c => c.path === '/api/media/status').length, 1)
  await page.getByRole('tab', { name: 'Stability Image' }).click()
  await page.getByRole('button', { name: 'Generate image', exact: true }).click()
  await page.getByRole('img', { name: 'generated image' }).waitFor()
  release()
  await page.clock.runFor(6000)
  await roundTrip(page)
  assert.equal(await page.getByRole('img', { name: 'generated image' }).isVisible(), true)
  assert.equal(await page.getByText('Luma video is ready', { exact: true }).count(), 0)
  assert.equal(calls.filter(c => c.path === '/api/media/status').length, 1)
  assert.deepEqual(errors, [])
})

test('media history restores an earlier video after image generation and checks only the selected job', { timeout: 20000 }, async t => {
  const { page, calls, errors } = await fixture(t, async ({ path, route, body }) => {
    if (path === '/api/media/generate') { await route.fulfill({ json: body.model === 'luma.fixture' ? video : image }); return true }
    if (path === '/api/media/status') { await route.fulfill({ json: { ...video, status: 'completed' } }); return true }
    return false
  }, { clock: true })
  await page.getByRole('tab', { name: 'Luma Video' }).click()
  await page.getByRole('textbox', { name: 'Describe the video' }).fill('A sweeping camera move')
  await page.getByRole('button', { name: 'Generate video', exact: true }).click()
  await page.getByText('Luma is rendering', { exact: true }).waitFor()
  await page.getByRole('tab', { name: 'Stability Image' }).click()
  await page.getByRole('textbox', { name: 'Describe the image' }).fill('An owl portrait')
  await page.getByRole('button', { name: 'Generate image', exact: true }).click()
  await page.getByRole('img', { name: 'generated image' }).waitFor()
  await page.clock.runFor(6000)
  assert.equal(calls.filter(c => c.path === '/api/media/status').length, 0)
  await page.getByRole('button', { name: /^Video video-one/ }).click()
  await page.getByText('Luma is rendering', { exact: true }).waitFor()
  await page.clock.runFor(5100)
  await page.locator('.media-progress strong').filter({ hasText: /^completed$/ }).waitFor()
  assert.deepEqual(calls.filter(c => c.path === '/api/media/status').map(c => c.body), [{ jobId: 'video-one' }])
  assert.equal(await page.getByRole('textbox', { name: 'Describe the image' }).inputValue(), 'An owl portrait')
  await roundTrip(page)
  await page.getByRole('button', { name: /^Image 1/ }).click()
  assert.equal(await page.getByRole('img', { name: 'generated image' }).isVisible(), true)
  assert.equal(calls.filter(c => c.path === '/api/media/generate').length, 2)
  assert.deepEqual(errors, [])
})

test('runtime video history can be selected after reload without automatically polling or generating', { timeout: 20000 }, async t => {
  const { page, calls, errors } = await fixture(t, async ({ path, state }) => {
    if (path === '/api/state') state.models.media = { jobs: [{ ...video, status: 'completed' }, { ...video, jobId: 'older-video', status: 'failed', error: 'RENDER_FAILED' }] }
    return false
  }, { clock: true })
  await page.getByRole('button', { name: /^Video video-one/ }).waitFor()
  await page.clock.runFor(6000)
  assert.equal(calls.filter(c => c.path.startsWith('/api/media/')).length, 0)
  await page.getByRole('button', { name: /^Video video-one/ }).click()
  await page.getByText('Job: video-one', { exact: true }).waitFor()
  await page.reload()
  if (await page.getByRole('button', { name: 'More tools', exact: true }).getAttribute('aria-expanded') === 'false') await page.getByRole('button', { name: 'More tools', exact: true }).click()
  await page.getByRole('button', { name: 'Media', exact: true }).click()
  const older = page.getByRole('button', { name: /^Video older-video/ })
  await older.focus()
  await older.press('Enter')
  await page.getByText('Job: older-video', { exact: true }).waitFor()
  assert.equal(calls.filter(c => c.path.startsWith('/api/media/')).length, 0)
  assert.equal(await page.getByRole('textbox', { name: 'Describe the image' }).inputValue(), '')
  assert.deepEqual(errors, [])
  await page.screenshot({ path: '/tmp/chimera-media-history-desktop.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('heading', { name: 'Recent media', exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: '/tmp/chimera-media-history-mobile.png' })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  assert.equal(await page.locator('vite-error-overlay').count(), 0)
})

test('selecting history during pending generation is not overwritten by its later acceptance', { timeout: 20000 }, async t => {
  let release, arrived
  const pending = new Promise(resolve => { arrived = resolve })
  const { page, calls, errors } = await fixture(t, async ({ path, state, route }) => {
    if (path === '/api/state') state.models.media = { jobs: [{ ...video, status: 'completed' }] }
    if (path === '/api/media/generate') {
      arrived(); await new Promise(resolve => { release = resolve })
      await route.fulfill({ json: image }); return true
    }
    return false
  })
  t.after(() => release?.())
  await page.getByRole('textbox', { name: 'Describe the image' }).fill('A new result')
  await page.getByRole('button', { name: 'Generate image', exact: true }).click()
  await pending
  await page.getByRole('button', { name: /^Video video-one/ }).click()
  release()
  await page.getByRole('button', { name: /^Image 1/ }).waitFor()
  assert.equal(await page.getByText('Job: video-one', { exact: true }).isVisible(), true)
  assert.equal(await page.getByRole('img', { name: 'generated image' }).count(), 0)
  await page.getByRole('button', { name: /^Image 1/ }).click()
  assert.equal(await page.getByRole('img', { name: 'generated image' }).isVisible(), true)
  assert.equal(calls.filter(c => c.path === '/api/media/generate').length, 1)
  assert.deepEqual(errors, [])
})

test('image preview retention is bounded without evicting video job references', { timeout: 25000 }, async t => {
  const { page, calls, errors } = await fixture(t, async ({ path, route, body }) => {
    if (path !== '/api/media/generate') return false
    await route.fulfill({ json: body.model === 'luma.fixture' ? video : image }); return true
  }, { clock: true })
  await page.getByRole('tab', { name: 'Luma Video' }).click()
  await page.getByRole('textbox', { name: 'Describe the video' }).fill('Keep this video')
  await page.getByRole('button', { name: 'Generate video', exact: true }).click()
  await page.getByRole('button', { name: /^Video video-one/ }).waitFor()
  await page.getByRole('tab', { name: 'Stability Image' }).click()
  for (let number = 1; number <= 11; number += 1) {
    await page.getByRole('textbox', { name: 'Describe the image' }).fill(`Image draft ${number}`)
    await page.getByRole('button', { name: 'Generate image', exact: true }).click()
    await page.getByRole('button', { name: new RegExp(`^Image ${number} `) }).waitFor()
  }
  assert.equal(await page.getByRole('button', { name: /^Image \d+ / }).count(), 10)
  assert.equal(await page.getByRole('button', { name: /^Image 1 / }).count(), 0)
  assert.equal(await page.getByRole('button', { name: /^Video video-one/ }).count(), 1)
  assert.equal(calls.filter(c => c.path === '/api/media/generate').length, 12)
  assert.equal(calls.filter(c => c.path === '/api/media/status').length, 0)
  assert.deepEqual(errors, [])
})

test('completed runtime video loads its playback link only on explicit request without regenerating', { timeout: 20000 }, async t => {
  const { page, calls, errors } = await fixture(t, async ({ path, state, route }) => {
    if (path === '/api/state') state.models.media = { jobs: [{ ...video, status: 'completed' }] }
    if (path === '/api/media/status') { await route.fulfill({ json: { ...video, status: 'completed', artifactUrl: '/fixture-video.mp4' } }); return true }
    return false
  }, { clock: true })
  await page.getByRole('button', { name: /^Video video-one/ }).click()
  await page.clock.runFor(6000)
  assert.equal(calls.filter(c => c.path.startsWith('/api/media/')).length, 0)
  await page.getByRole('button', { name: 'Load video', exact: true }).click()
  await page.locator('.media-preview video').waitFor()
  assert.equal(await page.locator('.media-preview video').getAttribute('src'), '/fixture-video.mp4')
  assert.equal(await page.locator('.media-preview video').getAttribute('preload'), 'none')
  assert.equal(await page.locator('.media-preview video').evaluate(node => node.controls), true)
  await page.getByRole('button', { name: 'Refresh playback link', exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: '/tmp/chimera-video-playback-desktop.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Refresh playback link', exact: true }).scrollIntoViewIfNeeded()
  assert.equal(await page.getByRole('button', { name: 'Refresh playback link', exact: true }).evaluate(button => {
    const rect = button.getBoundingClientRect()
    return rect.top >= 90 && rect.bottom <= document.querySelector('.statusbar').getBoundingClientRect().top
  }), true)
  await page.screenshot({ path: '/tmp/chimera-video-playback-mobile.png' })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  assert.equal(await page.locator('vite-error-overlay').count(), 0)
  assert.deepEqual(calls.filter(c => c.path === '/api/media/status').map(c => c.body), [{ jobId: 'video-one' }])
  assert.equal(calls.filter(c => c.path === '/api/media/generate').length, 0)
  assert.deepEqual(errors, [])
})

test('manual playback recovery is single-flight across navigation and cannot replace a newly selected job', { timeout: 20000 }, async t => {
  let arrived, release
  const pending = new Promise(resolve => { arrived = resolve })
  const { page, calls, errors } = await fixture(t, async ({ path, state, route }) => {
    if (path === '/api/state') state.models.media = { jobs: [{ ...video, status: 'completed' }, { ...video, jobId: 'video-two', status: 'completed' }] }
    if (path === '/api/media/status') {
      arrived(); await new Promise(resolve => { release = resolve })
      await route.fulfill({ json: { ...video, status: 'completed', artifactUrl: '/stale-video.mp4' } }); return true
    }
    return false
  })
  t.after(() => release?.())
  await page.getByRole('button', { name: /^Video video-one/ }).click()
  await page.getByRole('button', { name: 'Load video', exact: true }).evaluate(button => { button.click(); button.click() })
  await pending
  await roundTrip(page)
  assert.equal(await page.getByRole('button', { name: 'Loading video…', exact: true }).isDisabled(), true)
  await page.getByRole('button', { name: /^Video video-two/ }).click()
  assert.equal(await page.getByRole('button', { name: 'Waiting for another check…', exact: true }).isDisabled(), true)
  release()
  await page.getByRole('button', { name: 'Load video', exact: true }).waitFor()
  assert.equal(await page.getByText('Job: video-two', { exact: true }).isVisible(), true)
  assert.equal(await page.locator('.media-preview video').count(), 0)
  assert.deepEqual(calls.filter(c => c.path === '/api/media/status').map(c => c.body), [{ jobId: 'video-one' }])
  assert.deepEqual(errors, [])
})

test('failed or missing playback links remain recoverable only through explicit retry', { timeout: 20000 }, async t => {
  let checks = 0
  const { page, calls, errors } = await fixture(t, async ({ path, state, route }) => {
    if (path === '/api/state') state.models.media = { jobs: [{ ...video, status: 'completed' }] }
    if (path === '/api/media/status') {
      checks++
      await route.fulfill(checks === 1 ? { status: 503, json: { error: 'MEDIA_LINK_UNAVAILABLE' } }
        : { json: { ...video, status: 'completed', ...(checks === 3 ? { artifactUrl: '/recovered-video.mp4' } : {}) } }); return true
    }
    return false
  }, { clock: true })
  await page.getByRole('button', { name: /^Video video-one/ }).click()
  await page.getByRole('button', { name: 'Load video', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: /media link unavailable/i }).waitFor()
  await roundTrip(page)
  await page.clock.runFor(11000)
  assert.equal(checks, 1)
  await page.getByRole('button', { name: 'Load video', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: /no playback link/i }).waitFor()
  await page.getByRole('button', { name: 'Load video', exact: true }).click()
  await page.locator('.media-preview video').waitFor()
  assert.equal(await page.locator('.media-preview [role="alert"]').count(), 0)
  assert.equal(calls.filter(c => c.path === '/api/media/generate').length, 0)
  assert.equal(checks, 3)
  assert.deepEqual(errors, [])
})

test('terminal video failures show their reason and do not offer automatic regeneration', { timeout: 20000 }, async t => {
  const { page, calls, errors } = await fixture(t, async ({ path, state }) => {
    if (path === '/api/state') state.models.media = { jobs: [{ ...video, status: 'failed', error: 'MEDIA_GENERATION_FAILED' }] }
    return false
  }, { clock: true })
  await page.getByRole('button', { name: /^Video video-one/ }).click()
  const failure = page.getByRole('alert').filter({ hasText: /media generation failed/i })
  await failure.waitFor()
  assert.equal(await page.getByRole('button', { name: 'Load video', exact: true }).count(), 0)
  await page.clock.runFor(11000)
  assert.equal(calls.filter(c => c.path.startsWith('/api/media/')).length, 0)
  await failure.scrollIntoViewIfNeeded()
  await page.screenshot({ path: '/tmp/chimera-video-failure-desktop.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  await failure.scrollIntoViewIfNeeded()
  await page.screenshot({ path: '/tmp/chimera-video-failure-mobile.png' })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  assert.equal(await page.locator('vite-error-overlay').count(), 0)
  assert.deepEqual(errors, [])
})

test('video player errors offer link refresh without automatically fetching another link', { timeout: 20000 }, async t => {
  let checks = 0
  const { page, calls, errors } = await fixture(t, async ({ path, state, route }) => {
    if (path === '/api/state') state.models.media = { jobs: [{ ...video, status: 'completed' }] }
    if (path === '/api/media/status') {
      checks++
      await route.fulfill({ json: { ...video, status: 'completed', artifactUrl: `/fixture-video-${checks}.mp4` } }); return true
    }
    return false
  }, { clock: true })
  await page.getByRole('button', { name: /^Video video-one/ }).click()
  await page.getByRole('button', { name: 'Load video', exact: true }).click()
  // Native media errors do not bubble to window's uncaught-error handler.
  await page.locator('.media-preview video').dispatchEvent('error', { bubbles: false })
  await page.getByRole('alert').filter({ hasText: /could not play/i }).waitFor()
  await page.clock.runFor(6000)
  assert.equal(checks, 1)
  await page.getByRole('button', { name: 'Refresh playback link', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.media-preview video')?.getAttribute('src') === '/fixture-video-2.mp4')
  assert.equal(await page.locator('.media-preview [role="alert"]').count(), 0)
  assert.equal(checks, 2)
  assert.equal(calls.filter(c => c.path === '/api/media/generate').length, 0)
  assert.deepEqual(errors, [])
})

test('playback status must identify the requested video before changing the selected result', { timeout: 20000 }, async t => {
  const { page, calls, errors } = await fixture(t, async ({ path, state, route }) => {
    if (path === '/api/state') state.models.media = { jobs: [{ ...video, status: 'completed' }] }
    if (path === '/api/media/status') {
      await route.fulfill({ json: { ...video, jobId: 'wrong-video', status: 'completed', artifactUrl: '/wrong-video.mp4' } }); return true
    }
    return false
  })
  await page.getByRole('button', { name: /^Video video-one/ }).click()
  await page.getByRole('button', { name: 'Load video', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: /requested video/i }).waitFor()
  assert.equal(await page.getByText('Job: video-one', { exact: true }).isVisible(), true)
  assert.equal(await page.getByRole('button', { name: /^Video wrong-video/ }).count(), 0)
  assert.equal(await page.locator('.media-preview video').count(), 0)
  assert.equal(calls.filter(c => c.path === '/api/media/generate').length, 0)
  assert.deepEqual(errors, [])
})

test('automatic video status cannot substitute a different job in the selected preview', { timeout: 20000 }, async t => {
  const { page, calls, errors } = await fixture(t, async ({ path, state, route }) => {
    if (path === '/api/state') state.models.media = { jobs: [video] }
    if (path === '/api/media/status') {
      await route.fulfill({ json: { ...video, jobId: 'wrong-video', status: 'completed' } }); return true
    }
    return false
  }, { clock: true })
  await page.getByRole('button', { name: /^Video video-one/ }).click()
  await page.clock.runFor(5100)
  await page.getByRole('alert').filter({ hasText: /requested video/i }).waitFor()
  assert.equal(await page.getByText('Job: video-one', { exact: true }).isVisible(), true)
  assert.equal(await page.getByRole('button', { name: /^Video wrong-video/ }).count(), 0)
  assert.deepEqual(calls.filter(c => c.path === '/api/media/status').map(c => c.body), [{ jobId: 'video-one' }])
  assert.deepEqual(errors, [])
})

test('Save image downloads the exact selected history artifact without another API request', { timeout: 20000 }, async t => {
  let artifact = image
  const { page, calls, errors } = await fixture(t, async ({ path, route }) => {
    if (path !== '/api/media/generate') return false
    await route.fulfill({ json: artifact }); return true
  })
  await page.getByRole('textbox', { name: 'Describe the image' }).fill('First image')
  await page.getByRole('button', { name: 'Generate image', exact: true }).click()
  await page.getByRole('button', { name: /^Image 1 / }).waitFor()
  // Use a second, independently generated fixture so exporting the wrong
  // selection cannot pass a byte-equality assertion by coincidence.
  artifact = { ...image, base64: await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 4; canvas.height = 4
    const context = canvas.getContext('2d'); context.fillStyle = '#17bacb'; context.fillRect(0, 0, 4, 4)
    return canvas.toDataURL('image/png').split(',')[1]
  }) }
  await page.getByRole('textbox', { name: 'Describe the image' }).fill('Second image')
  await page.getByRole('button', { name: 'Generate image', exact: true }).click()
  await page.getByRole('button', { name: /^Image 2 / }).waitFor()
  await page.getByRole('button', { name: /^Image 1 / }).click()
  await roundTrip(page)
  const before = calls.length
  const downloaded = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Save image', exact: true }).click()
  const file = await downloaded
  assert.equal(file.suggestedFilename(), 'chimera-stability-fixture-image-1.png')
  assert.equal(await file.failure(), null)
  assert.deepEqual(await readFile(await file.path()), Buffer.from(image.base64, 'base64'))
  assert.equal(calls.length, before)
  assert.equal(calls.filter(c => c.path === '/api/media/generate').length, 2)
  assert.equal(await page.getByRole('textbox', { name: 'Describe the image' }).inputValue(), 'Second image')
  assert.deepEqual(errors, [])
})

for (const [mimeType, extension] of [['image/jpeg', 'jpg'], ['image/webp', 'webp']]) {
  test(`image export preserves ${mimeType} bytes and file extension`, { timeout: 20000 }, async t => {
    let artifact
    const { page, calls, errors } = await fixture(t, async ({ path, route }) => {
      if (path !== '/api/media/generate') return false
      await route.fulfill({ json: artifact }); return true
    })
    const dataUrl = await page.evaluate(type => {
      const canvas = document.createElement('canvas'); canvas.width = 4; canvas.height = 4
      const context = canvas.getContext('2d'); context.fillStyle = '#864ace'; context.fillRect(0, 0, 4, 4)
      return canvas.toDataURL(type)
    }, mimeType)
    assert.ok(dataUrl.startsWith(`data:${mimeType};base64,`))
    artifact = { ...image, modelId: 'stability.fixture/v1:1', mimeType, base64: dataUrl.split(',')[1] }
    await page.getByRole('textbox', { name: 'Describe the image' }).fill('Export this original')
    await page.getByRole('button', { name: 'Generate image', exact: true }).click()
    const save = page.getByRole('link', { name: 'Save image', exact: true })
    await save.waitFor()
    assert.equal(await save.getAttribute('href'), dataUrl)
    const downloaded = page.waitForEvent('download')
    await save.focus(); await save.press('Enter')
    const file = await downloaded
    assert.equal(file.suggestedFilename(), `chimera-stability-fixture-v1-1-image-1.${extension}`)
    assert.deepEqual(await readFile(await file.path()), Buffer.from(artifact.base64, 'base64'))
    assert.equal(calls.filter(c => c.path === '/api/media/generate').length, 1)
    assert.deepEqual(errors, [])
    await save.scrollIntoViewIfNeeded()
    await page.screenshot({ path: '/tmp/chimera-image-export-desktop.png' })
    await page.setViewportSize({ width: 390, height: 844 })
    await save.scrollIntoViewIfNeeded()
    await page.screenshot({ path: '/tmp/chimera-image-export-mobile.png' })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    assert.equal(await page.locator('vite-error-overlay').count(), 0)
    assert.equal(await save.evaluate(node => node.getBoundingClientRect().bottom <= document.querySelector('.statusbar').getBoundingClientRect().top), true)
  })
}

test('image export explains unsupported or missing data without offering a mislabeled download', { timeout: 20000 }, async t => {
  let artifact = { ...image, mimeType: 'image/gif' }
  const { page, calls, errors } = await fixture(t, async ({ path, route }) => {
    if (path !== '/api/media/generate') return false
    await route.fulfill({ json: artifact }); return true
  })
  await page.getByRole('textbox', { name: 'Describe the image' }).fill('Unsupported format')
  await page.getByRole('button', { name: 'Generate image', exact: true }).click()
  await page.getByText(/Image export is unavailable/).waitFor()
  assert.equal(await page.getByRole('link', { name: 'Save image', exact: true }).count(), 0)
  artifact = { ...image, base64: '' }
  await page.getByRole('button', { name: 'Generate image', exact: true }).click()
  await page.getByRole('button', { name: /^Image 2 / }).waitFor()
  assert.equal(await page.getByRole('link', { name: 'Save image', exact: true }).count(), 0)
  assert.equal(calls.filter(c => c.path === '/api/media/generate').length, 2)
  assert.deepEqual(errors, [])
})

test('Save image remains available for the selected result while another generation is pending', { timeout: 20000 }, async t => {
  let requests = 0, release, arrived
  const pending = new Promise(resolve => { arrived = resolve })
  const { page, calls, errors } = await fixture(t, async ({ path, route }) => {
    if (path !== '/api/media/generate') return false
    if (++requests === 2) { arrived(); await new Promise(resolve => { release = resolve }) }
    await route.fulfill({ json: image }); return true
  })
  t.after(() => release?.())
  await page.getByRole('textbox', { name: 'Describe the image' }).fill('First image')
  await page.getByRole('button', { name: 'Generate image', exact: true }).click()
  await page.getByRole('button', { name: /^Image 1 / }).waitFor()
  await page.getByRole('textbox', { name: 'Describe the image' }).fill('Second image')
  await page.getByRole('button', { name: 'Generate image', exact: true }).click()
  await pending
  await roundTrip(page)
  assert.equal(await page.getByRole('button', { name: 'Sending…', exact: true }).isDisabled(), true)
  const downloaded = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Save image', exact: true }).click()
  const file = await downloaded
  assert.equal(file.suggestedFilename(), 'chimera-stability-fixture-image-1.png')
  assert.deepEqual(await readFile(await file.path()), Buffer.from(image.base64, 'base64'))
  assert.equal(calls.filter(c => c.path === '/api/media/generate').length, 2)
  release()
  await page.getByRole('button', { name: /^Image 2 / }).waitFor()
  assert.deepEqual(errors, [])
})
