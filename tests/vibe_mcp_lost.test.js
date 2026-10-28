// A Vibe session that lost the Convertigo MCP: an HTTP 401 of the MCP during a call makes Vibe suspend the server for the
// session. Up to Vibe 3.0.2 every later call failed with a refusal of its Rust core, and the model tried again 52 times
// in 6 minutes (feedback group 3681d23e, Studio 8.4.6, 28/10); from 3.0.3 the calls fail with mcp_authorization_required,
// then mcp_unknown_route. The failure shapes below are those of vibe-acp 3.0.2 and 3.0.3 on a bench MCP answering 401.
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
const threads = [];
function FakeThread(runnable, name) {
  this.runnable = runnable;
  this.name = name;
  this.setDaemon = () => {};
  this.start = () => threads.push(this);
}
FakeThread.sleep = () => {};
const packages = new Proxy({}, {
  get(_target, property) {
    if (property !== "java") {
      return javaProxy;
    }
    return new Proxy({}, {
      get(_t, pkg) {
        if (pkg !== "lang") {
          return javaProxy;
        }
        return new Proxy({}, {
          get(_l, name) {
            if (name === "Thread") {
              return FakeThread;
            }
            if (name === "Runnable") {
              return function (body) { return body; };
            }
            return javaProxy;
          }
        });
      }
    });
  }
});
const sandbox = { Packages: packages, context: javaProxy, request: javaProxy, log: javaProxy, C8O: { agentBridge: {} } };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, "js/agent_bridge_common.js"), "utf8"), sandbox, { filename: "agent_bridge_common.js" });
const stopped = [];
sandbox.processAlive = () => true;
sandbox.stopEntry = (entry) => { stopped.push(entry.handle); sandbox.pushEvent(entry, "system/closed", { handle: entry.handle }); };

function fakeEntry() {
  const events = [];
  const written = [];
  return {
    handle: "vibe-test", provider: "vibe", protocol: "acp", status: "running", sessionId: "s1",
    nextIndex: 0, firstIndex: 0, lastAccess: 0, lastError: "", process: {}, pending: new Map(),
    writer: { write(text) { written.push(String(text)); }, newLine() {}, flush() {} },
    events: { add(event) { events.push(event); }, size() { return events.length; }, remove() { events.shift(); } },
    _events: events, _written: written
  };
}

const update = (body) => JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: body } });
const REFUSAL = "Core rejected durable input: RustRejectedApplyResult(type='rejected', rejection=RustInvalidStateRejection("
  + "code='invalid_state', command_type='reconfigure', state='running'))";
const start = (id, title) => update({ sessionUpdate: "tool_call", toolCallId: id, title: title || "mcp_Convertigo.databaseobject_tree_get", status: "in_progress" });
const failed = (id, code, message) => update({ sessionUpdate: "tool_call_update", toolCallId: id, status: "failed",
  rawOutput: { type: "failure", content: [], error: { code, message: message || "The provided tool call failed", retryable: false } } });
