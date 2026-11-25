// A turn ended with "corrig\u00e9, build OK" on objects nothing had run or shown since their last change. lib_ConvertigoMCP
// writes, per Tigo conversation, what its writes left unproven (server store, lib_ConvertigoMCP.proofState: the
// conversation id to {"v":1, "unproven":[{qname, project, kind, changedAt}], ...}). When the model's last message would
// end a turn, the changes of the turn still unproven (UI ones minus those a Playwright call the Bridge saw complete
// after their change proved) get one corrective prompt if the answer claims success without saying they are not
// verified, and a warning {phase:"turn/proof", reason:"unverified_changes"} just before the turn/end. The store
// contents below are fakes in the contract's shape.
// node --test tests/vibe_unproven_changes.test.js
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
vm.runInContext(fs.readFileSync(process.env.BRIDGE_COMMON_PATH || path.join(root, "js/agent_bridge_common.js"), "utf8"), sandbox, { filename: "agent_bridge_common.js" });
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
const say = (text, messageId) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text }, messageId: messageId || "m" + text.length });
const call = (id, title, rawInput) => update({ sessionUpdate: "tool_call", toolCallId: id, title, status: "in_progress", rawInput: rawInput || {} });
const done = (id, status) => update({ sessionUpdate: "tool_call_update", toolCallId: id, status: status || "completed", rawOutput: { type: "success" } });
const answer = (id, stopReason) => JSON.stringify({ jsonrpc: "2.0", id, result: { stopReason: stopReason || "end_turn" } });
const play = (entry, lines) => lines.forEach((line) => sandbox.handleAcpLine(entry, line, "stdout"));
const prompts = (entry) => entry._written.map((w) => JSON.parse(w)).filter((m) => m.method === "session/prompt");
const types = (entry, type) => entry._events.filter((event) => event.type === type);

// The server store: a Java map per key, the proof states a Java map from the conversation id to a JSON string.
let clock = 5000000;
sandbox.now = () => clock;
const store = new Map();
sandbox.context = { server: { get: (key) => (store.has(key) ? store.get(key) : null), set: (key, value) => store.set(key, value) } };
function proofState(conversationId, unproven, extra) {
  const states = { get: (id) => (id === conversationId ? JSON.stringify(Object.assign({ v: 1, at: clock, writes: unproven.length, unproven, lastProof: null }, extra || {})) : null) };
  store.set("lib_ConvertigoMCP.proofState", states);
}
function turn(id) {
  const entry = fakeEntry();
  entry.nextRequestId = 100;
  entry.mcpConversationId = "agent-conv-1";
  entry.pending.put = (key, value) => entry.pending.set(key, value);
  entry.pending.set(String(id), { id, method: "session/prompt" });
  sandbox.pushEvent(entry, "turn/start", { requestId: id });
  return entry;
}
const item = (qname, kind, changedAt) => ({ qname, project: "Shop", kind, changedAt });

test("a success claim, in French or English, as whole words and not negated; a mention that something is not verified", () => {
  for (const text of ["C'est corrig\u00e9.", "Le bug est r\u00e9solu et le build OK.", "Tout fonctionne maintenant.", "La page est op\u00e9rationnelle.",
    "C\u2019est bon, j'ai termin\u00e9.", "Fixed: the list loads.", "The form works.", "Build succeeded, the page is working.", "Le probl\u00e8me est r\u00e9gl\u00e9."]) {
    assert.equal(sandbox.vibeClaimsSuccess(text), true, text);
  }
  for (const text of ["Le formulaire ne fonctionne pas encore.", "Le build n'est pas fonctionnel.", "It is not working yet.", "The page isn't working.",
    "J'ai ajout\u00e9 le champ.", "Voici le plan.", "unfixed", "networking", "dysfonctionnement"]) {
    assert.equal(sandbox.vibeClaimsSuccess(text), false, text);
  }
  for (const text of ["SeqA est corrig\u00e9e mais non v\u00e9rifi\u00e9e.", "Je n'ai pas pu v\u00e9rifier la page.", "Il reste \u00e0 v\u00e9rifier l'\u00e9cran.",
    "La s\u00e9quence n'a pas \u00e9t\u00e9 test\u00e9e.", "Fixed, but not verified.", "I could not verify the page.", "The change is unverified."]) {
    assert.equal(sandbox.vibeSaysUnverified(text), true, text);
  }
  assert.equal(sandbox.vibeSaysUnverified("C'est corrig\u00e9 et v\u00e9rifi\u00e9 par requestable-execute."), false);
});

