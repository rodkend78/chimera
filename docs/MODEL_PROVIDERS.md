# Chimera Model Fabric

**Status:** The local V1 pilot automatically routes work across an authenticated
Codex subscription and verified AWS Bedrock inference profiles. Antigravity is an
operator-managed native executor available by explicit model selection (see below).
Chimera reuses the host's existing authentication; it never
copies an OAuth token or AWS secret into the browser or repository.

## Provider lanes

### Codex through ChatGPT

Chimera uses `@openai/codex-sdk` for CEO planning, synthesis, coding, and
general reasoning. The SDK and Chimera's App Server connection use the same
Codex authentication. It can be established from Chimera's connection card or
from the CLI:

```sh
codex login
codex login status
```

For the pilot, model-provider Codex threads are deliberately read-only, have
network and web search disabled, and use `approvalPolicy: never`. This keeps a
model call inside the signed Chimera action boundary. A future write-capable
Codex worker must expose each filesystem, shell, browser, or network effect as
an explicit Chimera gateway action rather than inheriting ambient authority.

The workspace shows a **ChatGPT / Codex** connection card. **Connect** or
**Reconnect** starts the official Codex App Server managed browser flow and
opens the returned trusted OpenAI authorization URL in Chimera's own browser.
Depending on the App Server version, the exact trusted origin may be
`https://chatgpt.com` or `https://auth.openai.com`. The App Server owns OAuth
tokens, persistence, and refresh. Chimera retains only bounded connection
state, plan type, login ID, and login outcome; it strips account email and
never receives, returns, logs, or persists access tokens. The full managed URL
is used only for active navigation. Query and fragment data are redacted from
observable tab state and audit resources, and an OAuth tab is not restored from
Chimera's suspended-tab file.

Authorization URLs fail closed unless they use HTTPS on an explicitly trusted
OpenAI host. Their callback must be an exact `http://localhost:<ephemeral>` or
`http://127.0.0.1:<ephemeral>` `/auth/callback` URL. Chimera grants that one
origin and path a short-lived browser exception; all other private-network and
localhost destinations remain blocked.

After the App Server reports a successful login, Chimera refreshes its safe
account state and rebuilds future model routes without restarting the
workspace. A task already in flight keeps its captured router and is not
silently moved between providers.

### Antigravity through the local signed-in account

The operator-approved native executor is available to RJ and every registered
specialist through the existing model picker. It uses the installed `agy` CLI
and its signed-in account, with no Gemini API-key fallback. Discovery does not
prove quota or subscription entitlement; a successful call establishes session
readiness, not an independently verified billing ledger.

Open **Agents → Connections → Antigravity → Find Antigravity models**. Choose
an Antigravity model for RJ or a specialist, then choose **Pinned** to prevent
fallback. **Preferred** retains normal fallback behavior. Existing agent pins
are not overwritten, and Auto defaults are unchanged. Rediscover after server
restart; saved preferences remain but unavailable routes cannot dispatch.

**Native permission boundary:** native file, shell, browser, MCP and subagent
actions use the operator's Antigravity CLI settings, not Chimera's Sandbox or
network-grant settings. CLI settings may differ from desktop app settings.
Chimera does not change those settings or pass an auto-approval flag. Permission
denials or requests requiring an interactive session may fail the headless task;
review/configure the CLI or use the desktop app, then explicitly submit new work.
The UI calls out this distinction at both connection and agent-picker surfaces.

Each call starts a fresh CLI session with the exact selected model, a custom
Chimera assignment agent, scrubbed credential environment, bounded output and
timeout, cancellation, and validated schema output. The first init must confirm
the selected agent/model and request-review permission mode before any prompt is
sent. Native tool lists are accepted under the operator's explicit approval;
an empty list is no longer required. Startup hooks still require review and
API-provider settings remain refused.

Project tasks receive their trusted task worktree via `--add-dir`; no path is
accepted by the public connection API. Other work uses a private retained
directory under `.chimera/antigravity/calls`. Native outputs and partial work
survive successful or failed calls for review; no automatic expiry is installed.
This scratch directory is not an OS sandbox. Native tools may reach other
locations if the operator's Antigravity permissions allow it.

Chimera still authorizes and audits the outer invocation and uses its durable
model-call ledger. Native tool events record names/state and task attribution,
not arguments, output, credentials or reasoning. They are observations, not
individual Chimera approvals. Steering during native execution stops the task
for review instead of automatically replanning and potentially repeating effects.
Cancellation stops the owned CLI process group, but cannot undo completed external
effects or guarantee cancellation of work already handed to an external service.

**Open Antigravity app** runs only
`/usr/bin/open -a /Applications/Antigravity.app`. It opens a separate desktop
window, not an embedded IDE, and does not automatically transfer/start a task.
Launch intent must be audited first; an uncertain completion is not retried.
The authenticated operator endpoints are:

- `GET /api/antigravity/state`
- `POST /api/antigravity/refresh`
- `POST /api/antigravity/open`

POST requires CSRF and an empty JSON object. No arbitrary command, path, model
prompt, or URL can be supplied through these connection endpoints.

#### Verification boundary

The native adapter validates the selected model, protocol handshake, permission mode,
bounded structured output, cancellation, and operator-visible failure codes. Fixture
tests cover these checks without contacting a provider or requiring an authenticated
account. A live provider call is a separate operator acceptance step and is not
represented as repository evidence.
### AWS Bedrock Runtime

