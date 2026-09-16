


# lib_ConvertigoAgentBridge

Local runtime bridge between the Tigo Assistant and workspace-managed OpenAI Codex or Mistral Vibe agents. It manages isolated homes, persistent processes, events, runtime installation, and opaque in-memory MCP credential handles.

Requires Convertigo Studio 8.4.4 or newer when used by the Tigo local Agent stack.


For more technical informations : [documentation](./project.md)

- [Installation](#installation)
- [Sequences](#sequences)
    - [agent_claude_close](#agent_claude_close)
    - [agent_claude_prompt](#agent_claude_prompt)
    - [agent_claude_setup](#agent_claude_setup)
    - [agent_claude_start](#agent_claude_start)
    - [agent_cleanup_storage](#agent_cleanup_storage)
    - [agent_codex_close](#agent_codex_close)
    - [agent_codex_prompt](#agent_codex_prompt)
    - [agent_codex_setup](#agent_codex_setup)
    - [agent_codex_start](#agent_codex_start)
    - [agent_events](#agent_events)
    - [agent_python_setup](#agent_python_setup)
    - [agent_settings](#agent_settings)
    - [agent_status](#agent_status)
    - [agent_sweep_expired](#agent_sweep_expired)
    - [agent_vibe_close](#agent_vibe_close)
    - [agent_vibe_prompt](#agent_vibe_prompt)
    - [agent_vibe_setup](#agent_vibe_setup)
    - [agent_vibe_start](#agent_vibe_start)


## Installation

1. In your Convertigo Studio click on ![](https://github.com/convertigo/convertigo/blob/develop/eclipse-plugin-studio/icons/studio/project_import.gif?raw=true "Import a project in treeview") to import a project in the treeview
2. In the import wizard

   ![](https://github.com/convertigo/convertigo/blob/develop/eclipse-plugin-studio/tomcat/webapps/convertigo/templates/ftl/project_import_wzd.png?raw=true "Import Project")
   
   paste the text below into the `Project remote URL` field:
   <table>
     <tr><td>Usage</td><td>Click the copy button at the end of the line</td></tr>
     <tr><td>To contribute</td><td>

     ```
     lib_ConvertigoAgentBridge=git@github.com:convertigo/c8oprj-convertigo-agent-bridge.git:branch=main
     ```
     </td></tr>
     <tr><td>To simply use</td><td>

     ```
     lib_ConvertigoAgentBridge=git@github.com:convertigo/c8oprj-convertigo-agent-bridge/archive/main.zip
     ```
     </td></tr>
    </table>
3. Click the `Finish` button. This will automatically import the __lib_ConvertigoAgentBridge__ project


## Sequences

### agent_claude_close

Close a Claude Code bridge entry and stop its running process if needed.

**variables**

<table>
<tr>
<th>name</th><th>comment</th>
</tr>
<tr>
<td>handle</td><td>Process handle returned by agent_claude_start.</td>
</tr>
</table>

### agent_claude_prompt

Send a prompt to the resident Claude Code process without blocking.

**variables**

<table>
<tr>
<th>name</th><th>comment</th>
</tr>
<tr>
<td>agentProfile</td><td>Agent profile.</td>
</tr>
<tr>
<td>agentRevealMode</td><td>When true, Convertigo reveal mode instructions are prepended to the prompt.</td>
</tr>
<tr>
<td>claudeSessionId</td><td>Alias of sessionId.</td>
</tr>
<tr>
<td>conversationId</td><td>Conversation identifier.</td>
</tr>
<tr>
<td>externalSessionId</td><td>Alias of sessionId.</td>
</tr>
<tr>
<td>handle</td><td>Process handle returned by agent_claude_start.</td>
</tr>
<tr>
<td>mcpBearerTokenHandle</td><td>Opaque server-side handle of the managed MCP bearer token.</td>
</tr>
<tr>
<td>mcpEndpoint</td><td>Optional MCP endpoint.</td>
</tr>
<tr>
<td>model</td><td>Optional Claude model alias; a change restarts the resident process with resume.</td>
</tr>
<tr>
<td>nocodeMcpTokenHandle</td><td>Opaque server-side handle of the NoCode MCP token.</td>
</tr>
<tr>
<td>noCodeMcpTokenHandle</td><td>Alias of nocodeMcpTokenHandle.</td>
</tr>
<tr>
<td>projectId</td><td>Optional project identifier.</td>
</tr>
<tr>
<td>prompt</td><td>User prompt sent to Claude Code.</td>
</tr>
<tr>
<td>reasoningEffort</td><td>Optional Claude effort level; a change restarts the resident process with resume.</td>
</tr>
<tr>
<td>sessionId</td><td>Optional Claude Code session id.</td>
</tr>
<tr>
<td>skillProfile</td><td>Skill profile.</td>
</tr>
<tr>
<td>userId</td><td>User identifier.</td>
</tr>
<tr>
<td>workspaceRoot</td><td>Optional Convertigo user workspace root.</td>
</tr>
</table>

### agent_claude_setup

Check or install the local Claude Code runtime used by the agent bridge.

**variables**

<table>
<tr>
<th>name</th><th>comment</th>
</tr>
<tr>
<td>agentProfile</td><td>Agent profile used to select the managed skill pack, for example nocode or generalist.</td>
</tr>
<tr>
<td>agentRevealMode</td><td>When true, the managed MCP configuration declares the Convertigo reveal mode header.</td>
</tr>
<tr>
<td>allowNodeDownload</td><td>When false, setup fails instead of downloading Node.js through Convertigo ProcessUtils.</td>
</tr>
<tr>
<td>assistantContext</td><td>Assistant context supplied by the embedding surface, for example nocode.</td>
</tr>
<tr>
<td>assistantSurface</td><td>Assistant surface supplied by the embedding surface, for example nocode or studio.</td>
</tr>
<tr>
<td>claudeHome</td><td>Optional explicit CLAUDE_CONFIG_DIR. When empty, the bridge resolves it from claudeHomeScope.</td>
</tr>
<tr>
<td>claudeHomeScope</td><td>CLAUDE_CONFIG_DIR isolation scope: default, shared, user, or conversation. Defaults to visible user-scoped workspace home.</td>
</tr>
<tr>
<td>claudeInstallMethod</td><td>Claude install method. Only npm is currently supported.</td>
</tr>
<tr>
<td>claudeInstallTimeoutMs</td><td>Timeout in milliseconds for npm install. Defaults to 600000.</td>
</tr>
<tr>
<td>claudeLogin</td><td>Alias of login.</td>
</tr>
<tr>
<td>claudeLoginStatus</td><td>Alias of loginStatus.</td>
</tr>
<tr>
<td>claudePackage</td><td>Optional npm package name for Claude Code. Defaults to @anthropic-ai/claude-code.</td>
</tr>
<tr>
<td>claudePath</td><td>Optional Claude Code CLI executable path.</td>
</tr>
<tr>
<td>claudeVersion</td><td>Optional npm package version for Claude Code. Defaults to latest.</td>
</tr>
<tr>
<td>conversationId</td><td>Conversation identifier used for conversation scoped homes.</td>
</tr>
<tr>
<td>forceClaudeInstall</td><td>When true, reinstall Claude Code even when an executable is already found.</td>
</tr>
<tr>
<td>forceLogin</td><td>When true, starts a new browser sign-in even when usable credentials already exist.</td>
</tr>
<tr>
<td>install</td><td>When true, installs the Claude Code CLI if it is missing.</td>
</tr>
<tr>
<td>installDir</td><td>Optional installation directory. Defaults to <workspaceRoot>/agents/claude.</td>
</tr>
<tr>
<td>login</td><td>When true, starts the Claude browser sign-in (`claude auth login`) in the user scoped CLAUDE_CONFIG_DIR and returns the URL to open.</td>
</tr>
<tr>
<td>loginStatus</td><td>When true, reports the state of the pending Claude browser sign-in without starting a new one.</td>
</tr>
<tr>
<td>mcpBearerToken</td><td>Optional direct MCP bearer token. Prefer mcpBearerTokenHandle when available.</td>
</tr>
<tr>
<td>mcpBearerTokenHandle</td><td>Opaque server-side handle of the managed MCP bearer token.</td>
</tr>
<tr>
<td>mcpEndpoint</td><td>Optional MCP endpoint. Defaults to /api/mcp on the current Convertigo endpoint.</td>
</tr>
<tr>
<td>mcpSkillsSourceDir</td><td>Optional lib_ConvertigoMCP project directory used to synchronize base agent skills.</td>
</tr>
<tr>
<td>nocodeMcpToken</td><td>Optional direct NoCode MCP token. Prefer nocodeMcpTokenHandle when available.</td>
</tr>
<tr>
<td>noCodeMcpToken</td><td>Alias of nocodeMcpToken.</td>
</tr>
<tr>
<td>nocodeMcpTokenHandle</td><td>Opaque server-side handle of the NoCode MCP token.</td>
</tr>
<tr>
<td>noCodeMcpTokenHandle</td><td>Alias of nocodeMcpTokenHandle.</td>
</tr>
<tr>
<td>nodeDir</td><td>Optional Node.js installation directory override.</td>
</tr>
<tr>
<td>nodeVersion</td><td>Optional Node.js version used by the Convertigo workspace Node installer.</td>
</tr>
<tr>
<td>npmPath</td><td>Optional npm executable path override.</td>
</tr>
<tr>
<td>projectId</td><td>Optional project identifier included in scoped homes.</td>
</tr>
<tr>
<td>skillProfile</td><td>Skill profile used to select the managed skill pack, for example nocode or generalist.</td>
</tr>
<tr>
<td>skipSkillsInstall</td><td>When true, skips synchronization of the lib_ConvertigoMCP skill pack into the agent home.</td>
</tr>
<tr>
<td>userId</td><td>User identifier used for user or conversation scoped homes.</td>
</tr>
<tr>
<td>viewerDebugPort</td><td>Optional Studio viewer debug port declared as an MCP header.</td>
</tr>
<tr>
<td>workspaceRoot</td><td>Optional Convertigo user workspace root. Defaults to Engine.USER_WORKSPACE_PATH.</td>
</tr>
</table>

### agent_claude_start

Start or reuse a resident Claude Code stream-json process for a conversation.

**variables**

<table>
<tr>
<th>name</th><th>comment</th>
</tr>
<tr>
<td>agentProfile</td><td>Agent profile used to select the managed skill pack.</td>
</tr>
<tr>
<td>agentRevealMode</td><td>When true, Convertigo reveal mode is enabled for this process.</td>
</tr>
<tr>
<td>allowNodeDownload</td><td>When false, setup fails instead of downloading Node.js.</td>
</tr>
<tr>
<td>assistantContext</td><td>Assistant context supplied by the embedding surface.</td>
</tr>
<tr>
<td>assistantSurface</td><td>Assistant surface supplied by the embedding surface.</td>
</tr>
<tr>
<td>claudeHome</td><td>Optional explicit CLAUDE_CONFIG_DIR. When empty, the bridge resolves it from claudeHomeScope.</td>
</tr>
<tr>
<td>claudeHomeScope</td><td>CLAUDE_CONFIG_DIR isolation scope: default, shared, user, or conversation. Defaults to visible user-scoped workspace home.</td>
</tr>
<tr>
<td>claudeInstallMethod</td><td>Claude install method. Only npm is currently supported.</td>
</tr>
<tr>
<td>claudeInstallTimeoutMs</td><td>Timeout in milliseconds for npm install.</td>
</tr>
<tr>
<td>claudePackage</td><td>Optional npm package name for Claude Code.</td>
</tr>
<tr>
<td>claudePath</td><td>Optional Claude Code CLI executable path.</td>
</tr>
<tr>
<td>claudeSessionId</td><td>Alias of sessionId.</td>
</tr>
<tr>
<td>claudeVersion</td><td>Optional npm package version for Claude Code.</td>
</tr>
<tr>
<td>conversationId</td><td>Conversation identifier used for conversation scoped homes.</td>
</tr>
<tr>
<td>cwd</td><td>Workspace directory the agent should work in. Defaults to the Convertigo workspace root.</td>
</tr>
<tr>
<td>env</td><td>Optional JSON object of extra environment variables for the Claude process.</td>
</tr>
<tr>
<td>externalSessionId</td><td>Alias of sessionId used by the Assistant durable conversation record.</td>
</tr>
<tr>
<td>forceClaudeInstall</td><td>When true, reinstall Claude Code even when found.</td>
</tr>
<tr>
<td>handle</td><td>Optional stable process handle. Generated when empty and remembered in the HTTP session.</td>
</tr>
<tr>
<td>install</td><td>When true, installs the Claude Code CLI if it is missing.</td>
</tr>
<tr>
<td>installDir</td><td>Optional installation directory. Defaults to <workspaceRoot>/agents/claude.</td>
</tr>
<tr>
<td>mcpBearerToken</td><td>Optional direct MCP bearer token. Prefer mcpBearerTokenHandle.</td>
</tr>
<tr>
<td>mcpBearerTokenHandle</td><td>Opaque server-side handle of the managed MCP bearer token.</td>
</tr>
<tr>
<td>mcpEndpoint</td><td>Optional MCP endpoint. Defaults to /api/mcp on the current Convertigo endpoint.</td>
</tr>
<tr>
<td>mcpSkillsSourceDir</td><td>Optional lib_ConvertigoMCP project directory used to synchronize base agent skills.</td>
</tr>
<tr>
<td>model</td><td>Optional Claude model alias or id, for example opus, sonnet, or haiku.</td>
</tr>
<tr>
<td>nocodeMcpToken</td><td>Optional direct NoCode MCP token.</td>
</tr>
<tr>
<td>noCodeMcpToken</td><td>Alias of nocodeMcpToken.</td>
</tr>
<tr>
<td>nocodeMcpTokenHandle</td><td>Opaque server-side handle of the NoCode MCP token.</td>
</tr>
<tr>
<td>noCodeMcpTokenHandle</td><td>Alias of nocodeMcpTokenHandle.</td>
</tr>
<tr>
<td>nodeDir</td><td>Optional Node.js installation directory override.</td>
</tr>
<tr>
<td>nodeVersion</td><td>Optional Node.js version override.</td>
</tr>
<tr>
<td>npmPath</td><td>Optional npm executable path override.</td>
</tr>
<tr>
<td>projectId</td><td>Optional project identifier included in scoped homes.</td>
</tr>
<tr>
<td>reasoningEffort</td><td>Optional Claude effort level: low, medium, high, xhigh, or max.</td>
</tr>
<tr>
<td>sessionId</td><td>Optional Claude Code session id to resume.</td>
</tr>
<tr>
<td>skillProfile</td><td>Skill profile used to select the managed skill pack.</td>
</tr>
<tr>
<td>skipSkillsInstall</td><td>When true, skips skill synchronization.</td>
</tr>
<tr>
<td>ttlSeconds</td><td>Idle time-to-live of the resident process in seconds. Defaults to 3600.</td>
</tr>
<tr>
<td>userId</td><td>User identifier used for user or conversation scoped homes.</td>
</tr>
<tr>
<td>viewerDebugPort</td><td>Optional Studio viewer debug port declared as an MCP header.</td>
</tr>
<tr>
<td>workspaceRoot</td><td>Optional Convertigo user workspace root. Defaults to Engine.USER_WORKSPACE_PATH.</td>
</tr>
</table>

### agent_cleanup_storage

Remove conversation-scoped agent artifacts and periodically purge unreferenced storage.

**variables**

<table>
<tr>
<th>name</th><th>comment</th>
</tr>
<tr>
<td>conversationId</td><td>Conversation whose artifacts must be deleted immediately.</td>
</tr>
<tr>
<td>externalSessionId</td><td>Codex thread id used to locate a non-deterministic legacy home.</td>
</tr>
<tr>
<td>force</td><td>Bypass the six-hour periodic cleanup interval.</td>
</tr>
<tr>
<td>handle</td><td>Managed process handle associated with the conversation.</td>
</tr>
<tr>
<td>intervalSeconds</td><td>Periodic cleanup interval. Defaults to 21600 seconds.</td>
</tr>
<tr>
<td>orphanGraceSeconds</td><td>Minimum age before deleting an unreferenced artifact. Defaults to 86400 seconds.</td>
</tr>
<tr>
<td>threadid</td><td>Alias for conversationId.</td>
</tr>
<tr>
<td>userId</td><td>Raw user identifier for conversation-scoped homes.</td>
</tr>
<tr>
<td>userKey</td><td>Already-normalized Assistant user storage key.</td>
</tr>
<tr>
<td>workspaceRoot</td><td>Convertigo workspace root. Defaults to the engine user workspace.</td>
</tr>
</table>

### agent_codex_close

Close a Codex bridge entry and stop its running process if needed.

**variables**

<table>
<tr>
<th>name</th><th>comment</th>
</tr>
<tr>
<td>handle</td><td>Process handle returned by agent_codex_start.</td>
</tr>
</table>

### agent_codex_prompt

Send a prompt to Codex CLI through codex exec --json. Poll agent_events for normalized stream events.

**variables**

<table>
<tr>
<th>name</th><th>comment</th>
</tr>
<tr>
<td>agentRevealMode</td><td>Set true to tell the agent to pass reveal=true on supported Convertigo mutation/viewer tools for this turn.</td>
</tr>
<tr>
<td>browserDebugUrl</td><td>Visible Studio viewer remote debugging URL.</td>
</tr>
<tr>
<td>browserDevToolsJsonUrl</td><td>Visible Studio viewer DevTools JSON URL.</td>
</tr>
<tr>
<td>browserDevToolsWebSocketUrl</td><td>Visible Studio viewer DevTools websocket URL.</td>
</tr>
<tr>
<td>bypassApprovalsAndSandbox</td><td>Set false to avoid --dangerously-bypass-approvals-and-sandbox. Defaults to true for unattended Studio runs.</td>
</tr>
<tr>
<td>codexThreadId</td><td>Existing Codex thread id to resume.</td>
</tr>
<tr>
<td>conversationId</td><td>Conversation identifier preserved across managed Codex restarts.</td>
</tr>
<tr>
<td>externalSessionId</td><td>Alias for codexThreadId used by the assistant state.</td>
</tr>
<tr>
<td>handle</td><td>Process handle returned by agent_codex_start.</td>
</tr>
<tr>
<td>model</td><td>Optional Codex model override.</td>
</tr>
<tr>
<td>playwrightCdpEndpoint</td><td>CDP endpoint used by Playwright MCP to attach to the visible viewer.</td>
</tr>
<tr>
<td>playwrightMcpEndpoint</td><td>Optional Playwright MCP endpoint override.</td>
</tr>
<tr>
<td>projectId</td><td>Current Convertigo project identifier.</td>
</tr>
<tr>
<td>prompt</td><td>User prompt text sent to codex exec.</td>
</tr>
<tr>
<td>reasoningEffort</td><td>Optional Codex reasoning effort override: low, medium, high, or xhigh.</td>
</tr>
<tr>
<td>sandbox</td><td>Optional sandbox mode used only when bypassApprovalsAndSandbox is false.</td>
</tr>
<tr>
<td>serviceTier</td><td>Optional Codex service tier override, such as priority.</td>
</tr>
<tr>
<td>sessionId</td><td>Alias for codexThreadId.</td>
</tr>
<tr>
<td>userId</td><td>User identifier used for the conversation-scoped Codex home.</td>
</tr>
<tr>
<td>viewerCdpEndpoint</td><td>Alias for the visible viewer CDP endpoint.</td>
</tr>
<tr>
<td>workspaceRoot</td><td>Convertigo workspace root used by the managed agent runtime.</td>
</tr>
</table>

### agent_codex_setup

Check the local Codex CLI runtime used by the agent bridge.

**variables**

<table>
<tr>
<th>name</th><th>comment</th>
</tr>
<tr>
<td>agentProfile</td><td>Agent profile used to select the managed skill pack, for example flow, nocode or generalist.</td>
</tr>
<tr>
<td>allowNodeDownload</td><td>When false, setup fails instead of downloading Node.js through Convertigo ProcessUtils.</td>
</tr>
<tr>
<td>assistantContext</td><td>Assistant context supplied by the embedding surface, for example nocode.</td>
</tr>
<tr>
<td>assistantSurface</td><td>Assistant surface supplied by the embedding surface, for example nocode or studio.</td>
</tr>
<tr>
<td>browserDebugUrl</td><td>Optional CDP HTTP endpoint for the visible Studio/JxBrowser viewer.</td>
</tr>
<tr>
<td>browserDevToolsJsonUrl</td><td>Optional DevTools /json endpoint for the visible Studio/JxBrowser viewer.</td>
</tr>
<tr>
<td>browserDevToolsWebSocketUrl</td><td>Optional DevTools WebSocket endpoint for the visible Studio/JxBrowser viewer.</td>
</tr>
<tr>
<td>codexHome</td><td>Optional explicit CODEX_HOME directory. When empty, the bridge resolves it from codexHomeScope.</td>
</tr>
<tr>
<td>codexHomeScope</td><td>CODEX_HOME isolation scope: default, shared, user, or conversation. Defaults to visible user-scoped workspace home.</td>
</tr>
<tr>
<td>codexInstallLockTimeoutMs</td><td>Timeout in milliseconds while waiting for the Codex install lock. Defaults to 600000.</td>
</tr>
<tr>
<td>codexInstallMethod</td><td>Codex install method. Only npm is currently supported.</td>
</tr>
<tr>
<td>codexInstallTimeoutMs</td><td>Timeout in milliseconds for npm install. Defaults to 600000.</td>
</tr>
<tr>
<td>codexLogin</td><td>When true, starts browser-based Codex authentication asynchronously.</td>
</tr>
<tr>
<td>codexLoginStatus</td><td>When true, returns the current browser-based Codex authentication status.</td>
</tr>
<tr>
<td>codexPackage</td><td>Optional npm package name for Codex CLI. Defaults to @openai/codex.</td>
</tr>
<tr>
<td>codexPath</td><td>Optional Codex CLI executable path.</td>
</tr>
<tr>
<td>codexVersion</td><td>Optional npm package version for Codex CLI. Defaults to latest.</td>
</tr>
<tr>
<td>conversationId</td><td>Conversation identifier used for conversation scoped homes.</td>
</tr>
<tr>
<td>forceCodexInstall</td><td>When true, reinstall Codex even when an executable is already found.</td>
</tr>
<tr>
<td>forceLogin</td><td>When true, starts a fresh Codex login even when scoped credentials look configured.</td>
</tr>
<tr>
<td>forcePlaywrightInstall</td><td>When true, reinstall Playwright MCP even when it is already found.</td>
</tr>
<tr>
<td>install</td><td>When true, installs the Codex CLI if it is missing.</td>
</tr>
<tr>
<td>installDir</td><td>Optional installation directory. Defaults to <workspaceRoot>/agents/codex.</td>
</tr>
<tr>
<td>mcpBearerToken</td><td>Optional direct MCP bearer token. Prefer mcpBearerTokenHandle when available.</td>
</tr>
<tr>
<td>mcpBearerTokenHandle</td><td>Server-side handle containing the MCP bearer token.</td>
</tr>
<tr>
<td>mcpEndpoint</td><td>Optional MCP endpoint. Defaults to /api/flow-mcp for Flow projects and /api/mcp otherwise.</td>
</tr>
<tr>
<td>mcpSkillsSourceDir</td><td>Optional lib_ConvertigoMCP project directory used to synchronize base agent skills.</td>
</tr>
<tr>
<td>nocodeMcpToken</td><td>Optional direct NoCode MCP bearer token. Prefer nocodeMcpTokenHandle when available.</td>
</tr>
<tr>
<td>noCodeMcpToken</td><td>Optional direct NoCode MCP bearer token alias. Prefer noCodeMcpTokenHandle when available.</td>
</tr>
<tr>
<td>nocodeMcpTokenHandle</td><td>Server-side handle containing the NoCode MCP bearer token.</td>
</tr>
<tr>
<td>noCodeMcpTokenHandle</td><td>Server-side handle containing the NoCode MCP bearer token alias.</td>
</tr>
<tr>
<td>nodeDir</td><td>Optional Node.js installation directory override.</td>
</tr>
<tr>
<td>nodeVersion</td><td>Optional Node.js version used by the Convertigo workspace Node installer.</td>
</tr>
<tr>
<td>npmPath</td><td>Optional npm executable path override.</td>
</tr>
<tr>
<td>playwrightCdpEndpoint</td><td>Optional CDP endpoint passed to the Playwright MCP server.</td>
</tr>
<tr>
<td>playwrightMcpEndpoint</td><td>Optional alias for the Playwright MCP CDP endpoint.</td>
</tr>
<tr>
<td>playwrightMcpPackage</td><td>Optional npm package name for Playwright MCP. Defaults to @playwright/mcp.</td>
</tr>
<tr>
<td>playwrightMcpVersion</td><td>Optional npm package version for Playwright MCP. Defaults to latest.</td>
</tr>
<tr>
<td>playwrightPackage</td><td>Compatibility alias for playwrightMcpPackage. Defaults to @playwright/mcp.</td>
</tr>
<tr>
<td>playwrightVersion</td><td>Compatibility alias for playwrightMcpVersion. Defaults to latest.</td>
</tr>
<tr>
<td>projectId</td><td>Optional project identifier included in scoped homes.</td>
</tr>
<tr>
<td>skillProfile</td><td>Skill profile used to select the managed skill pack, for example flow, nocode or generalist.</td>
</tr>
<tr>
<td>skipPlaywrightInstall</td><td>When true, skip installing Playwright MCP next to Codex.</td>
</tr>
<tr>
<td>skipSkillsInstall</td><td>When true, skips synchronization of the lib_ConvertigoMCP skill pack into the agent home.</td>
</tr>
<tr>
<td>userId</td><td>User identifier used for user or conversation scoped homes.</td>
</tr>
<tr>
<td>viewerCdpEndpoint</td><td>Optional alias for the viewer CDP endpoint passed to Playwright MCP.</td>
</tr>
<tr>
<td>workspaceRoot</td><td>Optional Convertigo user workspace root. Defaults to Engine.USER_WORKSPACE_PATH.</td>
</tr>
</table>

### agent_codex_start

Prepare a Codex CLI conversation entry. The Codex process is launched by agent_codex_prompt.

**variables**

<table>
<tr>
<th>name</th><th>comment</th>
</tr>
<tr>
<td>agentProfile</td><td>Agent profile used to select the managed skill pack, for example flow, nocode or generalist.</td>
</tr>
<tr>
<td>agentRevealMode</td><td>Set true to tell the agent to pass reveal=true on supported Convertigo mutation/viewer tools.</td>
</tr>
<tr>
<td>allowNodeDownload</td><td>When false, setup fails instead of downloading Node.js through Convertigo ProcessUtils.</td>
</tr>
<tr>
<td>assistantContext</td><td>Assistant context supplied by the embedding surface, for example nocode.</td>
</tr>
<tr>
<td>assistantSurface</td><td>Assistant surface supplied by the embedding surface, for example nocode or studio.</td>
</tr>
<tr>
<td>browserDebugUrl</td><td>Optional CDP HTTP endpoint for the visible Studio/JxBrowser viewer.</td>
</tr>
<tr>
<td>browserDevToolsJsonUrl</td><td>Optional DevTools /json endpoint for the visible Studio/JxBrowser viewer.</td>
</tr>
<tr>
<td>browserDevToolsWebSocketUrl</td><td>Optional DevTools WebSocket endpoint for the visible Studio/JxBrowser viewer.</td>
</tr>
<tr>
<td>codexHome</td><td>Optional explicit CODEX_HOME directory. When empty, the bridge resolves it from codexHomeScope.</td>
</tr>
<tr>
<td>codexHomeScope</td><td>CODEX_HOME isolation scope: default, shared, user, or conversation. Defaults to visible user-scoped workspace home.</td>
</tr>
<tr>
<td>codexInstallMethod</td><td>Codex install method. Only npm is currently supported.</td>
</tr>
<tr>
<td>codexInstallTimeoutMs</td><td>Timeout in milliseconds for npm install. Defaults to 600000.</td>
</tr>
<tr>
<td>codexPackage</td><td>Optional npm package name for Codex CLI. Defaults to @openai/codex.</td>
</tr>
<tr>
<td>codexPath</td><td>Optional Codex CLI executable path.</td>
</tr>
<tr>
<td>codexThreadId</td><td>Existing Codex thread id to resume on the next prompt.</td>
</tr>
<tr>
<td>codexVersion</td><td>Optional npm package version for Codex CLI. Defaults to latest.</td>
</tr>
<tr>
<td>conversationId</td><td>Conversation identifier used for conversation scoped homes.</td>
</tr>
<tr>
<td>cwd</td><td>Workspace directory the agent should work in. Defaults to the Convertigo workspace root.</td>
</tr>
<tr>
<td>env</td><td>Optional JSON object of environment variables for codex exec. Values are not echoed back.</td>
</tr>
<tr>
<td>forceCodexInstall</td><td>When true, reinstall Codex even when an executable is already found.</td>
</tr>
<tr>
<td>forcePlaywrightInstall</td><td>When true, reinstall Playwright MCP even when it is already found.</td>
</tr>
<tr>
<td>handle</td><td>Optional stable process handle. Generated when empty and remembered in the HTTP session.</td>
</tr>
<tr>
<td>install</td><td>When true, installs the Codex CLI if it is missing before starting.</td>
</tr>
<tr>
<td>installDir</td><td>Optional installation directory. Defaults to <workspaceRoot>/agents/codex.</td>
</tr>
<tr>
<td>mcpBearerToken</td><td>Optional direct MCP bearer token. Prefer mcpBearerTokenHandle when available.</td>
</tr>
<tr>
<td>mcpBearerTokenHandle</td><td>Server-side handle containing the MCP bearer token.</td>
</tr>
<tr>
<td>mcpEndpoint</td><td>Optional MCP endpoint. Defaults to /api/flow-mcp for Flow projects and /api/mcp otherwise.</td>
</tr>
<tr>
<td>mcpSkillsSourceDir</td><td>Optional lib_ConvertigoMCP project directory used to synchronize base agent skills.</td>
</tr>
<tr>
<td>model</td><td>Optional Codex model override.</td>
</tr>
<tr>
<td>nocodeMcpToken</td><td>Optional direct NoCode MCP bearer token. Prefer nocodeMcpTokenHandle when available.</td>
</tr>
<tr>
<td>noCodeMcpToken</td><td>Optional direct NoCode MCP bearer token alias. Prefer noCodeMcpTokenHandle when available.</td>
</tr>
<tr>
<td>nocodeMcpTokenHandle</td><td>Server-side handle containing the NoCode MCP bearer token.</td>
</tr>
<tr>
<td>noCodeMcpTokenHandle</td><td>Server-side handle containing the NoCode MCP bearer token alias.</td>
</tr>
<tr>
<td>nodeDir</td><td>Optional Node.js installation directory override.</td>
</tr>
<tr>
<td>nodeVersion</td><td>Optional Node.js version used by the Convertigo workspace Node installer.</td>
</tr>
<tr>
<td>npmPath</td><td>Optional npm executable path override.</td>
</tr>
<tr>
<td>playwrightCdpEndpoint</td><td>Optional CDP endpoint passed to the Playwright MCP server.</td>
</tr>
<tr>
<td>playwrightMcpEndpoint</td><td>Optional alias for the Playwright MCP CDP endpoint.</td>
</tr>
<tr>
<td>playwrightMcpPackage</td><td>Optional npm package name for Playwright MCP. Defaults to @playwright/mcp.</td>
</tr>
<tr>
<td>playwrightMcpVersion</td><td>Optional npm package version for Playwright MCP. Defaults to latest.</td>
</tr>
<tr>
<td>playwrightPackage</td><td>Compatibility alias for playwrightMcpPackage. Defaults to @playwright/mcp.</td>
</tr>
<tr>
<td>playwrightVersion</td><td>Compatibility alias for playwrightMcpVersion. Defaults to latest.</td>
</tr>
<tr>
<td>projectId</td><td>Optional project identifier included in scoped homes.</td>
</tr>
<tr>
<td>reasoningEffort</td><td>Optional Codex reasoning effort override: low, medium, high, or xhigh.</td>
</tr>
<tr>
<td>serviceTier</td><td>Optional Codex service tier override, such as priority.</td>
</tr>
<tr>
<td>skillProfile</td><td>Skill profile used to select the managed skill pack, for example flow, nocode or generalist.</td>
</tr>
<tr>
<td>skipPlaywrightInstall</td><td>When true, skip installing Playwright MCP next to Codex.</td>
</tr>
<tr>
<td>skipSkillsInstall</td><td>When true, skips synchronization of the lib_ConvertigoMCP skill pack into the agent home.</td>
</tr>
<tr>
<td>ttlSeconds</td><td>Idle lifetime before sweep can close the entry. Defaults to 3600.</td>
</tr>
<tr>
<td>userId</td><td>User identifier used for user or conversation scoped homes.</td>
</tr>
<tr>
<td>viewerCdpEndpoint</td><td>Optional alias for the viewer CDP endpoint passed to Playwright MCP.</td>
</tr>
<tr>
<td>workspaceRoot</td><td>Optional Convertigo user workspace root. Defaults to Engine.USER_WORKSPACE_PATH.</td>
</tr>
</table>

### agent_events

Long-poll normalized stream events from a running agent process.

**variables**

<table>
<tr>
<th>name</th><th>comment</th>
</tr>
<tr>
<td>cursor</td><td>Cursor returned by the previous agent_events call. Defaults to 0.</td>
</tr>
<tr>
<td>handle</td><td>Process handle returned by agent_vibe_start. Defaults to the handle stored in the HTTP session.</td>
</tr>
<tr>
<td>limit</td><td>Maximum number of events to return. Defaults to 100.</td>
</tr>
<tr>
<td>waitMs</td><td>Long-poll wait when no event is available. Defaults to 25000, capped at 30000.</td>
</tr>
</table>

### agent_python_setup

Check or install a workspace-local Python runtime for agent CLIs.

**variables**

<table>
<tr>
<th>name</th><th>comment</th>
</tr>
<tr>
<td>allowPythonDownload</td><td>Set false to forbid Python downloads and only report missing runtime.</td>
</tr>
<tr>
<td>forcePythonInstall</td><td>Set true to reinstall the workspace-managed standalone Python runtime.</td>
</tr>
<tr>
<td>install</td><td>Set true to install or reuse the workspace-managed standalone Python runtime.</td>
</tr>
<tr>
<td>pythonArchiveFlavor</td><td>Archive flavor. Defaults to install_only_stripped.</td>
</tr>
<tr>
<td>pythonArchiveSha256</td><td>Optional SHA-256 checksum for the Python archive.</td>
</tr>
<tr>
<td>pythonArchiveUrl</td><td>Optional direct Python standalone archive URL. Useful for enterprise mirrors or offline servers.</td>
</tr>
<tr>
<td>pythonAssetUrlPrefix</td><td>Optional python-build-standalone asset URL prefix. Supports {tag}.</td>
</tr>
<tr>
<td>pythonBuildTag</td><td>python-build-standalone release tag. Defaults to 20260610.</td>
</tr>
<tr>
<td>pythonInstallDir</td><td>Optional standalone Python installation directory. Defaults to <workspaceRoot>/agents/runtimes/python/<runtime>.</td>
</tr>
<tr>
<td>pythonMirrorBaseUrl</td><td>Alias for pythonAssetUrlPrefix when using an enterprise mirror.</td>
</tr>
<tr>
<td>pythonPath</td><td>Optional explicit Python executable path.</td>
</tr>
<tr>
<td>pythonPlatform</td><td>Optional python-build-standalone platform tag override.</td>
</tr>
<tr>
<td>pythonVersion</td><td>Python standalone version. Defaults to 3.12.13.</td>
</tr>
<tr>
<td>workspaceRoot</td><td>Optional Convertigo user workspace root. Defaults to Engine.USER_WORKSPACE_PATH.</td>
</tr>
</table>

### agent_settings

Return available AI agent providers, models and reasoning settings discovered from local CLIs.

**variables**

<table>
<tr>
<th>name</th><th>comment</th>
</tr>
<tr>
<td>agentProfile</td><td>Optional agentProfile preference.</td>
</tr>
<tr>
<td>checkUpdates</td><td>Check the package registry for newer CLI versions. Disabled by default.</td>
</tr>
<tr>
<td>codexHome</td><td>Optional explicit CODEX_HOME directory.</td>
</tr>
<tr>
<td>codexHomeScope</td><td>CODEX_HOME isolation scope: default, shared, user, or conversation.</td>
</tr>
<tr>
<td>codexPath</td><td>Optional Codex CLI executable path.</td>
</tr>
<tr>
<td>conversationId</td><td>Conversation identifier used for conversation scoped agent homes.</td>
</tr>
<tr>
<td>mcpEndpoint</td><td>Optional Convertigo MCP endpoint. Defaults to the current Convertigo endpoint plus /api/mcp.</td>
</tr>
<tr>
<td>model</td><td>Optional model preference.</td>
</tr>
<tr>
<td>projectId</td><td>Selected Convertigo project identifier.</td>
</tr>
<tr>
<td>provider</td><td>Optional provider filter: codex or vibe. Empty returns all providers.</td>
</tr>
<tr>
<td>reasoningEffort</td><td>Optional reasoningEffort preference.</td>
</tr>
<tr>
<td>refreshUpdateCheck</td><td>Bypass the cached CLI version check.</td>
</tr>
<tr>
<td>runtimePresenceOnly</td><td>Check only for runtime files without invoking the CLI.</td>
</tr>
<tr>
<td>savePreferences</td><td>Optional savePreferences preference.</td>
</tr>
<tr>
<td>serviceTier</td><td>Optional serviceTier preference.</td>
</tr>
<tr>
<td>settingsTimeoutMs</td><td>Timeout in milliseconds for CLI settings discovery. Defaults to 20000.</td>
</tr>
<tr>
<td>skillProfile</td><td>Optional skillProfile preference.</td>
</tr>
<tr>
<td>updateCheckCacheMs</td><td>Cache duration in milliseconds for package registry checks.</td>
</tr>
<tr>
<td>updateCheckTimeoutMs</td><td>Timeout in milliseconds for the package registry check.</td>
</tr>
<tr>
<td>userId</td><td>User identifier used for user scoped agent homes.</td>
</tr>
<tr>
<td>vibeHome</td><td>Optional explicit VIBE_HOME directory.</td>
</tr>
<tr>
<td>vibeHomeScope</td><td>VIBE_HOME isolation scope: shared, user, or conversation.</td>
</tr>
<tr>
<td>vibeProfile</td><td>Vibe profile filter for the vibe provider: mistral (default) or convertigo. The convertigo pseudo-provider is always listed with provider=all.</td>
</tr>
<tr>
<td>workspaceRoot</td><td>Optional Convertigo user workspace root. Defaults to Engine.USER_WORKSPACE_PATH.</td>
</tr>
</table>

### agent_status

Return the status of one agent process or the current registry.

**variables**

<table>
<tr>
<th>name</th><th>comment</th>
</tr>
<tr>
<td>handle</td><td>Optional process handle. Empty returns all registered handles.</td>
</tr>
</table>

### agent_sweep_expired

Stop abandoned agent processes whose idle time exceeds their TTL.

**variables**

<table>
<tr>
<th>name</th><th>comment</th>
</tr>
<tr>
<td>maxIdleSeconds</td><td>Optional hard idle threshold applied in addition to each process TTL.</td>
</tr>
</table>

### agent_vibe_close

Close a Vibe ACP session and stop its process.

**variables**

<table>
<tr>
<th>name</th><th>comment</th>
</tr>
<tr>
<td>handle</td><td>Process handle returned by agent_vibe_start. Defaults to the handle stored in the HTTP session.</td>
</tr>
</table>

### agent_vibe_prompt

Send a prompt to a running Vibe ACP session. By default the call returns after submit; poll agent_events for streaming chunks.

**variables**

<table>
<tr>
<th>name</th><th>comment</th>
</tr>
<tr>
<td>agentRevealMode</td><td>Set true to tell the agent to pass reveal=true on supported Convertigo mutation/viewer tools for this turn.</td>
</tr>
<tr>
<td>handle</td><td>Process handle returned by agent_vibe_start. Defaults to the handle stored in the HTTP session.</td>
</tr>
<tr>
<td>images</td><td>Optional JSON array of local image paths attached to the prompt. Sent to Vibe as ACP image blocks when the active model supports images.</td>
</tr>
<tr>
<td>messageId</td><td>Optional UUID message id echoed by the agent when supported.</td>
</tr>
<tr>
<td>prompt</td><td>User prompt text sent as ACP text content.</td>
</tr>
<tr>
<td>requestTimeoutMs</td><td>Timeout used only when waitForCompletion is true. Defaults to 600000.</td>
</tr>
<tr>
<td>waitForCompletion</td><td>Set true for a blocking prompt call. Default false keeps HTTP responsive and streams through agent_events.</td>
</tr>
</table>

### agent_vibe_setup

Check or install the local Vibe CLI runtime used by the agent bridge.

**variables**

<table>
<tr>
<th>name</th><th>comment</th>
</tr>
<tr>
<td>agentProfile</td><td>Agent capability profile used to select the managed MCP authorization scope.</td>
</tr>
<tr>
<td>allowPythonDownload</td><td>Set false to forbid Python downloads and only report missing runtime.</td>
</tr>
<tr>
<td>assistantContext</td><td>Assistant surface context used to select the MCP authorization scope.</td>
</tr>
<tr>
<td>configure</td><td>Set true to write the local VIBE_HOME config.toml with the Convertigo MCP HTTP endpoint.</td>
</tr>
<tr>
<td>conversationId</td><td>Conversation identifier used for conversation scoped homes. Generated in the HTTP session when empty.</td>
</tr>
<tr>
<td>forceLogin</td><td>When true, starts a new browser sign-in even when an API key already exists.</td>
</tr>
<tr>
<td>forcePythonInstall</td><td>Set true to reinstall the workspace-managed standalone Python runtime before Vibe setup.</td>
</tr>
<tr>
<td>forceVibeInstall</td><td>Set true to install or update the workspace-local Vibe venv even when Vibe is already found in PATH.</td>
</tr>
<tr>
<td>gatewayApiKey</td><td>Convertigo profile only: stores the user's LiteLLM virtual key in the user scoped VIBE_HOME .env (never returned).</td>
</tr>
<tr>
<td>install</td><td>Set true to install or reuse managed Python and install Vibe in the workspace-local venv.</td>
</tr>
<tr>
<td>installDir</td><td>Optional installation directory. Defaults to <workspaceRoot>/agents/vibe.</td>
</tr>
<tr>
<td>llmGatewayModel</td><td>Convertigo profile only: gateway model name. Defaults to mistral/zai-glm-5-2.</td>
</tr>
<tr>
<td>llmGatewayThinking</td><td>Convertigo profile only: thinking level (off, low, medium, high). Defaults to medium; the gateway passes reasoning_effort to GLM 5.2.</td>
</tr>
<tr>
<td>llmGatewayUrl</td><td>Convertigo profile only: LiteLLM gateway base URL. Defaults to https://llm.convertigo.com/v1.</td>
</tr>
<tr>
<td>login</td><td>When true, starts the Mistral AI Studio browser sign-in for the user scoped VIBE_HOME and returns the URL to open.</td>
</tr>
<tr>
<td>loginStatus</td><td>When true, reports the state of the pending Vibe browser sign-in without starting a new one.</td>
</tr>
<tr>
<td>mcpBearerTokenHandle</td><td>Opaque server-memory handle for the managed Convertigo MCP bearer token.</td>
</tr>
<tr>
<td>mcpEndpoint</td><td>Optional Convertigo MCP endpoint. Defaults to the current Convertigo endpoint plus /api/mcp.</td>
</tr>
<tr>
<td>mcpSkillsSourceDir</td><td>Optional lib_ConvertigoMCP project directory used to synchronize base agent skills.</td>
</tr>
<tr>
<td>model</td><td>Optional Vibe model alias. Defaults to vibe-thinking.</td>
</tr>
<tr>
<td>nocodeMcpTokenHandle</td><td>Opaque server-memory handle for the C8Oforms NoCode MCP bearer token.</td>
</tr>
<tr>
<td>projectId</td><td>Optional project identifier included in user or conversation scoped homes.</td>
</tr>
<tr>
<td>pythonArchiveFlavor</td><td>Archive flavor. Defaults to install_only_stripped.</td>
</tr>
<tr>
<td>pythonArchiveSha256</td><td>Optional SHA-256 checksum for the Python archive.</td>
</tr>
<tr>
<td>pythonArchiveUrl</td><td>Optional direct Python standalone archive URL. Useful for enterprise mirrors or offline servers.</td>
</tr>
<tr>
<td>pythonAssetUrlPrefix</td><td>Optional python-build-standalone asset URL prefix. Supports {tag}.</td>
</tr>
<tr>
<td>pythonBuildTag</td><td>python-build-standalone release tag. Defaults to 20260610.</td>
</tr>
<tr>
<td>pythonInstallDir</td><td>Optional standalone Python installation directory. Defaults to <workspaceRoot>/agents/runtimes/python/<runtime>.</td>
</tr>
<tr>
<td>pythonMirrorBaseUrl</td><td>Alias for pythonAssetUrlPrefix when using an enterprise mirror.</td>
</tr>
<tr>
<td>pythonPath</td><td>Optional explicit Python executable path.</td>
</tr>
<tr>
<td>pythonPlatform</td><td>Optional python-build-standalone platform tag override.</td>
</tr>
<tr>
<td>pythonVersion</td><td>Python standalone version. Defaults to 3.12.13.</td>
</tr>
<tr>
<td>skillProfile</td><td>Managed skill profile used to select the MCP authorization scope.</td>
</tr>
<tr>
<td>skipSkillsInstall</td><td>When true, skips synchronization of the lib_ConvertigoMCP skill pack into the agent home.</td>
</tr>
<tr>
<td>userId</td><td>User identifier used for user or conversation scoped homes. The value is hashed in filesystem paths.</td>
</tr>
<tr>
<td>vibeHome</td><td>Optional explicit VIBE_HOME directory. Overrides vibeHomeScope.</td>
</tr>
<tr>
<td>vibeHomeScope</td><td>VIBE_HOME isolation scope: shared, user, or conversation. Defaults to shared.</td>
</tr>
<tr>
<td>vibeLogin</td><td>Alias of login.</td>
</tr>
<tr>
<td>vibeLoginStatus</td><td>Alias of loginStatus.</td>
</tr>
<tr>
<td>vibeProfile</td><td>Vibe profile: mistral (personal Mistral account, default) or convertigo (Convertigo LiteLLM gateway with a per-user virtual key).</td>
</tr>
<tr>
<td>workspaceRoot</td><td>Optional Convertigo user workspace root. Defaults to Engine.USER_WORKSPACE_PATH.</td>
</tr>
</table>

### agent_vibe_start

Start a long-running vibe-acp process and create an ACP session.

**variables**

<table>
<tr>
<th>name</th><th>comment</th>
</tr>
<tr>
<td>agentProfile</td><td>Agent capability profile used to select the managed MCP authorization scope.</td>
</tr>
<tr>
<td>agentRevealMode</td><td>Set true to tell the agent to pass reveal=true on supported Convertigo mutation/viewer tools.</td>
</tr>
<tr>
<td>allowPythonDownload</td><td>Set false to forbid Python downloads and only report missing runtime.</td>
</tr>
<tr>
<td>assistantContext</td><td>Assistant surface context used to select the MCP authorization scope.</td>
</tr>
<tr>
<td>autoConfigure</td><td>Set false to avoid writing config.toml before start. Defaults to true when vibeHome is not explicit.</td>
</tr>
<tr>
<td>conversationId</td><td>Conversation identifier used for conversation scoped homes. Generated in the HTTP session when empty.</td>
</tr>
<tr>
<td>credentialsPolicy</td><td>Credential injection policy: explicit, user-home, vibe-home, or auto. Defaults to vibe-home for managed profiles.</td>
</tr>
<tr>
<td>cwd</td><td>Workspace directory the agent should work in. Defaults to the Convertigo workspace root.</td>
</tr>
<tr>
<td>env</td><td>Optional JSON object of environment variables for vibe-acp. Values are not echoed back.</td>
</tr>
<tr>
<td>forcePythonInstall</td><td>Set true to reinstall the workspace-managed standalone Python runtime before Vibe start.</td>
</tr>
<tr>
<td>handle</td><td>Optional stable process handle. Generated when empty and remembered in the HTTP session.</td>
</tr>
<tr>
<td>install</td><td>Set true to install missing Vibe/Python runtime before start. Default false.</td>
</tr>
<tr>
<td>installDir</td><td>Optional installation directory. Defaults to <workspaceRoot>/agents/vibe.</td>
</tr>
<tr>
<td>llmGatewayModel</td><td>Convertigo profile only: gateway model name.</td>
</tr>
<tr>
<td>llmGatewayThinking</td><td>Convertigo profile only: thinking level (off, low, medium, high).</td>
</tr>
<tr>
<td>llmGatewayUrl</td><td>Convertigo profile only: LiteLLM gateway base URL.</td>
</tr>
<tr>
<td>mcpBearerTokenHandle</td><td>Opaque server-memory handle for the managed Convertigo MCP bearer token.</td>
</tr>
<tr>
<td>mcpEndpoint</td><td>Convertigo MCP endpoint passed to ACP session/new.</td>
</tr>
<tr>
<td>model</td><td>Optional Vibe model alias. Defaults to vibe-thinking.</td>
</tr>
<tr>
<td>nocodeMcpTokenHandle</td><td>Opaque server-memory handle for the C8Oforms NoCode MCP bearer token.</td>
</tr>
<tr>
<td>projectId</td><td>Optional project identifier included in user or conversation scoped homes.</td>
</tr>
<tr>
<td>pythonArchiveFlavor</td><td>Archive flavor. Defaults to install_only_stripped.</td>
</tr>
<tr>
<td>pythonArchiveSha256</td><td>Optional SHA-256 checksum for the Python archive.</td>
</tr>
<tr>
<td>pythonArchiveUrl</td><td>Optional direct Python standalone archive URL. Useful for enterprise mirrors or offline servers.</td>
</tr>
<tr>
<td>pythonAssetUrlPrefix</td><td>Optional python-build-standalone asset URL prefix. Supports {tag}.</td>
</tr>
<tr>
<td>pythonBuildTag</td><td>python-build-standalone release tag. Defaults to 20260610.</td>
</tr>
<tr>
<td>pythonInstallDir</td><td>Optional standalone Python installation directory. Defaults to <workspaceRoot>/agents/runtimes/python/<runtime>.</td>
</tr>
<tr>
<td>pythonMirrorBaseUrl</td><td>Alias for pythonAssetUrlPrefix when using an enterprise mirror.</td>
</tr>
<tr>
<td>pythonPath</td><td>Optional explicit Python executable path.</td>
</tr>
<tr>
<td>pythonPlatform</td><td>Optional python-build-standalone platform tag override.</td>
</tr>
<tr>
<td>pythonVersion</td><td>Python standalone version. Defaults to 3.12.13.</td>
</tr>
<tr>
<td>reasoningEffort</td><td>Optional Vibe thinking level selected through ACP.</td>
</tr>
<tr>
<td>requestTimeoutMs</td><td>ACP initialize/session timeout. Defaults to 60000.</td>
</tr>
<tr>
<td>skillProfile</td><td>Managed skill profile used to select the MCP authorization scope.</td>
</tr>
<tr>
<td>ttlSeconds</td><td>Idle lifetime before sweep can close the process. Defaults to 3600.</td>
</tr>
<tr>
<td>userId</td><td>User identifier used for user or conversation scoped homes. The value is hashed in filesystem paths.</td>
</tr>
<tr>
<td>vibeHome</td><td>Optional explicit VIBE_HOME. Overrides vibeHomeScope.</td>
</tr>
<tr>
<td>vibeHomeScope</td><td>VIBE_HOME isolation scope: shared, user, or conversation. Defaults to shared.</td>
</tr>
<tr>
<td>vibeProfile</td><td>Vibe profile: mistral (default) or convertigo (Convertigo LiteLLM gateway).</td>
</tr>
<tr>
<td>workspaceRoot</td><td>Optional Convertigo user workspace root. Defaults to Engine.USER_WORKSPACE_PATH.</td>
</tr>
</table>



