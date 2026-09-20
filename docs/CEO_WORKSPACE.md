# CEO Workspace Wiring

**Status:** Implemented locally for build-plan step 6
**Scope:** Gate 3 conformance harness, not a production agent runtime

## Composition

The CEO workspace is a composition layer over Chimera's existing contracts. It
does not replace the trust kernel, create a second policy engine, or grant the
CEO a privileged execution identity.

| Surface | Existing contract reused | CEO workspace integration |
|---|---|---|
| Identity and delegation | Human-signed grants and Ed25519 identities | `CeoWorkspace` and each `SignedSpecialistStub` receive a fixed grant bound to their own key. |
| Message fabric | `chimera.agent-message.v1` | Incoming messages, task handoffs, and structured results use `createAgentMessageEnvelope` and `verifyAgentMessage`. |
| Gateway | `ChimeraGateway` | CEO actions, CEO task-handoff sends, specialist work, specialist result sends, and browser commands are submitted under the acting agent's grant. |
| Model selection | Product charter model-freedom rule | `ModelRouter` is the `routerId` plus `route(prompt, context)` interface. `DurableAgentModelPolicy` gives RJ and each specialist independent Auto, Preferred, or Pinned text routes. `createGatewayModelRouter()` signs and policy-checks each invocation before provider dispatch. `createReliableModelRouter()` adds single-flight execution, durable result replay, and fail-closed ambiguous-outcome handling. |
| Browser | `OpenBotBrowserComputerAdapter` | `CeoWorkspace.browserCommand()` calls the live adapter with the CEO grant; takeover and command revalidation remain adapter-owned. |
| Decisions | Existing gateway challenge and `decide()` path | Confirm-tier actions are appended to `.chimera/decisions/queue.jsonl`; `HumanDecisionHandler` signs and submits the decision to the existing gateway path. |
| Activity | `MemoryAuditLog` plus browser state | `createActivityProjection()` returns recent audit events, per-agent activity, pending decisions, session/browser state, and audit-chain verification. The browser API continues to serve this at `GET /api/state`. |

The public module entry point is `src/ceo/index.mjs`.

## Orchestration flow

1. `CeoWorkspace.receive()` verifies the signed inbound message against the
   sender grant and the CEO's own human-signed grant.
2. The configured `ModelRouter` returns a bounded plan of at most eight
   specialist tasks. The V1 composition is provider adapter, then
   `createGatewayModelRouter()`, then `createReliableModelRouter()`. A
   `model.invoke` action must pass the acting agent's exact grant and Chimera
   policy before the provider receives the prompt. Model output is data and
   cannot add a grant.
3. The CEO signs a `task_handoff` envelope. Sending that envelope is also a
   signed gateway action with capability `agent.message.task_handoff`, so the
   handoff cannot leave the workspace unless the CEO grant and policy both
   allow the exact specialist destination.
4. The specialist verifies the handoff. A requested operation is signed by the
   specialist and submitted to the gateway under the specialist's grant before
   its stub executor runs.
5. The specialist signs a `structured_result`. Sending the result also passes
   through the gateway under the specialist grant. The CEO verifies the result
   and its attribution before including it in synthesis.
6. The router synthesizes only verified results. If it proposes a consequential
   action, the CEO signs that exact action and submits it to the gateway under
   the CEO grant.
7. An `auto` action may continue. A `blocked` or out-of-grant action stops. A
   `confirm` action becomes a decision record containing its exact action diff,
   resource, expiry, agent and grant attribution, challenge hash, and policy
   rationale.
8. The human decision handler signs `approve` or `deny` with the enrolled human
   identity and calls `ChimeraGateway.decide()`. Reuse of the same decision is
   rejected because the gateway challenge is no longer pending.

## RJ conversation loop

`POST /api/conversations/messages` is the operator-facing entry point. Chimera
admits one task, persists the operator's message to a mode-`0600` append-only ledger,
then starts the existing signed orchestration flow. The optional
`recipientAgentId` addresses a registered specialist through RJ; the
target is bound into the signed operator message, and decomposition fails
closed unless every planned subtask uses that verified specialist.
The final RJ synthesis or safe failure is persisted as a linked reply with the
task ID. `GET /api/state` returns the bounded
`chimera.conversation-projection.v2` with Team HQ, agent channels, and read-only
task rooms. Verified handoff/result rows retain a bounded provenance projection
(envelope hash, signer, grant, and gateway action when present); Harness tool
telemetry is explicitly derived, not signed. Existing v1 operator/RJ ledger rows are
restored as legacy records without rewriting the source history.

The imported RJ continuity context is supplied to CEO decomposition and
synthesis calls. Imported specialist context is supplied only to that
specialist's model call. Provider credentials, grants, sessions, and private
keys never enter either context.

Imported Harness specialists use a finite reason/tool/observation loop: no more
than six model turns or four tool calls per handoff. Each tool must be listed in
the agent's selected access profile. Tool observations are sensitivity-redacted
before they return to the model, and response summaries are redacted before
durable Team Chat projection. Every call still crosses the existing DSH policy,
per-agent workspace, audit log, and approval broker. The loop does not create
ambient authority and stops with a coded failure when either bound is reached.

## Authority model

The CEO is a planner, delegator, synthesizer, and escalator. It has no ambient
authority and no authority field in a model response or peer message is
interpreted as a grant.

- The CEO can send only message types and destinations in its own signed grant.
- A specialist acts under its own signed grant, never the CEO's grant.
- `verifyAgentMessage` checks the recipient grant before a requested action is
  accepted. A poisoned request outside that scope returns
  `RECIPIENT_SCOPE_DENIED` before specialist execution.
