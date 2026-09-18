import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'

const execFileAsync = promisify(execFile)

function boundedName(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(value)
}

const [name, entryArg] = process.argv.slice(2)
if (!boundedName(name) || typeof entryArg !== 'string' || entryArg.length === 0) {
  throw new TypeError('usage: bundle-lambda.mjs <artifact-name> <entry-file>')
}

const root = resolve(new URL('../..', import.meta.url).pathname)
const entry = resolve(root, entryArg)
const outputDirectory = join(root, '.chimera', 'gate2-artifacts')
const temporaryDirectory = await mkdtemp(join(tmpdir(), `chimera-${name}-`))
const bundled = join(temporaryDirectory, 'index.js')
const temporaryZip = join(temporaryDirectory, `${name}.zip`)

try {
  await build({
    bundle: true,
    entryPoints: [entry],
    format: 'cjs',
    legalComments: 'none',
    minify: false,
    outfile: bundled,
    platform: 'node',
    target: 'node22',
  })
  await execFileAsync('zip', ['-q', '-j', temporaryZip, bundled])
  const archive = await readFile(temporaryZip)
  const digest = createHash('sha256').update(archive).digest('hex')
  const filename = `${name}-${digest}.zip`
  await mkdir(outputDirectory, { recursive: true })
  const outputPath = join(outputDirectory, filename)
  await rename(temporaryZip, outputPath)
  process.stdout.write(`${JSON.stringify({
    name,
    entry: basename(entry),
    path: outputPath,
    key: `gate2/${filename}`,
    sha256: digest,
  })}\n`)
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true })
}
