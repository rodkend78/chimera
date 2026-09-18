# Chimera ADE workspace

The Projects surface is Chimera's single-operator Agent Development
Environment. It lets an operator register an existing local Git repository (or create
a Chimera-managed one), give RJ a bounded objective, and keep all specialist
work in a task-owned copy until the operator explicitly accepts the reviewed result.

This public contract intentionally omits private deployment evidence and historical operator run logs.

## Operating flow

1. Open **Projects** and register the repository. Local repositories must be
   clean and checked out on their default branch. The registry only accepts
   paths under the configured operator allowlist.
2. Set the project's approved public hosts, if the task needs network access.
   This is the project ceiling; every task can only narrow it.
3. Enter an objective and select **Sandbox**, **Connected**, or **Live**. A
   short-lived lease is issued only after RJ's signed plan identifies an
   imported specialist. Sandbox has no network; Connected and Live still use
   exact public-host allowlists and the standing agent profile ceiling.
4. Watch the RJ plan, specialist handoff, tool requests, and Decisions queue.
   Files are written only inside `scratch/repo` in the task worktree. Git
   metadata is protected from specialist writes and all tool calls re-check
   the current lease.
5. Select **Review changes**. The review includes changed files, binary-safe
   patch data, the plan, and a SHA-256 review digest. A task must be completed
   before the commit control appears.
6. Commit with an explicit message. Chimera verifies the source repository is
   still at the prepared commit, recomputes the review digest, applies the
   exact patch, and records the source and isolated commit IDs in the audit
   chain. A changed worktree or stale review is rejected.

## Workspace refresh continuity

Returning to a visible Chimera tab requests a fresh snapshot through the same
polling loop as periodic updates. If a poll is already in flight, visibility
events join that cycle rather than starting competing reads. Once the cycle
settles, success or failure, exactly one next poll is scheduled. Existing pacing
remains 900ms after a foreground cycle or 3500ms after a background cycle;
foreground return does not stop future updates. The effect still removes its
listener and timer on cleanup. This guard covers periodic/visibility polling,
not every explicit refresh after an operator action.

A failed state read keeps the previous view and unsent drafts with the existing
stale-state connection warning. The next successful poll replaces the snapshot
and clears that warning. No task/model action is submitted by returning to a tab.
This is UI scheduling, not new offline storage, server availability, or changes
to operator session/authentication policy.

The shared snapshot reader also orders overlapping periodic and post-action
refreshes by request start. Only the newest-started request may replace displayed
state or the connection warning; a delayed older success/failure cannot roll back
either. If a newer request has already confirmed a snapshot, a superseded
post-action read reports that confirmation instead of falsely labelling its
accepted action stale. If the newest request is pending or failed, freshness
remains unconfirmed and the last confirmed view is retained. Accepted sends remain
accepted, with a notice describing freshness **at acknowledgement**, never an
automatic resend. This is client request ordering, not a server revision check or
a guarantee that a server snapshot contains every concurrent write. Authentication
and the API client's existing read recovery are unchanged.

## Decision review keyboard controls

Decision review opens as a native modal dialog with focus on **Close**, not on
Approve or Deny. Tab and Shift+Tab wrap between its enabled buttons, and controls
behind the dialog are inert. Escape, Close and a backdrop click dismiss only the
review: they do not approve or deny the requested action. Focus returns to the
original review control when it still exists. Clicking inside the review does
not dismiss it. Exact action fields remain text with bounded, scrollable layout
on desktop and phone; the existing Approve/Deny handlers and server checks are
unchanged. Keyboard/modal behavior is not a new grant or approval validation rule.

## Decision response feedback

Approve/Deny share one synchronous pending guard per exact action ID in the
loaded workspace. Closing review or switching sections does not unlock a pending
response or resubmit it. Other decisions remain independent; a late response can
close only its own review. Pending responses are visible in review, the matching
rail card, and the Decisions response list. Caught failures remain attributed
after navigation, with instructions to inspect Decisions and Activity before an
explicit retry. No response is automatically retried.

