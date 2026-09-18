# Selected Hermes snapshot imports

Use `CHIMERA_HERMES_SNAPSHOT_FILE` with an absolute path to an owner-only local
snapshot when migrating a selected team. It takes precedence over the S3 reference
provider. An invalid snapshot fails closed; it does not fall back to cloud or stale
profiles. Existing discovery and registry import interfaces are unchanged.

The snapshot is private runtime data, not repository content:

```json
{
  "schema": "chimera.hermes-snapshot.v1",
  "entries": [
    { "key": "ace/SOUL.md", "content": "<canonical base64>", "sha256": "<64 lowercase hex characters>" }
  ]
}
```

Keys are relative to the profiles directory. Select approved profiles explicitly.
Include only current persona documents, bounded memories, and skill definitions.
Do not export `.env`, provider configuration, credentials, browser sessions,
private keys, authority grants, transient state, or executable skill assets.
Do not follow symbolic links by default. Record omissions separately. Inspect
content before transfer: automated secret filters are not a comprehensive secret
scanner. A self-contained hash validates integrity, not source authenticity.

The reader rejects symlink files, oversized documents, duplicate/unsafe keys,
noncanonical base64 and digest mismatches. The existing Hermes materializer
also applies per-layer size limits, filename/content filters, and cross-agent
reference validation. Keep snapshots and parent directories owner-only.

On startup, worker capsules are rebuilt from this snapshot without cloud
credentials. They do not automatically refresh from Hermes: create a fresh
selected export, verify source hashes and exclusions, then replace it at an idle
boundary and restart. Never overlay a stale backup tree onto a current export.

Persona/memory content and skill definitions are continuity data. Their presence
does not install referenced tools or prove Linux compatibility. Model pins,
provider authentication and task grants are configured separately on the new
workstation. Verify an actual delegated task and restart before calling the
migration operational.
