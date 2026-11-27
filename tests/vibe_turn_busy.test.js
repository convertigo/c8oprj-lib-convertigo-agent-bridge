// "A turn is already running" (TigoAccess 9c3d8e62, ACOSS 26/11 with Bridge 0.5.0-beta.30): Vibe's own refusal of a
// prompt (vibe/app_server/session.py) or of a setting (its harness's _require_idle) while a turn of its own runs. It came
// after a Stop followed by an immediate resend (Vibe still closing the cancelled turn), after a model or effort change
// on a reused process (configureVibeSession sent it during the turn), and on two sends of one conversation (the
// admission checked, then started the turn, in two steps). Now the admission is one step, a refused turn's prompt is
// sent again a short while when Vibe may be closing a turn, else the turn ends as busy, and no setting goes during a turn.
// node --test tests/vibe_turn_busy.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { vibeHarness } = require("./helpers/vibe_harness.js");

const h = vibeHarness();
const { sandbox, clock } = h;
const BUSY = "A turn is already running";

function idle() {
  h.reset();
  return h.fakeEntry("vibe-test", "s1");
}
const prompt = (text, extra) => sandbox.C8O.agentBridge.vibePrompt(Object.assign({ handle: "vibe-test", prompt: text || "Continue." }, extra || {}));

test("two prompts at once: one is admitted, the other answers busy and never reaches Vibe", () => {
  const entry = idle();
  let second = null;
  // the second send arrives while the first is being written to Vibe, before its turn/start
  entry.onWrite = (text) => {
    if (second === null && /session\/prompt/.test(text)) {
      second = prompt("Second message.");
    }
  };
  const first = prompt("First message.");
  assert.equal(first.status, "submitted");
  assert.equal(second.status, "busy");
  assert.equal(h.sentMessages(entry, "session/prompt").length, 1);
  assert.equal(entry.admissionGate.get(), false, "the gate is released");
  assert.equal(prompt("Third, during the turn.").status, "busy");
});

test("a Stop then an immediate resend: Vibe still closing its turn refuses, the prompt goes again and the turn runs", () => {
  const entry = idle();
  entry.lastCancelAt = clock.now - 300;
  const result = prompt("Reprends.");
  assert.equal(result.status, "submitted");
  const first = h.sentMessages(entry, "session/prompt")[0];
  h.play(entry, [h.refusal(first.id, BUSY)]);
  assert.equal(h.types(entry, "turn/error").length, 0, "no failure of the turn");
  assert.equal(h.types(entry, "acp/response_error").length, 0, "no error the Assistant would read as the end of the turn");
  assert.equal(entry.turnActive, true);
  assert.equal(h.runThreads("vibe-busy-"), 1);
  const again = h.sentMessages(entry, "session/prompt");
  assert.equal(again.length, 2);
  assert.deepEqual(again[1].params, first.params, "the same message");
  assert.equal(entry.turnRequestId, String(again[1].id));
  assert.equal(h.types(entry, "turn/retry")[0].data.endedRequestId, String(first.id));
  h.play(entry, [h.answer(again[1].id)]);
  assert.equal(h.types(entry, "turn/end").length, 1);
  assert.equal(entry.turnActive, false);
});

test("Vibe busy without a reason to be closing a turn: the turn ends as busy, the message was not sent", () => {
  const entry = idle();
  prompt("Bonjour.");
  const sent = h.sentMessages(entry, "session/prompt")[0];
  h.play(entry, [h.refusal(sent.id, BUSY)]);
  assert.equal(h.runThreads("vibe-busy-"), 0);
  const ended = h.types(entry, "turn/error");
  assert.equal(ended.length, 1);
  assert.equal(ended[0].data.busy, true);
  assert.equal(ended[0].data.error.code, "turn_busy");
  assert.match(ended[0].data.error.message, /was not sent\. Send it again in a moment\.$/);
  assert.equal(h.types(entry, "acp/response_error").length, 0);
  assert.equal(entry.turnActive, false);
});

test("the retries stop after their budget and the turn ends as busy", () => {
  const entry = idle();
  entry.lastTurnEndAt = clock.now - 100;
  prompt("Encore.");
  for (let i = 0; i < 200 && entry.turnActive === true; i++) {
    const last = h.sentMessages(entry, "session/prompt").pop();
    h.play(entry, [h.refusal(last.id, BUSY)]);
    clock.now += 250;
    h.runThreads("vibe-busy-");
  }
  assert.equal(entry.turnActive, false);
  const ended = h.types(entry, "turn/error");
  assert.equal(ended.length, 1);
  assert.equal(ended[0].data.busy, true);
  assert.ok(ended[0].data.retries > 10 && ended[0].data.retries < 100, "retried for a while, not for ever: " + ended[0].data.retries);
  assert.ok(h.types(entry, "progress/message").some((event) => event.data.code === "turn_busy_wait"), "the wait is told once");
});

