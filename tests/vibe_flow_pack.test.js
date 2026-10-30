// Flow capability pack of a Vibe Studio home: with lib_flow_engine and lib_flow_mcp loaded, config.toml declares the
// `convertigo-flow` MCP server (same engine, token and headers as `Convertigo`), its tool permissions, the three Flow
// skills in enabled_skills and the routing in AGENTS.md; without them, none of it. The session-level `Convertigo`
// server carries the headers config.toml declares (Vibe keeps a session server whole).
// node --test tests/vibe_flow_pack.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
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
const commonSource = fs.readFileSync(path.join(root, "js/agent_bridge_common.js"), "utf8");
const vibeSource = fs.readFileSync(path.join(root, "js/agent_bridge_vibe.js"), "utf8");
vm.runInThisContext(commonSource, { filename: "agent_bridge_common.js" });
tigoVibeServers = () => [];
vibePlaywrightServer = () => null;
flowMcpCatalogRevision = () => "rev123";

const LEGACY = "http://localhost:18080/convertigo/api/mcp";
const FLOW = "http://localhost:18080/convertigo/api/flow-mcp";
const withFlow = (available) => {
  flowCapabilityAvailability = () => ({ available });
};

// The text writeLocalVibeConfig would write, without touching the disk.
function vibeConfig(endpoint, options) {
  const originalWriteTextFile = writeTextFile, originalEnsureDirectory = ensureDirectory;
  let written = "";
  writeTextFile = (file, text) => {
    if (/config\.toml$/.test(String(file && file.getName ? file.getName() : ""))) {
      written = String(text);
    } else if (!written.length && /\[\[mcp_servers\]\]/.test(String(text))) {
      written = String(text);
    }
  };
  ensureDirectory = () => {};
  try {
    writeLocalVibeConfig("/managed/vibe-home", endpoint, "glm-5-3", options || {});
  } finally {
    writeTextFile = originalWriteTextFile;
    ensureDirectory = originalEnsureDirectory;
  }
  return written;
}

// [[mcp_servers]] blocks of a config by name, each with its nested tables.
function serverBlocks(text) {
  const blocks = {};
  for (const block of String(text).split(/\n(?=\[\[mcp_servers\]\])/)) {
    const name = /^\[\[mcp_servers\]\][\s\S]*?\nname = "([^"]+)"/.exec(block);
    if (name) {
      blocks[name[1]] = block.split(/\n(?=\[tools\.)/)[0];
    }
  }
  return blocks;
}

