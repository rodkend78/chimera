# Chimera Browser Interaction Contract

**Status:** Accepted for implementation
**Date:** 2026-08-22

## Product behavior

Chimera's browser is part of the workspace, not a detached automation console.
It should feel like the browser surface in Codex Desktop while adding persistent
agent sessions and explicit human-agent control handoff.

An agent can:

- open, close, activate, and reorder tabs;
- navigate, search, click, scroll, type, and read rendered pages;
- upload and download files when policy permits;
- preserve its authenticated browser profile and workspace between tasks;
- ask a human to take over for login, CAPTCHA, enrollment, payment, or judgment;
- continue from the same tabs after control returns.

A human can:

- watch the agent work live;
- inspect the tab strip, URL, activity, and pending decisions;
- take control immediately without terminating the agent or losing session state;
- use the browser normally, including opening and managing tabs;
- return control to the agent at the same page and browser state;
- open the session in a larger dedicated window when needed.

## Control model

Many authorized viewers may observe a session, but exactly one actor owns input.
The initial owner is the assigned agent.

```text
AGENT_CONTROL
  -- human takes control --> HUMAN_CONTROL

HUMAN_CONTROL
  -- same human returns control --> AGENT_CONTROL
```

While a human owns input:

- agent pointer, keyboard, navigation, and tab commands are rejected;
- the agent may continue reasoning, reading approved activity events, and
  preparing a proposed next step;
- the agent may not inject input through a second protocol path;
- queued actions must be revalidated after control returns;
- the active controller is always visible in the interface.

Control transitions, tab changes, navigation, uploads, downloads, and policy
decisions enter the Chimera activity stream. Sensitive values are redacted
before activity projection.

## Session and tab ownership

- Each browser session belongs to exactly one agent or explicitly shared domain.
- Tabs belong to that session and do not leak into another agent's profile.
- One persistent profile may not be mounted by two running browser containers.
- Suspending a session preserves tab metadata, cookies, permitted storage, and
  workspace state, then stops paid compute.
- Resuming restores the session into a fresh isolated executor with the same
  Chimera session identity.
- Closing the final tab creates a blank tab rather than destroying the session.

## Policy boundary

Viewing and input ownership do not confer authorization. Agent browser effects
still pass through the Chimera gateway. Human browser input is attributed and
audited. Ordinary direct human browsing does not require the agent's grant: when
the signed human action has no matching agent-policy rule, the gateway records a
`human-browser-control` override and permits the browser operation. Explicit
browser blocks and ambiguous policy matches still deny, and the executor's
network safety guard remains in force for every actor.

The browser adapter must classify at least:

- navigation and cross-domain redirects;
- typing into ordinary, sensitive, and credential fields;
- form submission and external messages;
- uploads, downloads, clipboard reads, and clipboard writes;
- purchases, financial actions, account changes, and destructive actions;
- private-network, localhost, metadata-service, and link-local destinations;
- CAPTCHA, MFA, OAuth consent, and account enrollment.

Passwords, passkeys, payment authorization, CAPTCHA, and personal enrollment are
human-only interactions in the pilot. Private-network and cloud metadata access
are blocked at both policy and network layers.

## Runtime boundary

### Native account-browser addition

Normal account authentication is not established by the existing automated
Chromium takeover tests. A supported Chrome window, explicit selected-tab
sharing and human-only sign-in are separate from the isolated agent browser.
The existing isolated browser contract remains in force; do not interpret the
account path as automatic permission to share personal browser sessions with agents.

For the implemented human-only path, choose **Browser → My accounts → Open
Chrome**. The dedicated launcher uses `<repo>/.chimera/account-browser/chrome`
as its persistent, owner-only user-data directory (Chimera Work). It requests a
new app instance instead of routing into an already-running automation browser.
No remote-debugging or automation flags are supplied. No other browser's profile,
cookies or sessions are imported; sign in personally in the new instance.
Unsafe or redirected storage is refused before Chrome dispatch, without an
automatic retry. A same-OS-user process can still access this directory; this
is separation from accidental browser reuse, not an OS-user security sandbox.

Pairing and account acceptance in a supported Chrome profile require separate
human verification. Supervised interaction and Focus tab UX remain future work;
the initial companion slice exposes visible-text reads only.

### Explicit companion setup and use

These are future human acceptance instructions, not live actions performed by
the fixture suite. Default config: `<repo>/.chimera/account-browser/install/runtime.json`;
socket: `<repo>/.chimera/account-browser/bridge.sock`. Native-host registration
for Chimera Work belongs in `<repo>/.chimera/account-browser/chrome/NativeMessagingHosts`,
not the standard Chrome directory or RJ's automated browser directory. The socket directory must
already exist, be canonical and owner-only (0700). Both explicit setup destination
parents must exist.

