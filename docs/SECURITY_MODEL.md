# Chimera Security Model

## Overview

Chimera authorizes and records side effects requested by autonomous agents. Its high-value assets are human signing authority, agent private keys, provider and SaaS credentials, AWS roles, policy configuration, approval challenges, audit history, agent workspaces, and the data reachable through tools. A false allow is more serious than an unnecessary denial.

The current repository is a local single-operator pilot with live model routes, policy-bound specialist executors, and short-lived AWS AgentCore Browser and Code Interpreter workers. Decision requests, terminal outcomes, actor signing identities, gateway replay IDs, and the authoritative audit chain persist in owner-only local files. Pending executor continuations remain process-local by design: a graceful stop cancels them and a crash leaves their durable decision records to be orphaned on restart. They are never resumed automatically. Production key custody and truncation-resistant audit anchoring are still deferred to hardened AWS infrastructure.

## Threat Model, Trust Boundaries, and Assumptions

Trust boundaries:

- **Human approver to gateway:** grants and confirmation decisions are untrusted until their signature, enrolled key, time window, challenge binding, and replay state are verified.
- **Agent to gateway:** action payloads, public keys, signatures, IDs, capability names, resource names, and timestamps are attacker-controlled. A compromised model or agent process is assumed possible.
- **Policy to executor:** an allow decision authorizes only the exact signed action. The executor may not broaden parameters, destinations, IAM roles, mounts, or network access.
- **Runtime adapter to Chimera:** Cordis, Hermes, Telegram, MCP, browser, shell, and model events are untrusted protocol inputs. Adapter metadata is not authorization.
- **Gateway to audit store:** a returned decision is not authoritative unless its audit append commits. Production must fail closed when durable append certainty is unavailable.
- **Peer agent and memory inputs:** all peer messages, retrieved documents, web pages, skill candidates, and model output are data, not policy or authority.
- **Developer and operator configuration:** policy, trusted keys, adapters, and infrastructure code are privileged inputs. Repository access is not equivalent to production key access.
- **Chimera to managed worker:** provider session IDs, AWS credentials, automation WebSockets, and Live View URLs stay server-side. A worker action is authorized for one durable Chimera agent/session binding.
- **Managed browser to network:** every browser request and redirect hop is checked against the public-only destination policy. Private, loopback, link-local, metadata, credential-bearing, file, and special-use destinations fail closed.
- **Agent to human controller:** controller changes and agent actions are serialized per worker. Automation is paused before human ownership is committed and failure compensation restores the safe prior state.

Assumptions:

- The cryptographic implementation and enrolled public keys are correct.
- Private keys are unavailable to models and ordinary tool processes.
- The execution layer can technically enforce filesystem, process, network, and IAM restrictions independently of model cooperation.
- Time is trustworthy enough for short-lived grants; production uses a monitored clock and bounded skew policy.
- A Telegram account or bot token alone is not a human signing key.

## Attack Surface, Mitigations, and Attacker Stories

Primary attack surfaces are signed-envelope parsing, canonicalization, key lookup, policy matching, time windows, replay state, approval binding, runtime adapters, executor parameter translation, shell/process escape, network egress, credential brokers, audit persistence, Telegram callbacks, peer messages, retrieval, and skill publication.

Current mitigations include bounded envelope fields, plain-record canonicalization, Ed25519 signatures, human-key allowlisting, agent-key fingerprint binding, exact-resource rules, default deny, short-lived grants, action-to-grant time containment, one-time action IDs, challenge-bound confirmation, absolute blocked policy, and a hash-chained audit log. Tests exercise malformed payloads, forged signatures, expired grants, replay, lookalike destinations, and altered history.

The local HTTP control plane accepts only `127.0.0.1`, `::1`, or `localhost`.
Static assets are public to the local machine, but every API route requires an
HttpOnly SameSite operator cookie after a one-time, five-minute fragment
bootstrap; every mutation also requires a session-bound CSRF value. Expired
bootstrap material is cleared and cannot be replayed. Browser-stream WebSocket
upgrades require the same cookie. Bootstrap, cookie, CSRF, and private-key
values are excluded from state projections and audit events.