test("a Studio home with the Flow projects declares the convertigo-flow server beside Convertigo", () => {
  withFlow(true);
  const options = { viewerDebugPort: 45991, conversationId: "agent-1", mcpBearerToken: "secret-managed-jwt", agentRevealMode: "true" };
  const text = vibeConfig(LEGACY, options);
  const blocks = serverBlocks(text);
  assert.deepEqual(Object.keys(blocks), ["Convertigo", "convertigo-flow"]);
  const flow = blocks["convertigo-flow"];
  assert.match(flow, /^url = "http:\/\/localhost:18080\/convertigo\/api\/flow-mcp\?toolsRevision=rev123"$/m);
  assert.match(flow, /^transport = "http"$/m);
  assert.match(flow, /^tool_timeout_sec = 600\.0$/m);
  assert.match(flow, /\[mcp_servers\.auth\]\ntype = "static"\napi_key_env = "CONVERTIGO_MCP_TOKEN"\napi_key_header = "Authorization"\napi_key_format = "Bearer \{token\}"/);
  assert.match(flow, /"X-Convertigo-Viewer-Debug-Port" = "45991"/);
  assert.match(flow, /"X-Convertigo-Conversation-Id" = "agent-1"/);
  assert.match(flow, /"X-Convertigo-Reveal-Mode" = "true"/);
  assert.match(flow, /"X-Convertigo-No-Log" = "true"/);
  assert.match(flow, /"X-Convertigo-Guidance-Version" = "2026-09-04\.vibe-serial-transport-v1"/);
  // same auth and headers as the Legacy server, which gets its guidance version from _setupVibe
  const legacyHeaders = /\[mcp_servers\.auth\.headers\]\n([\s\S]*?)\n*$/.exec(blocks.Convertigo)[1];
  assert.match(legacyHeaders, /X-Convertigo-No-Log/);
  assert.ok(flow.indexOf(legacyHeaders) >= 0, "the Flow server repeats every header of the Convertigo server");
  assert.match(blocks.Convertigo, /^url = "http:\/\/localhost:18080\/convertigo\/api\/mcp\?jsonOnly=false&from_bridge=true/m);
  assert.doesNotMatch(text, /secret-managed-jwt/, "the token stays in the process environment");
});

test("without the Flow projects, or in No Code, the home has no Flow server", () => {
  withFlow(false);
  const without = vibeConfig(LEGACY, { viewerDebugPort: 45991, conversationId: "agent-1" });
  assert.deepEqual(Object.keys(serverBlocks(without)), ["Convertigo"]);
  assert.doesNotMatch(without, /convertigo-flow|flow-mcp/);
  withFlow(true);
  const noCode = vibeConfig(LEGACY, { skillProfile: "nocode", userId: "alice", conversationId: "agent-2" });
  assert.doesNotMatch(noCode, /convertigo-flow|flow-mcp/);
  assert.equal(vibeExpectedFlowMcpUrl("https://example.test/unrelated-mcp", {}), "", "never for an endpoint that is not the Convertigo MCP");
  withFlow(false);
});

test("the Convertigo server of a Studio home always stays on the Legacy MCP", () => {
  withFlow(true);
  assert.equal(vibeLegacyMcpEndpoint(FLOW), LEGACY);
  assert.equal(vibeLegacyMcpEndpoint(LEGACY + "?jsonOnly=true"), LEGACY + "?jsonOnly=true");
  assert.equal(vibeFlowMcpEndpoint(LEGACY + "?jsonOnly=true", {}), FLOW);
  const blocks = serverBlocks(vibeConfig(FLOW, { userId: "studio" }));
  assert.match(blocks.Convertigo, /^url = "http:\/\/localhost:18080\/convertigo\/api\/mcp\?/m);
  assert.match(blocks["convertigo-flow"], /^url = "http:\/\/localhost:18080\/convertigo\/api\/flow-mcp\?toolsRevision=rev123"$/m);
  assert.match(buildMcpServers(FLOW, { userId: "studio" })[0].url, /\/api\/mcp\?/);
  withFlow(false);
});

test("a Flow conversation (flow profile) gets one MCP facade: convertigo-flow only", () => {
  withFlow(true);
  const options = { agentProfile: "flow", userId: "studio", viewerDebugPort: 45991, conversationId: "agent-9", mcpBearerToken: "secret-jwt" };
  assert.equal(vibeFlowFacade(LEGACY, options), true);
  assert.equal(vibeFlowFacade(LEGACY, { userId: "studio" }), false, "a Studio conversation keeps both servers");
  const text = vibeConfig(LEGACY, options);
  const blocks = serverBlocks(text);
  assert.deepEqual(Object.keys(blocks), ["convertigo-flow"], "no Convertigo server");
  assert.match(blocks["convertigo-flow"], /api_key_env = "CONVERTIGO_MCP_TOKEN"/);
  assert.match(blocks["convertigo-flow"], /"X-Convertigo-No-Log" = "true"/);
  assert.match(blocks["convertigo-flow"], /"X-Convertigo-Conversation-Id" = "agent-9"/);
  assert.doesNotMatch(text, /name = "Convertigo"|secret-jwt/);
  assert.deepEqual(buildMcpServers(LEGACY, options), [], "no session server: it would replace the config entry whole");
  withFlow(false);
  assert.equal(vibeFlowFacade(LEGACY, options), false, "without Flow on the engine, the profile falls back");
  assert.deepEqual(Object.keys(serverBlocks(vibeConfig(LEGACY, options))), ["Convertigo"]);
});

test("a Flow-only config.toml enables the Flow skills only and allows the built-in tools", () => {
  const bare = '# Generated\nactive_model = "glm-5-3"\n\n[[mcp_servers]]\nname = "convertigo-flow"\n';
  const merged = mergeVibeFlowPackConfig(bare, true, true);
  assert.ok(merged.startsWith('enabled_skills = ["convertigo-flow-mcp", "convertigo-flow-backend", "convertigo-flow-frontend-svelte"]\n'));
  for (const tool of ["skill", "read", "grep", "bash", "write_file", "edit"]) {
    assert.match(merged, new RegExp("\\[tools\\." + tool + '\\]\npermission = "always"'), tool);
  }
  assert.match(merged, /\[tools\.convertigo-flow_project-save\]/);
  assert.equal(mergeVibeFlowPackConfig(merged, true, true), merged, "idempotent");
  const legacy = mergeVibeFlowPackConfig(VIBE_REWRITTEN, true, true);
  assert.match(legacy, /^enabled_skills = \["convertigo-flow-mcp", "convertigo-flow-backend", "convertigo-flow-frontend-svelte"\]$/m,
    "the Legacy skill of an earlier profile of the home is no longer enabled");
  assert.equal(legacy.split("[tools.skill]").length, 2, "an existing permission is not repeated");
});

test("a Flow-only Vibe home is read back as valid, with its headers", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-flow-only-"));
  const file = path.join(dir, "config.toml");
  const saved = { readTextFile };
  readTextFile = (f) => fs.readFileSync(f.p, "utf8");
  try {
    withFlow(true);
    fs.writeFileSync(file, vibeConfig(LEGACY, { agentProfile: "flow", userId: "studio", viewerDebugPort: 45991, conversationId: "agent-9" }));
    const info = inspectVibeConfig(new FakeFile(file));
    assert.equal(info.valid, true);
    assert.equal(info.flowOnly, true);
    assert.equal(info.hasConvertigoServer, false);
    assert.equal(info.endpoint, "");
    assert.equal(info.flowEndpoint, FLOW + "?toolsRevision=rev123");
    assert.equal(info.bearerTokenEnv, "CONVERTIGO_MCP_TOKEN");
    assert.equal(info.viewerDebugPort, 45991);
    assert.equal(info.conversationId, "agent-9");
    assert.equal(info.noLog, true);
    // re-serialized by Vibe: bare header keys
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/"(X-Convertigo-[A-Za-z-]+)"/g, "$1"));
    assert.equal(inspectVibeConfig(new FakeFile(file)).noLog, true);
  } finally {
    readTextFile = saved.readTextFile;
    withFlow(false);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed call of a Flow tool counts as a lost MCP, as a Convertigo one", () => {
  const failure = { code: Object.keys(VIBE_MCP_LOST_CODES)[0] };
  assert.equal(vibeMcpLostReason("mcp_convertigo_flow.project_save", failure, null), "convertigo_mcp_suspended");
  assert.equal(vibeMcpLostReason("convertigo-flow_project-save", failure, null), "convertigo_mcp_suspended");
  assert.equal(vibeMcpLostReason("mcp_Convertigo.project_save", failure, null), "convertigo_mcp_suspended");
  assert.equal(vibeMcpLostReason("mcp_playwright.browser_click", failure, null), "");
});

