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
const discovered=normalizeClaudeModelCatalog([
 {value:'opus',resolvedModel:'claude-opus-5-5',displayName:'Opus 5.5',description:'For complex work',supportsEffort:true,supportedEffortLevels:['low','high','max']},
 {value:'fable',resolvedModel:'claude-fable-5-1',displayName:'Fable 5.1',description:'For your toughest challenges',supportsEffort:true},
 {value:'claude-haiku-4-5',displayName:'Haiku 4.5',supportsEffort:false},
 {value:'opus',displayName:'duplicate'}
]);
assert.deepEqual(discovered.map(m=>m.label),['Opus 5.5','Fable 5.1','Haiku 4.5']);
assert.deepEqual(discovered[0].reasoningLevels.map(l=>l.id),['low','high','max']);
assert.deepEqual(discovered[2].reasoningLevels,[]);
assert.ok(catalog.every(m=>! /\d/.test(m.label)), 'fallback aliases must not advertise stale versions');

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

// The input of a call reaches the Assistant with its result: the tool/start of a streamed call carries {} (run 13, Read of a PNG).
{
  const readEntry = fakeEntry();
  const big = "x".repeat(5000);
  [
    JSON.stringify({ type: "stream_event", event: { type: "message_start", message: { id: "m2" } } }),
    JSON.stringify({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_r", name: "Read", input: {} } } }),
    JSON.stringify({ type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_w", name: "Write", input: {} } } }),
    JSON.stringify({ type: "assistant", message: { id: "m2", content: [
      { type: "tool_use", id: "toolu_r", name: "Read", input: { file_path: "/ws/.playwright-mcp/home.png" } },
      { type: "tool_use", id: "toolu_w", name: "Write", input: { file_path: "/ws/a.txt", content: big, meta: { a: 1 } } }] } }),
    JSON.stringify({ type: "user", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "toolu_r", content: [{ type: "image", source: { type: "base64", data: "AAAA" } }] },
      { type: "tool_result", tool_use_id: "toolu_w", content: "ok" }] } })
  ].forEach((line) => handleClaudeStreamLine(readEntry, line, "stdout"));
  const updates = readEntry._events.filter((event) => event.type === "tool/update");
  assert.deepEqual(updates[0].data.input, { file_path: "/ws/.playwright-mcp/home.png" });
  assert.equal(updates[1].data.input.file_path, "/ws/a.txt");
  assert.equal(updates[1].data.input.content.length, 301, "a long argument is cut, not copied whole");
  assert.equal(updates[1].data.input.meta, undefined, "objects are left out");
}

// Skill calls acknowledge the managed skills: the next turns no longer ask for a reread (run 9).
{
  const skillEntry = fakeEntry();
  skillEntry.home = { path: "/tmp/claude-home" };
  skillEntry.managedSkillBundle = {
    ready: true, fingerprint: "f1", refreshRequired: true, skills: {},
    slugs: ["convertigo-studio", "convertigo-generalist"], pendingSlugs: ["convertigo-studio", "convertigo-generalist"]
  };
  const acknowledged = [];
  const originalAcknowledge = acknowledgeManagedSkillBundle;
  acknowledgeManagedSkillBundle = (home, bundle) => { acknowledged.push([home, bundle.fingerprint]); return true; };
  try {
    const skillCall = (id, name, input) => [
      JSON.stringify({ type: "assistant", message: { id: "m" + id, content: [{ type: "tool_use", id, name, input }] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } })
    ];
    skillCall("s1", "Skill", { skill: "convertigo-studio" }).forEach((line) => handleClaudeStreamLine(skillEntry, line, "stdout"));
    assert.equal(acknowledged.length, 0, "one skill out of two is not an acknowledgement");
    skillCall("s2", "Read", { file_path: "/tmp/claude-home/skills/convertigo-generalist/SKILL.md" }).forEach((line) => handleClaudeStreamLine(skillEntry, line, "stdout"));
    assert.deepEqual(acknowledged, [["/tmp/claude-home", "f1"]]);
    assert.equal(skillEntry.managedSkillBundle.refreshRequired, false);
    assert.ok(skillEntry._events.some((event) => event.type === "guidance/acknowledged"));
  } finally {
    acknowledgeManagedSkillBundle = originalAcknowledge;
  }
}

function commonSourceOrClaude() { return fs.readFileSync("js/agent_bridge_claude.js", "utf8"); }

// Tigo's "/" menu gets Claude's commands: the skills and the built-ins that keep the conversation in step with Tigo.
{
  const commandEntry = fakeEntry();
  const written = [];
  commandEntry.writer = { write: (text) => written.push(JSON.parse(text)), newLine() {}, flush() {} };
  const pending = new Map();
  commandEntry.pending = { put: (k, v) => pending.set(k, v), get: (k) => pending.get(k), remove: (k) => pending.delete(k) };
  claudeRequestCommands(commandEntry);
  assert.equal(written[0].type, "control_request");
  assert.equal(written[0].request.subtype, "initialize");
  handleClaudeStreamLine(commandEntry, JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: written[0].request_id, response: {
    account: { email: "someone@example.com" }, commands: [
      { name: "compact", description: "Free up context", argumentHint: "<optional custom summarization instructions>", builtin: true },
      { name: "clear", description: "Start a new session", builtin: true },
      { name: "model", description: "Set the AI model", builtin: true },
      { name: "convertigo-generalist", description: "Bootstrap Claude Code for general Convertigo work. (user)", argumentHint: "" },
      { name: "__remote-workflow", description: "internal" }] } } }), "stdout");
  const update = commandEntry._events.find((event) => event.type === "commands/update");
  assert.deepEqual(update.data.update.availableCommands.map((c) => c.name), ["compact", "convertigo-generalist"],
    "/clear and /model would put the conversation out of step with Tigo");
  assert.equal(update.data.update.availableCommands[0].input.hint, "<optional custom summarization instructions>");
  assert.equal(pending.size, 0);
  assert.doesNotMatch(JSON.stringify(commandEntry._events), /someone@example\.com/, "account metadata stays out of the events");
  // A later system/init does not replace the described list; system/commands_changed does.
  handleClaudeStreamLine(commandEntry, JSON.stringify({ type: "system", subtype: "init", session_id: "s1", mcp_servers: [], slash_commands: ["compact", "context", "clear"] }), "stdout");
  assert.equal(commandEntry._events.filter((event) => event.type === "commands/update").length, 1);
  handleClaudeStreamLine(commandEntry, JSON.stringify({ type: "system", subtype: "commands_changed", commands: [{ name: "context", description: "Show context", builtin: true }] }), "stdout");
  assert.deepEqual(commandEntry._events.filter((event) => event.type === "commands/update").pop().data.update.availableCommands.map((c) => c.name), ["context"]);
  // Without an initialize answer, system/init still offers the built-ins of the menu.
  const olderEntry = fakeEntry();
  handleClaudeStreamLine(olderEntry, JSON.stringify({ type: "system", subtype: "init", session_id: "s2", mcp_servers: [], slash_commands: ["compact", "context", "cost", "clear", "convertigo-generalist"] }), "stdout");
  assert.deepEqual(olderEntry._events.find((event) => event.type === "commands/update").data.update.availableCommands.map((c) => c.name), ["compact", "context", "cost"]);
  // With a managed skill bundle, the account's other skills stay out of the menu.
  const managedEntry = fakeEntry();
  managedEntry.managedSkillBundle = { slugs: ["convertigo-generalist", "convertigo-studio"] };
  handleClaudeStreamLine(managedEntry, JSON.stringify({ type: "system", subtype: "commands_changed", commands: [
    { name: "convertigo-studio", description: "Studio" }, { name: "pptx", description: "Slides" }, { name: "compact", description: "Compact", builtin: true }] }), "stdout");
  assert.deepEqual(managedEntry._events.find((event) => event.type === "commands/update").data.update.availableCommands.map((c) => c.name), ["convertigo-studio", "compact"]);
  // A prompt that starts with a menu command goes as is: Claude Code runs it only at the start of the message.
  assert.equal(claudeMenuCommandOf(managedEntry, "/compact keep the SQL decisions"), "compact");
  assert.equal(claudeMenuCommandOf(managedEntry, "/pptx"), "", "not in the menu");
  assert.equal(claudeMenuCommandOf(managedEntry, "/clear"), "");
  assert.equal(claudeMenuCommandOf(managedEntry, "/cost"), "cost", "a built-in of the menu that Claude does not list for a subscription");
  // A local command calls no model: its zero usage keeps the last measure. /compact does not answer with the
  // output of the command before it.
  const localEntry = fakeEntry();
  localEntry.claudeTurnCommand = "context";
  handleClaudeStreamLine(localEntry, JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 0, result: "## Context Usage",
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }), "stdout");
  assert.equal(localEntry._events.filter((event) => event.type === "usage/update").length, 0);
  assert.equal(localEntry._events.find((event) => event.type === "answer/chunk").data.text, "## Context Usage");
  const compactEntry = fakeEntry();
  compactEntry.claudeTurnCommand = "compact";
  handleClaudeStreamLine(compactEntry, JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 0, result: "## Context Usage (previous command)" }), "stdout");
  assert.equal(compactEntry._events.filter((event) => event.type === "answer/chunk").length, 0);
  assert.equal(compactEntry._events.pop().type, "turn/end");
  assert.equal(compactEntry.claudeTurnCommand, "");
  assert.equal(claudeMenuCommandOf(managedEntry, "Lis /compact dans le guide"), "");
  assert.equal(claudeMenuCommandOf(fakeEntry(), "/context"), "context", "before the menu is known, the built-ins count");
  assert.match(commonSourceOrClaude(), /var menuCommand = claudeMenuCommandOf\(entry, promptText\);[\s\S]{0,200}?if \(managedPreflightCurrent && !menuCommand\.length\)/);
}