A reply must name the requested action and report `allowed` or `denied` to be
confirmed. The UI distinguishes the **requested outcome** from the **service
result**; an HTTP-successful denial is not labelled an accepted approval. A
confirmed result remains confirmed even if the follow-up snapshot is unconfirmed.
Allowed, human-denied, expired or no-longer-pending replies suppress further
responses to that action in this loaded page, including on stale cards. Other
denials may leave the decision pending on the service; inspect before trying
again. These client guards do not change server eligibility, replay handling,
authentication or approval authority.

The latest response per action is page-local feedback, retained across section
navigation but not browser reload. **Dismiss response** in the Decisions list
clears only that settled feedback; it does not delete an audit record, cancel a
request, retry a response, or unlock a terminal action. Dismissal is unavailable
until both the response and its follow-up snapshot read have settled. Other
actions' notices are unaffected. It is not a durable receipt or proof of work
execution. Use Activity and the service audit for execution details.

## Top-bar RJ route display

The top-bar **RJ model** selector retains the exact current route reported by the
workspace, even if that provider/model is missing from its selectable catalog or
no longer has a selectable availability state. It displays a disabled
**Unavailable** option for that current route, with an amber treatment and the
full provider/model IDs in its accessible description and hover title. It must
not visually substitute Auto merely because a matching option is absent.

Catalog recovery restores the normal option without selecting or checking a
model. Switching to Auto or another available choice remains explicit and uses
the existing handler. Auto and an unset route are not labelled unavailable.
This is a display correction, not a change to provider eligibility, routing
policy, task execution, or the roster's separate Pinned/Preferred preferences.
The existing compact phone header still omits this global selector. This display
does not prove live provider availability or the actual model used by a task.

## Agent roster updates

Model routing, access-profile, worker start/stop/recovery and team-removal
requests from Agents have a separate synchronous in-flight guard per agent,
owned by the loaded workspace. Navigation cannot unlock an outstanding request,
same-turn events cannot duplicate it, and one agent's completion cannot unlock
another agent's controls. Other agents can still receive independent updates.
Removal and Live-profile confirmation dialogs remain required where they were
required before; server authority, task ownership and policy checks are unchanged.

**Agent updates** retains the latest attributed pending/accepted/unconfirmed
outcome per agent across section navigation, including an agent whose card was
removed by the accepted request. Dismiss clears feedback only, never sends work.
Model/access updates no longer label the removal button as Removing. A request
failure is caught and remains inspectable rather than becoming an unhandled
browser error. Nothing is retried automatically; inspect the agent and Activity
before retrying an unconfirmed response. An acknowledged update followed by a
failed status refresh remains accepted, with an explicit stale-settings warning.

These safeguards cover the Agents roster controls, not every command elsewhere
in Chimera. They are page-local request ownership and feedback, not a new access
grant, cross-tab/server idempotency, durable outcome ledger or proof that a real
worker ran. Reload clears the feedback; audit/history remains the source for
longer-lived evidence. Import/discovery and provider connection flows are separate.

The Agents model picker retains a saved Pinned or Preferred route even when
its provider/model disappears or becomes ineligible. A disabled **Unavailable**
option shows the exact saved route, with a readable explanation and full IDs
below it. It does not misleadingly display Auto or change saved preferences.
Pinned work continues to fail closed if that route cannot be used; Preferred
work may fall back to Auto under the existing runtime policy. Catalog recovery
removes the warning without submitting a model update or probing the provider.
Switching to Auto or another eligible model remains an explicit operator action;
choosing another model preserves the current Pinned/Preferred behavior. This is
roster presentation, not proof of provider health or the model used by a past task.

## Project results and continuation

### Drafts and failed actions

Within one loaded workspace, each repository keeps its own unsent objective,
access mode and host draft, and the intake form retains its separate draft.
These drafts and project/task selection survive section navigation. Switching
repositories does not carry another project's draft or access choice into it.
Delayed submissions do not erase newer edits or move the operator away after
subsequent project/task selection or section navigation. These are in-memory
drafts, not durable saves: reloading the page discards them.

