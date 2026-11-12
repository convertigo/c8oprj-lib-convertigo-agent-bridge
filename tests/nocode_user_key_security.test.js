// The A4 security review (convertigo/c8oprj-tigoaccess#1, 10/11), T1 to T8 and T10, for the Bridge. T1 itself runs on Linux:
// sandbox/c8o-agent-isolation-test.sh (CI on amd64 and arm64, and on test-nocode, Landlock ABI 1, during A5).
// node --test tests/nocode_user_key_security.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");

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

const KEY = "sk-dummy-" + "d".repeat(40);
const SERVER_KEY = "sk-server-" + "b".repeat(32);
const HANDLE = "lib_ConvertigoAssistant.gatewayKey." + "0f".repeat(16);
const NOCODE = { userId: "ann@example.com", skillProfile: "nocode", vibeProfile: "convertigo", provider: "vibe" };
const STUDIO_PROFILE = { userId: "studio", skillProfile: "generalist", vibeProfile: "convertigo", provider: "vibe" };

function load({ registered = true, sequence = true, store = {}, policy = "files", abi = 1 } = {}) {
  const map = new Map(Object.entries(store));
  const logs = [];
  const sandbox = {
    Packages: javaProxy, request: javaProxy, C8O: { agentBridge: {} },
    context: { server: { get: (k) => (map.has(k) ? map.get(k) : null), set: (k, v) => map.set(k, v), remove: (k) => map.delete(k) } },
    log: { info: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)), debug: (m) => logs.push(String(m)) }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "js/agent_bridge_common.js"), "utf8"), sandbox, { filename: "agent_bridge_common.js" });
  sandbox.Engine = {
    isStudioMode: () => false,
    theApp: { databaseObjectsManager: {
      getOriginalProjectByName: (name) => (name === "C8Oforms" ? { getSequenceByName: (s) => (s === "APIV2_TigoUserKey" && sequence ? {} : null) } : null),
      symbolsGetValue: (name) => (name === "C8Oforms.tigo.server.id" && registered ? "server-test" : null)
    } }
  };
  sandbox.now = () => Date.now();
  sandbox.gatewayKeyFingerprint = (key) => crypto.createHash("sha256").update(String(key)).digest("hex").slice(0, 16);
  sandbox.requestParameter = () => "";
  sandbox.resolveProjectIdOption = () => "";
  sandbox.projectUsesFlow = () => false;
  sandbox.agentSandbox = () => ({ describe: () => JSON.stringify({ policy, effective: policy, landlockAbi: abi, helper: "/h" }) });
  sandbox.readConvertigoGatewayKeyFile = () => SERVER_KEY;
  return { sandbox, map, logs };
}

const bundle = (overrides = {}) => JSON.stringify(Object.assign({ key: KEY, owner: "ann@example.com", expiresAt: Date.now() + 600000 }, overrides));
const confinedFiles = { confined: true, policy: "files" };

