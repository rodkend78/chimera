# Agent Workspace UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every implementer and reviewer must use `gpt-5.6-luna` with `max` reasoning. The main agent independently verifies the integrated work.

**Goal:** Complete all six approved UX phases: agent setup, connections, conversation destinations, routing, the task workspace, and safe recovery/evidenced outcomes.

**Architecture:** Extend the existing React workspace and signed runtime using small services and projections. Reuse durable agent/model/access stores, the model-call ledger, signed mailboxes, task controls, and exact-action approvals. Keep provider login, model inference, native execution, authority, and evidence as distinct concepts.

**Tech Stack:** Node >=22.19.0 ESM, React 19, Vite 8, existing JSON/JSONL persistence, Node test runner, Playwright, existing model/connector adapters.

**Spec:** [Six-phase design](../specs/2026-09-18-agent-workspace-ux.md).

## Implementation and local verification status

Completed all six phases and eleven implementation tasks on 2026-09-20 at
06:00 UTC in `codex/agent-workspace-ux`. The execution record is
`.superpowers/sdd/2026-09-18-agent-workspace-ux/progress.md`; the step checklists
below retain the original implementation instructions, not current release
status. GPT-5.6 Luna Max implementers and reviewers completed scoped work and
cross-reviews; the main agent inspected integration changes and independently
ran the final gates against frozen source.

- `npm test`: 1,327 tests, 1,320 passed, zero failures or cancellations, seven
  skipped (297,781.913916 ms).
- `npm run build`: passed, 3,659 modules. The existing large lazy live-view SDK
  chunk warning remains; it is not a claim that bundle optimization is complete.
- `npm run pilot:ade-acceptance`: passed the disposable local workflow,
  approval/restart, explicit recovery, review and audit checks. Its delivery
  commit belongs only to the disposable fixture repository.
- `npm audit --omit=dev`: zero reported production dependency vulnerabilities;
  this is not a substitute for a complete security audit.
- Rendered checks passed at phone, tablet and desktop sizes, including keyboard
  access and a constrained 200% zoom case. These use isolated fixtures, not live
  provider accounts.
- Original 23 carried security-patch files in the source checkout are unchanged.
  The repository index is unchanged, HEAD remains `8aba783f416750f50baeed2f5262bbfe55f65205`,
  and `git diff --check` is clean.

The seven skipped checks are six Linux-only isolation/process/service/locking
checks and the unavailable Gitleaks prerequisite; they remain **unverified**.
CI, live account acceptance, commit/push/merge and iMac deployment have **not**
been performed in this implementation phase. No private installation, AWS
resource, paid provider call or account configuration was changed. Publication
status remains evidence-backed; no publishing adapter was added or implied.

## Global Constraints

- Work in the community repository; do not modify the private installation, the iMac, or AWS resources.
- Preserve the existing uncommitted security patch and its regression coverage.
- Use GPT-5.6 Luna (`gpt-5.6-luna`) with `max` reasoning for every delegated task and independent delegated review.
- Keep Node >=22.19.0, React 19, Vite 8, Node's test runner, and Playwright; do not add a new UI or orchestration framework.
- Keep macOS and Linux support; unsupported executors fail closed rather than falling back to an unsandboxed shell.
- Model output, imported persona files, and agent messages are data, not grants or operator consent.
- Do not call paid providers, change external accounts, commit, push, merge, or deploy as part of implementation verification without separate authorization.
- Never copy credentials, OAuth sessions, private keys, or provider account configuration into agent persona or memory.
- Keep Auto, Preferred, and Pinned model choices; Pinned never silently falls back.
- Keep unknown post-dispatch outcomes blocked from automatic retry or fallback.
- Preserve human browser takeover, task-bound grants, cancellation, steering, approval expiry, and exact-action confirmation.
- State readiness, price, quality, completion, and publication only to the extent supported by actual evidence; represent missing evidence as unknown or untested.
- Retain all existing navigation destinations and advanced functionality using progressive disclosure rather than removing features.

## Review Focus

1. A provider disconnect/reconnect racing with task dispatch must not permit a new call through a previously captured router; Task 1 tests the dispatch-time fence and stale verification.
2. A selected room/agent disappearing while an unsent or unconfirmed draft exists must not readdress or resend it; Task 5 tests navigation, reload, removed recipients, and lost acknowledgements.
3. A native model route labeled read-only must not be admitted to zero-tool Ask merely because it has a filesystem sandbox; Task 3 tests an executable-provider spy and strict pins.
4. Two model-generated steps claiming different resources must not run concurrently without runtime-proven ownership; Task 8 tests forged, missing, ancestor/descendant, and unknown claims.
5. A model saying “tests passed” or “deployed,” or a legacy decision missing task identity, must not become verified outcome evidence or a task-specific approval; Tasks 7 and 10 test both cases.

## Baseline and execution rules

Source inspected: community repo at `8aba783f416750f50baeed2f5262bbfe55f65205`,
branch `main`, with an existing uncommitted security patch. The patch changes
filesystem confinement, browser egress, approval argument integrity, readiness,
CI, and regression tests. Do not discard, stage, or commit it incidentally.

Before implementation, use the git-worktree skill to prepare an isolated
non-main branch. Carry the exact approved security baseline into that workspace
without copying `.env`, `.chimera`, credentials, browser profiles, or personal
agent data. Retain an exact tracked/untracked file inventory and hashes, then
compare the carried patch before edits. If creating that baseline requires a
commit, obtain authorization first; do not invent permission to publish it.

The plan/spec documents are the only additions made during planning. Existing
source files remain unchanged. Implementation waits for detailed-plan review.

One implementer works at a time because `App.jsx`, `runtime.mjs`, and the model
fabric are shared integration points. Each task is followed by a fresh Luna Max
reviewer. The main agent reviews actual diffs, verifies test output and affected
behavior, and records coverage of the six phases in the SDD ledger. Do not
accept a completion claim without its changes and evidence.

Each task uses red/green tests and ends with a reviewable diff. Commit steps are
deferred until separately authorized; review the exact working-tree diff,
including untracked additions, instead of pretending `base..HEAD` includes it.

## File map and shared interface ownership

| Owner | New focused files | Existing integration files |
| --- | --- | --- |
| Task 1: connection truth | `src/connections/state.mjs`, `policy.mjs`, `service.mjs`; `src/browser/connections-api.mjs` | `src/browser/runtime.mjs`, `server.mjs`; `src/ceo/local-model-fabric.mjs`; provider/connector dispatch seams |
| Task 2: durable agents | `src/agents/native-reference-provider.mjs` | `src/agents/registry.mjs`, `worker-workspace.mjs`; runtime/server |
| Task 3: Ask | `src/ceo/ask-service.mjs` | conversation ledger, structured output, model fabric, runtime/server |
| Task 4: guided setup | `src/agents/readiness.mjs`, `readiness-store.mjs`; `app/src/AgentSetupWizard.jsx`, `ConnectionsWorkspace.jsx`, `agent-setup.css` | `App.jsx`, model/access pickers, agent API |
| Task 5: conversations | `app/src/conversation-target.js`, `draft-store.js`, `ConversationComposer.jsx`, `conversation-composer.css` | `App.jsx`, `TaskRoomControls.jsx`, task/conversation ledgers and runtime |
| Task 6: routing | `src/ceo/task-requirements.mjs`, `routing-evidence.mjs` | task-aware router, local model fabric, runtime, task controls |
| Task 7: plan/attribution | `src/ceo/task-plan.mjs` | task ledger, CEO workspace, structured output, decisions, runtime |
| Task 8: scheduling | `src/agents/plan-resources.mjs` | team dispatcher, CEO workspace, runtime |
| Task 9: task workspace | `src/ceo/task-workspace-projection.mjs`; `app/src/TaskWorkspace.jsx`, `task-workspace.css` | runtime/server, `App.jsx`, task results/room components |
| Task 10: recovery/outcomes | `src/ceo/task-outcomes.mjs`, `task-recovery.mjs`; `app/src/TaskOutcome.jsx` | task ledger, runtime, task controls, decision dialog |
| Task 11: integrated acceptance | `tests/agent-workspace-acceptance.test.mjs`, `agent-workspace-rendered.test.mjs` | existing feature docs and regressions |

