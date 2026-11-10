// A used-up Tigo budget (tigo-nocode-contract.md section 6). LiteLLM 1.99.1 refuses the request with HTTP 429 and the
// error type budget_exceeded; the Bridge is the first trusted component that sees it and turns it into
// {code: "budget_exceeded", scope, retryable: false}, without the gateway's message or any entity id, on every runtime
// and Bridge event. An RPM/TPM limit or an upstream 429 keeps its own retryable handling.
// node --test tests/gateway_budget_exceeded.test.js
// VIBE_TEST_PYTHON=<python of a managed Vibe venv> also runs the hook against Vibe's own retry loop.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");

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

// LiteLLM 1.99.1 bodies (auth_checks.py, user_api_key_auth.py, auth_exception_handler.py) and their scope
const body = (message, type = "budget_exceeded") => JSON.stringify({ error: { message, type, param: null, code: "429" } });
const BUDGETS = {
  key: body("Budget has been exceeded! Key=88dc28d0f030c55ed4ab77ed8faf098196cb1c05df778539800c9f1243fe6b4b Current cost: 10.01, Max budget: 10.0"),
  member: body("Budget has been exceeded! User=lu-7f3a in Team=team-acme Current cost: 4.2, Max budget: 4.0"),
  team: body("Budget has been exceeded! Team=team-acme Current cost: 101.0, Max budget: 100.0"),
  user: body("ExceededBudget: User=lu-7f3a over budget. Spend=5.1, Budget=5.0"),
  unknown: body("Budget has been exceeded! Current cost: 4.2, Max budget: 4.0")
};
const NOT_BUDGETS = {
  rpm: body("Rate limit exceeded for key: 88dc28d0. Limit type: requests. Current limit: 10, Remaining: 0. Limit resets at: 2026-11-10 15:00:00 UTC", "throttling_error"),
  tpm: body("Rate limit exceeded for team: team-acme. Limit type: tokens. Current limit: 100000, Remaining: 0.", "throttling_error"),
  upstream: "litellm.RateLimitError: MistralException - {\"message\":\"Requests rate limit exceeded\"}",
  claude: "API Error: 429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"Number of request tokens has exceeded your per-minute rate limit\"}}",
  vibe: JSON.stringify({ code: -31001, message: "Rate limit exceeded for convertigo (model: glm-5-3).", data: { provider: "convertigo", model: "glm-5-3" } })
};

function fakeEntry(fields = {}) {
  const events = [];
  const written = [];
  return Object.assign({
    handle: "vibe-test", provider: "vibe", protocol: "acp", status: "running", sessionId: "s1", vibeProfile: "convertigo",
    nextIndex: 0, firstIndex: 0, lastAccess: 0, lastError: "", process: {}, pending: new Map(),
    writer: { write(text) { written.push(String(text)); }, newLine() {}, flush() {} },
    events: { add(event) { events.push(event); }, size() { return events.length; }, remove() { events.shift(); } },
    _events: events, _written: written
  }, fields);
}

test("a LiteLLM budget refusal is budget_exceeded with the level it names, whatever carries it", () => {
  for (const [scope, text] of Object.entries(BUDGETS)) {
    const expected = { code: "budget_exceeded", scope, retryable: false };
    assert.deepEqual({ ...sandbox.gatewayBudgetError(text) }, expected, scope + " (body)");
    assert.deepEqual({ ...sandbox.gatewayBudgetError({ error: { message: "HTTP 429: " + JSON.parse(text).error.message } }) }, expected, scope + " (message)");
  }
  assert.equal(sandbox.gatewayBudgetError(body("ExceededBudget: Key over 30d budget. Spend=$1.0000, Limit=$1.00")).scope, "key");
  assert.equal(sandbox.gatewayBudgetError(body("ExceededBudget: Team=team-acme over 30d budget. Spend=$1.0000, Limit=$1.00")).scope, "team");
  assert.equal(sandbox.gatewayBudgetError(body("ExceededBudget: End User=e1 over budget. Spend=1, Budget=1")).scope, "user");
  assert.equal(sandbox.gatewayBudgetError(JSON.stringify({ error: { type: "budget_exceeded" } })).scope, "unknown", "the type alone");
  assert.equal(sandbox.gatewayBudgetError({ code: "budget_exceeded", scope: "team", retryable: false }).scope, "team", "already normalized");
});

