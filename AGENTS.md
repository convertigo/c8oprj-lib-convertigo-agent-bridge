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

- For the public Assistant hosted at `assistant.convertigo.com`, backend-apps
  needs only `lib_ConvertigoAssistant`: do not deploy this Bridge or
  `lib_ConvertigoMCP` there. Both belong to the developer's local Studio stack.
  Publishing the three-project Studio bundle does not authorize deploying all
  three projects on backend-apps. A separate server/NoCode agent execution host
  has its own full-stack requirements.
- Default Studio workspace root is usually
  `/Users/nicolas/dev/convertigo/runtime-ConvertigoStudioHotfix/.metadata/.plugins/com.twinsoft.convertigo.studio`.
- Runtime agent files use the global symbol `assistant.agents.directory` when set;
  otherwise they live under `<workspaceRoot>/agents`. Do not infer the engine
  workspace from the repository or relocate existing data automatically.
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
- A full settings read probes each command once (`activeProbeMemo`, set by
  `C8O.agentBridge.settings` for the read only): `firstWorkingCommand` and the
  Playwright MCP probe answer from it. Codex is detected before and after its
  home is prepared, then Node and the Playwright MCP again for Claude; without
  it a No Code read ran `npm --version` six times, 10 s on test-nocode. Its
  timings line gives each provider's time (`providerMs`). Installs and starts
  never use the memo. Run `node --test tests/settings_probe_once.test.js`.
- Provider readiness requires both a usable managed runtime and locally
  configured authentication. Settings expose only authentication presence,
  status, source type, and the required action; never expose credential values.
  Codex accepts a scoped/user `auth.json` or `OPENAI_API_KEY`. Vibe accepts
  `MISTRAL_API_KEY` from the scoped/user `.vibe/.env` or process environment.
- Settings are read with the displayed conversation's id in the request, also
  while its turn runs (a viewer opening it). Settings may only run the periodic
  orphan purge (`cleanupAgentStorage({workspaceRoot})`), never the public
  `cleanupStorage`: its request fallbacks pick up that id and the
  exact-conversation cleanup stops the agent process (Vibe journals
  "client interrupt", Codex also loses its conversation home). Run
  `node tests/settings_storage_cleanup.test.js` after changing this.
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
- Always retain loopback hosts in child `NO_PROXY`, even with the engine proxy
  disabled. Failed PAC resolution must stop before spawning a network process.
  Gateway model discovery uses the engine HTTP client and the same proxy helper.
- The managed Vibe runtime is pinned to `mistral-vibe==3.1.0`; generated configs
  enable the system trust store. Cover proxy changes with
  `node --test tests/proxy_transport.test.js` and preserve cached model fallback.
- Refresh model capabilities from the installed CLI after setup. A runtime
  update affects new agent processes/conversations; an already running process
  may keep its previous model catalog until it is restarted.
- Runtime presence checks must stop at the first usable executable. On Windows,
  remove surrounding double quotes from PATH entries and explicit command paths;
  skip candidates that cannot be inspected or canonicalized. One malformed PATH
  entry must never abort all provider settings. Run
  `node --test tests/windows_runtime_paths.test.js` after changing discovery.
  These tests model Windows filesystem failures; they do not replace native
  Windows installation validation. After enabling Windows long paths, restart
  Studio (a Windows reboot may also be needed). An older bundle is not a proven
  workaround: this discovery code predates the 0.4.x releases.

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
  `configureMcp=false`; the bridge adds the `convertigo-studio` router.
  A Studio (generalist) Claude home holds both Legacy and Flow packs when Flow
  is available, and never receives `convertigo-nocode`. An explicit `flow`
  conversation gets the Flow pack only (see "Flow capability pack for Claude").
- Authentication mirrors Codex: sync `.credentials.json` from `~/.claude` or the
  user-scoped home, or import it from the macOS keychain; verify with
  `claude auth status`. Never log or return token values.
- Authentication probe cache keys use canonical CLI and home paths so Homebrew
  symlinks share one verdict. A successful login invalidates that entry in both
  memory and `agents/claude-auth-checks.json` once; repeated completed-login
  polls keep the new verdict cached. Run `node tests/claude_authentication.test.js`.
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
- Playwright tool names are `mcp__playwright__browser_*` for Claude. A Claude
  conversation gets the Flow capability pack only with the `flow` profile
  (Codex and Vibe Studio homes get it with any Studio profile).