Existing schema/API readers remain compatible. New fields are bounded and
allowlisted. Never accept a filesystem path, shell command, token, or external
URL through a connection action endpoint. Runtime-owned context travels outside
model-controlled fields.

## Task 1: truthful connection state and durable local disconnection

**Phase:** 2; prerequisite for agent setup and model routing.

**Files:**

- Create: `src/connections/state.mjs`, `src/connections/policy.mjs`, `src/connections/service.mjs`, `src/browser/connections-api.mjs`.
- Modify: `src/browser/runtime.mjs`, `src/browser/server.mjs`, `src/ceo/local-model-fabric.mjs`, `src/ceo/antigravity-provider.mjs`, and the runtime connector dispatch wrappers.
- Test: `tests/connection-state.test.mjs`, `tests/connection-policy.test.mjs`, `tests/connections-api.test.mjs`, `tests/local-model-fabric.test.mjs`.

**Interfaces:**

- `projectConnection({ providerId, enabled, revision, machineRef, accountRef, signedIn, catalogAvailable, lastVerification, error, operations })` returns a bounded `chimera.connection-state.v1` with `status`, provenance, operation capabilities, and operation-scoped evidence. `operations` is the server adapter's allowlisted action map; missing operations are unsupported, not guessed from provider names.
- `DurableConnectionPolicy.open({ filePath, audit, now })`; `get(providerId)` returns `{ enabled, revision }`; `setEnabled(providerId, enabled, { changedBy })` persists an audited new revision; `assertEnabled(providerId)` throws `CONNECTION_DISABLED` before dispatch.
- `ConnectionService.list()` is read-only. `act({ providerId, operation, model, requestId, expectedRevision, allowQuotaUse })` accepts only `connect`, `refresh`, `test-safe`, `test-model`, `reconnect`, or `disconnect` and returns normalized state plus an operation receipt.
- Authenticated `GET /api/connections`; CSRF-protected `POST /api/connections/action` delegates to `act()`. Provider IDs must resolve through a fixed server adapter registry.
- `LocalModelFabricRegistry.describeSelection(preference)` returns selection eligibility/metadata without inference; selection and `routerFor()` must no longer call a billable probe implicitly.

- [ ] **Step 1: Add the failing state/fence regression.**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { projectConnection } from '../src/connections/state.mjs'

test('catalog discovery is not verification and a new revision invalidates it', () => {
  const base = { providerId: 'fixture', enabled: true, revision: 2,
    machineRef: 'fixture-machine', accountRef: null, signedIn: true,
    catalogAvailable: true, error: null }
  assert.equal(projectConnection(base).status, 'available')
  assert.equal(projectConnection({ ...base, lastVerification: {
    revision: 1, machineRef: 'fixture-machine', operation: 'model-invoke',
    status: 'passed', at: '2026-09-18T00:00:00.000Z',
  } }).status, 'available')
  assert.equal(projectConnection({ ...base, enabled: false }).status, 'not-connected')
})
```

Also test a captured router, then disable its provider, then invoke it: zero
provider calls and `CONNECTION_DISABLED`. Repeat after reopening the policy.
Allow an already-dispatched operation to settle, but fence its next model/tool
call. Test forged provider IDs, extra keys, stale revisions, duplicate request
IDs, and loss of a test acknowledgement without automatic resubmission.

- [ ] **Step 2: Run red.** `node --test tests/connection-state.test.mjs tests/connection-policy.test.mjs tests/connections-api.test.mjs`; expect missing modules/contracts or assertions before implementation.
- [ ] **Step 3: Implement the state and action contract.** Use atomic mode-0600 persistence and the existing audit/redaction patterns. The normalizer must apply these precedence rules:

```js
const current = lastVerification?.revision === revision
  && lastVerification?.machineRef === machineRef
if (!enabled) status = 'not-connected'
else if (error) status = 'needs-attention'
else if (current && lastVerification.status === 'passed') status = 'verified'
else if (catalogAvailable) status = 'available'
else if (signedIn) status = 'signed-in'
else status = 'not-connected'
```

The state also identifies the verified operation; a successful account read
must never be presented as verified model execution. Safe account labels may be
null; preserve Codex's existing removal of email. Runtime machine identity is
server-supplied. A revision changes on binding/account/session changes, not on
every polling read. Retained evidence without a confirmable current binding is
historical, not current verification.

Adapter capabilities are explicit: Codex uses managed login/read; Antigravity
uses refresh/open and its no-prompt handshake; GitHub uses existing login/state;
AWS lanes use existing credential-chain/catalog reads; compatible model APIs
without a safe check report unsupported. RJ AWS keeps signed verify/reconcile.
Disconnect only disables Chimera's binding, leaving external credentials intact.
It fences both model and relevant connector dispatch, not just a UI badge.
Re-enable/reconnect is explicit. A failed re-enable must not lose the old task.

`test-model` requires `allowQuotaUse === true`, exact model identity, and a
single-flight request ID. Reuse signed model invocation and durable ambiguity
semantics; never directly call a paid probe around the gateway. Store receipt
metadata, never provider output/credentials in connection state.

- [ ] **Step 4: Run green and existing provider regressions.** Run the three new tests plus `tests/local-model-fabric.test.mjs`, `tests/codex-auth-api.test.mjs`, `tests/antigravity-ui.test.mjs`, and `tests/rj-aws-runtime.test.mjs`. Assert no inference on state/refresh/select and no fake external logout.
- [ ] **Step 5: Review the exact diff and evidence with a fresh Luna Max reviewer.** Leave changes uncommitted until separately authorized.

## Task 2: durable native agents, metadata editing, and continuity reports

**Phase:** 1 backend; depends on Task 1's non-invoking selection description.

**Files:**

- Create: `src/agents/native-reference-provider.mjs`.
- Modify: `src/agents/registry.mjs`, `src/agents/worker-workspace.mjs`, `src/browser/runtime.mjs`, `src/browser/server.mjs`.
- Test: `tests/agent-registry.test.mjs`, `tests/native-reference-provider.test.mjs`, `tests/browser-runtime-agents.test.mjs`.

**Interfaces:**

- Keep existing Hermes v1 manifests readable and unchanged. Add a discriminated `chimera.agent-manifest.v2` native form with `source.type: 'chimera'`, `source.sourceId: 'local'`, and `source.ref: 'chimera://local/agents/<agentId>'`; persona/memory/skill refs append their existing kind names and use `type: 'chimera-profile'`.
- `agentManifestFromNativeInput({ agentId, displayName, role, capabilities }, { now })` produces the native manifest with the existing model-fabric/isolation/DSH execution posture.
- `DurableAgentRegistry.updateMetadata(agentId, { displayName, role, capabilities }, { changedBy })` preserves identity/source/references/execution, serializes mutations, persists atomically, and audits the change.
- `NativeAgentReferenceProvider.open({ root, audit })`; `savePersona({ agentId, content, changedBy })` stores one bounded `SOUL.md` revision; `materialize(reference, { agentId, kind })` returns existing worker materialization objects. Caller-supplied paths are never accepted.
- `runtime.createAgent({ requestId, agentId, displayName, role, capabilities, persona })` returns `{ schema: 'chimera.agent-create-result.v1', requestId, agent, continuity }`; `agent` is the validated manifest. `runtime.updateAgentMetadata(input)` accepts `{ agentId, displayName, role, capabilities }` and returns the updated manifest. Routes: `POST /api/agents/create` and `POST /api/agents/metadata`.
- Import/create results include `continuity: [{ agentId, status, digest, report, failureCode }]`; status is `materialized`, `unavailable`, or `not-requested`. Never expose raw continuity content in `/api/state`.

- [ ] **Step 1: Add the failing manifest/backward-compatibility test.**

```js
import assert from 'node:assert/strict'
import test from 'node:test'
import { agentManifestFromNativeInput, validateAgentManifest } from '../src/agents/registry.mjs'

