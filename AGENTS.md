# Convertigo Agent Bridge Notes

This project is the Convertigo-side runtime bridge for local AI agents such as
Codex and Vibe. Keep this file current when workflow decisions or runtime
contracts change, so another agent can resume the work without rediscovering the
same context.

## Convertigo Project Editing

- Do not hand-edit `_c8oProject/*.yaml` or `c8oProject.yaml`.
- Use the Convertigo MCP tools for every Convertigo object mutation, then verify
  the live tree with `databaseobject_tree_get` when needed.
- Direct edits are acceptable for plain source files such as `js/*.js`,
  `docs/*.md`, `README.md`, and this `AGENTS.md`.
- After editing JavaScript helpers, run `node --check` on the touched files.

## Runtime Scope

- Default Studio workspace root is usually
  `/Users/nicolas/dev/convertigo/runtime-ConvertigoStudioHotfix/.metadata/.plugins/com.twinsoft.convertigo.studio`.
- Runtime agent files must live under `<workspaceRoot>/agents`, not under the
  Eclipse metadata plugin directory guessed from the repository.
- Do not commit generated runtime content from `<workspaceRoot>/agents`.
- Agent settings expose each managed CLI's installed version. Checking the
  latest available version is opt-in through `checkUpdates` and cached to avoid
  registry traffic during normal agent calls. The default cache is persisted for
  six hours in `<workspaceRoot>/agents/runtime-update-checks.json`. The same file
  also keeps the last discovered provider model catalog, default model, and
  default reasoning level so presence-only startup checks can hydrate the prompt
  bar without invoking the CLI. Use
  `refreshUpdateCheck` only for an explicit user refresh or immediately after an
  install/update.
- Startup environment checks must use `runtimePresenceOnly`. This checks known
  managed paths and `PATH` entries without invoking the CLI; full model
  discovery is deferred until configuration is opened or the agent starts.
- Provider readiness requires both a usable managed runtime and locally
  configured authentication. Settings expose only authentication presence,
  status, source type, and the required action; never expose credential values.
  Codex accepts a scoped/user `auth.json` or `OPENAI_API_KEY`. Vibe accepts
  `MISTRAL_API_KEY` from the scoped/user `.vibe/.env` or process environment.
- When no provider is ready, settings must leave the default provider empty so
  the Assistant can ask the user to choose Vibe or Codex. Runtime setup may
  finish with `authentication_required`; session start must stop immediately in
  that state instead of spawning a process that will fail remotely.
- Runtime installation and updates are explicit operations. Codex updates use
  the managed `@openai/codex@latest` package and Vibe updates use the managed
  `mistral-vibe` package. Do not silently update a provider while starting or
  resuming a conversation.
- Runtime archive downloads must use the Convertigo engine HTTP client. Every
  network-capable child process started by the bridge, including npm, pip,
  Codex, and Vibe, must receive proxy variables derived from the engine
  `ProxyManager`, including bypass domains and the local NTLM bridge when
  applicable. Never log proxy URLs containing credentials.
- Refresh model capabilities from the installed CLI after setup. A runtime
  update affects new agent processes/conversations; an already running process
  may keep its previous model catalog until it is restarted.

## Claude Code Integration

- Main file: `js/agent_bridge_claude.js`, loaded after the Codex file by
  `js/vibe_agent_bridge.js`. Sequences: `agent_claude_setup`, `agent_claude_start`,
  `agent_claude_prompt`, `agent_claude_close`.
- Protocol `claude-stream-json`: one resident `claude -p` process per handle,
  fed on stdin with `{"type":"user",...}` messages; `--resume <sessionId>` on
  restart. Model or effort changes restart the process, never a second one.
- Managed home is `<workspaceRoot>/agents/claude/homes/users/<id>/claude-home`
  (`CLAUDE_CONFIG_DIR`). MCP is declared in `convertigo-mcp.json` with
  `Bearer ${CONVERTIGO_MCP_TOKEN}` and passed with `--strict-mcp-config`; the
  token only exists in the process environment.
- Skills are delegated to `lib_ConvertigoMCP._setupClaude` with
  `configureMcp=false`; the bridge adds the legacy-only `convertigo-studio`
  router. Claude never receives the Flow pack or `convertigo-nocode` in the
  Studio profile.
- Authentication mirrors Codex: sync `.credentials.json` from `~/.claude` or the
  user-scoped home, or import it from the macOS keychain; verify with
  `claude auth status`. Never log or return token values.
