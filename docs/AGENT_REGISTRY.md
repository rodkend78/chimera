# Agent Registry and Hermes Intake

Chimera's first roster intake is a preview-first, read-only bridge from a
configured Hermes host into the local pilot. It does not copy or edit a Hermes
profile. Discovery and backup materialization require explicit environment
targets. Chimera does not default to a live production instance or vault bucket.

## Configuration

Set these in `.env` only when you intend to connect Hermes. Leave them empty
to keep discovery fail-closed (`HERMES_DISCOVERY_NOT_CONFIGURED` /
`HERMES_REFERENCE_NOT_CONFIGURED`):

- `CHIMERA_HERMES_INSTANCE_ID` — SSM instance to inventory. Required for
  **Find Hermes agents**. There is no default instance id.
- `CHIMERA_HERMES_BACKUP_BUCKET` — S3 bucket for read-only continuity
  materialization. Required to import persona, memory, or skills. There is no
  default vault bucket.
- `CHIMERA_HERMES_BACKUP_PREFIX` — optional object prefix override.
- `CHIMERA_HERMES_HOST` — optional `hermes://` host label. Used only after an
  instance id is set.

Use a staging or test instance and bucket. Do not point Chimera at a live
production host unless you mean to.

## Operator flow

1. Open **Team** for the roster, or **Settings** when configuring connections
   and imports. Select **Find Hermes agents** in the Settings import panel. When
   `CHIMERA_HERMES_INSTANCE_ID` is set, this pulls profiles from the configured
   host label. There is no default instance id.
2. Chimera runs one fixed SSM command that lists directory names under the
   configured Hermes profile root (default `/var/lib/chimera/hermes/profiles`). It does not read `config.yaml`, credentials,
   sessions, schedules, memory content, or channel state.
3. Review the returned candidates and uncheck anything that should remain
   outside the pilot.
4. Select **Import RJ continuity** for the reserved `rj` main persona, or
   **Import selected** for specialists. Chimera converts the candidates to
   bounded `chimera.agent-manifest.v1` records under
   `.chimera/agents/registry.json`.
5. The CEO includes registered agents in its planning catalog. Each agent gets
   a distinct ephemeral signing identity and a separate human-signed grant for
   model invocation and structured results.

The discovery preview expires after 15 minutes. Imports must refer to an exact
candidate in that server-held preview; the API will not accept an invented
profile ID. Batch imports validate fully before the durable registry changes.

Setup is configuration only: creating a native agent, discovering Hermes
candidates, importing a profile, or editing metadata does not start a task or a
worker. A separate explicit task or Ask request is required. The native source
(`chimera://native/...`) and imported Hermes source (`hermes://...`) remain
distinct in the roster; an imported profile never becomes a native permission
grant.

## Manifest boundary

The registry stores only:

- agent ID, display name, role, and capability labels;
- a non-secret `hermes://` source reference plus persona, memory, and skill
  references;
- the required execution posture: per-agent workspace and DSH-mediated side
  effects;
- enabled state and import timestamp.

Unknown candidate fields are discarded. Raw paths, profile contents, tokens,
passwords, cookies, Telegram state, and credential values are not accepted by
the manifest schema.

## Continuity capsule boundary

Chimera materializes an imported profile into a per-agent workspace using
three exact, read-only layers:

- persona: only `AGENTS.md`, `IDENTITY.md`, `SOUL.md`, `TOOLS.md`, and
  `USER.md` at the profile root;
- memory: bounded, non-sensitive documents below `memories/`;
- skills: bounded `SKILL.md` definitions only.

Skill scripts, assets, dependencies, credentials, `.env` files, provider
sessions, private keys, authority grants, databases, and transient runtime
state do not cross the boundary. Safe-named documents are also rejected when
their content contains credential assignments, private-key blocks, or NUL
bytes. The workspace returns safe counts, bounded bytes, exclusions, and a
deterministic SHA-256 digest. Persona and memory content enter bounded model
context; skills enter as a discoverable path catalog. RJ retains Chimera
signing identity `ceo`; `rj` is provenance, never authority. The main RJ capsule
is recorded separately from specialist manifests and rematerialized with the
same digest when the pilot restarts.

## Current execution boundary

An imported specialist can receive and return a signed bounded task through an
isolated Harness worker, durable mailbox, read-only continuity workspace, and
DSH-mediated tool boundary. Each roster card exposes a separate access profile
and model policy. **Auto** selects by task, **Preferred** falls back to Auto
before dispatch, and **Pinned** fails closed if its exact conversation model is
unavailable. Media-only image and video models cannot be assigned as an
agent's conversational route.

Importing continuity does not migrate a running Hermes process, OAuth session,
schedule, credential, or implicit tool permission. Skill scripts and assets
still require a later verified dependency resolver before execution.