const VIBE_REWRITTEN = [
  "enabled_skills = [",
  '    "convertigo-vibe-generalist",',
  "]",
  'active_model = "glm-5-3"',
  "",
  "[[mcp_servers]]",
  'name = "Convertigo"',
  "",
  "[tools.skill]",
  'permission = "always"',
  "",
  "[tools.Convertigo_project-list]",
  'permission = "always"',
  ""
].join("\n");

test("the Flow tools and skills are added to config.toml, idempotently, and removed without Flow", () => {
  const added = mergeVibeFlowPackConfig(VIBE_REWRITTEN, true);
  assert.match(added, /^enabled_skills = \["convertigo-vibe-generalist", "convertigo-flow-mcp", "convertigo-flow-backend", "convertigo-flow-frontend-svelte"\]$/m);
  for (const tool of VIBE_FLOW_TOOL_NAMES) {
    assert.ok(added.indexOf("[tools.convertigo-flow_" + tool + ']\npermission = "always"') >= 0, tool);
  }
  assert.ok(VIBE_FLOW_TOOL_NAMES.indexOf("flow-catalog") >= 0 && VIBE_FLOW_TOOL_NAMES.length >= 60);
  assert.match(added, /\[tools\.Convertigo_project-list\]/, "the Legacy permissions are kept");
  assert.equal(mergeVibeFlowPackConfig(added, true), added, "idempotent");
  // Vibe re-serializes the file: a multi-line list and a quoted table name read the same
  const reserialized = added
    .replace(/^enabled_skills = \[.*\]$/m, 'enabled_skills = [\n    "convertigo-vibe-generalist",\n    "convertigo-flow-mcp",\n    "convertigo-flow-backend",\n    "convertigo-flow-frontend-svelte",\n]')
    .replace("[tools.convertigo-flow_flow-catalog]", '[tools."convertigo-flow_flow-catalog"]');
  assert.equal(mergeVibeFlowPackConfig(reserialized, true), reserialized);
  const removed = mergeVibeFlowPackConfig(reserialized, false);
  assert.doesNotMatch(removed, /convertigo-flow/);
  assert.match(removed, /^enabled_skills = \["convertigo-vibe-generalist"\]$/m);
  assert.match(removed, /\[tools\.Convertigo_project-list\]\npermission = "always"/);
  assert.equal(mergeVibeFlowPackConfig(VIBE_REWRITTEN, false), VIBE_REWRITTEN, "a home without Flow is left as it is");
});

