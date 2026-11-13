// The agent browser of the Electron Studio. That Studio names the CDP port of its agent browser in the Java system
// property convertigo.studio.cdp.port (the Eclipse Studio never sets it): one browser for the whole Studio, with one page
// that the agent navigates itself. With the property, the managed Playwright MCP of every runtime attaches to
// http://127.0.0.1:<port> instead of the leased per-conversation port, no lease file is written, and the agent
// instructions describe that browser instead of the Studio JxBrowser. Without it (or with a value that is not a port),
// nothing changes.
// node --test tests/electron_agent_browser.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
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
const sandbox = { Packages: javaProxy, context: javaProxy, request: javaProxy, log: javaProxy, C8O: { agentBridge: {} } };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const name of ["common", "codex", "vibe", "claude"]) {
  vm.runInContext(fs.readFileSync(path.join(root, "js", "agent_bridge_" + name + ".js"), "utf8"), sandbox, { filename: "agent_bridge_" + name + ".js" });
}

const PROPERTY = "convertigo.studio.cdp.port";
const AGENT_BROWSER = "http://127.0.0.1:45678";

// The engine JVM: only the property under test, as Rhino gives it (a Java String, or null when absent).
function engine(value) {
  sandbox.System = {
    getProperty: (name) => (name === PROPERTY && value !== undefined ? value : null),
    getenv: () => null,
    currentTimeMillis: () => 0
  };
}

// The endpoint a conversation resolves today, by kind of options.
const ECLIPSE = [
  [{}, ""],
  [{ viewerDebugPort: 41234 }, "http://127.0.0.1:41234"],
  [{ viewerDebugPort: "41234" }, "http://127.0.0.1:41234"],
  [{ viewerDebugPort: 80 }, ""],
  [{ browserDebugUrl: "http://127.0.0.1:9222/json" }, "http://127.0.0.1:9222"],
  [{ playwrightCdpEndpoint: "http://127.0.0.1:9333/" }, "http://127.0.0.1:9333/"],
  [{ browserDevToolsJsonUrl: "http://localhost:9444/json/" }, "http://localhost:9444"],
  [{ viewerDebugPort: 41234, playwrightCdpEndpoint: "http://127.0.0.1:9333" }, "http://127.0.0.1:41234"]
];

test("without the property, a conversation resolves the endpoint it resolves today", () => {
  engine(undefined);
  assert.equal(sandbox.studioAgentBrowserCdpPort(), 0);
  for (const [options, expected] of ECLIPSE) {
    assert.equal(sandbox.resolvePlaywrightMcpCdpEndpoint(options), expected, JSON.stringify(options));
  }
});

test("a value that is not a port is ignored", () => {
  for (const value of ["", "  ", "abc", "80", "1023", "70000", "65536", "-1", "4567.5", "45678x", "0x1F90", "123456"]) {
    engine(value);
    assert.equal(sandbox.studioAgentBrowserCdpPort(), 0, JSON.stringify(value));
    for (const [options, expected] of ECLIPSE) {
      assert.equal(sandbox.resolvePlaywrightMcpCdpEndpoint(options), expected, JSON.stringify(value) + " " + JSON.stringify(options));
    }
  }
  sandbox.System = { getProperty: () => { throw new Error("denied"); } };
  assert.equal(sandbox.studioAgentBrowserCdpPort(), 0, "a property read that throws");
});

test("with the property, every endpoint a conversation resolves is the agent browser", () => {
  for (const value of ["45678", " 45678 "]) {
    engine(value);
    assert.equal(sandbox.studioAgentBrowserCdpPort(), 45678);
    for (const [options, eclipse] of ECLIPSE) {
      // A call that resolves no endpoint (No Code, settings reads, a home without a viewer) still resolves none.
      assert.equal(sandbox.resolvePlaywrightMcpCdpEndpoint(options), eclipse.length ? AGENT_BROWSER : "", JSON.stringify(options));
    }
  }
  // One endpoint for the whole Studio: the endpoint a process started with is the one every later turn requests, so
  // the "needs a fresh process for the current endpoint" checks never fire for it.
  engine("45678");
  const started = sandbox.resolvePlaywrightMcpCdpEndpoint({ viewerDebugPort: 45678 });
  for (const turn of [{ viewerDebugPort: 41234 }, { browserDebugUrl: "http://127.0.0.1:9222/json" }, { playwrightCdpEndpoint: started }]) {
    assert.equal(sandbox.resolvePlaywrightMcpCdpEndpoint(turn), started);
  }
});

