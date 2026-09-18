import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from 'vite'

const configFile = fileURLToPath(new URL('../app/vite.config.js', import.meta.url))
const repositoryRoot = resolve(fileURLToPath(new URL('../app', import.meta.url)), '..')
const copyPlugin = 'chimera-copy-agentcore-dcv-assets'

test('file URL conversion decodes spaces in config paths', () => {
  const spacedConfig = new URL('file:///tmp/chimera%20release/app%20with%20spaces/vite.config.js')
  assert.equal(fileURLToPath(spacedConfig), '/tmp/chimera release/app with spaces/vite.config.js')
})

test('client build reads the repository-level env contract', async () => {
  const config = await resolveConfig({ configFile, logLevel: 'silent' }, 'build')
  assert.equal(config.envDir, repositoryRoot)
})

test('development server resolution excludes the production asset-copy close hook', async () => {
  const config = await resolveConfig({ configFile, logLevel: 'silent' }, 'serve')
  assert.equal(config.plugins.some(plugin => plugin.name === copyPlugin), false,
    'closing a dev or rendered-fixture server must not copy into the served production output')
})

test('production build resolution retains exactly one DCV asset-copy hook', async () => {
  const config = await resolveConfig({ configFile, logLevel: 'silent' }, 'build')
  const plugins = config.plugins.filter(plugin => plugin.name === copyPlugin)
  assert.equal(plugins.length, 1)
  assert.equal(typeof plugins[0].closeBundle, 'function')
})