- Electron Studio: the engine runs with the Java system property
  `convertigo.studio.cdp.port`, the CDP port of the Studio agent browser (one
  browser for the whole Studio, one page, `about:blank` until the agent
  navigates it; no `Target.createTarget`; `Browser.close` ends it). The Eclipse
  Studio never sets it. With it (`studioAgentBrowserCdpPort`, a value that is
  not a port 1024-65535 is ignored), `ensureManagedViewerDebugPort` gives every
  conversation that would lease a port that port instead, with no lease file,
  and `resolvePlaywrightMcpCdpEndpoint` turns every endpoint it would resolve
  into `http://127.0.0.1:<port>` (a call that resolves none still resolves
  none). The agent instructions of the three runtimes describe that browser
  instead of the Studio JxBrowser, and a Codex or Vibe turn on it is prefixed by
  `withStudioAgentBrowserPrompt`, since their Studio homes take the viewer rules
  from the Convertigo skills. Run `node --test tests/electron_agent_browser.test.js`.

## Flow capability pack for Vibe

- A Vibe Studio home (provider `vibe` or the `convertigo` gateway, any non
  No Code profile, `flow` included) gets the Flow pack when
  `flowCapabilityAvailable()` holds, as `setupCodexStudio` does for Codex.
- `writeLocalVibeConfig` declares a second `[[mcp_servers]]`,
  `name = "convertigo-flow"` (the server the Flow skills name; its tools read
  `convertigo-flow_<tool>`), on `/api/flow-mcp` of the same engine with
  `toolsRevision=<flowMcpCatalogRevision()>`, the same static auth
  (`api_key_env = "CONVERTIGO_MCP_TOKEN"`) and X-Convertigo-* headers as
  `Convertigo`, plus `X-Convertigo-Guidance-Version`. The `Convertigo` server
  always stays on `/api/mcp` (`vibeLegacyMcpEndpoint`), even for a `flow`
  profile. The recorded intent carries `flowEndpoint` (only when the pack is
  present, so homes without Flow are not rewritten), and the reuse check reads
  the Flow url back from config.toml.
- After `_setupVibe`, `syncVibeFlowPack` copies the three Flow skills from
  `lib_flow_mcp/_flow/resources/skills`, adds them to `enabled_skills` (an
  explicit list hides every skill it does not name), adds
  `[tools.convertigo-flow_*]` permissions for `VIBE_FLOW_TOOL_NAMES` and the
  routing section of AGENTS.md (before the compaction rules). Without Flow it
  removes all of it. A missing Flow skill source is a configuration error.
- The Flow server is never an ACP session server. Vibe merges the session
  servers over config.toml by name (`WithUnionMerge(merge_key="name")`) and keeps
  the session entry whole: its config headers, `tool_timeout_sec` and
  `startup_timeout_sec` are dropped. That is also why `buildMcpServers` repeats
  `X-Convertigo-No-Log`, `X-Convertigo-Reveal-Mode` and
  `X-Convertigo-Guidance-Version` on the session `Convertigo` server: the ones
  of config.toml never reached the engine.
- One MCP facade for a Flow conversation (`vibeFlowFacade`): when the
  conversation profile is `flow` (explicit, or a Flow primary project), the
  Vibe home declares `convertigo-flow` only, in config.toml (no `Convertigo`
  entry, no ACP session server), and the Convertigo tools a Flow project needs
  come through the relay of lib_flow_mcp (`LEGACY_RELAY_TOOLS`).
  `lib_ConvertigoMCP._setupVibe` is not run for such a home:
  `setupVibeFlowFacadeHome` writes its AGENTS.md (no Legacy guidance), the
  plan sync hook, `enabled_skills` with the Flow skills only and the built-in
  tool permissions `_setupVibe` would give. `inspectVibeConfig` reads the auth
  and headers of a Flow-only config from `convertigo-flow` (`flowOnly`), and
  the expected `endpoint` of its intent is "". Codex keeps both servers: its
  Studio home is shared by the user's conversations, and profiles are routing
  hints there.
- Vibe has no MCP `resources/read`: AGENTS.md tells the agent to read a Flow
  guide with `flow-resource-get` and its `uri` (lib_flow_mcp 0.2.4 answers it
  from the MCP resource). A failed `mcp_convertigo_flow.*` call counts as a lost
  MCP like a `mcp_Convertigo.*` one (`vibeMcpLostReason`).
- Run `node --test tests/vibe_flow_pack.test.js`.

## Flow capability pack for Claude

- A Claude conversation of the `flow` profile (explicit, or a Flow primary
  project; the profile exists only on an engine with Flow) gets the same one
  MCP facade as a Vibe one (`claudeFlowFacade`). A Studio Claude conversation
  always runs in a home of its own (`claudeStart` leases its viewer port), so
  no other conversation changes. The generalist and No Code profiles keep
  their homes; `flow` lists `claude` in `supportedProviders`.
- `bootstrapClaudeHome` writes `convertigo-mcp.json` with the options of the
  `flow` profile: `convertigo-flow` (HTTP, `/api/flow-mcp?jsonOnly=true`, the
  same `Bearer ${CONVERTIGO_MCP_TOKEN}` and headers as the Legacy `convertigo`
  server, `X-Convertigo-Guidance-Version` and `X-Convertigo-Agent-Provider:
  claude` included) and `playwright`, no `convertigo`. The Flow MCP relays the
  Convertigo tools a Flow project needs with those headers; the provider header
  keeps the gateway-model tools (`image-describe`, `browser-verify`,
  `subagent-run`) out of Claude's catalog.
