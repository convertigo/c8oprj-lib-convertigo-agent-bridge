const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const javaProxy = new Proxy(function () {}, {
  get(_target, property) {
    if (property === Symbol.toPrimitive) {
      return () => "";
    }
    if (property === "isFile" || property === "isDirectory" || property === "exists") {
      return () => false;
    }
    return javaProxy;
  },
  apply() {
    return javaProxy;
  },
  construct() {
    return javaProxy;
  }
});

global.Packages = javaProxy;
global.context = javaProxy;
global.request = javaProxy;
global.log = javaProxy;
global.C8O = { agentBridge: {} };

const commonSource = fs.readFileSync("js/agent_bridge_common.js", "utf8");
const codexSource = fs.readFileSync("js/agent_bridge_codex.js", "utf8");
const vibeSource = fs.readFileSync("js/agent_bridge_vibe.js", "utf8");
const claudeSource = fs.readFileSync("js/agent_bridge_claude.js", "utf8");
const loaderSource = fs.readFileSync("js/vibe_agent_bridge.js", "utf8");
assert.match(loaderSource, /include\("js\/agent_bridge_claude\.js"\)/);
vm.runInThisContext(commonSource, { filename: "agent_bridge_common.js" });
vm.runInThisContext(codexSource, { filename: "agent_bridge_codex.js" });
vm.runInThisContext(vibeSource, { filename: "agent_bridge_vibe.js" });
vm.runInThisContext(claudeSource, { filename: "agent_bridge_claude.js" });

// Provider normalization and labels.
assert.equal(normalizeProvider("claude"), "claude");
assert.equal(normalizeProvider("claude-code"), "claude");
assert.equal(normalizeProvider("anthropic-claude"), "claude");
assert.equal(providerLabel("claude"), "Claude");
assert.equal(agentProxyTargetUrl("claude", {}), "https://api.anthropic.com");
assert.ok(AGENT_CAPABILITY_PROFILES.generalist.supportedProviders.indexOf("claude") >= 0);
assert.ok(AGENT_CAPABILITY_PROFILES.nocode.supportedProviders.indexOf("claude") >= 0);
assert.ok(AGENT_CAPABILITY_PROFILES.flow.supportedProviders.indexOf("claude") < 0, "Flow stays Codex-only");

// Managed skill bundle never expects Flow skills for Claude, even when Flow is available.
flowCapabilityAvailability = () => ({ available: true });
assert.deepEqual(managedSkillBundleSlugs({}, "claude"), ["convertigo-studio", "convertigo-generalist"]);
assert.ok(managedSkillBundleSlugs({}, "codex").indexOf("convertigo-flow-mcp") >= 0);
assert.doesNotMatch(buildConvertigoStudioRouterSkill(true), /convertigo-flow/);
assert.match(buildConvertigoStudioRouterSkill(true), /agent home/);

// Effort and command line.
assert.equal(normalizeClaudeEffort("very-high"), "xhigh");
assert.equal(normalizeClaudeEffort("max"), "max");
assert.equal(normalizeClaudeEffort("weird"), "");
const command = claudeCommand({
  claudePath: "/managed/claude",
  mcpConfigFile: "/home/convertigo-mcp.json",
  model: "opus",
  reasoningEffort: "high",
  sessionId: "sess-1",
  workspaceRoot: "/ws",
  cwd: "/ws"
}, {});
assert.equal(command[0], "/managed/claude");
assert.ok(command.indexOf("--input-format") >= 0 && command.indexOf("stream-json") >= 0);
assert.ok(command.indexOf("--include-partial-messages") >= 0);
assert.equal(command[command.indexOf("--mcp-config") + 1], "/home/convertigo-mcp.json");
assert.ok(command.indexOf("--strict-mcp-config") >= 0);
assert.equal(command[command.indexOf("--model") + 1], "opus");
assert.equal(command[command.indexOf("--effort") + 1], "high");
assert.equal(command[command.indexOf("--resume") + 1], "sess-1");
assert.equal(command.indexOf("--add-dir"), -1);

// MCP config keeps the bearer token out of the file.
const mcpConfig = buildClaudeMcpConfig("http://localhost:18082/convertigo/api/mcp", { agentRevealMode: "true" }, "");
assert.equal(mcpConfig.mcpServers.convertigo.type, "http");
assert.equal(mcpConfig.mcpServers.convertigo.headers.Authorization, "Bearer ${CONVERTIGO_MCP_TOKEN}");
assert.equal(mcpConfig.mcpServers.convertigo.headers["X-Convertigo-Reveal-Mode"], "true");
assert.match(mcpConfig.mcpServers.convertigo.url, /jsonOnly=true/);
assert.doesNotMatch(JSON.stringify(mcpConfig), /eyJ/);

