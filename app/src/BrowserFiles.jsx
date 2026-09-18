import { useEffect, useRef, useState } from 'react'
import { api, post } from './api.js'

async function fileCommand(body) {
  const result = await post('/api/browser/files', body)
  if (result.status === 'denied') throw new Error(result.reason ?? 'BROWSER_FILE_ACCESS_DENIED')
  return result.output ?? result.result ?? result
}

export function BrowserFiles({ humanControl, notify }) {
  const [files, setFiles] = useState({ downloads: [] })
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const input = useRef(null)
  useEffect(() => {
    if (!humanControl || !open) return
    let stopped = false
    let timer
    const refresh = async () => {
      try {
        const result = await api('/api/browser/files')
        if (result.status === 'denied') throw new Error(result.reason)
        if (!stopped) setFiles(result.result ?? result)
      }
      catch (error) { if (!stopped) notify(error.message.replaceAll('_', ' ').toLowerCase()) }
      if (!stopped) timer = setTimeout(refresh, 3000)
    }
    void refresh()
    return () => { stopped = true; clearTimeout(timer) }
  }, [humanControl, open, notify])
  if (!humanControl) return null
  const upload = async (selected) => {
    setBusy(true)
    try {
      if (!selected.length || selected.length > 8 || selected.reduce((size, file) => size + file.size, 0) > 8 * 1024 * 1024) throw new Error('Choose up to 8 files, at most 8 MiB total')
      const encoded = await Promise.all(selected.map((file) => new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onerror = () => reject(new Error('FILE_READ_FAILED'))
        reader.onload = () => resolve({ name: file.name, mimeType: file.type || 'application/octet-stream', base64: String(reader.result).split(',')[1] })
        reader.readAsDataURL(file)
      })))
      await fileCommand({ command: 'upload-files', files: encoded })
      notify('Selected files delivered to the website')
    } catch (error) { notify(error.message.replaceAll('_', ' ').toLowerCase()) }
    finally { setBusy(false); if (input.current) input.current.value = '' }
  }
  const download = async (id) => {
    setBusy(true)
    try {
      const file = await fileCommand({ command: 'download-file', downloadId: id })
      const bytes = Uint8Array.from(atob(file.base64), (character) => character.charCodeAt(0))
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }))
      const link = document.createElement('a')
      link.href = url; link.download = file.name; link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (error) { notify(error.message.replaceAll('_', ' ').toLowerCase()) }
    finally { setBusy(false) }
  }
  return <div className="browser-files">
    <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>Uploads & downloads</button>
    {open ? <div className="browser-files-panel">
      <p>Click a website’s upload control first, then choose files here. Up to 8 MiB per upload. Downloads up to 25 MiB; newest 5 retained for this browser session.</p>
      <input ref={input} aria-label="Upload to active website" type="file" multiple={files.upload?.multiple} disabled={busy || !files.upload?.pending} onChange={(event) => void upload([...event.target.files])} />
      <span>{files.upload?.pending ? 'Website is waiting for files' : 'No upload requested by the website'}</span>
      {(files.downloads ?? []).map((file) => <div key={file.id}><span>{file.name} · {file.status}</span><button type="button" disabled={busy || file.status !== 'ready'} onClick={() => void download(file.id)}>Save to my computer</button></div>)}
    </div> : null}
  </div>
}