- Playwright viewer automation is not wired for Claude yet; `CLAUDE.md` tells
  the agent to report unvalidated browser proof instead of bypassing.
- Tests: `node tests/claude_provider.test.js`.

## Claude and Vibe viewer automation

- Claude and Vibe reuse the Codex viewer wiring: `ensureManagedViewerDebugPort`
  leases one JxBrowser debug port per conversation, the managed home becomes
  conversation-scoped, `X-Convertigo-Viewer-Debug-Port` is sent to the
  Convertigo MCP, and `@playwright/mcp` is installed in the provider npm prefix
  (`agents/claude/npm`, `agents/vibe/npm`) and declared as a stdio MCP server
  bound to `--cdp-endpoint http://127.0.0.1:<port> --shared-browser-context`.
- Claude declares it in the generated `convertigo-mcp.json`; Vibe declares it in
  the managed `config.toml` (`transport = "stdio"`). Settings probes
  (`discoverVibeSettings`) must pass `disableViewerDebugPortReservation` so they
  never lease ports.
- Playwright tool names are `mcp__playwright__browser_*` for Claude; the Flow
  capability pack still requires Codex.

## Vibe image attachments

- `agent_vibe_prompt` accepts `images` (JSON array of local paths). `vibePrompt`
  turns PNG/JPEG/GIF/WebP files into ACP image blocks (10 MB, 8 images max)
  only when `vibeModelSpec(model).supportsImages` is true; otherwise the images
  are skipped, a `warning` event is emitted and the prompt tells the agent to
  say the model cannot see images.
- Verified 2026-09-14: `mistral-vibe-cli-latest` (vibe-thinking, Mistral Medium
  3.5) accepts images; `zai-glm-5-2` through Mistral returns 400 "Image input is
  not enabled for this model". `VIBE_GLM_SUPPORTS_IMAGES` records that fact and
  `migrateManagedVibeModelPresets` realigns existing managed presets.

## Codex Integration

- Main files:
  - `js/agent_bridge_common.js`
  - `js/agent_bridge_codex.js`
  - `js/vibe_agent_bridge.js`
- The default Codex home scope is `user`, not the user's global home. When a
  Studio JxBrowser CDP endpoint is supplied for Playwright MCP and no scope is
  explicitly forced, use `conversation` scope so each live viewer context gets a
  fresh Codex home and config.
- The visible default Codex home path is:
  `<workspaceRoot>/agents/codex/homes/users/<stable-user-id>/codex-home`
- Avoid hidden `.codex-home` directories for the default managed home; Finder
  visibility matters for support and demos.
- The Codex CLI should be installed under `<workspaceRoot>/agents/codex/npm`
  when the managed workspace install path is used.
- The managed Codex runtime must also install `@playwright/mcp` in the same npm
  prefix, with browser downloads disabled. Codex `config.toml` must expose it as
  `[mcp_servers.playwright]` using `npx --prefix <workspaceRoot>/agents/codex/npm
  playwright-mcp --cdp-endpoint <Studio JxBrowser debug URL>
  --shared-browser-context` only for viewer-scoped homes. For forced shared/user
  homes, keep Playwright MCP disabled unless the caller explicitly accepts a
  hardcoded endpoint.
- Agents must use the Playwright MCP browser tools for viewer automation. Do not
  instruct agents to run ad hoc Node scripts with `require("playwright")` or
  `chromium.connectOverCDP(...)`. If the browser target is `about:blank` before
  `mobile-builder-open` reports `browserControlReady:true`, instruct the agent
  to poll the builder readiness. If the tools are unavailable, disabled, still
  on `about:blank` after readiness, stale, or attached to another endpoint,
  instruct the agent to report the managed MCP configuration issue instead of
  bypassing it.
- Codex setup must synchronize the Convertigo Generalist skill into the managed
  `codex-home/skills/convertigo-generalist/SKILL.md` and write MCP config into
  `codex-home/config.toml`. The Convertigo MCP entry must include the static
  `X-Convertigo-Guidance-Version` header matching the managed skill version.
  Studio/generalist conversations also reserve one stable JxBrowser debug port:
  write it both to Playwright's `--cdp-endpoint` and to the Convertigo MCP
  `X-Convertigo-Viewer-Debug-Port` header. The MCP injects that transport value
  into viewer calls, so prompts and agents must not carry the port themselves.
  Normalize the managed Playwright CDP endpoint to `127.0.0.1` so Node does not
  resolve `localhost` to an IPv6 listener that JxBrowser does not expose.
