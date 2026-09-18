// Claude Code authentication handling: credentials state, Keychain re-read, CLI probe,
// probe cache and turn-error mapping.
//
// Sources are loaded like tests/claude_provider.test.js: vm.runInThisContext with a Java
// `Packages` proxy, so every top level function becomes a global that a test can stub.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

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

global.Packages = javaProxy;
global.java = javaProxy;
global.context = javaProxy;
global.request = javaProxy;
global.log = javaProxy;
global.C8O = { agentBridge: {} };

vm.runInThisContext(fs.readFileSync("js/agent_bridge_common.js", "utf8"), { filename: "agent_bridge_common.js" });
vm.runInThisContext(fs.readFileSync("js/agent_bridge_codex.js", "utf8"), { filename: "agent_bridge_codex.js" });
vm.runInThisContext(fs.readFileSync("js/agent_bridge_vibe.js", "utf8"), { filename: "agent_bridge_vibe.js" });
vm.runInThisContext(fs.readFileSync("js/agent_bridge_claude.js", "utf8"), { filename: "agent_bridge_claude.js" });

const FIXED_NOW = 1700000000000;
now = () => FIXED_NOW;

// ---------------------------------------------------------------------------
// 1. Credentials state: a present but revoked refresh token must not look healthy.
// ---------------------------------------------------------------------------

function withCredentialsFile(payload, body) {
  const originalHasContent = fileHasContent;
  const originalReadJson = readJsonFile;
  fileHasContent = () => payload !== null;
  readJsonFile = () => payload;
  try {
    return body();
  } finally {
    fileHasContent = originalHasContent;
    readJsonFile = originalReadJson;
  }
}

function credentialsState(oauth) {
  return withCredentialsFile({ claudeAiOauth: oauth }, () => claudeCredentialsState({ lastModified: () => 42 }));
}

const fresh = credentialsState({ accessToken: "at", refreshToken: "rt", expiresAt: FIXED_NOW + 3600000 });
assert.equal(fresh.exists, true);
assert.equal(fresh.expired, false);
assert.equal(fresh.stale, false, "a token valid for another hour is neither expired nor stale");

// The reported bug: expiry passed, refresh token present (possibly revoked server side).
const revoked = credentialsState({ accessToken: "at", refreshToken: "rt", expiresAt: FIXED_NOW - 1000 });
assert.equal(revoked.expired, false, "a refreshable token stays formally not expired");
assert.equal(revoked.stale, true, "but it must be flagged stale so it gets re-validated");
assert.equal(revoked.hasRefreshToken, true);

const hardExpired = credentialsState({ accessToken: "at", expiresAt: FIXED_NOW - 1000 });
assert.equal(hardExpired.expired, true);
assert.equal(hardExpired.stale, false);

const noCredentials = withCredentialsFile(null, () => claudeCredentialsState({ lastModified: () => 0 }));
assert.deepEqual(
  Object.keys(noCredentials).sort(),
  ["exists", "expired", "expiresAt", "hasRefreshToken", "method", "stale", "updatedAt"],
  "the empty state must keep the same shape as a real one"
);
assert.equal(noCredentials.stale, false);

// A stale copy is reported as configured but marked for a real check.
{
  const originalState = claudeCredentialsState;
  const originalEnv = environmentHasValue;
  const originalKeychain = readKeychainClaudeCredentials;
  environmentHasValue = () => false;
  readKeychainClaudeCredentials = () => "";
  claudeCredentialsState = () => ({ exists: true, expired: false, stale: true, expiresAt: FIXED_NOW - 1000, updatedAt: 7, hasRefreshToken: true, method: "oauth" });
  const info = inspectClaudeAuthentication("/managed/claude-home");
  assert.equal(info.configured, true);
  assert.equal(info.status, "stale");
  assert.equal(info.staleCredentials, true);
  claudeCredentialsState = originalState;
  environmentHasValue = originalEnv;
  readKeychainClaudeCredentials = originalKeychain;
}

console.log("Claude credentials state OK");

// ---------------------------------------------------------------------------
// 2. Keychain re-read when no credentials file source exists (macOS).
// ---------------------------------------------------------------------------

