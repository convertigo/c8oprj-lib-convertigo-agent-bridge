// The managed MCP token of a Vibe process ends with its lease (30 min without a turn using it) and the process keeps it
// for its whole life (CONVERTIGO_MCP_TOKEN, the Authorization header of its config.toml). Toulouse, 24/11 (TigoAccess
// e1349aa7, 1ffa451a): project-list answered "MCP token expired", the tools/list after it was refused with 401 and Vibe
// had no Convertigo tool left for the session; the recovery of a lost MCP (beta.30) restarted Vibe with the same token.
// Now the Bridge says so (warning mcp_token_expired), asks the Assistant for a new token (state mcpTokenRenewal
// "needed", answered by the next agent_events read with mcpBearerTokenHandle), restarts Vibe with it in the same turn
// and resumes the work.
// node --test tests/vibe_mcp_token_expired.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { vibeHarness } = require("./helpers/vibe_harness.js");

const h = vibeHarness();
const { sandbox, clock, registry, restarts, leases, hooks } = h;

const EXPIRED_TEXT = "MCP token expired: its conversation used it last at 2026-11-24T11:35:10.914Z and a token stays valid 30 min without a "
  + "turn using it. Send a new message in the Tigo panel: it renews the authorization. The work done so far is kept. Do not call "
  + "Convertigo tools again in this turn: tell the user.";
// A tools/call the MCP answered with the expiry (isError), as vibe-acp 3.1.0 reported it on a headless engine (27/11,
// idle time cut to 1 min): status failed, rawOutput {type: "failure", content}.
const expiredCall = (id) => [
  h.update({ toolCallId: id, title: "mcp_Convertigo.project_list", kind: "other", status: "in_progress", sessionUpdate: "tool_call" }),
  h.update({ toolCallId: id, kind: "other", status: "failed", sessionUpdate: "tool_call_update",
    content: [{ type: "content", content: { type: "text", text: EXPIRED_TEXT } }],
    rawOutput: { type: "failure", content: [{ type: "text", text: EXPIRED_TEXT }] } })
];
// Vibe 3.1 after a 401 on tools/list: the Convertigo server is suspended, then unknown.
const unauthorizedCall = (id, code) => [
  h.update({ toolCallId: id, title: "mcp_Convertigo.databaseobject_tree_get", kind: "other", status: "in_progress", sessionUpdate: "tool_call" }),
  h.update({ toolCallId: id, kind: "other", status: "failed", sessionUpdate: "tool_call_update",
    rawOutput: { error: { code: code || "mcp_authorization_required", message: "The provided tool call failed", retryable: false } } })
];

function turn(id) {
  h.reset();
  leases.token("h-old", "managed_old");
  const entry = h.fakeEntry("vibe-test", "s1", { mcpLeaseTokenId: "managed_old", mcpBearerTokenFingerprint: "fp-managed_old" });
  entry.pending.set(String(id), { id, method: "session/prompt" });
  sandbox.pushEvent(entry, "turn/start", { requestId: id });
  entry.turnPromptBlocks = [{ type: "text", text: "Liste les projets du Studio." }];
  return entry;
}

