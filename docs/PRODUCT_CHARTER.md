# Chimera Product Charter

**Status:** Accepted
**Date:** 2026-08-22

## North star

Chimera combines the strongest operating ideas from Grok Bot, OpenBot, Buzz,
Hermes, and DeepSeek Harness behind one calm, easy-to-use product. It must keep
the benefits of those systems without inheriting their provider lock-in,
permission ambiguity, shared-state hazards, fragmented interfaces, or opaque
automation.

The experience should feel simple enough for a non-technical operator while
remaining inspectable and governable by an expert.

## What Chimera inherits

| Source inspiration | Capability Chimera keeps | Boundary Chimera adds |
|---|---|---|
| Grok Bot | Domain-owning agents, fast onboarding, chat-first operation, and parallel work | Per-agent isolation, explicit authority, and model independence |
| OpenBot | Persistent browser computers, live browser streaming, activity visibility, and human takeover | Every browser effect passes through Chimera policy, identity, and audit |
| Buzz | Humans and agents working together in shared task spaces | Signed identities, traceable handoffs, and no implicit transfer of authority |
| Hermes | Reusable skills, durable memory, and a self-improving operational loop | Candidate skills are versioned, evaluated, and review-gated before promotion |
| DeepSeek Harness | Composable execution harness, sessions, trajectories, approvals, and evaluation seams | The harness is an adapter layer; it cannot bypass the Chimera gateway |

No source product defines Chimera's architecture by itself. We reuse verified
ideas and compatible components, then place them behind Chimera-owned contracts.

## Product promises

### One approachable workspace

An operator can create an agent, give it a job, watch it work, take over its
browser, approve a consequential decision, and review the result without
learning the underlying runtime.

The primary surfaces are:

1. **Agents** — domain-owning workers and their current state.
2. **Conversations** — human-agent and agent-agent collaboration.
3. **Browser** — a live, controllable computer session for the selected agent.
4. **Tasks** — delegation, dependencies, handoffs, and outcomes.
5. **Activity** — a readable projection of the signed event history.
6. **Decisions** — the human approval queue.
7. **Telegram HQ** — mobile command, notification, and escalation.

### Any model, chosen per job

Models are commodities behind a versioned provider interface. An agent or task
may use OpenAI, Anthropic, DeepSeek, an AWS Bedrock model, or an approved
self-hosted model without changing the identity, policy, browser, memory, task,
or audit layers.

Model selection is configuration, not migration. Routing may consider quality,
latency, cost, privacy, tool-use ability, and task class. A model never receives
more authority because it is more capable.

### Useful agent-to-agent collaboration

Agents can send direct messages, collaborate in task rooms, delegate bounded
work, stream status, and return structured results. Each message carries its
author, recipient, task, parent event, timestamp, and signature.

Communication never transfers permission by implication. A receiving agent may
act only under its own valid human delegation grant. Requests that exceed that
grant are blocked or escalated to a human decision.

### Visible computer use

Each agent or domain receives an isolated browser profile and workspace. The
operator can see the session live, inspect its activity, take control, and
return control to the agent. Agent input is locked while the human controls the
session.

Navigation, form submission, messages, uploads, downloads, credentials,
purchases, destructive actions, and private-network access have explicit policy
semantics. CAPTCHA and account-enrollment steps return control to the human.

### Skills that improve safely

Successful trajectories may produce candidate procedures. Candidates include
their provenance, evaluations, permissions, and failure cases. They become
reusable skills only after passing automated checks and the configured review
gate. Self-improvement must not become silent self-modification.

## Non-negotiable boundaries

- No model or provider lock-in.
- No agent can bypass the gateway to reach a side effect.
- No shared browser profile, workspace, credential view, or ambient cloud role
  between unrelated agents.
- No authority laundering through agent-to-agent messages.
- No production Docker socket exposed to an agent or browser container.
- No Telegram callback treated as a cryptographic signature.
- No hidden autonomous action when the product says a human is in control.
- No consequential action without a readable activity record and provenance.
- No skill promotion based only on a successful-looking trajectory.
- No claim of customer readiness without an end-to-end customer-path test.

## The Chimera contract

Every runtime, model, browser, connector, and interface integrates through the
same sequence:

```text
human delegation
  -> signed agent intent
  -> identity and schema verification
  -> policy decision
  -> isolated execution or human confirmation
  -> signed result
  -> durable audit event
  -> visible workspace update
```

This contract is Chimera's defining advantage. The source platforms supply
useful ingredients; Chimera supplies the coherent product, model freedom,
security boundary, and operator experience.
