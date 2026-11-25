// Vibe 3.1 resolves its MCP servers when a session starts: a Convertigo MCP that refuses the connection (or the token)
// then leaves the session without any Convertigo tool for its whole life. Vibe says so once, in an agent message of
// its own right after session/new: "MCP server 'Convertigo' failed to connect: mcp_transport_failed." On a bench with
// a customer's stack (Studio 8.4.8 on Windows, MCP 0.3.0-beta.52, Bridge 0.5.0-beta.29) the model then worked around
// the missing tools (curl with the token of its environment, 7.5 min) or looped on sleep and curl for more than 10 min.
// The Bridge never runs a turn on such a session: it waits for the MCP within the turn, restarts Vibe on the same
// session in the same turn and sends the message again, once; an MCP that does not come back ends the turn.
// The first two lines of tests/fixtures/vibe-3.1.0-mcp-connect-notice.ndjson were captured live from vibe-acp 3.1.0 on
// a headless engine (MCP refused, then answering 401); the last two come from Vibe 3.1.0's own serializers
// (_warn_mcp_failures, AcpCommandController.message), for several servers and for a server other than Convertigo.
// node --test tests/vibe_mcp_unavailable_at_start.test.js
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

test("Vibe's notices are read whole: a Convertigo server, several servers, another server, never other messages", () => {
  const texts = notices.map((line) => JSON.parse(line).params.update.content.text);
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.vibeMcpConnectNotices(texts[0]))), [{ server: "Convertigo", error: "mcp_transport_failed", convertigo: true }]);
  assert.equal(sandbox.vibeMcpConnectNotices(texts[1])[0].error, "authentication was rejected");
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.vibeMcpConnectNotices(texts[2]).map((n) => [n.server, n.error, n.convertigo]))),
    [["Convertigo", "authentication was rejected", true], ["playwright", "mcp_timeout", false]]);
  assert.equal(sandbox.vibeMcpConnectNotices(texts[3])[0].convertigo, false);
  assert.equal(sandbox.vibeMcpConnectNotices("MCP server 'convertigo-flow' failed to connect: mcp_timeout.")[0].convertigo, true);
  for (const text of ["Le serveur MCP server 'Convertigo' failed to connect: x.", "MCP server 'Convertigo' failed to connect: x. Je continue sans.",
    "Done.", ""]) {
    assert.equal(sandbox.vibeMcpConnectNotices(text).length, 0, text);
  }
});

test("a notice before any turn marks the process and is a line of the work log, not an answer", () => {
  const entry = fakeEntry();
  play(entry, [notices[0]]);
  assert.equal(types(entry, "answer/chunk").length, 0);
  assert.match(types(entry, "progress/message")[0].data.text, /^Vibe: MCP server 'Convertigo' failed to connect: mcp_transport_failed\.$/);
  assert.deepEqual([entry.convertigoMcpMissing.source, entry.convertigoMcpMissing.error], ["notice", "mcp_transport_failed"]);
  assert.equal(entry._written.length, 0, "nothing to cancel");
  const other = fakeEntry("vibe-other");
  play(other, [notices[3]]);
  assert.equal(other.convertigoMcpMissing, undefined, "another server failing is only a line of the work log");
  const routed = fakeEntry("vibe-routed");
  play(routed, [update({ sessionUpdate: "tool_call", toolCallId: "e1", title: "mcp_Convertigo.project_list", status: "in_progress" }),
    update({ sessionUpdate: "tool_call_update", toolCallId: "e1", status: "completed", rawOutput: { type: "success" } }), notices[0]]);
  assert.equal(routed.convertigoMcpMissing, undefined, "a refresh that failed after a Convertigo call keeps the tools it had");
});