test("the viewer port of a conversation is the agent browser port, without a lease", () => {
  const leaseReads = [];
  const leaseFile = sandbox.viewerDebugPortLeaseFile;
  sandbox.viewerDebugPortLeaseFile = (options) => { leaseReads.push(options); return null; };
  try {
    engine(undefined);
    assert.equal(sandbox.ensureManagedViewerDebugPort({ viewerDebugPort: 41234, conversationId: "conv-1" }), 41234);
    assert.equal(sandbox.ensureManagedViewerDebugPort({ conversationId: "conv-1" }), 0, "the stubbed lease file is null");
    assert.equal(leaseReads.length, 1, "without the property, a conversation without a port goes to its lease");

    leaseReads.length = 0;
    engine("45678");
    const conversation = { conversationId: "conv-1" };
    assert.equal(sandbox.ensureManagedViewerDebugPort(conversation), 45678);
    assert.equal(conversation.viewerDebugPort, 45678);
    const leased = { conversationId: "conv-1", viewerDebugPort: 41234 };
    assert.equal(sandbox.ensureManagedViewerDebugPort(leased), 45678, "a requested or leased port has no effect there");
    assert.equal(leased.viewerDebugPort, 45678);
    const noCode = { conversationId: "conv-1", agentProfile: "nocode" };
    assert.equal(sandbox.ensureManagedViewerDebugPort(noCode), 0);
    assert.equal(noCode.viewerDebugPort, undefined);
    const probe = { conversationId: "conv-1", disableViewerDebugPortReservation: true };
    assert.equal(sandbox.ensureManagedViewerDebugPort(probe), 0);
    assert.equal(probe.viewerDebugPort, undefined);
    assert.equal(sandbox.ensureManagedViewerDebugPort({}), 0, "no conversation, no viewer, as with a lease");
    assert.equal(leaseReads.length, 0, "no lease file is read or written");
  } finally {
    sandbox.viewerDebugPortLeaseFile = leaseFile;
  }
});

test("each runtime launches its Playwright MCP on the agent browser", () => {
  class FakeFile {
    constructor(parent, name) { this.p = name === undefined ? String(parent) : String(parent && parent.p ? parent.p : parent) + "/" + String(name); }
    getCanonicalPath() { return this.p; }
    getAbsolutePath() { return this.p; }
    isFile() { return true; }
    isDirectory() { return true; }
    isAbsolute() { return true; }
    exists() { return true; }
    mkdirs() { return true; }
    getParentFile() { return new FakeFile(this.p.replace(/\/[^/]*$/, "")); }
  }
  const saved = {};
  const stub = (name, value) => { saved[name] = sandbox[name]; sandbox[name] = value; };
  stub("File", FakeFile);
  stub("resolveWorkspaceRoot", () => "/ws");
  stub("normalizeDirectory", (value, fallback) => String(value || fallback));
  stub("detectNodeRuntime", () => ({ found: true, path: "/usr/bin/node" }));
  stub("playwrightViewerInitArgs", () => []);
  stub("codexPlaywrightMcpCommand", () => "npx");
  stub("nodeRuntimeSearchPath", () => "");
  stub("applyManagedMcpEnvironment", () => {});
  try {
    // Array.from: an array of the sandbox realm never deep-equals one of this realm.
    const cdpArgs = (args) => Array.from(args.slice(args.indexOf("--cdp-endpoint"), args.indexOf("--cdp-endpoint") + 3));
    for (const [property, viewerDebugPort, expected] of [[undefined, 41234, "http://127.0.0.1:41234"], ["45678", 45678, AGENT_BROWSER], ["45678", 41234, AGENT_BROWSER]]) {
      engine(property);
      const options = { viewerDebugPort, conversationId: "conv-1" };
      const label = JSON.stringify([property, viewerDebugPort]);
      // The provider runtime: the playwright server of convertigo-mcp.json.
      assert.deepEqual(cdpArgs(sandbox.claudePlaywrightServer(options).args), ["--cdp-endpoint", expected, "--shared-browser-context"], "provider runtime " + label);
      // Vibe: the playwright server of config.toml.
      assert.deepEqual(cdpArgs(sandbox.vibePlaywrightServer(options).args), ["--cdp-endpoint", expected, "--shared-browser-context"], "vibe " + label);
      // Codex: config.toml and the process environment.
      assert.deepEqual(cdpArgs(sandbox.codexPlaywrightMcpArgs(options, "/agents/codex")), ["--cdp-endpoint", expected, "--shared-browser-context"], "codex args " + label);
      const config = sandbox.patchCodexPlaywrightMcpConfigText("", options, "/agents/codex").text;
      assert.ok(config.includes('"--cdp-endpoint", "' + expected + '", "--shared-browser-context"'), "codex config " + label);
      assert.match(config, /^enabled = true$/m, "codex config " + label);
      assert.equal(sandbox.codexRuntimeEnv(options, "/home").PLAYWRIGHT_MCP_CDP_ENDPOINT, expected, "codex env " + label);
    }
    // The viewer port travels in the MCP headers as before: the Electron Studio port, and the conversation with it.
    engine("45678");
    const options = { conversationId: "conv-1" };
    sandbox.ensureManagedViewerDebugPort(options);
    const headers = sandbox.vibeConfigMcpHeaderLines(options);
    assert.ok(headers.includes('"X-Convertigo-Viewer-Debug-Port" = "45678"'));
    assert.ok(headers.includes('"X-Convertigo-Conversation-Id" = "conv-1"'));
  } finally {
    for (const name of Object.keys(saved)) {
      sandbox[name] = saved[name];
    }
  }
});

