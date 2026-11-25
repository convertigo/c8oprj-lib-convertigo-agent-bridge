// A Vibe session that lost the Convertigo MCP during a turn (an HTTP 401 of the MCP: mcp_authorization_required, then
// mcp_unknown_route on every Convertigo call): at the third such failure in a row the Bridge cancels the turn
// (noteVibeMcpLost). The work stayed half done until the user wrote again. Once per user message the turn now goes on:
// when Vibe has answered the cancel (or its process was stopped) and the MCP answers, Vibe restarts on the same session
// within the same turn and gets a continuation prompt that has it check its last change first (warning
// mcp_lost_resumed); an MCP that does not come back ends the turn (convertigo_mcp_unreachable).
// tests/fixtures/vibe-3.1.0-mcp-401.ndjson: live lines of vibe-acp 3.1.0 on a headless engine, the MCP answering 401
// from the middle of a turn that created three sequences one by one (two calls through, then three lost).
// node --test tests/vibe_mcp_lost_resume.test.js
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
  apply() { return javaProxy; },
  construct() { return javaProxy; }
});
const threads = [];
let clock = 1000000;
function FakeThread(runnable, name) {
  this.runnable = runnable;
  this.name = name;
  this.setDaemon = () => {};
  this.start = () => threads.push(this);
}
FakeThread.sleep = (ms) => { clock += Number(ms || 0); };
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
const sandbox = { Packages: packages, context: javaProxy, request: javaProxy, log: javaProxy, C8O: { agentBridge: {} } };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, "js/agent_bridge_common.js"), "utf8"), sandbox, { filename: "agent_bridge_common.js" });
vm.runInContext(fs.readFileSync(path.join(root, "js/agent_bridge_vibe.js"), "utf8"), sandbox, { filename: "agent_bridge_vibe.js" });
const vibeSource = fs.readFileSync(path.join(root, "js/agent_bridge_vibe.js"), "utf8");

const registry = new Map();
const probes = [];
const restarts = [];
sandbox.now = () => clock;
sandbox.convertigoMcpSleep = (ms) => { clock += ms; };
sandbox.convertigoMcpProbeHttp = () => { clock += 5; return probes.length ? probes.shift() : { ok: true, code: "ok", status: 200 }; };
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

const REFUSED = { ok: false, code: "connection_refused", status: 0 };
const update = (body) => JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: body } });
const answer = (id, stopReason) => JSON.stringify({ jsonrpc: "2.0", id, result: { stopReason: stopReason || "end_turn" } });
const notices = fs.readFileSync(path.join(__dirname, "fixtures", "vibe-3.1.0-mcp-connect-notice.ndjson"), "utf8").split("\n").filter(Boolean);
const play = (entry, lines) => lines.forEach((line) => sandbox.handleAcpLine(entry, line, "stdout"));

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
function fakeEntry(handle, sessionId) {
  const written = [];
  const events = [];
  const entry = {
    handle: handle || "vibe-test", provider: "vibe", protocol: "acp", status: "running", sessionId: sessionId || "s1",
    nextIndex: 0, firstIndex: 0, lastAccess: 0, lastError: "", process: { alive: true }, pending: new JavaMap(), nextRequestId: 100,
    writer: { write(text) { written.push(String(text)); }, newLine() {}, flush() {} },
    events: { add(event) { events.push(event); }, size() { return events.length; }, remove() { events.shift(); }, get(i) { return events[i]; } },
    mcpProbeTarget: { url: "http://127.0.0.1:18080/convertigo/api/mcp", headers: [] },
    credentials: { policy: "explicit", sources: [], injectedKeys: [] }, home: {}, command: [], envKeys: [], createdAt: 0, ttlMillis: 0,
    startOptions: { handle: handle || "vibe-test", conversationId: "c1", mcpEndpoint: "http://127.0.0.1:18080/convertigo/api/mcp" },
    _events: events, _written: written
  };
  registry.set(entry.handle, entry);
  return entry;
}
// What vibeStartSteps does for a restart in place: the old process stopped, a new entry that takes its turn and stream.
sandbox.vibeRestartStarter = (options) => {
  const old = registry.get(options.handle);
  restarts.push({ handle: options.handle, sessionId: options.sessionId, restartInPlace: options.restartInPlace });
  assert.equal(old.restartingInPlace, true);
  old.status = "restarting";
  sandbox.stopEntryProcess(old);
  const fresh = fakeEntry(options.handle, options.sessionId);
  fresh._written = [];
  fresh.writer = { write(text) { fresh._written.push(String(text)); }, newLine() {}, flush() {} };
  sandbox.adoptVibeTurn(fresh, old);
  registry.set(options.handle, fresh);
  sandbox.pushEvent(fresh, "system/start", { handle: options.handle });
  return { ok: true, status: "started" };
};
function turn(id, text) {
  threads.length = 0;
  probes.length = 0;
  restarts.length = 0;
  const entry = fakeEntry();
  entry.pending.set(String(id), { id, method: "session/prompt" });
  sandbox.pushEvent(entry, "turn/start", { requestId: id });
  entry.turnPromptBlocks = [{ type: "text", text: text || "Ajoute un champ email au formulaire Contact." }];
  return entry;
}
// After a restart in place the new entry writes to the event list it adopted (the first entry's _events).
const types = (entry, type) => entry._events.filter((event) => event.type === type);
const reasons = (entry) => types(entry, "warning").map((event) => event.data.reason);
const prompts = (entry) => entry._written.map((w) => JSON.parse(w)).filter((m) => m.method === "session/prompt");
const runThreads = (name) => { const pending = threads.filter((t) => t.name.indexOf(name) >= 0); pending.forEach((t) => { threads.splice(threads.indexOf(t), 1); t.runnable.run(); }); return pending.length; };


