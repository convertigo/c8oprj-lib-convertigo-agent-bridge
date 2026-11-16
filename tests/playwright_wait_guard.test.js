// The Playwright MCP guard. browser_wait_for takes `time` in seconds and stops at 30: Mistral Large 4 passed
// milliseconds ({time: 2500}) and waited 30 s each time (71 waits, 35 min of a 95-min run). Every Playwright MCP server
// of a managed runtime starts through node/playwright_guard.cjs, a stdio MCP proxy that reads a time from 100 up as
// milliseconds, caps it at 30 and says "seconds" in the tools/list answer; everything else goes through unchanged.
// node --test tests/playwright_wait_guard.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const GUARD = path.join(root, "node", "playwright_guard.cjs");
const guard = require(GUARD);

const call = (name, args, id = 1) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const sentArgs = (line) => JSON.parse(line).params.arguments;

test("time: milliseconds are read as seconds, any wait stops at 30", () => {
  for (const [given, expected] of [[2500, 2.5], [45, 30], [3, 3], [30000, 30], [30, 30], [0.5, 0.5], [100, 0.1], [99, 30], [-2, 0], [0, 0]]) {
    assert.equal(guard.waitSeconds(given), expected, String(given));
    assert.equal(sentArgs(guard.rewriteClientLine(call("browser_wait_for", { time: given }))).time, expected, String(given));
  }
  // not a number: left to the server's own validation
  const text = call("browser_wait_for", { time: "2500" });
  assert.equal(guard.rewriteClientLine(text), text);
});

test("tools/call: only browser_wait_for, its namespaced names, and nothing but its time", () => {
  const textOnly = call("browser_wait_for", { text: "Saved" });
  assert.equal(guard.rewriteClientLine(textOnly), textOnly, "text only: byte for byte");
  const gone = call("browser_wait_for", { textGone: "Loading", time: 2 });
  assert.equal(guard.rewriteClientLine(gone), gone, "a time in seconds: byte for byte");
  assert.deepEqual(sentArgs(guard.rewriteClientLine(call("browser_wait_for", { text: "Saved", time: 5000 }))), { text: "Saved", time: 5 }, "text kept, its timeout in seconds");
  for (const name of ["mcp__playwright__browser_wait_for", "playwright_browser_wait_for", "playwright.browser_wait_for"]) {
    assert.equal(sentArgs(guard.rewriteClientLine(call(name, { time: 2500 }))).time, 2.5, name);
  }
  for (const name of ["browser_navigate", "xbrowser_wait_for", "browser_wait_for_x", "browser_evaluate"]) {
    const other = call(name, { time: 2500, url: "http://127.0.0.1/" });
    assert.equal(guard.rewriteClientLine(other), other, name + " is untouched");
  }
  for (const line of ["not json browser_wait_for", '{"jsonrpc":"2.0","method":"notifications/initialized"}', ""]) {
    assert.equal(guard.rewriteClientLine(line), line);
  }
  // a JSON-RPC batch
  const batch = JSON.parse(guard.rewriteClientLine("[" + call("browser_wait_for", { time: 2500 }, 1) + "," + call("browser_click", { time: 2500 }, 2) + "]"));
  assert.equal(batch[0].params.arguments.time, 2.5);
  assert.equal(batch[1].params.arguments.time, 2500);
});

test("tools/list: the time of browser_wait_for says seconds, at most 30, e.g. 2 (not 2000); the other tools are untouched", () => {
  const navigate = { name: "browser_navigate", description: "Navigate", inputSchema: { type: "object", properties: { url: { type: "string", description: "The URL" } } } };
  const wait = { name: "browser_wait_for", description: "Wait for text", inputSchema: { type: "object", properties: {
    time: { type: "number", description: "The time to wait in seconds, at most 30." }, text: { type: "string", description: "The text to wait for" } } } };
  const answer = JSON.stringify({ jsonrpc: "2.0", id: 7, result: { tools: [navigate, wait] } });
  const rewritten = guard.rewriteServerLine(answer);
  const tools = JSON.parse(rewritten).result.tools;
  assert.equal(tools[1].inputSchema.properties.time.description, "In seconds, not milliseconds: at most 30, e.g. 2 for two seconds (not 2000). The time to wait in seconds, at most 30.");
  assert.match(tools[1].inputSchema.properties.time.description, /seconds.*at most 30.*e\.g\. 2 .*\(not 2000\)/);
  assert.deepEqual(tools[0], navigate);
  assert.deepEqual(tools[1].inputSchema.properties.text, wait.inputSchema.properties.text);
  assert.equal(tools[1].description, wait.description);
  assert.equal(guard.rewriteServerLine(rewritten), rewritten, "said once");
  // results of the other calls go through byte for byte, even when they name the tool
  const result = JSON.stringify({ jsonrpc: "2.0", id: 8, result: { content: [{ type: "text", text: "await browser_wait_for(2500)" }] } });
  assert.equal(guard.rewriteServerLine(result), result);
  // a request of the server with a tools list is not an answer
  const request = JSON.stringify({ jsonrpc: "2.0", id: 9, method: "sampling/createMessage", result: { tools: [wait] } });
  assert.equal(guard.rewriteServerLine(request), request);
});

