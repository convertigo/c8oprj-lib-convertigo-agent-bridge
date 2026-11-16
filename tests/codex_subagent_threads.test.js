// Codex sub-agents are child threads of the same app-server process (spawn_agent, multi_agent on by default): their
// turn/started, items, deltas and turn/completed reach the Bridge with the child's threadId. Only the conversation's own
// thread ends the Tigo turn, gives the answer, the plan and the turn id Stop interrupts; a child's work is shown as
// tool events and progress lines named after the sub-agent. The fixtures are real Codex 0.153.4 app-server transcripts
// (gpt-6-astra, effort low): a main agent delegates to one sub-agent, waits for it, then integrates its report.
// node --test tests/codex_subagent_threads.test.js
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
for (const file of ["agent_bridge_common.js", "agent_bridge_codex.js", "agent_bridge_vibe.js", "agent_bridge_claude.js"]) {
  vm.runInContext(fs.readFileSync(path.join(root, "js", file), "utf8"), sandbox, { filename: file });
}
sandbox.now = () => Date.now();

function fakeEntry(fields = {}) {
  const events = [];
  const written = [];
  return Object.assign({
    handle: "codex-test", provider: "codex", protocol: "codex-app-server", status: "running", phase: "turn",
    sessionId: "", codexThreadId: "", activeTurnId: "", codexTurnEnded: false,
    nextIndex: 0, firstIndex: 0, lastAccess: 0, lastError: "", process: {}, pending: new Map(),
    writer: { write(text) { written.push(String(text)); }, newLine() {}, flush() {} },
    events: { add(event) { events.push(event); }, size() { return events.length; }, remove() { events.shift(); } },
    _events: events, _written: written
  }, fields);
}

function readFixture(name) {
  return fs.readFileSync(path.join(root, "tests", "fixtures", name), "utf8").split("\n").filter((line) => line.trim().length);
}

// What codexPrompt does before the transcript: the thread is known, the turn was submitted as request 3.
function replay(name) {
  const lines = readFixture(name);
  const messages = lines.map((line) => JSON.parse(line));
  const main = messages.find((message) => message.method === "thread/started").params.thread;
  const mainTurn = messages.find((message) => message.method === "turn/started" && message.params.threadId === main.id).params.turn;
  const childTurns = messages.filter((message) => message.method === "turn/started" && message.params.threadId !== main.id);
  assert.equal(childTurns.length, 1, name + " has one sub-agent turn");
  const child = { threadId: childTurns[0].params.threadId, turnId: childTurns[0].params.turn.id };
  const entry = fakeEntry({ sessionId: main.id, codexThreadId: main.id });
  sandbox.pushEvent(entry, "turn/start", { requestId: 3, provider: "codex", threadId: main.id });
  const steps = [];
  for (let i = 0; i < lines.length; i++) {
    const before = entry._events.length;
    sandbox.handleCodexAppServerLine(entry, lines[i], "stdout");
    steps.push({ message: messages[i], events: entry._events.slice(before), turnActive: entry.turnActive, activeTurnId: entry.activeTurnId, codexTurnEnded: entry.codexTurnEnded });
  }
  return { entry, steps, main, mainTurn, child, events: entry._events };
}

const finalText = (run) => run.steps.filter((step) => step.message.method === "item/completed" && step.message.params.threadId === run.main.id &&
  step.message.params.item.type === "agentMessage" && step.message.params.item.phase === "final_answer").map((step) => step.message.params.item.text).pop();
const childReport = (run) => run.steps.filter((step) => step.message.method === "item/completed" && step.message.params.threadId === run.child.threadId &&
  step.message.params.item.type === "agentMessage" && step.message.params.item.phase === "final_answer").map((step) => step.message.params.item.text).pop();

