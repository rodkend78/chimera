# Chimera 0.1.0-beta.1

Chimera is a local, model-independent agent workspace and authorization control
plane. It gives a human a bounded delegation surface, lets agents propose
actions, classifies those actions as `auto`, `confirm`, or `blocked`, and keeps
the resulting decisions in a tamper-evident audit chain. The beta also includes
a local Chromium workspace with agent tabs, live streaming, human takeover, a
durable task queue, project workspaces, and optional model and worker adapters.

This is a source beta for evaluation and development. It is a local,
single-operator pilot, not a production security boundary, hosted service,
Hermes replacement, DeepSeek Harness fork, Telegram bot, or claim of complete
platform parity. Do not use it for production secrets, regulated workloads,
customer data, or unattended high-impact actions.

The original Chimera work is licensed under the Apache License 2.0. Third-party
dependencies retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
and [NOTICE](NOTICE).

## Beta scope

The checked-in source demonstrates:

- Ed25519 human and agent identities, expiring grants, exact resource scopes,
  replay protection, default-deny policy, one-time approvals, and a chained
  local audit log.
- A React/Vite workspace backed by Playwright Chromium, persistent local tabs,
  accessibility snapshots, signed navigation checks, and an explicit human
  control lease.
- A bounded CEO queue with signed handoffs, specialist attribution, durable
  checkpoints, explicit task continuation, and safe interruption on restart.
- ADE project registration, task-isolated workspaces, short-lived access leases,
  digest-bound review, and an explicit commit boundary.
- Optional Codex, AWS Bedrock Runtime, AWS Bedrock Mantle, Antigravity, Google
  intake, Hermes discovery, RJ AWS, TypeSafe Jev, and media adapters. These connectors are
  opt-in and disabled or denied when their required configuration is absent.

The browser, model, cloud, and connector adapters have different trust and
availability boundaries. Passing the local fixture suite does not establish
provider access, billing, account sign-in, production isolation, or parity with
another operating system.

## Prerequisites

The supported pilot hosts are macOS and Linux. The managed lifecycle command
supports Darwin and Linux; other platforms are not a tested parity target.

Install the following before starting:

- Node.js 22.19.0 or newer, with npm.
- Python 3.9 or newer at `/usr/bin/python3`. Worker filesystem operations use
  its POSIX descriptor-relative APIs and fail closed if this broker is unavailable.
- Git, when using the Projects workspace with a repository.
- Playwright Chromium, installed for the current user with the command below.
- Playwright Firefox as well when running the complete test suite; the client
  intake and clients UI tests launch Firefox.
- Linux only: the `bubblewrap` package must provide `/usr/bin/bwrap` for local
  harness sandbox checks. Linux test runs also need Playwright's OS
  dependencies; install them with the test command below.
- The Codex CLI for the current CEO path. Bedrock specialists do not replace
  this requirement: the readiness check requires Codex to be installed, and
  CEO orchestration becomes available after the operator connects ChatGPT.

AWS CLI credentials and access are optional for Bedrock specialist and worker
lanes. They use the operator's own AWS account and can incur AWS charges.
Antigravity, Google intake, Hermes, RJ AWS, and other connectors likewise need
their own explicit configuration and account access; none is assumed by the
public defaults.

## Clean install

Use a fresh checkout and the lockfile so the installed dependency set is
reproducible. The commands below create only local, ignored install and build
state.

```sh
git clone https://github.com/rodkend78/chimera.git
cd chimera
npm ci
npx playwright install chromium
npm run build
```

The optional local environment file is not needed for a keyless demo or for
the default-deny startup path. If you need an optional connector, copy the
template, leave unrelated settings empty, and restrict the file to the current
user:

```sh
cp .env.example .env
chmod 600 .env
```

Never copy a production `.env`, `.chimera` directory, browser profile, private
key, OAuth token, provider credential, or customer data into this checkout.
The `.chimera/` directory is local runtime state and is ignored by Git.

## Optional TypeSafe Jev setup

