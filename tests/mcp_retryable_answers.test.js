// A tool call the Convertigo MCP answered with a retryable HTTP error is classed retryable. Vibe reports any HTTP error
// of an MCP as mcp_http_error, not retryable, without its status: the 503 of a No Code token C8Oforms could not check
// while it was deployed (test-nocode 28/10 17:21, feedback group 1d0f4cb9) read as a lasting failure. lib_ConvertigoMCP
// keeps the last retryable answer of each Tigo conversation in the store the server shares between projects.
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

// The key lib_ConvertigoMCP writes under (C8O.mcpAuth.noteRetryableAnswer).
const KEY = "lib_ConvertigoMCP.retryableAnswers";
const clock = { now: 1793000000000 };
sandbox.System = { currentTimeMillis: () => clock.now, getProperty: () => null };
const shared = new Map();
sandbox.context = { server: { get: (key) => (shared.has(key) ? shared.get(key) : null), set: (key, value) => shared.set(key, value) } };

function noteAnswer(conversationId, at, status, code) {
  if (!shared.has(KEY)) {
    shared.set(KEY, new Map());
  }
  shared.get(KEY).set(conversationId, JSON.stringify({ at, status, code }));
}

function fakeEntry(mcpConversationId) {
  const events = [];
  return {
    handle: "vibe-test", provider: "vibe", protocol: "acp", status: "running", sessionId: "s1", mcpConversationId,
    nextIndex: 0, firstIndex: 0, lastAccess: 0, lastError: "", process: null, pending: new Map(),
    writer: { write() {}, newLine() {}, flush() {} },
    events: { add(event) { events.push(event); }, size() { return events.length; }, remove() { events.shift(); } },
    _events: events
  };
}

const update = (body) => JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: body } });

// A Convertigo call that fails with the error Vibe gives, durationMs after its start; the failure of its update.
function failedCall(entry, code, retryable, durationMs) {
  const id = "effect-" + entry._events.length;
  sandbox.handleAcpLine(entry, update({ sessionUpdate: "tool_call", toolCallId: id, title: "mcp_Convertigo.nocode_form_get", status: "in_progress" }), "stdout");
  clock.now += durationMs;
  sandbox.handleAcpLine(entry, update({ sessionUpdate: "tool_call_update", toolCallId: id, status: "failed",
    rawOutput: { type: "failure", content: [], error: { code, message: "The provided tool call failed", retryable } } }), "stdout");
  return JSON.parse(JSON.stringify(entry._events.filter((event) => event.type === "tool/update").pop().data.failure));
}

test("an HTTP error the MCP answered the call as retryable is retryable, with its status and code", () => {
  shared.clear();
  const entry = fakeEntry("agent-bf6a810d");
  // the MCP answers 0.3 s into the call, Vibe reports it 0.1 s later
  const start = clock.now;
  noteAnswer("agent-bf6a810d", start + 300, 503, "nocode_token_check_unavailable");
  assert.deepEqual(failedCall(entry, "mcp_http_error", false, 400), {
    code: "mcp_http_error", message: "The provided tool call failed", retryable: true,
    details: { httpStatus: 503, mcpCode: "nocode_token_check_unavailable" }, durationMs: 400
  });
});

test("an HTTP error the MCP did not mark retryable stays as Vibe reports it", () => {
  shared.clear();
  const entry = fakeEntry("agent-1");
  assert.equal(failedCall(entry, "mcp_http_error", false, 400).retryable, false, "no retryable answer in the engine");
  noteAnswer("agent-other", clock.now + 100, 503, "nocode_token_check_unavailable");
  const other = failedCall(entry, "mcp_http_error", false, 400);
  assert.equal(other.retryable, false, "the answer of another conversation");
  assert.equal(other.details, null);
  noteAnswer("agent-1", clock.now - 5000, 503, "nocode_token_check_unavailable");
  assert.equal(failedCall(entry, "mcp_http_error", false, 400).retryable, false, "an answer to an earlier call");
  noteAnswer("agent-1", clock.now + 100, 503, "nocode_token_check_unavailable");
  assert.equal(failedCall(fakeEntry(""), "mcp_http_error", false, 400).retryable, false, "a session that names no conversation");
  const transport = failedCall(entry, "mcp_transport_failed", false, 400);
  assert.equal(transport.retryable, false, "only an HTTP error is read again");
  assert.equal(transport.details, null);
});

test("a retryable failure, details Vibe gives and an engine without the store are kept", () => {
  shared.clear();
  const entry = fakeEntry("agent-2");
  noteAnswer("agent-2", clock.now + 100, 503, "token_store_unreadable");
  assert.deepEqual(failedCall(entry, "mcp_timeout", true, 400).details, null, "already retryable");
  noteAnswer("agent-2", clock.now + 100, 503, "token_store_unreadable");
  const id = "effect-details";
  sandbox.handleAcpLine(entry, update({ sessionUpdate: "tool_call", toolCallId: id, title: "x", status: "in_progress" }), "stdout");
  clock.now += 400;
  sandbox.handleAcpLine(entry, update({ sessionUpdate: "tool_call_update", toolCallId: id, status: "failed",
    rawOutput: { error: { code: "mcp_http_error", retryable: false, details: { status: 503 } } } }), "stdout");
  const withDetails = entry._events.filter((event) => event.type === "tool/update").pop().data.failure;
  assert.equal(withDetails.retryable, true);
  assert.deepEqual(JSON.parse(JSON.stringify(withDetails.details)), { status: 503 }, "Vibe's own details are kept");
  // an update without a seen start looks one minute back
  shared.clear();
  noteAnswer("agent-2", clock.now - 30000, 503, "token_store_unreadable");
  sandbox.handleAcpLine(entry, update({ sessionUpdate: "tool_call_update", toolCallId: "never-started", status: "failed",
    rawOutput: { error: { code: "mcp_http_error", retryable: false } } }), "stdout");
  assert.equal(entry._events.filter((event) => event.type === "tool/update").pop().data.failure.retryable, true);
  const saved = sandbox.context;
  sandbox.context = { server: null };
  try {
    assert.equal(failedCall(entry, "mcp_http_error", false, 400).retryable, false, "no shared store");
  } finally {
    sandbox.context = saved;
  }
  shared.set(KEY, new Map([["agent-2", "{not json"]]));
  assert.equal(failedCall(entry, "mcp_http_error", false, 400).retryable, false, "an unreadable answer");
});

test("a Vibe session keeps the conversation its MCP calls name", () => {
  const vibe = fs.readFileSync(path.join(root, "js/agent_bridge_vibe.js"), "utf8");
  const kept = vibe.indexOf("entry.mcpConversationId = mcpConversationId(options);");
  assert.ok(kept > 0 && kept < vibe.indexOf("buildMcpServers(mcpEndpoint, options)"), "set before the MCP servers of the session");
  assert.equal(sandbox.mcpConversationId({ conversationId: "agent-e50aebd1-3413-4e84-9030-0d4d395a3cb6" }), "agent-e50aebd1-3413-4e84-9030-0d4d395a3cb6");
  const headers = sandbox.buildMcpServers("http://localhost:18112/convertigo/api/mcp", { conversationId: "agent-3" })[0].headers;
  assert.deepEqual(JSON.parse(JSON.stringify(headers.filter((h) => h.name === "X-Convertigo-Conversation-Id").map((h) => h.value))), ["agent-3"],
    "the same id the MCP reads");
});
