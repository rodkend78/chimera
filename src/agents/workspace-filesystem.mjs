import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const helper = fileURLToPath(new URL('./workspace-filesystem.py', import.meta.url))

export async function workspaceFilesystem(workspace, request) {
  // The root is runtime-owned; no agent-controlled descendant is canonicalized
  // here. The broker opens all of those relative to held directory descriptors.
  const root = await realpath(workspace.path)
  const protectedPaths = (workspace.protectedWriteRoots ?? []).map(path => {
    const value = relative(root, resolve(path))
    if (value === '' || value.startsWith(`..${sep}`) || value === '..') throw new Error('WORKER_WRITE_PROTECTED')
    return value.split(sep)
  })
  return new Promise((resolvePromise, reject) => {
    const child = execFile('/usr/bin/python3', ['-I', '-B', helper], {
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout) => {
      if (error) return reject(Object.assign(new Error('WORKER_FILESYSTEM_UNAVAILABLE'), { code: 'WORKER_FILESYSTEM_UNAVAILABLE' }))
      try {
        const result = JSON.parse(stdout)
        if (result.error) throw Object.assign(new Error(result.error), { code: result.error })
        resolvePromise(result.result)
      } catch (error) { reject(error) }
    })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify({ ...request, root, protected: protectedPaths }))
  })
}
