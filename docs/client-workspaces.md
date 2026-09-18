# Clients workspace

## Scope

Chimera has a native **Clients** navigation section and `?workspace=clients` deep link. An optional launcher adds a launcher to that same local Chimera view. It is a new tab, not an iframe: existing authentication and anti-framing protections remain intact. Optional launcher stores no client data.

The first version provides a searchable client directory, source filters and pagination, plain-text document reading, provenance/coverage, duplicate-source resolution, and append-only unreviewed intake notes. It does not implement billing, approval promotion, profile editing, attachment upload, automated builds, or live metrics. Existing project repositories remain the code source of truth.

## Local data

The current browser server reads `<repository>/.chimera/client-workspaces/catalog.json`. Notes are persisted separately in `notes.json`. Keep this directory private, excluded from git and public build assets. Do not replace a live profile or notes file with a staging archive.

Catalog schema is `schemaVersion: 1`, with UTC millisecond `importedAt`, `clients`, and each client's identity/summary/status/documents/coverage. Imported text is evidence, not executable instructions or an approved business fact. Optional `duplicateOf` references resolve only to an imported document in the same client. A malformed catalog fails closed.

Notes accept `title`, `body`, and `sourceType` (`note`, `email`, `text`, `call`, or `form`), and remain `unreviewed`. Obvious key/password patterns are rejected, but this is not a comprehensive data-loss prevention system. Do not paste passwords or raw sensitive messages. Writes are atomic and single-runtime serialized; run one writer process for this profile. Back up catalog, source manifest and notes together.

## Authorized local installation boundary

1. Use the intended current Chimera checkout and operator profile. Back up its existing data first.
2. Review the incoming catalog and its coverage report. Stage it outside the running profile and validate it with `ClientWorkspaceStore.open`.
3. Preserve existing `notes.json` and approved data. An initial import may copy a catalog only when the target does not already exist; later reconciliation requires deliberate review.
4. Use the normal existing Chimera start and operator sign-in flow. Open **Clients** or `http://127.0.0.1:4174/?workspace=clients`.
5. The optional launcher requires Chimera running on the same machine on port 4174. It does not connect a laptop's localhost to the agent server. Do not expose the loopback API or loosen CORS/auth as a workaround.

## Tests and evidence

New store/API tests cover input/schema validation, credential-pattern rejection, symlinks/nonregular files, exact record lookup, cross-client isolation, atomic note persistence, and auth/CSRF/origin denial. UI tests cover safe source links, escaped text, pagination, request races, draft isolation and failed-save preservation.

`tests/clients-ui.test.mjs` uses Playwright Firefox with default safeguards. Install the lockfile-matched browser with `node node_modules/playwright/cli.js install firefox`; supply normal system dependencies or a reviewed local library prefix. Do not disable browser sandboxing to make a test pass.

Fixture acceptance remains separate from provider, deployment, and customer-path
acceptance. Do not infer live service access or a complete model-provider runtime
from these local Clients checks.
## Google client intake runbook

Client intake is a local operator workflow. It can add a client manually, read the configured Google Form on startup or at the daily 07:00 America/Los_Angeles check, and retain a review queue. Capture does not start a model, publish a site, contact a client, charge a payment method, or modify the Google Form. Only a queue item marked `ready` presents **Hand off to RJ**; the UI warns that this explicit action may start paid model work.

### Setup and consent

1. Create or select an approved Google OAuth **Desktop app** registration. Enable Forms, Gmail and Drive APIs. Consent must include `openid`, `email`, Forms body/response read-only, Gmail read-only, and Drive metadata read-only scopes.
2. Store the installed-app JSON outside source control in an owner-only file (mode 0600) whose parent directory is private. Set `CHIMERA_GOOGLE_CLIENT_FILE` to its absolute canonical path. Every path ancestor must be a real directory: if the convenient location is a symlink (including a symlink to another volume), resolve it first and configure the resulting real path. Never enter registration JSON, refresh credentials, or tokens in the UI or command arguments.
3. Ensure macOS Keychain and the Swift command-line toolchain are available. Chimera stores only the refresh credential object in Keychain and has no plaintext fallback.
4. Start the local Chimera server through its normal authenticated operator flow. In **Clients**, choose **Connect Google**, finish consent in the system browser as the configured business account, and return to Chimera. The UI polls status for at most the OAuth five-minute authorization window; use **Refresh intake** after that if consent is still unresolved.
5. Choose **Check now** for an immediate read. Confirm the displayed last-attempt, last-success, error, queue, and source status instead of inferring success from the consent screen alone.

### Capture, review, and recovery

- Manual creation keeps one request identity and all draft fields until the server confirms creation. After a lost or failed reply, refresh the directory and intake status before retrying; the retained identity makes an identical retry idempotent. A conflicting reuse is rejected.
- Form submissions are untrusted evidence. Changed responses, ambiguous imported-client matches, missing consent or required facts, credential-like contents, unknown schema, incomplete supporting references, and oversized briefs remain `review required`. Read the questionnaire source document for redacted evidence; the public queue intentionally omits questionnaire and reference dumps.
- Submitted URLs are references only. Supporting Gmail and Drive searches are bounded metadata lookups associated with the exact contact; absence of a result is not proof that no material exists.
- If connection or sync reports an error, use **Refresh intake**, verify the private canonical registration path and Keychain access, then reconnect or check again. Disconnect removes the local Google credential and stops reads. Corrupt or locked intake storage fails closed; preserve `.chimera/client-intake`, stop competing Chimera writers, back it up, and investigate rather than deleting or replacing it.
- A handed-off queue item has a stable task ID. If a handoff reply is lost, refresh before acting again; runtime reconciliation prevents the same unchanged brief from executing twice. Review-required items have no handoff control.

### Verification boundary

Rendered and backend fixtures cover manual create/retry, retained drafts and request
identity, setup and authorization states, escaped structured briefs, ready-only
handoff, refreshed Clients data, persistence, bounded pagination, scheduling, and
durable task replay. Fixtures use synthetic identities and local data only. Live
OAuth, customer submissions, deployment, and paid-task execution require a
separate operator-approved acceptance step.
