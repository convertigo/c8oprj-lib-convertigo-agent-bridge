// The managed token of a Tigo conversation is leased by lib_ConvertigoMCP (valid while a turn uses it, it ends its idle
// time after the last activity): the events of a running turn slide the lease, so a long tool, a wait or a sub-agent
// without MCP call does not end it. PCA eval 29/10: GLM lost every Convertigo tool 2 h into its turn, the token had a
// fixed 2 h expiry and only the next message renewed it.
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

// What the JWT helpers of the Bridge call, and the store the server shares between projects.
class JavaString {
  constructor(bytes) { this.text = Buffer.from(bytes).toString("utf8"); }
  toString() { return this.text; }
}
sandbox.Packages = new Proxy(javaProxy, { get: (_target, property) => (property === "java" ? { lang: { String: JavaString } } : javaProxy) });
sandbox.Base64 = { getUrlDecoder: () => ({ decode: (text) => Buffer.from(String(text), "base64url") }) };
const clock = { now: Date.UTC(2026, 9, 30, 8, 0, 0) };
sandbox.System = { currentTimeMillis: () => clock.now, getProperty: () => null };
const shared = new Map();
sandbox.context = { server: { get: (key) => (shared.has(key) ? shared.get(key) : null), set: (key, value) => shared.set(key, value) } };

const LEASES = "lib_ConvertigoMCP.managedTokenLeases";
const ID = "managed_0123456789abcdef0123456789abcdef";
const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const token = (header, payload) => part(header) + "." + part(payload) + ".c2lnbmF0dXJl";
const leasedToken = token({ alg: "HS256", typ: "JWT", kid: ID }, { iss: "lib_ConvertigoMCP", kind: "managed", lease: "turn" });

class Leases {
  constructor() { this.map = new Map(); }
  get(key) { return this.map.has(key) ? this.map.get(key) : null; }
  put(key, value) { this.map.set(key, value); }
  remove(key) { this.map.delete(key); }
  replace(key, oldValue, newValue) {
    if (this.get(key) !== String(oldValue)) { return false; }
    this.map.set(key, String(newValue));
    return true;
  }
}

function freshLease(idleMs) {
  const leases = new Leases();
  leases.put(ID, JSON.stringify({ idleMs, expiresAt: clock.now + idleMs, maxAt: clock.now + 7 * 86400000 }));
  shared.set(LEASES, leases);
  return leases;
}

function fakeEntry(tokenId) {
  const events = [];
  return {
    handle: "vibe-test", provider: "vibe", protocol: "acp", status: "running", nextIndex: 0, firstIndex: 0, lastAccess: 0,
    mcpLeaseTokenId: tokenId,
    events: { add(event) { events.push(event); }, size() { return events.length; }, remove() { events.shift(); } }
  };
}

const expiresAt = (leases) => JSON.parse(leases.get(ID)).expiresAt;
const minutes = (n) => n * 60000;

test("the token id of a leased managed token, and none for a token without lease", () => {
  assert.equal(sandbox.managedMcpTokenId({ mcpBearerToken: leasedToken }), ID);
  assert.equal(sandbox.managedMcpTokenId({ mcpBearerToken: token({ kid: ID }, { kind: "managed", exp: 1 }) }), "", "a fixed-expiry token");
  assert.equal(sandbox.managedMcpTokenId({ mcpBearerToken: leasedToken, skillProfile: "nocode" }), "", "No Code tokens are C8Oforms ones");
  assert.equal(sandbox.managedMcpTokenId({ mcpBearerToken: token({ kid: "durable_x" }, { lease: "turn" }) }), "", "not a managed id");
  assert.equal(sandbox.managedMcpTokenId({ mcpBearerToken: "not-a-jwt" }), "");
  assert.equal(sandbox.managedMcpTokenId({}), "");
});

