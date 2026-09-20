# Agent workspace UX: six-phase design

Status: detailed design for operator review; implementation has not started.

Date: 2026-09-18 (America/Los_Angeles).

## Outcome

Make Chimera feel like one place to work with RJ and the team, rather than an
assembly of provider, worker, and permission controls. A person should be able
to add an agent, understand what it can actually do, talk to the intended
recipient, start work, intervene, and review an evidenced result without losing
the advanced controls that already exist.

This design implements all six approved areas. It does not replace the signed
gateway, task ledger, model fabric, per-agent isolation, or human takeover model.

## Global constraints

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

## Phase 1: a complete Add agent journey

### Required experience

1. Team has one obvious **Add agent** entry point with **Import from Hermes** and
   **Create in Chimera** choices. RJ remains the reserved main identity; adding
   a specialist cannot overwrite RJ or another registered agent.
2. Import presents discovered profiles before registration. A person can review
   the agent's name, role, capabilities, and continuity sources and correct the
   role/capabilities instead of accepting “General specialist” for everyone.
3. Native creation accepts a bounded name, identifier, role, capabilities, and
   persona text. It uses the same signing, worker, and policy boundaries as an
   imported specialist, not a separate privileged execution path.
4. Explain continuity honestly: persona/memory/skill documents retained,
   excluded file classes, unresolved sources, and missing dependencies. A
   filtered import must not say that the entire original runtime migrated.
5. Guide model preference, executor boundary, and access-profile selection.
   Advanced fields stay available. Selection does not run a paid probe.
6. End with **Check setup** and an optional explicitly described **Run test**.
   An untested agent can be saved, but is labeled untested. A successful model
   response does not prove every tool or network capability works.
7. Changes to a model, connection, access policy, persona revision, or executor
   invalidate the relevant prior verification. Duplicate submissions are safe.
8. Returning later allows editing descriptive metadata without reimporting the
   agent or silently changing its grants, model pin, or files.

### Acceptance

Native and imported fixture agents can be created, edited, restored after a
restart, explicitly tested, and selected for work. Expired discovery previews,
reserved identifiers, partial import failures, unsupported dependencies, and
double-clicks have clear outcomes without phantom “Ready” badges.

## Phase 2: consistent Connections

### Required experience

1. One Connections surface describes each supported connection with a common
   vocabulary: **Not connected**, **Signed in**, **Available**, **Verified**, or
   **Needs attention**. Configuration/catalog discovery alone is not verified
   execution.
2. Show the runtime machine and a non-secret account label when the existing
   adapter can safely identify it; otherwise say the account is not reported.
   Do not reintroduce account email that existing adapters deliberately strip.
3. **Connect**, **Refresh**, **Test**, **Reconnect**, and **Disconnect from
   Chimera** have precise capabilities. Unsupported provider operations explain
   the supported external setup path rather than exposing a dead button.
4. Disconnect prevents future Chimera dispatch for that connection. It does
   not delete shared CLI credentials or falsely claim to log out other apps.
   Existing in-flight work keeps its captured invocation; no new dispatch is
   permitted after disconnection. Its retained output is still visible.
5. A test states what will run and whether it can consume provider quota. It is
   initiated only by an explicit action, never by rendering, polling, selecting
   a model, or refreshing a catalog.
6. Verification is scoped to the connection revision, machine, model/executor,
   operation, and timestamp. An expired or changed connection does not retain a
   current-success badge.
7. Antigravity clearly exposes its native CLI permission boundary. Its model
   selection must not imply that Chimera Sandbox governs its native tools.
8. Connection repair returns the person to the original agent/task and retains
   the draft and any already-produced work.

### Acceptance

With injected provider adapters, every displayed operation either performs the
advertised bounded action or explains why it is unsupported. Disconnect and
restart cannot silently re-enable routing. No catalog or selection path performs
an inference call. No credentials appear in API state, tests, logs, or fixtures.

## Phase 3: clear conversation destinations

### Required experience

1. The composer belongs to the selected task or agent, not whichever unrelated
   task happens to be globally active. Its destination and intent are always
   visible before send.
2. **New task** is an explicit action. Starting new work while another task is
   active offers a bounded queue; it must not become steering on the old task.
3. **Ask** is a non-executing conversation mode: a model may answer, but cannot
   delegate work, run a native executor, or invoke tools. Provider quota can
   still be consumed. **Start work** explicitly enters the existing task flow.
4. Direct agent conversation includes that agent's persona and model policy and
   remains separately attributed; it is not RJ silently speaking as the agent.
   If the selected native executor cannot prove a no-tool mode, Ask is blocked
   with a clear alternative, not silently routed around a pin.
5. Task-room `@mentions` select validated recipients. They do not create agent
   identities, inherit RJ's authority, or copy unrelated agent context.
6. Drafts are keyed by workspace/operator scope, destination, recipients, and
   mode. They survive view changes and reloads in the same browser session.
   Logout clears the local draft namespace. A destination disappearing leaves
   a recoverable draft; it does not redirect the message.
7. Busy, accepted, failed, and outcome-unknown states are explicit. Repeated
   clicks do not submit the same logical message twice. An unknown send is not
   automatically resent.

### Acceptance

Rendered tests cover two tasks, two agents, queued work, mentions, navigation,
reload, concurrent refresh, and draft recovery. Runtime tests prove that Ask
makes zero tool/delegation/native-executor calls, including adversarial model
responses, while Start work retains signed specialist delegation.

## Phase 4: explainable task routing

### Required experience