test("a Stop while the message waits for a retry ends the turn without sending it", () => {
  const entry = idle();
  entry.lastCancelAt = clock.now - 100;
  prompt("Vas-y.");
  h.play(entry, [h.refusal(h.sentMessages(entry, "session/prompt")[0].id, BUSY)]);
  sandbox.pushEvent(entry, "turn/interrupt_requested", { protocol: "acp" });
  h.runThreads("vibe-busy-");
  assert.equal(h.sentMessages(entry, "session/prompt").length, 1);
  assert.equal(h.types(entry, "turn/end")[0].data.result.stopReason, "cancelled");
  assert.equal(entry.turnActive, false);
});

test("a refused prompt that is not the turn's is no failure of the turn", () => {
  const entry = idle();
  prompt("Le vrai tour.");
  const turnId = h.sentMessages(entry, "session/prompt")[0].id;
  entry.pending.set("777", { id: 777, method: "session/prompt" });
  h.play(entry, [h.refusal(777, BUSY)]);
  entry.pending.set("778", { id: 778, method: "session/prompt" });
  h.play(entry, [JSON.stringify({ jsonrpc: "2.0", id: 778, error: { code: -32603, message: "boom" } })]);
  assert.equal(h.types(entry, "turn/error").length, 0);
  assert.equal(h.types(entry, "acp/response_error").length, 0);
  assert.deepEqual(h.reasons(entry), ["turn_busy", "other_prompt_error"]);
  assert.ok(h.types(entry, "warning").every((event) => event.data.otherRequest === true));
  assert.equal(entry.turnActive, true);
  h.play(entry, [h.answer(turnId)]);
  assert.equal(h.types(entry, "turn/end").length, 1);
});

test("no setting changes during a turn: a start then keeps it for the next prompt", () => {
  const entry = idle();
  const configCalls = [];
  const original = sandbox.configureVibeSession;
  sandbox.configureVibeSession = (e, options) => { configCalls.push([options.model, options.reasoningEffort, e.turnActive === true]); return null; };
  try {
    prompt("Tour en cours.");
    assert.equal(entry.turnActive, true);
    sandbox.configureOrDeferVibeSession(entry, { model: "glm-5-3", reasoningEffort: "high" }, 30000);
    assert.deepEqual(configCalls, [], "nothing sent to Vibe during the turn");
    h.play(entry, [h.answer(h.sentMessages(entry, "session/prompt")[0].id)]);
    prompt("Tour suivant.");
    assert.deepEqual(configCalls, [["glm-5-3", "high", false]], "applied before the next turn starts");
    assert.equal(entry.deferredSessionConfig, null);
    sandbox.configureOrDeferVibeSession(entry, { model: "mistral-large-4" }, 30000);
    assert.equal(configCalls.length, 1, "kept again: that turn runs");
  } finally {
    sandbox.configureVibeSession = original;
  }
});

test("a setting Vibe refuses while closing its turn is sent again, and its refusal is no error event", () => {
  const entry = idle();
  const calls = [];
  const original = sandbox.acpRequest;
  sandbox.acpRequest = (e, method, params) => {
    calls.push(params.configId + "=" + params.value);
    if (calls.length < 3) {
      const error = new Error(BUSY + ": turn-1");
      error.acpError = { code: -32009, message: BUSY + ": turn-1", data: { activeTurnId: "turn-1" } };
      throw error;
    }
    return { configOptions: [] };
  };
  try {
    sandbox.vibeSetConfigOption(entry, "model", "glm-5-3", 30000);
  } finally {
    sandbox.acpRequest = original;
  }
  assert.deepEqual(calls, ["model=glm-5-3", "model=glm-5-3", "model=glm-5-3"]);
  entry.pending.set("55", { id: 55, method: "session/set_config_option" });
  h.play(entry, [JSON.stringify({ jsonrpc: "2.0", id: 55, error: { code: -32009, message: BUSY + ": turn-1" } })]);
  assert.equal(h.types(entry, "acp/response_error").length, 0);
  assert.equal(h.types(entry, "acp/response").length, 1);
});

test("a setting refused for another reason fails at once", () => {
  const entry = idle();
  let calls = 0;
  const original = sandbox.acpRequest;
  sandbox.acpRequest = () => { calls++; throw new Error("Unknown config option"); };
  try {
    assert.throws(() => sandbox.vibeSetConfigOption(entry, "model", "x", 30000), /Unknown config option/);
  } finally {
    sandbox.acpRequest = original;
  }
  assert.equal(calls, 1);
});
