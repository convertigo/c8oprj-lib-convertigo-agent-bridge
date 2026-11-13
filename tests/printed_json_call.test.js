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
const say = (text) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const call = (id, title) => update({ sessionUpdate: "tool_call", toolCallId: id, title: title || "mcp_Convertigo.databaseobject_tree_get", status: "in_progress" });
const answer = (id, stopReason) => JSON.stringify({ jsonrpc: "2.0", id, result: { stopReason: stopReason || "end_turn" } });
const play = (entry, lines) => lines.forEach((line) => sandbox.handleAcpLine(entry, line, "stdout"));
const prompts = (entry) => entry._written.map((w) => JSON.parse(w)).filter((m) => m.method === "session/prompt");
const types = (entry, type) => entry._events.filter((event) => event.type === type);

function turn(id) {
  const entry = fakeEntry();
  entry.nextRequestId = 100;
  entry.pending.put = (key, value) => entry.pending.set(key, value);
  entry.pending.set(String(id), { id, method: "session/prompt" });
  sandbox.pushEvent(entry, "turn/start", { requestId: id });
  return entry;
}

const printed = (tool = 'run_typescript', separator = '\n') => tool + separator + JSON.stringify({code: 'await tools.mcp_sample.document_set(' + JSON.stringify({source: 'sample '.repeat(900)}) + ');'});

test('a long printed JSON tool call is retried once in the same session across chunks', () => {
  const e = turn(7), text = printed();
  assert.ok(text.length > 2000);
  play(e, [say(text.slice(0, 13)), say(text.slice(13, 2300)), say(text.slice(2300)), answer(7)]);
  assert.equal(prompts(e).length, 1);
  assert.equal(prompts(e)[0].params.sessionId, 's1');
  assert.equal(prompts(e)[0].method, 'session/prompt');
  assert.match(prompts(e)[0].params.prompt[0].text, /not executed/);
  assert.equal(types(e, 'turn/nudge')[0].data.max, 1);
  assert.equal(types(e, 'turn/end').length, 0);
  const id = types(e, 'turn/nudge')[0].data.requestId;
  play(e, [say(text), answer(id)]);
  assert.equal(prompts(e).length, 1, 'no second retry');
  assert.equal(types(e, 'turn/end')[0].data.result.incomplete, true);
});

test('a short stray character and generic MCP or observed tool names are recognized', () => {
  for (const [name, separator] of [['run_typescript', '\uD638'], ['mcp_sample.document_set', '\n'], ['write_file', ': '], ['task', '']]) {
    const e = turn(7);
    play(e, [say(printed(name, separator)), answer(7)]);
    assert.equal(prompts(e).length, 1, name);
  }
  const e = turn(7);
  play(e, [call('known', 'custom.render'), say(printed('custom.render')), answer(7)]);
  assert.equal(prompts(e).length, 1);
});

test('normal prose, malformed JSON, arrays and oversized candidates do not trigger', () => {
  for (const text of [
    'For example: ' + printed(), printed() + '\nThis is documentation.',
    'Here is the requested example:\n' + 'x'.repeat(2100) + '\nrun_typescript {"code":"example"}',
    'unknown_tool {"code":"example"}', 'run_typescript {not JSON}', 'run_typescript [1,2]',
    'run_typescript question? {"code":"example"}', printed('run_typescript', ' explanation '),
    'A report '.repeat(40000) + '\nrun_typescript {"code":"example"}'
  ]) {
    const e = turn(7);
    play(e, [say(text), answer(7)]);
    assert.equal(prompts(e).length, 0, text.slice(0, 60));
  }
});

test('the printed JSON retry can be disabled and cannot fall through to the legacy nudge', () => {
  const previous = sandbox.vibePrintedCallRetryLimit;
  sandbox.vibePrintedCallRetryLimit = () => 0;
  try {
    const e = turn(7);
    play(e, [say('run_typescript {"code":"sample"}'), answer(7)]);
    assert.equal(prompts(e).length, 0);
    assert.equal(types(e, 'turn/end')[0].data.result.incomplete, true);
  } finally { sandbox.vibePrintedCallRetryLimit = previous; }
});