Project intake, submission, review and commit share a synchronous in-flight
guard owned by the loaded workspace, including while Projects is unmounted.
Accepted and failed outcomes identify their originating action and remain
available on return; nothing auto-retries a write. Reviewed patches and commit
messages remain view-local: returning requires a fresh explicit review.
If a connection fails, inspect the project/task list before resubmitting because
the server may already have accepted the request. An acknowledged commit clears
its old review immediately; if the subsequent review fails, the message explicitly
distinguishes the successful commit from that failed read. Use **Review changes**
to inspect the updated state, not another commit. Server authority, source-head
and review-digest checks are unchanged. This UI guard is not cross-tab or
cross-restart request idempotency.

### Attributed reports

The selected project task now shows RJ's recorded summary and its specialists'
attributed reports directly in Projects. Runtime failure/status messages are
labelled separately from RJ's completed synthesis. The report header identifies
the task and prepared base commit; the base is not a current-workspace identity
receipt. Message verification describes provenance, not factual correctness.
Reports render as text, not executable HTML or model-supplied actions.

Task tabs use objectives instead of opaque ID suffixes and share selection with
the recovery controls. Queued tasks and explicit continuations appear even when
they do not own a new session; a continuation references its recorded project
session. A new objective and an explicit **Continue task** submission are still
required. Merely selecting or reading a report does not execute work, expand
access, accept a patch, or commit source. Selecting a task restores only that
task's own control draft, if one exists in this loaded page.

Task continuation/guidance controls retain per-task in-flight locks, attributed
pending/success/failure notices, and drafts across task selection and navigation
between Queue, Projects and other sections. Their owner is the loaded workspace,
so a reply received while neither control is mounted can still settle its request
and show the outcome when the operator returns. No action is resubmitted by
navigation. In Queue, the selected task conversation, objective-history row and
task-control dropdown now share selection: changing any one targets that exact
task and clears the previous room's recipients/reply address. Project-task
selection remains separate; select the intended project/task when changing
sections.

HQ and agent chats do not expose an unrelated task's Guide, Stop or Continue
controls. Missing or contradictory task-room identity is read-only until the
matching task record is loaded or the operator chooses another room. A selected
room disappearing from a refreshed snapshot does not silently select the newest
task. **Load older tasks** can restore missing task context; reading history never
executes or resumes work. Task records that precede their channel projection get
a navigation entry labelled **Task record**, not an invented signed transcript
or an assertion that agent work occurred.

Queue's selected conversation and explicitly loaded older tasks/messages now
belong to the loaded workspace rather than the mounted section. Leaving Queue
and returning keeps the same room and pagination context without fetching history
again. If the selected room disappears, it remains unavailable rather than
silently selecting another task. Existing reply/recipient clearing on section
navigation remains in force: retaining reading context does not restore a send
address or alter the global command dock's destination.

Older-history reads share a synchronous in-flight guard across navigation.
Pending responses settle into their original conversation even while Queue is
closed, and never select a different room. Message pages must identify the
requested conversation; malformed/mismatched pages are rejected without replacing
existing history. Task/message IDs are deduplicated across overlapping pages.
The latest **History read status** identifies the original room or Objectives
list and retains completion/failure guidance on return. Retrying a failed room
read requires selecting that room and explicitly loading older messages again.
This does not add automatic background reads; existing authenticated-read session
recovery in the API client is unchanged. These are page-local reading caches,
not durable/offline history.

The transcript follows new messages only while the operator is at or near its
bottom (within 32 pixels). Scrolling up keeps the visible message anchored as
new messages arrive or older pages are prepended. **Jump to latest** explicitly
returns to the bottom and resumes following; it does not read history, send a
message or change recipients. It is keyboard-operable, and the transcript itself
can receive keyboard focus. Automatic following scrolls only the transcript,
not its workspace ancestors.