- Keep `codex-home/managed-skill-bundle.json` as the per-conversation content
  fingerprint for managed skills. A new conversation records its initial
  baseline because it has no stale context. A resumed conversation must reread
  only the skills whose SHA-256 changed, and the bridge acknowledges the new
  bundle only after observing those reads. If installed skill content changes
  while a resident app-server is alive, restart it before submitting the next
  prompt.
- In Flow reveal mode, canonical frontend source writes use `reveal: true`.
  After the first frontend read of every resumed turn, agents call the
  idempotent `dev.ensure` action with `wait:false` before mutation so a Studio
  restart does not hide the live construction phase.
  Local images are imported only through `frontend-svelte-asset-import`; its
  returned `resources/...` URL is the canonical authoring value. Do not teach
  agents to copy project assets with shell commands or into generated static
  directories.
  Before a Playwright action, call `frontend-svelte-action` with `dev.open` and
  continue only when it reports `browserControlReady: true`.
  When an existing conversation home is repaired, restart its resident Codex
  app-server automatically before submitting the pending prompt.
- When the Assistant passes `agentProfile=nocode`, `skillProfile=nocode`,
  `assistantContext=nocode`, or targets the `C8Oforms` project, setup must use
  the managed `convertigo-nocode` skill instead of `convertigo-generalist`.
  C8Oforms should also pass the authenticated `userId` and `user` home scope so
  each user gets separate Codex/Vibe homes under the workspace agent runtime.
- For NoCode Codex sessions, the Assistant creates the C8Oforms MCP token from
  the authenticated session and passes only an opaque server-memory handle to the
  bridge. The bridge resolves that handle, sets `C8O_NOCODE_MCP_TOKEN` only in
  the Codex process environment, and writes `bearer_token_env_var` to
  `codex-home/config.toml`; never write the raw token to config files, prompts,
  logs, or conversation records.
- For Studio/generalist sessions, the Assistant supplies an opaque handle for a
  short-lived `lib_ConvertigoMCP` token. Resolve it only from the shared server
  store, inject it as `CONVERTIGO_MCP_TOKEN`, and configure Codex or Vibe to
  derive the Authorization bearer header from that environment variable. Never
  persist or return the raw token.
- The same opaque handle and `CONVERTIGO_MCP_TOKEN` secret authenticate both
  Legacy and Flow MCP endpoints. Configure both MCP entries with that variable
  and fingerprint the common token when deciding whether a resident agent
  process must restart.
- Experimental Flow support stays on the private `codex/flow-agent-profile`
  branch. The Studio user has one Codex home containing both the Legacy and
  Flow MCP servers. `lib_ConvertigoMCP._setupCodex` owns the Legacy skill pack and
  `lib_flow_mcp._setupCodex` owns the Flow pack; AgentBridge adds only the small
  routing skill. Legacy/Flow profiles are routing hints and conversation
  metadata, never home or history boundaries.
- Treat Flow as an alpha capability, not as baseline Convertigo vocabulary.
  Expose its profile, prompts, skills, MCP entry, and setup requirements only
  when the running engine is at least 8.5.0 and both `lib_flow_engine` and
  `lib_flow_mcp` are loaded. Otherwise Studio setup and user-facing guidance
  must remain standard Convertigo-only and must not mention Flow.
- Keep `assistantSurface` independent from authoring routing. A value such as
  `studio` describes the host UI and must never silently select Legacy.
- A non-`studio` Assistant user is a NoCode identity. It must be forced to the
  NoCode capability pack and must never receive Legacy or Flow MCP access.
- The MCP endpoint should be derived from the current Convertigo endpoint when
  possible. Local hotfix Studio commonly uses
  `http://localhost:18082/convertigo/api/mcp`; standard Studio/server ports may
  differ.
- Validate Codex setup with `lib_ConvertigoAgentBridge.agent_codex_setup` before
  debugging Assistant UI symptoms.
- Codex runs in resident app-server mode by default:
  `codex app-server --listen stdio://`. `agent_codex_start` must stay
  idempotent for a live handle and return `already_running` rather than spawning
  another process.
- Codex app-server starts write PID metadata under
  `<workspaceRoot>/agents/codex/app-server-pids/<handle>.json`. Keep this file
  in sync with close/sweep behavior so project reloads do not leave invisible
  orphan processes.

## Current 1.2.0 Roadmap

- Expose an agent settings/capabilities contract for the Assistant UI.
- Models and reasoning choices must be discovered from the installed CLIs when
  possible, not maintained only as Assistant-side hardcoded values.