// Tool titles.
assert.equal(claudeToolTitle("mcp__convertigo__project-list"), "convertigo.project-list");
assert.equal(claudeToolTitle("Read"), "Read");

// Model catalog exposes effort levels through the shared provider contract.
const catalog = claudeModelCatalog();
assert.equal(catalog[0].id, "fable");
assert.ok(catalog.some((model) => model.id === "opus"), "the Opus alias must stay available");
assert.deepEqual(catalog[0].reasoningLevels.map((level) => level.id), ["low", "medium", "high", "xhigh", "max"]);

// Stream-json mapping on a fake entry.
function fakeEntry() {
  const events = [];
  return {
    handle: "claude-test",
    provider: "claude",
    protocol: "claude-stream-json",
    status: "running",
    phase: "turn",
    sessionId: "",
    nextIndex: 0,
    firstIndex: 0,
    lastAccess: 0,
    lastError: "",
    process: null,
    writer: { write() {}, newLine() {}, flush() {} },
    events: {
      add(event) { events.push(event); },
      size() { return events.length; },
      remove() { events.shift(); }
    },
    _events: events
  };
}

const entry = fakeEntry();
const lines = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "df8d", model: "claude-sonnet-5", mcp_servers: [{ name: "convertigo", status: "connected" }], tools: ["mcp__convertigo__project-list"] }),
  JSON.stringify({ type: "stream_event", event: { type: "message_start", message: { id: "msg1" } } }),
  JSON.stringify({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } }),
  JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Je consulte la liste des projets.\n" } } }),
  JSON.stringify({ type: "stream_event", event: { type: "content_block_stop", index: 0 } }),
  JSON.stringify({ type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "mcp__convertigo__project-list", input: {} } } }),
  JSON.stringify({ type: "stream_event", event: { type: "content_block_stop", index: 1 } }),
  JSON.stringify({ type: "assistant", message: { id: "msg1", content: [{ type: "text", text: "Je consulte la liste des projets.\n" }, { type: "tool_use", id: "toolu_1", name: "mcp__convertigo__project-list", input: {} }] } }),
  JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "{\"projects\":[]}" }] }] } }),
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Aucun projet.", session_id: "df8d", usage: { output_tokens: 12 } })
];
lines.forEach((line) => handleClaudeStreamLine(entry, line, "stdout"));
const types = entry._events.map((event) => event.type);
assert.equal(entry.sessionId, "df8d");
assert.ok(types.indexOf("session/update") >= 0);
assert.ok(types.indexOf("claude/init") >= 0);
const commentary = entry._events.filter((event) => event.type === "answer/chunk" && event.data.phase === "commentary");
assert.equal(commentary.length, 1, "streamed text must be emitted once, not duplicated by the assistant message");
assert.equal(entry._events.filter((event) => event.type === "tool/start").length, 1);
const toolUpdate = entry._events.find((event) => event.type === "tool/update");
assert.equal(toolUpdate.data.status, "completed");
assert.equal(toolUpdate.data.title, "convertigo.project-list");
const finalAnswer = entry._events.find((event) => event.type === "answer/chunk" && event.data.phase === "final_answer");
assert.equal(finalAnswer.data.text, "Aucun projet.");
assert.equal(types[types.length - 1], "turn/end");
assert.equal(entry.status, "completed");