test("a tool answering \"MCP token expired\" stops the turn, the panel gives a new token, Vibe resumes with it in the same turn", () => {
  const entry = turn(3);
  leases.end("managed_old");
  h.play(entry, expiredCall("t1"));
  const expired = h.types(entry, "warning").find((event) => event.data.reason === "mcp_token_expired");
  assert.ok(expired, "the Bridge says the token expired");
  assert.deepEqual([expired.data.phase, expired.data.source, expired.data.resume], ["mcp/auth", "tool_answer", true]);
  assert.equal(h.sentMessages(entry, "session/cancel").length, 1, "the turn is stopped at once: the MCP tells the agent to give up");
  assert.equal(sandbox.statusOf(entry).mcpTokenRenewal, "needed");
  assert.equal(entry.mcpRecovery.cause, "mcp_token_expired");
  assert.ok(!h.reasons(entry).includes("convertigo_mcp_suspended"), "not counted as a lost MCP");
  h.play(entry, [h.answer(3, "cancelled")]);
  assert.equal(h.types(entry, "turn/end").length, 0, "the user's turn goes on");

  // the Assistant's next event read brings a new token, created in its user's session
  leases.token("h-new", "managed_new");
  hooks.onSleep = () => sandbox.C8O.agentBridge.events({ handle: "vibe-test", cursor: "0", waitMs: "0", mcpBearerTokenHandle: "h-new" });
  h.runThreads("mcp-recovery-");
  assert.deepEqual(restarts.map((r) => [r.restartInPlace, r.mcpBearerTokenHandle]), [["true", "h-new"]], "restarted with the new token");
  const fresh = registry.get("vibe-test");
  assert.notEqual(fresh, entry);
  assert.equal(fresh.mcpLeaseTokenId, "managed_new");
  const resumed = h.sentMessages(fresh, "session/prompt");
  assert.equal(resumed.length, 1);
  assert.match(resumed[0].params.prompt[0].text, /^Note from the Agent Bridge: the authorization of the Convertigo MCP \(its token\) expired during your turn/);
  assert.match(resumed[0].params.prompt[0].text, /Disregard those answers and their advice to stop\. Call again the tool that failed/);
  const progress = h.types(entry, "progress/message").map((event) => event.data.code);
  assert.ok(progress.includes("mcp_token_wait") && progress.includes("mcp_token_renewed") && progress.includes("mcp_lost_resumed"));
  assert.equal(h.types(entry, "warning").find((event) => event.data.reason === "mcp_lost_resumed").data.cause, "mcp_token_expired");
  assert.equal(sandbox.statusOf(fresh).mcpTokenRenewal, "", "nothing more to renew");
  h.play(fresh, [h.answer(resumed[0].id)]);
  assert.equal(h.types(entry, "turn/end").length, 1);
});

test("a 401 (mcp_authorization_required) with the lease gone is a token to renew, not a lost MCP restarted with the same token", () => {
  const entry = turn(3);
  leases.end("managed_old");
  h.play(entry, unauthorizedCall("t1"));
  assert.deepEqual(h.reasons(entry), ["mcp_token_expired"]);
  assert.equal(h.types(entry, "warning")[0].data.source, "unauthorized");
  assert.equal(entry.mcpLostFailures || 0, 0);
  // the calls Vibe still makes before the cancel lands change nothing
  h.play(entry, unauthorizedCall("t2", "mcp_unknown_route"));
  assert.deepEqual(h.reasons(entry), ["mcp_token_expired"]);
  assert.equal(h.sentMessages(entry, "session/cancel").length, 1);
});

test("a 401 while the lease lives is still a lost MCP (the recovery of beta.30)", () => {
  const entry = turn(3);
  h.play(entry, unauthorizedCall("t1"));
  assert.deepEqual(h.reasons(entry), ["convertigo_mcp_suspended"]);
  assert.equal(sandbox.statusOf(entry).mcpTokenRenewal, "");
});

test("the recovery of a lost MCP renews an ended token before it restarts Vibe", () => {
  const entry = turn(3);
  h.play(entry, [...unauthorizedCall("t1"), ...unauthorizedCall("t2", "mcp_unknown_route"), ...unauthorizedCall("t3", "mcp_unknown_route")]);
  assert.ok(h.reasons(entry).includes("mcp_lost_turn_stopped"));
  h.play(entry, [h.answer(3, "cancelled")]);
  leases.end("managed_old");
  leases.token("h-new", "managed_new");
  hooks.onSleep = () => sandbox.acceptMcpTokenRenewal(entry, "h-new");
  h.runThreads("mcp-recovery-");
  assert.deepEqual(restarts.map((r) => r.mcpBearerTokenHandle), ["h-new"]);
  assert.equal(entry.mcpProbeTarget.headers.find((header) => header.name === "Authorization").value, "Bearer managed_new", "the probe before the restart uses it");
});