- `installClaudeSkills` copies the three Flow skills from
  `lib_flow_mcp/_flow/resources/skills` (a missing source is a configuration
  error) and removes `convertigo-studio`, `convertigo-generalist` and
  `convertigo-nocode`: Claude Code offers every skill of its home.
  `lib_ConvertigoMCP._setupClaude` is not run for such a home. A Studio home
  removes the Flow skills of an earlier `flow` profile.
  `managedSkillBundleSlugs(options, "claude")` is the Flow skills for a Flow
  conversation; `claudePrompt` reads the bundle with the conversation's
  profile, since the Assistant's Claude prompt names none.
- `CLAUDE.md` is `claudeFlowInstructions`: one server, the Flow routing
  (`## Convertigo Flow routing`), the viewer and working rules, then
  `## After a context compaction (Convertigo Flow)`. Claude Code reloads
  CLAUDE.md after a compaction (`InstructionsLoaded`, `load_reason:
  "compact"`). Claude Code reads MCP resources, so the guides are read as
  resources (`flow-resource-get` stays a fallback).
- Permissions: nothing per server. Claude runs with `--permission-mode
  bypassPermissions --dangerously-skip-permissions --strict-mcp-config`, and the
  Bridge answers `can_use_tool` with allow, for `mcp__convertigo-flow__*` and
  `mcp__playwright__*` as for `mcp__convertigo__*`.
- Lost MCP: the `system/init` check stops the turn for any server that is not
  `connected`, `convertigo-flow` included. `inspectClaudeMcpConfig` expects the
  server of the conversation's profile.
- The gateway home (`claudeGatewayHome`) replaces its skills with the managed
  home's, so the skills of an earlier profile leave it too.
- Compaction: the Bridge sets nothing for Claude Code (no threshold, no
  `autoCompactEnabled`, no hook). Claude Code compacts at the auto-compact
  window (the model's context window, up to 1M) minus about 33k tokens (20k
  kept for the answer, 13k of margin); `CLAUDE_CODE_AUTO_COMPACT_WINDOW` or the
  `autoCompactWindow` setting (100k to 1M tokens) and
  `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` lower it, `DISABLE_AUTO_COMPACT` turns it
  off, a `## Compact Instructions` section of CLAUDE.md or a `PreCompact` hook
  steers the summary (checked in Claude Code 2.1.303).
- Run `node --test tests/claude_flow_pack.test.js`.

## Requests waiting for the panel

- lib_ConvertigoMCP leaves requests for the Tigo panel of a conversation in the
  server store `lib_ConvertigoAssistant.hostRequests` (keyed by the
  `X-Convertigo-Conversation-Id` the Bridge sends): a preview capture, or a No Code
  write held while the user has "Confirmer avant de modifier" on. The panel takes
  them when it reads the turn, after `agent_events` returns. `hostRequestWaiting`
  ends that wait at once for a `pending` request (once per request), so the card
  shows without waiting 10 s; a held call sends no event meanwhile.
- The confirmation gate itself is in the MCP router and keys on the No Code token,
  so the Bridge keeps answering Vibe permission requests itself
  (`choosePermissionOption`). Only Vibe sends the conversation header in No Code
  (`buildMcpServers`); Codex and Claude No Code configs are shared by the user's
  conversations, so they send none, and with the switch on the MCP refuses their
  writes (`cannot_ask`) instead of writing unconfirmed. Run
  `node --test tests/host_request_wait.test.js`.

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
- No Code (entries with `noCode`): `vibeImageBlocks` reads the user's
  attachments only (`noCodeAttachmentAllowed`: agents/<provider>/users/<user>/
  conversations/<id>/attachments, agents/attachments/<user>/); the path comes
  from the page. For a model that cannot see, `describeImagesForBlindModel` has
  each image described by image-describe, loaded from the installed
  lib_ConvertigoMCP (`js/tools_image_describe.js`), on the user's gateway key:
  3 images and 45 s per message at most, the description appended to the
  prompt, a "describe" line in startup-timings.ndjson, the calls kept in
  `convertigo-image-descriptions.json` beside the session journal and counted by
  `vibeJournalUsage`. Each described image is also pushed as an `image-describe`
  tool call (tool/start, tool/update with the image path and the description)
  right after turn/start, the prompt's cursor before them, so the Assistant shows
  its thumbnail as in the Studio. Cover with
  `node --test tests/nocode_image_describe.test.js`.

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
- Embedded NoCode MCP requests carry `X-Convertigo-Agent-Profile: nocode`.
  The MCP filters its catalog and rejects tools outside the explicit no-code
  allowlist. This is a capability restriction, not authentication: bearer
  validation and C8Oforms ACLs remain mandatory. Studio requests are unchanged.
  Synchronize a NoCode-only `AGENTS.md` for both Codex and Vibe; never suggest
  fallback to generic requestable/project tools. Read existing forms through
  `nocode-form-get` before advice or edits; empty updates are never reads.