- Message signatures establish attribution. The separately signed gateway
  action establishes permission to send or execute.
- Browser effects retain the browser adapter's gateway mediation and human
  takeover lease. Calling `browserCommand()` does not bypass either.
- Model routing changes computation, not authority. Replacing a router does not
  change the CEO workspace, grants, gateway, or audit contracts.
- One logical model turn has one deterministic call ID. Concurrent submissions
  share one provider call, a completed result is replayed from
  `.chimera/model-calls/events.jsonl`, and a timeout or crash after possible
  dispatch becomes `MODEL_CALL_OUTCOME_UNKNOWN`. Chimera does not automatically
  resend an ambiguous request; an operator must reconcile or explicitly start
  a new logical turn.
- Each durable call ID and ledger record is bound to the gateway router's
  authorization scope, derived from the acting agent, grant, and model
  resource. A result from one agent or grant cannot satisfy another scope.
  Every cache hit also submits a fresh signed authorization action before the
  stored result is returned, so agent-key possession, the current grant window,
  and current policy are revalidated without redispatching the provider call.
- Provider and SDK errors cannot assert that a request was definitely not sent.
  Only a Chimera-owned gateway denial before provider dispatch is retryable;
  every provider-originated failure is recorded as an ambiguous outcome.
- The JSONL decision queue is a local durable projection of decision requests;
  it is not a second approval authority. Only the live gateway challenge and a
  valid human signature can resolve an action.

The local JSONL queues are ignored by Git and contain operational metadata.
They must not contain credentials or unredacted sensitive values. Production
still needs durable gateway pending-state recovery, model-result encryption and
redaction rules, an append-enforcing audit store, and immutable anchors.

## Conversation modes and task routing

The shared Conversation surface keeps the destination explicit. **Ask agent**
is an inference-only request to the selected agent and does not grant tools,
create a task, or prove task execution. **Start work** creates a durable task;
**Continue task** creates a new explicit continuation linked to a terminal task;
and task guidance addresses the selected task at its next safe boundary. Each
mode owns its task/agent draft, destination revision, request identity, and
receipt lookup state, so changing rooms does not silently retarget or resend a
draft.

Task routing is structured and task-bound. Auto, Preferred, and Pinned remain
distinct policies: Preferred may fall back before dispatch, while Pinned fails
closed when its exact route is unavailable. Requirements, model preferences,
access ceilings, and task leases are checked by the runtime before dispatch;
model output, imported persona files, and agent messages remain data rather
than authority. A lost post-dispatch outcome stays unknown until inspected and
is never retried automatically.

## Activity projection

`createActivityProjection()` returns `chimera.activity-projection.v1`:

- `recentEvents`: real hash-chain entries in reverse chronological order;
- `agentActivity`: event counts and latest activity grouped by attributable
  agent or actor;
- `pendingDecisions`: unresolved durable decision records;
- `session`: controller, browser tabs/running state, suspension state, and
  session ID;
- `audit`: the current hash-chain verification result.

For compatibility with the existing React workspace, the same object also
exposes `activity`, `decisions`, `agent`, `controller`, `browser`, `suspended`,
and `hourlyCost`. `src/browser/server.mjs` already owns `GET /api/state`; its
`ChimeraBrowserRuntime.state()` now returns this projection.

## Gate 3 replay package

The bounded real CEO-led team task must retain enough evidence to replay the
whole chain without trusting a narrative. Capture:

1. the exact policy version and source revision;
2. the human public key registry and the signed CEO, sender, and specialist
   grants, including their windows and scope selectors;
3. the inbound signed message, every signed task-handoff and structured-result
   envelope, and their parent/task IDs;
4. every agent-signed gateway action, policy decision, grant ID, challenge hash,
   and any human-signed decision;
5. the deterministic task input or pinned production router/model identifiers
   and routing configuration, without model secrets;
6. the specialist executor input/output and citations for the bounded task;
7. the decision JSONL records and the complete verified audit chain, including
   its final head hash;
8. the activity projection shown to the operator and the browser session/control
   state if the task used the browser;
9. negative replay evidence for a poisoned peer request, CEO overreach,
   specialist overreach, and a repeated human decision.

The conformance implementation is exercised by
`tests/ceo-workspace.test.mjs`. Passing it establishes the local composition and
replay shape. The bounded real-team replay is implemented by
`scripts/gate3-replay.mjs` and covered by `tests/gate3-replay.test.mjs`.

### Run the Gate 3 replay

From the repository root:

```sh
node scripts/gate3-replay.mjs
```

The command is offline and uses no real model endpoint. It recreates the output
directory on each run, prints a human-readable outcome and audit-head summary,
then leaves exactly these operational artifacts:

```text
.chimera/gate3-replay/
├── evidence.json
└── decisions.jsonl
```

`evidence.json` has nine named groups matching the list above. It contains the
complete audit entries and final head hash, the decision JSONL records and
digest, exact signed grants/messages/actions/decisions, pinned deterministic
router configuration, specialist I/O and citations, the operator projection,
and all four negative results. Before reporting success the runner reloads that
file, verifies grant and action/decision window containment, verifies the grant,
message, action, and human-decision signatures, reproduces policy decisions,
and verifies the audit hash chain from genesis through the retained final head.

The source under `fixtures/vault-snapshot/` is an allowlisted, read-only local
stand-in for configured knowledge/vault access. The fixture adapter maps the logical
`workspace/knowledge/...` resource to that snapshot without network or write
access. A real revision-pinned knowledge connector is a later swap-in behind the
same specialist executor boundary, matching the router's model-freedom pattern;
the fixture result must not be represented as current live-knowledge proof.
