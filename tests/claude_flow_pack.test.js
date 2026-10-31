// Flow capability pack of a Claude conversation of the `flow` profile: its convertigo-mcp.json declares the
// `convertigo-flow` server (same auth and headers as the Legacy `convertigo` server, guidance version included) and
// Playwright only, its home has the three Flow skills only, and its CLAUDE.md the Flow routing and the rules to reload
// after a compaction. A Studio (generalist) Claude conversation keeps the Legacy server and skills; Codex and Vibe keep
// their homes.
// node --test tests/claude_flow_pack.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
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

const root = path.resolve(__dirname, "..");
for (const file of ["agent_bridge_common.js", "agent_bridge_codex.js", "agent_bridge_vibe.js", "agent_bridge_claude.js"]) {
  vm.runInThisContext(fs.readFileSync(path.join(root, "js", file), "utf8"), { filename: file });
}
const claudeSource = fs.readFileSync(path.join(root, "js/agent_bridge_claude.js"), "utf8");
// The Studio engine the endpoints of each profile derive from.
engineConvertigoBaseUrl = () => "http://localhost:18080/convertigo";

const LEGACY = "http://localhost:18080/convertigo/api/mcp";
const FLOW = "http://localhost:18080/convertigo/api/flow-mcp";
const FLOW_SKILLS = ["convertigo-flow-mcp", "convertigo-flow-backend", "convertigo-flow-frontend-svelte"];
const STUDIO_SKILLS = ["convertigo-studio", "convertigo-generalist", "convertigo-nocode"];
const withFlow = (available) => {
  flowCapabilityAvailability = () => ({ available });
};
// A Studio Claude conversation: the viewer port claudeStart leases, reveal mode, the conversation.
const conversation = (extra) => Object.assign({ userId: "studio", viewerDebugPort: 45991, conversationId: "agent-7", agentRevealMode: "true" }, extra || {});

// java.io.File over a real temporary folder.
class FakeFile {
  constructor(parent, child) {
    const base = parent instanceof FakeFile ? parent.p : String(parent);
    this.p = child === undefined ? base : path.join(base, String(child));
  }
  exists() { return fs.existsSync(this.p); }
  isFile() { return fs.existsSync(this.p) && fs.statSync(this.p).isFile(); }
  isDirectory() { return fs.existsSync(this.p) && fs.statSync(this.p).isDirectory(); }
  getName() { return path.basename(this.p); }
  getParentFile() { return new FakeFile(path.dirname(this.p)); }
  getCanonicalPath() { return this.p; }
  getAbsolutePath() { return this.p; }
  isAbsolute() { return path.isAbsolute(this.p); }
  listFiles() { return this.isDirectory() ? fs.readdirSync(this.p).map((name) => new FakeFile(this, name)) : null; }
  mkdirs() { fs.mkdirSync(this.p, { recursive: true }); return true; }
  delete() {
    if (this.isDirectory()) { fs.rmdirSync(this.p); } else { fs.unlinkSync(this.p); }
    return true;
  }
}