- Vibe caches the MCP tool catalog on disk for 24 h, keyed on sha256 of the
  serialized server entry (`registry.py:_server_key`), and never reruns
  `tools/list` while that entry is fresh. Skills and `config.toml` are pushed by
  the bridge, but the catalog is pulled by Vibe, so a stack upgrade alone leaves
  an existing home on the previous tool list: that is how a 0.2.13 `SKILL.md`
  ended up telling an agent to call a `nocode-form-get` its catalog did not
  expose. `vibeMcpTransportEndpoint` therefore carries
  `toolsRevision=<managedMcpCatalogRevision()>`, folding the deployed
  `lib_ConvertigoMCP` version and the source skill hash into the URL, and
  `pruneVibeDescriptorCache` drops the entries left behind when the server entry
  is rewritten. Keep this parameter separate from `descriptorVersion`: the MCP
  compares that one byte for byte and reports `mcp_guidance_version_mismatch` on
  every guarded tool call. `buildMcpServers` and the managed `config.toml` must
  keep producing the same URL, or Vibe maintains two catalog caches.
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

## Who owns the managed MCP url (contract with lib_ConvertigoMCP)

Two independently released projects write the same `[[mcp_servers]]` entry of
the managed Vibe `config.toml`: this Bridge writes the file, then calls
`lib_ConvertigoMCP._setupVibe` through `installAgentSkills`, so the MCP project
always runs last on it.

**The Bridge owns the `url` of that entry.** It is built by
`vibeMcpTransportEndpoint` in `js/agent_bridge_common.js` and looks like:

```
http://<host>/convertigo/api/mcp?jsonOnly=false&from_bridge=true&descriptorVersion=<guidance>&toolsRevision=<hash>
```

- `from_bridge=true` is the ownership marker. `_setupVibe` (and `_setupCodex` /
  `_setupClaude`) must leave a marked url byte for byte alone. They still repair
  everything else in the entry: `tool_timeout_sec`, `[mcp_servers.auth]`, the
  `X-Convertigo-Guidance-Version` header, the `[tools.*]` permissions.
- Without the marker the MCP setup keeps its previous behaviour and rewrites the
  url to its own `?jsonOnly=true` form. That is deliberate: it still repairs a
  stale or hand-written entry, and an older Bridge paired with a newer MCP
  behaves exactly as it does today.
- A newer Bridge paired with an older MCP simply gets its url clobbered again,
  as before. Nothing crashes; only the cache-busting is lost.
- The marker is inert server side. `_c8oProject/sequences/mcp_endpoint.yaml`
  reads only `request`, `jsonOnly` and — as a fallback when the
  `X-Convertigo-Guidance-Version` header is absent — `descriptorVersion`. The
  `/api/mcp` URL mapper maps `request` and `jsonOnly` only, and ignores every
  other query parameter. Verified live: the same `tools/call` with and without
  `from_bridge=true` returns byte-identical responses, guidance handshake
  included.
- Why the url has to survive: Vibe caches the MCP tool catalog for 24 h under
  sha256 of the serialized server entry. `toolsRevision` (MCP project version +
  hash of the source skill) is the only lever that invalidates that cache under
  an existing home, and it only works if it is still in the file Vibe reads.
- Covered by `tests/agent_bridge_runtime.test.js` here, and by
  `tests/scripts/validate_setup_vibe_config.js` on the MCP side.

## Vibe Integration

- Managed Mistral GLM presets use `mistral-direct` with `backend = "generic"`
  and `api_style = "reasoning"`. The OpenAI adapter stringifies Mistral's
  thinking blocks into the answer; the reasoning adapter preserves separate
  answer/reasoning channels while forwarding low/high/max unchanged. Existing
  managed homes migrate on setup/start. Keep explicit custom cache prices.
- GLM input/output/cached-input estimates are 1.4/4.4/0.14 USD per million
  tokens. ACP cost is a session token estimate, never proof of a cash charge,
  subscription, or account balance. An API key can use a Mistral subscription.