const refused = (id) => failed(id, "effect_recovery_failed", REFUSAL);
const completed = (id) => update({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", rawOutput: { type: "success" } });
const warnings = (entry) => entry._events.filter((event) => event.type === "warning").map((event) => event.data.reason);
const play = (entry, lines) => lines.forEach((line) => sandbox.handleAcpLine(entry, line, "stdout"));

test("a refusal of the core is read from a failed update, whatever field carries it", () => {
  assert.deepEqual({ ...sandbox.vibeCoreRefusal({ rawOutput: { error: { message: REFUSAL } } }) }, {
    rejection: "invalid_state", code: "invalid_state", commandType: "reconfigure", state: "running",
    repr: REFUSAL.substring(REFUSAL.indexOf("RustRejectedApplyResult"))
  });
  const inContent = sandbox.vibeCoreRefusal({ content: [{ type: "content", content: { type: "text", text: "ToolError: " + REFUSAL } }] });
  assert.equal(inContent.commandType, "reconfigure");
  const command = sandbox.vibeCoreRefusal("Core rejected durable input: RustRejectedApplyResult(type='rejected', rejection="
    + "RustInvalidCommandRejection(code='invalid_command', error=RustProtocolError(code='bad', message='x')))");
  assert.equal(command.rejection, "invalid_command");
  assert.equal(command.code, "invalid_command", "the rejection's own code, not its error's");
  assert.equal(sandbox.vibeCoreRefusal({ rawOutput: { error: { code: "mcp_timeout", message: "The provided tool call failed" } } }), null);
});

test("Vibe 3.0.2: the first refusal marks the process, the third in a row ends the turn, an unanswered cancel stops it", () => {
  threads.length = 0;
  stopped.length = 0;
  const entry = fakeEntry();
  sandbox.pushEvent(entry, "turn/start", { requestId: 7 });
  play(entry, [start("effect-1"), completed("effect-1"), start("effect-2"), refused("effect-2")]);
  assert.equal(entry.restartReason, "core_rejected_input", "the process keeps the Convertigo MCP lost");
  assert.equal(entry.restartDetail.commandType, "reconfigure");
  assert.deepEqual(warnings(entry), ["core_rejected_input"]);
  assert.equal(entry._events.filter((event) => event.type === "tool/update")[1].data.coreRefusal.state, "running");
  play(entry, [start("effect-3", "bash: ls"), completed("effect-3")]);
  assert.equal(entry.mcpLostFailures, 0, "a call that went through resets the count");
  play(entry, [start("effect-4"), refused("effect-4"), start("effect-5"), refused("effect-5")]);
  assert.equal(entry._written.length, 0);
  play(entry, [start("effect-6"), refused("effect-6")]);
  assert.deepEqual(warnings(entry), ["core_rejected_input", "mcp_lost_turn_stopped"]);
  assert.match(entry._written.join(""), /"method":"session\/cancel"/);
  assert.ok(entry._events.some((event) => event.type === "turn/interrupt_requested" && event.data.reason === "mcp_lost"));
  play(entry, [start("effect-7"), refused("effect-7")]);
  assert.equal(threads.length, 1, "one stop per streak");
  assert.equal((entry._written.join("").match(/session\/cancel/g) || []).length, 1);

  threads[0].runnable.run();
  assert.deepEqual(stopped, ["vibe-test"], "the turn still ran after the grace delay");
  assert.equal(entry.turnActive, false);
  assert.ok(warnings(entry).includes("mcp_lost_process_stopped"));
});

test("Vibe 3.0.3: mcp_authorization_required then mcp_unknown_route on Convertigo tools count the same way", () => {
  threads.length = 0;
  stopped.length = 0;
  const entry = fakeEntry();
  entry.pending.set("7", { method: "session/prompt" });
  sandbox.pushEvent(entry, "turn/start", { requestId: 7 });
  play(entry, [start("effect-1", "mcp_playwright.browser_navigate"), failed("effect-1", "mcp_unknown_route")]);
  assert.equal(entry.restartReason, undefined, "another MCP server is not the Convertigo one");
  play(entry, [start("effect-2"), failed("effect-2", "mcp_timeout")]);
  assert.equal(entry.restartReason, undefined, "a timeout leaves the server routed");
  play(entry, [start("effect-3"), failed("effect-3", "mcp_authorization_required")]);
  assert.equal(entry.restartReason, "convertigo_mcp_suspended");
  assert.deepEqual({ ...entry.restartDetail }, { code: "mcp_authorization_required" });
  play(entry, [start("effect-4"), failed("effect-4", "mcp_unknown_route"), start("effect-5"), failed("effect-5", "mcp_unknown_route")]);
  assert.deepEqual(warnings(entry), ["convertigo_mcp_suspended", "mcp_lost_turn_stopped"]);
  sandbox.handleAcpLine(entry, JSON.stringify({ jsonrpc: "2.0", id: 7, result: { stopReason: "cancelled" } }), "stdout");
  assert.equal(entry.turnActive, false);
  threads[0].runnable.run();
  assert.deepEqual(stopped, [], "a cancel answered in time leaves the process to the next start");
  assert.equal(entry.restartReason, "convertigo_mcp_suspended");
});

test("a turn that fails on a refusal of the core marks the process too", () => {
  const entry = fakeEntry();
  entry.pending.set("8", { method: "session/prompt" });
  sandbox.pushEvent(entry, "turn/start", { requestId: 8 });
  sandbox.handleAcpLine(entry, JSON.stringify({ jsonrpc: "2.0", id: 8, error: { code: -32603, message: REFUSAL } }), "stdout");
  assert.equal(entry.restartReason, "core_rejected_input");
  assert.equal(entry.restartDetail.commandType, "reconfigure");
  assert.equal(entry.turnActive, false);
});

test("the next start replaces a process that lost the Convertigo MCP, on the same session", () => {
  const vibe = fs.readFileSync(path.join(root, "js/agent_bridge_vibe.js"), "utf8");
  const common = fs.readFileSync(path.join(root, "js/agent_bridge_common.js"), "utf8");
  assert.match(common, /var VIBE_MCP_LOST_RESTARTS = \{ core_rejected_input: true, convertigo_mcp_suspended: true \};/);
  const branchStart = vibe.indexOf('VIBE_MCP_LOST_RESTARTS[trim(existing.restartReason)] === true) {');
  assert.ok(branchStart > 0, "the restart branch exists");
  assert.ok(branchStart < vibe.indexOf("var requestedMcpTokenFingerprint = mcpBearerTokenFingerprint(options);"), "before an alive process is reused");
  const branch = vibe.slice(branchStart, vibe.indexOf("existing = null;", branchStart));
  assert.match(branch, /options\.sessionId = trim\(existing\.sessionId\);/);
  assert.match(branch, /reason: "mcp_lost_restart"/);
  assert.match(branch, /stopEntry\(existing, true\);/);
  const prompt = vibe.indexOf('var pending = sendAcpRequest(entry, "session/prompt", params);');
  assert.match(vibe.slice(prompt - 80, prompt), /entry\.mcpLostFailures = 0;/, "each turn counts its own failures");
});

test("the ACP lines of vibe-acp 3.0.2 and 3.0.3 after a 401 of the MCP end the turn at the third failure", () => {
  for (const [file, reason, firstCode] of [["vibe-3.0.2-mcp-401.ndjson", "core_rejected_input", "effect_recovery_failed"],
    ["vibe-3.0.3-mcp-401.ndjson", "convertigo_mcp_suspended", "mcp_authorization_required"]]) {
    threads.length = 0;
    const entry = fakeEntry();
    entry.pending.set("3", { method: "session/prompt" });
    sandbox.pushEvent(entry, "turn/start", { requestId: 3 });
    const lines = fs.readFileSync(path.join(__dirname, "fixtures", file), "utf8").split("\n").filter(Boolean);
    let stoppedAt = -1;
    lines.forEach((line, index) => {
      sandbox.handleAcpLine(entry, line, "stdout");
      if (stoppedAt < 0 && /session\/cancel/.test(entry._written.join(""))) {
        stoppedAt = index;
      }
    });
    const failures = entry._events.filter((event) => event.type === "tool/update" && event.data.status === "failed");
    assert.equal(failures[0].data.failure.code, firstCode, file);
    assert.equal(entry.restartReason, reason, file);
    assert.equal(threads.length, 1, file + ": one stop");
    const failedBeforeStop = lines.slice(0, stoppedAt + 1).filter((line) => /"status":"failed"/.test(line)).length;
    assert.equal(failedBeforeStop, 3, file + ": the turn is stopped at the third failure");
  }
});