Chimera uses the normal AWS credential provider chain and region `us-west-2`.
No AWS access key is stored in Chimera. At startup it discovers the account's
text-model catalog and inference profiles, but only checked-in, allowlisted
routes can receive work.

The pilot routes are in [`config/model-routing.json`](../config/model-routing.json):

- `us.amazon.nova-micro-v1:0` for low-cost bulk extraction and classification;
- `us.anthropic.claude-haiku-4-5-20251001-v1:0` for bounded research and
  evidence work;
- Codex as the fallback when an AWS specialist route is unavailable.

Routes are eligible only when a configured catalog entry and the corresponding
operator credentials are available. Catalog presence alone is not invocation
permission; unavailable or denied routes fail closed.
The Media workspace installs two specialist adapters that are separate from
text routing:

- `stability.stable-image-ultra-v1:1` uses Bedrock `InvokeModel` for synchronous
  image generation and returns the bounded image directly to the local UI;
- `luma.ray-v2:0` uses Bedrock async invocation for 5- or 9-second video and
  writes the result into an operator-configured private object store.

Video objects are encrypted at rest, blocked from public access, and opened through
a short-lived URL only after the provider reports the job completed. Local fixtures
exercise media adapter boundaries without generating or downloading provider media.
Each generation is signed by the CEO identity, checked as an exact
`model.invoke` resource by the Chimera gateway, and recorded only by request
hash and attribution. The local pilot allows at most two concurrent provider
dispatches and twelve new generations per rolling hour. Prompts, provider
invocation ARNs, S3 paths, and presigned URLs are excluded from `/api/state`;
the initiating Media view receives only the bounded image result or its own
short-lived completed-video URL.

### AWS Bedrock Mantle

Mantle is modeled as a separate provider because catalog and invocation access
are endpoint-specific. Chimera sends `OpenAI-Project: default`, discovers
models at `https://bedrock-mantle.us-west-2.api.aws/v1/models`, and invokes
models at `/openai/v1/chat/completions`. It prefers SigV4 with the normal AWS
credential provider chain. It can alternatively use
`CHIMERA_BEDROCK_MANTLE_API_KEY`, `BEDROCK_API_KEY`, or
`AWS_BEARER_TOKEN_BEDROCK`; a generic OpenAI key is never silently reused
against AWS.

The V1 priority routes are:

- `xai.grok-4.6`, strong for research, reasoning, and coding; its initial
  automatic route remains research so this capability note does not silently
  replace Codex as the default coding lane;
- `google.gemma-4-31b` for low-cost bulk and multimodal understanding of text,
  images, and video inputs.

Both appear in the Agents catalog before connection so missing authentication is
actionable. Startup discovers the project catalog without billable completions.
Configured catalog-listed automatic routes are eligible for requested tasks;
catalog presence is not proof of inference access. Explicit model checks and
manual selection can run a billable probe; actual tasks can also incur charges.
Credentials remain inside the server-side
provider closure and are excluded from state, descriptors, task records, and
audit events.

### OpenAI-compatible model providers (opt-in)

Chimera can register an explicitly configured OpenAI-compatible text provider in
the model-routing file. Provider definitions and credentials are empty by default.
An operator may set a provider API key and an HTTPS endpoint, or a loopback endpoint
for a local development service. The endpoint validator rejects embedded credentials,
query strings, fragments, and non-loopback HTTP.

Pinned selection fails closed when the configured provider, credential, or model is
unavailable; it never silently moves work to another provider. No personal tunnel,
GPU host, bucket, account, or route is included in the public defaults.
## Routing and authorization

The in-app selector is `Chimera Auto · Best model for task`. The router uses
the signed task stage and bounded task text:

| Work | Preferred lane |
| --- | --- |
| CEO decomposition and synthesis | Codex subscription |
| Repository implementation, debugging, tests | Codex subscription |
| Bulk extraction, classification, normalization | Catalog-listed configured Mantle Gemma 4 31B, then Bedrock Nova Micro |
| Image/video understanding | Mantle Gemma 4 31B when verified |
| Research, comparison, evidence gathering | Mantle Grok 4.6 when verified, then Bedrock Claude Haiku 4.5 |
| General reasoning | Codex subscription |

Every choice appends `model.route.selected` to the audit chain before
dispatch. The event records route ID, capability, task ID, stage, and cost
class, but no prompt body or credential. If no eligible provider exists, the
router fails before dispatch with `NO_ELIGIBLE_MODEL_ROUTE`.

The CEO and specialist grants authorize only the legacy compatible adapter and
the new `model:model-fabric:` resource prefix. Provider calls still pass
through the gateway and durable logical-call ledger, so an uncertain
post-dispatch result is not silently retried.

## Operator checks

```sh
aws sts get-caller-identity --region us-west-2
npm run pilot:check
npm run pilot
```

`pilot:check` verifies Node, loopback binding, Chromium, local `.env`
permissions if a file exists, and that Codex is installed. A signed-out Codex
installation passes so the operator can reach Chimera's in-app **Connect**
flow; task submission remains disabled until login succeeds. AWS is an optional
specialist lane. The check prints provider IDs only and never prints
credentials.

## Remaining provider work

- Antigravity desktop session attachment and interactive permission forwarding
  remain separate work, as does direct Google OAuth/Gemini API routing.
- Add model health, latency, budget, and fallback telemetry to routing scores.
- Replace local authentication discovery with AWS-hosted identity brokering
  when the pilot moves off this Mac.