- Keep `resolveVibeProfile` distinct from the public `vibeProfile` sequence
  input. Convertigo `include()` evaluates helpers in the request scope, even
  inside the loader IIFE; a helper named like the input overwrites it and
  silently selects Mistral instead of Convertigo. The sequence-level tests in
  `tests/vibe_sequence_profile.test.js` exercise this loader behavior for setup,
  start and settings without starting a runtime or touching credentials.
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
- Agent processes are swept (`sweepRegistry`) at each Vibe start, at most every
  10 s on event reads, and every minute by one daemon reaper thread per engine
  (`ensureAgentReaper`; bump `REAPER_REVISION` when the sweep changes). A process
  stops when dead, idle beyond its TTL (1 h, 20 min in No Code, at least 1 h in a
  turn), or prewarmed (`prewarm` on agent_vibe_start, one per user) and idle
  3 min without its first message. A No Code user keeps at most 3 Vibe
  processes, least recently used idle one first, never one in a turn. Each stop
  writes a "stop" line in `agents/vibe/startup-timings.ndjson`. A start finding
  its conversation's process still starting waits for it. Cover with
  `node --test tests/vibe_process_guards.test.js`.
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

## Plan sync hook (Vibe)

- Tigo shows the agent's `todo` list as the plan. In long builds the agent forgot it
  for dozens of minutes while keeping `docs/generated/PROGRESS.md` current (run 4:
  4 todo writes in about 600 tool calls), whatever the skill said.
- `setupVibeFromMcpProject` installs `hooks/vibe_plan_sync.py` as
  `VIBE_HOME/hooks/convertigo_plan_sync.py` and declares it in `VIBE_HOME/hooks.toml`
  (type `post_tool`, between `# BEGIN/END convertigo-plan-sync` markers; other hooks
  of the file are kept). Vibe runs it after every tool call with the Python of its
  own venv and appends its `additional_context` to the tool result the model reads.
- The hook appends a reminder to rewrite the todo list after a second PROGRESS.md
  write without a todo write in between, or after 25 calls without one
  (`CONVERTIGO_PLAN_SYNC_EVERY`), quoting the last todo list and the "Lots" section
  of PROGRESS.md. State: `<session>/convertigo-plan-sync.json`. It never rewrites
  the plan itself, and any error leaves the tool result untouched.
- A Vibe process reads hooks.toml when it starts: running conversations get the
  hook at their next start. `vibePlanSync=false` removes the block.
- Run `node --test tests/vibe_plan_sync.test.js` after changing this.

## Who may call the Bridge sequences

- Every Public sequence starts with `C8O.agentBridge.requireCaller();` right after
  `include("js/vibe_agent_bridge.js");` (`js/agent_bridge_access.js`). Anonymous callers
  are refused: the Studio listens on every interface, and these sequences drive agents
  that have file tools and the Convertigo MCP.
- Accepted: a WEB_ADMIN session, or the Assistant of this engine with the engine caller
  key in `X-Convertigo-Agent-Bridge-Key`. The key is created on first use in
  `context.server` (`lib_ConvertigoAgentBridge.callerKey.v1`) under the store lock, lives
  in memory only and changes at each engine start. lib_ConvertigoAssistant
  (`js/agent_bridge_client.js`) uses the same entry and lock.
- A new Public sequence must add the same call; `tests/agent_bridge_access.test.js`
  fails otherwise. `agent_quota` and `agent_session_metrics` keep their own WEB_ADMIN
  checks. Accessibility is no protection: the Studio runs Private requestables over HTTP.
- Run `node --test tests/agent_bridge_access.test.js` after changing this.

## Quota snapshots

- Private `agent_quota(handle, provider)` reads account rate limits from an existing
  Codex app-server or Claude stream-json process. Without a live process, an explicit
  authenticated quota read may run a short metadata-only CLI probe in the user
  home (30-second cache), without creating a conversation or sending a prompt. The authenticated Assistant
  facade chooses the server-only handle after checking owner/provider. Quota
  failures are nonfatal; no quota is added to public status or event buffers.
  The private sequence also checks Studio WEB_ADMIN or server authentication:
  Studio mode can execute Private requestables over HTTP, so Private alone is
  not the authentication boundary.
- `account/rateLimits/updated` (Codex), `rate_limit_event` (Claude) and ACP
  `usage_update` (Vibe) update aggregate snapshots in server memory, read only
  through the private quota sequence.
  Only Codex/Claude reported limit windows represent account quotas; ACP context
  tokens/cost are separate and do not imply a credit balance.
- Snapshots contain only provider, source, window percentages/reset times,
  timestamps and optional context/cost aggregates. Never pass credentials or
  raw protocol messages as a quota snapshot. Missing values are not zero usage.
- ACP context carries `limitKind: "compaction"` and `costKind: "session_estimate"`.
  Its size is the CLI's effective compaction threshold, not necessarily the
  model's maximum context length. Do not infer billing mode from a key or CLI name.