const FAKE_SERVER = `
process.stdin.setEncoding("utf8");
let buf = "";
process.stderr.write("fake server stderr\\n");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let at;
  while ((at = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, at); buf = buf.slice(at + 1);
    const m = JSON.parse(line);
    if (m.method === "exit") { process.stdout.write("", () => process.exit(m.params.code)); return; }
    if (m.method === "tools/list") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "browser_wait_for", inputSchema: { type: "object", properties: { time: { type: "number", description: "The time to wait in seconds" } } } }] } }) + "\\n");
      continue;
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { echo: m.params, raw: line } }) + "\\n");
  }
});
process.stdin.on("end", () => process.exit(0));
`;

function startGuard(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playwright-guard-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const server = path.join(dir, "server.cjs");
  fs.writeFileSync(server, FAKE_SERVER);
  const child = spawn(process.execPath, [GUARD, "--", process.execPath, server], { stdio: ["pipe", "pipe", "pipe"] });
  const out = { stdout: "", stderr: "", lines: [] };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    out.stdout += chunk;
    out.lines = out.stdout.split("\n").slice(0, -1).map((line) => JSON.parse(line));
  });
  child.stderr.on("data", (chunk) => { out.stderr += chunk; });
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  return { child, out, exited };
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("the proxy process: rewrites the wait, passes the rest through, keeps stderr and the exit code", async (t) => {
  const { child, out, exited } = startGuard(t);
  const big = "x".repeat(1 << 20);
  const navigate = call("browser_navigate", { url: "http://127.0.0.1/" + big }, 3);
  child.stdin.write(call("browser_wait_for", { time: 2500 }, 1) + "\n");
  // one message split over several writes
  const text = call("browser_wait_for", { text: "Saved" }, 2) + "\n";
  child.stdin.write(text.slice(0, 10));
  await pause(20);
  child.stdin.write(text.slice(10, 40));
  await pause(20);
  child.stdin.write(text.slice(40));
  child.stdin.write(navigate + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" }) + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "exit", params: { code: 3 } }) + "\n");
  const { code } = await exited;
  assert.equal(code, 3, "the exit code of the server");
  const byId = Object.fromEntries(out.lines.map((line) => [line.id, line]));
  assert.deepEqual(byId[1].result.echo.arguments, { time: 2.5 });
  assert.equal(byId[2].result.raw, text.slice(0, -1), "an untouched call reaches the server byte for byte");
  assert.equal(byId[3].result.raw, navigate, "a 1 MB message goes through unchanged");
  assert.match(byId[4].result.tools[0].inputSchema.properties.time.description, /^In seconds, not milliseconds: at most 30, e\.g\. 2 for two seconds \(not 2000\)\./);
  assert.match(out.stderr, /fake server stderr/, "the server's stderr");
  assert.match(out.stderr, /browser_wait_for time 2500 -> 2\.5 s/);
});

test("the proxy process: closing its stdin closes the server's; a missing command exits 127", async (t) => {
  const { child, exited } = startGuard(t);
  child.stdin.end();
  assert.deepEqual(await exited, { code: 0, signal: null });
  const missing = spawn(process.execPath, [GUARD, "--", path.join(os.tmpdir(), "no-such-playwright-mcp")], { stdio: ["pipe", "pipe", "pipe"] });
  const result = await new Promise((resolve) => missing.on("exit", (code) => resolve(code)));
  assert.equal(result, 127);
});

test("the proxy process: a signal reaches the server and ends the proxy the same way", { skip: process.platform === "win32" }, async (t) => {
  const { child, out, exited } = startGuard(t);
  while (!/fake server stderr/.test(out.stderr)) {
    await pause(10);
  }
  child.kill("SIGTERM");
  assert.deepEqual(await exited, { code: null, signal: "SIGTERM" });
});

// --- Wiring: each runtime starts its Playwright MCP through the guard ---

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
  apply() { return javaProxy; },
  construct() { return javaProxy; }
});
const sandbox = { Packages: javaProxy, context: javaProxy, request: javaProxy, log: javaProxy, C8O: { agentBridge: {} } };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const name of ["common", "codex", "vibe", "claude"]) {
  vm.runInContext(fs.readFileSync(path.join(root, "js", "agent_bridge_" + name + ".js"), "utf8"), sandbox, { filename: "agent_bridge_" + name + ".js" });
}

