// A vm sandbox with agent_bridge_common.js and agent_bridge_vibe.js, fake Java threads (run by hand), a fake clock, a
// registry and fake Vibe entries whose stdin is recorded. Shared by the Vibe recovery tests.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..", "..");

function vibeHarness() {
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
  const clock = { now: 1000000 };
  function FakeThread(runnable, name) {
    this.runnable = runnable;
    this.name = name;
    this.setDaemon = () => {};
    this.start = () => threads.push(this);
  }
  FakeThread.sleep = (ms) => { clock.now += Number(ms || 0); };
  FakeThread.currentThread = () => ({ getName: () => "test" });
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
  const sandbox = { Packages: packages, context: javaProxy, request: javaProxy, log: { info() {}, warn() {} }, C8O: { agentBridge: {} } };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "js/agent_bridge_common.js"), "utf8"), sandbox, { filename: "agent_bridge_common.js" });
  vm.runInContext(fs.readFileSync(path.join(root, "js/agent_bridge_vibe.js"), "utf8"), sandbox, { filename: "agent_bridge_vibe.js" });

  const registry = new Map();
  const probes = [];
  const restarts = [];
  const secrets = new Map();
  const shared = new Map();
  const hooks = { onSleep: null };
  sandbox.now = () => clock.now;
  sandbox.convertigoMcpSleep = (ms) => { clock.now += ms; if (hooks.onSleep) { hooks.onSleep(); } };
  sandbox.vibeBusySleep = (ms) => { clock.now += ms; };
  sandbox.convertigoMcpProbeHttp = () => { clock.now += 5; return probes.length ? probes.shift() : { ok: true, code: "ok", status: 200 }; };
  sandbox.getRegistry = () => ({ get: (h) => (registry.has(h) ? registry.get(h) : null), put: (h, e) => registry.set(h, e), remove: (h) => registry.delete(h) });
  sandbox.processAlive = (p) => !!p && p.alive !== false;
  sandbox.stopEntryProcess = (entry) => { if (entry.process) { entry.process.alive = false; } };
  sandbox.stopEntry = (entry, remove) => {
    sandbox.stopEntryProcess(entry);
    entry.status = "closed";
    sandbox.pushEvent(entry, "system/closed", { handle: entry.handle });
    if (remove) { registry.delete(entry.handle); }
  };
  sandbox.stopConversationSubagents = () => {};
  sandbox.writeStartupTimings = () => {};
  sandbox.withProjectNotesPrompt = (text) => text;
  sandbox.withAgentTempDirPrompt = (text) => text;
  sandbox.withRevealModePrompt = (text) => text;
  sandbox.withStudioAgentBrowserPrompt = (text) => text;
  sandbox.vibeImageBlocks = () => ({ blocks: [], skipped: [] });
  sandbox.describeImagesForBlindModel = () => ({ described: [], failed: [], text: "" });
  sandbox.noCodeAgentRefusal = () => null;
  // Managed MCP tokens: a handle names a token in server memory; a token "managed_<id>" is leased under that id.
  sandbox.getServerStore = () => ({ get: (key) => (shared.has(key) ? shared.get(key) : null), set: (key, value) => shared.set(key, value) });
  sandbox.serverSecretGet = (handle) => String(secrets.get(String(handle || "")) || "");
  sandbox.managedMcpBearerToken = (options) => sandbox.serverSecretGet(options && options.mcpBearerTokenHandle);
  sandbox.mcpBearerTokenFingerprint = (options) => { const token = sandbox.managedMcpBearerToken(options); return token ? "fp-" + token : ""; };
  sandbox.managedMcpTokenId = (options) => { const token = sandbox.managedMcpBearerToken(options); return /^managed_/.test(token) ? token : ""; };
  const leases = {
    map: null,
    set(id, expiresAt) {
      if (!leases.map) { leases.map = new Map(); shared.set("lib_ConvertigoMCP.managedTokenLeases", leases.map); }
      leases.map.set(id, JSON.stringify({ idleMs: 1800000, expiresAt, maxAt: 0 }));
    },
    end(id) { leases.set(id, clock.now - 1); },
    token(handle, id, expiresAt) { secrets.set(handle, id); leases.set(id, typeof expiresAt === "number" ? expiresAt : clock.now + 1800000); }
  };
  // The registry's pending requests are a Java map: get, put, remove, size(), values().toArray().
  class JavaMap {
    constructor() { this.map = new Map(); }
    get(key) { return this.map.has(key) ? this.map.get(key) : null; }
    put(key, value) { this.map.set(key, value); }
    set(key, value) { this.map.set(key, value); }
    remove(key) { this.map.delete(key); }
    size() { return this.map.size; }
    values() { const list = [...this.map.values()]; return { toArray: () => list }; }
  }
  // An AtomicBoolean, for the admission gate.
  const gate = () => { let value = false; return { compareAndSet(expect, update) { if (value !== expect) { return false; } value = update; return true; }, set(v) { value = v; }, get: () => value }; };
  function fakeEntry(handle, sessionId, extra) {
    const written = [];
    const events = [];
    const entry = Object.assign({
      handle: handle || "vibe-test", provider: "vibe", protocol: "acp", status: "running", sessionId: sessionId || "s1",
      nextIndex: 0, firstIndex: 0, lastAccess: 0, lastError: "", process: { alive: true }, pending: new JavaMap(), nextRequestId: 100,
      writer: { write(text) { written.push(String(text)); if (entry.onWrite) { entry.onWrite(String(text)); } }, newLine() {}, flush() {} },
      events: { add(event) { events.push(event); }, size() { return events.length; }, remove() { events.shift(); }, get(i) { return events[i]; } },
      mcpProbeTarget: { url: "http://127.0.0.1:18080/convertigo/api/mcp", headers: [{ name: "Authorization", value: "Bearer old" }] },
      credentials: { policy: "explicit", sources: [], injectedKeys: [] }, home: {}, command: [], envKeys: [], createdAt: 0, ttlMillis: 0,
      startOptions: { handle: handle || "vibe-test", conversationId: "c1", mcpEndpoint: "http://127.0.0.1:18080/convertigo/api/mcp", mcpBearerTokenHandle: "h-old" },
      admissionGate: gate(),
      _events: events, _written: written
    }, extra || {});
    registry.set(entry.handle, entry);
    return entry;
  }
  // What vibeStartSteps does for a restart in place: the old process stopped, a new entry that takes its turn and stream.
  sandbox.vibeRestartStarter = (options) => {
    const old = registry.get(options.handle);
    restarts.push({ handle: options.handle, sessionId: options.sessionId, restartInPlace: options.restartInPlace, mcpBearerTokenHandle: options.mcpBearerTokenHandle });
    assert.equal(old.restartingInPlace, true);
    old.status = "restarting";
    sandbox.stopEntryProcess(old);
    const fresh = fakeEntry(options.handle, options.sessionId, {
      mcpLeaseTokenId: sandbox.managedMcpTokenId(options),
      mcpBearerTokenFingerprint: sandbox.mcpBearerTokenFingerprint(options),
      startOptions: Object.assign({}, options)
    });
    fresh._written = [];
    fresh.writer = { write(text) { fresh._written.push(String(text)); }, newLine() {}, flush() {} };
    sandbox.adoptVibeTurn(fresh, old);
    registry.set(options.handle, fresh);
    sandbox.pushEvent(fresh, "system/start", { handle: options.handle });
    return { ok: true, status: "started" };
  };

  const update = (body) => JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: body } });
  const answer = (id, stopReason) => JSON.stringify({ jsonrpc: "2.0", id, result: { stopReason: stopReason || "end_turn" } });
  const refusal = (id, text) => JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: text || "Internal error", data: { details: "A turn is already running" } } });
  const play = (entry, lines) => lines.forEach((line) => sandbox.handleAcpLine(entry, line, "stdout"));
  // After a restart in place the new entry writes to the event list it adopted (the first entry's _events).
  const types = (entry, type) => entry._events.filter((event) => event.type === type);
  const reasons = (entry) => types(entry, "warning").map((event) => event.data.reason);
  const sentMessages = (entry, method) => entry._written.map((w) => JSON.parse(w)).filter((m) => m.method === method);
  const runThreads = (name) => {
    const pending = threads.filter((t) => t.name.indexOf(name) >= 0);
    pending.forEach((t) => { threads.splice(threads.indexOf(t), 1); t.runnable.run(); });
    return pending.length;
  };
  function reset() {
    threads.length = 0;
    probes.length = 0;
    restarts.length = 0;
    registry.clear();
    secrets.clear();
    shared.clear();
    leases.map = null;
    hooks.onSleep = null;
  }
  return { sandbox, clock, threads, registry, probes, restarts, secrets, leases, hooks, fakeEntry, update, answer, refusal, play, types, reasons, sentMessages, runThreads, reset, gate };
}

module.exports = { vibeHarness };