- Vibe session totals come from the unified journal (`vibeJournalUsage`, state in
  `<session>/convertigo-usage.json`) and travel as `journalUsage` with each
  usage update and as `quota.context.journal`. `requests`, `inputTokens`,
  `cachedTokens`, `outputTokens` and `cacheRate` are the agent's own model
  requests (context and cache). `models` has one entry per model of the session:
  the agent's models (`kind: "agent"`, cost from the journal tokens at the Vibe
  config prices, `costSource: "journal"`) and the vision models of the Convertigo
  MCP tool `image-describe` (`kind: "vision"`, `calls`, cost the gateway
  charged, `costSource: "gateway"`) and the sub-agent runs of `subagent-run` and
  `browser-verify` (`kind: "subagent"`, one row per `profile` and `model`, key
  `subagent:<profile>|<model>`, `runs`, `calls` = model calls, gateway cost),
  read from the `tool_succeeded` results whose usage block names one of these
  tools, each counted once by its `callId` (the run id for a sub-agent).
- The Convertigo MCP server entries carry `X-Convertigo-Conversation-Id` (the
  Tigo conversation, `mcpConversationId`): always in the ACP session servers,
  in a config file only for a conversation-scoped home (with a viewer port).
  The MCP sub-agent tools record their runs under it.
  `costAmount`/`costCurrency` and `sessionTokens` are the whole session, every
  model included; a cost is null when one model of the session has none. Codex
  and Claude conversations do not read the vision calls yet.
- Run `node tests/agent_quota.test.js`, `node tests/claude_provider.test.js` and
  `node tests/agent_bridge_runtime.test.js` after changing this contract.

## CLI metadata discovery

- Claude model labels, resolved versions and effort levels come from the installed authenticated CLI stream-json `initialize` reply. Generic family aliases are compatibility fallback only. Catalog caches are scoped to the Claude home; presence-only startup never runs the CLI.
- Claude quota refresh uses `get_usage` with `skip_behaviors:true`, including before the first prompt. Those percentages are already 0–100; `rate_limit_event` utilization is a 0–1 fraction. Normalize ISO resets to epoch seconds and include model-scoped weekly windows. Raw control replies (account identity included) never enter public events.
- Codex metadata probes use only initialize and `account/rateLimits/read`, with no thread creation. Vibe ACP still supplies context usage rather than account credit.
- Push/tag CI only builds CARs and publishes pre-releases; it never deploys,
  regardless of `[skip deploy]`. Stable promotion is manual after review.

- A newer workstation Keychain OAuth expiry takes precedence over an older managed credential file when synchronizing conversation homes. A copied file’s modification time alone must not make an expired session win over a later sign-in.

- Modern Claude Code uses a home-hashed Keychain service on macOS. `CLAUDE_SECURESTORAGE_CONFIG_DIR` points conversation processes at their user’s auth home while `CLAUDE_CONFIG_DIR` keeps MCP/viewer settings isolated. Read the scoped Keychain service before legacy global credentials; never overwrite a new sign-in with an expired snapshot.

## Windows installation diagnostics

- Full Windows settings checks read `LongPathsEnabled` and probe a temporary
  >260-character file path in `agents`, then clean it up. Short write failures
  are inconclusive; never label them as disabled long paths. Presence-only
  startup reuses the five-minute cache and does not spawn diagnostic commands.
- Expose only PATH entry position, length and category. Never publish PATH
  contents, registry command output, credentials or per-user keys as diagnostics.
- See `docs/windows-runtime.md`. Native Windows verification remains necessary;
  a passing Java filesystem check does not certify Python/npm support.

## Tigo 1.5 custom resources

- Bridge 0.4.23 accepts `tigoResourcesHandle` on provider start/prompt sequences.
  `js/agent_bridge_resources.js` resolves it only from private shared memory;
  reject missing/expired handles. Never accept inline connection credentials.
- Preserve the mandatory managed Convertigo MCP/skills. Additional connections
  are named `tigo_<hash>`, scoped to conversation homes and replaced only when an
  explicit broker context is supplied. Do not remove unrelated user servers.
- Codex TOML uses `env_http_headers` and `env_vars`; Claude JSON uses `${ENV}`
  references. Vibe ACP HTTP headers exist only transiently in session memory;
  ACP stdio entries have no `type` property and use name/value `env` arrays.
- Apply custom secret environment values only to the intended provider process.
  Configuration files and public protocol replies must not contain raw values.
- Run `node --test tests/tigo_resources.test.js` together with runtime/provider
  tests when changing this contract. Assistant 1.5.0 owns library UI/storage and
  determines when a configuration change requires process restart and resume.

## Release channels

- Stable Tigo bundle: Assistant 1.4.49, Bridge 0.4.22, MCP 0.2.23.
- Preview Tigo bundle: Assistant 1.5.1, Bridge 0.4.24, MCP 0.2.24.
- All new GitHub tag publications are pre-releases and cannot become Latest
  automatically. No push or tag deploys a server. Hosted Assistant deployment
  has a separate manual workflow in its repository; do not deploy Bridge/MCP
  on backend-apps merely to host assistant.convertigo.com.

## Gateway model refresh and image support

- `refreshModelCatalog` bypasses the five-minute gateway model cache and the
  provider metadata cache. Runtime presence checks stay offline, and a failed
  refresh retains the last known offer. Parse each flag before combining it.