function syncWith(options) {
  const originalNewest = newestUsableClaudeCredentialsFile;
  const originalState = claudeCredentialsState;
  const originalKeychain = readKeychainClaudeCredentials;
  const originalWrite = writeClaudeCredentialsFile;
  const originalHasContent = fileHasContent;
  const originalReadText = readTextFile;
  const written = [];
  newestUsableClaudeCredentialsFile = () => null; // no readable source file, as on macOS
  claudeCredentialsState = () => options.targetState;
  readKeychainClaudeCredentials = () => options.keychain;
  writeClaudeCredentialsFile = (_dir, text) => { written.push(String(text)); return {}; };
  fileHasContent = () => String(options.currentCopy || "").length > 0;
  readTextFile = () => String(options.currentCopy || "");
  const report = { copied: [], reused: [], generated: [] };
  try {
    syncClaudeCredentials([], {}, report);
  } finally {
    newestUsableClaudeCredentialsFile = originalNewest;
    claudeCredentialsState = originalState;
    readKeychainClaudeCredentials = originalKeychain;
    writeClaudeCredentialsFile = originalWrite;
    fileHasContent = originalHasContent;
    readTextFile = originalReadText;
  }
  return { report, written };
}

const healthyState = { exists: true, expired: false, stale: false, expiresAt: FIXED_NOW + 3600000, updatedAt: 1, hasRefreshToken: true, method: "oauth" };

// The managed copy is not formally expired but the Keychain now holds another session:
// the Keychain wins, the stale copy is refreshed instead of being reused for ever.
const rotated = syncWith({ targetState: healthyState, currentCopy: '{"claudeAiOauth":{"accessToken":"old"}}', keychain: '{"claudeAiOauth":{"accessToken":"new"}}' });
assert.deepEqual(rotated.report.copied, [".credentials.json"]);
assert.deepEqual(rotated.report.reused, []);
assert.equal(rotated.report.authenticationSource, "keychain");
assert.equal(rotated.report.authenticationImported, true);
assert.match(rotated.written[0], /"new"/);

// Identical content: nothing is rewritten, the copy is reused (no needless churn).
const unchanged = syncWith({ targetState: healthyState, currentCopy: '{"claudeAiOauth":{"accessToken":"same"}}', keychain: '{"claudeAiOauth":{"accessToken":"same"}}' });
assert.deepEqual(unchanged.report.copied, []);
assert.deepEqual(unchanged.report.reused, [".credentials.json"]);
assert.equal(unchanged.report.authenticationSource, "keychain");

// Same session, different file layout (the CLI rewrites the file its own way): the copy is
// reused, otherwise every settings call would rewrite the credentials and force a CLI check.
const reformatted = syncWith({
  targetState: healthyState,
  currentCopy: '{\n  "claudeAiOauth": {\n    "accessToken": "same",\n    "expiresAt": 10,\n    "scopes": ["user:inference"]\n  }\n}',
  keychain: '{"claudeAiOauth":{"expiresAt":10,"accessToken":"same"}}'
});
assert.deepEqual(reformatted.report.copied, []);
assert.deepEqual(reformatted.report.reused, [".credentials.json"]);
assert.equal(reformatted.report.authenticationImported, undefined, "a reused copy is not a new sign-in");

// A stale copy whose tokens match the Keychain is kept: the Keychain has nothing better to
// offer, the CLI probe is what decides whether the session still works.
const staleState = { exists: true, expired: false, stale: true, expiresAt: FIXED_NOW - 1, updatedAt: 1, hasRefreshToken: true, method: "oauth" };
const stillStale = syncWith({ targetState: staleState, currentCopy: '{"claudeAiOauth":{"accessToken":"same"}}', keychain: '{"claudeAiOauth":{"accessToken":"same"}}' });
assert.deepEqual(stillStale.report.copied, []);
assert.deepEqual(stillStale.report.reused, [".credentials.json"]);