// A File on the real disk for the project folder (so the shipped guard is looked up where the Bridge ships it), and
// existing for everything else (the managed runtimes of the stubs).
class FakeFile {
  constructor(parent, name) { this.p = name === undefined ? String(parent) : String(parent && parent.p ? parent.p : parent) + "/" + String(name); }
  getCanonicalPath() { return this.p; }
  getAbsolutePath() { return this.p; }
  getName() { return this.p.replace(/^.*\//, ""); }
  isFile() { return this.p.startsWith(root + "/") ? fs.existsSync(this.p) && fs.statSync(this.p).isFile() : !/\/missing\//.test(this.p); }
  isDirectory() { return true; }
  isAbsolute() { return true; }
  exists() { return this.isFile(); }
  mkdirs() { return true; }
  getParentFile() { return new FakeFile(this.p.replace(/\/[^/]*$/, "")); }
}

const COPY = "/ws/agents/guard/playwright-mcp-guard.cjs";

function wired(t, overrides = {}) {
  const saved = {};
  const stub = (name, value) => { saved[name] = sandbox[name]; sandbox[name] = value; };
  const copies = [];
  stub("File", FakeFile);
  stub("System", { getProperty: (name) => (name === "os.name" ? (overrides.os || "Mac OS X") : null), getenv: () => null, currentTimeMillis: () => 0 });
  stub("resolveWorkspaceRoot", () => "/ws");
  stub("agentsDirectory", () => new FakeFile("/ws/agents"));
  stub("normalizeDirectory", (value, fallback) => String(value || fallback));
  stub("projectDirectoryByName", (name) => (name === "lib_ConvertigoAgentBridge" ? new FakeFile(overrides.bridgeDir || root) : null));
  stub("readTextFile", (file) => fs.readFileSync(file.p, "utf8"));
  stub("writeFileIfChanged", (file, text) => { copies.push({ path: file.p, text }); return true; });
  stub("detectNodeRuntime", () => ({ found: true, path: "/usr/bin/node" }));
  stub("playwrightViewerInitArgs", () => []);
  stub("codexPlaywrightMcpCommand", () => overrides.npx || "/agents/codex/npm/bin/npx");
  stub("nodeRuntimeSearchPath", () => "");
  stub("applyManagedMcpEnvironment", () => {});
  stub("resolvePlaywrightMcpCdpEndpoint", () => "http://127.0.0.1:45678");
  t.after(() => { for (const name of Object.keys(saved)) sandbox[name] = saved[name]; });
  return copies;
}

const options = () => ({ viewerDebugPort: 45678, conversationId: "conv-1" });
const VIEWER = ["--cdp-endpoint", "http://127.0.0.1:45678", "--shared-browser-context"];

test("Vibe, the provider runtime and Codex start Playwright MCP through the guard", (t) => {
  const copies = wired(t);
  const guarded = (args, real) => {
    assert.deepEqual(Array.from(args.slice(0, 3)), [COPY, "--", real]);
    assert.deepEqual(Array.from(args.slice(args.indexOf("--cdp-endpoint"), args.indexOf("--cdp-endpoint") + 3)), VIEWER, "the viewer args are kept");
  };
  // Vibe: node <guard> -- node <cli.js> ... in config.toml, and the intent records the guard
  const vibe = sandbox.vibePlaywrightServer(options());
  assert.equal(vibe.command, "/usr/bin/node");
  assert.equal(vibe.guarded, true);
  guarded(vibe.args, "/usr/bin/node");
  assert.equal(vibe.args[3], "/ws/agents/vibe/npm/node_modules/@playwright/mcp/cli.js");
  let toml = "";
  const savedWrite = sandbox.writeTextFile, savedEnsure = sandbox.ensureDirectory;
  sandbox.writeTextFile = (_file, value) => { toml = String(value); };
  sandbox.ensureDirectory = () => {};
  try {
    sandbox.writeLocalVibeConfig("/managed/vibe-home", "http://localhost:18080/convertigo/api/mcp", "glm-5-3", Object.assign(options(), { vibeProfile: "mistral", model: "glm-5-3" }));
  } finally {
    sandbox.writeTextFile = savedWrite;
    sandbox.ensureDirectory = savedEnsure;
  }
  assert.match(toml, /name = "playwright"\ntransport = "stdio"\n[^[]*command = \[\s*"\/usr\/bin\/node",?\s*\]\nargs = \[\s*"\/ws\/agents\/guard\/playwright-mcp-guard\.cjs",\s*"--",\s*"\/usr\/bin\/node",/);
  assert.equal(sandbox.VIBE_CONFIG_MCP_INTENT_KEYS.playwrightGuard, true, "a guard change rewrites the playwright entry and prunes its descriptor cache");
  assert.match(fs.readFileSync(path.join(root, "js", "agent_bridge_vibe.js"), "utf8"),
    /if \(expectedPlaywright !== null && expectedPlaywright\.guarded === true\) \{\n\s*intentFields\.playwrightGuard = PLAYWRIGHT_MCP_GUARD_REVISION;/);

  // the provider runtime: the playwright server of convertigo-mcp.json
  const claude = sandbox.claudePlaywrightServer(options());
  assert.equal(claude.type, "stdio");
  assert.equal(claude.command, "/usr/bin/node");
  guarded(claude.args, "/usr/bin/node");
  assert.equal(claude.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD, "1");
  assert.equal(claude.guarded, undefined, "only command, args and env go into the file");

  // Codex: [mcp_servers.playwright] of config.toml, through the npx it used before
  const codex = sandbox.patchCodexPlaywrightMcpConfigText("", Object.assign(options(), { codexHomeScope: "conversation" }), "/agents/codex").text;
  assert.match(codex, /^command = "\/agents\/codex\/npm\/bin\/node"$/m, "the node beside npx runs the guard");
  assert.ok(codex.includes('args = ["' + COPY + '", "--", "/agents/codex/npm/bin/npx", "--prefix", '), codex);
  assert.ok(codex.includes('"--cdp-endpoint", "http://127.0.0.1:45678", "--shared-browser-context"'));
  assert.match(codex, /^enabled = true$/m);
  // a disabled server is written as before
  const disabled = sandbox.patchCodexPlaywrightMcpConfigText("", Object.assign(options(), { codexHomeScope: "conversation", playwrightMcpEnabled: "false" }), "/agents/codex").text;
  assert.match(disabled, /^command = "\/agents\/codex\/npm\/bin\/npx"$/m);

  // the guard each one runs is the shipped one
  assert.ok(copies.length >= 3);
  for (const copy of copies) {
    assert.equal(copy.path, COPY);
    assert.equal(copy.text, fs.readFileSync(GUARD, "utf8"));
  }
});

test("without the shipped guard, on a Windows .cmd launcher, or switched off, Playwright MCP starts as before", (t) => {
  const unguarded = { command: "/usr/bin/node", args: ["/ws/agents/vibe/npm/node_modules/@playwright/mcp/cli.js"].concat(VIEWER) };
  {
    const copies = wired(t, { bridgeDir: "/missing/lib_ConvertigoAgentBridge" });
    assert.deepEqual(JSON.parse(JSON.stringify(sandbox.vibePlaywrightServer(options()))), unguarded);
    const claude = sandbox.claudePlaywrightServer(options());
    assert.deepEqual([claude.command, Array.from(claude.args)], ["/usr/bin/node", ["/ws/agents/claude/npm/node_modules/@playwright/mcp/cli.js"].concat(VIEWER)]);
    const codex = sandbox.patchCodexPlaywrightMcpConfigText("", Object.assign(options(), { codexHomeScope: "conversation" }), "/agents/codex").text;
    assert.match(codex, /^command = "\/agents\/codex\/npm\/bin\/npx"$/m);
    assert.ok(codex.includes('args = ["--prefix", '));
    assert.equal(copies.length, 0);
  }
  {
    wired(t, { os: "Windows 11", npx: "C:\\Studio\\nodes\\npx.cmd" });
    const launch = { command: "C:\\Studio\\nodes\\npx.cmd", args: ["--prefix", "x", "playwright-mcp"] };
    assert.equal(sandbox.playwrightMcpGuardedLaunch(options(), launch), launch, "Node spawns a .cmd only through a shell");
  }
  {
    wired(t);
    const launch = { command: "/usr/bin/node", args: ["cli.js"] };
    assert.equal(sandbox.playwrightMcpGuardedLaunch(Object.assign(options(), { playwrightMcpGuard: "false" }), launch), launch);
    assert.equal(sandbox.playwrightMcpGuardedLaunch(Object.assign(options(), { playwrightMcpGuard: false }), launch), launch);
    assert.deepEqual(Array.from(sandbox.playwrightMcpGuardedLaunch(options(), launch).args), [COPY, "--", "/usr/bin/node", "cli.js"]);
  }
});
