import { readFile, lstat, realpath } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { runNativeHost } from '../../src/account-browser/host.mjs'
import { EXPECTED_ORIGIN } from '../../src/account-browser/identity.mjs'

try {
  if (process.argv[2] !== EXPECTED_ORIGIN) throw new Error('Origin denied')
  const path = fileURLToPath(new URL('../../runtime.json', import.meta.url))
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) || await realpath(path) !== path) throw new Error('Unsafe configuration')
  const config = JSON.parse(await readFile(path, 'utf8'))
  if (config.schema !== 1 || config.allowedOrigin !== EXPECTED_ORIGIN) throw new Error('Invalid configuration')
  await runNativeHost({ input: process.stdin, output: process.stdout, origin: process.argv[2], allowedOrigin: EXPECTED_ORIGIN, socketPath: config.socketPath })
} catch { process.stderr.write('Chimera companion unavailable. Check explicit setup and runtime.\n'); process.exitCode = 1 }