for (const fixture of ["codex-0.153.4-subagent.ndjson", "codex-0.153.4-subagent-tool.ndjson"]) {
  test(fixture + ": only the main thread's turn/completed ends the turn", () => {
    const run = replay(fixture);
    const childEnd = run.steps.find((step) => step.message.method === "turn/completed" && step.message.params.threadId === run.child.threadId);
    const mainEnd = run.steps.find((step) => step.message.method === "turn/completed" && step.message.params.threadId === run.main.id);
    assert.ok(childEnd && mainEnd, "the transcript has both turn ends");
    assert.ok(run.steps.indexOf(childEnd) < run.steps.indexOf(mainEnd), "the sub-agent ends first");
    assert.deepEqual(childEnd.events.map((event) => event.type).filter((type) => type.indexOf("turn/") === 0), [], "no turn event for the child's end");
    assert.equal(childEnd.codexTurnEnded, false);
    assert.equal(childEnd.turnActive, true, "the Bridge still sees the turn running (MCP lease, Stop)");
    const ends = run.events.filter((event) => event.type === "turn/end");
    assert.equal(ends.length, 1);
    assert.ok(mainEnd.events.includes(ends[0]), "the turn ends on the main thread's turn/completed");
    assert.equal(ends[0].data.threadId, run.main.id);
    assert.equal(ends[0].data.turnId, run.mainTurn.id);
    assert.equal(run.entry.turnActive, false);
  });

  test(fixture + ": the answer is the main agent's, the sub-agent's report is its work", () => {
    const run = replay(fixture);
    const answer = run.events.filter((event) => event.type === "answer/chunk" && event.data.phase === "final_answer").map((event) => event.data.text).join("");
    assert.equal(answer.trim(), finalText(run).trim());
    assert.match(answer, /^Integrated: /);
    const report = childReport(run);
    assert.ok(report && report.length);
    const childProgress = run.events.filter((event) => event.data && event.data.subagent && event.data.subagent.threadId === run.child.threadId);
    assert.ok(childProgress.length > 0, "the sub-agent's work is shown");
    const reportLine = run.events.find((event) => event.type === "progress/message" && event.data.subagentPhase === "final_answer");
    assert.ok(reportLine, "its report is a progress line");
    assert.equal(reportLine.data.text, "[" + reportLine.data.subagent.name + "] " + report);
    assert.equal(reportLine.data.phase, "commentary");
    assert.equal(reportLine.data.subagent.threadId, run.child.threadId);
    // one sub-agent card: running when it starts, completed with its report when it ends
    const cards = run.events.filter((event) => event.data && event.data.callId === "codex-subagent:" + run.child.threadId);
    assert.deepEqual(cards.map((event) => [event.type, event.data.status]), [["tool/start", "running"], ["tool/update", "completed"]]);
    assert.equal(cards[1].data.detail, report);
    assert.equal(cards[0].data.title, "[" + cards[0].data.subagent.name + "] sub-agent");
    // the main agent's wait is shown as a tool that runs until the report comes
    const waits = run.events.filter((event) => event.data && event.data.toolName === "wait");
    assert.deepEqual(waits.map((event) => [event.type, event.data.status]), [["tool/start", "running"], ["tool/update", "completed"]]);
  });

  test(fixture + ": the conversation keeps its thread and the turn Stop interrupts", () => {
    const run = replay(fixture);
    const childStart = run.steps.find((step) => step.message.method === "turn/started" && step.message.params.threadId === run.child.threadId);
    assert.equal(childStart.activeTurnId, run.mainTurn.id, "a child's turn/started does not replace the turn id");
    assert.equal(run.entry.activeTurnId, run.mainTurn.id);
    assert.equal(run.entry.codexThreadId, run.main.id);
    assert.equal(run.entry.sessionId, run.main.id);
    assert.equal(run.events.filter((event) => event.type === "session/update" && event.data.reportedSessionId === run.child.threadId).length, 0);
    assert.equal(run.events.filter((event) => event.type === "turn/start" && event.data.threadId === run.child.threadId).length, 0);
    assert.equal(run.entry.codexSubagents[run.child.threadId].status, "completed");
  });
}