Each conversation retains its reading anchor or scroll offset across room and
section changes within this loaded workspace. Resizing reconciles the visible
message anchor. When no message is visible (for example, while reading a tall
collaboration panel), the existing offset is retained instead of anchoring to an
off-screen message. This is best-effort position preservation: if the anchored
message disappears, the offset is clamped to available content; reloading clears
these positions. Exact text-line/caret recovery or durable reading positions are
not claimed.

This binds Queue's task-specific controls, not the global execution rail or the
main RJ command dock. The dock now labels **Guide current task**, **Guide queued
task**, **Addressed guidance**, or **New objective**, with an expandable full
objective/task-ID disclosure. Unaddressed display and dispatch share the same
running-first, then queued selection rule—even when a completed record appears
first in history. If neither exists, submission starts a new objective through
RJ; it does not continue the historical task being viewed. Participant/reply
guidance uses its explicit task address; missing/inactive task context remains
blocked rather than falling back to another task.

The rail is labelled global workspace and distinguishes current execution,
queued work and the latest recorded task. It does not follow room selection.
The proposed dock destination is derived from the latest loaded state, but a
draft retains the destination under which typing began. Changes to task identity,
general/addressed/new-objective mode, recipients or reply parent require **Review
destination** before that draft can be sent. The native modal shows both targets;
**Keep draft** or Escape leaves the text and original destination intact.
**Use this destination** only rebinds the draft: a separate send is required.
If the destination changes again while reviewing, the stale choice is disabled
until **Review latest destination** is selected. Task status advancing from
queued to running does not change the guidance destination; inactive addressed
tasks and invalid recipients remain blocked by the existing checks.

The send handler compares the reviewed destination with its current UI context
and submits the exact task/recipient/reply payload. Server authentication,
admission, task-state, recipient and authority checks remain authoritative; this
UI snapshot is not an access grant or a guarantee that state cannot change on
the server. Viewing another room without changing a dock address still does not
retarget general guidance. Editing a retained draft does not silently rebind it;
clear the text to begin a new draft under the current context.

Dock submissions use a synchronous in-flight guard. The input stays editable
while a request waits; accepted responses clear only the exact submitted draft,
not later edits. An addressed acknowledgement clears only its original address
object, preserving a newer reply selection. Up/Down history keeps original draft
destinations and restores the unsent draft; recall never replays work and needs
review if its target differs. History is bounded to 20 accepted submissions.

The expandable **Last dock result** retains the originating target and outcome
until dismissed or replaced by a later result. It opens for a new outcome, closes
when focus/interaction moves outside it or Escape is pressed, and does not reopen
an old result just because polling changes the current target. It distinguishes
accepted sends, locally unsent commands and unconfirmed sends. A failed state refresh after an
acknowledged send does not turn it into a failed send or retain the submitted
text for accidental replay. After an unconfirmed send, inspect task history before
manually retrying. These are page-local safeguards, not durable/cross-tab drafts,
server-side idempotency or exactly-once external execution.

Drafts are keyed by both task identity and guidance/continuation mode. An untouched
task starts blank with a Standard budget; unsent guidance never becomes a new
continuation objective when the task ends. Accepted replies clear only the exact
submitted draft, preserving newer text or budget edits made in either section.
Same-turn duplicate submissions are blocked, and failed requests preserve their
draft and budget without automatic replay. Inspect task/history before retrying
a request whose response was lost. These task-control drafts are separate from
the new-project-task composer and intake drafts described above.

**Stop task** can be sent while guidance or resume is pending; duplicate pending
stops are blocked. A late reply from the older request cannot replace the newer
stop acknowledgement. This only prioritizes the operator's existing stop API;
it does not promise to undo already-started effects or add model cancellation
support to providers that lack it. Task-control locks, notices and drafts are
in-memory for this page only, not durable across tabs, reloads or application
restarts. They are not persisted to browser storage and do not provide server-side
or cross-tab request idempotency.

An acknowledged task-control action remains accepted if its follow-up state
refresh fails. The retained notice marks the displayed state as potentially
stale and explicitly warns not to repeat the accepted request. This distinguishes
an effect acknowledgement from current execution status; it does not establish
task completion or exactly-once execution after an unconfirmed response.