test("AGENTS.md routes between both servers before the compaction rules, idempotently", () => {
  const agents = "# Convertigo Vibe Workspace\n\n- For Convertigo tasks, use the `convertigo-vibe-generalist` skill.\n\n" + VIBE_COMPACTION_RULES;
  const routed = mergeVibeStudioRouting(agents, true);
  assert.match(routed, /Both the `Convertigo` \(Legacy\) and `convertigo-flow` \(Flow\) MCP servers are installed/);
  assert.match(routed, /explicit user request for Flow, FlowScript, or Flow Svelte wins: use the `convertigo-flow-mcp` skill/);
  assert.ok(routed.indexOf(VIBE_STUDIO_ROUTING_HEADING) < routed.indexOf(VIBE_COMPACTION_RULES_HEADING));
  assert.equal(mergeVibeStudioRouting(routed, true), routed, "idempotent");
  assert.equal(mergeVibeStudioRouting(routed, false), agents.replace(/\s+$/, "") + "\n");
  assert.equal(mergeVibeStudioRouting(agents, false), agents);
  const appended = mergeVibeStudioRouting("# Workspace\n", true);
  assert.equal(mergeVibeStudioRouting(appended, true), appended);
  assert.equal(mergeVibeStudioRouting(appended, false), "# Workspace\n");
});

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
  listFiles() { return this.isDirectory() ? fs.readdirSync(this.p).map((name) => new FakeFile(this, name)) : null; }
  mkdirs() { fs.mkdirSync(this.p, { recursive: true }); return true; }
  delete() {
    if (this.isDirectory()) { fs.rmdirSync(this.p); } else { fs.unlinkSync(this.p); }
    return true;
  }
}

