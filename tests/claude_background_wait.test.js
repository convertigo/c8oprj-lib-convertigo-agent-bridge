// A Claude turn that ends while one of its background agents (Agent tool, run_in_background) still runs. Claude Code
// takes the task notification on its own and runs a new turn, but the Bridge used to send turn/end first, so the
// Assistant stopped reading and the user had to write "Continue" (a trial run of 31/10). The Bridge
// now keeps the turn open on Claude Code's system/task_* events, and writes a short continue itself, at most three
// times per user prompt, when Claude Code does not resume after a notification. The event shapes are those of Claude
// Code 2.1.314.
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
for (const file of ["agent_bridge_common.js", "agent_bridge_codex.js", "agent_bridge_vibe.js", "agent_bridge_claude.js"]) {
  vm.runInContext(fs.readFileSync(path.join(root, "js", file), "utf8"), sandbox, { filename: file });
}
sandbox.processAlive = () => true;

function turn() {
  const events = [];
  const written = [];
  const entry = {
    handle: "claude-test", provider: "claude", protocol: "claude-stream-json", status: "running", phase: "turn",
    sessionId: "a1ce30d5", nextIndex: 0, firstIndex: 0, lastAccess: 0, lastError: "", process: {}, pending: new Map(),
    writer: { write(text) { written.push(String(text)); }, newLine() {}, flush() {} },
    events: { add(event) { events.push(event); }, size() { return events.length; }, remove() { events.shift(); } },
    _events: events, _written: written
  };
  sandbox.pushEvent(entry, "turn/start", { requestId: 1, provider: "claude" });
  return entry;
}

const line = (message) => JSON.stringify(message);
const play = (entry, lines) => lines.forEach((text) => sandbox.handleClaudeStreamLine(entry, text, "stdout"));
const types = (entry, type) => entry._events.filter((event) => event.type === type);
const userMessages = (entry) => entry._written.map((w) => JSON.parse(w)).filter((m) => m.type === "user");
const started = (id, extra) => line(Object.assign({ type: "system", subtype: "task_started", task_id: id,
  tool_use_id: "toolu_" + id, description: "Frontend Svelte lots 4-5", subagent_type: "general-purpose",
  is_backgrounded: true, spawn_depth: 1, task_type: "local_agent" }, extra || {}));
const notified = (id) => line({ type: "system", subtype: "task_notification", task_id: id, tool_use_id: "toolu_" + id,
  status: "completed", output_file: "/tmp/tasks/" + id + ".output", summary: "Agent finished" });
const said = (id, text) => line({ type: "assistant", message: { id, role: "assistant", content: [{ type: "text", text }] } });
const result = (text) => line({ type: "result", subtype: "success", is_error: false, result: text, num_turns: 3,
  duration_ms: 1000, usage: { output_tokens: 10 } });
const waiting = "Backend terminé. J'attends sa notification pour continuer.";

function runWatchers() {
  const pending = threads.splice(0);
  pending.forEach((thread) => thread.runnable.run());
  return pending.length;
}

test("a result while a background agent runs keeps the turn open, and Claude Code's own resume ends it", () => {
  threads.length = 0;
  const entry = turn();
  play(entry, [started("a87dc"), said("m1", "Sous-agent lancé."), result(waiting)]);
  assert.equal(types(entry, "turn/end").length, 0, "the Assistant keeps reading the turn");
  assert.equal(entry.turnActive, true);
  assert.equal(entry.phase, "background");
  assert.equal(types(entry, "answer/chunk").length, 0, "the waiting message is not the answer");
  // Objects of the sandbox realm: compared through JSON.
  assert.deepEqual(JSON.parse(JSON.stringify(types(entry, "turn/background_wait")[0].data.tasks)), [{ id: "a87dc", description: "Frontend Svelte lots 4-5" }]);
  assert.match(types(entry, "progress/message")[0].data.text,
    /^Agent Bridge: the turn stays open until the background agent "Frontend Svelte lots 4-5" reports\.$/);

  play(entry, [notified("a87dc")]);
  assert.equal(threads.length, 1, "a resume check is scheduled after the notification");
  // Claude Code runs the notification turn by itself.
  play(entry, [line({ type: "stream_event", event: { type: "message_start", message: { id: "m2" } } })]);
  assert.equal(types(entry, "turn/background_resumed").length, 1);
  assert.ok(types(entry, "progress/message").some((event) => event.data.text === waiting), "the held text goes to the work log");
  runWatchers();
  assert.equal(userMessages(entry).length, 0, "no continue once Claude Code resumed");
  play(entry, [said("m2", "Rapport frontend reçu."), result("L'application est terminée.")]);
  assert.equal(types(entry, "turn/end").length, 1);
  assert.equal(entry.turnActive, false);
  assert.deepEqual(types(entry, "answer/chunk").map((event) => event.data.text), ["L'application est terminée."]);
});