test('Stop, cancellation, refused writes, errors and other providers never retry', () => {
  for (const mode of ['stop', 'cancelled', 'error', 'refused', 'other']) {
    const e = turn(7);
    if (mode === 'stop') sandbox.pushEvent(e, 'turn/interrupt_requested', {});
    if (mode === 'refused') e.turnWriteRefused = true;
    if (mode === 'other') e.provider = 'codex';
    play(e, [say(printed()), mode === 'error'
      ? JSON.stringify({jsonrpc:'2.0',id:7,error:{message:'failed'}})
      : answer(7, mode === 'cancelled' ? 'cancelled' : 'end_turn')]);
    assert.equal(prompts(e).length, 0, mode);
  }
});

test('a real tool call resets the candidate and the next user turn resets the retry budget', () => {
  const e = turn(7);
  play(e, [say('An ordinary introduction.'), call('read', 'mcp_sample.document_get'), say(printed()), answer(7)]);
  const id = types(e, 'turn/nudge')[0].data.requestId;
  play(e, [say('Done.'), answer(id)]);
  e.pending.set('20', {id:20,method:'session/prompt'});
  sandbox.pushEvent(e, 'turn/start', {requestId:20});
  play(e, [say(printed()), answer(20)]);
  assert.equal(prompts(e).length, 2);
});


test('retry telemetry contains metadata, never the printed arguments', () => {
  const e = turn(7);
  play(e, [say(printed()), answer(7)]);
  const n = types(e, 'turn/nudge')[0].data;
  assert.equal(n.reason, 'printed_call');
  assert.equal(n.tool, 'run_typescript');
  assert.ok(n.textLength > 2000);
  assert.equal(n.text, '');
  assert.equal(JSON.stringify(n).includes('sample '), false);
  assert.equal(types(e, 'progress/message').length, 1);
  assert.ok(prompts(e).every(p => p.method === 'session/prompt'));
});

test('a stop arriving during the retry decision is checked again before sending', () => {
  const e = turn(7), old = sandbox.vibePrintedCallRetryLimit;
  sandbox.vibePrintedCallRetryLimit = () => { e.turnInterrupted = true; return 1; };
  try {
    play(e, [say(printed()), answer(7)]);
    assert.equal(prompts(e).length, 0);
  } finally { sandbox.vibePrintedCallRetryLimit = old; }
});


test('the operator symbol accepts zero or one retry and caps larger values', () => {
  const previous = sandbox.Packages;
  try {
    for (const [value, expected] of [[null, 1], ['', 1], ['0', 0], ['1', 1], ['8', 1], ['invalid', 1]]) {
      sandbox.Packages = {com:{twinsoft:{convertigo:{engine:{Engine:{theApp:{databaseObjectsManager:{symbolsGetValue(name) {
        assert.equal(name, 'agentbridge.vibe.printed_call_retries'); return value;
      }}}}}}}}};
      assert.equal(sandbox.vibePrintedCallRetryLimit(), expected, String(value));
    }
  } finally { sandbox.Packages = previous; }
});

test('a cancelled snake-case stop reason does not retry or mark a printed-call failure', () => {
  const e = turn(7);
  play(e, [say(printed()), JSON.stringify({jsonrpc:'2.0',id:7,result:{stop_reason:'cancelled'}})]);
  assert.equal(prompts(e).length, 0);
  assert.equal(types(e, 'turn/incomplete').length, 0);
});


test('a structured tool call after the correction completes the original turn normally', () => {
  const e = turn(7);
  play(e, [say(printed()), answer(7)]);
  const id = types(e, 'turn/nudge')[0].data.requestId;
  play(e, [call('executed', 'mcp_sample.document_set'), say('The document is saved.'), answer(id)]);
  assert.equal(prompts(e).length, 1);
  assert.equal(types(e, 'turn/end').length, 1);
  assert.equal(types(e, 'turn/end')[0].data.result.incomplete, undefined);
  assert.equal(e.turnActive, false);
  assert.equal(e.turnFinalText, '');
});

test('a final response with provider finish_reason stop is also eligible', () => {
  const e = turn(7);
  play(e, [say(printed()), JSON.stringify({jsonrpc:'2.0',id:7,result:{finish_reason:'stop'}})]);
  assert.equal(prompts(e).length, 1);
});