test('native agent creation uses its own bounded source and unchanged authority posture', () => {
  const manifest = agentManifestFromNativeInput({ agentId: 'test-builder',
    displayName: 'Test Builder', role: 'Repository implementation', capabilities: ['coding'] },
  { now: () => 0 })
  assert.equal(manifest.source.ref, 'chimera://local/agents/test-builder')
  assert.equal(manifest.execution.sideEffects, 'dsh-required')
  assert.equal(manifest.modelPreference.mode, 'chimera-auto')
  assert.deepEqual(validateAgentManifest(manifest), manifest)
  assert.throws(() => agentManifestFromNativeInput({ agentId: 'ceo',
    displayName: 'Replacement', role: 'CEO', capabilities: ['general'] }))
})
```

Add registry reopen, reserved `rj`/`operator`/built-in collision, duplicate
request, concurrent registration, atomic write failure, and metadata-preserves-
policy tests. Test that persona credential assignments/private key material are
rejected or excluded without being logged. Keep every existing Hermes test.

- [ ] **Step 2: Run red.** `node --test tests/agent-registry.test.mjs tests/native-reference-provider.test.mjs tests/browser-runtime-agents.test.mjs`.
- [ ] **Step 3: Implement native creation and safe reports.** Extend validation by source discriminant, not by weakening Hermes references. Use exact URI construction:

```js
const ref = `chimera://local/agents/${agentId}`
const references = {
  personaRefs: [{ type: 'chimera-profile', ref: `${ref}/persona` }],
  memoryRefs: [{ type: 'chimera-profile', ref: `${ref}/memory` }],
  skillRefs: [{ type: 'chimera-profile', ref: `${ref}/skills` }],
}
```

Native persona is UTF-8, nonempty, at most 64 KiB; no arbitrary files, runtime
configuration, or executable assets. Empty native memory/skill collections are
explicitly reported. Reuse confined workspace writes from the preserved security
patch. Serialize the entire registry mutation, not only the final disk write.
Reject metadata edits during active work just like model/access edits.

Use the existing `AgentWorkerWorkspace.state().continuity` counts/digest/report.
Add `dependencyStatus: 'unverified'` unless a bounded runtime check actually
verified a declared dependency. Explain that copied SKILL.md instructions do not
include scripts, credentials, or installed integrations. Report known excluded
companions without executing instructions or guessing that a skill is runnable.
Materialization failure leaves a clearly reported unready registration that can
be repaired; never roll back by deleting unrelated work or claim full migration.
Imports keep server-held discovery/candidate validation and expose role/capability
overrides already supported by `importAgents()`.

- [ ] **Step 4: Run green and restart coverage.** Run the Task 2 tests plus `tests/hermes-reference-provider.test.mjs` and the existing worker-workspace tests. Confirm model pins/access policies survive metadata changes and no model is called on create/import.
- [ ] **Step 5: Independent review; retain uncommitted diff and test evidence.**

## Task 3: a genuine non-executing Ask path

**Phase:** 3 backend; also supplies bounded inference verification for setup.

**Files:**

- Create: `src/ceo/ask-service.mjs`.
- Modify: `src/ceo/conversation-ledger.mjs`, `src/ceo/structured-model-output.mjs`, `src/ceo/local-model-fabric.mjs`, `src/browser/runtime.mjs`, `src/browser/server.mjs`.
- Test: `tests/ask-service.test.mjs`, `tests/browser-runtime-ask.test.mjs`, `tests/conversation-ledger.test.mjs`, `tests/structured-model-output.test.mjs`.

**Interfaces:**

- `validateAskRequest(input)` accepts only `{ requestId, conversationId, recipientAgentId, content }`, bounds IDs at 256 and UTF-8 content at 16 KiB, rejects arrays/extra keys, and resolves recipients server-side.
- `AskService({ resolveInvocation, history, now })`; `ask(input)` returns `{ schema: 'chimera.ask-result.v1', requestId, conversationId, recipientAgentId, status, messageId, answer, failureCode }`. Statuses are `completed`, `failed-not-sent`, and `unknown`.
- `resolveInvocation({ recipientAgentId, requestId })` returns `{ router, agentId, context, descriptor }`; `router` is already signed/durable, `context` contains only that agent's bounded continuity, and `descriptor.execution` must equal `inference-only`.
- Add `DurableConversationLedger.beginAsk({ requestId, requestHash, message })`, `finishAsk({ requestId, message, outcome, failureCode })`, and `getAsk(requestId)`. `beginAsk` atomically reserves a unique request while writing the human question; `finishAsk` appends its bounded answer/failure. Exact repeats return the recorded state, hash collisions fail. A question without a terminal reply restores as unknown. Keep legacy ordinary message rows readable and do not rewrite them.
- `runtime.ask(input)`; CSRF-protected `POST /api/conversations/ask`; `GET /api/conversations/asks/:requestId` is status-only for reconciling a lost response.
- Add conversation kinds `question` and `answer` plus `mode: 'ask'` and `requestId` as optional validated fields; preserve all v1/v2 history readers.
- `LocalModelFabricRegistry.routerForAsk(preference)` requires an adapter descriptor with `execution: 'inference-only'`. Absence of this proof fails `ASK_EXECUTOR_NOT_PURE`; a strict pin remains unchanged.

- [ ] **Step 1: Add the failing pure-request test.**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { validateAskRequest } from '../src/ceo/ask-service.mjs'

test('Ask cannot accept a tool or task execution request', () => {
  const input = { requestId: 'ask-1', conversationId: 'agent:ace',
    recipientAgentId: 'ace', content: 'Explain this design.' }
  assert.deepEqual(validateAskRequest(input), input)
  assert.throws(() => validateAskRequest({ ...input, toolCall: { name: 'bash' } }))
  assert.throws(() => validateAskRequest({ ...input, taskId: 'execute-this' }))
})
```

Runtime fixture spies must prove zero task submissions, delegates, worker starts,
leases, approvals, project sessions, browser calls, and native executor calls.
Direct specialist Ask must call only that specialist's identity/model/persona.
Test native/pinned rejection before dispatch; adversarial `{ toolCall }` or
`{ tasks }` model output; concurrent duplicate IDs; recipient/content collisions;
restart after dispatch with unknown result; and a response lost after durable
success, retrieved without re-invocation.

- [ ] **Step 2: Run red.** `node --test tests/ask-service.test.mjs tests/browser-runtime-ask.test.mjs`.
- [ ] **Step 3: Implement a separate inference flow.** Do not call `sendMessage()`, `submitTask()`, `#runTask()`, or `CeoWorkspace.receive()`. Add the exact output schema:

```js
const askOutputSchema = {
  type: 'object',
  properties: { answer: { type: 'string', minLength: 1, maxLength: 16384 } },
  required: ['answer'],
  additionalProperties: false,
}
```

Validate the response at runtime even when a provider claims schema enforcement.
Use a model-invocation-only signed grant and the existing reliable model ledger;
the inference route cannot have a dispatcher/tool callback. Add one serialized
conversation request record before dispatch, a content/destination hash for
idempotency, and a bounded status projection; a pending request restored after
restart is unknown, not automatically replayed. Redact persisted content using
the existing policy without fabricating an answer.

