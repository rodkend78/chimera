# Chimera Agent Harness

## Identity and leadership

RJ is the operator-facing CEO and main team controller. The internal authority identifier remains `ceo` so existing signatures, policy resources, durable task records, and handoff verification keep a stable security boundary. RJ's Hermes profile is reserved for the main persona and cannot be imported as a second specialist.

Imported Hermes specialists receive:

- a distinct signing identity and human-signed grant;
- a durable signed mailbox for RJ-to-agent handoffs and attributed results;
- a private worker workspace;
- read-only memory and skill mounts;
- a private writable `scratch/` directory;
- a Harness worker lifecycle with start, stop, heartbeat, interruption, and recovery state;
- DSH enforcement before every tool executor.

Credentials, existing sessions, schedules, and Hermes runtime configuration are not copied into the worker workspace.

## Access profiles

The operator selects one profile per imported agent from the Agents screen. Changes are durable and audited. A profile change rebuilds the worker's human-signed grant; a running worker is stopped and restarted around that change. Access changes are refused while a task is active.

| Profile | Files and processes | Network | Consequential actions |
| --- | --- | --- | --- |
| Sandbox | Isolated workspace; read-only mounts; writable scratch | None | DSH confirmation still applies where policy requires it |
| Connected sandbox | Same isolated workspace | Guarded public HTTP(S) through `web_fetch` | DSH confirmation required |
| Live workflow | Same isolated workspace | Real public services through guarded brokers and future approved connectors | Explicit signed human confirmation |

Each registered agent can also own short-lived AWS AgentCore workers:

- **Code worker:** isolated shell, code execution, and session files. Available to every access profile.
- **Computer worker:** managed browser automation plus Live View. Available only to `connected` and `live` profiles.
- **Human control:** The operator can pause agent automation, take exclusive control, and explicitly return the worker to its agent.

Worker sessions are bound to one agent, limited to 5–60 minutes, capped at four active sessions, reconciled after a Chimera restart, and reaped on expiry. Browser requests and redirect hops are checked against the public-only network policy. Explicit screenshots and code exports are copied into Chimera's bounded immutable artifact store before teardown.

“Live” does not mean unrestricted host authority. Loopback, private, link-local, internal, credential-bearing, and redirect destinations remain blocked. Raw subprocess networking remains denied; internet access is brokered so destination checks cannot be bypassed with shell commands. Credential reads, infrastructure mutation, and spending remain blocked by policy unless the product later adds a separate, explicit capability and approval path.

## Bound executors

The pilot binds `read`, `glob`, `grep`, `write`, `edit`, `str_replace_editor`, `bash`, and `web_fetch`. Executors fail closed if the selected access profile does not include them. `bash` runs through macOS Seatbelt or Linux Bubblewrap with a minimal environment, read-only system/runtime and workspace mounts, a private `/tmp`, write access only to `scratch/`, a new process session, and no raw network namespace. Unsupported platforms or a missing sandbox binary fail with `SANDBOX_EXECUTOR_UNAVAILABLE`; Chimera never falls back to an unsandboxed shell.

GitHub CI installs Bubblewrap and executes Linux-only integration checks for scratch writes, read-only workspace enforcement, raw-network denial, timeout handling, and process-group teardown. AWS AgentCore remains the managed pilot boundary for longer-lived code and computer-use sessions.

Model-driven tool calling is bound through `AgentHarnessWorker.executeTool`. AgentCore adds `mcp__chimera_worker__code` and `mcp__chimera_worker__computer`; both derive ownership from the signed agent execution context. No model response is treated as authority merely because it mentions a tool.

AgentCore Browser and Code Interpreter cover browser/computer-use and coding work. They are not an unrestricted Windows or macOS desktop. Native desktop applications will require the planned EC2/DCV adapter behind the same worker contract.