test("T1: the isolation script checks the Bridge's confinement against another agent, the guard and the engine", () => {
  const script = fs.readFileSync(path.join(root, "sandbox/c8o-agent-isolation-test.sh"), "utf8");
  const common = fs.readFileSync(path.join(root, "js/agent_bridge_common.js"), "utf8");
  const list = /var AGENT_SANDBOX_SYSTEM_READ_ONLY = (\[[\s\S]*?\]);/.exec(common)[1].replace(/\s+/g, " ");
  const paths = JSON.parse(list);
  assert.match(script, new RegExp("for p in " + paths.join(" ").replace(/\//g, "\\/") + "; do"), "the same read-only system as agentSandbox()");
  for (const what of ["environ", "cmdline", "task/$pid/environ", "/proc/$pid/mem", "/proc/$pid/fd", "/proc/$pid/root/", "ptrace(16", "process_vm_readv"]) {
    assert.ok(script.includes(what), what);
  }
  for (const who of ["agent:$agent_b", "guard:$guard", "engine:$engine"]) {
    assert.ok(script.includes(who), who);
  }
  assert.match(script, /control: an unconfined process reads the agent's environment/, "a control proves the refusals come from the confinement");
  assert.match(fs.readFileSync(path.join(root, ".github/workflows/sandbox-helper.yml"), "utf8"), /sh \/test\/c8o-agent-isolation-test\.sh \/usr\/local\/bin\/c8o-agent-sandbox \/usr\/bin\/python3/);
});

test("T2: read_file of /proc/self/environ is refused under files and mcp-only", () => {
  for (const policy of ["files", "mcp-only"]) {
    const { sandbox } = load({ policy });
    const entry = { noCodePolicy: policy, toolCallKinds: {}, toolCallTitles: {} };
    const params = { toolCall: { toolCallId: "t1", kind: "read", title: "read_file", rawInput: { path: "/proc/self/environ" } } };
    assert.equal(sandbox.noCodePermissionRefused(entry, params), true, policy + ": a native read outside the session folder asks, the Bridge refuses");
    const lines = sandbox.vibeToolPolicyLines(NOCODE).join("\n");
    assert.match(lines, /outside_workdir = "deny"/, policy);
    if (policy === "mcp-only") {
      assert.match(lines, /disabled_tools = \[[^\]]*"read_file"/, "no file tool at all");
    }
  }
});

test("T3: mcp-only counts as isolated only when confined (run_typescript is not proven isolated)", () => {
  const { sandbox } = load({ policy: "mcp-only", abi: 0 });
  assert.equal(sandbox.userGatewayKeyIsolationRefusal(NOCODE, "vibe", { confined: false, policy: "mcp-only" }).code, "agent_isolation_unavailable");
  assert.equal(sandbox.userGatewayKeyIsolationRefusal(NOCODE, "vibe", { confined: true, policy: "mcp-only" }), null);
});

test("T4: on a server with per-user keys, every unconfined agent is refused, whatever its profile (WEB_ADMIN low code too)", () => {
  const { sandbox } = load();
  for (const [provider, info] of [["vibe", null], ["claude", null], ["codex", null], ["vibe", { confined: false, policy: "full" }]]) {
    const refused = sandbox.userGatewayKeyIsolationRefusal(STUDIO_PROFILE, provider, info);
    assert.equal(refused && refused.code, "agent_isolation_unavailable", "generalist " + provider);
  }
  // a registered server refuses before any No Code call has ever been made
  const fresh = load();
  assert.equal(fresh.sandbox.userGatewayKeyIsolationRefusal(STUDIO_PROFILE, "vibe", null).code, "agent_isolation_unavailable");
  // seen, then the registration disappears: still refused until the engine restarts
  const seen = load();
  seen.sandbox.serverUsesUserGatewayKeys();
  seen.sandbox.Engine.theApp.databaseObjectsManager.symbolsGetValue = () => null;
  assert.equal(seen.sandbox.userGatewayKeyIsolationRefusal(STUDIO_PROFILE, "codex", null).code, "agent_isolation_unavailable");
  // a server that never had per-user keys, and the Studio, are not concerned
  assert.equal(load({ registered: false }).sandbox.userGatewayKeyIsolationRefusal(STUDIO_PROFILE, "claude", null), null);
  const studio = load();
  studio.sandbox.Engine.isStudioMode = () => true;
  assert.equal(studio.sandbox.userGatewayKeyIsolationRefusal(STUDIO_PROFILE, "claude", null), null);
  // a reused process started unconfined is stopped too
  assert.match(fs.readFileSync(path.join(root, "js/agent_bridge_vibe.js"), "utf8"),
    /var reuseRefusal = userGatewayKeyIsolationRefusal\(options, "vibe",[\s\S]{0,300}stopEntry\(existing, true\);\n\s+return reuseRefusal;/);
});

test("T5: a dummy key never reaches a log, an event, a status, a refusal or a file the Bridge writes", () => {
  const { sandbox, logs, map } = load({ store: { [HANDLE]: bundle() } });
  const written = [];
  sandbox.writeTextFile = (file, text) => written.push(String(text));
  sandbox.writeEnvFileValue = (file, name, value) => written.push(String(value));
  sandbox.readTextFile = () => "CONVERTIGO_LLM_API_KEY=" + SERVER_KEY + "\nMISTRAL_API_KEY=m";
  const options = Object.assign({ gatewayKeyHandle: HANDLE }, NOCODE);
  const env = {};
  const applied = sandbox.applyUserGatewayKey(env, options, "vibe");
  assert.equal(env.CONVERTIGO_LLM_API_KEY, KEY, "the process environment, and only it");
  sandbox.scrubGatewayKeyFromEnvFile({ p: "/home/.env", isFile: () => true });
  const events = [];
  const entry = { provider: "vibe", vibeProfile: "convertigo", userGatewayKeys: true, gatewayKeyHandle: HANDLE, gatewayKeyFingerprint: applied.fingerprint,
    nextIndex: 0, firstIndex: 0, events: { add: (e) => events.push(e), size: () => events.length, remove: () => events.shift() } };
  sandbox.pushEvent(entry, "turn/error", { error: { message: "HTTP 401 for key " + KEY } });
  sandbox.pushEvent(entry, "tool/update", { detail: "env: CONVERTIGO_LLM_API_KEY=" + KEY });
  sandbox.pushEvent(entry, "stderr", { line: KEY });
  const refusals = [
    sandbox.userGatewayKeyRefusal(Object.assign({}, NOCODE, { gatewayKeyHandle: "lib_ConvertigoAssistant.gatewayKey.ffffffffffffffff" }), "vibe"),
    sandbox.userGatewayKeyIsolationRefusal(NOCODE, "claude", null),
    sandbox.inspectVibeAuthentication("/home", "convertigo", options)
  ];
  const everything = JSON.stringify({ logs, written, events, refusals, env: applied, keys: Object.keys(env) });
  assert.ok(!everything.includes(KEY), "the dummy key appears nowhere");
  assert.ok(!written.join("").includes(SERVER_KEY), "the server key left the home .env");
  assert.ok(map.has(HANDLE), "the key stays in server memory, behind its handle");
  const source = fs.readFileSync(path.join(root, "js/agent_bridge_common.js"), "utf8");
  for (const line of source.split("\n").filter((l) => /log\.(info|warn|error|debug)\(/.test(l))) {
    assert.doesNotMatch(line, /credential\.key|bundle\.key|gatewayKey\b|apiKey\)|\bkey\)/, line.trim());
  }
  assert.match(source, /lastError: gatewayBudgetError\(entry\.lastError\) !== null \? GATEWAY_BUDGET_MESSAGE : redactUserGatewayKey\(entry, entry\.lastError\),/);
  assert.equal(sandbox.redactUserGatewayKey(entry, "printed " + KEY), "printed sk-***");
});

test("T6: another user's userId or handle is refused", () => {
  const { sandbox } = load({ store: { [HANDLE]: bundle() } });
  assert.equal(sandbox.userGatewayCredential(Object.assign({}, NOCODE, { userId: "bob@example.com", gatewayKeyHandle: HANDLE })).reason, "foreign");
  assert.equal(sandbox.userGatewayKeyRefusal(Object.assign({}, NOCODE, { userId: "bob@example.com", gatewayKeyHandle: HANDLE }), "vibe").code,
    "gateway_credential_missing");
  assert.equal(sandbox.userGatewayCredential(Object.assign({}, NOCODE, { gatewayKeyHandle: "lib_ConvertigoAssistant.gatewayKey." + "1e".repeat(16) })).reason,
    "expired", "a handle nobody issued");
});

test("T7: sandboxed-shell with per-user keys runs without a shell (capped to files) and is never accepted as such", () => {
  const { sandbox } = load({ policy: "sandboxed-shell" });
  const info = sandbox.engineNoCodeToolInfo();
  assert.equal(info.policy, "files");
  assert.equal(info.configured, "sandboxed-shell", "the panel shows what the operator chose");
  assert.match(sandbox.vibeToolPolicyLines(NOCODE).join("\n"), /disabled_tools = \[[^\]]*"bash\*"/);
  assert.equal(sandbox.userGatewayKeyIsolationRefusal(NOCODE, "vibe", { confined: true, policy: "sandboxed-shell" }).code, "agent_isolation_unavailable");
  assert.equal(load({ policy: "sandboxed-shell", registered: false }).sandbox.engineNoCodeToolInfo().policy, "sandboxed-shell", "other servers keep it");
  assert.equal(sandbox.userGatewayKeyIsolationRefusal(NOCODE, "vibe", confinedFiles), null);
});

test("T8: a key past its lifetime, then purged, fails closed", () => {
  const { sandbox, map } = load({ store: { [HANDLE]: bundle({ expiresAt: Date.now() - 1000 }) } });
  const held = sandbox.gatewayKeyFingerprint(KEY);
  const entry = { provider: "vibe", vibeProfile: "convertigo", model: "glm-5-3", gatewayKeyHandle: HANDLE, ownerKey: "ann@example.com", gatewayKeyFingerprint: held };
  assert.equal(sandbox.userGatewayKeyRefusal(Object.assign({ gatewayKeyHandle: HANDLE }, NOCODE), "vibe").reason, "expired", "no new start");
  assert.equal(sandbox.userGatewayKeyRefusal(sandbox.entryGatewayKeyOptions(entry, {}), "vibe"), null, "its process goes on");
  map.delete(HANDLE);
  const refused = sandbox.userGatewayKeyRefusal(sandbox.entryGatewayKeyOptions(entry, {}), "vibe");
  assert.equal(refused.code, "gateway_credential_missing", "purged: its prompts are refused");
  assert.equal(sandbox.userGatewayCredential(sandbox.entryGatewayKeyOptions(entry, {})).key, "", "image description gets no key");
  assert.equal(sandbox.convertigoGatewayApiKey(Object.assign({ gatewayKeyHandle: HANDLE }, NOCODE), "/home"), "", "never the server key");
});

test("T10: an entry's key stays redacted after a new handle of the same key, a generation 2 and the purge of every handle", () => {
  const HANDLE_RENEWED = "lib_ConvertigoAssistant.gatewayKey." + "1e".repeat(16);
  const HANDLE_GEN2 = "lib_ConvertigoAssistant.gatewayKey." + "2d".repeat(16);
  const KEY_GEN2 = "sk-dummy-" + "e".repeat(40);
  const { sandbox, map } = load({ store: { [HANDLE]: bundle() } });
  const events = [];
  const entry = { provider: "vibe", vibeProfile: "convertigo", ownerKey: "ann@example.com", userGatewayKeys: true,
    gatewayKeyHandle: HANDLE, gatewayKeyFingerprint: sandbox.gatewayKeyFingerprint(KEY), nextIndex: 0, firstIndex: 0,
    events: { add: (e) => events.push(e), size: () => events.length, remove: () => events.shift() } };
  assert.equal(sandbox.rememberEntryGatewayKey(entry, Object.assign({ gatewayKeyHandle: HANDLE }, NOCODE)), true, "at its start");
  // the Assistant renews the same key under a new handle while the process keeps running (keepUserGatewayKeyAlive)
  map.set(HANDLE_RENEWED, bundle());
  assert.equal(sandbox.rememberEntryGatewayKey(entry, sandbox.entryGatewayKeyOptions(entry, { gatewayKeyHandle: HANDLE_RENEWED })), true);
  assert.equal(entry.gatewayKeyHandle, HANDLE_RENEWED, "the newer handle of the same key replaces the old one");
  // generation 2 for the next start, then the 2-hour purge of every handle
  map.set(HANDLE_GEN2, bundle({ key: KEY_GEN2 }));
  map.delete(HANDLE);
  map.delete(HANDLE_RENEWED);
  map.delete(HANDLE_GEN2);
  sandbox.pushEvent(entry, "tool/update", { detail: "env: CONVERTIGO_LLM_API_KEY=" + KEY });
  sandbox.pushEvent(entry, "stderr", { line: "retrying with " + KEY });
  sandbox.pushEvent(entry, "stderr", { line: "Authorization: Bearer " + KEY_GEN2 });
  sandbox.pushEvent(entry, "turn/error", { error: { message: "key=sk-unknown-" + "f".repeat(20) + " refused" } });
  sandbox.pushEvent(entry, "message/delta", { text: "desk-booking-application-form and risk-assessment-matrix-2026 stay" });
  const UNKNOWN = "sk-otherUser" + "9".repeat(20);
  sandbox.pushEvent(entry, "stderr", { line: "\u001b[1m" + UNKNOWN + "\u001b[0m" });
  sandbox.pushEvent(entry, "stderr", { line: "GET /v1?auth=Bearer%20" + UNKNOWN + "&key%3D" + UNKNOWN });
  sandbox.pushEvent(entry, "tool/update", { detail: "{\\\"env\\\":\\\"line\\n" + UNKNOWN + "\\\"}" });
  const sent = JSON.stringify(events);
  assert.ok(!sent.includes(KEY) && !sent.includes(KEY_GEN2) && !sent.includes("sk-unknown-"), "no key in any event");
  assert.equal(events[0].data.detail, "env: CONVERTIGO_LLM_API_KEY=sk-***", "the key it held, from its memory");
  assert.equal(events[1].data.line, "retrying with sk-***");
  assert.equal(events[2].data.line, "Authorization: Bearer sk-***", "generation 2, by the sk-*** floor");
  assert.equal(events[3].data.error.message, "key=sk-*** refused", "any key-shaped token, by the floor");
  assert.equal(events[4].data.text, "desk-booking-application-form and risk-assessment-matrix-2026 stay", "words are not keys");
  assert.equal(events[5].data.line, "\u001b[1msk-***\u001b[0m", "after an ANSI color code");
  assert.equal(events[6].data.line, "GET /v1?auth=Bearer%20sk-***&key%3Dsk-***", "after a percent-encoded byte");
  assert.ok(events[7].data.detail.endsWith("\\nsk-***\\\"}"), "after an escaped newline: " + events[7].data.detail);
  assert.ok(!JSON.stringify(events).includes(UNKNOWN));
  // in memory only: never serialized with the entry
  assert.ok(!JSON.stringify(entry).includes(KEY) && !Object.keys(entry).some((k) => /Redaction/.test(k)));
  entry.lastError = "HTTP 401 for " + KEY;
  assert.equal(sandbox.redactUserGatewayKey(entry, entry.lastError), "HTTP 401 for sk-***", "its status too");
  // an entry without a per-user key (Studio) is left as it was
  const studio = { provider: "vibe", userGatewayKeys: false };
  assert.equal(sandbox.redactUserGatewayKey(studio, "text with " + KEY), "text with " + KEY);
  assert.equal(sandbox.rememberEntryGatewayKey(studio, Object.assign({ gatewayKeyHandle: HANDLE }, NOCODE)), false);
  // the key the process holds stays in memory however many other keys come, and serves Claude Code's budget probe
  for (let i = 0; i < 12; i++) {
    const other = "lib_ConvertigoAssistant.gatewayKey." + String(i).padStart(2, "0").repeat(16);
    map.set(other, bundle({ key: "sk-dummy-" + String(i % 10).repeat(40) }));
    sandbox.rememberEntryGatewayKey(entry, Object.assign({ gatewayKeyHandle: other }, NOCODE));
    map.delete(other);
  }
  assert.equal(sandbox.entryHeldGatewayKey(entry), KEY, "the key of the process environment is never evicted");
  assert.equal(sandbox.redactUserGatewayKey(entry, "again " + KEY), "again sk-***");
  // the start and the prompt of each runtime remember the key
  const vibe = fs.readFileSync(path.join(root, "js/agent_bridge_vibe.js"), "utf8");
  const claude = fs.readFileSync(path.join(root, "js/agent_bridge_claude.js"), "utf8");
  assert.match(vibe, /entry\.unsetEnv = userGatewayKey\.unset;\n\s+rememberEntryGatewayKey\(entry, options\);/);
  assert.match(vibe, /return gatewayKeyRefusal;\n\s+\}\n\s+rememberEntryGatewayKey\(entry, entryGatewayKeyOptions\(entry, options\)\);/);
  assert.match(claude, /entry\.unsetEnv = userGatewayKey\.unset;\n\s+rememberEntryGatewayKey\(entry, options\);/);
  assert.match(claude, /\} else \{\n\s+rememberEntryGatewayKey\(existing, options\);/, "a reused Claude process too");
  assert.match(vibe, /rememberEntryGatewayKey\(existing, options\);\n\s+rememberSessionHandle\(handle\);/, "a reused Vibe process too");
  assert.match(claude, /userGatewayCredential\(entryGatewayKeyOptions\(entry, \{\}\)\)\.key \|\| entryHeldGatewayKey\(entry\)/);
  // the answers of a failed start or prompt, and a prompt's response, are redacted as the events are
  assert.equal((vibe.match(/error: redactUserGatewayKey\(entry, String\(e\)\),\n\s+acpError: redactUserGatewayKey\(entry, e\.acpError \|\| null\),/g) || []).length, 2);
  assert.match(vibe, /response: redactUserGatewayKey\(entry, response\),/);
});