Plain inference adapters may opt in when their implementation sends no tool
definitions and executes no native tools. Codex's current `sandboxMode:
'read-only'` is not proof of zero native tools. Antigravity's native route is
not eligible. Do not silently move a pinned agent to a different provider;
explain that Start work or an explicitly changed model is required. A future
documented no-tool SDK adapter is a separate verified capability, not assumed.

- [ ] **Step 4: Run green.** Run the four Task 3 tests plus `tests/reliable-model-router.test.mjs` and `tests/ceo-workspace.test.mjs`. Verify signed invocation, no inference on GET, and no automatic retry after unknown dispatch.
- [ ] **Step 5: Independent review including executable-provider rejection.**

## Task 4: guided Add agent and one Connections workspace

**Phases:** 1 and 2 complete; depends on Tasks 1–3.

**Files:**

- Create: `src/agents/readiness.mjs`, `src/agents/readiness-store.mjs`, `app/src/AgentSetupWizard.jsx`, `app/src/ConnectionsWorkspace.jsx`, `app/src/agent-setup.css`.
- Modify: `src/browser/runtime.mjs`, `src/browser/server.mjs`, `app/src/App.jsx`, existing model/access picker integration.
- Test: `tests/agent-readiness.test.mjs`, `tests/agent-setup-rendered.test.mjs`, `tests/connections-rendered.test.mjs`, `tests/agent-updates-rendered.test.mjs`.

**Interfaces:**

- `buildAgentReadiness({ manifest, continuity, selection, access, executor, verification })` returns `{ schema: 'chimera.agent-readiness.v1', agentId, status, fingerprint, checks, lastTest }`; statuses are `blocked`, `configured`, or `verified`; each check is `pass`, `blocked`, or `unknown` with its exact scope.
- `DurableAgentReadinessStore.open({ filePath, audit, now })`; `record({ agentId, fingerprint, requestId, scope, status, observedAt })`; `latest(agentId)`. The bounded, mode-0600 store retains test receipts only, never answers/persona/tokens. Successful Ask verification is recorded with `scope: 'inference-only'`; unknown remains unknown across restart. A changed fingerprint makes a prior success historical.
- `runtime.agentReadiness({ agentId })` is local/cached and non-invoking; `POST /api/agents/readiness` performs that check. `POST /api/agents/test` accepts `{ agentId, requestId, expectedFingerprint, allowQuotaUse: true }` and performs exactly one pure inference verification via Task 3; unsupported native Ask modes explain that no test was sent.
- `<AgentSetupWizard state={state} onClose={fn} onComplete={fn} refresh={fn} />` uses existing `post()` with explicit steps: source, identity/continuity, model/executor, access, check/test/save.
- `<ConnectionsWorkspace connections={rows} returnTarget={target} onReturn={fn} refresh={fn} />` renders only supported actions and returns to the unchanged task/agent context.

- [ ] **Step 1: Add the failing fingerprint/readiness test.**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildAgentReadiness } from '../src/agents/readiness.mjs'

test('setup validity does not claim model or executor verification', () => {
  const value = buildAgentReadiness({
    manifest: { agentId: 'ace', role: 'Review', capabilities: ['coding'] },
    continuity: { status: 'materialized', digest: 'a'.repeat(64) },
    selection: { status: 'eligible', providerId: 'fixture', model: 'small', connectionRevision: 1 },
    access: { profileId: 'sandbox', changedAt: '2026-09-18T00:00:00.000Z' },
    executor: { kind: 'harness', status: 'task-bound' }, verification: null,
  })
  assert.equal(value.status, 'configured')
  assert.equal(value.lastTest, null)
  assert.equal(value.checks.find(row => row.name === 'execution').status, 'unknown')
})
```

Rendered fixtures cover create and Hermes import, editable overrides, reserved
RJ, stale discovery preview, missing source, no automatic POST on render, no
model call on selection/check, explicit quota-use confirmation, duplicate-click
single flight, changed-fingerprint invalidation, and failure without lost inputs.
At 390/768/1440/2560-pixel widths verify dialog/card overflow and keyboard focus.

- [ ] **Step 2: Run red.** `node --test tests/agent-readiness.test.mjs tests/agent-setup-rendered.test.mjs tests/connections-rendered.test.mjs`.
- [ ] **Step 3: Implement the guided UI and readiness projection.** Derive, rather than invent, an executor choice. Imported workers are task-bound; starting the existing unbound standalone worker is not a readiness test. Keep Auto/Preferred/Pinned and Sandbox/Connected/Live controls. The final status uses this distinction:

```js
const hasBlocker = checks.some(check => check.status === 'blocked')
const currentTest = verification?.fingerprint === fingerprint
  && verification?.status === 'passed'
const status = hasBlocker ? 'blocked' : currentTest ? 'verified' : 'configured'
```

Label what the test verified (inference response, not all tools). The fingerprint
covers continuity digest, metadata, model preference, connection revision,
executor identity, and access policy. Task 3 failure/ambiguity rules apply.
Render all continuity counts/exclusions and explicit unresolved dependencies.
Retain model catalog and provider-specific advanced details in Settings, removing
duplicate connection controls only after their functions are represented.
Reuse existing styles/avatars; no new UI framework or generated artwork.

- [ ] **Step 4: Run green and legacy UI regressions.** Add `tests/workspace-navigation.test.mjs`, `tests/antigravity-ui.test.mjs`, and `tests/rj-aws-ui.test.mjs` to the new rendered suite. Inspect screenshots, not only assertions.
- [ ] **Step 5: Independent review and main-agent visual inspection.**

## Task 5: destination-bound drafts, explicit New task, and mentions

**Phase:** 3 complete; depends on Tasks 1–4.

**Files:**

- Create: `app/src/conversation-target.js`, `app/src/draft-store.js`, `app/src/ConversationComposer.jsx`, `app/src/conversation-composer.css`.
- Modify: `app/src/App.jsx`, `app/src/TaskRoomControls.jsx`, `app/src/TaskControls.jsx`, `src/ceo/task-ledger.mjs`, `src/browser/runtime.mjs`, `src/browser/server.mjs`.
- Test: `tests/conversation-target.test.mjs`, `tests/draft-store.test.mjs`, existing `tests/command-target-rendered.test.mjs`, `tests/command-recovery-rendered.test.mjs`, `tests/task-room-rendered.test.mjs`, and `tests/browser-runtime-tasks.test.mjs`.

**Interfaces:**

- `draftKey({ workspaceId, operatorId, mode, conversationId, taskId, recipientAgentIds, replyTo })` returns a stable key with sorted recipient IDs. Modes: `new-task`, `ask`, `guidance`, `continuation`.
- `createDraftStore({ storage, scope, now })` exposes `get(target)`, `save(target, draft)`, `remove(target)`, `clearScope()`; draft includes content, budget, destination revision, request ID, and `draft|sending|accepted|unconfirmed` status. Use bounded sessionStorage with an in-memory fallback and an explicit persistence warning.
- `resolveComposerTarget({ selection, mode, recipients, state })` derives a proposed target from the selected room/agent, never from `currentTask()`; it cannot mutate an existing draft's bound destination.
- New-task submission uses existing `POST /api/tasks` with explicit `queue: true` when requested. Extend ordinary task queue admission to the same maximum 32, one running root task, and restart-resume safeguards; do not make new root tasks run concurrently.
- Task/guidance submission accepts optional `{ requestId, expectedDestinationRevision }`; new UI sends both. The server persists request identity/destination hash and returns its existing receipt on exact duplicates, rejecting collisions.

- [ ] **Step 1: Add the failing stable-destination test.**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { draftKey } from '../app/src/draft-store.js'

