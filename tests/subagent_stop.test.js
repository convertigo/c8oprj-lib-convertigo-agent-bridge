// The Convertigo MCP sub-agents of a conversation (subagent-run, browser-verify) run in processes the Studio started, not
// under the agent. A conversation cancelled at its time cap left its constructor building for 6 more minutes, its project
// lock refusing project-reload until the runner was killed by hand (measured run, 17/11). The Bridge stops them with the
// conversation: a stop (its turn over or not), a turn cut because the MCP was lost, a deleted conversation, a swept agent.
// Not on a restart of the agent between turns: the next turn collects a running sub-agent by its runId.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "js/agent_bridge_common.js"), "utf8");
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
            if (name === "Thread") { return FakeThread; }
            if (name === "Runnable") { return function (body) { return body; }; }
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
vm.runInContext(source, sandbox, { filename: "agent_bridge_common.js" });

function fakeEntry(extra) {
  const events = [];
  return Object.assign({
    handle: "vibe-test", provider: "vibe", protocol: "acp", status: "running", sessionId: "s1",
    nextIndex: 0, firstIndex: 0, lastAccess: 0, process: {}, pending: new Map(),
    writer: { write() {}, newLine() {}, flush() {} },
    events: { add(event) { events.push(event); }, size() { return events.length; }, remove() { events.shift(); } },
    _events: events
  }, extra || {});
}

function runThreads() {
  while (threads.length) {
    threads.shift().runnable.run();
  }
}

test("the shared stop contract is defined, the same block as lib_ConvertigoMCP's js/subagents.js", () => {
  assert.equal(typeof sandbox.C8O.tigoStopConversationSubagents, "function");
  assert.equal(typeof sandbox.C8O.tigoConversationSubagentRuns, "function");
  assert.deepEqual(sandbox.C8O.tigoConversationSubagentRuns("agent-1").length, 0, "no run folder, no run");
  const start = source.indexOf("// Shared sub-agent stop contract across Tigo projects");
  const end = source.indexOf("// End shared sub-agent stop contract.");
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  assert.match(block, /Keep this block identical in both\./);
  assert.match(block, /new File\(new File\(String\(Packages\.com\.twinsoft\.convertigo\.engine\.Engine\.USER_WORKSPACE_PATH\)\)\.getCanonicalFile\(\), "subagents"\)/);
  assert.match(block, /if \(String\(holder\.runId \|\| ""\) === run\.runId\) \{ lock\["delete"\]\(\); \}/);
});

test("a conversation's sub-agents are stopped on a thread of their own, by the conversation id its MCP calls carry", () => {
  const calls = [];
  const saved = sandbox.C8O.tigoStopConversationSubagents;
  const savedRuns = sandbox.C8O.tigoConversationSubagentRuns;
  sandbox.C8O.tigoConversationSubagentRuns = (id) => (id === "agent-none" ? [] : [{ runId: "x" }]);
  sandbox.C8O.tigoStopConversationSubagents = (id, reason) => { calls.push([id, reason]); return id === "agent-1" ? ["build-20261117-145304-6d00596a"] : []; };
  try {
    const entry = fakeEntry({ handle: "vibe-h", conversationId: "agent-1" });
    sandbox.stopConversationSubagents(entry, "its conversation was stopped");
    assert.equal(calls.length, 0, "nothing runs on the caller's thread");
    runThreads();
    assert.deepEqual(calls, [["agent-1", "its conversation was stopped"]]);
    const event = entry._events.find((e) => e.type === "subagents/stopped");
    assert.deepEqual(JSON.parse(JSON.stringify(event.data)), { runIds: ["build-20261117-145304-6d00596a"], reason: "its conversation was stopped" });
    sandbox.stopConversationSubagents(fakeEntry({ handle: "h2", mcpConversationId: "agent-mcp", conversationId: "agent-other" }), "r");
    runThreads();
    assert.deepEqual(calls[1], ["agent-mcp", "r"], "the MCP conversation id first, as in the agent's MCP header");
    sandbox.stopConversationSubagents(fakeEntry({ handle: "bad id!" }), "r");
    runThreads();
    assert.equal(calls.length, 2, "no valid conversation id, nothing to stop");
    const quiet = fakeEntry({ handle: "h3", conversationId: "agent-none" });
    sandbox.stopConversationSubagents(quiet, "r");
    assert.equal(threads.length, 0, "no thread when the conversation runs no sub-agent");
    assert.equal(calls.length, 2);
    const late = fakeEntry({ handle: "h4", conversationId: "agent-late" });
    sandbox.stopConversationSubagents(late, "r");
    runThreads();
    assert.equal(late._events.some((e) => e.type === "subagents/stopped"), false, "no event when nothing was stopped");
  } finally {
    sandbox.C8O.tigoStopConversationSubagents = saved;
    sandbox.C8O.tigoConversationSubagentRuns = savedRuns;
  }
});

test("a stop, a close, a deleted conversation, a swept agent and a turn cut for a lost MCP stop them; a restart does not", () => {
  const body = (name) => {
    const at = source.indexOf(name);
    assert.ok(at >= 0, name);
    return source.slice(at, source.indexOf("\n  }\n", at));
  };
  const interrupt = body("C8O.agentBridge.interrupt = function (options) {");
  assert.ok(interrupt.indexOf('stopConversationSubagents(entry, "its conversation was stopped");') > 0);
  assert.ok(interrupt.indexOf("stopConversationSubagents(entry") < interrupt.indexOf("if (!processAlive(entry.process)) {"),
    "before the checks: a stop after the turn ended, or with the process gone, stops them too");
  assert.match(body("function cleanupConversationArtifacts(options, report) {"), /stopConversationSubagents\(entry, "its conversation was deleted"\);\s*stopEntry\(entry, true\);/);
  assert.match(body("function stopSweptEntry(registry, entry, reason, current) {"), /stopConversationSubagents\(entry, "its conversation's agent ended \(" \+ reason \+ "\)"\);/);
  assert.match(body("function noteVibeMcpLost(entry, reason, detail) {"), /stopConversationSubagents\(entry, "its conversation's turn was stopped \(the agent lost the Convertigo MCP\)"\);/);
  for (const [file, name] of [["js/agent_bridge_vibe.js", "vibeClose"], ["js/agent_bridge_claude.js", "claudeClose"], ["js/agent_bridge_codex.js", "codexClose"]]) {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    const at = text.indexOf("C8O.agentBridge." + name + " = function (options) {");
    assert.match(text.slice(at, text.indexOf("\n  };\n", at)), /stopConversationSubagents\(entry, "its conversation was closed"\);\s*stopEntry\(entry, true\);/, name);
  }
  assert.equal(body("function stopEntry(entry, removeFromRegistry) {").indexOf("stopConversationSubagents"), -1,
    "stopEntry also restarts an agent between turns");
});
