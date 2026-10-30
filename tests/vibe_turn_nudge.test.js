// (harness of vibe_mcp_lost.test.js) A Vibe session that lost the Convertigo MCP: an HTTP 401 of the MCP during a call makes Vibe suspend the server for the
// session. Up to Vibe 3.0.2 every later call failed with a refusal of its Rust core, and the model tried again 52 times
// in 6 minutes (feedback group 3681d23e, Studio 8.4.6, 28/10); from 3.0.3 the calls fail with mcp_authorization_required,
// then mcp_unknown_route. The failure shapes below are those of vibe-acp 3.0.2 and 3.0.3 on a bench MCP answering 401.
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
vm.runInContext(fs.readFileSync(path.join(root, "js/agent_bridge_common.js"), "utf8"), sandbox, { filename: "agent_bridge_common.js" });
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


// mistral-large-4 ended 3 of its 4 early turns on a message that was only the name of a tool ("run_typescript", no call)
// and one on an announcement of its next step (usage tests 30/10). The Bridge nudges such a turn, at most twice, and never
// a question, a confirmation, a refused write, a stop or an error.
const update = (body) => JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: body } });
const say = (text) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const call = (id, title) => update({ sessionUpdate: "tool_call", toolCallId: id, title: title || "mcp_Convertigo.databaseobject_tree_get", status: "in_progress" });
const answer = (id, stopReason) => JSON.stringify({ jsonrpc: "2.0", id, result: { stopReason: stopReason || "end_turn" } });
const play = (entry, lines) => lines.forEach((line) => sandbox.handleAcpLine(entry, line, "stdout"));
const prompts = (entry) => entry._written.map((w) => JSON.parse(w)).filter((m) => m.method === "session/prompt");
const types = (entry, type) => entry._events.filter((event) => event.type === type);

function turn(id) {
  const entry = fakeEntry();
  entry.nextRequestId = 100;
  // The real pending map is a Java HashMap (put/get).
  entry.pending.put = (key, value) => entry.pending.set(key, value);
  entry.pending.set(String(id), { id, method: "session/prompt" });
  sandbox.pushEvent(entry, "turn/start", { requestId: id });
  return entry;
}

test("a turn that ends on a bare tool name is nudged in the same turn, and the nudge's answer ends it", () => {
  const entry = turn(7);
  play(entry, [call("e1", "bash: ls"), say("`run_typescript`"), answer(7)]);
  assert.equal(types(entry, "turn/end").length, 0, "the turn goes on");
  assert.equal(entry.turnActive, true);
  const sent = prompts(entry);
  assert.equal(sent.length, 1);
  assert.match(sent[0].params.prompt[0].text, /only the name of the tool `run_typescript`, with no call to it/);
  const nudge = types(entry, "turn/nudge")[0].data;
  assert.equal(nudge.reason, "tool_name");
  assert.equal(nudge.count, 1);
  assert.equal(nudge.endedRequestId, 7);
  assert.match(types(entry, "progress/message")[0].data.text, /^Agent Bridge: the agent ended its turn on the tool name `run_typescript`/);
  play(entry, [call("e2"), say("Done: the field is added."), answer(nudge.requestId)]);
  assert.equal(types(entry, "turn/end").length, 1);
  assert.equal(types(entry, "turn/end")[0].data.requestId, nudge.requestId);
  assert.equal(entry.turnActive, false);
});