- Empty cached effort lists are retried at catalog expiry; explicit refresh
  rechecks all efforts. An unrelated HTTP 400 is an unknown probe result, not
  evidence that reasoning is unsupported. After applying a gateway offer,
  recompute `supports.reasoning` and `reasoningMode` from the offered levels,
  including when restoring an old provider cache. Cover this with
  `node --test tests/gateway_effort_refresh.test.js`.
- Mistral Large 4 (`mistral/mistral-large-4` and its ACP alias) accepts images.
  Declare `supports_images = true` in its managed config and transmit ACP image
  blocks; GLM remains text-only. Do not apply GLM capabilities to every model.
- Configuration intent revision `gateway-vision-v2` refreshes existing managed
  configs without requiring runtime reinstallation. If an attachment is skipped
  for an unknown capability, explain that it was not transmitted rather than
  claiming the upstream model cannot see images.
- `node tests/gateway_models.test.js` checks metadata refresh, offline startup,
  stale-catalog fallback and the outbound ACP image payload without inference.


## Studio native tools

Every Studio skill profile keeps the Studio native tool policy; only No Code is restricted.
Prefer the owning Convertigo MCP tools for authoring, without disabling native tools for Flow.

## Printed Vibe todo calls

`vibePrintedCallOf` recognizes complete `todo {JSON}`, `todo … {JSON}`, `todo:{JSON}` and `todo({JSON})` responses and reuses the existing
bounded printed-call retry (one per turn, never after Stop/refusal/error). The Bridge asks for a real tool call;
it never executes printed arguments. Keep ordinary answers, questions and malformed JSON outside this rule.
The short announcement detector also recognizes present-tense verification after a write;
read-only turns and requests for user input still finish normally.
Run `node --test tests/vibe_turn_nudge.test.js` and the Bridge suite after changing it.
Before changing the runtime pin, set `VIBE_TEST_PYTHONS` to a JSON array of the
Python executables for the previous and new installed runtimes, then run that
test. It validates the generated `mistral` and `convertigo` configurations and
feeds their actual ACP serializers through the turn handler, entirely offline.
The current matrix covers 3.0.4 and 3.1.0; it does not replace live model tests.

## Vibe turns ending on a tool error

`vibeToolErrorAnswerOf` recognizes a final message that is only the error of a tool call: `<tool> failed: <JSON
error | exception | one short line>`, a JSON error object, or an exception line with only stack lines after it.
The turn is nudged (reason `tool_error`, the shared two-nudge bound) only when it made a tool call and the last
ACP plan update (`entry.planEntries`, the todo list Tigo shows) still has a pending or in-progress step. A finished
plan, no plan, prose that explains the error, Stop, cancellation and refused writes end the turn as before.
Run `node --test tests/vibe_turn_nudge.test.js` and the Bridge suite after changing it.

## Flow MCP failures and per-request journal measures

Flow MCP errors keep `isError:true` for every provider. `mcpResultError` recognizes MCP envelopes in
provider results; both ACP events and journal metrics classify a nominal `completed`/`tool_succeeded`
containing such an error as failed. Do not treat an application result's ordinary `error` property as a tool failure.

Usage state v3 / metrics v2 retains bounded `modelRequests` (1000 rows) with observed journal start/end,
duration and available input/cached/output/reasoning tokens. Prompt text and tool arguments never enter these rows.
First-token and provider-latency fields remain null unless the provider reports them; journal boundaries are
labelled `journal_boundary` and are not provider latency. Request details travel in explicit exports, not every
usage update. Migration rereads retained journal segments and preserves the previous metrics snapshot.
Run `node --test tests/vibe_mcp_metrics.test.js` and `tests/agent_quota.test.js` after changing this contract.

Printed `todo({...})` calls are recognized too. After bounded nudges fail, the turn ends with
`incomplete:true` and `PRINTED_TOOL_CALL`, and emits a progress diagnostic; it never executes printed arguments.

## Tigo right of the No Code Studio

- A No Code session needs the Tigo right of its user (C8Oforms `tigo_rights`).
  The Assistant checks it for the user of the session; the Bridge checks it
  again on the agent's No Code MCP token (`noCodeAgentRefusal`): at
  `vibeStart`/`codexStart`/`claudeStart` and at each prompt (a running entry
  keeps `noCodeAccess`), C8Oforms `APIV2_McpTokenValidate` answers
  `agent_not_allowed` once the right is withdrawn. Without a token, or without a
  C8Oforms that knows the right (no `APIV2_AgentAccess`), the Bridge leaves it to
  the Assistant and the MCP. Cover with `node --test tests/nocode_agent_access.test.js`.

## Managed No Code permissions

- Restricted ACP sessions deny missing or unrecognized tool permission titles.
  Native file tools operate within the session folder; requests outside it are
  refused. A missing title emits `permission/refused` with `unknown_tool`.