test("an answer that claims success over changes of the turn nothing proved gets one corrective prompt, then a warning before the turn ends", () => {
  const entry = turn(7);
  proofState("agent-conv-1", [item("Shop.sq:SaveOrder", "backend", clock + 10), item("Shop.Mobile.Orders", "ui", clock + 20),
    item("Shop.sq:Old", "backend", clock - 60000)]);
  clock += 100;
  play(entry, [call("e1", "mcp_Convertigo.databaseobject_tree_apply"), done("e1"), say("C'est corrig\u00e9 et le build est OK."), answer(7)]);
  assert.equal(types(entry, "turn/end").length, 0, "the turn goes on");
  const sent = prompts(entry);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].params.prompt[0].text, "Note from the Agent Bridge: your answer says the work is done, but 2 object(s) you changed in this turn "
    + "have no proof after their last change: `Shop.sq:SaveOrder` (backend), `Shop.Mobile.Orders` (ui). Prove them now: `requestable-execute` "
    + "for a sequence or a transaction, `browser-verify` for a page. If you cannot, tell the user clearly which ones are not verified and why. "
    + "Never call them fixed, working or build OK without that proof.");
  const nudge = types(entry, "turn/nudge")[0].data;
  assert.deepEqual([nudge.reason, nudge.count, nudge.max, nudge.itemCount], ["unproven_changes", 1, 1, 2]);
  assert.equal(entry.turnNudges, 0, "not counted in VIBE_TURN_NUDGES_MAX");
  assert.match(types(entry, "progress/message")[0].data.text, /^Agent Bridge: the agent called its work done with 2 change\(s\) not proven/);
  // The model proves the sequence (the MCP drops it), says the page is not verified: the turn ends with the warning.
  proofState("agent-conv-1", [item("Shop.Mobile.Orders", "ui", clock - 80)]);
  play(entry, [say("SaveOrder est prouv\u00e9e ; la page Orders n'est pas v\u00e9rifi\u00e9e (pas de navigateur)."), answer(sent[0].id)]);
  assert.equal(prompts(entry).length, 1, "one corrective prompt per user message");
  const warning = types(entry, "warning").find((event) => event.data.reason === "unverified_changes");
  assert.deepEqual(JSON.parse(JSON.stringify(warning.data)), { phase: "turn/proof", reason: "unverified_changes",
    items: [{ qname: "Shop.Mobile.Orders", kind: "ui" }], count: 1, nudged: true, message: "1 change(s) not proven after their last change" });
  const end = types(entry, "turn/end")[0];
  assert.ok(warning.index < end.index, "the warning comes before the turn/end");
  assert.equal(entry.turnActive, false);
});

test("a UI change a Playwright browser call proved after it is dropped; one before it, or a failed call, is not", () => {
  const entry = turn(8);
  proofState("agent-conv-1", [item("Shop.Mobile.Orders", "ui", clock + 5), item("Shop.Mobile.Cart", "ui", clock + 50)]);
  clock += 10;
  play(entry, [call("p1", "mcp_playwright.browser_snapshot"), done("p1")]);
  clock += 100;
  play(entry, [call("p2", "mcp_playwright.browser_click"), done("p2", "failed"), say("La page fonctionne."), answer(8)]);
  const nudge = types(entry, "turn/nudge")[0].data;
  assert.deepEqual(JSON.parse(JSON.stringify(nudge.items)), [{ qname: "Shop.Mobile.Cart", kind: "ui" }], "Orders was shown after its change");
  const code = turn(9);
  proofState("agent-conv-1", [item("Shop.Mobile.Cart", "ui", clock + 1)]);
  clock += 10;
  play(code, [call("r1", "run_typescript", { code: "async function main() { return await tools.mcp_playwright.browser_snapshot({}); }" }), done("r1"),
    say("The page works."), answer(9)]);
  assert.equal(types(code, "turn/nudge").length, 0, "a snapshot run from run_typescript proves the page too");
  assert.equal(types(code, "warning").length, 0);
  assert.equal(types(code, "turn/end").length, 1);
});