test("a notice during a turn cancels it, the turn waits for the MCP, Vibe restarts on the session and gets the message again: one turn", () => {
  const entry = turn(7);
  play(entry, [notices[0]]);
  assert.deepEqual(reasons(entry), ["convertigo_mcp_unavailable_at_start"]);
  assert.match(entry._written.join(""), /"method":"session\/cancel"/);
  assert.equal(entry.mcpRecovery.awaiting, "7");
  play(entry, [answer(7, "cancelled")]);
  assert.equal(types(entry, "turn/end").length, 0, "the cancelled Vibe turn does not end the user's turn");
  assert.equal(types(entry, "acp/response_error").length, 0);
  assert.equal(entry.turnActive, true);
  probes.push(REFUSED, REFUSED);
  assert.equal(runThreads("mcp-recovery-" + entry.handle), 1);
  assert.match(types(entry, "progress/message")[1].data.text, /^Agent Bridge: the Convertigo MCP does not answer \(connection_refused\); Tigo waits for it/);
  assert.deepEqual(restarts, [{ handle: "vibe-test", sessionId: "s1", restartInPlace: "true" }]);
  const fresh = registry.get("vibe-test");
  assert.notEqual(fresh, entry);
  assert.equal(fresh.events, entry.events, "the new process continues the same event stream");
  const sent = prompts(fresh);
  assert.equal(sent.length, 1);
  assert.match(sent[0].params.prompt[0].text, /^Note from the Agent Bridge: this session had started without the Convertigo MCP tools[\s\S]*The user's message again:\n\nAjoute un champ email au formulaire Contact\.$/);
  assert.equal(fresh.turnRequestId, String(sent[0].id));
  assert.equal(fresh.turnActive, true);
  assert.deepEqual(reasons(entry), ["convertigo_mcp_unavailable_at_start", "convertigo_mcp_restarted"]);
  const restarted = types(entry, "warning").find((event) => event.data.reason === "convertigo_mcp_restarted").data;
  assert.equal(restarted.resent, true);
  sandbox.pushEvent(entry, "stdout", { line: "late line of the stopped process" });
  play(fresh, [update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Le champ est ajouté." }, messageId: "m9" }), answer(sent[0].id)]);
  const ends = types(entry, "turn/end");
  assert.equal(ends.length, 1, "one turn/end in the stream");
  assert.equal(ends[0].data.requestId, sent[0].id);
  assert.equal(fresh.turnActive, false);
  const indexes = entry._events.map((event) => event.index);
  assert.deepEqual(indexes, [...indexes].sort((a, b) => a - b), "the indexes keep growing across the restart");
  assert.equal(new Set(indexes).size, indexes.length);
  assert.equal(entry._events.some((event) => event.type === "stdout"), false, "the stopped process pushes nothing more");
});

test("an MCP that does not come back ends the turn with a message, never a turn without its tools", () => {
  const entry = turn(8);
  play(entry, [notices[0], answer(8, "cancelled")]);
  for (let i = 0; i < 100; i++) { probes.push(REFUSED); }
  runThreads("mcp-recovery-");
  assert.equal(restarts.length, 0);
  const unreachable = types(entry, "warning").find((event) => event.data.reason === "convertigo_mcp_unreachable").data;
  assert.equal(unreachable.code, "connection_refused");
  assert.ok(unreachable.waitedMs >= 56000 && unreachable.waitedMs <= 60000, String(unreachable.waitedMs));
  assert.ok(unreachable.attempts >= 20);
  const error = types(entry, "turn/error")[0].data;
  assert.equal(error.error.code, "convertigo_mcp_unreachable");
  assert.match(error.error.message, /^Le MCP Convertigo ne répond pas[\s\S]*\n\nThe Convertigo MCP does not answer/);
  assert.equal(entry.turnActive, false);
  assert.equal(entry.convertigoMcpMissing.source, "notice", "the next message restarts Vibe once the MCP answers");
  assert.ok(types(entry, "progress/message").some((event) => /still waiting for the Convertigo MCP \(\d+ s/.test(event.data.text)));
  const token = turn(9);
  play(token, [notices[1], answer(9, "cancelled")]);
  for (let i = 0; i < 100; i++) { probes.push({ ok: false, code: "unauthorized", status: 401 }); }
  runThreads("mcp-recovery-");
  assert.match(types(token, "turn/error")[0].data.error.message, /^Le MCP Convertigo refuse l'autorisation de cette conversation/);
});

test("once per message: a second notice in the same message ends the turn", () => {
  const entry = turn(10);
  play(entry, [notices[0], answer(10, "cancelled")]);
  runThreads("mcp-recovery-");
  const fresh = registry.get("vibe-test");
  const resent = prompts(fresh)[0];
  play(fresh, [notices[0]]);
  assert.equal(fresh.mcpRecovery.kind, "unreachable");
  play(fresh, [answer(resent.id, "cancelled")]);
  runThreads("mcp-recovery-");
  assert.equal(restarts.length, 1, "no second restart");
  assert.equal(types(entry, "turn/error")[0].data.error.code, "convertigo_mcp_unreachable");
  assert.equal(types(entry, "warning").filter((event) => event.data.reason === "convertigo_mcp_unreachable")[0].data.code, "restart_limit");
});

test("a cancel Vibe does not answer: the process is stopped and the turn goes on in the restarted Vibe", () => {
  const entry = turn(11);
  play(entry, [notices[0]]);
  assert.equal(runThreads("mcp-recovery-watchdog-"), 1);
  assert.equal(entry.process.alive, false);
  assert.equal(sandbox.statusOf(entry).status, "restarting", "a read sees a restart, not a dead process");
  assert.ok(reasons(entry).includes("mcp_lost_process_stopped"));
  runThreads("mcp-recovery-");
  assert.equal(prompts(registry.get("vibe-test")).length, 1);
  assert.equal(types(entry, "turn/end").length + types(entry, "system/closed").length, 0);
});

test("a prompt to a process started without its Convertigo tools waits for the MCP within the turn, then Vibe gets it", () => {
  threads.length = 0;
  restarts.length = 0;
  const entry = fakeEntry();
  entry.convertigoMcpMissing = { source: "probe", error: "connection_refused" };
  const result = sandbox.C8O.agentBridge.vibePrompt({ handle: "vibe-test", prompt: "Liste les projets.", messageId: "msg-1" });
  assert.equal(result.status, "submitted");
  assert.match(String(result.requestId), /^mcp-wait-/);
  assert.equal(entry._written.length, 0, "Vibe without its tools never gets the message");
  assert.equal(entry.turnActive, true);
  const start = types(entry, "turn/start")[0];
  assert.equal(start.data.deferred, "convertigo_mcp");
  assert.equal(result.cursor, start.index + 1, "the panel reads the turn from its start");
  assert.deepEqual(reasons(entry), ["convertigo_mcp_unavailable_at_start"]);
  assert.equal(types(entry, "warning")[0].data.source, "probe");
  probes.push(REFUSED);
  runThreads("mcp-recovery-");
  const fresh = registry.get("vibe-test");
  const sent = prompts(fresh);
  assert.equal(sent[0].params.prompt[0].text, "Liste les projets.", "the message as the user wrote it: Vibe never saw it");
  assert.equal(sent[0].params.messageId, "msg-1");
  assert.equal(types(entry, "warning").find((event) => event.data.reason === "convertigo_mcp_restarted").data.resent, false);
  play(fresh, [answer(sent[0].id)]);
  assert.equal(types(entry, "turn/end").length, 1);
  assert.equal(fresh.turnActive, false);
});

test("a Stop while the turn waits for the MCP ends it at once; the wait then stops", () => {
  const entry = turn(12);
  play(entry, [notices[0], answer(12, "cancelled")]);
  const stopped = sandbox.C8O.agentBridge.interrupt({ handle: "vibe-test" });
  assert.equal(stopped.status, "interrupted");
  assert.equal(types(entry, "turn/end")[0].data.result.stopReason, "cancelled");
  assert.equal(entry.turnActive, false);
  probes.push(REFUSED, REFUSED);
  runThreads("mcp-recovery-");
  assert.equal(restarts.length, 0);
  assert.equal(types(entry, "turn/error").length, 0);
});

// Live, 25/11: a new conversation's empty session cannot be reloaded ("Session not found"), so the restarted Vibe starts
// a new one; that failed session/load in the turn's stream ended the turn in the Assistant, which reads every
// acp/response_error as the end of the turn.
test("a failed step of a restart within the turn is no failure of the turn", () => {
  const entry = turn(14);
  play(entry, [notices[0], answer(14, "cancelled")]);
  const fresh = fakeEntry("vibe-test", "s1");
  sandbox.adoptVibeTurn(fresh, entry);
  fresh.status = "starting";
  fresh.pending.put("2", { id: 2, method: "session/load" });
  play(fresh, [JSON.stringify({ jsonrpc: "2.0", id: 2, error: { code: -32602, message: "Session not found: s1" } })]);
  assert.equal(types(entry, "acp/response_error").length, 0);
  assert.equal(types(entry, "acp/response").filter((event) => event.data.method === "session/load").length, 1);
  fresh.status = "running";
  fresh.pending.put("3", { id: 3, method: "session/set_config_option" });
  play(fresh, [JSON.stringify({ jsonrpc: "2.0", id: 3, error: { code: -32602, message: "bad option" } })]);
  assert.equal(types(entry, "acp/response_error").length, 1, "once running, an error is reported as before");
});

test("a Stop before Vibe answered the cancelled turn: its late answer does not end the user's next turn", () => {
  const entry = turn(15);
  play(entry, [notices[0]]);
  assert.equal(sandbox.C8O.agentBridge.interrupt({ handle: "vibe-test" }).status, "interrupted");
  assert.equal(types(entry, "turn/end").length, 1);
  entry.pending.set("16", { id: 16, method: "session/prompt" });
  sandbox.pushEvent(entry, "turn/start", { requestId: 16 });
  play(entry, [answer(15, "cancelled")]);
  assert.equal(types(entry, "turn/end").length, 1, "the late answer is swallowed");
  assert.equal(types(entry, "acp/response_error").length, 0);
  assert.equal(entry.turnActive, true, "the new turn goes on");
  play(entry, [answer(16)]);
  assert.equal(types(entry, "turn/end").length, 2);
});

test("a read of the events waits through a restart in place and goes on with the new process", () => {
  const entry = turn(13);
  play(entry, [notices[0], answer(13, "cancelled")]);
  const cursor = entry.nextIndex;
  entry.status = "restarting";
  sandbox.stopEntryProcess(entry);
  runThreads("mcp-recovery-");
  const read = sandbox.C8O.agentBridge.events({ handle: "vibe-test", cursor: String(cursor), waitMs: "0" });
  assert.equal(read.ok, true);
  assert.ok(read.events.some((event) => event.type === "warning" && event.data.reason === "convertigo_mcp_restarted"));
  assert.equal(read.state.alive, true);
});

test("the start probes the MCP before Vibe starts, marks the process, and replaces a marked one once the MCP answers", () => {
  const probeAt = vibeSource.indexOf("var mcpProbeTarget = convertigoMcpProbeTarget(mcpEndpoint, options);");
  assert.ok(probeAt > 0 && probeAt < vibeSource.indexOf("startProcess(entry, env);"), "probed before the process starts");
  assert.match(vibeSource, /mcpAtStart = waitForConvertigoMcp\(mcpProbeTarget, CONVERTIGO_MCP_START_WAIT_MS, null, null\)\.last;/);
  assert.match(vibeSource, /entry\.convertigoMcpMissing = \{ source: "probe", error: mcpAtStart\.code, at: now\(\) \};/);
  const restartAt = vibeSource.indexOf("existing.convertigoMcpMissing && existing.turnActive !== true");
  assert.ok(restartAt > 0 && restartAt < vibeSource.indexOf("var requestedMcpTokenFingerprint = mcpBearerTokenFingerprint(options);"));
  assert.match(vibeSource.slice(restartAt, restartAt + 1200), /reason: "convertigo_mcp_restarted"[\s\S]*stopEntry\(existing, true\);/);
  assert.match(vibeSource, /if \(inPlaceOf !== null\) \{\n\s+adoptVibeTurn\(entry, inPlaceOf\);/);
  assert.equal(sandbox.convertigoMcpProbeTarget("http://127.0.0.1:18080/convertigo/api/mcp", { settingsProbe: "true" }), null, "a settings probe reads models only");
  assert.equal(sandbox.convertigoMcpProbeTarget("http://example.org/other", {}), null);
});