The normal repository server discovers only the config at that fixed repository
location. An arbitrary `--destination` prepares a portable package but is **not
auto-discovered** by that server; `runtimeConfigPath` in CLI output is a returned
file path, not a supported runtime configuration override.

Substitute canonical absolute paths and the real Node executable:

```sh
node scripts/account-browser/setup.mjs prepare \
  --destination /absolute/repo/.chimera/account-browser/install \
  --host-manifest-dir /absolute/repo/.chimera/account-browser/chrome/NativeMessagingHosts \
  --node-path /absolute/path/to/node \
  --socket-path /absolute/repo/.chimera/account-browser/bridge.sock
```

Use `dry-run` instead of `prepare` to preview paths without installation. Preparation
copies the self-contained host package and returns `extensionPath`. Create the
canonical `chrome` parent with owner-only 0700 permissions before preparation.
For an existing standard-path installation, stop Chimera explicitly, use the
validated receipt uninstall command below, and prepare with the new manifest
location. Never manually overwrite the receipt or copy browser profile contents.
Restart Chimera and launch **My accounts → Open Chrome**. In that dedicated
instance, open `chrome://extensions`, enable Developer mode and Load unpacked
at that path. Verify fixed ID `pfaemhmnhfolpknkdecobnpppgipnegm`. Config cannot choose
another allowed origin. Explicitly start/restart the accepted runtime after preparation.
No config means **Companion not installed**, with no listener. Invalid config or any
existing socket means **Companion unavailable**; no stale socket is silently deleted.

1. Request pairing in Chrome. In **My accounts**, Refresh sharing and compare the exact
   **Pairing ID** with the one labelled **Pairing ID** in that popup. Approve only a
   matching request, then Finish pairing in Chrome. Profile IDs alone do not distinguish
   pending connections. The challenge stays in the popup, never the operator UI/audit.
   Pairing grants no tab access.
2. Ask an actively assigned connected/live Hermes participant to read your shared page.
   `mcp__chimera_account__await_share` accepts exactly `{}` and waits once for at most
   60 seconds, further bounded by parent authority/task lifetime. In Chrome choose the
   named task/agent, acknowledge the visible-text warning and Share this tab. A
   `no-share-timeout` requires a new explicit task/tool action; there is no background resumption.
   A share is initially reserved, not readable. After final document inspection and
   local cache installation, the companion sends its document-bound ready acknowledgement.
   The broker audits/persists metadata and rechecks current signed authority before
   publishing the lease. Reservations expire after ten seconds (or earlier parent expiry)
   and count toward the 128-lease cap. An abandoned/failed handshake never retries a read.
3. The worker receives only its committed lease metadata. `mcp__chimera_account__read`
   accepts exactly `{leaseId}` through DSH/gateway capability `browser.account.read`;
   waiting uses `browser.account.wait`. There is no HTTP page-text endpoint. Shared text
   goes to the agent's configured model/provider, which may be remote; sharing does not
   guarantee that page content stays on this Mac. Raw bounded, redacted observations
   stay transient in that worker's loop. Generic checkpoints and dispatcher results
   retain metadata only. Model-authored summaries persist normally and may contain
   page facts or quotations; this is not perfect PII filtering. Revocation
   cannot remove information already observed. Page content remains untrusted evidence.
4. Stop sharing or Revoke pairing in My accounts, or Stop in Chrome. Navigation,
   closure/replacement, disconnect, cancellation, expiry and restart invalidate leases.
   Refresh explicitly; no auto-approval. Sign-in, MFA, recovery, consent, payment and CAPTCHA stay human-only.

Stopping a participant also immediately closes its read admission. In this first
slice that action conservatively revokes all companion shares for its current task,
including other participants' shares; any further sharing must be explicit.
Runtime shutdown also fences immediately. If companion metadata persistence fails,
the runtime still completes its remaining approval, decision, task, browser, store,
auth and audit cleanup attempts before reporting the collected error.

For uninstall, revoke sharing/pairing, close the accepted runtime explicitly, remove
the extension through Chrome, then run:

```sh
node scripts/account-browser/setup.mjs uninstall --receipt-path /absolute/repo/.chimera/account-browser/install/receipt.json
```

Only unchanged recorded installer files are removed. Foreign/edited files cause refusal;
Chrome profiles are untouched. The companion setup and fixture checks are separate
rollout gates. Passing local fixtures does not establish supported Chrome extension
loading, pairing, or account acceptance.

The first adapter targets OpenBot-compatible browser-computer semantics:
isolated Chromium, Playwright automation, a persistent profile/workspace, live
screen transport, and human takeover. Chimera owns the session API, control
lease, policy checks, audit events, and product UI.

The runtime may change later without changing this contract.