Recent specialist reports use the existing bounded state projection. **Load
agent report history** reads that exact task room through the authenticated
history API, 100 messages at a time; **Load earlier agent reports** follows the
returned cursor. Failed reads preserve loaded reports and permit manual retry.
Responses from another room are excluded, and changing the selected task aborts
an outstanding history read. Long objectives expand through **Full objective**.

File reviews are tagged with the selected task. A delayed response cannot render
under another task or expose its commit control there. Existing server-side
digest and source-head checks remain authoritative. Legacy/session-only entries
whose task context is absent show an explicit missing-summary state; they do not
infer a new project binding or continuation authority. Queue history remains
available for older task records.

## Read-only project identity

Project model context now advertises `identityReceiptPath`:
`mounts/project/identity.json`. Use the existing Harness `read` tool at that
exact path to obtain a fresh `chimera.project-identity.v1` observation. This is
a virtual runtime-owned resource, not a file copied from the repository. No new
tool permission, shell access, or Git-metadata access is required. The normal
gateway and task lease still apply; authority is checked before observation
and again before returning it. A disk file at that path cannot override the
runtime result, and a non-project worker cannot obtain a receipt through it.

The receipt identifies the project/session, prepared base commit, current
checkout commit, relative source root, preparation/observation times, and whether
Git reports tracked/untracked changes or ignored files. It omits absolute host
paths, remote URLs, credentials, file contents and change filenames. Continuations
retain the original session/base identity and observe the current workspace,
including any retained modifications.

This is a **runtime observation**, not an independent signature, remote-origin
attestation, atomic snapshot or whole-workspace content hash. Matching commit IDs
alone do not prove that every file is unchanged. Git status has its own index,
ignore and submodule semantics; contents of ignored/untracked files are not
hashed. Always check the change flags, retain the receipt with the tool evidence,
and re-read near consequential review boundaries. A changed HEAD during the
observation or redirected workspace/Git metadata fails closed. This receipt does
not grant commit, network or publication authority.

## Bounded source discovery

Harness `glob` supports `*` and `?` within a path segment, `**` for zero or
more segments, and flat literal alternatives such as
`scratch/repo/**/*.{ts,tsx}`. Nested braces, character classes and embedded
globstars are rejected explicitly; expansion is capped at 32 variants. An
optional `path` narrows the search to a readable file/directory, but patterns
and returned paths remain relative to the workspace root.

Discovery defaults to `mounts/` and `scratch/`, skips `.git` and symlink
directory entries, and rejects scoped paths escaping the workspace. It is not
an atomic filesystem snapshot or a replacement for OS process isolation.
Glob filters before applying its 500-match limit. Both glob and literal grep
return `truncated`, `limitReason` and `scannedEntries`; traversal stops after
10,000 entries or beyond 64 nested directory levels. Grep additionally caps
file inspection and matching lines at 500 and searches only text files no
larger than 1 MiB. A complete search means complete within these documented
file-type exclusions, not all file contents on disk.

When `truncated` is true, an empty result does **not** establish absence.
Narrow `path` (and the glob pattern) and retry within the task budget. Agents
receive this guidance in their tool contracts. Do not claim a whole-repository
review based on capped search results.

## Durable project queue

The Projects composer accepts another job while the team is working. Up to 32
unstarted project jobs can wait durably. Ready jobs run in submission order,
one root executor at a time, and start only after the preceding executor has
finished cleanup. This is **queued multitasking, not parallel root execution**:
browser grants and cached agent workers still require exclusive ownership.
Ordinary chat tasks retain their existing exclusive-admission behavior.

Queued jobs preserve their objective, project, requested access, budget, and
guidance. Worktrees are prepared only when execution starts, and specialist
leases are issued after staffing. Cancelling a waiting job creates no worktree
and does not cancel another task's approvals. A cleanup failure blocks queue
advancement and is exposed in the task checkpoint and Projects alert.