- The contract should describe providers, available models, default model,
  reasoning levels, and support flags such as resume, stop, images, and MCP.
- Vibe model and reasoning choices come from ACP `session/new.configOptions`
  and later `config_option_update` events. Do not infer the account-specific
  catalog only from `config.toml`; cache the ACP result per scoped `VIBE_HOME`.
- Keep the Convertigo Generalist skill synchronized and forced by setup; it
  should not be a user-visible choice in Studio.
- `mobile-builder-open` may return `browserDebugUrl`,
  `browserDevToolsJsonUrl`, and `browserDevToolsWebSocketUrl`. These values
  target the visible Studio JxBrowser mobile viewer. The bridge should scope the
  CDP endpoint to the managed Codex home used for that conversation so
  `[mcp_servers.playwright]` starts `@playwright/mcp` against the visible viewer
  instead of opening a separate browser.

## Vibe Integration

- Main files:
  - `js/agent_bridge_common.js`
  - `js/agent_bridge_vibe.js`
  - `js/vibe_agent_bridge.js`
- Vibe conversations and homes are managed under `<workspaceRoot>/agents/vibe`.
- Vibe setup is workspace-managed like Codex setup: install or reuse the
  standalone Python under `<workspaceRoot>/agents/runtimes/python`, create the
  Vibe venv under `<workspaceRoot>/agents/vibe/.venv` with that Python, and run
  only the managed `vibe` and `vibe-acp` binaries. External Python/Vibe paths
  are diagnostic or explicit opt-out fallbacks, not the default runtime.
- Bootstrap each scoped `VIBE_HOME` by synchronizing `~/.vibe/.env` when it
  exists. Start Vibe with the `vibe-home` credentials policy by default; do not
  send the raw Mistral key through Assistant sequence payloads.
- Apply an Assistant model or thinking selection through ACP
  `session/set_config_option` after `session/new`. The remote Vibe catalog can
  also contain account-routed models that are not present in the initial static
  TOML file.
- With Vibe 2.25 and later, MCP custom headers must live in the explicit
  `[mcp_servers.auth]` block (for example as an inline `headers` map). A legacy
  `[mcp_servers.headers]` table cannot coexist with explicit authentication.
  Full settings discovery repairs this managed configuration through
  `lib_ConvertigoMCP._setupVibe` and invalidates the cached model catalog before
  starting ACP discovery.
- Keep a managed `glm-5-2` preset targeting `zai-glm-5-2`: account-routed
  models are not guaranteed CLI defaults. Migrate the former managed alias
  without deleting its model definition or touching user-defined presets.
- Synchronize generalist Vibe guidance through
  `lib_ConvertigoMCP._setupVibe`. The generated entry point is
  `skills/convertigo-vibe-generalist/SKILL.md`; never copy or direct the agent
  to the MCP repository's root `AGENT.md` or `TOOLS.md`, which are maintainer
  documentation.
- In NoCode/C8Oforms contexts, Vibe should resolve home scope by user, not by
  conversation, unless the caller explicitly overrides the scope.
- Do not add project names into the filesystem path for Codex/Vibe homes.
  Projects belong in conversation metadata (`projectNames`, `primaryProject`)
  so one conversation can cover no project, a scratch flow, or several impacted
  projects without changing homes.
- The Assistant startup path should not auto-resume the latest conversation.
  It should list conversations and capabilities; a conversation becomes active
  only when the user resumes it explicitly or sends the first prompt.
- Once the user explicitly resumes a Codex conversation, the Assistant may
  prewarm the resident app-server before the first prompt. This prewarm is
  best-effort and should still rely on `agent_codex_prompt` start fallback if the
  process is not ready.
- Python/Vibe setup is separate from Codex setup. Keep the shared helper logic in
  `agent_bridge_common.js` and provider-specific behavior in the provider files.

## Event Flow

- Assistant UI reads agent progress through `agent_events` / long polling.
- Do not depend on WebSocket for now; it is not yet supported by the server/SDK
  and is often blocked in enterprise environments.
- Avoid flooding Studio logs. Prefer long polling and meaningful progress
  events over tight polling loops.
- Stop/close behavior should be explicit and should clean up process handles kept
  in server memory.

## Build And Release

- Follow the standard Convertigo project build used by the neighboring projects;
  do not invent a custom GitHub Actions build path.
- Tags are expected to match the Convertigo project version when producing `.car`
  releases.