test("any tool of the session counts, not only run_typescript; plain words do not", () => {
  const entry = turn(7);
  play(entry, [call("e1", "mcp_Convertigo.databaseobject_tree_apply"), say("mcp_Convertigo.databaseobject_tree_apply"), answer(7)]);
  assert.equal(types(entry, "turn/nudge")[0].data.tool, "mcp_Convertigo.databaseobject_tree_apply");
  const mcp = turn(8);
  play(mcp, [say("Convertigo_project-lint."), answer(8)]);
  assert.equal(types(mcp, "turn/nudge").length, 1, "a Convertigo MCP tool name");
  const junk = turn(10);
  play(junk, [say("run_typescript rhyumbe"), answer(10)]);
  assert.equal(types(junk, "turn/nudge")[0].data.tool, "run_typescript", "the name and one stray token");
  for (const [id, text] of [[12, "Task completed."], [13, "Edit terminé"], [14, "todo ok"]]) {
    const plain = turn(id);
    play(plain, [say(text), answer(id)]);
    assert.equal(types(plain, "turn/nudge").length, 0, text + ": a builtin name that is also a word, with another word");
  }
  const alone = turn(15);
  play(alone, [say("task"), answer(15)]);
  assert.equal(types(alone, "turn/nudge").length, 1, "a builtin name alone is still a printed call");
  const prose = turn(11);
  play(prose, [say("run_typescript a été lancé et la page est prête"), answer(11)]);
  assert.equal(types(prose, "turn/nudge").length, 0, "a sentence that starts with a tool name");
  const word = turn(9);
  play(word, [say("Done"), answer(9)]);
  assert.equal(types(word, "turn/nudge").length, 0);
  assert.equal(types(word, "turn/end").length, 1);
});

test("a call written as a function call, with its arguments in parentheses and nothing else, is nudged", () => {
  const typed = turn(22);
  play(typed, [say('run_typescript(code="async function main() {\n  const r = await tools.mcp_Convertigo.batch_call({ calls: [] });\n  return r;\n}")'), answer(22)]);
  const [nudge] = types(typed, "turn/nudge");
  assert.equal(nudge.data.tool, "run_typescript", "a replay of 30/10");
  assert.equal(nudge.data.reason, "printed_call");
  const mcp = turn(23);
  play(mcp, [say('mcp_Convertigo.project_lint(project="Shop")'), answer(23)]);
  assert.equal(types(mcp, "turn/nudge")[0].data.tool, "mcp_Convertigo.project_lint");
  for (const [id, text] of [[24, "run_typescript(code) a échoué, je regarde pourquoi."], [25, "Lancé : run_typescript(code)"],
    [26, "Tasks(3)"]]) {
    const prose = turn(id);
    play(prose, [say(text), answer(id)]);
    assert.equal(types(prose, "turn/nudge").length, 0, text);
  }
});

test("a compound tool name glued to a stray word is nudged; a plain word or a sentence is not", () => {
  const glued = turn(16);
  play(glued, [say("run_typescriptInteraction"), answer(16)]);
  assert.equal(types(glued, "turn/nudge")[0].data.tool, "run_typescript", "the name glued to a word (a replay of 30/10)");
  const seen = turn(17);
  play(seen, [call("e2", "mcp_Convertigo.project_lint"), say("mcp_Convertigo.project_lintVerification."), answer(17)]);
  assert.equal(types(seen, "turn/nudge")[0].data.tool, "mcp_Convertigo.project_lint", "a tool of the session, glued");
  for (const [id, text] of [[18, "Tasks"], [19, "Editorial"], [21, "run_typescriptInteraction terminée avec succès"]]) {
    const other = turn(id);
    play(other, [say(text), answer(id)]);
    assert.equal(types(other, "turn/nudge").length, 0, text);
  }
});