test("a sub-agent's shell call is a tool event under its name, without the item that would retitle it", () => {
  const run = replay("codex-0.153.4-subagent-tool.ndjson");
  const calls = run.events.filter((event) => (event.type === "tool/start" || event.type === "tool/update") && event.data.itemType === "commandExecution");
  assert.deepEqual(calls.map((event) => event.type), ["tool/start", "tool/update"]);
  for (const call of calls) {
    assert.equal(call.data.subagent.name, "count");
    assert.equal(call.data.title, "[count] /bin/zsh -lc 'ls -1'");
    assert.equal(call.data.item, undefined);
  }
  assert.equal(calls[1].data.status, "completed");
  const commentary = run.events.filter((event) => event.type === "progress/message" && event.data.subagent && event.data.subagentPhase === "commentary");
  assert.equal(commentary.length, 1);
  assert.match(commentary[0].data.text, /^\[count\] I.ll list the current directory/);
  // the main agent's own commentary streams as before, as its own
  assert.ok(run.events.some((event) => event.type === "answer/chunk" && event.data.phase === "commentary" && !event.data.subagent && /delegate the count/.test(event.data.text)));
  assert.ok(!run.events.some((event) => event.type === "answer/chunk" && /list the current directory/.test(event.data.text)), "the child's commentary is not streamed as the main agent's");
});

test("a child thread announced by thread/started (spawn_agent v1) never becomes the conversation's thread", () => {
  for (const mainKnown of [true, false]) {
    const entry = fakeEntry(mainKnown ? { sessionId: "main-1", codexThreadId: "main-1", activeTurnId: "turn-main" } : {});
    sandbox.handleCodexAppServerLine(entry, JSON.stringify({ method: "thread/started", params: { thread: {
      id: "child-1", parentThreadId: "main-1", agentNickname: "Euclid", agentRole: "worker",
      source: { subAgent: { thread_spawn: { parent_thread_id: "main-1", depth: 1, agent_path: null, agent_nickname: "Euclid", agent_role: "worker" } } }
    } } }), "stdout");
    assert.equal(entry.codexThreadId, mainKnown ? "main-1" : "", "main known: " + mainKnown);
    assert.equal(entry.sessionId, mainKnown ? "main-1" : "");
    assert.deepEqual(entry._events.map((event) => event.type), ["codex/subagent"]);
    assert.equal(entry.codexSubagents["child-1"].name, "Euclid");
  }
});

test("a child's errors, plan, reasoning and deltas are not the main agent's", () => {
  const entry = fakeEntry({ sessionId: "main-1", codexThreadId: "main-1", activeTurnId: "turn-main" });
  const send = (method, params) => sandbox.handleCodexAppServerLine(entry, JSON.stringify({ method, params }), "stdout");
  send("item/started", { threadId: "main-1", turnId: "turn-main", item: { type: "subAgentActivity", id: "call_1", kind: "started", agentThreadId: "child-1", agentPath: "/root/backend" } });
  send("item/completed", { threadId: "main-1", turnId: "turn-main", item: { type: "subAgentActivity", id: "call_1", kind: "started", agentThreadId: "child-1", agentPath: "/root/backend" } });
  send("turn/started", { threadId: "child-1", turn: { id: "turn-child", items: [], status: "inProgress" } });
  send("turn/plan/updated", { threadId: "child-1", turnId: "turn-child", explanation: null, plan: [{ step: "child step", status: "inProgress" }] });
  send("item/reasoning/summaryTextDelta", { threadId: "child-1", turnId: "turn-child", itemId: "r1", delta: "Thinking about the backend.\n", summaryIndex: 0 });
  send("item/started", { threadId: "child-1", turnId: "turn-child", item: { type: "agentMessage", id: "m1", text: "", phase: "final_answer" } });
  send("item/agentMessage/delta", { threadId: "child-1", turnId: "turn-child", itemId: "m1", delta: "Backend done, to integrate by the orchestrator.\n" });
  send("error", { threadId: "child-1", turnId: "turn-child", error: { message: "stream disconnected" }, willRetry: false });
  send("turn/completed", { threadId: "child-1", turn: { id: "turn-child", items: [], status: "failed", error: { message: "stream disconnected" } } });
  const types = entry._events.map((event) => event.type);
  for (const type of ["plan/update", "reasoning/chunk", "answer/chunk", "turn/error", "turn/end", "turn/start"]) {
    assert.ok(!types.includes(type), type + " must not come from a child");
  }
  assert.notEqual(entry.status, "error");
  assert.equal(entry.activeTurnId, "turn-main");
  const warning = entry._events.find((event) => event.type === "warning");
  assert.match(warning.data.message, /^Sub-agent backend failed: /);
  assert.equal(entry.codexSubagents["child-1"].status, "failed");
  // the main thread's own plan and error still drive the turn
  send("turn/plan/updated", { threadId: "main-1", turnId: "turn-main", explanation: null, plan: [{ step: "main step", status: "inProgress" }] });
  assert.equal(entry._events[entry._events.length - 1].type, "plan/update");
  send("error", { threadId: "main-1", turnId: "turn-main", error: { message: "boom" }, willRetry: false });
  assert.equal(entry._events[entry._events.length - 1].type, "turn/error");
});