In **Settings → Connections → TypeSafe Jev**, enter your own API key from the
[TypeSafe dashboard](https://console.typesafe.ai/). Chimera saves it only in
`.chimera/jev/key.json` with owner-only permissions. The Settings API reports
whether Jev is configured; it never returns the saved key. Replace or remove
the key from the same screen. Each local Chimera installation needs its own key;
no credential is included in the repository.

Jev makes typed decisions: it may choose among models that have already passed
Chimera's trusted eligibility checks, suggest an eligible specialist for an
unbound task, or answer a worker's bounded Choice, Score, or yes/no question.
It does not write task output or execute tools. Chimera keeps the current route
when Jev is unavailable or its answer is below the confidence threshold. A
separate execution model is still required.

When connected, Chimera sends relevant task text and requirements for routing,
or the state supplied with an explicit `jev_decide` tool call, to TypeSafe's
`/v1/systemone` API. Calls pass through the signed model gateway and durable
model-call ledger. Use a key only if the tasks you submit may share that data
with TypeSafe. Disconnecting removes the saved key; a call already in flight
may still finish. This beta is a local single-operator pilot, not a multi-user
credential vault.

## Model account setup

The current CEO route uses the Codex CLI and the operator's ChatGPT
subscription. Install the CLI according to its own documentation, then check
its local status and connect it from Chimera when prompted:

```sh
codex login
codex login status
```

Start Chimera first, open **Work → ChatGPT / Codex**, and use **Connect** or
**Reconnect**. Other connector settings are under **Settings**. The App Server owns the OAuth token; Chimera
retains only bounded connection state and does not put the token in the browser,
repository, task record, or audit projection. Do not paste account status,
authorization URLs, tokens, or callback details into an issue.

For agent setup, use **Team** to review the roster and open **New agent** for a
native Chimera agent. Use **Settings → Import agents** to discover and preview
Hermes candidates before importing them. Setup and continuity import do not
start work; choose **Ask agent**, **Start work**, or **Continue task** explicitly
from the Conversation surface. Ask is inference-only, while task work remains
bound to the selected route, task lease, approval, and retained evidence.

AWS Bedrock Runtime and AWS Bedrock Mantle are optional specialist lanes.
Configure the normal AWS credential chain or an explicitly supported local
environment variable only on the machine that runs Chimera, and verify the
intended account with:

```sh
aws sts get-caller-identity --region us-west-2
```

This command is an operator check, not a required install step. Model discovery
does not prove invocation access, quota, privacy, or cost. Chimera does not
advertise a standalone all-model CEO orchestrator: the current CEO path still
requires Codex CLI availability and a connected ChatGPT account.

## First-run secure launch

Run the readiness check before starting work:

```sh
npm run pilot:check
```

It verifies Node, the POSIX Python broker, loopback binding, Chromium, `.env` permissions when a file is
present, and Codex CLI availability. A missing optional AWS account is not a
startup failure. Fix any `BLOCK` line before continuing.

For a foreground pilot, use:

```sh
npm run pilot
```

For a managed user service on macOS or Linux, use:

```sh
npm run pilot:up
npm run pilot:status
```

Both start the local service on loopback at `http://127.0.0.1:4174/`. Startup
prints a short-lived secure launch URL containing a one-time operator bootstrap
token. Use that URL only on the same computer, keep it private, and never paste
it into shell transcripts, issue reports, screenshots, chat, or CI logs. The
bootstrap token expires after five minutes and is consumed when exchanged for
the authenticated operator session. The resulting session and CSRF tokens are
also short-lived; the server never accepts unauthenticated API mutations.

Open the printed URL locally, then connect the model account and submit one
bounded objective. The service stays loopback-only and keeps operator state in
`.chimera/`. If the launch URL expires, restart explicitly to obtain a new one.
Do not loosen CORS, bind to a public interface, or expose the API as a way to
work around an expired session.

The lifecycle commands are:

```sh
npm run pilot:status
npm run pilot:restart
npm run pilot:down
```

Restart and shutdown are explicit boundaries. In-flight work is cancelled or
terminalized safely; unsafe external effects are not silently retried, and a
restart does not guarantee that a provider-side action was undone. Inspect the
task and decision state before resubmitting work. Run only one pilot instance
for a checkout; an occupied managed port is reported rather than taken over.

`npm run dev` remains available for split local development: the API uses port
4174 and Vite uses port 5173. Both origins are loopback-only and remain subject
to the same authenticated API boundary.

## Costs, data, and limitations

Local Node, npm, and Chromium use local resources. A connected Codex/ChatGPT
subscription, AWS Bedrock Runtime or Mantle inference, AgentCore workers, S3
media artifacts, Google services, Hermes infrastructure, Antigravity, or any
other enabled provider uses the operator's account and may incur provider
charges. Model catalog presence is not a price or availability guarantee; check
each provider's current terms and billing controls before enabling it.

The beta is intentionally limited:

- It is a local single-operator pilot. Local task, model, audit, browser, and
  project state is not application-encrypted; protect the host and backups.
- Default-deny policy, loopback binding, operator authentication, signed
  actions, and replay protection are part of the proof, but they do not make a
  compromised host, provider, browser, or account safe.
- Human-only sign-in, MFA, CAPTCHA, payment, enrollment, and judgment remain
  human actions. A browser control lease does not grant a model permission to
  use an account.
- Managed Chromium uses an authenticated, DNS-pinning public-egress proxy.
  Private and special-use destinations are blocked, including redirects and
  subresources. Only exact, short-lived sign-in callback URLs are exempt;
  private-site browsing is not supported. Service workers, QUIC, and direct
  WebRTC UDP are disabled to preserve that transport boundary.
- AWS AgentCore, cloud audit, media storage, external model access, and remote
  team connectors need separately configured infrastructure and acceptance.
  Project-scoped isolation and production key custody are not complete here.
- The checked-in test suite uses fixtures and keyless paths. It does not prove
  live provider output, account authorization, cloud durability, or billing.
- Worker roots, their ancestors, and staging areas are runtime-owned. Only
  scratch descendants are agent-writable. Do not share those roots with
  untrusted host processes; descriptor-relative operations protect against
  descendant symlink swaps, not a compromised operator account or runtime.
- Confirm-tier tool previews are bounded: shell commands, file contents/change
  text, GitHub bodies, and generic argument previews must fit 4 KiB; larger calls require splitting or a dedicated review
  adapter. Known credential fields are redacted, but arbitrary prose can still
  contain secrets: do not embed credentials in commands or tool arguments.

## Backup and upgrade

Stop the pilot before backing up `.chimera/`. Use an owner-only, encrypted OS
backup for the complete directory if you need to preserve local identities,
replay records, decisions, task history, browser state, or project metadata.
Never upload that directory, a browser profile, or a backup containing keys or
tokens to an issue, pull request, public artifact, or untrusted service.

To upgrade, review the release notes and dependency changes, stop the running
pilot, take a protected backup, update the checkout, reinstall from the lockfile,
install any changed browser runtime, rebuild, and run the verification commands:

```sh
npm run pilot:down
git pull --ff-only
npm ci
npx playwright install chromium firefox
npm test
npm run build
npm audit --omit=dev
npm run pilot:up
```

Do not delete or overlay `.chimera/` to repair a failed upgrade. If state
migration or permissions fail, keep the backup, stop competing processes, and
investigate the reported error before attempting a new start.

## Supported verification commands

These commands are the supported local checks for this source beta:

```sh
npm ci
npx playwright install chromium firefox
npm test
npm run build
npm audit --omit=dev
npm run demo
npm run pilot:check
npm run pilot:ade-acceptance
```

`npm run demo` uses generated identities and a memory audit log; it makes no
provider call. `npm run pilot:ade-acceptance` uses disposable local fixtures and
does not replace live provider or security acceptance. Keep command output
free of secure launch URLs, account identifiers, credentials, private paths,
and customer content.

The quick-start Chromium install is sufficient for the pilot runtime. The full
test suite additionally launches Firefox, so install both browsers before
`npm test`:

```sh
npx playwright install chromium firefox
```

On Linux, install the host sandbox and browser OS dependencies before testing:

```sh
sudo apt-get install -y bubblewrap
test -x /usr/bin/bwrap
npx playwright install --with-deps chromium firefox
```

Keep the host's normal security controls enabled. A missing `/usr/bin/bwrap` or
Playwright OS dependency is a setup failure to fix on the test host, not a
reason to weaken host-wide sandboxing.

## Documentation and support

The technical contracts live in:

- [Security model](docs/SECURITY_MODEL.md)
- [Browser contract](docs/BROWSER_CONTRACT.md)
- [Model providers](docs/MODEL_PROVIDERS.md)
- [CEO workspace](docs/CEO_WORKSPACE.md)
- [Agent harness](docs/AGENT_HARNESS.md)
- [Agent registry](docs/AGENT_REGISTRY.md)
- [ADE workspace](docs/ADE_WORKSPACE.md)
- [Client workspaces](docs/client-workspaces.md)
- [Plugins and connectors](docs/PLUGINS_AND_CONNECTORS.md)
- [Message envelope](docs/MESSAGE_ENVELOPE.md)
- [Nostr key custody ADR](docs/ADR-002-NOSTR-KEY-CUSTODY.md)

Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a change and
[SECURITY.md](SECURITY.md) before reporting a vulnerability. GitHub issues are
for reproducible, non-sensitive bugs and feature discussion only.
