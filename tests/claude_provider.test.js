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

// Convertigo gateway profile (LiteLLM per-user key) on the Vibe provider.
{
  assert.equal(resolveVibeProfile({}), "mistral");
  assert.equal(resolveVibeProfile({ vibeProfile: "convertigo" }), "convertigo");
  assert.equal(resolveVibeProfile({ provider: "convertigo" }), "convertigo");
  assert.equal(resolveVibeProfile({ agentMode: "gateway" }), "convertigo");
  assert.equal(withVibeProfile({ provider: "convertigo" }, "convertigo").provider, "vibe");
  const spec = vibeGatewayModelSpec({});
  assert.equal(spec.name, "mistral/zai-glm-5-3", "the fallback model when the gateway cannot be listed");
  assert.equal(spec.alias, "glm-5-3");
  assert.equal(spec.provider, "convertigo");
  assert.equal(spec.thinking, "high", "thinking is on by default; an unprobed model gets a level every known model accepts");
  assert.equal(vibeGatewayModelSpec({ gatewayModelIds: ["mistral/zai-glm-5-2"], gatewayModelEfforts: { "mistral/zai-glm-5-2": ["low", "medium", "high", "max"] } }).thinking, "medium");
  assert.equal(vibeGatewayModelSpec({ llmGatewayThinking: "off" }).thinking, "");
  assert.equal(vibeGatewayModelSpec({ llmGatewayThinking: "high" }).thinking, "high");
  assert.equal(convertigoGatewayUrl({ llmGatewayUrl: "https://gw.example/v1/" }), "https://gw.example/v1");
  const toml = 'active_model = "glm-5-2"\n\n[[providers]]\nname = "convertigo"\napi_base = "https://llm.convertigo.com/v1"\napi_key_env_var = "CONVERTIGO_LLM_API_KEY"\n\n[[models]]\nname = "mistral/zai-glm-5-2"\nprovider = "convertigo"\nalias = "glm-5-2"\n';
  assert.equal(parseVibeGatewayUrl(toml), "https://llm.convertigo.com/v1");
  assert.equal(parseVibeGatewayUrl('[[providers]]\nname = "mistral"\napi_base = "https://api.mistral.ai/v1"\n'), "");
  const untouched = migrateManagedVibeModelPresets(toml);
  assert.equal(untouched.text, toml, "gateway configs must not receive the Mistral GLM preset");
  assert.equal(untouched.added, false);
  assert.equal(inspectVibeAuthentication("/nonexistent/gateway-home-" + Date.now(), "convertigo").action, "convertigo_key");
  assert.match(vibeSource, /C8O\.agentBridge\.vibeGatewayKeyStore = function/);
  assert.match(commonSource, /homes-convertigo/);
}

// Convertigo mode: listed first, announces its harness, key file fallback.
{
  assert.match(commonSource, /providers\.push\(vibeSettings\(withVibeProfile\(options, "convertigo"\)\)\);\s*\}\s*if \(!provider\.length \|\| provider === "codex"\)/);
  assert.match(commonSource, /harness: "vibe",/);
  assert.match(commonSource, /function readConvertigoGatewayKeyFile/);
  assert.match(commonSource, /"agents"\), "convertigo"\), "llm-api-key"\)/);
}