test("syncVibeFlowPack installs the three Flow skills with the pack and removes them without Flow", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-flow-pack-"));
  const home = path.join(dir, ".vibe-home");
  const sources = path.join(dir, "lib_flow_mcp/_flow/resources/skills");
  for (const slug of VIBE_FLOW_SKILL_SLUGS) {
    fs.mkdirSync(path.join(sources, slug), { recursive: true });
    fs.writeFileSync(path.join(sources, slug, "SKILL.md"), "---\nname: " + slug + "\n---\n");
  }
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "config.toml"), VIBE_REWRITTEN);
  fs.writeFileSync(path.join(home, "AGENTS.md"), "# Convertigo Vibe Workspace\n");
  const saved = { File, readTextFile, writeTextFile, ensureDirectory, flowSkillSourceFile };
  File = FakeFile;
  readTextFile = (file) => (file.exists() ? fs.readFileSync(file.p, "utf8") : "");
  writeTextFile = (file, text) => { fs.mkdirSync(path.dirname(file.p), { recursive: true }); fs.writeFileSync(file.p, String(text)); };
  ensureDirectory = (file) => fs.mkdirSync(file.p, { recursive: true });
  flowSkillSourceFile = (_options, slug) => new FakeFile(sources, slug + "/SKILL.md");
  try {
    withFlow(true);
    const ok = () => ({ ok: true, copied: [], generated: [], reused: [], warnings: [], message: "legacy" });
    const installed = syncVibeFlowPack({}, new FakeFile(home), LEGACY, ok());
    assert.equal(installed.ok, true, installed.error);
    assert.equal(installed.flowPackStatus, "installed");
    assert.equal(installed.resolvedFlowMcpUrl, FLOW + "?toolsRevision=rev123");
    for (const slug of VIBE_FLOW_SKILL_SLUGS) {
      assert.equal(fs.readFileSync(path.join(home, "skills", slug, "SKILL.md"), "utf8"), "---\nname: " + slug + "\n---\n");
    }
    const config = fs.readFileSync(path.join(home, "config.toml"), "utf8");
    assert.match(config, /"convertigo-flow-frontend-svelte"\]/);
    assert.match(config, /\[tools\.convertigo-flow_flow-catalog\]/);
    assert.match(fs.readFileSync(path.join(home, "AGENTS.md"), "utf8"), /convertigo-flow` \(Flow\) MCP servers are installed/);
    assert.equal(syncVibeFlowPack({}, new FakeFile(home), LEGACY, ok()).generated.length, 0, "a current home is left alone");
    assert.equal(syncVibeFlowPack({}, new FakeFile(home), LEGACY, { ok: false }).flowPackStatus, undefined, "nothing after a failed Legacy setup");

    withFlow(false);
    const cleaned = syncVibeFlowPack({}, new FakeFile(home), LEGACY, ok());
    assert.equal(cleaned.ok, true, cleaned.error);
    assert.equal(cleaned.flowPackStatus, "removed");
    for (const slug of VIBE_FLOW_SKILL_SLUGS) {
      assert.equal(fs.existsSync(path.join(home, "skills", slug)), false, slug);
    }
    assert.doesNotMatch(fs.readFileSync(path.join(home, "config.toml"), "utf8"), /convertigo-flow/);
    assert.doesNotMatch(fs.readFileSync(path.join(home, "AGENTS.md"), "utf8"), /convertigo-flow/);

    withFlow(true);
    flowSkillSourceFile = () => null;
    const missing = syncVibeFlowPack({}, new FakeFile(home), LEGACY, ok());
    assert.equal(missing.ok, false, "a Flow pack without its skills is a configuration error, as for Codex");
    assert.match(missing.error, /Missing Flow skill source/);
  } finally {
    File = saved.File;
    readTextFile = saved.readTextFile;
    writeTextFile = saved.writeTextFile;
    ensureDirectory = saved.ensureDirectory;
    flowSkillSourceFile = saved.flowSkillSourceFile;
    withFlow(false);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("config.toml is read back with its Flow server url", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-flow-config-"));
  const file = path.join(dir, "config.toml");
  const saved = { readTextFile };
  readTextFile = (f) => fs.readFileSync(f.p, "utf8");
  try {
    withFlow(true);
    fs.writeFileSync(file, vibeConfig(LEGACY, { viewerDebugPort: 45991, conversationId: "agent-1" }));
    const info = inspectVibeConfig(new FakeFile(file));
    assert.equal(info.valid, true);
    assert.equal(info.flowEndpoint, FLOW + "?toolsRevision=rev123");
    assert.match(info.endpoint, /\/api\/mcp\?/);
    assert.equal(info.noLog, true);
    withFlow(false);
    fs.writeFileSync(file, vibeConfig(LEGACY, {}));
    assert.equal(inspectVibeConfig(new FakeFile(file)).flowEndpoint, "");
  } finally {
    readTextFile = saved.readTextFile;
    withFlow(false);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the reuse check of a Vibe home covers the Flow server", () => {
  assert.equal(VIBE_CONFIG_MCP_INTENT_KEYS.flowEndpoint, true, "a Flow server change drops the descriptor cache");
  assert.match(vibeSource, /var expectedFlowEndpoint = vibeExpectedFlowMcpUrl\(setup\.mcpEndpoint, options\);/);
  assert.match(vibeSource, /if \(expectedFlowEndpoint\.length\) \{\s*intentFields\.flowEndpoint = expectedFlowEndpoint;/);
  assert.match(vibeSource, /mcpEndpointBaseUrl\(setup\.config\.selected\.flowEndpoint\) === mcpEndpointBaseUrl\(expectedFlowEndpoint\)/);
  assert.match(vibeSource, /var expectedEndpoint = vibeFlowFacade\(setup\.mcpEndpoint, options\)\s*\?\s*""\s*:\s*vibeMcpTransportEndpoint\(vibeLegacyMcpEndpoint\(setup\.mcpEndpoint\), options\);/);
  // a home written before the pack (no flowEndpoint line) differs from one with the pack, and not from one without
  const before = vibeConfigIntent({ endpoint: "e", noLog: true });
  assert.notEqual(vibeConfigIntent({ endpoint: "e", noLog: true, flowEndpoint: FLOW }), before);
  assert.notEqual(
    vibeConfigIntentSubset(vibeConfigIntent({ endpoint: "e", flowEndpoint: FLOW }), VIBE_CONFIG_MCP_INTENT_KEYS),
    vibeConfigIntentSubset(before, VIBE_CONFIG_MCP_INTENT_KEYS)
  );
});

test("the session-level Convertigo server carries No-Log, Reveal and the guidance version; Flow stays in config.toml", () => {
  withFlow(true);
  const named = (headers, name) => headers.filter((h) => h.name === name).map((h) => h.value);
  const servers = buildMcpServers(LEGACY, { mcpBearerToken: "jwt", agentRevealMode: "true", viewerDebugPort: 45991, conversationId: "agent-1" });
  assert.deepEqual(servers.map((s) => s.name), ["Convertigo"], "a session server would replace the Flow entry of config.toml whole");
  const headers = servers[0].headers;
  assert.deepEqual(named(headers, "X-Convertigo-No-Log"), ["true"]);
  assert.deepEqual(named(headers, "X-Convertigo-Reveal-Mode"), ["true"]);
  assert.deepEqual(named(headers, "X-Convertigo-Guidance-Version"), ["2026-09-04.vibe-serial-transport-v1"]);
  assert.deepEqual(named(headers, "X-Convertigo-Viewer-Debug-Port"), ["45991"]);
  assert.deepEqual(named(headers, "X-Convertigo-Conversation-Id"), ["agent-1"]);
  assert.deepEqual(named(buildMcpServers(LEGACY, { mcpNoLog: "false" })[0].headers, "X-Convertigo-No-Log"), []);
  assert.deepEqual(named(buildMcpServers(LEGACY, {})[0].headers, "X-Convertigo-Reveal-Mode"), []);
  assert.deepEqual(buildMcpServers("https://example.test/unrelated-mcp", { mcpBearerToken: "jwt" })[0].headers, []);
  withFlow(false);
});

test("a Studio home gets the Legacy setup then the Flow pack; a Flow conversation gets the Flow-only home", () => {
  const saved = { setupVibeFromMcpProject, syncVibeFlowPack, setupVibeFlowFacadeHome };
  const calls = [];
  setupVibeFromMcpProject = (_options, _home, endpoint) => {
    calls.push(["legacy", endpoint]);
    return { ok: true, copied: [], generated: [], reused: [], warnings: [] };
  };
  syncVibeFlowPack = (_options, _home, endpoint, report) => {
    calls.push(["flow", endpoint]);
    report.flowPackStatus = "installed";
    return report;
  };
  setupVibeFlowFacadeHome = (_options, _home, endpoint) => {
    calls.push(["facade", endpoint]);
    return { ok: true, flowPackStatus: "installed", flowFacade: true };
  };
  try {
    withFlow(true);
    const report = installAgentSkills({ agentProfile: "flow", userId: "studio", mcpEndpoint: FLOW }, "vibe", "/managed/vibe-home");
    assert.equal(report.ok, true);
    assert.equal(report.flowFacade, true);
    assert.deepEqual(calls, [["facade", FLOW]], "a Flow conversation does not run the Legacy setup");
    calls.length = 0;
    installAgentSkills({ userId: "studio", mcpEndpoint: LEGACY }, "convertigo", "/managed/vibe-home");
    assert.deepEqual(calls, [["legacy", LEGACY], ["flow", LEGACY]], "the gateway (convertigo) profile takes the same path");
    assert.deepEqual(agentCapabilityProfile({ agentProfile: "flow", userId: "studio" }).supportedProviders, ["codex", "vibe"]);
  } finally {
    setupVibeFromMcpProject = saved.setupVibeFromMcpProject;
    syncVibeFlowPack = saved.syncVibeFlowPack;
    setupVibeFlowFacadeHome = saved.setupVibeFlowFacadeHome;
    withFlow(false);
  }
});

test("the Flow-only home gets its AGENTS.md, the Flow skills and the Flow pack", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-flow-facade-"));
  const home = path.join(dir, ".vibe-home");
  const sources = path.join(dir, "skills");
  for (const slug of VIBE_FLOW_SKILL_SLUGS) {
    fs.mkdirSync(path.join(sources, slug), { recursive: true });
    fs.writeFileSync(path.join(sources, slug, "SKILL.md"), "---\nname: " + slug + "\n---\n");
  }
  const saved = { File, readTextFile, writeTextFile, ensureDirectory, flowSkillSourceFile, installVibePlanSyncHook };
  File = FakeFile;
  readTextFile = (file) => (file.exists() ? fs.readFileSync(file.p, "utf8") : "");
  writeTextFile = (file, text) => { fs.mkdirSync(path.dirname(file.p), { recursive: true }); fs.writeFileSync(file.p, String(text)); };
  ensureDirectory = (file) => fs.mkdirSync(file.p, { recursive: true });
  flowSkillSourceFile = (_options, slug) => new FakeFile(sources, slug + "/SKILL.md");
  installVibePlanSyncHook = () => "updated";
  try {
    withFlow(true);
    const options = { agentProfile: "flow", userId: "studio" };
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "config.toml"), vibeConfig(LEGACY, options));
    const report = setupVibeFlowFacadeHome(options, new FakeFile(home), LEGACY);
    assert.equal(report.ok, true, report.error);
    assert.equal(report.flowFacade, true);
    assert.equal(report.resolvedMcpUrl, FLOW);
    const agents = fs.readFileSync(path.join(home, "AGENTS.md"), "utf8");
    assert.match(agents, /Its one Convertigo MCP server is `convertigo-flow`/);
    assert.match(agents, /flow-resource-get` and its `uri`/);
    assert.doesNotMatch(agents, /convertigo-vibe-generalist|databaseobject-tree-apply|NGX pages load/, "no Legacy guidance");
    for (const slug of VIBE_FLOW_SKILL_SLUGS) {
      assert.ok(fs.existsSync(path.join(home, "skills", slug, "SKILL.md")), slug);
    }
    const config = fs.readFileSync(path.join(home, "config.toml"), "utf8");
    assert.match(config, /^enabled_skills = \["convertigo-flow-mcp", "convertigo-flow-backend", "convertigo-flow-frontend-svelte"\]$/m);
    assert.match(config, /\[tools\.bash\]\npermission = "always"/);
    assert.doesNotMatch(config, /name = "Convertigo"/);
    const again = setupVibeFlowFacadeHome(options, new FakeFile(home), LEGACY);
    assert.equal(again.generated.filter((entry) => !/hooks\.toml/.test(entry)).length, 0, "a current home is left alone: " + again.generated);
  } finally {
    File = saved.File;
    readTextFile = saved.readTextFile;
    writeTextFile = saved.writeTextFile;
    ensureDirectory = saved.ensureDirectory;
    flowSkillSourceFile = saved.flowSkillSourceFile;
    installVibePlanSyncHook = saved.installVibePlanSyncHook;
    withFlow(false);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
