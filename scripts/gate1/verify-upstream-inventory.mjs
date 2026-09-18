import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  extractDshToolCatalog,
  loadDshEffectInventory,
} from '../../src/dsh/effect-inventory.mjs'

const executeFile = promisify(execFile)
const repositoryPath = resolve(process.argv[2] ?? '../deepseek-harness-upstream')
const inventory = await loadDshEffectInventory()
const { stdout } = await executeFile('git', ['-C', repositoryPath, 'rev-parse', 'HEAD'])
const revision = stdout.trim()
if (revision !== inventory.upstreamCommit) {
  throw new Error(`DSH_REVISION_MISMATCH expected=${inventory.upstreamCommit} actual=${revision}`)
}

const catalogMarkdown = await readFile(resolve(repositoryPath, 'docs/tool-catalog.md'), 'utf8')
const upstreamTools = extractDshToolCatalog(catalogMarkdown)
const inventoryTools = inventory.catalogTools()
if (JSON.stringify(upstreamTools) !== JSON.stringify(inventoryTools)) {
  const inventorySet = new Set(inventoryTools)
  const upstreamSet = new Set(upstreamTools)
  throw new Error(JSON.stringify({
    error: 'DSH_TOOL_CATALOG_DRIFT',
    missingFromInventory: upstreamTools.filter((tool) => !inventorySet.has(tool)),
    absentUpstream: inventoryTools.filter((tool) => !upstreamSet.has(tool)),
  }))
}

process.stdout.write(`${JSON.stringify({
  status: 'passed',
  revision,
  ...inventory.auditCoverage(),
})}\n`)