test('drafts do not collide across task, agent, intent, or operator', () => {
  const base = { workspaceId: 'local-fixture', operatorId: 'owner', mode: 'guidance',
    conversationId: 'task:alpha', taskId: 'alpha', recipientAgentIds: ['ace'], replyTo: null }
  assert.notEqual(draftKey(base), draftKey({ ...base, taskId: 'beta', conversationId: 'task:beta' }))
  assert.notEqual(draftKey(base), draftKey({ ...base, mode: 'ask' }))
  assert.notEqual(draftKey(base), draftKey({ ...base, operatorId: 'other' }))
  assert.equal(draftKey({ ...base, recipientAgentIds: ['ace', 'iris'] }),
    draftKey({ ...base, recipientAgentIds: ['iris', 'ace'] }))
})
```

Replace tests intentionally asserting the old global-dock destination with tests
for selected-room behavior; retain their no-silent-rebinding/no-auto-send cases.
Test deleted/completed tasks, removed agent, stale response arriving after a
selection switch, reload with `sending` restored as `unconfirmed`, corrupted or
full sessionStorage, logout cleanup, and unknown POST acknowledgements.

- [ ] **Step 2: Run red.** Run the new pure tests and existing command-target/recovery rendered tests with new assertions.
- [ ] **Step 3: Implement the target-first composer.** Selecting New task changes only local state. Ask calls `/api/conversations/ask`; Start work calls `/api/tasks`; task guidance keeps existing steer/message paths; explicit continuation keeps its existing endpoint. Do not infer send mode from whether another task is running.

```js
const endpointByMode = {
  ask: '/api/conversations/ask',
  'new-task': '/api/tasks',
  continuation: '/api/tasks/continue',
}
const guidanceEndpoint = target.recipientAgentIds.length
  ? '/api/tasks/message' : '/api/tasks/steer'
const endpoint = target.mode === 'guidance' ? guidanceEndpoint : endpointByMode[target.mode]
```

The button states the real action/destination. Use keyboard-accessible mention
suggestions sourced from eligible IDs; ambiguous display names require choosing
a suggestion. Recipient chips are authoritative metadata, not raw `@text`.
Changing mode/recipients selects a separate draft or requires explicit rebind;
never silently moves existing text to new recipients. Persistence limit is 50
drafts of at most 16 KiB each; prune empty/acknowledged drafts, never silently
discard unsent text to make room. A lost acknowledgement offers status/history
lookup, not resubmission. Keep errors and drafts even when refreshing state fails.

- [ ] **Step 4: Run green.** Run all Task 5 tests, `tests/task-controls-recovery-rendered.test.mjs`, and `tests/task-message-api.test.mjs`. Verify ordinary queued tasks retain explicit restart resumption and project admission rules.
- [ ] **Step 5: Independent review of cross-target and double-submit cases.**

## Task 6: structured, explainable routing with honest measurements

**Phase:** 4; depends on connection state, agent metadata, and explicit task intent.

**Files:**

- Create: `src/ceo/task-requirements.mjs`, `src/ceo/routing-evidence.mjs`.
- Modify: `src/ceo/task-aware-model-router.mjs`, `src/ceo/local-model-fabric.mjs`, `src/ceo/gateway-model-router.mjs`, `src/ceo/reliable-model-router.mjs`, `src/browser/runtime.mjs`, `app/src/TaskControls.jsx`, `app/src/ConversationComposer.jsx`.
- Test: `tests/task-requirements.test.mjs`, `tests/routing-evidence.test.mjs`, `tests/task-aware-model-router.test.mjs`, `tests/local-model-fabric.test.mjs`, `tests/browser-runtime-model-controls.test.mjs`, and new `tests/gateway-model-router.test.mjs`.

**Interfaces:**

- `normalizeTaskRequirements(input, legacyContext)` produces `chimera.task-requirements.v1` with bounded `capabilities`, `inputModalities`, `outputModalities`, `requiredTools`, `minContextTokens`, `privacy`, `priorityPreset`, `modelPreference`, and `maxEstimatedUsd`. Missing constraints remain unspecified, not asserted capabilities.
- Presets are `balanced`, `quality`, `latency`, `economy`. Privacy is `approved-providers` or `local-only`. `modelPreference` has the existing Auto/Preferred/Pinned shape and cannot supersede a stricter agent pin.
- `RoutingEvidenceStore.open({ filePath, audit, now })`; `recordInvocation({ providerId, model, capability, outcome, durationMs, cost })`; `snapshot({ providerId, model, capability })`. Outcomes are `succeeded`, `failed-not-sent`, and `unknown`; cost is null or `{ usd, source: 'measured'|'operator-estimate', evidenceRef }`.
- `createTaskAwareModelRouter()` accepts normalized route descriptors plus a trusted `eligibility(route, { requirements, context })` callback returning `{ connectionEnabled, agentAllowed, executorAllowed, requirementsSatisfied, pinSatisfied, reasons }`, and adds `explain({ requirements, context })`. `route(prompt, context, controls)` keeps its current result contract and uses the same eligibility/ranking path as `explain()`. The callback is supplied by runtime code, never accepted from an API request or model response.
- Explanation: `{ schema: 'chimera.routing-explanation.v1', taskId, selected, candidates, reasons, evidence, observedAt }`; candidates carry `eligible|rejected|unknown` and specific reasons, without prompt/provider secrets.

- [ ] **Step 1: Add the failing hard-filter/pin test.**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeTaskRequirements } from '../src/ceo/task-requirements.mjs'

test('requirements preserve a strict pin and separate generation from conversation', () => {
  const value = normalizeTaskRequirements({ capabilities: ['image-generation'],
    outputModalities: ['IMAGE'], requiredTools: [], priorityPreset: 'economy',
    modelPreference: { mode: 'pinned', providerId: 'fixture', model: 'image-1' } }, {})
  assert.equal(value.schema, 'chimera.task-requirements.v1')
  assert.equal(value.modelPreference.mode, 'pinned')
  assert.deepEqual(value.outputModalities, ['IMAGE'])
  assert.throws(() => normalizeTaskRequirements({ requiredTools: ['bash'], grant: 'allow-all' }, {}))
})
```

Extend route fixtures with incompatible modalities, disabled connections,
missing executor/tool evidence, unknown context capacity, unavailable pinned
models, and conflicting task/agent pins. Assert zero provider calls before a
hard-filter failure and no alternate call after ambiguous dispatch. Test all
presets with known fixtures, unknown cost not ranked as zero, real invocation
latency/reliability restoration, and task-specific explanations.

- [ ] **Step 2: Run red.** Run the six Task 6 tests after adding assertions.
- [ ] **Step 3: Implement eligibility before ranking.** Trusted runtime policy supplies eligible agents, connection revisions, executor identity/tool scopes, and native execution boundaries. Model-proposed requirements may narrow choices, not grant authority. The operator's task request is captured at admission; updates affect only new work or explicit continuation.

```js
const eligible = candidates.filter(candidate =>
  candidate.connectionEnabled
  && candidate.agentAllowed
  && candidate.executorAllowed
  && candidate.requirementsSatisfied
  && candidate.pinSatisfied)
if (eligible.length === 0) {
  throw createTrustedModelCallNotSentError('No eligible model route', {
    code: 'NO_ELIGIBLE_MODEL_ROUTE',
  })
}
```

Use the existing trusted-error factory. Do not serialize signals, credentials,
runtime proof objects, or mutable controls into model context. Preserve signal
and progress forwarding through all wrappers used by the runtime.
Test the complete wrapper chain: only a Chimera-owned, proven pre-dispatch
eligibility rejection can retain `not_sent`; provider/SDK-originated errors,
including forged `dispatchState` fields, remain unknown. Do not make a generic
catch treat provider exceptions as retryable in order to satisfy the UI.

Manual routes use provider/config-declared capabilities and modalities instead
of an invented universal capability list. Known Codex/fixture route capabilities
can be declared explicitly; unknown discovered models remain unknown for
required features. Legacy stage/taskKind/costPreference are normalized only
when structured requirements are absent.

Ranking is deterministic: Balanced uses configured priority, then observed
success ratio (at least five resolved samples), observed median latency (at
least three successful samples), then stable route ID. Prefer speed prioritizes
the observed latency term; Prefer lower cost prioritizes comparable measured or
operator-estimated cost; Prefer quality uses `priorityByPreset.quality` when
explicitly configured, otherwise the declared default priority. Label quality
as declared/unknown, never a measured benchmark without an evaluator receipt.
Unknown metrics sort after known comparable metrics, not as zero or perfect.
An enforced cost constraint with no credible bounded estimate is ineligible.

Expose selected agent/model/executor and a short reason in task details, with
rejected candidates under Details. Retain distinct media adapters and pre-
dispatch-only Preferred fallback. Instrument actual invocations only; do not
generate evaluations or paid probes in the background.