test("a running turn keeps its token alive past the idle time without any MCP call, the end of the turn starts the idle time", () => {
  const leases = freshLease(minutes(5));
  const entry = fakeEntry(ID);
  sandbox.pushEvent(entry, "turn/start", { requestId: "r1" });
  // 40 minutes of events (a long build, a wait, a sub-agent) without one MCP call
  for (let i = 0; i < 80; i++) {
    clock.now += 30000;
    sandbox.pushEvent(entry, "answer/chunk", { text: "." });
    assert.ok(expiresAt(leases) > clock.now, "the lease ended " + i / 2 + " min into the turn");
  }
  clock.now += 10000;
  sandbox.pushEvent(entry, "answer/chunk", { text: "." });
  assert.ok(expiresAt(leases) - clock.now < minutes(5), "touched at most every 30 s");
  clock.now += 5000;
  sandbox.pushEvent(entry, "turn/end", { requestId: "r1" });
  assert.equal(expiresAt(leases), clock.now + minutes(5), "the end of the turn starts the idle time");
  // no turn: events of the idle conversation do not slide it, and it ends
  clock.now += minutes(3);
  sandbox.pushEvent(entry, "system/status", {});
  assert.equal(expiresAt(leases), clock.now - minutes(3) + minutes(5));
});

test("an ended or revoked lease is never brought back, and an entry without leased token touches nothing", () => {
  const leases = freshLease(minutes(5));
  const entry = fakeEntry(ID);
  clock.now += minutes(6);
  const ended = leases.get(ID);
  sandbox.pushEvent(entry, "turn/start", { requestId: "r2" });
  assert.equal(leases.get(ID), ended, "ended");
  leases.remove(ID);
  clock.now += minutes(1);
  sandbox.pushEvent(entry, "answer/chunk", {});
  sandbox.pushEvent(entry, "turn/end", { requestId: "r2" });
  assert.equal(leases.get(ID), null, "revoked");
  const other = freshLease(minutes(5));
  const before = other.get(ID);
  const plain = fakeEntry("");
  sandbox.pushEvent(plain, "turn/start", {});
  clock.now += minutes(1);
  sandbox.pushEvent(plain, "answer/chunk", {});
  assert.equal(other.get(ID), before);
  shared.delete(LEASES);
  sandbox.pushEvent(fakeEntry(ID), "turn/start", {});
});

test("a tool that runs longer than the idle time without any event does not end the lease while the turn runs", () => {
  const leases = freshLease(minutes(2));
  const entry = fakeEntry(ID);
  entry.process = { isAlive: () => true };
  const started = [];
  const savedThread = sandbox.Thread;
  const savedRunnable = sandbox.Runnable;
  sandbox.Runnable = function (implementation) { return implementation; };
  let sleeps = 0;
  sandbox.Thread = class {
    constructor(runnable, name) { this.runnable = runnable; this.name = name; }
    setDaemon() {}
    start() { started.push(this); }
    static sleep(ms) {
      // one `sleep 600` in the agent's terminal: no event for 10 minutes, then the turn ends
      clock.now += ms;
      sleeps++;
      if (sleeps === 20) {
        entry.turnActive = false;
      }
    }
  };
  try {
    sandbox.pushEvent(entry, "turn/start", { requestId: "r3" });
    sandbox.pushEvent(entry, "turn/start", { requestId: "r3" });
    assert.equal(started.length, 1, "one keeper per running turn");
    assert.match(started[0].name, /mcp-lease/);
    const turnStart = clock.now;
    let lastSeen = 0;
    const realReplace = leases.replace.bind(leases);
    leases.replace = (key, oldValue, newValue) => {
      assert.ok(Number(JSON.parse(oldValue).expiresAt) > clock.now, "the lease ended " + (clock.now - turnStart) / 1000 + " s into the turn");
      lastSeen = clock.now;
      return realReplace(key, oldValue, newValue);
    };
    started[0].runnable.run();
    assert.equal(clock.now - turnStart, minutes(10));
    assert.equal(lastSeen, turnStart + minutes(9.5), "touched until the turn ended");
    assert.equal(entry.mcpLeaseKeeper, false, "the keeper stopped with the turn");
  } finally {
    sandbox.Thread = savedThread;
    sandbox.Runnable = savedRunnable;
  }
});

test("every runtime keeps the token id of its session", () => {
  for (const file of ["js/agent_bridge_vibe.js", "js/agent_bridge_codex.js", "js/agent_bridge_claude.js"]) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert.match(source, /entry\.mcpBearerTokenFingerprint = mcpBearerTokenFingerprint\(options\);\n {4}entry\.mcpLeaseTokenId = managedMcpTokenId\(options\);/, file);
  }
});
