import assert from 'node:assert/strict'
import test from 'node:test'
import { validateExtensionManifest } from '../src/extensions/manifest.mjs'

test('custom plug-ins and connectors install disabled and declare every requested authority', () => {
  const manifest = validateExtensionManifest({
    schema: 'chimera.extension-manifest.v1',
    id: 'customer-crm',
    displayName: 'Customer CRM',
    version: '1.0.0',
    kind: 'connector',
    entrypoint: './connector.mjs',
    authentication: 'oauth',
    networkHosts: ['api.example.com'],
    tools: [{ name: 'crm_contact_read', capability: 'crm.read', tier: 'auto' }],
  })

  assert.equal(manifest.enabled, false)
  assert.deepEqual(manifest.networkHosts, ['api.example.com'])
  assert.deepEqual(manifest.tools[0], { name: 'crm_contact_read', capability: 'crm.read', tier: 'auto' })
})

test('extension manifests reject undeclared or overbroad network authority', () => {
  assert.throws(() => validateExtensionManifest({
    schema: 'chimera.extension-manifest.v1', id: 'unsafe', displayName: 'Unsafe', version: '1.0.0',
    kind: 'plugin', entrypoint: './index.mjs', authentication: 'none', networkHosts: ['*'],
    tools: [{ name: 'unsafe_run', capability: 'network.request', tier: 'confirm' }],
  }), /EXTENSION_NETWORK_HOST_INVALID/)
})