- [ ] **Step 4: Run green.** Run Task 6 tests plus reliable-model-router, gateway-model-router, and task-control regression suites. Verify all new measurements are bounded and redact source text.
- [ ] **Step 5: Independent routing/authority review.**

## Task 7: durable real plans and task-bound decisions

**Phase:** 5 foundation; also closes Phase 6 attribution requirements.

**Files:**

- Create: `src/ceo/task-plan.mjs`.
- Modify: `src/ceo/task-ledger.mjs`, `src/ceo/workspace.mjs`, `src/ceo/structured-model-output.mjs`, `src/ceo/decisions.mjs`, `src/browser/runtime.mjs`.
- Test: `tests/task-plan.test.mjs`, `tests/task-ledger.test.mjs`, `tests/ceo-workspace.test.mjs`, `tests/ceo-decisions.test.mjs`, `tests/browser-runtime-task-control.test.mjs`.

**Interfaces:**

- `normalizeTaskPlan(input, { eligibleAgentIds })` returns `{ schema: 'chimera.task-plan.v2', tasks }`: at most eight nodes with `nodeId`, `specialistAgentId`, `objective`, `acceptanceCriteria`, `dependsOn`, normalized optional `requirements`, and optional proposed `resources`. Resource declarations are untrusted proposals. The ledger stores this `tasks` array as `plan.nodes` for the workspace projection.
- Legacy plans receive deterministic `step-1` IDs and sequential predecessor dependencies. Duplicate IDs, missing/self dependencies, and cycles fail before handoff.
- `DurableTaskLedger.recordPlan(taskId, { revision, planHash, nodes })`; `recordStep(taskId, { revision, nodeId, status, messageId, resultId, reason })`. Step statuses: `queued`, `running`, `waiting-for-approval`, `completed`, `blocked`, `failed`, `cancelled`, `unknown`.
- Task records expose `plan` and bounded step history independent of the latest checkpoint. Stale revisions cannot replace a newer plan or modify its steps.
- Decision records gain optional validated `taskId`/`nodeId` from the trusted signed action/runtime. Legacy absent fields stay null/unattributed; no matching by agent name or timestamp.

- [ ] **Step 1: Add the failing graph validation test.**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeTaskPlan } from '../src/ceo/task-plan.mjs'

test('a cyclic plan fails before any specialist handoff', () => {
  const node = (nodeId, specialistAgentId, dependsOn) => ({ nodeId,
    specialistAgentId, objective: 'Review bounded evidence.',
    acceptanceCriteria: ['Return evidence.'], dependsOn })
  assert.throws(() => normalizeTaskPlan({ tasks: [
    node('a', 'ace', ['b']), node('b', 'iris', ['a']),
  ] }, { eligibleAgentIds: ['ace', 'iris'] }), { code: 'TASK_PLAN_CYCLE' })
})
```

Add legacy sequential normalization, eight-node bound, duplicate/unknown IDs,
task ledger reopen, concurrent step writes, stale revision rejection, and invalid
terminal transitions. Post/restore decisions for two tasks and one legacy record;
assert only exact task IDs appear in each task's approvals. Preserve exact action
diff/hash and approval-expiry regressions from the security patch.

- [ ] **Step 2: Run red.** `node --test tests/task-plan.test.mjs tests/task-ledger.test.mjs tests/ceo-workspace.test.mjs tests/ceo-decisions.test.mjs tests/browser-runtime-task-control.test.mjs`. `tests/ceo-decisions.test.mjs` is a new focused test file for this task.
- [ ] **Step 3: Persist plan and attribution at existing hooks.** Validate the full graph before `onPlan`; persist it before dispatch. Extend model output schemas with bounded DAG fields while runtime still accepts legacy plans. The `onPlan` hook already exists in the CEO runtime; use it rather than inventing a second plan source.

```js
await tasks.recordPlan(taskId, { revision, planHash, nodes: normalized.tasks })
await tasks.recordStep(taskId, { revision, nodeId, status: 'queued' })
```

Validate/audit every transition and keep schema restore deterministic. On
restart, running/unknown work is retained and fenced, not replayed. A derived
UI plan never authorizes work. Copy task identity from the signed action to
`decisions.post()` at every producer, including tool/browser decisions; new
request bodies cannot override that trusted identity. Legacy unbound approvals
remain in global Needs you, explicitly unattributed.

- [ ] **Step 4: Run green.** Run Task 7 tests and `tests/decision-dialog-rendered.test.mjs`, `tests/browser-runtime-restart.test.mjs`, and task-control ledger regressions.
- [ ] **Step 5: Independent schema migration, restart, and attribution review.**

## Task 8: conservative dependency-aware parallel specialists

**Phase:** 5 scheduling; depends on Tasks 6–7.

**Files:**

- Create: `src/agents/plan-resources.mjs`.
- Modify: `src/agents/team-dispatcher.mjs`, `src/ceo/workspace.mjs`, `src/browser/runtime.mjs`.
- Test: `tests/plan-resources.test.mjs`, `tests/team-dispatcher.test.mjs`, `tests/ceo-workspace.test.mjs`, `tests/browser-runtime-task-control.test.mjs`.

**Interfaces:**

- `resourcesConflict(left, right)` evaluates trusted resource claims `{ key, access: 'read'|'write', verified: true }`; null/unknown claims conflict with everything. Ancestor/descendant keys conflict for writes, while unrelated token prefixes do not.
- `planNodeReadiness({ node, states, heldResources, claims })` returns `blocked`, `waiting`, or `ready`. Its state map and resource claims come only from dispatcher/runtime state; readiness is a scheduling decision, not authorization.
- `TeamDispatcher.dispatchPlan({ tasks, planHash, revision, assertProposalCurrent, resolveResources, onStep })` returns results in normalized plan order. `resolveResources(node)` is a runtime callback, never model code; unknown authority/ownership returns null.
- `CeoWorkspace` accepts optional `dispatchPlan`; existing `dispatchTask` remains a sequential compatibility path.
- Existing per-agent locks, global execution cap four, dynamic peer wait-cycle detection, message reservation/depth limits, cancellation, and physical-settlement guarantees remain active. Project tasks keep `maxExecuting: 1` until separately proven isolated worktree ownership exists.

- [ ] **Step 1: Add the failing conservative-resource test.**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { resourcesConflict } from '../src/agents/plan-resources.mjs'

test('unknown and ancestor write resources cannot be parallelized', () => {
  const claim = (key, access) => ({ key, access, verified: true })
  assert.equal(resourcesConflict(null, [claim('workspace:other', 'read')]), true)
  assert.equal(resourcesConflict([claim('workspace:repo/src', 'write')],
    [claim('workspace:repo/src/app.js', 'read')]), true)
  assert.equal(resourcesConflict([claim('workspace:repo', 'read')],
    [claim('workspace:repo', 'read')]), false)
  assert.equal(resourcesConflict([{ key: 'workspace:one', access: 'read', verified: false }],
    [claim('workspace:two', 'read')]), true)
})
```

Extend the existing dispatcher fixture/gates to prove at least two independent
nodes overlap, maximum four, same-agent and shared-write serialization, ready
dependency ordering, failed/unknown predecessor blocking, preserved plan-order
results, and no rerun of completed nodes. Exercise steering during mailbox
delivery/claim, cancellation with delayed physical settlement, projection or
fsync failure, and parent peer asks that would deadlock on retained resources.

- [ ] **Step 2: Run red.** `node --test tests/plan-resources.test.mjs tests/team-dispatcher.test.mjs tests/ceo-workspace.test.mjs`.
- [ ] **Step 3: Extend the existing dispatcher pump.** Do not create another worker pool. Node readiness is the conjunction of all existing guards and these new conditions:

```js
export function planNodeReadiness({ node, states, heldResources, claims }) {
  if (node.dependsOn.some(id => ['blocked', 'failed', 'cancelled', 'unknown'].includes(states.get(id)))) return 'blocked'
  if (!node.dependsOn.every(id => states.get(id) === 'completed')) return 'waiting'
  if (heldResources.some(held => resourcesConflict(claims, held))) return 'waiting'
  return 'ready'
}
```