The pinned DeepSeek Harness adapter adds one ownership classification for every
published tool, full session/call/root/parent lineage in the signed request,
independent authorization for Code Mode children, and fail-closed handling for
unknown tools, unresolved parents, missing authority, replay, and unsigned DSH
approval outcomes. A monotonic Cordis guard also denies any execution token
that a short-circuiting pre-execute listener prevented Chimera from seeing. Its
inventory identifies the credential, filesystem,
human-command, model, MCP, network, and subprocess paths that require lower
execution-plane enforcement. The adapter proof does not replace those Gate 2
controls.

Live model credentials remain server-side environment inputs and are never
serialized in provider descriptors or browser state. Provider base URLs must
use HTTPS, except explicit loopback HTTP for local development, and cannot
contain embedded credentials, query strings, or fragments. The selected model
comes from a human-visible allowlist and is persisted separately from key
material. Production still requires Secrets Manager/KMS custody and controlled
egress; a local `.env` is only a single-operator development boundary.

Important attacker stories:

- A prompt-injected agent requests a production credential or changes a destination to a lookalike. Policy must deny before execution.
- A compromised agent steals another public identity or replays an old signed action. Key binding, time windows, and single-use IDs must deny it.
- An attacker replays a legitimate approval for different parameters. The signature must bind the exact challenge and action digest.
- A shell tool is semantically allowed for a harmless command but performs hidden network or filesystem effects. Container/VM, egress, mount, and IAM controls must prevent the side effect even if semantic classification fails.
- A local untrusted page tries to call Chimera through the browser or attach to its WebSocket. Origin checks, the operator cookie, and CSRF checks must deny it; a non-loopback bind must prevent startup.
- A runtime or MCP adapter calls an underlying service without the gateway. The execution inventory and network/credential placement must make that path unusable.
- An audit operator edits or truncates local history. Hash verification detects edits, while production immutability and external anchors detect truncation and replacement.
- A Telegram bot token is stolen. It may notify or submit a callback but cannot produce the approver's passkey signature.
- A peer message or retrieved document says to override policy. It carries no signing authority and must remain inert data.
- A public site redirects a browser worker to metadata or a private address. Request interception must abort the redirected request, not merely validate the first URL.
- An agent acts while the operator is taking over its computer. The per-session controller queue must commit one owner before any later action proceeds.

AgentCore workers are capped at four active sessions, one kind per agent, and 5–60 minutes. Restart reconciliation stops durable sessions from an earlier process. Provider diagnostics are normalized to stable public error codes; raw AWS messages, credentials, provider session IDs, signed URLs, and local artifact paths are excluded from normal state projections.

Local Harness subprocesses use macOS Seatbelt or Linux Bubblewrap. Both expose
the worker workspace read-only except for `scratch/`, provide a private temp
area and bounded environment, deny raw networking, and kill the process group
on timeout or output overflow. Linux uses a private namespace via
`--unshare-all`/`--unshare-net`; a missing sandbox binary fails closed rather
than running the command on the host. Ubuntu 24.04 hosts must explicitly permit
Bubblewrap to create its initial user namespace, preferably with a scoped
AppArmor profile. Chimera also treats a denied namespace setup as
`SANDBOX_EXECUTOR_UNAVAILABLE`; CI changes the related sysctl only on its
disposable runner so the real isolation tests can execute.

Out of scope for this proof: provider-side model confidentiality, Nostr relay behavior, passkey enrollment, AWS compromise above the Chimera account boundary, physical device compromise, and cryptographic library defects. They become in scope when those adapters are added.

## Severity Calibration

- **Critical:** a remote or compromised agent can execute a blocked production action, obtain a human or agent private key, forge a human grant/approval, escape into the host or another agent domain, or mutate authoritative audit history without detection.
- **High:** an attacker can reuse approval for different parameters, bypass destination/IAM/network constraints, access secrets reachable by a privileged adapter, or create an unaudited side-effect path requiring ordinary agent access.
- **Medium:** a denial-of-service can exhaust approvals or crash the gateway without granting authority; audit metadata leaks sensitive resource names; policy ambiguity produces safe denials but harms operation; an agent can read another low-sensitivity workspace.
- **Low:** local developer-only diagnostics leak non-secret IDs, malformed requests produce noisy duplicate deny events, or usability defects increase unnecessary confirmation without enabling execution.

The severity of availability issues rises when Chimera becomes the only control plane for time-critical operations. Until then, fail-closed denial is the intended bias.