// ACP model discovery must not rename the Convertigo mode back to "vibe".
{
  assert.match(commonSource, /provider\.id = normalizeProvider\(provider\.id\) === "convertigo" \? "convertigo" : "vibe";/);
  assert.match(vibeSource, /vibeProfile: discoveryProfile,/);
  assert.match(vibeSource, /\["id", "label", "harness", "profile", "gateway", "identity"/);
}

// MCP headers: reveal restart for Vibe, no-log header controlled by option/symbol.
{
  assert.equal(mcpNoLogEnabled({ mcpNoLog: "false" }), false);
  assert.equal(mcpNoLogEnabled({ mcpNoLog: "true" }), true);
  assert.equal(mcpNoLogEnabled({}), true, "symbol unreachable in tests: default is true");
  assert.match(commonSource, /'"X-Convertigo-No-Log" = "true"'/);
  // The quotes around the header key are optional: the Vibe runtime re-serializes config.toml
  // with bare keys, and a header read back as absent rewrites the config at every start.
  assert.match(commonSource, /info\.revealMode = \/\["'\]\?X-Convertigo-Reveal-Mode/);
  assert.match(commonSource, /info\.noLog = \/\["'\]\?X-Convertigo-No-Log/);
  assert.match(vibeSource, /reason: "reveal_mode_changed"/);
  assert.match(claudeSource, /headers\["X-Convertigo-No-Log"\] = "true";/);
}

// Convertigo mode: the model offer comes from the gateway, not from a constant.
{
  assert.equal(gatewayModelAlias("mistral/zai-glm-5-3"), "glm-5-3");
  assert.equal(gatewayModelAlias("mistral/zai-glm-5-2"), "glm-5-2");
  assert.equal(gatewayModelAlias("claude-sonnet-5"), "claude-sonnet-5");
  assert.deepEqual(normalizeGatewayModelIds("mistral/zai-glm-5-2, mistral/zai-glm-5-10 mistral/zai-glm-5-3,mistral/zai-glm-5-3, bad!name"),
    ["mistral/zai-glm-5-10", "mistral/zai-glm-5-3", "mistral/zai-glm-5-2"], "newest first, deduplicated, unsafe names dropped");

  const offer = { gatewayModelIds: ["mistral/zai-glm-5-2", "mistral/zai-glm-5-3"] };
  const specs = vibeGatewayModelSpecs(offer, "");
  assert.deepEqual(specs.map(s => s.alias), ["glm-5-3", "glm-5-2"]);
  assert.ok(specs.every(s => s.activeModel === "glm-5-3" && s.provider === "convertigo"), "the newest model is active by default");
  assert.equal(vibeGatewayModelSpec(offer, "").name, "mistral/zai-glm-5-3");
  assert.equal(vibeGatewayModelSpecs(Object.assign({ model: "glm-5-2" }, offer), "")[0].activeModel, "glm-5-2", "a conversation keeps its model while it is offered");
  assert.equal(vibeGatewayModelSpecs(Object.assign({ model: "devstral-small" }, offer), "")[0].activeModel, "glm-5-3", "an unknown model falls back to the default");
  assert.deepEqual(vibeGatewayModelSpecs({ llmGatewayModel: "mistral/zai-glm-5-2", gatewayModelIds: offer.gatewayModelIds }, "").map(s => s.name),
    ["mistral/zai-glm-5-2"], "an explicit llmGatewayModel pins the offer");
  assert.equal(vibeGatewayModelsFingerprint(specs), "mistral/zai-glm-5-2:high,mistral/zai-glm-5-3:high");

  const toml = 'active_model = "glm-5-3"\n\n[[providers]]\nname = "convertigo"\napi_base = "https://llm.convertigo.com/v1"\n\n[[models]]\nname = "mistral/zai-glm-5-3"\nprovider = "convertigo"\nalias = "glm-5-3"\n\n[[models]]\nname = "mistral/zai-glm-5-2"\nprovider = "convertigo"\nalias = "glm-5-2"\n\n[[models]]\nname = "devstral-small-latest"\nprovider = "mistral"\nalias = "devstral-small"\n';
  assert.equal(parseVibeGatewayModels(toml), "mistral/zai-glm-5-2:,mistral/zai-glm-5-3:", "only gateway models count in the reuse fingerprint");
  assert.match(vibeSource, /selected\.gatewayModels\) === expectedGatewayModels/);

  // Vibe advertises its built-in Mistral models over ACP; the Convertigo mode hides them.
  const acp = [{ id: "model", currentValue: "devstral-small", options: [
    { value: "glm-5-3", name: "glm-5-3" }, { value: "glm-5-2", name: "glm-5-2" },
    { value: "devstral-small", name: "devstral-small" }, { value: "mistral-medium-3.5", name: "mistral-medium-3.5" }] }];
  const filtered = normalizeVibeAcpProviderSettings(acp, { id: "convertigo", gateway: { models: ["glm-5-3", "glm-5-2"] } });
  assert.deepEqual(filtered.models.map(m => m.id), ["glm-5-3", "glm-5-2"]);
  assert.ok(filtered.models.every(m => m.provider === "convertigo"));
  assert.equal(filtered.defaultModel, "glm-5-3", "a built-in default is replaced by an offered model");
  const plainVibe = normalizeVibeAcpProviderSettings(acp, { id: "vibe" });
  assert.equal(plainVibe.models.length, 4, "the regular Vibe provider still lists everything");
}

// The generated config.toml declares every offered model and activates the requested one.
{
  const originalWrite = writeTextFile, originalEnsure = ensureDirectory;
  let written = "";
  writeTextFile = (_file, text) => { written = String(text); };
  ensureDirectory = () => {};
  try {
    const result = writeLocalVibeConfig("/managed/vibe-home", "http://localhost:18080/convertigo/api/mcp", "glm-5-2",
      { vibeProfile: "convertigo", gatewayModelIds: ["mistral/zai-glm-5-2", "mistral/zai-glm-5-3"] });
    assert.match(written, /^active_model = "glm-5-2"$/m, "the conversation model stays active");
    assert.equal((written.match(/^\[\[models\]\]$/gm) || []).length, 2);
    assert.match(written, /name = "mistral\/zai-glm-5-3"\nprovider = "convertigo"\nalias = "glm-5-3"/);
    assert.match(written, /name = "mistral\/zai-glm-5-2"\nprovider = "convertigo"\nalias = "glm-5-2"/);
    assert.doesNotMatch(written, /provider = "mistral"/);
    assert.equal(parseVibeGatewayModels(written), "mistral/zai-glm-5-2:high,mistral/zai-glm-5-3:high");
    assert.equal(result.model, "glm-5-2");
  } finally {
    writeTextFile = originalWrite;
    ensureDirectory = originalEnsure;
  }
}

// Convertigo agent key: the drop file replaces a stale .env value, whatever the file dates.
{
  const FP = "aabbccdd00112233", OLD_FP = "0011223344556677";
  // The reported bug: a placeholder typed first, the real key dropped in the file later.
  let d = gatewayKeySyncDecision("xxx", "", "sk-real-key", FP);
  assert.deepEqual([d.key, d.write, d.reason], ["sk-real-key", true, "file_changed"]);
  // First start of a home.
  d = gatewayKeySyncDecision("", "", "sk-real-key", FP);
  assert.deepEqual([d.key, d.write, d.reason], ["sk-real-key", true, "env_empty"]);
  // Steady state: nothing is rewritten.
  d = gatewayKeySyncDecision("sk-real-key", FP, "sk-real-key", FP);
  assert.deepEqual([d.key, d.write, d.reason], ["sk-real-key", false, "file_already_applied"]);
  // A key stored from the UI after the file was applied wins until the file changes.
  d = gatewayKeySyncDecision("sk-ui-key", FP, "sk-real-key", FP);
  assert.deepEqual([d.key, d.write], ["sk-ui-key", false]);
  d = gatewayKeySyncDecision("sk-ui-key", OLD_FP, "sk-rotated", FP);
  assert.deepEqual([d.key, d.write, d.reason], ["sk-rotated", true, "file_changed"]);
  // A home written before the marker existed only gains the marker.
  d = gatewayKeySyncDecision("sk-real-key", "", "sk-real-key", FP);
  assert.deepEqual([d.key, d.write, d.reason], ["sk-real-key", true, "marker_missing"]);
  // No drop file: the .env key is left alone.
  d = gatewayKeySyncDecision("sk-ui-key", "", "", "");
  assert.deepEqual([d.key, d.write, d.reason], ["sk-ui-key", false, "no_key_file"]);

  assert.doesNotMatch(commonSource, /isConvertigoGatewayProfile\(options\) && !vibeEnvHasKey\(/, "the only-when-empty guard is gone");
  assert.match(commonSource, /report\.gatewayKey = syncConvertigoGatewayKey\(options, homeDir, report\)\.reason/);
  const rejected = rejectedGatewayKeyAuthentication({});
  assert.equal(rejected.configured, false);
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.action, "convertigo_key");
  assert.match(rejected.message, /rejected the agent key/);
}

// Reasoning effort levels are per gateway model: GLM 5.3 refuses medium.
{
  const efforts = { "mistral/zai-glm-5-2": ["low", "medium", "high", "max"], "mistral/zai-glm-5-3": ["low", "high", "max"] };
  const offer = { gatewayModelIds: Object.keys(efforts), gatewayModelEfforts: efforts };
  assert.equal(gatewayEffortFor("medium", efforts["mistral/zai-glm-5-3"]), "high", "the closest stronger level");
  assert.equal(gatewayEffortFor("medium", efforts["mistral/zai-glm-5-2"]), "medium");
  assert.equal(gatewayEffortFor("max", ["low"]), "low");
  assert.equal(gatewayEffortFor("high", []), "", "a model without reasoning gets no level");
  assert.equal(gatewayEffortFor("off", efforts["mistral/zai-glm-5-3"]), "");
  assert.equal(gatewayEffortFor("medium", null), "high");
  const specs = vibeGatewayModelSpecs(offer, "");
  assert.deepEqual(specs.map(s => [s.alias, s.thinking]), [["glm-5-3", "high"], ["glm-5-2", "medium"]]);
  assert.deepEqual(gatewayEffortsForAlias(offer, "glm-5-3"), ["low", "high", "max"]);

  const acp = [
    { id: "model", currentValue: "glm-5-3", options: [{ value: "glm-5-3", name: "glm-5-3" }, { value: "glm-5-2", name: "glm-5-2" }] },
    { id: "thinking", currentValue: "medium", options: ["off", "low", "medium", "high", "max"].map(v => ({ value: v, name: v })) }];
  const normalized = normalizeVibeAcpProviderSettings(acp, { id: "convertigo", gateway: { models: ["glm-5-3", "glm-5-2"], efforts: { "glm-5-3": ["low", "high", "max"], "glm-5-2": ["low", "medium", "high", "max"] } } });
  const byId = Object.fromEntries(normalized.models.map(m => [m.id, m]));
  assert.deepEqual(byId["glm-5-3"].reasoningLevels.map(l => l.id), ["low", "high", "max"], "medium and off are not offered for GLM 5.3");
  assert.equal(byId["glm-5-3"].defaultReasoning, "high");
  assert.deepEqual(byId["glm-5-2"].reasoningLevels.map(l => l.id), ["low", "medium", "high", "max"], "off is not offered: the model requires an effort");
  assert.equal(byId["glm-5-2"].defaultReasoning, "medium");
  assert.doesNotMatch(commonSource, /return id === "off" \|\| id === "none" \|\| accepted\.indexOf\(id\) >= 0;/, "the off/none escape hatch is gone");
}

// The Vibe session option `thinking` is not the provider reasoning_effort.
{
  // Vibe's generic backend (Convertigo gateway profile) forwards the level and drops it on off.
  assert.equal(vibeThinkingEffort("low", true), "low");
  assert.equal(vibeThinkingEffort("off", true), "");
  // Vibe's native Mistral backend (Vibe profile) rewrites it: low becomes "none", which GLM refuses.
  assert.equal(vibeThinkingEffort("low", false), "none");
  assert.equal(vibeThinkingEffort("medium", false), "high");
  assert.equal(vibeThinkingEffort("max", false), "high");
  assert.equal(vibeThinkingEffort("off", false), "");

  const glm53 = ["low", "high", "max"], glm52 = ["low", "medium", "high", "max"];
  assert.deepEqual(vibeThinkingLevelsFor(glm53, true), ["low", "high", "max"], "generic: off is never offered");
  assert.deepEqual(vibeThinkingLevelsFor(glm52, true), ["low", "medium", "high", "max"]);
  assert.deepEqual(vibeThinkingLevelsFor(glm53, false), ["medium", "high", "max"], "native backend: low would send reasoning_effort none");
  assert.deepEqual(vibeThinkingLevelsFor(glm52, false), ["medium", "high", "max"]);
  assert.deepEqual(vibeThinkingLevelsFor([], false), ["off"], "a model that takes no effort only gets off");
  assert.equal(vibeThinkingLevelsFor(null, false), null, "an unprobed model keeps whatever Vibe offers");

  // Which backend a model really runs on: the managed GLM presets are declared on the generic
  // `mistral-direct` provider even on the Vibe profile, so they get their real levels there too.
  assert.equal(vibeModelUsesGenericBackend("glm-5-3", false), true);
  assert.equal(vibeModelUsesGenericBackend("zai-glm-5-2", false), true);
  assert.equal(vibeModelUsesGenericBackend("glm-5-3", true), true);
  assert.equal(vibeModelUsesGenericBackend("vibe-thinking", false), false, "a Vibe-native model stays on backend = mistral");
  assert.equal(vibeModelUsesGenericBackend("mistral-medium-3.5", false), false);
  assert.equal(vibeModelUsesGenericBackend("devstral-small", true), true, "every gateway model is generic");

  // Whatever the caller asks, the applied level is one the model accepts.
  const usable = vibeThinkingLevelsFor(glm53, true);
  assert.deepEqual(usable, ["low", "high", "max"]);
  assert.equal(vibeThinkingFor("off", usable), "low", "off is clamped to the weakest accepted level");
  assert.equal(vibeThinkingFor("low", usable), "low");
  assert.equal(vibeThinkingFor("medium", usable), "high", "a level the model does not take goes up");
  assert.equal(vibeThinkingFor("high", usable), "high");
  assert.equal(vibeThinkingFor("max", usable), "max");
  assert.equal(vibeThinkingFor("banana", usable), "high", "an unknown value falls back on the default");
  assert.equal(vibeThinkingFor("", usable), "high");
  assert.equal(vibeThinkingFor("max", ["low"]), "low", "the closest weaker level when nothing stronger exists");
  assert.equal(vibeThinkingFor("high", []), "", "a model without reasoning gets no level");
  assert.equal(vibeDefaultThinkingFor(usable, ""), "high");
  assert.equal(vibeDefaultThinkingFor(usable, "off"), "high", "a session left on off still pre-selects a real level");
  assert.equal(vibeDefaultThinkingFor(usable, "low"), "low", "low is a real level again, no longer clamped up");
  assert.equal(vibeDefaultThinkingFor(vibeThinkingLevelsFor(glm53, false), "low"), "medium",
    "a model still on the native backend keeps the old clamp");

  // The Vibe profile offer: every model carries a default the model accepts.
  const acpVibe = [
    { id: "model", currentValue: "glm-5-3", options: [{ value: "glm-5-3", name: "glm-5-3" }, { value: "glm-5-2", name: "glm-5-2" }] },
    { id: "thinking", currentValue: "low", options: ["off", "low", "medium", "high", "max"].map(v => ({ value: v, name: v })) }];
  const vibeOffer = normalizeVibeAcpProviderSettings(acpVibe, { id: "vibe", source: {}, supports: {} });
  const vibeById = Object.fromEntries(vibeOffer.models.map(m => [m.id, m]));
  // Same three real levels as the gateway profile: the GLM presets no longer go through the
  // native Mistral backend and its two-value reasoning_effort.
  assert.deepEqual(vibeById["glm-5-3"].reasoningLevels.map(l => l.id), ["low", "high", "max"]);
  assert.equal(vibeById["glm-5-3"].defaultReasoning, "low", "the session level low is now accepted, so it is kept");
  assert.deepEqual(vibeById["glm-5-2"].reasoningLevels.map(l => l.id), ["low", "medium", "high", "max"]);
  vibeOffer.models.forEach((model) => {
    const offered = model.reasoningLevels.map(l => l.id);
    assert.ok(!offered.length || offered.includes(model.defaultReasoning), model.id + " pre-selects an offered level");
  });

  // configureVibeSession aligns both profiles through the same clamp, on the backend the active
  // model really runs on rather than on the profile.
  assert.match(commonSource, /var usableThinking = vibeThinkingLevelsFor\(acceptedEfforts, vibeModelUsesGenericBackend\(activeAlias, convertigoSession\)\);/);
  assert.match(commonSource, /vibeDefaultThinkingFor\(usableThinking, currentThinking\)/);
}

// The Vibe profile config declares a second provider so the GLM presets get the generic backend.
{
  const originalWrite = writeTextFile, originalEnsure = ensureDirectory;
  let written = "";
  writeTextFile = (_file, text) => { written = String(text); };
  ensureDirectory = () => {};
  try {
    writeLocalVibeConfig("/managed/vibe-home", "http://localhost:18080/convertigo/api/mcp", "glm-5-3", {});
    assert.equal((written.match(/^\[\[providers\]\]$/gm) || []).length, 2, "the native provider is kept next to the new one");
    // Vibe's own models and the browser sign-in stay on the untouched native provider.
    assert.match(written, /^\[\[providers\]\]\nname = "mistral"\n[\s\S]*?^backend = "mistral"$/m);
    assert.match(written, /^browser_auth_base_url = "https:\/\/console\.mistral\.ai"$/m);
    // The additional provider: same endpoint, same key, generic backend.
    assert.match(written, /^\[\[providers\]\]\nname = "mistral-direct"\napi_base = "https:\/\/api\.mistral\.ai\/v1"\napi_key_env_var = "MISTRAL_API_KEY"\napi_style = "openai"\nbackend = "generic"\nreasoning_field_name = "reasoning_content"$/m);
    assert.doesNotMatch(written, /name = "mistral-direct"[\s\S]*?browser_auth/, "the sign-in stays on the native provider only");
    // The GLM preset points at it; nothing else does.
    assert.match(written, /name = "zai-glm-5-3"\nprovider = "mistral-direct"\nalias = "glm-5-3"/);
    assert.equal(parseVibeProviderNames(written), "mistral,mistral-direct");
    assert.equal(parseVibeProviderNames(written), expectedVibeProviderNames("vibe"));

    // A Vibe-native model keeps the native provider, and the extra provider is still declared.
    writeLocalVibeConfig("/managed/vibe-home", "http://localhost:18080/convertigo/api/mcp", "mistral-medium-3.5", {});
    assert.match(written, /name = "mistral-vibe-cli-latest"\nprovider = "mistral"\nalias = "mistral-medium-3\.5"/);
    assert.equal(parseVibeProviderNames(written), "mistral,mistral-direct");

    // The gateway profile is untouched: one provider, named convertigo.
    writeLocalVibeConfig("/managed/vibe-home", "http://localhost:18080/convertigo/api/mcp", "glm-5-3",
      { vibeProfile: "convertigo", gatewayModelIds: ["mistral/zai-glm-5-3"] });
    assert.equal(parseVibeProviderNames(written), "convertigo");
    assert.equal(parseVibeProviderNames(written), expectedVibeProviderNames("convertigo"));
  } finally {
    writeTextFile = originalWrite;
    ensureDirectory = originalEnsure;
  }
  // vibeStart must rewrite a home whose provider list predates the mistral-direct block.
  assert.match(vibeSourceText, /var expectedProviderNames = expectedVibeProviderNames\(profile\);/);
  assert.match(vibeSourceText, /trim\(setup\.config\.selected\.providerNames\) === expectedProviderNames/);
  assert.equal(parseVibeProviderNames('[[providers]]\nname = "mistral"\n'), "mistral",
    "a pre-existing home reports only the native provider, so it is rewritten once");
}

// A cached ACP catalog is re-aligned on the live gateway offer.
{
  const stale = { id: "convertigo", defaultModel: "devstral-small",
    gateway: { models: ["glm-5-3", "glm-5-2"], efforts: { "glm-5-3": ["low", "high", "max"], "glm-5-2": ["low", "medium", "high", "max"] } },
    models: [
      { id: "glm-5-2", label: "glm-5-2", defaultReasoning: "medium", reasoningLevels: ["off", "low", "medium", "high", "max"].map(id => ({ id, label: id })) },
      { id: "devstral-small", label: "devstral-small", defaultReasoning: "off", reasoningLevels: [] }] };
  const aligned = applyGatewayOfferToProvider(stale);
  assert.deepEqual(aligned.models.map(m => m.id), ["glm-5-3", "glm-5-2"], "the new model appears, the built-in one goes");
  assert.deepEqual(aligned.models[0].reasoningLevels.map(l => l.id), ["low", "high", "max"]);
  assert.equal(aligned.models[0].defaultReasoning, "high");
  assert.deepEqual(aligned.models[1].reasoningLevels.map(l => l.id), ["low", "medium", "high", "max"], "off is dropped from a cached catalog too");
  assert.equal(aligned.models[1].defaultReasoning, "medium");
  assert.equal(aligned.defaultModel, "glm-5-3");
  assert.equal(applyGatewayOfferToProvider({ id: "vibe", models: [{ id: "x" }] }).models.length, 1, "other providers are untouched");
}

// Vibe (personal Mistral account) profile: GLM 5.3 is a managed preset next to GLM 5.2.
{
  assert.equal(vibeModelSpec("glm-5-3").name, "zai-glm-5-3");
  assert.equal(vibeModelSpec("zai-glm-5-3").activeModel, "glm-5-3");
  assert.equal(vibeModelSpec("glm-5-3").thinking, "high");
  assert.equal(vibeModelSpec("glm-5-2").name, "zai-glm-5-2");

  // An existing home that only knows GLM 5.2 gains GLM 5.3, once.
  const existing = 'active_model = "glm-5-2"\n\n[[providers]]\nname = "mistral"\n\n[[models]]\nname = "zai-glm-5-2"\nprovider = "mistral"\nalias = "glm-5-2"\ninput_price = 1.4\noutput_price = 4.4\nthinking = "high"\nsupports_images = false\n';
  const upgraded = migrateManagedVibeModelPresets(existing);
  assert.deepEqual(upgraded.addedPresets, ["glm-5-3"]);
  assert.match(upgraded.text, /name = "zai-glm-5-3"\nprovider = "mistral-direct"\nalias = "glm-5-3"/);
  assert.match(upgraded.text, /name = "zai-glm-5-2"\nprovider = "mistral-direct"\nalias = "glm-5-2"/,
    "the GLM block already there is moved off the native provider too");
  assert.equal(upgraded.migratedProvider, true);
  assert.match(upgraded.text, /^active_model = "glm-5-2"$/m, "the active model is not changed behind the user's back");
  const again = migrateManagedVibeModelPresets(upgraded.text);
  assert.equal(again.added, false);
  assert.equal(again.text, upgraded.text, "idempotent");
  // A fresh config gets both, newest first.
  const fresh = migrateManagedVibeModelPresets('active_model = "vibe-thinking"\n');
  assert.deepEqual(fresh.addedPresets, ["glm-5-3"], "only the current GLM is pushed to new homes");
  assert.doesNotMatch(fresh.text, /zai-glm-5-2/);
  assert.equal(vibeModelSpec("glm-5-2").name, "zai-glm-5-2", "GLM 5.2 stays resolvable for conversations that still use it");

  // The same per-model thinking levels as through the gateway: the GLM presets of this profile
  // now run on the generic `mistral-direct` provider, which forwards reasoning_effort verbatim.
  const acp = [
    { id: "model", currentValue: "glm-5-3", options: [{ value: "glm-5-3", name: "glm-5-3" }, { value: "glm-5-2", name: "glm-5-2" }, { value: "mistral-medium-3.5", name: "mistral-medium-3.5" }] },
    { id: "thinking", currentValue: "medium", options: ["off", "low", "medium", "high", "max"].map(v => ({ value: v, name: v })) }];
  const vibe = normalizeVibeAcpProviderSettings(acp, { id: "vibe" });
  const byId = Object.fromEntries(vibe.models.map(m => [m.id, m]));
  assert.deepEqual(byId["glm-5-3"].reasoningLevels.map(l => l.id), ["low", "high", "max"]);
  assert.equal(byId["glm-5-3"].defaultReasoning, "high", "GLM 5.3 has no medium: the session level goes up to high");
  assert.deepEqual(byId["glm-5-2"].reasoningLevels.map(l => l.id), ["low", "medium", "high", "max"]);
  assert.equal(byId["glm-5-2"].defaultReasoning, "medium", "the session level is kept when the model accepts it");
  assert.deepEqual(byId["mistral-medium-3.5"].reasoningLevels.map(l => l.id), ["off", "low", "medium", "high", "max"], "other Vibe models are untouched");
  assert.equal(byId["mistral-medium-3.5"].defaultReasoning, "medium");
}

// Agent process lifecycle: common to every provider.
{
  assert.equal(entryUsesPidTree({ protocol: "acp", process: {} }), true, "ACP agents (Vibe) are tracked too");
  assert.equal(entryUsesPidTree({ protocol: "some-future-protocol", process: {} }), true, "a new provider is tracked with no specific code");
  assert.equal(entryUsesPidTree({ protocol: "acp", process: null }), false);

  const mine = { currentPid: 100, bridgeVersion: "0.4.17", maxIdleMs: 60000, idleMs: 1000, ownerAlive: false, registered: false };
  assert.deepEqual(pidRecordVerdict({ ownerPid: 100, bridgeVersion: "0.4.17" }, Object.assign({}, mine, { registered: true })), { stop: false, reason: "registered" });
  assert.deepEqual(pidRecordVerdict({ ownerPid: 77, bridgeVersion: "0.4.17" }, mine), { stop: true, reason: "owner_gone" }, "the JVM that started it was killed");
  assert.deepEqual(pidRecordVerdict({ ownerPid: 77 }, Object.assign({}, mine, { ownerAlive: true })), { stop: false, reason: "other_owner" }, "another live Convertigo on the same workspace keeps its agents");
  assert.deepEqual(pidRecordVerdict({ ownerPid: 100, bridgeVersion: "0.4.16" }, mine), { stop: true, reason: "bridge_version_changed" });
  assert.deepEqual(pidRecordVerdict({ ownerPid: 100, bridgeVersion: "0.4.17" }, mine), { stop: false, reason: "grace" });
  assert.deepEqual(pidRecordVerdict({ ownerPid: 100, bridgeVersion: "0.4.17" }, Object.assign({}, mine, { idleMs: 90000 })), { stop: true, reason: "orphan" });
  assert.deepEqual(pidRecordVerdict({}, Object.assign({}, mine, { idleMs: 90000 })), { stop: true, reason: "orphan" }, "records written before the owner field follow the idle rule");

  // One launch point applies every layer.
  const launch = commonSource.match(/function startProcess\(entry, env\) \{[\s\S]*?\n  \}/)[0];
  for (const layer of ["ensureAgentShutdownHook()", "sweepAllProviderPidFiles(", "agentGuardedCommand(entry", "writeEntryPidFile(entry)", "system/unguarded"]) {
    assert.ok(launch.includes(layer), layer);
  }
  assert.match(commonSource, /addShutdownHook\(hook\)/);
  // The guard script itself is valid JavaScript and watches both the owner pid and re-parenting.
  const guardLines = eval("[" + commonSource.match(/var AGENT_GUARD_SOURCE = \[([\s\S]*?)\]\.join\("\\n"\);/)[1] + "]");
  new vm.Script(guardLines.join("\n"));
  assert.ok(guardLines.some(l => l.includes("process.ppid !== startedUnder")) && guardLines.some(l => l.includes("process.kill(owner, 0)")));
  assert.equal(agentGuardedCommand({ command: ["vibe-acp"] }, { agentProcessGuard: "false" }).reason, "disabled");
}

// Stop interrupts the turn and keeps the agent; one thin adapter per protocol.
{
  const written = [];
  const fakeEntry = (protocol, extra) => Object.assign({ protocol, turnActive: true, nextRequestId: 7, nextIndex: 0, firstIndex: 0,
    events: { add() {}, size: () => 0, remove() {} }, writer: { write: t => written.push(JSON.parse(t)), newLine() {}, flush() {} } }, extra);
  assert.equal(TURN_INTERRUPT_ADAPTERS["acp"](fakeEntry("acp", { sessionId: "s-1" })), true);
  assert.deepEqual(written.pop(), { jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s-1" } }, "ACP cancel is a notification: no id");
  assert.equal(TURN_INTERRUPT_ADAPTERS["acp"](fakeEntry("acp", { sessionId: "" })), false);
  assert.equal(TURN_INTERRUPT_ADAPTERS["codex-app-server"](fakeEntry("codex-app-server", { codexThreadId: "t-1", activeTurnId: "turn-9" })), true);
  assert.deepEqual(written.pop(), { id: 7, method: "turn/interrupt", params: { threadId: "t-1", turnId: "turn-9" } });
  assert.equal(TURN_INTERRUPT_ADAPTERS["claude-stream-json"](fakeEntry("claude-stream-json", {})), true);
  assert.equal(written.pop().request.subtype, "interrupt");
  assert.equal(typeof TURN_INTERRUPT_ADAPTERS["some-future-protocol"], "undefined", "a new provider answers unsupported until it gets an adapter");

  // The common turn flag follows the three events every provider emits.
  const entry = fakeEntry("acp", { turnActive: false });
  pushEvent(entry, "turn/start", {}); assert.equal(entry.turnActive, true);
  pushEvent(entry, "session/update", {}); assert.equal(entry.turnActive, true);
  pushEvent(entry, "turn/end", {}); assert.equal(entry.turnActive, false);
  pushEvent(entry, "turn/start", {}); pushEvent(entry, "turn/error", {}); assert.equal(entry.turnActive, false);

  // A restarted Vibe process reloads the conversation and hides the replayed history.
  assert.match(vibeSource, /entry\.init\.agentCapabilities\.loadSession === true/);
  assert.match(vibeSource, /acpRequest\(entry, "session\/load", \{\s*sessionId: previousSessionId/);
  assert.match(vibeSource, /finally \{\s*entry\.replayingSession = false;/);
  assert.match(commonSource, /if \(entry\.replayingSession === true\) \{[\s\S]*?return;\s*\}\s*normalizeSessionUpdate/);
}