Resource claims must come from validated requests, known workspace bindings,
and enforcing adapters. Never trust the model's `resources` list as proof. A
native executor or arbitrary bounded work loop with unprovable future resource
use remains exclusive. Hold claims until executor settlement, even when a wait
timeout already returned an unknown result. A parent/child peer call conflicting
with a retained resource claim fails before execution with
`TEAM_RESOURCE_DEPENDENCY_CYCLE`; do not deadlock or silently release the lock.

Persist step transitions and use runtime-generated model/executor/plan IDs for
evidence. Do not allow model output to populate proof fields. Recheck proposal
revision and cancellation at each awaited claim boundary.

- [ ] **Step 4: Run green.** Run Task 8 tests plus all task-control/steering and budget tests. Independently inspect the asynchronous barrier assertions rather than relying only on timing sleeps.
- [ ] **Step 5: Independent concurrency and security-boundary review.**

## Task 9: one selected-task workspace

**Phase:** 5 UI complete; depends on Tasks 5–8.

**Files:**

- Create: `src/ceo/task-workspace-projection.mjs`, `app/src/TaskWorkspace.jsx`, `app/src/task-workspace.css`.
- Modify: `src/browser/runtime.mjs`, `src/browser/server.mjs`, `app/src/App.jsx`, `app/src/ProjectTaskResults.jsx`, `app/src/TaskRoomControls.jsx`.
- Test: `tests/task-workspace-projection.test.mjs`, `tests/task-workspace-api.test.mjs`, `tests/task-workspace-rendered.test.mjs`, `tests/project-results-rendered.test.mjs`.

**Interfaces:**

- `buildTaskWorkspace({ taskId, task, plan, team, messages, decisions, leases, session, review, artifacts, browserBindings, routing })` is a pure bounded projection. Mismatched task input fails `TASK_WORKSPACE_MISMATCH`; every collection is filtered by trusted task identity.
- `runtime.taskWorkspace(taskId)` returns `{ schema: 'chimera.task-workspace.v1', task, plan, team, conversation, permissions, approvals, files, results, browser, routing, evidence, recovery }`. Phase 6 fills evidence/recovery; until then those are explicitly unavailable, not optimistic.
- `GET /api/tasks/:taskId/workspace` is authenticated and read-only. It never runs a model, loads a project review by executing Git, starts a worker, or takes browser control.
- `<TaskWorkspace taskId={id} onNavigate={fn} onDestinationChange={fn} refresh={fn} />` reads the task-specific endpoint; selection changes abort/ignore old requests.

- [ ] **Step 1: Add the failing cross-task filtering test.**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTaskWorkspace } from '../src/ceo/task-workspace-projection.mjs'

test('unbound and other-task approvals never appear as this task approval', () => {
  const value = buildTaskWorkspace({ taskId: 'alpha', task: { taskId: 'alpha', status: 'running' },
    decisions: [{ actionId: 'a', taskId: 'alpha' }, { actionId: 'b', taskId: 'beta' }, { actionId: 'legacy' }],
    messages: [], leases: [], artifacts: [], browserBindings: [], routing: [] })
  assert.deepEqual(value.approvals.map(row => row.actionId), ['a'])
  assert.equal(value.browser, null)
  assert.throws(() => buildTaskWorkspace({ taskId: 'alpha', task: { taskId: 'beta' } }),
    { code: 'TASK_WORKSPACE_MISMATCH' })
})
```

Test stale HTTP replies after task switches, failures retaining the last known
view with a stale label, correct plan revision, no cross-task reports/artifacts,
unloaded versus empty review, unbound browser state, and GET side-effect spies.
Render every status with long names/objectives, many teammates, and keyboard
only input. Verify all navigation destinations remain reachable.

- [ ] **Step 2: Run red.** Run the four Task 9 tests with fixture-only adapters.
- [ ] **Step 3: Compose existing surfaces around the selected task.** Replace the generic TaskPlan illustration with real recorded nodes. Show summary, progress/blocker, conversation/composer, and results first; Team, Files, Decisions, Browser, and Details are contextual tabs/disclosures. Include the routing explanation from Task 6.

```js
const approvals = decisions.filter(row => row.taskId === taskId)
const conversation = messages.filter(row => row.taskId === taskId
  && row.conversationId === `task:${taskId}`)
const browser = browserBindings.find(row => row.taskId === taskId) ?? null
```

Do not infer browser ownership from the globally active tab. Unbound sessions
remain available in Browser but are labeled global/unattributed. Existing human
takeover actions remain explicit and exclusive. File review is loaded only by
its explicit existing action, then retained with observation time/digest; stale
review cannot look current. Signed provenance identifies attribution, not the
truth of the agent's conclusions. Raw events/deliveries remain under Details.

- [ ] **Step 4: Run green and inspect screenshots.** Run Task 9 tests and navigation, task-room, queue selection, project results, and browser takeover regressions. Inspect 390/768/1440/2560-pixel views for clipping and functional focus order.
- [ ] **Step 5: Independent UX/data-attribution review.**

## Task 10: actionable permissions, safe recovery, and evidence-based outcomes

**Phase:** 6; depends on Tasks 1–9.

**Files:**

- Create: `src/ceo/task-outcomes.mjs`, `src/ceo/task-recovery.mjs`, `app/src/TaskOutcome.jsx`.
- Modify: `src/ceo/task-ledger.mjs`, `src/browser/runtime.mjs`, `src/ceo/task-workspace-projection.mjs`, `app/src/TaskControls.jsx`, `app/src/TaskWorkspace.jsx`, decision-dialog presentation in `App.jsx`.
- Test: `tests/task-outcomes.test.mjs`, `tests/task-recovery.test.mjs`, `tests/task-outcome-rendered.test.mjs`, `tests/task-controls-recovery-rendered.test.mjs`, `tests/decision-dialog-rendered.test.mjs`.

**Interfaces:**

- `deriveTaskOutcomes({ task, receipts, review, currentRevision })` returns separate `workProduced`, `checksPassed`, `readyForReview`, and `published` objects with state, evidence references, observed time, and precise scope.
- `DurableTaskLedger.recordEvidence(taskId, receipt)` persists allowlisted runtime-issued receipts. A receipt includes `{ receiptId, kind, taskId, source, operationId, revision, observedAt, outcome, evidenceRef }`; kind is `artifact`, `check`, `review`, or `publication`. No public endpoint accepts a model/user assertion as a verified receipt.
- `classifyTaskRecovery({ task, modelCalls, steps = [], approvals, connection, cleanup })` returns `{ state, summary, retained, actions, retryAllowed }`; actions come from fixed supported UI operations. Inspect every step's effect state, not just the latest checkpoint, so one parallel success cannot hide another step's unknown outcome.
- `<TaskOutcome workspace={projection} onAction={fn} />` renders those fields and an expandable technical explanation without deriving success from prose.

- [ ] **Step 1: Add the failing prose-is-not-evidence test.**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveTaskOutcomes } from '../src/ceo/task-outcomes.mjs'
import { classifyTaskRecovery } from '../src/ceo/task-recovery.mjs'

test('completed prose cannot claim verified checks or publication', () => {
  const task = { taskId: 'alpha', status: 'completed', summary: 'Tests passed and deployed.' }
  const value = deriveTaskOutcomes({ task, receipts: [], review: null, currentRevision: null })
  assert.equal(value.checksPassed.state, 'not-run')
  assert.equal(value.published.state, 'not-published')
  assert.equal(value.readyForReview.state, 'not-reviewed')
})

test('an unknown dispatched call has no retry action', () => {
  const value = classifyTaskRecovery({ task: { taskId: 'alpha', status: 'failed' },
    modelCalls: [{ status: 'ambiguous' }], approvals: [], connection: null, cleanup: null })
  assert.equal(value.retryAllowed, false)
  assert.equal(value.actions.some(action => action.id === 'retry'), false)
})
```

