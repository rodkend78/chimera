# Architecture Decision: Build Chimera Beside the Runtimes

**Status:** Accepted for Phase 0  
**Date:** 2026-08-21  
**Source note:** This public contract preserves the architecture decision without distributing private design archives or deployment host details.

## Decision

Build Chimera as an independent control plane with adapter plugins for DeepSeek Harness and, later, Hermes. Do not fork DeepSeek Harness now, do not replace Hermes, and do not deploy developer-preview code onto a shared runtime host.

The product-level inheritance and anti-goals are normative in
[`PRODUCT_CHARTER.md`](PRODUCT_CHARTER.md). DeepSeek Harness is the first
execution-kitchen adapter, not the product shell or authority boundary. OpenBot
is the reference for isolated browser-computer behavior, not the policy engine.
All models remain replaceable behind the runtime adapter contract.

The first production-shaped path is:

```text
human-signed delegation grant
  -> agent-signed action request
  -> schema and signature verification
  -> policy decision
     -> auto: execute within grant
     -> confirm: obtain one-time human approval
     -> blocked: never execute
  -> append decision and result to durable audit chain
```

The kernel, model, chat surface, and execution sandbox are adapters around this path. None may call privileged infrastructure directly.

## Why this changes the original proposal

The recovered design has a strong product thesis: domain-owning agents, human escalation at decisions, reusable skills, a single governance path, replayable work, and chat-native operation. It also combines verified capabilities with assumptions that are unsafe to build on.

| Recovered proposal | Verified reality | Chimera decision |
|---|---|---|
| Fork `dsh` during recon | DeepSeek Harness is MIT and highly composable, but explicitly warns that compatibility-breaking changes will occur | Pin an upstream commit and build out-of-tree plugins; fork only if a measured incompatibility requires a patch |
| `dsh` supplies the event stream, sandbox, approvals, and swarm | It supplies append-only sessions, tool policy hooks, approval events, sandbox seams, and continuable subagents | Reuse those capabilities through an adapter; do not rebuild a mailbox until the native continuation/report path fails a real test |
| One tool gateway can guarantee every action | The `dsh` sandbox policy covers file effects; network and process policy are explicitly outside its vocabulary. A shell command can hide many side effects behind one tool call | Enforce at two layers: semantic policy at the tool gateway and mandatory OS/network/IAM confinement at the execution plane |
| Every action should be human co-signed | Requiring an interactive signature on every action destroys autonomous operation | A human signs a short-lived delegation grant; the agent signs each action; only `confirm` actions get a fresh human signature |
| A Telegram tap is a human cryptographic co-signature | Telegram callback identity is useful authorization evidence but is not possession of a Chimera signing key | Use Telegram as the notification surface and a passkey/WebAuthn approval surface for the actual signature |
| Nostr is the identity layer | Nostr interoperability was not required to prove authorization, and Nostr Schnorr keys complicate managed-key custody | Keep signing behind an interface. The proof uses Ed25519; Phase 1 must choose Nostr compatibility or AWS-managed key custody explicitly |
| Each Grok Bot owns a separate computer | Current official Grok Bot documentation says each member gets one cloud computer shared by that member's Bots | Chimera requires per-agent or per-domain execution isolation because the product requires stronger separation than that source model |
| Expose the `dsh` web UI for inspection | The upstream web server documentation says non-loopback binding has no TLS, authentication, or origin policy | Keep it loopback-only behind a reviewed tunnel during recon; later put any inspection UI behind operator authentication |
| Nine weeks to a pilot | The estimate predates an API soak, enforcement proof, Telegram signing choice, and execution-plane design | Use evidence gates. Estimate only after the 48-hour soak and zero-bypass trace inventory |

## Six-layer target, revised

### L1 Runtime adapters

DeepSeek Harness is the first adapter because its Cordis seams already expose tools, approvals, sessions, subagents, and configuration. Hermes remains a supported runtime until the Chimera pilot wins on measured tasks. Model routing stays outside the control-plane kernel.

### L2 Identity and delegation

An agent identity is a public key plus metadata. A human identity is an enrolled approver key. A signed delegation grant binds one human, one agent key, a time window, allowed capabilities and resources, and the highest permission tier. Keys never live in repository files. Nostr interoperability is the first production identity target; [`ADR-002-NOSTR-KEY-CUSTODY.md`](ADR-002-NOSTR-KEY-CUSTODY.md) defines the cloud-resident signing broker and recovery boundary.

### L3 Policy and audit gateway

Unknown actions fail closed. Policy cannot turn a blocked action into an approval. Approvals bind the exact action, grant, policy rule, and challenge hash. Action IDs and challenges are single use. Audit events form a hash chain; production retention also needs an append-enforcing AWS store and periodic immutable anchors.

### L4 Execution isolation

Every agent or domain runs with a distinct workspace, IAM role, network policy, credential view, and process boundary. The semantic gateway decides intent; the execution plane prevents bypass. No agent receives the host Docker socket, ambient AWS credentials, or unrestricted production egress.

### L5 Memory and skills

Configured knowledge and vault stores begin read-only. Retrieval records source IDs and policy decisions. Completed work may create a candidate skill, but publication is review-gated and protected from prompt-injected peer content. Shared mutable memory is not a coordination bus.

### L6 Presence

Telegram HQ routes mentions, presents decisions, and reports outcomes. It does not hold the only audit record and does not make callback identity equivalent to a cryptographic signature. Inspection UI remains operator-authenticated.

## Zero-bypass definition

“Zero bypass” is not satisfied by registering a `tools/pre-execute` listener. It is satisfied only when an inventory shows that every side-effect path terminates in an enforcing control:

- filesystem writes: workspace mount plus file policy;
- subprocesses: isolated container/VM, restricted user, no privileged mounts;
- network: default-deny egress with an audited proxy or explicit destinations;
- AWS: least-privilege per-agent IAM role and brokered high-risk operations;
- MCP and SaaS: tool policy plus server-side credentials unavailable to the agent process;
- human communications: exact destination policy and signed confirmation;
- spend: blocked in the pilot;
- audit: conditional append plus immutable external anchor.

If any adapter can reach a side effect outside those controls, the zero-bypass gate fails.

## What we are building first

This repository implements the trust-kernel semantics without a model or runtime. It is small enough to reason about and keyless enough to test on every commit. The next code milestone is a Cordis adapter that converts a `dsh` tool execution into a signed Chimera action and maps `auto`, `confirm`, and `blocked` back into the upstream pre-execution/approval pipeline.