// A stale copy whose Keychain holds another session is replaced.
const staleReplaced = syncWith({ targetState: staleState, currentCopy: '{"claudeAiOauth":{"accessToken":"old"}}', keychain: '{"claudeAiOauth":{"accessToken":"new"}}' });
assert.deepEqual(staleReplaced.report.copied, [".credentials.json"]);
assert.equal(staleReplaced.report.authenticationImported, true);

// Missing copy: the Keychain is the source of truth even though no file source exists.
const missingCopy = syncWith({ targetState: { exists: false, expired: false, stale: false, expiresAt: 0, updatedAt: 0, hasRefreshToken: false, method: "" }, currentCopy: "", keychain: '{"claudeAiOauth":{"accessToken":"new"}}' });
assert.deepEqual(missingCopy.report.copied, [".credentials.json"]);
assert.equal(missingCopy.report.authenticationImported, true);

// Fingerprints ignore the layout but not the tokens.
assert.equal(
  claudeCredentialsFingerprint('{"claudeAiOauth":{"accessToken":"a","refreshToken":"b","expiresAt":3}}'),
  claudeCredentialsFingerprint('{\n "claudeAiOauth": {\n  "expiresAt": 3,\n  "refreshToken": "b",\n  "accessToken": "a",\n  "rateLimitTier": "x"\n }\n}')
);
assert.notEqual(
  claudeCredentialsFingerprint('{"claudeAiOauth":{"accessToken":"a"}}'),
  claudeCredentialsFingerprint('{"claudeAiOauth":{"accessToken":"b"}}')
);

// No Keychain (Linux/Windows): the previous behaviour is kept.
const noKeychain = syncWith({ targetState: healthyState, currentCopy: "{}", keychain: "" });
assert.deepEqual(noKeychain.report.reused, [".credentials.json"]);
assert.deepEqual(noKeychain.written, []);

const noKeychainExpired = syncWith({ targetState: { exists: true, expired: true, stale: false, expiresAt: 1, updatedAt: 1, hasRefreshToken: false, method: "oauth" }, currentCopy: "{}", keychain: "" });
assert.deepEqual(noKeychainExpired.report.reused, []);
assert.deepEqual(noKeychainExpired.written, []);

console.log("Claude Keychain re-read OK");

// ---------------------------------------------------------------------------
// 3. Probe result mapping: healthy / revoked / logged out / CLI missing / timeout.
// ---------------------------------------------------------------------------

function probeWith(commandResult, commandPath) {
  const originalRun = runCommand;
  const originalEnv = claudeRuntimeEnv;
  claudeRuntimeEnv = () => ({});
  runCommand = () => commandResult;
  try {
    return claudeAuthenticationProbe({}, "/managed/claude-home", typeof commandPath === "string" ? commandPath : "/usr/local/bin/claude");
  } finally {
    runCommand = originalRun;
    claudeRuntimeEnv = originalEnv;
  }
}

const healthyProbe = probeWith({
  ok: true,
  exitCode: 0,
  error: "",
  stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" }),
  stderr: ""
});
assert.equal(healthyProbe.conclusive, true);
assert.equal(healthyProbe.valid, true);
assert.equal(healthyProbe.unauthorized, false);
assert.equal(healthyProbe.authMethod, "claude.ai");
assert.equal(healthyProbe.reason, "logged_in");

const loggedOutProbe = probeWith({ ok: true, exitCode: 0, error: "", stdout: JSON.stringify({ loggedIn: false }), stderr: "" });
assert.equal(loggedOutProbe.conclusive, true);
assert.equal(loggedOutProbe.valid, false);
assert.equal(loggedOutProbe.unauthorized, true);
assert.equal(loggedOutProbe.reason, "logged_out");

// A revoked session: no parsable JSON, only the CLI wording.
const revokedProbe = probeWith({ ok: false, exitCode: 1, error: "", stdout: "", stderr: "OAuth token revoked: failed to refresh authentication token (invalid_grant). Please run /login." });
assert.equal(revokedProbe.conclusive, true);
assert.equal(revokedProbe.unauthorized, true);
assert.equal(revokedProbe.valid, false);
assert.equal(revokedProbe.reason, "revoked");