// Authentication failures surface as turn errors.
const authEntry = fakeEntry();
handleClaudeStreamLine(authEntry, JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" }), "stdout");
const authError = authEntry._events.find((event) => event.type === "turn/error");
assert.ok(authError, "auth failure must emit turn/error");
assert.equal(authError.data.authentication, true);
assert.equal(authEntry.status, "error");

// Permission control requests are auto-allowed.
const permissionEntry = fakeEntry();
let written = null;
permissionEntry.writer = { write(text) { written = JSON.parse(text); }, newLine() {}, flush() {} };
handleClaudeStreamLine(permissionEntry, JSON.stringify({ type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" } } }), "stdout");
assert.equal(written.type, "control_response");
assert.equal(written.response.response.behavior, "allow");

// Non-JSON stdout stays diagnostic, stderr is recorded.
const diagEntry = fakeEntry();
handleClaudeStreamLine(diagEntry, "warning: something", "stderr");
assert.equal(diagEntry.lastError, "warning: something");
handleClaudeStreamLine(diagEntry, "plain text", "stdout");
assert.equal(diagEntry._events[diagEntry._events.length - 1].type, "diagnostic");

console.log("Claude provider contract OK");

// Viewer automation wiring: Claude and Vibe reuse the Codex Playwright MCP contract.
const claudeSourceText = fs.readFileSync("js/agent_bridge_claude.js", "utf8");
const commonSourceText = fs.readFileSync("js/agent_bridge_common.js", "utf8");
const vibeSourceText = fs.readFileSync("js/agent_bridge_vibe.js", "utf8");
assert.match(claudeSourceText, /ensureManagedViewerDebugPort\(options\)/, "claudeStart must lease a viewer debug port");
assert.match(claudeSourceText, /options\.claudeHomeScope = "conversation"/, "a leased viewer port forces a conversation-scoped Claude home");
assert.match(claudeSourceText, /"--cdp-endpoint", resolvePlaywrightMcpCdpEndpoint\(options\), "--shared-browser-context"/, "Claude Playwright MCP must attach to the Studio viewer");
assert.match(claudeSourceText, /mcp__playwright__browser_tabs/, "Claude instructions must name the Playwright tool routes");
assert.match(commonSourceText, /name = "playwright"',\s*\n\s*'transport = "stdio"'/, "Vibe config must declare the Playwright stdio server");
assert.match(commonSourceText, /"X-Convertigo-Viewer-Debug-Port" = "' \+ String\(viewerDebugPort\)/, "Vibe config must send the viewer debug port header");
assert.match(vibeSourceText, /ensureManagedViewerDebugPort\(options\)/, "vibeStart must lease a viewer debug port");
assert.match(vibeSourceText, /disableViewerDebugPortReservation: true/, "Vibe settings discovery must not lease viewer ports");
assert.equal(typeof claudePlaywrightEnabled, "function");
assert.equal(claudePlaywrightEnabled({ viewerDebugPort: 41370, claudeHomeScope: "conversation" }), true);
assert.equal(claudePlaywrightEnabled({ viewerDebugPort: 41370, claudeHomeScope: "user" }), false, "a shared/user home must not hardcode a viewer endpoint");
assert.equal(claudePlaywrightEnabled({ viewerDebugPort: 41370, agentProfile: "nocode", userId: "alice" }), false, "NoCode sessions have no Studio viewer");
assert.equal(claudePlaywrightEnabled({}), false);
console.log("Claude/Vibe viewer automation contract OK");

// Vibe image blocks: JSON path lists are parsed, missing files and models without vision are skipped.
assert.equal(typeof vibeImageBlocks, "function");
const missingImage = vibeImageBlocks(JSON.stringify(["/nonexistent/screen.png", "/nonexistent/notes.txt"]), "vibe-thinking");
assert.deepEqual(missingImage.blocks, []);
assert.deepEqual(missingImage.skipped.map((item) => item.reason), ["not_found"], "non-image files are ignored, missing images are reported");
assert.equal(vibeModelSpec("glm-5-2").supportsImages, false, "GLM 5.2 through Mistral has no image input");
assert.equal(vibeModelSpec("vibe-thinking").supportsImages, true);
assert.match(migrateManagedVibeModelPresets('active_model = "glm-5-2"\n\n[[models]]\nname = "zai-glm-5-2"\nprovider = "mistral"\nalias = "glm-5-2"\ninput_price = 1.4\noutput_price = 4.4\nthinking = "high"\nsupports_images = true\n').text, /supports_images = false/, "managed GLM presets are migrated to the verified vision flag");
console.log("Vibe image attachment contract OK");

// Browser login: setup sequences route login/loginStatus to the provider login functions.
{
  const originalClaudeStart = C8O.agentBridge.claudeLoginStart;
  const originalClaudeStatus = C8O.agentBridge.claudeLoginStatus;
  const originalVibeStart = C8O.agentBridge.vibeLoginStart;
  const originalVibeStatus = C8O.agentBridge.vibeLoginStatus;
  assert.equal(typeof originalClaudeStart, "function");
  assert.equal(typeof originalClaudeStatus, "function");
  assert.equal(typeof originalVibeStart, "function");
  assert.equal(typeof originalVibeStatus, "function");
  const calls = [];
  C8O.agentBridge.claudeLoginStart = (o) => { calls.push("claude:start:" + String(o.forceLogin)); return { ok: true, status: "waiting_for_login" }; };
  C8O.agentBridge.claudeLoginStatus = () => { calls.push("claude:status"); return { ok: true, status: "authenticated" }; };
  C8O.agentBridge.vibeLoginStart = (o) => { calls.push("vibe:start:" + String(o.forceLogin)); return { ok: true, status: "waiting_for_login" }; };
  C8O.agentBridge.vibeLoginStatus = () => { calls.push("vibe:status"); return { ok: true, status: "authenticated" }; };
  try {
    assert.equal(C8O.agentBridge.claudeSetup({ login: "true", forceLogin: "true" }).status, "waiting_for_login");
    assert.equal(C8O.agentBridge.claudeSetup({ claudeLoginStatus: true }).status, "authenticated");
    assert.equal(C8O.agentBridge.claudeSetup({ login: true, loginStatus: true }).status, "authenticated", "status wins over start");
    assert.equal(C8O.agentBridge.vibeSetup({ vibeLogin: "true", forceLogin: false }).status, "waiting_for_login");
    assert.equal(C8O.agentBridge.vibeSetup({ loginStatus: "true" }).status, "authenticated");
    assert.deepEqual(calls, ["claude:start:true", "claude:status", "claude:status", "vibe:start:false", "vibe:status"]);
  } finally {
    C8O.agentBridge.claudeLoginStart = originalClaudeStart;
    C8O.agentBridge.claudeLoginStatus = originalClaudeStatus;
    C8O.agentBridge.vibeLoginStart = originalVibeStart;
    C8O.agentBridge.vibeLoginStatus = originalVibeStatus;
  }
}

// The Vibe login helper drives the Mistral browser sign-in headlessly and never prints the key.
{
  const script = vibeLoginScriptSource();
  assert.match(script, /from vibe\.setup\.auth import BrowserSignInError, BrowserSignInErrorCode, BrowserSignInService, HttpBrowserSignInGateway/);
  assert.match(script, /delay = min\(delay \* 2, 30\.0\)/, "poll failures (HTTP 429) must back off instead of aborting");
  assert.match(script, /C8O_VIBE_OPEN_BROWSER/);
  assert.match(script, /emit\('C8O_SIGN_IN_URL', attempt\.sign_in_url\)/);
  assert.match(script, /emit\('C8O_LOGIN_COMPLETED', env_key\)/);
  assert.match(script, /write_env\(pathlib\.Path\(home\) \/ '\.env', env_key, api_key\)/);
  assert.doesNotMatch(script, /emit\([^)]*api_key\)/, "the API key must never reach the bridge output");
  assert.match(script, /os\.chmod\(tmp, 0o600\)/);
  const output = "C8O_SIGN_IN_URL https://console.mistral.ai/codestral/cli/authenticate?process_id=abc&code=1\nC8O_SIGN_IN_EXPIRES_AT 2026-09-14T16:00:00+00:00\n";
  assert.equal(output.match(/C8O_SIGN_IN_URL\s+(\S+)/)[1], "https://console.mistral.ai/codestral/cli/authenticate?process_id=abc&code=1");
  assert.equal(loginProcessUrl("Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=x\nPaste code here if prompted >"), "https://claude.com/cai/oauth/authorize?code=true&state=x");
  assert.match(loginProcessOutput({ stdoutFile: null, stderrFile: null }), /^\s*$/);
}

// Authentication descriptors expose the provider login action the Assistant relies on.
{
  const vibeAuth = inspectVibeAuthentication("/nonexistent/vibe-home-" + Date.now());
  assert.equal(vibeAuth.configured, false);
  assert.equal(vibeAuth.action, "vibe_login");
  assert.equal(authenticationInfo(false, "", "claude_login").action, "claude_login");
  assert.match(claudeSource, /new ProcessBuilder\(toJavaList\(\[setup\.claude\.path, "auth", "login"\]\)\)/);
  assert.match(claudeSource, /env\.BROWSER = browserScript/);
  assert.match(claudeSource, /claudeHomeScope = "user"/);
  assert.match(vibeSource, /vibeHomeScope = "user"/);
  assert.match(commonSource, /function vibeCredentialSourceDirs/);
  assert.match(vibeSource, /bootstrapVibeHome\(setup\.vibeHome, options\)/);
}

// Claude Code MCP timeouts are raised for long-running Convertigo tools.
{
  const env = claudeRuntimeEnv({}, "/managed/claude-home");
  assert.equal(env.MCP_TOOL_TIMEOUT, "600000");
  assert.equal(env.MCP_TIMEOUT, "60000");
  assert.equal(claudeRuntimeEnv({ claudeMcpToolTimeoutMs: "900000" }, "").MCP_TOOL_TIMEOUT, "900000");
}