// A temporary Claude home and Flow skill sources, with the Java file helpers on the real disk.
function withHome(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-flow-pack-"));
  const home = path.join(dir, "claude-home");
  const sources = path.join(dir, "lib_flow_mcp/_flow/resources/skills");
  for (const slug of FLOW_SKILLS) {
    fs.mkdirSync(path.join(sources, slug), { recursive: true });
    fs.writeFileSync(path.join(sources, slug, "SKILL.md"), "---\nname: " + slug + "\n---\n");
  }
  fs.mkdirSync(home, { recursive: true });
  const names = ["File", "readTextFile", "writeTextFile", "ensureDirectory", "flowSkillSourceFile", "sha256File",
    "hashShort",
    "syncClaudeCredentials", "claudeCredentialSourceDirs", "claudePlaywrightServer", "setupClaudeFromMcpProject", "copyFileBinary"];
  const saved = {};
  for (const name of names) {
    saved[name] = globalThis[name];
  }
  File = FakeFile;
  readTextFile = (file) => (file.isFile() ? fs.readFileSync(file.p, "utf8") : "");
  writeTextFile = (file, text) => { fs.mkdirSync(path.dirname(file.p), { recursive: true }); fs.writeFileSync(file.p, String(text)); };
  ensureDirectory = (file) => fs.mkdirSync(file.p, { recursive: true });
  flowSkillSourceFile = (_options, slug) => new FakeFile(sources, slug + "/SKILL.md");
  sha256File = (file) => crypto.createHash("sha256").update(fs.readFileSync(file.p)).digest("hex");
  hashShort = (text) => crypto.createHash("sha256").update(String(text)).digest("hex").substring(0, 12);
  syncClaudeCredentials = () => {};
  claudeCredentialSourceDirs = () => [];
  copyFileBinary = (source, target) => { fs.mkdirSync(path.dirname(target.p), { recursive: true }); fs.copyFileSync(source.p, target.p); };
  // The Playwright server of a conversation with a viewer port, without the package installed in a workspace.
  claudePlaywrightServer = (options) => (claudePlaywrightEnabled(options)
    ? { type: "stdio", command: "playwright-mcp", args: ["--cdp-endpoint", resolvePlaywrightMcpCdpEndpoint(options), "--shared-browser-context"], env: { PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" } }
    : null);
  // lib_ConvertigoMCP._setupClaude of a Studio home: the Legacy skill, as the sequence writes it.
  setupClaudeFromMcpProject = (_options, claudeHome) => {
    writeTextFile(new FakeFile(claudeHome, "skills/convertigo-generalist/SKILL.md"), "---\nname: convertigo-generalist\n---\n");
    return { attempted: true, ok: true, skillStatus: "created", skillPath: "", warnings: [], source: "lib_ConvertigoMCP._setupClaude", message: "Convertigo Generalist skill synchronized" };
  };
  try {
    withFlow(true);
    return run({ dir, home, sources });
  } finally {
    for (const name of names) {
      globalThis[name] = saved[name];
    }
    withFlow(false);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// What claudeSetup writes in a conversation home: bootstrap (convertigo-mcp.json, CLAUDE.md), then the skills.
function prepareHome(home, options) {
  const bootstrap = bootstrapClaudeHome(options, home, resolveMcpEndpoint(options));
  assert.equal(bootstrap.ok, true, bootstrap.error);
  const skills = installAgentSkills(options, "claude", home);
  assert.equal(skills.ok, true, skills.error);
  return {
    bootstrap,
    skills,
    config: JSON.parse(fs.readFileSync(path.join(home, "convertigo-mcp.json"), "utf8")),
    instructions: fs.readFileSync(path.join(home, "CLAUDE.md"), "utf8"),
    skillDirs: fs.existsSync(path.join(home, "skills")) ? fs.readdirSync(path.join(home, "skills")).sort() : []
  };
}

test("a Claude conversation of the flow profile declares convertigo-flow and Playwright only", () => {
  withHome(({ home }) => {
    const options = conversation({ agentProfile: "flow", mcpEndpoint: FLOW });
    assert.equal(claudeFlowFacade(options), true);
    const { config, bootstrap } = prepareHome(home, options);
    assert.match(bootstrap.message, /Flow/);
    assert.deepEqual(Object.keys(config.mcpServers), ["convertigo-flow", "playwright"], "no Legacy convertigo server");
    const flow = config.mcpServers["convertigo-flow"];
    assert.equal(flow.type, "http");
    assert.equal(flow.url, FLOW + "?jsonOnly=true");
    assert.deepEqual(flow.headers, {
      "X-Convertigo-Guidance-Version": mcpProjectGuidanceVersion(),
      "X-Convertigo-Agent-Provider": "claude",
      Authorization: "Bearer ${CONVERTIGO_MCP_TOKEN}",
      "X-Convertigo-Reveal-Mode": "true",
      "X-Convertigo-No-Log": "true",
      "X-Convertigo-Viewer-Debug-Port": "45991"
    });
    // the same auth and headers as the Legacy server of a Studio conversation with the same options
    const legacy = buildClaudeMcpConfig(LEGACY, copyOptionsWithProfile(conversation(), "generalist"), home).mcpServers.convertigo;
    assert.deepEqual(flow.headers, legacy.headers);
    assert.deepEqual(config.mcpServers.playwright.args, ["--cdp-endpoint", "http://127.0.0.1:45991", "--shared-browser-context"]);
    assert.doesNotMatch(JSON.stringify(config), /eyJ|secret/, "the token stays in the process environment");
    // the Legacy endpoint the Assistant may pass resolves to the Flow one, and the setup check reads the Flow server
    const fromLegacy = prepareHome(home, conversation({ agentProfile: "flow", mcpEndpoint: LEGACY }));
    assert.equal(fromLegacy.config.mcpServers["convertigo-flow"].url, FLOW + "?jsonOnly=true");
    const inspected = inspectClaudeMcpConfig(home, options);
    assert.equal(inspected.ok, true);
    assert.equal(inspected.managedServerName, "convertigo-flow");
    assert.equal(inspected.hasFlow, true);
    assert.equal(inspected.hasLegacy, false);
    assert.equal(inspected.hasPlaywright, true);
    assert.equal(inspectClaudeMcpConfig(home, conversation()).ok, false, "a Studio conversation would miss its convertigo server");
  });
});

test("a Claude Flow home has the three Flow skills only; a Studio home gets its skills back without them", () => {
  withHome(({ home }) => {
    for (const slug of STUDIO_SKILLS) {
      writeTextFile(new FakeFile(home, "skills/" + slug + "/SKILL.md"), "---\nname: " + slug + "\n---\n");
    }
    const options = conversation({ agentProfile: "flow" });
    const flow = prepareHome(home, options);
    assert.deepEqual(flow.skillDirs, FLOW_SKILLS.slice().sort(), "the Studio and No Code skills of an earlier profile are removed");
    for (const slug of FLOW_SKILLS) {
      assert.equal(fs.readFileSync(path.join(home, "skills", slug, "SKILL.md"), "utf8"), "---\nname: " + slug + "\n---\n", slug);
    }
    assert.equal(flow.skills.flowFacade, true);
    assert.equal(flow.skills.skillPath, path.join(home, "skills/convertigo-flow-mcp/SKILL.md"));
    assert.deepEqual(flow.skills.removed.sort(), STUDIO_SKILLS.map((slug) => "skills/" + slug).sort());
    assert.deepEqual(flow.skills.bundle.slugs, FLOW_SKILLS);
    assert.equal(flow.skills.bundle.ready, true);
    assert.equal(installAgentSkills(options, "claude", home).copied.length, 0, "a current home is left alone");

    const studio = prepareHome(home, conversation());
    assert.deepEqual(studio.skillDirs, ["convertigo-generalist", "convertigo-studio"]);
    assert.deepEqual(studio.skills.removed, FLOW_SKILLS.map((slug) => "skills/" + slug));
    assert.deepEqual(Object.keys(studio.config.mcpServers), ["convertigo", "playwright"]);
    assert.equal(studio.config.mcpServers.convertigo.url, LEGACY + "?jsonOnly=true");

    flowSkillSourceFile = () => null;
    const missing = installAgentSkills(options, "claude", home);
    assert.equal(missing.ok, false, "a Flow pack without its skills is a configuration error, as for Codex and Vibe");
    assert.match(missing.error, /Missing Flow skill source/);
  });
});

test("the CLAUDE.md of a Flow conversation routes to the Flow skills and keeps the rules to reload after a compaction", () => {
  withHome(({ home }) => {
    const { instructions } = prepareHome(home, conversation({ agentProfile: "flow", cwd: "/ws" }));
    assert.match(instructions, /^# Convertigo Agent Instructions \(Flow\)$/m);
    assert.match(instructions, /Its one Convertigo MCP server is `convertigo-flow` \(tools named `mcp__convertigo-flow__\*`\)/);
    assert.match(instructions, /relayed \(`project-save`, `project-list`, `log-view`, `requestable-execute`, `scheduler-\*`/);
    assert.match(instructions, /Invoke the `convertigo-flow-mcp` skill first, then the `convertigo-flow-backend` or `convertigo-flow-frontend-svelte`/);
    assert.match(instructions, /Legacy Convertigo or NGX authoring is not available in this conversation/);
    assert.match(instructions, /as an MCP resource of the `convertigo-flow` server; `flow-resource-get`/);
    assert.match(instructions, /`frontend-svelte-action` with `actionId:"dev\.open"` reports `browserControlReady:true`/);
    assert.match(instructions, /mcp__playwright__browser_snapshot/);
    assert.match(instructions, /Keep the plan in the project's `docs\/generated\/PROGRESS\.md`/);
    assert.match(instructions, /TaskCreate and TaskUpdate are optional/);
    assert.match(instructions, /A sub-agent, which may not have them, does not look for them/);
    assert.doesNotMatch(instructions, /Keep the TaskCreate\/TaskUpdate plan current/, "the plan never depends on host task tools");
    assert.match(instructions.substring(instructions.indexOf("\n## After a context compaction (Convertigo Flow)\n")), /plan of `docs\/generated\/PROGRESS\.md` current/);
    const routing = instructions.indexOf("\n## Convertigo Flow routing\n");
    const compaction = instructions.indexOf("\n## After a context compaction (Convertigo Flow)\n");
    assert.ok(routing > 0 && compaction > routing, "routing, then the compaction rules");
    assert.match(instructions.substring(compaction), /Reload the `convertigo-flow-mcp` skill and the specialist skill of the task, read the project's `docs\/generated\/PROGRESS\.md`/);
    assert.match(instructions.substring(compaction), /code-get/);
    assert.doesNotMatch(instructions, /convertigo-generalist|convertigo-studio|mobile-builder-open|databaseobject-tree-apply/, "no Legacy guidance");
    // The CLAUDE.md of a Claude home, not only the shared skill text, says that a viewer download raises no Playwright event.
    for (const text of [instructions, claudeInstructions(conversation({ cwd: "/ws" }), "generalist")]) {
      assert.match(text, /`page\.waitForEvent\('download'\)` never fires there: click, then wait for the file to appear in `[^`]*\/\.playwright-mcp\/downloads\/`/);
    }

    const studio = prepareHome(home, conversation({ cwd: "/ws" })).instructions;
    assert.equal(studio, claudeInstructions(conversation({ cwd: "/ws" }), "generalist"));
    assert.match(studio, /Invoke the `convertigo-studio` skill first, then the `convertigo-generalist` skill/);
    assert.doesNotMatch(studio, /convertigo-flow/);
  });
});

test("only the flow profile gets the pack: Studio and No Code Claude conversations, and engines without Flow, keep theirs", () => {
  withFlow(true);
  assert.equal(claudeFlowFacade(conversation()), false);
  assert.equal(claudeFlowFacade({ agentProfile: "flow", userId: "alice@example.test" }), false, "a No Code identity never gets Flow");
  assert.deepEqual(managedSkillBundleSlugs(conversation({ agentProfile: "flow" }), "claude"), FLOW_SKILLS);
  assert.deepEqual(managedSkillBundleSlugs(conversation(), "claude"), ["convertigo-studio", "convertigo-generalist"]);
  assert.deepEqual(managedSkillBundleSlugs({ agentProfile: "nocode", userId: "alice@example.test" }, "claude"), ["convertigo-nocode"]);
  assert.deepEqual(agentCapabilityProfile({ agentProfile: "flow", userId: "studio" }).supportedProviders, ["codex", "vibe", "claude"]);
  assert.match(claudeSource, /var profileSupported = capabilityProfile\.supportedProviders\.indexOf\("claude"\) >= 0;/);
  // Codex and Vibe homes are not facades of this kind: a Studio home with both packs, whatever the profile
  for (const provider of ["codex", "vibe"]) {
    assert.deepEqual(managedSkillBundleSlugs(conversation({ agentProfile: "flow" }), provider),
      ["convertigo-studio", "convertigo-generalist"].concat(FLOW_SKILLS), provider);
  }
  withFlow(false);
  assert.equal(claudeFlowFacade(conversation({ agentProfile: "flow" })), false, "without Flow on the engine the profile falls back");
  assert.deepEqual(managedSkillBundleSlugs(conversation({ agentProfile: "flow" }), "claude"), ["convertigo-studio", "convertigo-generalist"]);
  assert.deepEqual(Object.keys(buildClaudeMcpConfig(LEGACY, copyOptionsWithProfile(conversation({ agentProfile: "flow" }), "generalist"), "").mcpServers), ["convertigo"]);
});

// A fake resident Claude Code process for the stream-json handlers.
function fakeEntry(extra) {
  const events = [];
  const written = [];
  return Object.assign({
    handle: "claude-flow",
    provider: "claude",
    protocol: "claude-stream-json",
    status: "running",
    phase: "turn",
    sessionId: "",
    nextIndex: 0,
    firstIndex: 0,
    lastAccess: 0,
    lastError: "",
    process: { isAlive: () => true },
    credentials: { policy: "scoped-home", sources: [], injectedKeys: [] },
    writer: { write(text) { written.push(JSON.parse(text)); }, newLine() {}, flush() {} },
    events: { add(event) { events.push(event); }, size() { return events.length; }, remove() { events.shift(); } },
    _events: events,
    _written: written
  }, extra || {});
}

test("the Flow and Playwright tools run without a permission request, as the Convertigo ones", () => {
  const command = claudeCommand({ claudePath: "/managed/claude", mcpConfigFile: "/home/convertigo-mcp.json", workspaceRoot: "/ws", cwd: "/ws" }, {});
  assert.equal(command[command.indexOf("--permission-mode") + 1], "bypassPermissions");
  assert.ok(command.indexOf("--dangerously-skip-permissions") > 0);
  assert.equal(command[command.indexOf("--mcp-config") + 1], "/home/convertigo-mcp.json");
  assert.ok(command.indexOf("--strict-mcp-config") > 0, "only the servers of convertigo-mcp.json");
  for (const tool of ["mcp__convertigo-flow__project-save", "mcp__playwright__browser_click"]) {
    const entry = fakeEntry();
    claudeHandleControlRequest(entry, { type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: tool, input: { project: "P" } } });
    assert.deepEqual(entry._written[0].response.response, { behavior: "allow", updatedInput: { project: "P" } }, tool);
  }
  assert.equal(claudeToolTitle("mcp__convertigo-flow__code-get"), "convertigo-flow.code-get");
});

test("a Flow server that does not connect stops the turn, as the Convertigo one", () => {
  const saved = stopEntry;
  const stopped = [];
  stopEntry = (entry) => { stopped.push(entry.handle); };
  try {
    const entry = fakeEntry();
    handleClaudeStreamLine(entry, JSON.stringify({ type: "system", subtype: "init", session_id: "s1", mcp_servers: [
      { name: "convertigo-flow", status: "failed" }, { name: "playwright", status: "connected" }], tools: [] }), "stdout");
    const error = entry._events.find((event) => event.type === "turn/error");
    assert.equal(error.data.error.subtype, "mcp_unavailable");
    assert.deepEqual(error.data.error.servers, ["convertigo-flow:failed"]);
    assert.equal(entry.status, "error");
    assert.deepEqual(stopped, ["claude-flow"]);
  } finally {
    stopEntry = saved;
  }
});

test("a prompt of a Flow conversation keeps its Flow skill bundle though the Assistant names no profile", () => {
  withHome(({ home }) => {
    const options = conversation({ agentProfile: "flow" });
    const { skills } = prepareHome(home, options);
    const entry = fakeEntry({
      status: "completed",
      phase: "completed",
      home: { path: home },
      agentProfile: "flow",
      skillProfile: "flow",
      userId: "studio",
      mcpEndpoint: FLOW,
      managedSkillBundle: skills.bundle,
      managedSkillBundleFingerprint: skills.bundle.fingerprint,
      nextRequestId: 1
    });
    const saved = { getRegistry, statusOf };
    getRegistry = () => ({ get: () => entry, put() {}, remove() {} });
    statusOf = () => ({});
    try {
      // the prompt payload of lib_ConvertigoAssistant for Claude, with what bridgeCall adds
      const result = C8O.agentBridge.claudePrompt({ handle: "claude-flow", prompt: "Build the page", userId: "studio", conversationId: "agent-7" });
      assert.equal(result.ok, true, result.error);
      assert.equal(result.status, "submitted", "no restart");
      assert.deepEqual(entry.managedSkillBundle.slugs, FLOW_SKILLS);
      assert.equal(entry.managedSkillBundleFingerprint, skills.bundle.fingerprint);
      const sent = entry._written[entry._written.length - 1].message.content[0].text;
      assert.match(sent, /Current Convertigo MCP endpoint: http:\/\/localhost:18080\/convertigo\/api\/flow-mcp\./);
      assert.doesNotMatch(sent, /convertigo-generalist|convertigo-studio/);
    } finally {
      getRegistry = saved.getRegistry;
      statusOf = saved.statusOf;
    }
  });
});

test("the gateway home of a conversation follows the skills of its managed home", () => {
  withHome(({ dir, home }) => {
    prepareHome(home, conversation({ agentProfile: "flow" }));
    const gateway = path.join(dir, "claude-home-gateway");
    writeTextFile(new FakeFile(gateway, "skills/convertigo-generalist/SKILL.md"), "stale");
    assert.equal(claudeGatewayHome(home), gateway);
    assert.deepEqual(fs.readdirSync(path.join(gateway, "skills")).sort(), FLOW_SKILLS.slice().sort());
    assert.equal(fs.readFileSync(path.join(gateway, "CLAUDE.md"), "utf8"), fs.readFileSync(path.join(home, "CLAUDE.md"), "utf8"));
  });
});