test("an answer that already says what is not verified, or claims nothing, is not nudged but the warning is pushed", () => {
  for (const text of ["SaveOrder est corrig\u00e9e mais non v\u00e9rifi\u00e9e.", "J'ai modifi\u00e9 SaveOrder."]) {
    const entry = turn(10);
    proofState("agent-conv-1", [item("Shop.sq:SaveOrder", "backend", clock + 1)]);
    clock += 10;
    play(entry, [say(text), answer(10)]);
    assert.equal(prompts(entry).length, 0, text);
    const warning = types(entry, "warning").find((event) => event.data.reason === "unverified_changes").data;
    assert.equal(warning.nudged, false, text);
    assert.equal(warning.count, 1);
  }
});

test("its own budget: the proof prompt comes after the two other nudges of the turn, once", () => {
  const entry = turn(11);
  proofState("agent-conv-1", [item("Shop.sq:SaveOrder", "backend", clock + 1)]);
  clock += 10;
  play(entry, [say("run_typescript"), answer(11)]);
  play(entry, [say("run_typescript"), answer(types(entry, "turn/nudge")[0].data.requestId)]);
  play(entry, [say("C'est corrig\u00e9."), answer(types(entry, "turn/nudge")[1].data.requestId)]);
  assert.deepEqual(types(entry, "turn/nudge").map((n) => n.data.reason), ["tool_name", "tool_name", "unproven_changes"]);
  play(entry, [say("C'est corrig\u00e9."), answer(types(entry, "turn/nudge")[2].data.requestId)]);
  assert.equal(types(entry, "turn/end").length, 1);
  assert.equal(types(entry, "warning").filter((event) => event.data.reason === "unverified_changes")[0].data.nudged, true);
});

test("no data, an older MCP, changes of earlier turns, a Stop: nothing, or the warning alone", () => {
  for (const setup of [() => store.clear(), () => store.set("lib_ConvertigoMCP.proofState", { get: () => "not json" }),
    () => store.set("lib_ConvertigoMCP.proofState", { get: () => JSON.stringify({ v: 2, unproven: [item("Shop.sq:A", "backend", clock + 1)] }) }),
    () => proofState("another-conversation", [item("Shop.sq:A", "backend", clock + 1)]),
    () => proofState("agent-conv-1", [item("Shop.sq:A", "backend", 1)])]) {
    const entry = turn(12);
    setup();
    clock += 10;
    play(entry, [say("C'est corrig\u00e9."), answer(12)]);
    assert.equal(prompts(entry).length, 0);
    assert.equal(types(entry, "warning").length, 0);
    assert.equal(types(entry, "turn/end").length, 1);
  }
  const stopped = turn(13);
  proofState("agent-conv-1", [item("Shop.sq:A", "backend", clock + 1)]);
  clock += 10;
  sandbox.pushEvent(stopped, "turn/interrupt_requested", { protocol: "acp" });
  play(stopped, [say("C'est corrig\u00e9."), answer(13, "cancelled")]);
  assert.equal(prompts(stopped).length, 0, "never after a Stop");
  assert.equal(types(stopped, "warning")[0].data.reason, "unverified_changes", "the changes stay unproven");
});

test("at most 15 items in the prompt and the warning, with the total count", () => {
  const entry = turn(14);
  proofState("agent-conv-1", Array.from({ length: 20 }, (_, i) => item("Shop.sq:S" + i, "backend", clock + 1)));
  clock += 10;
  play(entry, [say("All fixed."), answer(14)]);
  assert.match(prompts(entry)[0].params.prompt[0].text, /`Shop\.sq:S14` \(backend\) and 5 more\. Prove them now/);
  play(entry, [say("S0 to S19 are not verified."), answer(prompts(entry)[0].id)]);
  const warning = types(entry, "warning").find((event) => event.data.reason === "unverified_changes").data;
  assert.equal(warning.items.length, 15);
  assert.equal(warning.count, 20);
  assert.equal(warning.message, "20 change(s) not proven after their last change");
});