test("without a resume after the notification the Bridge writes a continue, at most three times per user prompt", () => {
  threads.length = 0;
  const entry = turn();
  play(entry, [started("b1"), result(waiting), notified("b1")]);
  assert.equal(runWatchers(), 1);
  const sent = userMessages(entry);
  assert.equal(sent.length, 1);
  assert.match(sent[0].message.content[0].text,
    /^Note from the Agent Bridge: the background agent "Frontend Svelte lots 4-5" finished \(completed\); its result is in your task notifications\. Continue\.$/);
  assert.equal(types(entry, "turn/auto_continue")[0].data.count, 1);
  assert.ok(types(entry, "progress/message").some((event) => /it was asked to continue \(1\/3\)\.$/.test(event.data.text)));
  assert.equal(types(entry, "turn/end").length, 0, "the continue runs in the same Assistant turn");

  // The continue's turn starts another background agent and waits again: the counter keeps going...
  play(entry, [said("m3", "Je relance un agent."), started("b2"), result(waiting), notified("b2")]);
  runWatchers();
  play(entry, [said("m4", "Encore."), started("b3"), result(waiting), notified("b3")]);
  runWatchers();
  assert.equal(userMessages(entry).length, 3);
  // ...and past three continues the held answer ends the turn instead of a fourth one.
  play(entry, [said("m5", "Toujours."), started("b4"), result(waiting), notified("b4")]);
  runWatchers();
  assert.equal(userMessages(entry).length, 3, "no fourth continue");
  const end = types(entry, "turn/end");
  assert.equal(end.length, 1);
  assert.equal(end[0].data.backgroundWait, "continues_exhausted");
  assert.equal(types(entry, "answer/chunk").at(-1).data.text, waiting);
  assert.equal(entry.turnActive, false);
});

test("a later notification, a user prompt or a stop cancels a pending continue", () => {
  threads.length = 0;
  const entry = turn();
  play(entry, [started("c1"), started("c2"), result(waiting), notified("c1"), notified("c2")]);
  assert.equal(threads.length, 2);
  runWatchers();
  assert.equal(userMessages(entry).length, 1, "only the check of the last notification writes");

  const prompted = turn();
  play(prompted, [started("d1"), result(waiting), notified("d1")]);
  assert.equal(sandbox.claudeEndHeldTurn(prompted, "user_prompt"), true);
  runWatchers();
  assert.equal(userMessages(prompted).length, 0, "a user message arrived: no continue");
  assert.equal(types(prompted, "turn/end")[0].data.backgroundWait, "user_prompt");

  const stopped = turn();
  play(stopped, [started("e1"), result(waiting)]);
  sandbox.TURN_INTERRUPT_ADAPTERS["claude-stream-json"](stopped);
  assert.equal(types(stopped, "turn/end")[0].data.backgroundWait, "interrupted");
  assert.equal(stopped.turnActive, false);
});

test("background shells, an agent's own tasks and finished agents do not hold the turn", () => {
  threads.length = 0;
  const shell = turn();
  play(shell, [started("f1", { task_type: "local_bash", description: "npm run dev" }), result("Serveur lancé.")]);
  assert.equal(types(shell, "turn/end").length, 1, "a dev server in the background never ends");

  const nested = turn();
  play(nested, [started("g1", { owned_by_subagent: true, spawn_depth: 2 }), result("Fini.")]);
  assert.equal(types(nested, "turn/end").length, 1, "its notification goes to the agent that started it");

  const done = turn();
  play(done, [started("h1"), notified("h1"), result("Rapport intégré.")]);
  assert.equal(types(done, "turn/end").length, 1, "notified within the turn");
  assert.equal(threads.length, 0);

  // An agent resumed with SendMessage reports progress again: it is waited for again.
  const resumed = turn();
  play(resumed, [line({ type: "system", subtype: "task_progress", task_id: "h1" }), result(waiting)]);
  assert.equal(types(resumed, "turn/end").length, 1, "an unknown task id is ignored");
  done._events.length = 0;
  sandbox.pushEvent(done, "turn/start", { requestId: 2, provider: "claude" });
  play(done, [line({ type: "system", subtype: "task_progress", task_id: "h1", description: "Frontend Svelte lots 4-5" }), result(waiting)]);
  assert.equal(types(done, "turn/end").length, 0);
  assert.equal(types(done, "turn/background_wait").length, 1);
});
