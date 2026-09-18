# Security policy

Chimera 0.1.x is a source beta and local single-operator pilot. It is not a
production security boundary. The host, browser, provider accounts, cloud
roles, and configured connectors remain in scope for the operator's own threat
model. Do not place production secrets, credentials, customer data, or live
provider output in this repository or in an issue.

## Reporting a vulnerability

Please report suspected vulnerabilities privately through the repository's
GitHub security advisory form:

<https://github.com/rodkend78/chimera/security/advisories/new>

If private reporting is unavailable, do not publish exploit details. Open a
minimal issue asking the maintainers to enable private reporting, without
including a proof of concept, secret, endpoint credential, personal path, or
customer data.

Include only the information needed to reproduce the issue safely: affected
version or commit, platform, prerequisites, a redacted reproduction, impact,
and a suggested mitigation. Remove tokens, cookies, private URLs, account or
instance identifiers, local paths, browser profiles, and task contents before
submitting. The maintainers will acknowledge reports through GitHub and will
coordinate disclosure after a fix is available; no response or remediation
timeframe is guaranteed for this beta.

## Security boundaries

The source is designed to preserve loopback-only binding, authenticated
operator API mutations, default-deny policy, signed actions, grant windows,
approval challenge binding, and replay protection. These controls do not make a
compromised host or an incorrectly configured provider safe. See
[docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md) for the implemented boundary
and its explicit out-of-scope items.

Dependency reports should use the exact lockfile versions and the notices in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Do not attach `node_modules`,
`.env`, `.chimera`, generated bundles, or scanner output containing secret
values to a public issue or pull request.