test("no new token within 60 s: the turn ends and says to send the message again", () => {
  const entry = turn(3);
  leases.end("managed_old");
  h.play(entry, [...expiredCall("t1"), h.answer(3, "cancelled")]);
  h.runThreads("mcp-recovery-");
  assert.equal(restarts.length, 0);
  const ended = h.types(entry, "turn/error");
  assert.equal(ended.length, 1);
  assert.equal(ended[0].data.error.code, "convertigo_mcp_unreachable");
  assert.match(ended[0].data.error.message, /L'autorisation du MCP Convertigo de cette conversation a expiré/);
  assert.match(ended[0].data.error.message, /Send your message again: it renews the authorization/);
  assert.equal(h.types(entry, "warning").find((event) => event.data.reason === "convertigo_mcp_unreachable").data.code, "token_expired");
  assert.equal(entry.restartReason, "mcp_token_expired", "the next start replaces the process");
});

test("a prompt to a process whose token ended waits for a new one, then Vibe restarts and gets the message", () => {
  h.reset();
  leases.token("h-old", "managed_old");
  leases.end("managed_old");
  const entry = h.fakeEntry("vibe-test", "s1", { mcpLeaseTokenId: "managed_old", mcpBearerTokenFingerprint: "fp-managed_old" });
  const result = sandbox.C8O.agentBridge.vibePrompt({ handle: "vibe-test", prompt: "Liste les projets.", messageId: "msg-1" });
  assert.equal(result.status, "submitted");
  assert.equal(h.sentMessages(entry, "session/prompt").length, 0, "Vibe does not get it with the ended token");
  assert.equal(h.types(entry, "turn/start")[0].data.deferred, "mcp_token");
  assert.deepEqual(h.reasons(entry), ["mcp_token_expired"]);
  leases.token("h-new", "managed_new");
  hooks.onSleep = () => sandbox.acceptMcpTokenRenewal(entry, "h-new");
  h.runThreads("mcp-recovery-");
  const fresh = registry.get("vibe-test");
  const sent = h.sentMessages(fresh, "session/prompt");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].params.prompt[0].text, "Liste les projets.");
  assert.equal(sent[0].params.messageId, "msg-1");
  assert.deepEqual(restarts.map((r) => r.mcpBearerTokenHandle), ["h-new"]);
});

test("a renewal takes only another token whose lease lives", () => {
  h.reset();
  leases.token("h-old", "managed_old");
  const entry = h.fakeEntry("vibe-test", "s1", { mcpLeaseTokenId: "managed_old", mcpBearerTokenFingerprint: "fp-managed_old" });
  assert.equal(sandbox.acceptMcpTokenRenewal(entry, "h-old"), false, "nothing asked yet");
  sandbox.requestMcpTokenRenewal(entry, "tool_answer");
  assert.equal(sandbox.acceptMcpTokenRenewal(entry, "h-old"), false, "the same token");
  leases.token("h-dead", "managed_dead", clock.now - 1);
  assert.equal(sandbox.acceptMcpTokenRenewal(entry, "h-dead"), false, "an ended lease");
  assert.equal(sandbox.acceptMcpTokenRenewal(entry, "h-missing"), false, "no token behind the handle");
  leases.token("h-new", "managed_new");
  assert.equal(sandbox.acceptMcpTokenRenewal(entry, "h-new"), true);
  assert.equal(sandbox.statusOf(entry).mcpTokenRenewal, "received");
});

test("a lease that ends under a running turn is seen by its keeper", () => {
  const entry = turn(3);
  entry.mcpLeaseKeeper = false;
  const noted = [];
  const original = sandbox.noteVibeMcpTokenExpired;
  sandbox.noteVibeMcpTokenExpired = (e, source) => { noted.push(source); e.turnActive = false; };
  try {
    h.threads.length = 0;
    sandbox.keepManagedMcpLease(entry);
    leases.end("managed_old");
    h.runThreads("mcp-lease-");
  } finally {
    sandbox.noteVibeMcpTokenExpired = original;
  }
  assert.deepEqual(noted, ["lease_ended"]);
});

test("the lease of a token is read where the MCP keeps it", () => {
  h.reset();
  const entry = h.fakeEntry("vibe-test", "s1", { mcpLeaseTokenId: "managed_a" });
  assert.equal(sandbox.managedMcpLeaseEnded(entry), true, "no lease on this engine: revoked or the engine restarted");
  leases.set("managed_a", clock.now + 60000);
  assert.equal(sandbox.managedMcpLeaseEnded(entry), false);
  clock.now += 60001;
  assert.equal(sandbox.managedMcpLeaseEnded(entry), true);
  assert.equal(sandbox.managedMcpLeaseEnded({ mcpLeaseTokenId: "" }), false, "a token without lease: cannot tell");
});