test("a short announcement after the turn acted is nudged; a question, a confirmation request or a long report is not", () => {
  const announce = turn(7);
  play(announce, [call("e1", "mcp_Convertigo.databaseobject_tree_apply"), say("Le vrai coupable est le filtre. Je vais réécrire le filtre avec une expression plus simple."), answer(7)]);
  assert.equal(types(announce, "turn/nudge")[0].data.reason, "announcement");
  assert.match(prompts(announce)[0].params.prompt[0].text, /If you meant to do it, do it now with a tool call\. If the user only asked for a plan or an explanation, or you need their answer, reply with one short closing sentence instead\./);
  for (const text of [
    "Je vais modifier le formulaire. Voulez-vous que je continue ?",
    "Je vais supprimer le champ : confirmez-vous avant que je l'applique.",
    "I will update the page; let me know if you prefer another layout.",
    "Le champ est ajouté.",
    "x".repeat(700) + ". I will continue."
  ]) {
    const entry = turn(7);
    play(entry, [call("e1", "mcp_Convertigo.databaseobject_tree_apply"), say(text), answer(7)]);
    assert.equal(types(entry, "turn/nudge").length, 0, text.slice(0, 50));
    assert.equal(types(entry, "turn/end").length, 1, text.slice(0, 50));
  }
});

test("a refused write, a stop or an error ends the turn as before", () => {
  const refused = turn(7);
  play(refused, [call("e1", "mcp_Convertigo.nocode_form_edit"),
    update({ sessionUpdate: "tool_call_update", toolCallId: "e1", status: "completed",
      rawOutput: { type: "success", content: [{ type: "text", text: JSON.stringify({ status: "refused", saved: false, reason: "user" }) }] } }),
    say("Je vais attendre votre accord."), answer(7)]);
  assert.equal(types(refused, "turn/nudge").length, 0, "a write the user refused");
  const stopped = turn(7);
  sandbox.pushEvent(stopped, "turn/interrupt_requested", { protocol: "acp" });
  play(stopped, [say("run_typescript"), answer(7)]);
  assert.equal(types(stopped, "turn/nudge").length, 0, "after the Stop button");
  const cancelled = turn(7);
  play(cancelled, [say("run_typescript"), answer(7, "cancelled")]);
  assert.equal(types(cancelled, "turn/nudge").length, 0, "a cancelled turn");
  const failed = turn(7);
  play(failed, [say("run_typescript"), JSON.stringify({ jsonrpc: "2.0", id: 7, error: { code: -32603, message: "boom" } })]);
  assert.equal(types(failed, "turn/nudge").length, 0);
  assert.equal(types(failed, "turn/error").length, 1);
});

test("at most two nudges per turn, then the turn ends as today; the next turn counts again", () => {
  const entry = turn(7);
  play(entry, [say("run_typescript"), answer(7)]);
  play(entry, [say("run_typescript"), answer(types(entry, "turn/nudge")[0].data.requestId)]);
  play(entry, [say("run_typescript"), answer(types(entry, "turn/nudge")[1].data.requestId)]);
  assert.equal(types(entry, "turn/nudge").length, 2);
  assert.equal(types(entry, "turn/end").length, 1);
  assert.equal(entry.turnActive, false);
  entry.pending.set("20", { id: 20, method: "session/prompt" });
  sandbox.pushEvent(entry, "turn/start", { requestId: 20 });
  play(entry, [say("run_typescript"), answer(20)]);
  assert.equal(types(entry, "turn/nudge").length, 3, "a new turn of the user starts at zero");
});

// Review of 4f945f6 (30/10): asked for a plan only, the agent ends on "Ensuite, je créerai la page de liste." A nudge
// saying "do that step now" could make it change the project against the request.
test("a plan or an explanation ends the turn: no tool call, or reads only, before the announcement", () => {
  const plan = turn(7);
  play(plan, [say("Voici le plan. D'abord la table, puis les séquences. Ensuite, je créerai la page de liste."), answer(7)]);
  assert.equal(types(plan, "turn/nudge").length, 0, "no tool call");
  const reads = turn(8);
  play(reads, [call("e1", "mcp_Convertigo.databaseobject_tree_get"), call("e2", "mcp_Convertigo.project_lint"),
    call("e3", "bash: grep -n isbn app.js"), call("e4", "read_file"),
    say("J'ai lu le projet. Ensuite, je créerai la page de liste."), answer(8)]);
  assert.equal(types(reads, "turn/nudge").length, 0, "reads only, a shell command counts as a read");
  assert.equal(types(reads, "turn/end").length, 1);
});