- Without Landlock, `files` and `sandboxed-shell` resolve to `mcp-only`, including
  engines that do not expose sandbox diagnostics. Studio sessions retain their
  existing policy. The policy revision refreshes homes and restarts residents.
- Restricted managed configurations select `accept-edits`, disable blanket
  approval, and deny file access outside the working directory. These settings
  supplement kernel confinement; they do not replace it.
- Run `node --test tests/nocode_tool_policy.test.js` and the full test suite.



## No Code per-user gateway keys and the Tigo budget

- Design, isolation analysis and the checks left to securite-cve: `docs/nocode-user-keys.md` (contract
  `tigo-nocode-contract.md` sections 6 and 8, convertigo/c8oprj-tigoaccess#5).
- `userGatewayKeysOn`: a No Code session on a server whose C8Oforms has `APIV2_TigoUserKey` and that is registered with
  TigoAccess (`C8Oforms.tigo.server.id`). There the gateway key is
  the user's, from the masked `gatewayKeyHandle` (server memory, written by the Assistant). It goes into the process
  environment only, never into a home `.env` or the key file (`scrubGatewayKeyFromEnvFile` removes an old server key).
  Nothing falls back to the server key: a missing handle gives `gateway_credential_missing`. A new key restarts the
  process. The mode stays on once seen, until the engine restarts. The bundle's owner must equal the call's user. A
  running process keeps its key past its lifetime (by fingerprint). Events never carry the key (`redactUserGatewayKey`):
  each entry keeps the keys it was given in memory (`rememberEntryGatewayKey`, non-enumerable), so a renewed or purged
  handle changes nothing, and any `sk-` key-shaped token is masked as a floor. The Studio key file path is unchanged.
- On a server with per-user keys (`serverUsesUserGatewayKeys`: registered, or seen since the engine started), only a
  Vibe confined by Landlock under `files` or `mcp-only` runs, whatever the profile or the caller
  (`userGatewayKeyIsolationRefusal`, also checked when a process is reused). Every other agent answers
  `agent_isolation_unavailable`. `sandboxed-shell` is capped to `files` there (`engineNoCodeToolInfo`).
  `sandbox/c8o-agent-isolation-test.sh` (T1) checks the isolation on Linux, and the helper's CI runs it.
- `gatewayBudgetError` / `pushEvent`: a LiteLLM budget refusal (HTTP 429 `budget_exceeded`) is
  `{code: "budget_exceeded", scope, retryable: false}` on every error event, without the gateway message or ids.
  RPM/TPM and upstream 429s keep their handling.
- Vibe on the gateway loads `sandbox/python/c8o_gateway_budget.py` (`C8O_GATEWAY_BUDGET_HOOK=1`). A budget 429 is
  then not retried, and the hook prints `C8O_GATEWAY_BUDGET_EXCEEDED {"scope": …}` on stderr. Claude Code on a gateway
  model asks the gateway once at its first 429 retry. A Codex `error` with `willRetry` does not end the turn. The
  gateway probes (model list, efforts, budget) use the engine's HTTP client and proxy (`postGatewayChatCompletion`).
- Run `node --test tests/nocode_user_gateway_key.test.js tests/nocode_user_key_security.test.js tests/gateway_budget_exceeded.test.js`. With
  `VIBE_TEST_PYTHON=<managed venv python>`, the hook also runs against Vibe's real retry loop.

## Managed runtime update target

- The qualified package version has one source of truth in MANAGED_VIBE_VERSION.
  Installation and the update action must use that same target. Registry discovery
  may report a newer package, but that alone does not change the qualified target.
- runtime.latestVersion is the update action's target; availableVersion retains
  the registry result. Existing cached registry checks must follow the current
  target without rewriting the cache or starting a runtime.
- Run tests/runtime_update_target.test.js with the runtime and proxy suites.

## Printed JSON tool calls

The ACP adapter retains the complete final-message candidate up to 262144 characters,
separately from the short announcement tail. It never classifies a suffix after overflow.
A known tool or namespaced MCP tool followed only by a JSON object (with up to eight
non-word separator characters) can request a real tool call in the same session.
It never executes arguments from text. Printed-call retries default to one per user
turn; `agentbridge.vibe.printed_call_retries=0` disables them, and values above one
are capped at one. All nudges still share the existing two-per-turn overall bound:
a printed-call retry consumes one slot, and two earlier nudges prevent that retry.
Bare-name and announcement nudges have no additional category limit. Stop,
cancellation, errors and refused writes do not restart a turn.
The existing `turn/nudge` and progress events record tool/count/limit/length, without
copying printed arguments to the retry log. Run `node --test tests/printed_json_call.test.js
tests/vibe_turn_nudge.test.js` and the full Bridge suite. All transcripts in the new
regression tests are synthetic; no inference is needed.