const lost = fs.readFileSync(path.join(__dirname, "fixtures", "vibe-3.1.0-mcp-401.ndjson"), "utf8").split("\n").filter(Boolean);

test("vibe-acp 3.1.0 after a 401: the third lost call stops the turn, the MCP comes back, Vibe resumes in the same turn", () => {
  const entry = turn(3, "Cr\u00e9e trois s\u00e9quences SeqAlpha, SeqBeta et SeqGamma, une par une.");
  play(entry, lost);
  assert.deepEqual(reasons(entry), ["convertigo_mcp_suspended", "mcp_lost_turn_stopped"]);
  assert.equal(types(entry, "warning")[1].data.resume, true);
  assert.match(entry._written.join(""), /"method":"session\/cancel"/);
  assert.equal(entry.mcpRecovery.kind, "resume");
  assert.equal(entry.mcpRecovery.cause, "convertigo_mcp_suspended");
  play(entry, [answer(3, "cancelled")]);
  assert.equal(types(entry, "turn/end").length, 0, "the user's turn goes on");
  probes.push({ ok: false, code: "unauthorized", status: 401 });
  runThreads("mcp-recovery-");
  assert.match(types(entry, "progress/message").map((e) => e.data.text).join("\n"), /the Convertigo MCP does not answer \(unauthorized\)/);
  assert.deepEqual(restarts, [{ handle: "vibe-test", sessionId: "s1", restartInPlace: "true" }]);
  const fresh = registry.get("vibe-test");
  const sent = prompts(fresh);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].params.prompt.length, 1);
  assert.equal(sent[0].params.prompt[0].text, "Note from the Agent Bridge: the Convertigo MCP tools were lost during your last steps "
    + "(convertigo_mcp_suspended), so the Bridge stopped your turn and restarted Vibe on this conversation: the tools are back. Your last "
    + "change may be incomplete. Call `project-changes` and read back the objects you changed since your last successful proof, repair "
    + "any half-made change, then continue the user's request.");
  const resumed = types(entry, "warning").find((event) => event.data.reason === "mcp_lost_resumed").data;
  assert.deepEqual([resumed.cause, resumed.requestId], ["convertigo_mcp_suspended", sent[0].id]);
  assert.match(resumed.message, /^The Convertigo MCP was lost during the turn/);
  assert.equal(fresh.restartReason, undefined, "the new process has its MCP");
  assert.equal(fresh.mcpLostFailures, 0);
  assert.equal(fresh.turnMcpResumes, 1);
  play(fresh, [answer(sent[0].id)]);
  assert.equal(types(entry, "turn/end").length, 1);
  assert.equal(fresh.turnActive, false);
});

test("once per user message: a second loss in the same message stops the turn for the next message, as before", () => {
  const entry = turn(3);
  play(entry, [...lost, answer(3, "cancelled")]);
  runThreads("mcp-recovery-");
  const fresh = registry.get("vibe-test");
  const resent = prompts(fresh)[0];
  threads.length = 0;
  play(fresh, lost.filter((line) => /"status": "(?:failed|in_progress)"/.test(line) && /2b42a2b5|fe0a8b76|b08ca005/.test(line)));
  const stopped = types(entry, "warning").filter((event) => event.data.reason === "mcp_lost_turn_stopped");
  assert.equal(stopped.length, 2);
  assert.equal(stopped[1].data.resume, false);
  assert.match(stopped[1].data.message, /The next message restarts Vibe on this conversation\.$/);
  play(fresh, [answer(resent.id, "cancelled")]);
  assert.equal(types(entry, "turn/end").length, 1, "the turn ends as before");
  assert.equal(restarts.length, 1);
  assert.equal(fresh.restartReason, "convertigo_mcp_suspended", "the next start replaces the process");
});

test("an MCP that does not come back ends the turn and says the last change may be incomplete", () => {
  const entry = turn(3);
  play(entry, [...lost, answer(3, "cancelled")]);
  for (let i = 0; i < 100; i++) { probes.push(REFUSED); }
  runThreads("mcp-recovery-");
  assert.equal(restarts.length, 0);
  assert.equal(types(entry, "warning").find((event) => event.data.reason === "convertigo_mcp_unreachable").data.cause, "convertigo_mcp_suspended");
  const message = types(entry, "turn/error")[0].data.error.message;
  assert.match(message, /La derni\u00e8re modification peut \u00eatre incompl\u00e8te/);
  assert.match(message, /The last change may be incomplete/);
  assert.equal(entry.restartReason, "convertigo_mcp_suspended", "the next message restarts Vibe");
});

test("a cancel Vibe does not answer: the process is stopped silently and the turn resumes in a restarted Vibe", () => {
  const entry = turn(3);
  play(entry, lost);
  assert.equal(runThreads("mcp-recovery-watchdog-"), 1);
  assert.ok(reasons(entry).includes("mcp_lost_process_stopped"));
  assert.equal(types(entry, "system/closed").length, 0, "no system/closed: the Assistant would end the turn");
  runThreads("mcp-recovery-");
  assert.equal(prompts(registry.get("vibe-test")).length, 1);
  assert.ok(reasons(entry).includes("mcp_lost_resumed"));
});