test("an RPM/TPM limit, an upstream 429 or a runtime's rate-limit error is not a budget", () => {
  for (const [name, text] of Object.entries(NOT_BUDGETS)) {
    assert.equal(sandbox.gatewayBudgetError(text), null, name);
    assert.equal(sandbox.gatewayBudgetError({ error: text, message: text }), null, name + " (event)");
  }
  assert.equal(sandbox.gatewayBudgetError(""), null);
  assert.equal(sandbox.gatewayBudgetError({ message: "my_budget_exceeded_flag" }), null, "a word that only contains it");
});

test("every error event of a runtime carries the normalized error, never the gateway's message or an entity id", () => {
  for (const type of ["turn/error", "acp/response_error", "error"]) {
    const entry = fakeEntry();
    sandbox.pushEvent(entry, type, { requestId: 7, method: "session/prompt", provider: "claude", error: { message: "HTTP 429: " + BUDGETS.member } });
    const data = entry._events[0].data;
    assert.equal(data.code, "budget_exceeded", type);
    assert.equal(data.scope, "member");
    assert.equal(data.retryable, false);
    assert.equal(data.requestId, 7);
    assert.equal(data.provider, "claude");
    assert.equal(data.message, "budget_exceeded: The Tigo budget is used up.");
    const text = JSON.stringify(data);
    for (const leak of ["Budget has been exceeded", "lu-7f3a", "team-acme", "Current cost", "error\":{"]) {
      assert.ok(!text.includes(leak), type + " leaks " + leak);
    }
  }
  // a stderr line that repeats it is redacted; a rate limit is left as it was
  const entry = fakeEntry();
  sandbox.pushEvent(entry, "stderr", { line: "Model call failed message=" + BUDGETS.team });
  assert.equal(entry._events[0].data.line, "[gateway] budget_exceeded: The Tigo budget is used up.");
  const rpm = { requestId: 8, error: { message: NOT_BUDGETS.rpm } };
  sandbox.pushEvent(entry, "turn/error", rpm);
  assert.equal(entry._events[1].data, rpm, "an RPM limit keeps its own event");
  // a non-error event is never rewritten
  const update = { text: "the agent wrote: Budget has been exceeded! Team=x" };
  sandbox.pushEvent(entry, "message/delta", update);
  assert.equal(entry._events[2].data, update);
});

test("Vibe: the hook's stderr marker turns its rate-limited prompt error into the budget error of the turn", () => {
  const entry = fakeEntry();
  sandbox.pushEvent(entry, "turn/start", { requestId: 3 });
  sandbox.handleAcpLine(entry, "C8O_GATEWAY_BUDGET_EXCEEDED {\"scope\": \"team\"}", "stderr");
  assert.deepEqual(entry._events.map((event) => event.type), ["turn/start", "gateway/budget_exceeded"], "no stderr line for the marker");
  assert.equal(entry._events[1].data.scope, "team");
  entry.pending.set("3", { method: "session/prompt", id: 3, done: false });
  sandbox.handleAcpLine(entry, JSON.stringify({ jsonrpc: "2.0", id: 3, error: JSON.parse(NOT_BUDGETS.vibe) }), "stdout");
  const errors = entry._events.filter((event) => event.type === "turn/error" || event.type === "acp/response_error");
  assert.ok(errors.length >= 1);
  for (const event of errors) {
    assert.equal(event.data.code, "budget_exceeded", event.type);
    assert.equal(event.data.scope, "team", "the level the hook read in the gateway's body");
    assert.equal(event.data.retryable, false);
  }
  assert.equal(entry.turnActive, false, "the turn ended");
  // the next turn starts clean: a rate limit is a rate limit again
  sandbox.pushEvent(entry, "turn/start", { requestId: 4 });
  entry.pending.set("4", { method: "session/prompt", id: 4, done: false });
  sandbox.handleAcpLine(entry, JSON.stringify({ jsonrpc: "2.0", id: 4, error: JSON.parse(NOT_BUDGETS.vibe) }), "stdout");
  const last = entry._events.filter((event) => event.type === "turn/error").pop();
  assert.equal(last.data.code, undefined);
  assert.equal(last.data.error.code, -31001);
  // a marker the Bridge cannot read still says budget_exceeded, of an unknown level
  const other = fakeEntry();
  sandbox.handleAcpLine(other, "C8O_GATEWAY_BUDGET_EXCEEDED not-json", "stderr");
  assert.equal(other.gatewayBudgetRefusal.scope, "unknown");
});