const JXBROWSER_PAGE = /Studio JxBrowser exposes one existing visible page over CDP/;
const AGENT_BROWSER_PAGE = /The Studio agent browser, a dedicated browser window of the Electron Studio, exposes ONE existing page over CDP, `about:blank` until you navigate it\. Reuse that page: navigate it with the Playwright `browser_navigate` tool to the viewer URL \(the `viewerHomeUrl`, else `viewerBaseUrl`, that `mobile-builder-open` returns/;

function assertAgentBrowserWording(text, label) {
  assert.match(text, AGENT_BROWSER_PAGE, label);
  assert.match(text, /Do not open a new tab or page \(not supported\), do not close tabs or the browser, never call `Browser\.close`, and do not drive it with ad hoc `require\('playwright'\)` scripts or raw CDP/, label);
  assert.match(text, /do not wait for `browserDebugPortMatched` or `browserControlReady`/, label);
  assert.doesNotMatch(text, /JxBrowser (exposes|viewer over CDP)/, label);
  assert.doesNotMatch(text, /reports both `browserDebugPortMatched:true` and `browserControlReady:true`/, label);
  assert.doesNotMatch(text, /do not create, open, close, select, or navigate tabs\/pages/, label);
}

test("the agent instructions describe the agent browser only with the property", () => {
  const savedFlow = sandbox.flowCapabilityAvailable;
  sandbox.flowCapabilityAvailable = () => true;
  try {
    const texts = () => ({
      "codex": sandbox.agentSkillInstructions("codex", ""),
      "codex flow": sandbox.agentSkillInstructions("codex", "flow"),
      "vibe": sandbox.agentSkillInstructions("vibe", "generalist"),
      "provider runtime": sandbox.claudeInstructions({ cwd: "/w" }, "generalist"),
      "provider runtime flow": sandbox.claudeFlowInstructions({ cwd: "/w" })
    });
    const noCodeTexts = () => [sandbox.agentSkillInstructions("codex", "nocode"), sandbox.agentSkillInstructions("vibe", "nocode"), sandbox.claudeInstructions({ cwd: "/w" }, "nocode")];

    engine(undefined);
    const eclipse = texts();
    const eclipseNoCode = noCodeTexts();
    for (const [label, text] of Object.entries(eclipse)) {
      assert.match(text, JXBROWSER_PAGE, label);
      assert.doesNotMatch(text, /agent browser/, label);
    }
    engine("not a port");
    assert.deepEqual(texts(), eclipse, "an invalid value keeps the Eclipse instructions");

    engine("45678");
    for (const [label, text] of Object.entries(texts())) {
      assertAgentBrowserWording(text, label);
    }
    assert.match(sandbox.claudeInstructions({ cwd: "/w" }, "generalist"), /They are attached to the Studio agent browser over CDP\./);
    assert.deepEqual(noCodeTexts(), eclipseNoCode, "No Code instructions do not change");
  } finally {
    sandbox.flowCapabilityAvailable = savedFlow;
  }
});

test("a Codex or Vibe turn on the agent browser restates its rules", () => {
  engine(undefined);
  assert.equal(sandbox.withStudioAgentBrowserPrompt("Build the app", "http://127.0.0.1:41234"), "Build the app");
  assert.equal(sandbox.withStudioAgentBrowserPrompt("Build the app", AGENT_BROWSER), "Build the app");

  engine("45678");
  const turn = sandbox.withStudioAgentBrowserPrompt("Build the app", AGENT_BROWSER);
  assert.match(turn, /^Convertigo Studio agent browser for this turn:\n- The managed Playwright MCP tools are attached to the Studio agent browser over CDP\.\n/);
  assertAgentBrowserWording(turn, "turn");
  assert.ok(turn.endsWith("\n\nBuild the app"));
  assert.equal(sandbox.withStudioAgentBrowserPrompt(turn, AGENT_BROWSER), turn, "once per prompt");
  // A conversation without the agent browser (No Code, Playwright off) gets nothing.
  assert.equal(sandbox.withStudioAgentBrowserPrompt("Build the app", ""), "Build the app");
  assert.equal(sandbox.withStudioAgentBrowserPrompt("Build the app", "http://127.0.0.1:41234"), "Build the app");

  // Both Codex turn paths (app-server and exec) and the Vibe turn add it after the reveal-mode note.
  const codex = fs.readFileSync(path.join(root, "js/agent_bridge_codex.js"), "utf8");
  const vibe = fs.readFileSync(path.join(root, "js/agent_bridge_vibe.js"), "utf8");
  assert.equal((codex.match(/withRevealModePrompt\(promptText, entry\.convertigoRevealMode === true\);\n\s*promptText = withStudioAgentBrowserPrompt\(promptText, entry\.playwrightCdpEndpoint\);/g) || []).length, 2);
  assert.equal((vibe.match(/withRevealModePrompt\(promptText, entry\.convertigoRevealMode === true\);\n\s*promptText = withStudioAgentBrowserPrompt\(promptText, entry\.playwrightMcpEnabled === true \? entry\.playwrightCdpEndpoint : ""\);/g) || []).length, 1);
});