// JSON says logged in but the CLI still complains about the refresh: not usable.
const contradictoryProbe = probeWith({ ok: false, exitCode: 0, error: "", stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }), stderr: "Failed to refresh token: invalid_grant" });
assert.equal(contradictoryProbe.valid, false);
assert.equal(contradictoryProbe.unauthorized, true);

// CLI missing: no command path at all, and the "command not found" shape.
const noCliProbe = probeWith({ ok: false, exitCode: -1, error: "", stdout: "", stderr: "" }, "");
assert.equal(noCliProbe.conclusive, false);
assert.equal(noCliProbe.unauthorized, false);
assert.equal(noCliProbe.reason, "cli_missing");

const missingBinaryProbe = probeWith({ ok: false, exitCode: 127, error: "", stdout: "", stderr: "/bin/sh: claude: command not found" });
assert.equal(missingBinaryProbe.conclusive, false);
assert.equal(missingBinaryProbe.reason, "cli_missing");

const timeoutProbe = probeWith({ ok: false, exitCode: -1, error: "timeout", stdout: "", stderr: "" });
assert.equal(timeoutProbe.conclusive, false);
assert.equal(timeoutProbe.unauthorized, false);
assert.equal(timeoutProbe.reason, "timeout");

const unexpectedProbe = probeWith({ ok: true, exitCode: 0, error: "", stdout: "Usage: claude [options]", stderr: "" });
assert.equal(unexpectedProbe.conclusive, false);
assert.equal(unexpectedProbe.unauthorized, false);
assert.equal(unexpectedProbe.reason, "unexpected_output");

// A throwing runCommand never breaks the settings call.
{
  const originalRun = runCommand;
  const originalEnv = claudeRuntimeEnv;
  claudeRuntimeEnv = () => ({});
  runCommand = () => { throw new Error("boom"); };
  const failed = claudeAuthenticationProbe({}, "/home", "/usr/local/bin/claude");
  assert.equal(failed.conclusive, false);
  assert.equal(failed.reason, "probe_failed");
  runCommand = originalRun;
  claudeRuntimeEnv = originalEnv;
}

console.log("Claude authentication probe mapping OK");

// ---------------------------------------------------------------------------
// 4. Probe cache: one CLI call per window, inconclusive answers are never cached.
// ---------------------------------------------------------------------------

{
  const originalCacheMap = claudeAuthProbeCacheMap;
  const store = {};
  claudeAuthProbeCacheMap = () => store;

  let calls = 0;
  const conclusive = () => { calls += 1; return { checked: true, conclusive: true, valid: true, unauthorized: false, reason: "logged_in" }; };

  const first = claudeCachedAuthenticationProbe("key-a", {}, conclusive);
  assert.equal(calls, 1);
  assert.equal(first.cached, false);
  assert.equal(first.nextCheckAt, FIXED_NOW + 300000, "the default cache window is five minutes");

  const second = claudeCachedAuthenticationProbe("key-a", {}, conclusive);
  assert.equal(calls, 1, "a cached answer must not spawn the CLI again");
  assert.equal(second.cached, true);
  assert.equal(second.valid, true);

  // A different key (another home or another credentials timestamp) is a different probe.
  claudeCachedAuthenticationProbe("key-b", {}, conclusive);
  assert.equal(calls, 2);

  // An explicit refresh bypasses the cache.
  claudeCachedAuthenticationProbe("key-a", { refreshClaudeAuthCheck: true }, conclusive);
  assert.equal(calls, 3);

  // Expired window.
  now = () => FIXED_NOW + 300001;
  claudeCachedAuthenticationProbe("key-a", {}, conclusive);
  assert.equal(calls, 4);
  now = () => FIXED_NOW;

  // The shared runtime/version refresh flag must not defeat the authentication cache.
  claudeCachedAuthenticationProbe("key-a", { refreshUpdateCheck: true }, conclusive);
  assert.equal(calls, 4, "refreshUpdateCheck is the runtime flag, not an authentication refresh");

  // Inconclusive answers (timeout, missing CLI) are retried, never cached.
  let inconclusiveCalls = 0;
  const inconclusive = () => { inconclusiveCalls += 1; return { checked: true, conclusive: false, valid: false, unauthorized: false, reason: "timeout" }; };
  claudeCachedAuthenticationProbe("key-c", {}, inconclusive);
  claudeCachedAuthenticationProbe("key-c", {}, inconclusive);
  assert.equal(inconclusiveCalls, 2);

  claudeAuthProbeCacheMap = originalCacheMap;
}