test("a closing that hands over to the user is not nudged, even after a write", () => {
  for (const text of ["C'est en place. Je vais maintenant vous laisser tester la page.", "Done. I'll let you test it now."]) {
    const entry = turn(7);
    play(entry, [call("e1", "mcp_Convertigo.databaseobject_tree_apply"), say(text), answer(7)]);
    assert.equal(types(entry, "turn/nudge").length, 0, text);
  }
});

// A replay of 30/10 ended a turn on 'run_typescriptatischeck{"code": "async function main() {...}"}': the call written out.
test("a call written out as text (tool name, maybe glued to a stray word, then JSON arguments) is nudged", () => {
  const glued = turn(7);
  play(glued, [say('run_typescriptatischeck{"code": "async function main() {\\n  await tools.mcp_playwright.browser_snapshot({});\\n}"}'), answer(7)]);
  const nudge = types(glued, "turn/nudge")[0].data;
  assert.equal(nudge.reason, "printed_call");
  assert.equal(nudge.tool, "run_typescript");
  assert.match(prompts(glued)[0].params.prompt[0].text, /wrote a call to the tool `run_typescript` as text instead of making it/);
  const mcp = turn(8);
  play(mcp, [say('mcp_Convertigo.databaseobject_tree_get {"target": "App"}'), answer(8)]);
  assert.equal(types(mcp, "turn/nudge")[0].data.tool, "mcp_Convertigo.databaseobject_tree_get");
  for (const [id, text] of [[9, 'Le résultat est {"rows": 3}'], [10, 'task{"a": 1}'], [11, 'run_typescript{not json}'], [12, 'Voici la config : {"a": 1}']]) {
    const entry = turn(id);
    play(entry, [say(text), answer(id)]);
    assert.equal(types(entry, "turn/nudge").length, 0, text);
  }
});

test("one rule: the recorded printed calls are nudged with their reason, the answers that look like them are not", () => {
  const printed = [
    ["run_typescript", "tool_name", "run_typescript"],
    ["run_typescript rhyumbe", "tool_name", "run_typescript"],
    ["run_typescriptInteraction", "tool_name", "run_typescript"],
    ["run_typescript()", "tool_name", "run_typescript"],
    ['run_typescriptatischeck{"code": "async function main() {}"}', "printed_call", "run_typescript"],
    ['run_typescript進{"code": "async function main() {}"}', "printed_call", "run_typescript"],
    ["run_typescripté", "tool_name", "run_typescript"],
    ['run_typescript_1:{"code": "async function main() {}"}', "printed_call", "run_typescript"],
    ["run_typescriptx(code=1)", "printed_call", "run_typescript"],
    ["run_typescript_helper", "tool_name", "run_typescript"],
    ['run_typescript(code="async function main() {\\n  return 1;\\n}")', "printed_call", "run_typescript"],
    ['mcp_Convertigo.databaseobject_tree_get {"target": "App"}', "printed_call", "mcp_Convertigo.databaseobject_tree_get"]
  ];
  let id = 40;
  for (const [text, reason, tool] of printed) {
    const entry = turn(++id);
    play(entry, [say(text), answer(id)]);
    const nudge = types(entry, "turn/nudge")[0];
    assert.ok(nudge, text);
    assert.deepEqual([nudge.data.reason, nudge.data.tool], [reason, tool], text);
  }
  for (const text of ["Task completed.", "run_typescript ?", "run_typescript_1? ok", "run_typescript{not json}",
    "run_typescript a été lancé et la page est prête",
    "Voici le plan : d'abord la table, ensuite la page.", 'Le résultat est {"rows": 3}', "Tasks(3)"]) {
    const entry = turn(++id);
    play(entry, [say(text), answer(id)]);
    assert.equal(types(entry, "turn/nudge").length, 0, text);
  }
});
