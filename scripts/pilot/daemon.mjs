import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))
process.chdir(root)
await import('./start.mjs')