test("a Vibe on the gateway gets the budget hook, an unconfined one without the confined move fallback", () => {
  const saved = sandbox.confinedPythonPath;
  const savedFile = sandbox.File;
  sandbox.confinedPythonPath = () => "/bridge/sandbox/python";
  sandbox.File = { pathSeparator: ":" };
  try {
    const env = { PYTHONPATH: "/x" };
    assert.equal(sandbox.applyGatewayBudgetHook(env, null), true);
    assert.equal(env.C8O_GATEWAY_BUDGET_HOOK, "1");
    assert.equal(env.C8O_SANDBOX_MOVES, "0");
    assert.equal(env.PYTHONPATH, "/bridge/sandbox/python:/x");
    const confined = { PYTHONPATH: "/bridge/sandbox/python" };
    sandbox.applyGatewayBudgetHook(confined, { confined: true, pythonPath: "/bridge/sandbox/python" });
    assert.equal(confined.C8O_SANDBOX_MOVES, undefined, "a confined one keeps the move fallback");
    assert.equal(confined.PYTHONPATH, "/bridge/sandbox/python", "already on its path");
    sandbox.confinedPythonPath = () => "";
    assert.equal(sandbox.applyGatewayBudgetHook({}, null), false, "without the module, Vibe as it is");
  } finally {
    sandbox.confinedPythonPath = saved;
    sandbox.File = savedFile;
  }
  assert.match(fs.readFileSync(path.join(root, "js/agent_bridge_vibe.js"), "utf8"),
    /if \(isConvertigoGatewayProfile\(options\)\) \{\n\s+applyGatewayBudgetHook\(env, noCodeSandbox\);/);
});

test("Codex: an error it retries itself does not end the turn; its final error does", () => {
  const entry = fakeEntry({ provider: "codex", protocol: "codex-app-server" });
  sandbox.handleCodexAppServerLine(entry, JSON.stringify({ method: "error", params: { error: { message: "rate limited" }, willRetry: true } }), "stdout");
  assert.deepEqual(entry._events.map((event) => event.type), ["warning"]);
  assert.equal(entry._events[0].data.reason, "provider_retry");
  assert.notEqual(entry.status, "error");
  sandbox.handleCodexAppServerLine(entry, JSON.stringify({ method: "error", params: { error: { message: "rate limited" }, willRetry: false } }), "stdout");
  assert.equal(entry._events[1].type, "turn/error");
  assert.equal(entry.status, "error");
});

test("Claude Code on a gateway model: its first 429 retry of a turn asks the gateway, a used-up budget ends the turn", () => {
  const entry = fakeEntry({ provider: "claude", protocol: "claude-stream-json", model: "mistral/zai-glm-5-3", turnRequestId: "r1", workspaceRoot: "/w" });
  const probes = [];
  const savedKey = sandbox.convertigoGatewayApiKey;
  sandbox.convertigoGatewayApiKey = () => "sk-studio-" + "c".repeat(32);
  try {
    // a rate limit: no budget, Claude Code keeps its retries, the gateway is asked once per turn
    assert.equal(sandbox.claudeCheckGatewayBudget(entry, { probe: (options, key, model) => { probes.push([key, model]); return null; } }), null);
    assert.equal(sandbox.claudeCheckGatewayBudget(entry, { probe: () => { throw new Error("asked twice"); } }), null);
    assert.deepEqual(probes, [["sk-studio-" + "c".repeat(32), "mistral/zai-glm-5-3"]]);
    assert.equal(entry._events.length, 0);
    // a used-up budget: the normalized error, then the interrupt
    entry.gatewayBudgetProbed = false;
    const budget = sandbox.claudeCheckGatewayBudget(entry, { probe: () => sandbox.gatewayBudgetError(BUDGETS.key) });
    assert.equal(budget.scope, "key");
    const error = entry._events.find((event) => event.type === "turn/error");
    assert.equal(error.data.code, "budget_exceeded");
    assert.equal(error.data.scope, "key");
    assert.equal(error.data.requestId, "r1");
    assert.ok(entry._written.some((line) => line.includes("\"subtype\":\"interrupt\"")), "Claude Code's turn is stopped");
    // a model of Claude's own: never asked
    const own = fakeEntry({ provider: "claude", model: "claude-sonnet-5-5" });
    assert.equal(sandbox.claudeCheckGatewayBudget(own, { probe: () => { throw new Error("asked"); } }), null);
  } finally {
    sandbox.convertigoGatewayApiKey = savedKey;
  }
  assert.match(fs.readFileSync(path.join(root, "js/agent_bridge_claude.js"), "utf8"),
    /if \(subtype === "api_retry" && Number\(message\.error_status\) === 429\) \{\n\s+claudeCheckGatewayBudget\(entry\);/);
});

test("the effort probes stop at a used-up budget instead of asking again for every model", () => {
  const saved = sandbox.probeGatewayModelEffort;
  const asked = [];
  sandbox.probeGatewayModelEffort = (options, key, name, effort) => { asked.push(effort); return "budget"; };
  try {
    const options = {};
    assert.equal(sandbox.probeGatewayModelEfforts(options, "sk-x", "glm-5-3"), null, "unknown: the cached levels stay");
    assert.equal(options.gatewayBudgetRefused, true);
    assert.deepEqual(asked, ["low"]);
  } finally {
    sandbox.probeGatewayModelEffort = saved;
  }
  assert.match(fs.readFileSync(path.join(root, "js/agent_bridge_common.js"), "utf8"),
    /if \(code === 429 && gatewayBudgetError\(text\) !== null\) \{ return "budget"; \}/);
});

// The Python side reads the same bodies the same way (sandbox/python/c8o_gateway_budget.py).
const python = ["python3", "python"].find((name) => spawnSync(name, ["--version"]).status === 0);

test("the Vibe budget hook reads LiteLLM's bodies as the Bridge does", { skip: python ? false : "no Python" }, () => {
  const fixtures = Object.assign({}, BUDGETS, NOT_BUDGETS);
  const script = "import json,sys\nsys.path.insert(0, sys.argv[1])\nimport c8o_gateway_budget as b\n" +
    "data=json.loads(sys.stdin.read())\nprint(json.dumps({k: (b.budget_scope(v) if b.budget_refusal(v) else None) for k, v in data.items()}))";
  const run = spawnSync(python, ["-I", "-c", script, path.join(root, "sandbox/python")], { input: JSON.stringify(fixtures), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const read = JSON.parse(run.stdout);
  for (const [name, text] of Object.entries(fixtures)) {
    const bridge = sandbox.gatewayBudgetError(text);
    assert.equal(read[name], bridge ? bridge.scope : null, name);
  }
});

const vibePython = process.env.VIBE_TEST_PYTHON;

test("Vibe's own retry loop gives up at once on a budget refusal and keeps retrying a rate limit", { skip: vibePython ? false : "VIBE_TEST_PYTHON not set" }, () => {
  const script = [
    "import asyncio, json",
    "import httpx2",
    "from mistralai_vibe_local_harness.vibe.adapters import _provider_failure as pf, _retry as rt",
    "def err(status, text):",
    "    req = httpx2.Request('POST', 'https://llm.convertigo.com/v1/chat/completions')",
    "    return httpx2.HTTPStatusError('Client error', request=req, response=httpx2.Response(status, request=req, content=text.encode()))",
    "fixtures = json.loads(input())",
    "calls = {'n': 0}",
    "async def attempt():",
    "    calls['n'] += 1",
    "    raise err(429, fixtures['member'])",
    "async def main():",
    "    try:",
    "        await rt.call_with_retries(attempt, max_elapsed_time_s=300, notices=rt.RetryNotices(None))",
    "    except httpx2.HTTPStatusError:",
    "        pass",
    "asyncio.run(main())",
    "print(json.dumps({'budget': pf.read_provider_failure(err(429, fixtures['member'])).retryable,",
    "  'rpm': pf.read_provider_failure(err(429, fixtures['rpm'])).retryable, 'attempts': calls['n']}))"
  ].join("\n");
  const env = Object.assign({}, process.env, { C8O_GATEWAY_BUDGET_HOOK: "1", C8O_SANDBOX_MOVES: "0", PYTHONPATH: path.join(root, "sandbox/python") });
  const run = spawnSync(vibePython, ["-c", script], { input: JSON.stringify({ member: BUDGETS.member, rpm: NOT_BUDGETS.rpm }) + "\n", encoding: "utf8", env });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout.trim().split("\n").pop()), { budget: false, rpm: true, attempts: 1 });
  assert.match(run.stderr, /^C8O_GATEWAY_BUDGET_EXCEEDED \{"scope": "member"\}$/m);
  assert.doesNotMatch(run.stderr, /lu-7f3a|team-acme|Budget has been exceeded/, "the marker carries no id and no message");
});

test("the status of a process does not repeat a budget refusal its runtime wrote as its last error", () => {
  assert.match(fs.readFileSync(path.join(root, "js/agent_bridge_common.js"), "utf8"),
    /lastError: gatewayBudgetError\(entry\.lastError\) !== null \? GATEWAY_BUDGET_MESSAGE : entry\.lastError,/);
  assert.equal(sandbox.gatewayBudgetError("API Error: 429 " + BUDGETS.member).scope, "member", "what Claude Code writes on stderr");
});
