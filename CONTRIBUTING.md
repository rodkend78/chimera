# Contributing to Chimera

Thank you for helping improve the Chimera source beta. Contributions should
keep the local pilot's authorization, default-deny, loopback, authentication,
and replay-protection boundaries intact. Read the [README](README.md) and the
[security model](docs/SECURITY_MODEL.md) before changing a boundary.

## Development setup

Use a clean checkout and the committed lockfile:

```sh
npm ci
npx playwright install chromium firefox
npm test
npm run build
```

The optional `npm run pilot:ade-acceptance` check uses disposable local
fixtures. Provider accounts, AWS resources, Google accounts, browser profiles,
Hermes data, and live customer data are not required for tests. Keep `.env`,
`.chimera/`, `app/dist/`, `node_modules/`, credentials, and private keys out of
commits.

## Changes and pull requests

- Explain the user-visible behavior and the security boundary affected by the
  change. Keep patches bounded and preserve existing public interfaces unless a
  change is explicitly discussed.
- Add a focused regression test for new behavior or a fixed failure. Run the
  focused test while iterating, then run the full `npm test` suite and
  `npm run build` before requesting review.
- Run `npm audit --omit=dev` when dependency files change. Update
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) when the lockfile adds,
  removes, or changes a package license or version.
- Do not add real endpoints, account identifiers, hostnames, form IDs, bucket
  names, personal paths, secrets, tokens, customer data, screenshots, or
  provider output. Use reserved example domains and synthetic identities.
- Keep generated bundles, `node_modules`, runtime state, and deployment
  artifacts out of source changes. The source beta does not publish an npm
  package or a prebuilt application bundle.
- Use a descriptive commit or pull-request title and include the exact checks
  run, skipped checks, and any provider or platform limitation.

Pull requests are reviewed before merge. A passing test suite does not by
itself establish production isolation, cloud durability, provider access, or
complete operating-system parity.

## Licensing

Original Chimera work is licensed under the Apache License 2.0. By submitting a
contribution, you agree that it may be distributed under that license unless a
separate written agreement says otherwise. Do not copy third-party source into
the repository without retaining its license and required attribution. See
[LICENSE](LICENSE), [NOTICE](NOTICE), and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Reporting a vulnerability

Do not open a public issue for a suspected security vulnerability. Follow
[SECURITY.md](SECURITY.md) and use GitHub's private vulnerability-reporting
channel instead.