1. Separate the decisions **which agent owns this work**, **which model fits**,
   and **which executor is permitted and available**. A model name is not an
   execution permission.
2. Carry structured task requirements: task class, required output type,
   context needs, tools, privacy constraints, and an operator-selected routing
   preference. Existing tasks without new fields remain compatible.
3. Filter impossible/disabled/disallowed candidates before ranking. Honor the
   agent's strict model pin. Treat unavailable required capability metadata as
   unknown rather than inventing support.
4. Offer understandable presets (**Balanced**, **Prefer speed**, **Prefer
   quality**, **Prefer lower cost**) with declared capability, observed
   reliability/latency, and supplied cost evidence distinguished. No fabricated
   benchmark scores or claim that a subscription is unlimited/free.
5. Show a compact per-task explanation, exclusions, and operator override.
   Changes apply to future work or an explicit continuation, not an in-flight
   request. A task override cannot silently defeat an agent pin.
6. Image/video jobs require their installed generation adapters; they do not
   enter a text-only conversation route just because a catalog lists a model.
7. Record routing and bounded outcome observations without prompts, provider
   secrets, or URLs containing account tokens. Unknown dispatch remains unknown.

### Acceptance

Deterministic routing fixtures prove capability/permission filtering, strict
pins, preset differences with real supplied evidence, unknown metrics, explicit
overrides, media separation, cancellation, and no fallback after ambiguous
dispatch. Explanations are bound to the selected task, not a global last event.

## Phase 5: one complete task workspace

### Required experience

1. Work opens a selected task with its real plan, assigned teammates, current
   step, blockers, conversation, approvals, retained results, files, and relevant
   browser/worker sessions. Do not manufacture progress from a generic four-step
   illustration.
2. Show the human-readable summary first. Signed provenance, raw delivery
   details, technical codes, and the complete event trail remain inspectable.
3. Persist the real plan and step transitions so history survives restarts and
   does not depend on the last checkpoint overwriting earlier progress.
4. Independent steps may run concurrently, bounded by the existing maximum of
   four executing agents. Dependencies, same-agent work, shared writes, and
   unknown resource ownership serialize. Model-declared independence alone is
   insufficient to authorize overlapping effects.
5. Reject cyclic/missing dependencies before dispatch. A failed dependency
   blocks its dependents. Steering, cancellation, expired grants, and native
   execution restrictions prevent stale steps from starting.
6. Task-scoped human takeover retains the existing exclusive ownership rule.
   Opening a task never grants browser access, resumes a worker, or executes
   a pending action by itself.
7. New task admission remains bounded and separate from internal parallel
   specialist work. Restarted queued work requires explicit resumption as today.

### Acceptance

Tests prove overlapping independent fixture work, serialization of conflicting
work, the concurrency cap, deterministic result ordering, cancellation and
steering at claim boundaries, and durable plan restoration. The rendered task
view shows only the selected task's evidence, decisions, and sessions.

## Phase 6: permissions, recovery, and evidenced completion

### Required experience

1. Every agent/task has a short plain-language access summary derived from the
   real policy and executor. Details still expose exact tools, scope, and
   native-executor exceptions.
2. Consequential decisions say who is acting, what will change, the exact
   target/action, and expiry. Preserve the security patch's exact action view;
   presentation changes cannot change the action being approved.
3. A failure card answers **what happened**, **what is retained**, and **what
   can safely happen next**. Technical details are expandable.
4. Connection repair is not a retry. A known pre-dispatch failure may offer an
   explicit new attempt; an unknown external effect requires reconciliation
   or review, with no “Retry” action that repeats it blindly.
5. Keep task, draft, checkpoints, results, and evidence on restart. Do not
   auto-resume consequential work or imply cancellation undid prior effects.
6. Distinguish **Work produced**, **Checks passed**, **Ready for review**, and
   **Published**. Each label names its evidence; an agent's prose assertion is
   not a test receipt or a deployment receipt.
7. The final acceptance path covers connect/create-or-import/assign/approve/
   restart/review using isolated fixture adapters. Live account acceptance is
   reported separately and is not claimed from those fixtures.

### Acceptance

Known pre-dispatch, post-dispatch unknown, expired-approval, failed-check,
cancelled, and restart cases preserve context and expose only safe actions.
Fake success/publication text never produces a verified-success badge. Full
tests, production build, Linux sandbox checks when available, and rendered UX
acceptance remain separate evidence stages.

## Priority and delivery boundaries

Implementation is dependency ordered: connection truth and agent setup first;
then destination-safe conversations; routing; the task workspace and bounded
parallel scheduling; then recovery/completion and integrated acceptance.

Each implementation task gets a fresh Luna Max implementer and an independent
Luna Max reviewer. The main agent checks actual diffs/results and runs the
integrated verification. Shared-file implementation is sequential, so parallel
research does not become conflicting edits to `App.jsx` or the runtime.

The existing security patch is part of the development baseline, not a change
to discard or quietly commit. Implementation requires a non-main branch and a
validated isolated workspace containing that baseline. No provider credentials
or runtime `.chimera` directory are copied into that workspace.

## Not part of this change

- Replacing the trust kernel, all UI styling, the model-provider protocol, or
  the underlying browser transport.
- Granting agents root/admin permissions, unrestricted networking, or hidden
  automatic approvals.
- New provider subscriptions, paid testing, cloud infrastructure, or migration
  of a private user's accounts/personas into the public repository.
- Claiming an iMac deployment, GitHub CI result, or live model acceptance from
  a local build or fixture result.