Add genuine receipt, invalid source, other-task receipt, stale revision, failed
required check, unverified publication, source commit versus publication,
expired approval, task interruption, queued-after-restart, cleanup-blocked,
stale review, disconnected provider, and lost workspace-read tests. Negative
cases must not invoke task/model/tool APIs on render or navigation.

- [ ] **Step 2: Run red.** Run the five Task 10 tests with new assertions.
- [ ] **Step 3: Implement conservative outcomes and recovery actions.** Record check receipts from actual bounded executor/check results with command/scope, exit status, and revision—not from an agent's reported summary. Artifact receipts prove materialization, not correctness. Review is ready only with the current review digest. Publication needs an actual publishing adapter receipt and a current-path verification receipt; a Git commit alone never qualifies. If no publishing adapter supplied evidence, the state stays not-published/unverified.

```js
const unknownEffect = modelCalls.some(call => ['started', 'ambiguous'].includes(call.status))
  || steps.some(step => step.status === 'unknown' || step.effectOutcome === 'unknown')
  || task.checkpoint?.effectOutcome === 'unknown'
const retryAllowed = !unknownEffect && task.failure?.dispatchState === 'not_sent'
```

Extend task failure persistence with a bounded `dispatchState` copied only from
trusted runtime/model-call classification (`not_sent` or `unknown`), preserving
legacy absent values as unknown. Never accept it from a provider's free-form
error or a public request. Use that persisted classification, not error text. Expose
Inspect retained work, Reconnect, Reconcile where a provider supports it,
Resume queued work, Explicit continuation, and Retry reading as distinct
actions. Reconnection never resumes/resends work automatically. Every mutation
rechecks current task state server-side, even if the displayed button is stale.
Retain accepted-POST versus failed-refresh distinctions and single-flight IDs.

Access summaries use real agent access profile, task lease ceilings/hosts/tools,
expiry, and executor identity. Antigravity retains its native-permission warning.
Approvals reuse the exact immutable action display and expiry checks from the
security patch. Do not summarize away the authoritative target/action fields.
Details may show technical codes, but the first message explains what happened,
what remains, and the safe next action.

- [ ] **Step 4: Run green and restart integration.** Run Task 10 tests plus model-call reliability, task ledger, restart, exact-approval, and command-recovery suites. Verify no resend of an uncertain external effect and no publication label from a commit.
- [ ] **Step 5: Independent recovery and evidence-integrity review.**

## Task 11: integrated acceptance, accessibility, and accurate handoff docs

**Phases:** all six acceptance; depends on Tasks 1–10.

**Files:**

- Create: `tests/agent-workspace-acceptance.test.mjs`, `tests/agent-workspace-rendered.test.mjs`.
- Modify: `docs/AGENT_REGISTRY.md`, `docs/AGENT_HARNESS.md`, `docs/CEO_WORKSPACE.md`, `docs/MODEL_PROVIDERS.md`, `docs/ADE_WORKSPACE.md`, and relevant README onboarding links.
- Review: existing security-regression files without changing their guarantees.

**Interfaces:** no new production interfaces. This task consumes the preceding contracts and proves the complete user journey rather than adding another feature layer.

- [ ] **Step 1: Add the failing end-to-end fixture assertions.** Extend the existing deterministic runtime and Playwright HTTP-boundary fixture patterns, with all directories created by `mkdtemp` and all providers/browser/remote workers injected. Register cleanup only for exact fixture-owned paths.

```js
assert.equal(connection.status, 'available')
assert.equal(created.agent.agentId, 'test-builder')
assert.equal(readiness.lastTest, null)
assert.equal(askResult.status, 'completed')
assert.equal(toolCallsDuringAsk, 0)
assert.equal(taskWorkspace.plan.nodes.length, 2)
assert.equal(taskWorkspace.approvals.every(row => row.taskId === taskId), true)
assert.equal(restoredTask.retryable, false)
assert.equal(restoredDraft.status, 'unconfirmed')
assert.equal(resendCount, 0)
assert.equal(result.evidence.checksPassed.state, 'passed')
assert.equal(result.evidence.published.state, 'not-published')
```

These variables are outputs of the fixture sequence: safe connection discovery;
native create and separate Hermes import; metadata/model/access selection;
explicit pure Ask; two-node signed work plan; a bounded tool action requiring
approval; restart while an approval is pending; retained draft/task/evidence;
explicit safe continuation under a fresh approval; actual fixture check receipt;
final operator review. Restart must orphan the old approval and never execute
it or a queued step automatically. Add a second failure-path run with unknown
provider/tool outcome and no continuation that blindly replays that effect.

- [ ] **Step 2: Run the acceptance tests before polishing failures.** `node --test tests/agent-workspace-acceptance.test.mjs tests/agent-workspace-rendered.test.mjs`.
- [ ] **Step 3: Complete accessibility/docs against the implemented behavior.** Keyboard through Add agent, Connections, composer mentions, task tabs, approval, and recovery. Check visible focus, labels, aria-live feedback, dialog focus restoration, 200% zoom, long text, and no horizontal overflow at 390/768/1440/2560 pixels. Browser actions must stay usable with human takeover. Fix defects in their owning task through its implementer and re-review the changed scope.

Update docs to the actual Team/Settings navigation, native/import source rules,
connection lifecycle and local disconnect semantics, Ask's provider capability
boundary, task-bound drafts, structured routing, conservative parallelism, and
evidence stages. Remove obsolete claims of page-local-only drafts or a global
execution-selected composer. Keep limitations explicit; no claim of iMac/live
account verification or a published release from fixture results.

- [ ] **Step 4: Run final integrated verification.**

```sh
npm test
npm run build
npm run pilot:ade-acceptance
npm audit --omit=dev
git diff --check
```

Inspect actual totals, failures, skips, screenshots, and build artifacts. Run
Linux Bubblewrap/security tests in a supported Linux environment when available;
report unavailable platform/security checks as unverified, never passed. Do not
provision infrastructure or spend money to make a test green. Keep the existing
security patch's release blockers visible until its required checks genuinely
pass.

- [ ] **Step 5: Fresh whole-change Luna Max review, main-agent verification, and handoff.** Check spec coverage, source/test diffs, dependency/interface consistency, route/request authority, and rendered state. Resolve findings through the owning implementer; conduct one focused re-review of fixes. Report each phase as implemented/tested or blocked with concrete evidence. Commit, push, CI, live account acceptance, and deployment are separate stages requiring authorization/evidence, not synonyms for local completion.

## Phase coverage checklist

| Approved phase | Owning tasks | Required proof |
| --- | --- | --- |
| 1. Add/import/edit/test agents | 2, 4 | Native + Hermes paths, continuity report, metadata, invalidation, restart |
| 2. Connections | 1, 4 | Capability-backed actions, safe/account/model distinctions, durable dispatch fence |
| 3. Conversations | 3, 5 | Zero-tool Ask, direct specialist identity, selected destination, mentions, durable drafts, explicit new work |
| 4. Routing | 6 | Hard eligibility, strict pins, honest evidence, presets, task-bound explanations |
| 5. Task workspace | 7, 8, 9 | Real durable plan, exact approvals, independent concurrency, conflict serialization, focused results/browser |
| 6. Recovery/completion | 10, 11 | Safe recovery, retained state, exact permissions, receipt-backed outcome stages, end-to-end restart |

## Plan review and execution handoff

This is one integrated plan because all six phases share runtime, identity,
task, and model contracts. The task boundaries remain individually testable.
The requested execution method is preserved: Luna Max implementers and fresh
Luna Max reviewers, overseen by the main agent. No alternative model is implied.

The main agent must read the complete spec and plan, check every phase against
the table, check the five Review Focus items, scan for incomplete instructions,
and reconcile interface names before requesting the operator's detailed-plan
confirmation. After confirmation, execute all eleven tasks without asking for
routine permission between them, stopping only for a real authority/environment
blocker or a material change to this approved scope.
