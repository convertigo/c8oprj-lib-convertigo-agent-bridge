# Agent capability routing

This document defines the private integration contract used while Flow support
is developed outside the public 8.4.4 branches.

## Boundary

The integration has four independent dimensions:

- `surface`: Eclipse Studio, Web Studio, or NoCode Studio.
- `identity`: the authenticated Convertigo user.
- `capabilities`: the MCP servers, skills, and viewer control installed in the
  selected agent home.
- `projectContext`: selected projects and the current viewer/debug endpoint.

The surface does not select an authoring technology. A low-code Studio session
must be able to work on Legacy, Flow, or mixed projects without changing home or
conversation. The authenticated identity determines whether low-code authoring
is available: only the `studio` user receives it; every other identity is
strictly NoCode.

## Studio routing

The `studio` user has one Codex home and one conversation history. Its setup
installs both capability packs:

- Legacy: `convertigo`, owned by `lib_ConvertigoMCP`, with
  `convertigo-generalist`.
- Flow: `convertigo-flow`, owned by `lib_flow_mcp`, with the Flow orchestrator,
  backend specialist, and Svelte specialist skills.
- Router: `convertigo-studio`, owned by AgentBridge.

The router chooses the owning capability for each task:

1. Explicit Flow, FlowScript, or Flow Svelte intent selects Flow.
2. Explicit Legacy or NGX intent selects Legacy.
3. Existing FlowEngine and Flow frontend objects select Flow; Sequences,
   Connectors, Application, and NGX objects select Legacy.
4. Mixed projects may use both MCPs, but each mutation goes through the MCP that
   owns the target model.

The persisted `generalist` and `flow` descriptors remain routing hints and
compatibility metadata. They do not remove the other Studio MCP and must never
split or hide the Studio conversation history. `assistantSurface=studio`
identifies the host UI only; it does not force Legacy authoring.

There is no silent fallback after a capability error. The owner must be fixed or
the configuration defect reported. Convertigo YAML and generated files are not
an escape hatch.

## NoCode routing

Every authenticated identity other than `studio` receives only the `nocode`
profile, the Convertigo MCP NoCode capabilities, and the managed
`convertigo-nocode` skill. Such an identity cannot opt into Legacy or Flow by
passing another profile id or by running inside a Studio surface.

The Studio setup removes `convertigo-nocode` from the `studio` home so the
low-code agent cannot accidentally mutate a NoCode application.

A NoCode agent runs in the engine's container, as the engine's user. What it
may do besides the Convertigo MCP is the engine property `agents.tool_policy`
(`engine.util.AgentSandbox`; `files` on an engine without it):

| Policy | The NoCode agent gets |
| --- | --- |
| `mcp-only` | the Convertigo MCP tools only |
| `files` (`auto`, the default) | `read_file`, `write_file` and `edit` in the session's own folder (`scratch/<conversation>` beside the user's `VIBE_HOME`, its cwd and `TMPDIR`) and the tool results Vibe saved; no shell, `grep`, web or subagent |
| `sandboxed-shell` | files and the shell; the engine gives `files` where it cannot confine |
| `full` | what a Studio session gets |

Wherever the engine confines (Landlock, the `c8o-agent-sandbox` helper of its
Docker image), `vibe-acp` and every process it starts under `mcp-only`,
`files` and `sandboxed-shell` run through the helper: read only on the
runtime, writable only in the user's `VIBE_HOME` and the session's folder
(also its `HOME`, `TMPDIR` and cache), nothing else. The session refuses to
start rather than run unconfined.

`read_file` reads back, without asking, the tool results Vibe saved to a file
(`VIBE_HOME/logs/session/unified/*/tool-results/*`, through its allowlist).
For Vibe, the NoCode `config.toml` lists the tools a policy leaves out in
`disabled_tools` and turns off `run_typescript`'s background processes (but
under `sandboxed-shell`) and subagents; a resident NoCode process started
under another policy restarts on the same session. Under `mcp-only` and
`files` the Bridge also refuses any permission the session asks for a tool
that is not a Convertigo MCP one, instead of approving it. The Studio's own
session (`studio`) is never limited.

## Ownership

`lib_ConvertigoAgentBridge` owns provider lifecycle, isolated homes, sessions,
cancellation, event transport, secrets, Playwright/CDP wiring, unified Studio
setup, and generic capability descriptors. It must not know individual Flow MCP
tool names.

`lib_ConvertigoAssistant` owns the user conversation and surface context. It keeps a
single Studio history and asks the bridge for authoritative settings. Its prompt
routes through `convertigo-studio`; it does not expose a hidden Legacy/Flow mode
to the user.

Capability projects own their knowledge and installation:

- `lib_ConvertigoMCP._setupCodex` installs Legacy and NoCode packs.
- `lib_flow_mcp._setupCodex` installs the Flow MCP configuration and skills.

Missing required Flow setup is a configuration error. AgentBridge must not
generate a substitute Flow skill, call MCP through `curl`, or edit project files
directly.

## Descriptor contract

`agent_settings` returns:

- `agentProfile`: the current routing descriptor.
- `agentProfiles`: descriptors supported for the authenticated identity.
- `providers[].agentProfile`: the descriptor evaluated for that provider.

For `studio`, `generalist` and `flow` remain valid descriptors while the home
contains both capability packs. For any other identity, only `nocode` is
returned. Public descriptors expose policy, capability ids, MCP endpoint owner,
managed skills, and supported providers; they never expose credentials or
private home paths.

## Branch and rebase policy

Flow integration stays on dedicated local branches until it is ready to be made
public. Rebase these branches regularly on their 8.4.4 parent branches. Resolve
conflicts by preserving generic bridge contracts first and keep Flow-specific
knowledge in `lib_flow_mcp`.

Flow is an alpha capability and is available only when the running Convertigo
version is at least 8.5.0 and both `lib_flow_engine` and `lib_flow_mcp` are
loaded. When either condition is false, public capability descriptors, managed
setup output, prompts, skills, and MCP configuration must remain standard
Convertigo-only and must not mention or require Flow.

Validation before rebasing or merging:

1. An eligible `studio` setup installs both MCP servers and the routing skill in
   one home, without `convertigo-nocode`; an ineligible setup installs only the
   standard Convertigo capability and contains no Flow-facing guidance.
2. Explicit Flow and Legacy intents route to the matching owner without changing
   conversation identity or history.
3. Non-`studio` identities remain NoCode even if a low-code profile or Studio
   surface is requested.
4. Missing required Flow setup fails clearly and never falls back to Legacy.
5. The managed Playwright/CDP viewer endpoint remains profile-independent.
6. Resume, cancellation, progress events, and conversation storage remain
   routing-independent.
