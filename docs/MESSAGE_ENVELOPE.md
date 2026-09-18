# Signed Agent Message Envelope

## Contract

Chimera uses `chimera.agent-message.v1` for four collaboration events:

- `direct_message` — conversational content between named agents;
- `task_handoff` — an objective and explicit acceptance criteria;
- `progress_event` — queued, active, blocked, or completed status;
- `structured_result` — succeeded, partial, or failed output with structured data.

Every event signs the same transport-neutral record:

```json
{
  "schema": "chimera.agent-message.v1",
  "sender": {
    "agentId": "ceo",
    "algorithm": "ed25519",
    "keyId": "ceo:...",
    "publicKey": "-----BEGIN PUBLIC KEY-----...",
    "keyFingerprint": "..."
  },
  "payload": {
    "messageId": "message-123",
    "type": "task_handoff",
    "recipientAgentId": "researcher",
    "taskId": "task-42",
    "parentMessageId": null,
    "issuedAt": "2026-08-22T06:55:00.000Z",
    "expiresAt": "2026-08-22T07:15:00.000Z",
    "request": {
      "capability": "filesystem.read",
      "resource": "workspace/research.md",
      "operation": "read"
    },
    "content": {
      "objective": "Read the source and return evidence.",
      "acceptanceCriteria": ["Cite the source path."]
    }
  },
  "proof": {
    "type": "detached",
    "signature": "..."
  }
}
```

`request` may be `null` for a purely informational event. It describes what the
sender wants the recipient to do; it is not an authorization. `content` is
type-specific, bounded canonical JSON. `parentMessageId` links replies and
progress/results to an earlier event when applicable.

## Signing profiles

The Ed25519 test adapter signs the canonical `schema`, `sender`, and `payload`
record through the existing generic signing-provider interface. It produces the
detached proof shown above.

The Nostr development provider signs that same canonical record as the content
of a verified NIP-01 event. Its proof has `type: "nostr-event"` and contains the
event, including the sender pubkey, event ID, BIP-340 signature, message tag, and
recipient tag. This is a Chimera application envelope, not a claim of NIP-17
encryption or relay delivery. Production key custody remains the ADR-002 signing
broker; the existing in-memory Nostr signer remains development-only.

## Recipient verification

Before accepting a message, the recipient verifies:

1. the schema, bounded fields, message time window, sender key fingerprint, and
   Ed25519 or Nostr proof;
2. the sender's human-signed grant, agent-key binding, active window, envelope
   type, and exact recipient destination;
3. the recipient's own human-signed grant, agent-key binding, and active window;
4. that both agents belong to the same directly human-signed grant chain in
   version 1 (the same enrolled human key and human identity);
5. that the message window is contained by both grants; and
6. when `request` is non-null, that the recipient's grant covers the requested
   capability and resource.

An accepted result attributes the sender key and sender grant separately from
the acting authority. Acceptance does not execute the request; an eventual side
effect still passes through normal Chimera policy, approval, execution, and
audit handling.

## Authority is non-transferable

The acting authority is always the recipient's own current human-signed
delegation grant. A peer signature proves who sent the request; it does not make
the sender a human delegator. A message can request work, but it can never
confer a capability, extend a scope or expiry, raise a tier, or import the
sender's grant.

Fields such as `authority`, `grant`, `scope`, or instructions to ignore policy
inside `content` are inert data. If the signed `request` is outside the
recipient's grant, verification returns `RECIPIENT_SCOPE_DENIED`. If an attacker
edits the signed request, signature verification fails. A sender delegated by a
different human key is outside the recipient's grant chain and is rejected.

## Local durable team dispatch and task rooms

The runtime uses a single-process, task-scoped durable mailbox for RJ and
specialist handoffs and correlated signed replies. `agent_send` queues a handoff;
`agent_ask` waits for its correlated result; `agent_reply` and
`agent_report_blocker` finish the current assignment. Runtime code chooses the
sender, parent, root task, identity and grant. Peer tools cannot supply authority
or a requested external capability. Direct specialist selection and current
project leases bound peer eligibility. A message never issues a project lease.

All automatic and explicit results are redacted before signing and persistence.
Task-room conversation entries use `replyTo` to project the signed
`parentMessageId`. Verified entries contain only safe provenance: verification,
envelope hash, signer ID and grant ID (plus gateway action ID when available).
Scheduling and tool events remain `derived`; human guidance remains `human`.
Raw envelopes, tokens, private keys, grants and tool arguments do not enter the
room projection. Grant IDs identify historical attribution, not live authority.

Cancellation/timeout after atomic completion still projects and acknowledges
the stored signed reply once, including when an imported worker has not yet
returned. The dispatcher verifies attribution at the recorded commit time and
never reacquires execution authority. Projection/acknowledgement failure
durably interrupts only the reply with `TEAM_RESULT_DELIVERY_FAILED` when the
mailbox is writable; the input's committed result remains intact. Physical
drainage continues until the worker settles, and no worker effect is replayed.

`state.teamMessaging.tasks` projects at most 64 delivery metadata rows per recent
task, participating agent IDs, current `eligibleRecipients`, and status counts.
The UI maps pending to queued, processing to working, yielded asks to waiting,
completed/acknowledged to replied, failed to failed, expired to blocked (expired),
and interrupted to interrupted. These are delivery states: a replied delivery
does not imply successful work; the signed result retains its completed/failed
status in the transcript. Historical inactive tasks have no eligible recipients.

`POST /api/tasks/message` requires the existing operator cookie and CSRF token.
It accepts `taskId`, 1..4096 characters of nonblank `content`, 1..8 unique
`recipientAgentIds`, and optional same-task `replyTo`. The server checks current
task eligibility and rejects cross-task parents and unknown/unleased/directly
excluded recipients. Request bodies are capped at 32 KiB and targeted guidance
at 32 messages per task. Human content is redacted and durably appended before
acknowledgement. Recipient-specific steering snapshots combine existing global
guidance with only that recipient's targeted human messages. RJ, imported loops,
and built-in one-shot specialists all recheck those snapshots after model calls.
The trusted `assertProposalCurrent` callback remains attached through peer
resolver, storage and claim boundaries. RJ also carries its exact accepted plan
revision through initial and later root handoff admission. New RJ guidance after
plan acceptance stops obsolete dispatch with `TASK_PLAN_STALE`, preserving
completed evidence for explicit continuation instead of replaying the plan.
Guidance during the planning model call still supports bounded replanning.
Superseded pending tool approvals are
cancelled only for selected recipients, including proposals still being posted.

Saving guidance does not promise another model call: acknowledgements distinguish
`next-boundary` from `saved-no-active-assignment`. Finished assignments never
restart silently. Stop uses existing task cancellation, closes peer admission,
interrupts pending work, cancels approvals and revokes task leases. Restart retains
signed reply history and human guidance but interrupts unfinished mailbox work;
no old effect is automatically replayed. This provides durable local correlation,
not distributed transport or exactly-once external effects.

Verification: `node --test tests/task-message-api.test.mjs tests/browser-runtime-task-control.test.mjs tests/team-dispatcher.test.mjs tests/task-room-rendered.test.mjs`.