// The engine store does not always survive between sequence executions, so a persisted
// answer must be enough to skip the CLI call.
{
  const originalCacheMap = claudeAuthProbeCacheMap;
  const originalFileRead = claudeAuthProbeFileRead;
  const originalFileWrite = claudeAuthProbeFileWrite;
  const persisted = {};
  claudeAuthProbeCacheMap = () => ({}); // a brand new (empty) in-memory cache every time
  claudeAuthProbeFileRead = (_options, key) => (persisted[key] ? JSON.parse(JSON.stringify(persisted[key])) : null);
  claudeAuthProbeFileWrite = (_options, key, value) => { persisted[key] = JSON.parse(JSON.stringify(value)); };

  let calls = 0;
  const loader = () => { calls += 1; return { checked: true, conclusive: true, valid: true, unauthorized: false, reason: "logged_in" }; };
  claudeCachedAuthenticationProbe("persisted", {}, loader);
  const again = claudeCachedAuthenticationProbe("persisted", {}, loader);
  assert.equal(calls, 1, "the persisted answer must be reused across executions");
  assert.equal(again.cached, true);

  let inconclusiveCalls = 0;
  claudeCachedAuthenticationProbe("persisted-timeout", {}, () => { inconclusiveCalls += 1; return { checked: true, conclusive: false, reason: "timeout" }; });
  assert.equal(Object.prototype.hasOwnProperty.call(persisted, "persisted-timeout"), false, "a timeout is never persisted");

  claudeAuthProbeCacheMap = originalCacheMap;
  claudeAuthProbeFileRead = originalFileRead;
  claudeAuthProbeFileWrite = originalFileWrite;
}

console.log("Claude authentication probe cache OK");

// ---------------------------------------------------------------------------
// 5. claudeDoctorAuthentication: what the settings call ends up reporting.
// ---------------------------------------------------------------------------

function doctorWith(inspected, probe, commandPath) {
  const originalInspect = inspectClaudeAuthentication;
  const originalProbe = claudeAuthenticationProbe;
  const originalCacheMap = claudeAuthProbeCacheMap;
  let probeCalls = 0;
  inspectClaudeAuthentication = () => JSON.parse(JSON.stringify(inspected));
  claudeAuthenticationProbe = () => { probeCalls += 1; return probe; };
  claudeAuthProbeCacheMap = () => ({});
  try {
    const result = claudeDoctorAuthentication({}, "/managed/claude-home", typeof commandPath === "string" ? commandPath : "/usr/local/bin/claude", false);
    result._probeCalls = probeCalls;
    return result;
  } finally {
    inspectClaudeAuthentication = originalInspect;
    claudeAuthenticationProbe = originalProbe;
    claudeAuthProbeCacheMap = originalCacheMap;
  }
}

const configuredInfo = { configured: true, status: "configured", method: "user_home", action: "", home: "/home/.claude", expiresAt: FIXED_NOW + 3600000, updatedAt: 9 };

// Healthy session stays configured.
const healthyDoctor = doctorWith(configuredInfo, { checked: true, conclusive: true, valid: true, unauthorized: false, reason: "logged_in", authMethod: "claude.ai" });
assert.equal(healthyDoctor.configured, true);
assert.equal(healthyDoctor.action, "");
assert.equal(healthyDoctor.method, "user_home");
assert.equal(healthyDoctor.verifiedByCli, true);

// Revoked session: the file still looks fine, the probe says otherwise.
const revokedDoctor = doctorWith(configuredInfo, { checked: true, conclusive: true, valid: false, unauthorized: true, reason: "revoked" });
assert.equal(revokedDoctor.configured, false, "a revoked session must not stay configured");
assert.equal(revokedDoctor.action, "claude_login", "the Assistant shows the sign-in button on this action");
assert.equal(revokedDoctor.status, "revoked");
assert.equal(revokedDoctor.method, "");
assert.equal(revokedDoctor.checkMethod, "auth-status");
assert.ok(String(revokedDoctor.message).length > 0);

