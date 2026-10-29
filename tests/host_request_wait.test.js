// A request of the Convertigo MCP waiting for the panel of a conversation (lib_ConvertigoAssistant.hostRequests: a
// preview capture, or a No Code change waiting for the user's confirmation) ends the wait for events at once, so the
// panel reads the turn, takes it and shows its card without waiting 10 s. Once per request: a request the panel took
// (taken) or one already signaled no longer shortens the wait.
// node --test tests/host_request_wait.test.js
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
const source = fs.readFileSync(path.join(root, "js/agent_bridge_common.js"), "utf8");
vm.runInContext(source, sandbox, { filename: "agent_bridge_common.js" });

const shared = new Map();
sandbox.context = { server: { get: (key) => (shared.has(key) ? shared.get(key) : null), set: (key, value) => shared.set(key, value) } };

class JavaMap extends Map {
  values() { const list = [...super.values()]; return { toArray: () => list }; }
}
function leave(conversationId, id, status, kind = "write-confirm") {
  if (!shared.has("lib_ConvertigoAssistant.hostRequests")) {
    shared.set("lib_ConvertigoAssistant.hostRequests", new JavaMap());
  }
  const conversations = shared.get("lib_ConvertigoAssistant.hostRequests");
  if (!conversations.has(conversationId)) {
    conversations.set(conversationId, new JavaMap());
  }
  conversations.get(conversationId).set(id, JSON.stringify({ id, kind, status, conversationId }));
}

test("nothing waits: the wait goes on", () => {
  shared.clear();
  assert.equal(sandbox.hostRequestWaiting({ handle: "agent-1", mcpConversationId: "agent-1" }), false);
  leave("agent-2", "wc-1", "pending");
  assert.equal(sandbox.hostRequestWaiting({ handle: "agent-1", mcpConversationId: "agent-1" }), false, "another conversation's");
});

test("a pending request of the conversation ends the wait once; a taken one does not", () => {
  shared.clear();
  const entry = { handle: "agent-1", mcpConversationId: "agent-1" };
  leave("agent-1", "wc-1", "taken");
  assert.equal(sandbox.hostRequestWaiting(entry), false);
  leave("agent-1", "wc-2", "pending");
  assert.equal(sandbox.hostRequestWaiting(entry), true);
  assert.equal(sandbox.hostRequestWaiting(entry), false, "signaled once, even if the panel did not take it");
  leave("agent-1", "cap-3", "pending", "preview-capture");
  assert.equal(sandbox.hostRequestWaiting(entry), true, "a preview capture too");
  // Codex and Claude entries name no MCP conversation: the handle is the conversation
  leave("agent-9", "wc-4", "pending");
  assert.equal(sandbox.hostRequestWaiting({ handle: "agent-9" }), true);
});

test("a store that cannot be read never breaks the wait for events", () => {
  shared.clear();
  shared.set("lib_ConvertigoAssistant.hostRequests", { get: () => { throw new Error("broken"); } });
  assert.equal(sandbox.hostRequestWaiting({ handle: "agent-1" }), false);
});

test("the wait for events of agent_events stops on it", () => {
  assert.match(source, /while \(entry\.nextIndex <= cursor && processAlive\(entry\.process\) && now\(\) < deadline && !hostRequestWaiting\(entry\)\) \{/);
});
