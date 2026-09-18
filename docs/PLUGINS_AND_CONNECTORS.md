# Chimera Plug-ins and Connectors

Chimera uses one extension contract for both plug-ins and connectors:

- a **plug-in** adds local skills, workflows, UI contributions, or Harness tools;
- a **connector** adds an authenticated boundary to an external service;
- both declare their identity, version, entrypoint, authentication mode, exact network hosts, and every tool capability before installation;
- installation is disabled by default and grants no authority by itself;
- enabling a tool still requires an agent access profile, a matching human-signed grant, a DSH policy decision, and signed confirmation for consequential effects.

The manifest schema is `chimera.extension-manifest.v1`. The validator lives in `src/extensions/manifest.mjs` and rejects wildcard hosts, undeclared tools, duplicate tool names, unsafe entrypoints, and unsupported authentication modes.

Example:

```json
{
  "schema": "chimera.extension-manifest.v1",
  "id": "customer-crm",
  "displayName": "Customer CRM",
  "version": "1.0.0",
  "kind": "connector",
  "entrypoint": "./connector.mjs",
  "authentication": "oauth",
  "networkHosts": ["api.example.com"],
  "tools": [
    {
      "name": "crm_contact_read",
      "capability": "crm.read",
      "tier": "auto"
    },
    {
      "name": "crm_contact_update",
      "capability": "crm.write",
      "tier": "confirm"
    }
  ]
}
```

## Built-in GitHub connector

The V1 pilot includes a first-party GitHub PR connector without enabling the
general third-party loader. It uses the server's `gh` OAuth keychain, a bounded
`CHIMERA_GITHUB_REPOSITORIES` allowlist, a sanitized child-process environment,
and five explicit Harness tools: PR create, update, comment, check inspection,
and exact-head-SHA merge.

Connected agents receive only read-only check inspection. Live agents may
request the four consequential operations, which still pass through the DSH
inventory, signed grant, policy tier, and human decision queue. OAuth token
values are never projected into browser state, worker context, or audit facts.
This connector is trusted application code; it does not weaken the rule that
arbitrary manifest entrypoints remain non-executable until stages 2–4 below.

## Delivery stages

1. **Manifest contract — implemented.** Validate bounded identity, version, entrypoint, authentication, hosts, tools, capabilities, and risk tiers. Project the extension as disabled.
2. **Signed local catalog — next.** Persist installation records, file hashes, signer identity, enabled state, and assigned agents.
3. **Isolated loader — next.** Start the extension outside the main process with an RPC boundary and no ambient credentials.
4. **Authentication broker — next.** Store OAuth/API-key material outside agent workspaces and issue narrowly scoped connector calls.
5. **UI marketplace — later.** Inspect requested authority before install, enable, update, or removal.

Until stages 2–4 are implemented, a valid manifest is a safe package description, not an executable or connected extension. Chimera must not dynamically import an untrusted entrypoint into the main browser/runtime process.