test("the Convertigo MCP subagent-run is a tool of the main thread: its running answer does not end the turn", () => {
  const entry = fakeEntry({ sessionId: "main-1", codexThreadId: "main-1", activeTurnId: "turn-main" });
  const item = { type: "mcpToolCall", id: "call_mcp", server: "Convertigo", tool: "subagent-run", status: "inProgress", arguments: { profile: "constructor", task: "backend" } };
  sandbox.handleCodexAppServerLine(entry, JSON.stringify({ method: "item/started", params: { threadId: "main-1", turnId: "turn-main", item } }), "stdout");
  sandbox.handleCodexAppServerLine(entry, JSON.stringify({ method: "item/completed", params: { threadId: "main-1", turnId: "turn-main",
    item: Object.assign({}, item, { status: "completed", result: { content: [{ type: "text", text: "{\"status\":\"running\",\"runId\":\"r1\"}" }] } }) } }), "stdout");
  assert.deepEqual(entry._events.map((event) => [event.type, event.data.title]), [["tool/start", "Convertigo.subagent-run"], ["tool/update", "Convertigo.subagent-run"]]);
  assert.equal(entry.codexTurnEnded, false);
});

test("Stop interrupts the main turn and the turns of the sub-agents still running", () => {
  const entry = fakeEntry({ sessionId: "main-1", codexThreadId: "main-1", activeTurnId: "turn-main", nextRequestId: 10 });
  const send = (method, params) => sandbox.handleCodexAppServerLine(entry, JSON.stringify({ method, params }), "stdout");
  const interrupts = () => entry._written.map((text) => JSON.parse(text)).filter((message) => message.method === "turn/interrupt").map((message) => message.params);
  send("item/completed", { threadId: "main-1", turnId: "turn-main", item: { type: "subAgentActivity", id: "call_a", kind: "started", agentThreadId: "child-a", agentPath: "/root/backend" } });
  send("turn/started", { threadId: "child-a", turn: { id: "turn-a", items: [], status: "inProgress" } });
  send("item/completed", { threadId: "main-1", turnId: "turn-main", item: { type: "subAgentActivity", id: "call_b", kind: "started", agentThreadId: "child-b", agentPath: "/root/ui" } });
  send("turn/started", { threadId: "child-b", turn: { id: "turn-b", items: [], status: "inProgress" } });
  send("turn/completed", { threadId: "child-b", turn: { id: "turn-b", items: [], status: "completed" } });
  assert.equal(sandbox.TURN_INTERRUPT_ADAPTERS["codex-app-server"](entry), true);
  // the main turn first, then the one sub-agent still running (ui has finished)
  assert.deepEqual(interrupts(), [{ threadId: "main-1", turnId: "turn-main" }, { threadId: "child-a", turnId: "turn-a" }]);
  assert.deepEqual([...entry._events.find((event) => event.type === "codex/subagent" && event.data.event === "turn/interrupt").data.subagents], ["backend"]);
  send("turn/completed", { threadId: "child-a", turn: { id: "turn-a", items: [], status: "interrupted" } });
  entry._written.length = 0;
  sandbox.TURN_INTERRUPT_ADAPTERS["codex-app-server"](entry);
  assert.deepEqual(interrupts(), [{ threadId: "main-1", turnId: "turn-main" }], "an interrupted sub-agent is not interrupted again");
});