// A stale copy that the CLI could actually refresh comes back configured.
const staleDoctor = doctorWith({ configured: true, status: "stale", staleCredentials: true, method: "user_home", action: "", home: "/home/.claude", expiresAt: FIXED_NOW - 1, updatedAt: 9 },
  { checked: true, conclusive: true, valid: true, unauthorized: false, reason: "logged_in", authMethod: "claude.ai" });
assert.equal(staleDoctor.configured, true);
assert.equal(staleDoctor.method, "cli:claude.ai");
assert.equal(staleDoctor.status, "configured");

// Inconclusive probe: fall back to the credentials verdict and say why.
const fallbackDoctor = doctorWith(configuredInfo, { checked: true, conclusive: false, valid: false, unauthorized: false, reason: "timeout" });
assert.equal(fallbackDoctor.configured, true, "a timeout must not log the user out");
assert.equal(fallbackDoctor.checkFallbackReason, "timeout");

// No CLI at all (presence-only settings call): no probe, previous verdict kept.
const presenceDoctor = doctorWith(configuredInfo, { checked: true, conclusive: true, valid: false, unauthorized: true, reason: "revoked" }, "");
assert.equal(presenceDoctor._probeCalls, 0, "the presence-only path must not spawn the CLI");
assert.equal(presenceDoctor.configured, true);
assert.equal(presenceDoctor.check.reason, "cli_missing");

// An environment key is authoritative and never probed.
const envDoctor = doctorWith({ configured: true, status: "configured", method: "environment", action: "" }, { checked: true, conclusive: true, valid: false, unauthorized: true, reason: "revoked" });
assert.equal(envDoctor._probeCalls, 0);
assert.equal(envDoctor.configured, true);

console.log("Claude doctor authentication OK");

// ---------------------------------------------------------------------------
// 6. Turn-error mapping: the wordings a revoked session really produces.
// ---------------------------------------------------------------------------

[
  "Not logged in · Please run /login",
  "OAuth token has expired. Please obtain a new token.",
  "OAuth token revoked",
  "Failed to refresh authentication token",
  "invalid_grant: refresh token was revoked",
  "Refresh token not found",
  "API Error: 401 Unauthorized",
  "Invalid bearer token",
  "{\"type\":\"error\",\"error\":{\"type\":\"authentication_error\"}}",
  "Your session has expired, please log in again",
  "Invalid API key · Please run /login"
].forEach((text) => {
  assert.equal(claudeLooksLikeAuthenticationError(text), true, "must be an authentication error: " + text);
  assert.equal(claudeLooksLikeRevokedSession(text), true, "must look revoked: " + text);
});

[
  "",
  "Tool execution failed: file not found",
  "The model produced an invalid tool call",
  "Rate limit exceeded",
  "Connection reset by peer"
].forEach((text) => {
  assert.equal(claudeLooksLikeAuthenticationError(text), false, "must not be an authentication error: " + text);
});

// End to end on the stream handler: a revoked session surfaces with authentication: true.
{
  const events = [];
  const entry = {
    handle: "claude-auth-test",
    provider: "claude",
    status: "running",
    phase: "turn",
    sessionId: "",
    nextIndex: 0,
    firstIndex: 0,
    lastAccess: 0,
    lastError: "",
    process: null,
    writer: { write() {}, newLine() {}, flush() {} },
    events: { add(event) { events.push(event); }, size() { return events.length; }, remove() { events.shift(); } }
  };
  handleClaudeStreamLine(entry, JSON.stringify({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    result: "Failed to refresh authentication token (invalid_grant). Please run /login."
  }), "stdout");
  const turnError = events.find((event) => event.type === "turn/error");
  assert.ok(turnError, "a revoked session must emit turn/error");
  assert.equal(turnError.data.authentication, true, "the Assistant needs authentication: true to offer the sign-in button");
}

console.log("Claude authentication error mapping OK");
