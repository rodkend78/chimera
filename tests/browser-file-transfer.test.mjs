import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChromiumBrowserExecutor } from '../src/browser/executor.mjs'

test('real Chromium transfers selected browser uploads and bounded download artifacts', async () => {
  const profileDir = await mkdtemp(join(tmpdir(), 'chimera-browser-files-test-'))
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end(`<input type="file" id="file" style="position:absolute;top:20px;left:20px;width:200px;height:40px"><pre id="result"></pre>
      <button id="download" style="position:absolute;top:100px;left:20px;width:200px;height:40px">Download</button>
      <script>
      document.querySelector('#file').onchange=async(e)=>document.querySelector('#result').textContent=e.target.files[0].name+':'+await e.target.files[0].text();
      document.querySelector('#download').onclick=()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['download evidence']));a.download='evidence.txt';a.click()};
      </script>`)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const executor = new ChromiumBrowserExecutor({ profileDir })
  try {
    await executor.start()
    // Existing narrow callback exception permits this ephemeral loopback test fixture.
    const url = `http://127.0.0.1:${server.address().port}/auth/callback`
    executor.allowTemporaryNavigation(url)
    await executor.navigate(url)
    await assert.rejects(executor.uploadFiles([{ name: 'test.txt', mimeType: 'text/plain', base64: 'aGk=' }]), /BROWSER_FILE_CHOOSER_REQUIRED/)
    await executor.humanInput({ type: 'click', x: 60, y: 40 })
    for (let attempts = 0; attempts < 100 && !executor.browserFiles().upload.pending; attempts += 1) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(executor.browserFiles().upload.pending, true)
    assert.equal(executor.browserFiles().upload.multiple, false)
    assert.deepEqual(await executor.uploadFiles([{ name: 'test.txt', mimeType: 'text/plain', base64: Buffer.from('uploaded evidence').toString('base64') }]), { uploaded: true, count: 1 })
    assert.equal(executor.browserFiles().upload.pending, false)
    for (let attempts = 0; attempts < 100 && !(await executor.read()).text.includes('test.txt:uploaded evidence'); attempts += 1) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.match((await executor.read()).text, /test.txt:uploaded evidence/)
    await executor.humanInput({ type: 'click', x: 60, y: 120 })
    for (let attempts = 0; attempts < 100 && !executor.browserFiles().downloads.some((item) => item.status === 'ready'); attempts += 1) await new Promise((resolve) => setTimeout(resolve, 10))
    const item = executor.browserFiles().downloads[0]
    assert.equal(item.status, 'ready', JSON.stringify(item))
    const file = executor.downloadFile(item.id)
    assert.equal(file.name, 'evidence.txt')
    assert.equal(Buffer.from(file.base64, 'base64').toString(), 'download evidence')
    assert.equal(file.bytes, 17)
    assert.throws(() => executor.downloadFile('../../secret'), /BROWSER_DOWNLOAD_NOT_FOUND/)
  } finally {
    await executor.suspend()
    await new Promise((resolve) => server.close(resolve))
    await rm(profileDir, { recursive: true, force: true })
  }
})