Use the task selector in Projects (or Queue) to guide, stop, or explicitly
resume a waiting job. The authenticated `POST /api/tasks/resume-queued` route
resumes only a queued project job; it cannot restart an interrupted execution.
State exposes `projectQueue` and per-task `queuedForExecution` and
`recoveryRequired` flags. Paused recovery jobs are skipped until explicitly
resumed, so other ready project jobs can proceed.

## Restart behavior

An in-flight task is marked interrupted when replaying its ledger after a crash;
its project session is reconciled as failed and task leases are revoked. Its
source repository remains untouched. Checkpoints and completed artifacts stay
available for an explicit continuation; unknown external effects are never
blindly retried. Active worker sessions are reconciled rather than silently
reattached.

New-format queued project jobs that never started survive a restart but are
paused. Select **Resume queued task** to authorize their first execution. Legacy
queued records retain the prior interrupt-on-restart behavior. An explicit
continuation of a cancelled, never-started project job prepares a fresh workspace.
Graceful shutdown prevents the next waiting job from starting during teardown.

The queue is local and single-operator. This is not an AWS/distributed worker
lease implementation. Do not downgrade an existing queue journal to older code:
older readers do not understand queue lifecycle events. Preserve the journal
and use a compatible release for recovery.

## Media Studio session continuity

Media type, prompt/settings, selected result, pending generation ownership and
recovery notices survive section navigation within one loaded workspace.
Same-turn duplicate submits and remounts cannot resend a pending generation.
Editing while waiting preserves the newer draft; a response received while away
still records its result without resubmitting it. Confirmed generation remains
accepted even when the following workspace-status refresh fails.

Video-status reads are single-flight across navigation and update only their
original, still-selected job. Late replies cannot replace a newer image/result.
Checks pause while Media is unmounted and resume when the operator returns;
leaving Media does not cancel a provider job. Failed checks retain the last known
result and show persistent recovery guidance. Generation itself is never retried
automatically. Result metadata identifies the original model and video job.

Recent media retains the latest ten image previews plus known video references.
Image retention does not evict video references. The existing state API exposes
the current runtime's in-memory video jobs; these are also selectable, with no
new generation request. Selection is explicit, keeps the current draft intact,
and checks only the selected in-progress video while Media is open. If the
operator selects history while generation is pending, the later result is added
without replacing that selection. Latest-generation notices remain separately
labelled. Local artifact responses retain their richer data over state summaries.

Selected PNG, JPEG and WebP previews offer **Save image**. This browser-managed
download uses the original returned bytes and format, with a model-attributed
filename and image-history number. It remains available while another generation
is pending. Saving does not generate, upload, fetch a remote file or write to a
project; unsupported formats or missing data show an unavailable explanation.
The browser owns download completion; Chimera does not claim a file was saved
merely because the link was clicked. Save desired images before reloading.

This is not durable media storage, cross-tab locking or provider-job cancellation.
A page reload loses drafts and image previews; video references can reappear
only while their runtime still retains them. A backend restart loses its current
in-memory job map. The state API intentionally omits video playback URLs.
Completed jobs offer **Load video**, or **Refresh playback link** when a link
already exists. These explicit actions use the existing authenticated status
route, never generation, and share the same single-flight lock as polling.
Requests stay owned across navigation and cannot replace another selected job.
Both polling and manual replies must identify the requested video before being
applied. Missing links and failed requests require explicit playback retries;
terminal generation errors show the public provider error with no regeneration.

The native player uses `preload="none"`: loading a link does not automatically
download the video file. Press Play to fetch it. A player error offers explicit
link refresh without claiming every error is an expired URL. Statuses are last
known values, not proof of a fresh provider check. Local fixtures verify URL and
control wiring, request ownership and error handling—not real media decoding or
signed AWS playback. Live AWS media verification requires separately approved
provider usage.

## Frontend build isolation

`npm run build` copies the installed DCV client assets into the production output.
The asset-copy plugin applies only in Vite build mode. Closing a development
server or rendered UI fixture must not copy assets into the served `app/dist`
directory; tests do not own the production output. Serve/build configuration
regressions verify that separation while retaining the production copy hook.
This does not make two simultaneous production builds safe or make a build an
atomic deployment. Build completion and actual served asset identity remain
separate verification steps.

