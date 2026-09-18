const ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const TOOL = /^[a-z][a-z0-9_]{0,63}$/
const CAPABILITY = /^[a-z][a-z0-9.-]{0,127}$/
const ENTRYPOINT = /^\.\/(?!.*(?:^|\/)\.\.\/)[A-Za-z0-9_./-]+\.mjs$/
const HOST = /^(?=.{1,253}$)(?!-)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

function bounded(value, maximum) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function fail(code) {
  throw new TypeError(code)
}

export function validateExtensionManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schema !== 'chimera.extension-manifest.v1'
    || !ID.test(value.id ?? '')
    || !bounded(value.displayName, 128)
    || !/^\d+\.\d+\.\d+$/.test(value.version ?? '')
    || !['plugin', 'connector'].includes(value.kind)
    || !ENTRYPOINT.test(value.entrypoint ?? '')
    || !['none', 'oauth', 'api-key', 'aws-iam'].includes(value.authentication)) {
    fail('EXTENSION_MANIFEST_INVALID')
  }
  if (!Array.isArray(value.networkHosts) || value.networkHosts.length > 32
    || value.networkHosts.some((host) => !HOST.test(host))) fail('EXTENSION_NETWORK_HOST_INVALID')
  if (!Array.isArray(value.tools) || value.tools.length === 0 || value.tools.length > 64) fail('EXTENSION_TOOLS_INVALID')
  const names = new Set()
  const tools = value.tools.map((tool) => {
    if (!tool || typeof tool !== 'object' || !TOOL.test(tool.name ?? '') || names.has(tool.name)
      || !CAPABILITY.test(tool.capability ?? '') || !['auto', 'confirm', 'blocked'].includes(tool.tier)) {
      fail('EXTENSION_TOOL_INVALID')
    }
    names.add(tool.name)
    return { name: tool.name, capability: tool.capability, tier: tool.tier }
  })
  return Object.freeze(structuredClone({
    schema: 'chimera.extension-manifest.v1',
    id: value.id,
    displayName: value.displayName,
    version: value.version,
    kind: value.kind,
    entrypoint: value.entrypoint,
    authentication: value.authentication,
    networkHosts: [...new Set(value.networkHosts)],
    tools,
    enabled: false,
  }))
}