// A gateway model (mistral/zai-glm-5-3) runs Claude Code on the Convertigo LiteLLM gateway, like the claude-glm launcher:
// the gateway key, every model alias on that model, no --model flag, and a home without the subscription login.
{
  assert.equal(claudeGatewayModel("mistral/zai-glm-5-3"), true);
  assert.equal(claudeGatewayModel("claude-sonnet-5-5"), false);
  assert.equal(claudeGatewayModel("sonnet"), false);
  const claudeSource = fs.readFileSync("js/agent_bridge_claude.js", "utf8");
  assert.match(claudeSource, /if \(claudeGatewayModel\(pinnedModel\)\) \{[\s\S]{0,900}env\.ANTHROPIC_AUTH_TOKEN = gatewayKey;[\s\S]{0,900}env\.CLAUDE_CONFIG_DIR = gatewayHome;/);
  assert.match(claudeSource, /!claudeGatewayModel\(entry\.model\)\) \{\s*command\.push\("--model"\);/);
  assert.doesNotMatch(claudeSource.match(/function claudeGatewayHome[\s\S]*?\n  \}\n/)[0], /credentials|oauthAccount/,
    "the gateway home never receives the subscription login");
}

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
// A download in the viewer opened JxBrowser's modal Save panel and froze the Studio (run 9b).
assert.match(commonSourceText, /Browser\.setDownloadBehavior\\", \{ behavior: \\"allow\\"/, "the Playwright init page must make the viewer save downloads without a dialog");
assert.equal((claudeSourceText.match(/\.concat\(playwrightViewerInitArgs\(installDir\)\)/g) || []).length, 1, "Claude's npx Playwright launch must load the viewer init page");
assert.equal((commonSourceText.match(/\.concat\(playwrightViewerInitArgs\(installDir\)\)/g) || []).length, 3, "the direct, Codex and Vibe Playwright launches must load the viewer init page");
assert.match(claudeSourceText, /claudePlaywrightOutputDir\(options\) \+ "\/downloads\/`/, "Claude instructions must give the absolute path where viewer downloads land");
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
  assert.equal(vibeGatewayModelsFingerprint(specs), "mistral/zai-glm-5-2:high:200000:0:1.4/0.14/4.4,mistral/zai-glm-5-3:high:950000:1000000:1.4/0.14/4.4");
  const large = vibeGatewayModelSpecs({ gatewayModelIds: ["mistral/mistral-large-4"] }, "")[0];
  assert.deepEqual([large.inputPrice, large.cachedInputPrice, large.outputPrice], ["0.68", "0.068", "2.09"], "Mistral Large 4 prices fitted on gateway bills");
  assert.equal(vibeCompactThresholdFor("mistral/zai-glm-5-3"), 950000, "GLM 5.3 accepts ~975k input tokens; the run compacts itself at 900k");
  assert.equal(vibeCompactThresholdFor("glm-5-3"), 950000, "the alias matches too");
  assert.equal(vibeCompactThresholdFor("mistral/zai-glm-5-2"), 200000);
  assert.equal(vibeCompactThresholdFor("mistral-large-4"), 950000, "Mistral Large 4 has a 1M window, like GLM 5.3");
  assert.equal(vibeContextWindowFor("mistral/mistral-large-4"), 1000000);
  assert.equal(vibeCompactThresholdFor("mistral/mistral-small-4"), 200000, "unverified windows keep the default");
  assert.equal(vibeCompactThresholdFor(""), 200000);

  const toml = 'active_model = "glm-5-3"\n\n[[providers]]\nname = "convertigo"\napi_base = "https://llm.convertigo.com/v1"\n\n[[models]]\nname = "mistral/zai-glm-5-3"\nprovider = "convertigo"\nalias = "glm-5-3"\n\n[[models]]\nname = "mistral/zai-glm-5-2"\nprovider = "convertigo"\nalias = "glm-5-2"\n\n[[models]]\nname = "devstral-small-latest"\nprovider = "mistral"\nalias = "devstral-small"\n';
  assert.equal(parseVibeGatewayModels(toml), "mistral/zai-glm-5-2:::0,mistral/zai-glm-5-3:::0", "only gateway models count in the reuse fingerprint");
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
    assert.equal(parseVibeGatewayModels(written), "mistral/zai-glm-5-2:high:200000:0,mistral/zai-glm-5-3:high:950000:1000000");
    assert.match(written, /^auto_compact_threshold = 200000$/m, "the global threshold follows the active model (GLM 5.2)");
    assert.equal(result.model, "glm-5-2");
    writeLocalVibeConfig("/managed/vibe-home", "http://localhost:18080/convertigo/api/mcp", "glm-5-3",
      { vibeProfile: "convertigo", gatewayModelIds: ["mistral/zai-glm-5-2", "mistral/zai-glm-5-3"] });
    assert.match(written, /^active_model = "glm-5-3"\napi_timeout = 720\.0\nauto_compact_threshold = 950000$/m, "GLM 5.3 active: global threshold 950k");
    assert.match(written, /alias = "glm-5-3"[\s\S]*?auto_compact_threshold = 950000/);
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
  assert.deepEqual(vibeThinkingLevelsFor([], false), [], "a model that takes no effort gets no level at all: off is never offered");
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
    assert.match(written, /^\[\[providers\]\]\nname = "mistral-direct"\napi_base = "https:\/\/api\.mistral\.ai\/v1"\napi_key_env_var = "MISTRAL_API_KEY"\napi_style = "reasoning"\nbackend = "generic"\nreasoning_field_name = "reasoning_content"$/m);
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
  assert.deepEqual(byId["mistral-medium-3.5"].reasoningLevels.map(l => l.id), ["low", "medium", "high", "max"], "a Vibe-native model keeps its offer, minus off");
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
  // Version 2 also stops what the agent detached, on every way out, and the Bridge gives it the time to.
  assert.ok(guardLines.some(l => l.includes("C8O_AGENT_GUARD: markValue")), "the agent and its processes inherit the mark");
  assert.ok(guardLines.some(l => l.includes("if (!stopping) { stopping = true; sweep(); }")), "an agent that ends by itself takes its leftovers along");
  assert.match(commonSource, /if \(entry\.guarded === true\) \{\s*stopThroughGuard\(/);
  assert.match(commonSource, /Guards first, all at once/);
  if (process.platform !== "win32") {
    // The case seen in run 9b: the agent starts a server with nohup, its shell exits, the server is
    // re-parented to launchd. A Node server stands for it here.
    const os = require("node:os"), path = require("node:path"), childProcess = require("node:child_process");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c8o-guard-"));
    const script = path.join(dir, "agent-guard.cjs");
    fs.writeFileSync(script, guardLines.join("\n"));
    const tag = "c8o-guard-leftover-" + process.pid;
    const leftovers = () => (childProcess.spawnSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" }).stdout || "")
      .split("\n").filter(line => line.includes(tag)).map(line => Number(line.trim().split(/\s+/)[0]));
    const run = childProcess.spawnSync(process.execPath, [script, String(process.pid), "--", "/bin/sh", "-c",
      "nohup '" + process.execPath + "' -e 'setTimeout(() => {}, 60000)' " + tag + " >/dev/null 2>&1 & sleep 1; exit 3"], { timeout: 20000 });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    const left = leftovers();
    left.forEach(pid => { try { process.kill(pid, "SIGKILL"); } catch (e) {} });
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(run.status, 3, "the guard keeps the agent's exit code");
    assert.deepEqual(left, [], "the detached process is stopped with its agent");
  }
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

// The managed Vibe config.toml is reused when nothing changed.
// The Vibe runtime re-serializes config.toml on every session start, with bare header keys and
// its own table layout, and lib_ConvertigoMCP._setupVibe rewrites the Convertigo MCP url right
// after the Bridge wrote it. Both used to make the reuse check fail at every start, rewriting a
// byte-identical file and pruning the MCP descriptor cache for nothing.
{
  const bridgeWritten = [
    '[[mcp_servers]]', 'name = "Convertigo"', 'transport = "http"',
    'url = "http://localhost:18082/convertigo/api/mcp?jsonOnly=false&descriptorVersion=v1"',
    '', '[mcp_servers.auth]', 'type = "static"', 'api_key_env = "CONVERTIGO_MCP_TOKEN"',
    '', '[mcp_servers.auth.headers]',
    '"X-Convertigo-No-Log" = "true"', '"X-Convertigo-Reveal-Mode" = "true"',
    '"X-Convertigo-Viewer-Debug-Port" = "18083"', ''
  ].join("\n");
  // The very same settings, after the Vibe runtime rewrote the file: bare keys.
  const vibeRewritten = bridgeWritten.replace(/"(X-Convertigo-[^"]+)"(\s*=)/g, "$1$2");
  const originalReadTextFile = readTextFile;
  const originalFilePath = filePath;
  filePath = () => "/home/.vibe-home/config.toml";
  const inspect = (text) => {
    readTextFile = () => text;
    return inspectVibeConfig({ exists: () => true });
  };
  const fromBridge = inspect(bridgeWritten);
  const fromVibe = inspect(vibeRewritten);
  readTextFile = originalReadTextFile;
  filePath = originalFilePath;
  assert.equal(fromBridge.valid, true);
  assert.equal(fromVibe.valid, true, "the runtime's own layout is still a valid Convertigo entry");
  for (const field of ["noLog", "revealMode", "viewerDebugPort", "endpoint", "bearerTokenEnv"]) {
    assert.deepEqual(fromVibe[field], fromBridge[field],
      "the reuse check must read the same " + field + " whoever serialized the file");
  }
  assert.equal(fromVibe.noLog, true, "a bare header key is still a header");
  assert.equal(fromVibe.revealMode, true);
  assert.equal(fromVibe.viewerDebugPort, 18083);

  // _setupVibe owns the query string of the url, so only its base is comparable.
  assert.equal(mcpEndpointBaseUrl("http://h/convertigo/api/mcp?jsonOnly=true"), "http://h/convertigo/api/mcp");
  assert.equal(mcpEndpointBaseUrl("http://h/convertigo/api/mcp"), "http://h/convertigo/api/mcp");

  // What the Bridge meant to write is recorded beside the file, so two identical starts compare
  // equal while any real change moves the intent.
  const base = { endpoint: "http://h/api/mcp?jsonOnly=false", bearerTokenEnv: "CONVERTIGO_MCP_TOKEN",
    gatewayModels: "", gatewayUrl: "", noLog: true, playwrightCommand: "", playwrightEndpoint: "",
    providerNames: "mistral,mistral-direct", revealMode: false, viewerDebugPort: 0 };
  const intent = vibeConfigIntent(base);
  assert.equal(vibeConfigIntent(base), intent, "the same options always produce the same intent");
  assert.match(intent, /^bearerTokenEnv=CONVERTIGO_MCP_TOKEN$/m);
  for (const [field, value] of [["revealMode", true], ["noLog", false], ["endpoint", "http://other/api/mcp"],
    ["viewerDebugPort", 18083], ["playwrightEndpoint", "http://127.0.0.1:9222"], ["gatewayUrl", "https://llm"],
    ["gatewayModels", "glm-5-3"], ["providerNames", "mistral"], ["bearerTokenEnv", "OTHER"]]) {
    const changed = Object.assign({}, base);
    changed[field] = value;
    assert.notEqual(vibeConfigIntent(changed), intent, "changing " + field + " must trigger a rewrite");
  }
  // Only a change to the MCP server entry invalidates the descriptor cache Vibe keyed on it.
  const mcpOf = (value) => vibeConfigIntentSubset(vibeConfigIntent(value), VIBE_CONFIG_MCP_INTENT_KEYS);
  assert.equal(mcpOf(Object.assign({}, base, { gatewayModels: "glm-5-3", providerNames: "mistral" })), mcpOf(base),
    "a model or provider change leaves the cached tool catalog usable");
  assert.notEqual(mcpOf(Object.assign({}, base, { revealMode: true })), mcpOf(base));

  // The reuse check compares booleans on both sides: `"".length && true` is the number 0.
  assert.match(vibeSource, /var expectedRevealMode = !!\(expectedBearerEnv\.length/);
  assert.match(vibeSource, /var expectedNoLog = !!\(expectedBearerEnv\.length/);
  assert.match(vibeSource, /recordedIntent === expectedIntent/);
  assert.match(vibeSource, /mcpEndpointBaseUrl\(setup\.config\.selected\.endpoint\) === mcpEndpointBaseUrl\(expectedEndpoint\)/);
  assert.match(vibeSource, /writeVibeConfigIntent\(setup\.vibeHome, expectedIntent\)/);
  // active_model is deliberately not part of the intent: agent_vibe_start passes an empty model
  // on purpose and sets the session model over ACP, so start and setup would fight over the file.
  assert.match(vibeSource, /model: "",/);
  assert.doesNotMatch(vibeSource, /var expectedIntent = vibeConfigIntent\(\{[^}]*activeModel/);
}

// An agent always needs thinking: `off` is never offered, by any provider or backend.
{
  const acp = [
    { id: "model", currentValue: "mistral-medium-3.5", options: ["mistral-medium-3.5", "vibe-thinking", "local", "glm-5-3"].map(v => ({ value: v, name: v })) },
    { id: "thinking", currentValue: "off", options: ["off", "low", "medium", "high", "max"].map(v => ({ value: v, name: v })) }];
  const offer = normalizeVibeAcpProviderSettings(acp, { id: "vibe", source: {}, supports: {} });
  for (const model of offer.models) {
    assert.ok(model.reasoningLevels.every(l => l.id !== "off" && l.id !== "none"),
      model.id + " must not offer off");
    assert.ok(model.reasoningLevels.some(l => l.id === model.defaultReasoning),
      model.id + " must default to a level it offers, not to " + model.defaultReasoning);
  }
  assert.deepEqual(offer.models[0].reasoningLevels.map(l => l.id), ["low", "medium", "high", "max"]);
  assert.equal(offer.models[0].defaultReasoning, "high", "a catalog sitting on off pre-selects a real level");

  // A catalog restored from the persistent cache, written before this rule existed, is repaired.
  const cached = { id: "vibe", models: [
    { id: "vibe-thinking", defaultReasoning: "off", reasoningLevels: ["off", "low", "high"].map(id => ({ id, label: id })) },
    { id: "no-reasoning", defaultReasoning: "", reasoningLevels: [] }] };
  enforceThinkingReasoningLevels(cached);
  assert.deepEqual(cached.models[0].reasoningLevels.map(l => l.id), ["low", "high"]);
  assert.equal(cached.models[0].defaultReasoning, "low", "off falls back to the weakest offered level");
  assert.deepEqual(cached.models[1].reasoningLevels, [], "a model without reasoning keeps none");
  assert.equal(cached.models[1].defaultReasoning, "", "and is not given one");

  assert.equal(reasoningLevelDisablesThinking("off"), true);
  assert.equal(reasoningLevelDisablesThinking("None"), true);
  assert.equal(reasoningLevelDisablesThinking(""), true);
  assert.equal(reasoningLevelDisablesThinking("minimal"), false, "minimal is the weakest thinking, not its absence");
  assert.equal(reasoningLevelDisablesThinking("low"), false);

  // Codex: whatever the CLI catalog advertises, an off/none level is dropped and minimal kept.
  const codexModels = normalizeCodexModelCatalog({ models: [{ slug: "gpt-x",
    supported_reasoning_levels: [{ id: "none" }, { id: "minimal" }, { id: "low" }, { id: "high" }],
    default_reasoning_level: "none" }] });
  assert.deepEqual(codexModels[0].reasoningLevels.map(l => l.id), ["minimal", "low", "high"]);
  assert.equal(codexModels[0].defaultReasoning, "minimal", "a model defaulting to none starts on the weakest real level");
  // Claude exposes no off-equivalent level at all.
  assert.ok(claudeModelCatalog().every(m => m.reasoningLevels.every(l => !reasoningLevelDisablesThinking(l.id))));

  // A session that arrives on off is clamped up, native backend included.
  const originalAcpRequest = acpRequest;
  const originalPushEvent = pushEvent;
  const originalUpdate = updateVibeProviderSettings;
  const applied = [];
  acpRequest = (_entry, method, params) => { applied.push([method, params.configId, params.value]); return { configOptions: acp }; };
  pushEvent = () => {};
  updateVibeProviderSettings = () => null;
  configureVibeSession({ sessionId: "s-1", configOptions: acp, providerSettings: { id: "vibe" } }, {}, 1000);
  acpRequest = originalAcpRequest;
  pushEvent = originalPushEvent;
  updateVibeProviderSettings = originalUpdate;
  assert.deepEqual(applied, [["session/set_config_option", "thinking", "low"]],
    "a native Vibe session left on off is moved to the weakest remaining level");
}

// The Convertigo rules that survive automatic compactions are appended once to the Vibe AGENTS.md.
{
  const originalFile = File, originalRead = readTextFile, originalWrite = writeTextFile;
  let content = "# Convertigo Vibe Workspace\n\n- For Convertigo tasks, use the `convertigo-vibe-generalist` skill.\n";
  let exists = true, writes = 0;
  File = function () { return { isFile: () => exists }; };
  readTextFile = () => content;
  writeTextFile = (_file, text) => { content = String(text); writes++; };
  try {
    assert.equal(appendVibeCompactionRules("/managed/vibe-home"), "updated");
    assert.match(content, /^# Convertigo Vibe Workspace/);
    assert.match(content, /\n\n## After a context compaction \(Convertigo\)\n/);
    assert.match(content, /databaseobject-tree-get[\s\S]*childrenDepth: 1/);
    assert.match(content, /at:"inside"/);
    assert.equal(appendVibeCompactionRules("/managed/vibe-home"), "unchanged", "never appended twice");
    assert.equal(writes, 1);
    exists = false;
    assert.equal(appendVibeCompactionRules("/managed/vibe-home"), "missing");
  } finally {
    File = originalFile; readTextFile = originalRead; writeTextFile = originalWrite;
  }
  console.log("Vibe compaction rules contract OK");
}

{
  // The model Claude Code answers with (its default when Tigo asks for none) reaches the Assistant with the usage.
  const modelEntry = fakeEntry();
  handleClaudeStreamLine(modelEntry, JSON.stringify({ type: "assistant", message: { id: "mu1", model: "claude-opus-5-5", content: [{ type: "text", text: "ok" }],
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }), "stdout");
  assert.equal(modelEntry._events.find((event) => event.type === "usage/update").data.update._meta.model, "claude-opus-5-5");
  console.log("Claude answering model OK");
}
