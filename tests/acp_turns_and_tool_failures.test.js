// Vibe (ACP): a failed tool call keeps the cause Vibe gives. Low-code friction of Studio 8.4.6 users:
// "The provided tool call failed", whose error code was lost.
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
vm.runInContext(fs.readFileSync(path.join(root, "js/agent_bridge_common.js"), "utf8"), sandbox, { filename: "agent_bridge_common.js" });

function fakeEntry() {
  const events = [];
  return {
    handle: "vibe-test", provider: "vibe", protocol: "acp", status: "running", sessionId: "s1",
    nextIndex: 0, firstIndex: 0, lastAccess: 0, lastError: "", process: null, pending: new Map(),
    writer: { write() {}, newLine() {}, flush() {} },
    events: { add(event) { events.push(event); }, size() { return events.length; }, remove() { events.shift(); } },
    _events: events
  };
}

const update = (body) => JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: body } });

test("a failed tool call carries the code, the retry flag and the duration Vibe gives", () => {
  const entry = fakeEntry();
  sandbox.handleAcpLine(entry, update({ sessionUpdate: "tool_call", toolCallId: "effect-1", title: "mcp_Convertigo.databaseobject_tree_get", status: "in_progress" }), "stdout");
  sandbox.handleAcpLine(entry, update({ sessionUpdate: "tool_call_update", toolCallId: "effect-1", status: "failed",
    rawOutput: { type: "failure", content: [], error: { code: "mcp_transport_failed", message: "The provided tool call failed", retryable: false } } }), "stdout");
  const failed = entry._events.find((event) => event.type === "tool/update");
  assert.equal(failed.data.failure.code, "mcp_transport_failed");
  assert.equal(failed.data.failure.message, "The provided tool call failed");
  assert.equal(failed.data.failure.retryable, false);
  assert.ok(failed.data.failure.durationMs >= 0, "measured from the start of the call");
  assert.deepEqual(Object.keys(entry.toolStartedAt), [], "a finished call is forgotten");

  sandbox.handleAcpLine(entry, update({ sessionUpdate: "tool_call", toolCallId: "effect-2", title: "x", status: "in_progress" }), "stdout");
  sandbox.handleAcpLine(entry, update({ sessionUpdate: "tool_call_update", toolCallId: "effect-2", status: "completed", rawOutput: { type: "success" } }), "stdout");
  assert.equal(entry._events.filter((event) => event.type === "tool/update")[1].data.failure, undefined, "a completed call has no failure");

  sandbox.handleAcpLine(entry, update({ sessionUpdate: "tool_call_update", toolCallId: "effect-3", status: "failed", rawOutput: { code: "mcp_timeout", message: "The provided tool call failed", retryable: true } }), "stdout");
  const timeout = entry._events.filter((event) => event.type === "tool/update")[2].data.failure;
  assert.equal(timeout.code, "mcp_timeout");
  assert.equal(timeout.retryable, true);
  assert.equal(timeout.durationMs, null, "no start seen, no duration");
});
