# Agent storage directory

The global Convertigo symbol `assistant.agents.directory` optionally selects the
absolute directory containing Tigo's managed runtimes and agent data. Set it in
the Studio's Convertigo administration **Symbols** page, not in the browser or
a provider prompt. This configuration is shared by Assistant, Agent Bridge and
Convertigo MCP; update the three projects as one stack.

Without the symbol, or with an empty value, the existing location is unchanged:
`<engine workspace>/agents` (inside the Eclipse workspace plugin state in Studio).
With the symbol, a value such as `C:\tigo-workspace1` replaces that directory
itself: Vibe is installed under `C:\tigo-workspace1\vibe`, not an extra `agents`
subdirectory. Choose a short, writable, dedicated directory per workspace and
per operating-system user. Do not share it between engines or users. A bare
filesystem root, relative path or drive-relative path such as `C:folder` is
rejected. Enter a concrete absolute path: environment-variable syntax is not
expanded by this setting. UNC locations still depend on client/server policy;
a local directory is preferable for executable runtimes.

This reduces path lengths on Windows without requiring a registry change. It
is not a guarantee that every dependency fits every Windows path limit. It
does not grant directory permissions or change enterprise security policy.

The same location is used for provider installations, managed homes and caches,
conversations and attachments, gateway credentials and TigoAccess metadata,
personal prompt/skill/MCP resources, feedback and agent process guards. Vision
and browser helpers resolve their keys and runtime paths there too. Existing
project assets and the engine's separate `subagents/` run directory are not
relocated. No secret value is returned to the frontend by this setting.

## New installation

1. Install the matching three-project stack.
2. Select a dedicated short directory that the Studio account can create/write.
3. Define `assistant.agents.directory` before installing the provider runtime.
4. Reopen the Assistant and explicitly install/configure the runtime.

## Existing installation

Stop active agent conversations/processes before changing the setting. No
automatic migration or fallback to the previous directory is performed. Keep
the previous directory intact until the new setup has been checked.

For a clean runtime retry, let the Bridge reinstall its managed Python/Node/CLI
at the new location. Do not move an installed Python virtual environment: it
can embed absolute paths. Authentication and existing conversations/resources
need an explicit, reviewed transfer or fresh sign-in. In particular, preserve
a manually supplied `convertigo/llm-api-key` and its metadata when transferring
account data; never put them in Git, logs, screenshots or release archives.

An invalid/unwritable configuration must be fixed rather than silently selecting
another storage location. To return to the original location, stop agents, clear
the symbol, then reopen the Assistant; the original files were not removed.

## Validation

Offline tests cover default behavior, short POSIX/Windows/UNC destinations and
invalid-path rejection. No Code image ownership checks also cover an external
storage root. Native Windows/Citrix installation remains an acceptance test on
the target environment; a successful macOS test does not certify Windows.