## Acceptance proof

Run the deterministic end-to-end proof from the repository root:

```sh
npm run pilot:ade-acceptance
```

The proof covers project intake, RJ staffing, imported Hermes-shaped
specialist execution, approval-gated writes, restart-safe recovery, lease
revocation, review/digest binding, explicit source commit, and audit-chain
verification. It uses fixture model responses and a disposable Git repository;
it does not contact external providers or mutate a real project. The command
does not load `.env`, and both fixture runtime instances receive an explicit
local file audit backend. Ambient AWS audit variables cannot select a remote
writer for this proof. Production audit selection is unchanged.

Fixture cleanup covers repository setup, partial startup, restart and final
shutdown failures. It attempts each runtime close and removal of its own
temporary child directory, never removal of the caller-supplied parent. A lone
failure is rethrown unchanged; multiple failures retain the primary cause and
cleanup evidence in an `AggregateError`. A cleanup failure prevents a successful
result. This is test-fixture recovery, not a change to live runtime shutdown.

## Current executor boundary

Project specialists use Chimera's local Harness filesystem, shell, and guarded
web executors. AgentCore computer workers remain available for ordinary
agent-owned sessions. Project-scoped AgentCore code workers fail closed until
provider-side egress isolation can enforce the same task lease; this prevents a
provider-managed code runtime from bypassing the project boundary.

## Codex execution controls and assignment continuity

Codex model calls now use the installed SDK's streamed-turn API. Cancelling a
root task or shutting down the runtime passes its abort signal through automatic
model selection to the physical SDK call. The adapter checks cancellation before
dispatch and after results, rejects failed/incomplete streams and events after a
completion marker, and returns only a parsed structured response. Providers that
do not support cancellation retain their existing behavior; the runtime still
fences their stale results. A graceful shutdown is recorded as `PROCESS_STOPPED`,
not as a user cancellation.

The activity feed records bounded `started`, `responding`, and `completed` model
turn statuses. These are not task completion claims. It does not copy native
reasoning, commands, output, credentials, or thread IDs into progress events.
Execution controls travel separately from the signed, serialized model context.

RJ and specialists receive separate native Codex session bindings. Repeated
turns of one assignment resume that assignment's session. The binding key includes
root task, agent, assignment, project, stage, model, working directory, reasoning
effort, and sandbox configuration. It is not inferred from model output. New root
tasks, explicit task continuations, separate assignments, or different routing
configurations start separate sessions. Native context continuity does not grant
filesystem, network, tool, browser, or spending authority.

The runtime stores bindings in `model-calls/codex-sessions.jsonl` alongside its
other private state. Reservations and completions are fsynced before advancing;
the journal uses a hash chain and strict transition checks. It contains opaque
scope hashes, attempt IDs, thread IDs, and lifecycle state—not prompts or model
answers. Native Codex transcripts remain in Codex's own local session storage;
this journal is neither a transcript backup nor a cross-machine resume facility.
Completed bindings survive router recreation. Uncommitted, cancelled, failed, or
otherwise ambiguous native turns cannot be resumed automatically. The existing
signed model-call ledger remains the replay authority. A missing native session
fails safely instead of silently starting a replacement.

This is a **local, single-runtime** store with in-process writer ownership, not a
distributed lock. Do not run multiple OS processes against the same state
directory. Files must be private (0600); symlinked files, malformed or truncated
journals, invalid transitions, and failed disk writes fail closed. The store is
bounded to 10,000 bindings and a 64 MiB journal, with no automatic deletion of
evidence. Archive/migration and multi-host ownership need a separate reviewed
maintenance design before scaling beyond these limits.

The Codex router remains read-only with network and web search disabled and
approval policy `never`; it is not an unrestricted native coding executor.
Consequential work continues through Chimera's approval-gated Harness tools.
The next release gate is an explicitly approved live subscription task followed
by review of the recorded result. Local fake-SDK tests prove integration and
failure handling, not account authentication or live model quality.
